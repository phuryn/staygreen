import "server-only";
import { z } from "zod";
import { tokenInput } from "./agent-contract";
import { agentHash, newApiToken } from "./api-token-crypto";
import { requireWorkspaceAccess } from "./authz";
import { spendAgentBudget } from "./agent-auth";
import { db } from "./db";
import { env } from "./env";
import type { Member } from "./workspace";

const SUMMARY="id,name,kid,scope,created_at,last_used_at,revoked_at";
export type TokenSummary={id:string;name:string;kid:string;scope:"read"|"write";created_at:string;last_used_at:string|null;revoked_at:string|null};
export type AgentActivity={id:string;client:string;tool:string;resource_id:string;created_at:string};
export async function agentSettings(member:Member) {
  requireWorkspaceAccess(member.workspace,member.caller,"monitors:read");
  const {data:activity,error}=await db().from("agent_activity").select("id,client,tool,resource_id,created_at").eq("workspace_id",member.workspace.id).order("created_at",{ascending:false}).order("id").limit(100);
  if(error) throw new Error("Activity could not be loaded");
  const {hasPermission}=await import("./authz");
  let tokens:TokenSummary[]=[];
  if(hasPermission(member.workspace,member.caller,"tokens:manage")) {
    const r=await db().from("api_tokens").select(SUMMARY).eq("workspace_id",member.workspace.id).is("revoked_at",null).order("created_at",{ascending:false}).limit(100);
    if(r.error) throw new Error("Tokens could not be loaded"); tokens=r.data??[];
  }
  return {tokens,activity:activity??[]};
}
export async function mintApiToken(member:Member,input:unknown) {
  requireWorkspaceAccess(member.workspace,member.caller,"tokens:manage");
  const a=tokenInput.parse(input);const pepper=env().API_TOKEN_PEPPER;
  await spendAgentBudget(agentHash("token-management",[member.workspace.id,member.caller.userId],pepper),10);
  const token=newApiToken(member.workspace.id,pepper);
  const id=`tok_${a.request_id.replaceAll("-","").slice(0,24)}`;
  const {error}=await db().rpc("agent_token_create",{p_workspace_id:member.workspace.id,p_id:id,p_name:a.name,p_kid:token.kid,p_hash:token.hash,p_scope:a.scope});
  if(error) {
    if(error.code==="23505") return {ok:false,reason:"This token was already created. If you missed its value, revoke it and create another."} as const;
    if(error.message==="token_limit") return {ok:false,reason:"This workspace has 100 active tokens. Revoke one before creating another."} as const;
    throw new Error("Token creation failed");
  }
  return {ok:true,token:token.plaintext} as const;
}
export async function revokeApiToken(member:Member,tokenId:string) {
  requireWorkspaceAccess(member.workspace,member.caller,"tokens:manage");
  const id=z.string().regex(/^tok_[0-9a-f]{24}$/).parse(tokenId);
  const {data,error}=await db().from("api_tokens").update({revoked_at:new Date().toISOString()}).eq("workspace_id",member.workspace.id).eq("id",id).select("id");
  if(error) throw new Error("Token revocation failed");
  return data?.length?{ok:true} as const:{ok:false,reason:"That token isn't here any more."} as const;
}
