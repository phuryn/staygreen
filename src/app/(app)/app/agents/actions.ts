"use server";
import { mintApiToken, revokeApiToken } from "@/lib/api-tokens";
import { assertSameOrigin } from "@/lib/request";
import { memberOrNull } from "@/lib/workspace";
import { hasPermission } from "@/lib/authz";
import type { Result } from "../actions";

async function member() {
  await assertSameOrigin();
  const m=await memberOrNull();
  return m&&hasPermission(m.workspace,m.caller,"tokens:manage")?m:null;
}
export async function createToken(input:unknown):Promise<Result<{token:string}>> {
  const m=await member();if(!m)return {ok:false,reason:"This action isn't available in this workspace."};
  return mintApiToken(m,input);
}
export async function revokeToken(id:string):Promise<Result> {
  const m=await member();if(!m)return {ok:false,reason:"This action isn't available in this workspace."};
  return revokeApiToken(m,id);
}
