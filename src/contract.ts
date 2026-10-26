import { z } from "zod";
import contract from "./contract.generated.json";

export const MCP_TOOLS = contract.tools;
export const MCP_VERSIONS = contract.versions;
export const MCP_INSTRUCTIONS = contract.instructions;
export const LINE_LIMIT = contract.lineLimit;

// Validate the advertised JSON Schema locally. Server-only refinements (target
// safety, paired credentials, quotas, permissions) still run at the REST boundary.
// They cannot be reconstructed from JSON Schema and must never be copied here.
const schemas = (field: "inputSchema" | "outputSchema") => Object.fromEntries(MCP_TOOLS.map(tool => [
  tool.name, z.fromJSONSchema(tool[field] as unknown as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<Record<string, unknown>>,
]));
export const inputs = schemas("inputSchema");
export const outputs = schemas("outputSchema");
export const isTool = (name: string) => Object.hasOwn(inputs, name);
