import { notFound } from "next/navigation";
import { loadDemoPreview } from "@/lib/demo-clone-data";
import { allowed, loadSnapshot, requireMember } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { CloneScreen } from "./CloneScreen";

export const metadata = { title: "Clone status page" };
export const dynamic = "force-dynamic";
export const unstable_dynamicStaleTime = 0;

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const member = await requireMember(`/app/clone/${encodeURIComponent(slug)}`);
  if (!allowed(member.workspace, member.caller, "monitors:write") || !allowed(member.workspace, member.caller, "pages:manage")) notFound();
  const demo = await loadDemoPreview(slug);
  if (!demo) notFound();
  return <WorkspaceSnapshot snapshot={await loadSnapshot(member)}><CloneScreen slug={slug} demo={demo} /></WorkspaceSnapshot>;
}
