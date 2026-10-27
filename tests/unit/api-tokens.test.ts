import { beforeEach, expect, it, vi } from "vitest";
import { FREE } from "@/lib/plans";
import { agentQuery } from "../support/agent-db";
import type { Member } from "@/lib/workspace";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), origin: vi.fn(), member: vi.fn(), budget: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: () => mocks }));
vi.mock("@/lib/env", () => ({ env: () => ({ API_TOKEN_PEPPER: "pepper" }) }));
vi.mock("@/lib/agent-auth", () => ({ spendAgentBudget: mocks.budget }));
vi.mock("@/lib/request", () => ({ assertSameOrigin: mocks.origin }));
vi.mock("@/lib/workspace", () => ({ memberOrNull: mocks.member }));
import { agentSettings, mintApiToken, revokeApiToken } from "@/lib/api-tokens";
import { createToken, revokeToken } from "@/app/(app)/app/agents/actions";
const member: Member = { workspace: { id: "ws_a", clerk_org_id: "org_a" }, caller: { userId: "user_a", orgId: "org_a", orgRole: "org:admin" }, entitlements: FREE };
const input = { request_id: "658f56b4-56d0-4af0-80c3-b435ce2ab311", name: "CI", scope: "read" };
beforeEach(() => { vi.clearAllMocks(); mocks.rpc.mockResolvedValue({ error: null }); mocks.member.mockResolvedValue(member); mocks.origin.mockResolvedValue(undefined); });
it("returns a token once, persists only its hash, and cannot show it again after a lost response", async () => {
  const r = await mintApiToken(member, input); expect(r.ok).toBe(true);
  if (!r.ok) throw Error("No token");
  expect(r.token).toMatch(/^sg_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/);
  const saved = mocks.rpc.mock.calls[0][1]; expect(saved.p_hash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(saved)).not.toContain(r.token.split(".")[1]);
  mocks.rpc.mockResolvedValue({ error: { code: "23505" } });
  expect(await mintApiToken(member, input)).toMatchObject({ ok: false });
});
it("enforces permission and origin at the dashboard action boundary", async () => {
  mocks.origin.mockRejectedValueOnce(new Error("origin")); await expect(createToken(input)).rejects.toThrow("origin"); expect(mocks.member).not.toHaveBeenCalled();
  mocks.member.mockResolvedValue({ ...member, caller: { ...member.caller, orgRole: "org:member" } });
  expect(await createToken(input)).toMatchObject({ ok: false }); expect(await revokeToken("tok_" + "a".repeat(24))).toMatchObject({ ok: false }); expect(mocks.rpc).not.toHaveBeenCalled();
});
it("revokes by a workspace-scoped tombstone and returns no information about another workspace", async () => {
  const q = agentQuery([]); mocks.from.mockReturnValue(q);
  expect(await revokeApiToken(member, "tok_" + "a".repeat(24))).toMatchObject({ ok: false });
  expect(q.eq).toHaveBeenCalledWith("workspace_id", member.workspace.id); expect(q.update).toHaveBeenCalledWith({ revoked_at: expect.any(String) });
});
it("lists only metadata for tokens and the latest activity, never token hashes or receipts", async () => {
  const q = agentQuery([]); mocks.from.mockReturnValue(q); await agentSettings(member);
  const selections = (q.select as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
  expect(selections.join(",")).not.toMatch(/hash|result|secret/); expect(q.eq).toHaveBeenCalledWith("workspace_id", member.workspace.id);
});
