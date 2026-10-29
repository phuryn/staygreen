import "server-only";
import { db } from "./db";
import { demoPreviewSchema, demoSlugSchema } from "./demo-clone";

export async function loadDemoPreview(slug: string) {
  if (!demoSlugSchema.safeParse(slug).success) return null;
  const { data, error } = await db().rpc("demo_clone_source", { p_slug: slug });
  if (error) throw new Error(`demo_clone_source failed: ${error.code}`);
  return data ? demoPreviewSchema.parse(data) : null;
}
