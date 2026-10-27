import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { generateContract } from "../../scripts/generate-mcp-contract";
import { MCP_TOOLS as hostedTools } from "@/lib/agent-contract";
import { MCP_TOOLS, MCP_VERSIONS, MCP_INSTRUCTIONS, LINE_LIMIT } from "../../packages/staygreen/src/contract";

vi.mock("@/lib/agent-auth", () => ({ requireAgent: vi.fn() }));
vi.mock("@/lib/agent-service", () => ({ executeAgentTool: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
import { MCP_VERSIONS as hostedVersions, MCP_INSTRUCTIONS as hostedInstructions, BODY_LIMIT } from "@/lib/agent-transport";

it("the committed public contract is a fresh generation, byte for byte", async () => {
  expect(await readFile("packages/staygreen/src/contract.generated.json", "utf8")).toBe(await generateContract());
});
it("matches every hosted tool field, protocol negotiation and size ceiling", () => {
  expect(MCP_TOOLS).toEqual(hostedTools); expect(MCP_VERSIONS).toEqual(hostedVersions); expect(LINE_LIMIT).toBe(BODY_LIMIT);
  const unchanged = hostedInstructions.slice(hostedInstructions.indexOf(" Find app and monitor ids"));
  expect(MCP_INSTRUCTIONS.endsWith(unchanged)).toBe(true);
  expect(MCP_INSTRUCTIONS).toContain("STAYGREEN_API_TOKEN"); expect(MCP_INSTRUCTIONS).toContain("public scan service");
});
