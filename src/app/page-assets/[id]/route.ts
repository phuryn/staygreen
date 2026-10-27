import { db } from "@/lib/db";
import { PAGE_ASSET_ID } from "@/lib/page-assets";
import { pageAssetResponse } from "@/lib/page-asset-response";
import { resolvePage } from "@/lib/workspace";
import { currentCaller } from "@/lib/session";
import { NotAllowed, requireWorkspaceAccess } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** Public page images are uncached so the same address can later require membership.
 * App logos remain public by possession; they are dashboard artwork, not private page content. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!PAGE_ASSET_ID.test(id)) return pageAssetResponse(null);
  const page = await db().from("page_assets").select("page_id, content, mime").eq("id", id).maybeSingle();
  if (page.error) throw new Error(`page asset read failed: ${page.error.code}`);
  if (page.data) {
    const owner = await db().from("status_pages").select("members_only,edge_withdrawn").eq("id", page.data.page_id).maybeSingle();
    if (owner.error) throw new Error(`page access failed: ${owner.error.code}`);
    if (!owner.data) return pageAssetResponse(null);
    if (owner.data.members_only || owner.data.edge_withdrawn) {
      const owned = await resolvePage(page.data.page_id);
      if (!owned) return pageAssetResponse(null);
      try { requireWorkspaceAccess(owned.workspace, await currentCaller(), "monitors:read"); }
      catch (error) { if (error instanceof NotAllowed) return pageAssetResponse(null); throw error; }
    }
    const response = pageAssetResponse(page.data);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  // Both tables make their ids the same way, `asset_` and 128 random bits, so one address names
  // one image whichever table holds it.
  const app = await db().from("app_logos").select("content, mime").eq("id", id).maybeSingle();
  if (app.error) throw new Error(`app logo read failed: ${app.error.code}`);
  return pageAssetResponse(app.data);
}
