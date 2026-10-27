"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loading, PageHead } from "@/components/Shell";
import { TypeIcon } from "@/components/TypeIcon";
import { isCreatable } from "@/lib/monitor-input";
import { typeLabel } from "@/lib/model";
import { useWorkspace } from "@/lib/workspace-store";
import { MonitorForm } from "../../new/AddMonitorScreen";

/** The add form, filled in with what the monitor checks now. Its type and app stay what they are. */
export function EditMonitorScreen({ id }: { id: string }) {
  const s = useWorkspace();
  const router = useRouter();
  if (!s) return <Loading />;
  const m = s.monitors.find((x) => x.id === id);
  const back = { href: `/app/monitors/${id}`, label: m?.name ?? "Monitor" };

  if (!m) {
    return (
      <div className="empty">
        <h1 className="t-title">This monitor isn&apos;t here any more</h1>
        <p className="t-2">You or a teammate may have deleted it.</p>
        <Link href="/app/monitors" className="btn">Back to monitors</Link>
      </div>
    );
  }
  if (m.auto || !isCreatable(m.type)) {
    return (
      <>
        <PageHead back={back} title={`Edit ${m.name}`} />
        <div className="empty">
          <strong>{m.auto ? "Staygreen added this monitor with an HTTPS monitor, and it changes with that one." : "This kind of monitor can't be edited yet."}</strong>
        </div>
      </>
    );
  }

  const app = s.apps.find((a) => a.id === m.appId);
  return (
    <>
      <PageHead
        back={back}
        doc={`Edit ${m.name}`}
        title={
          <span className="row" style={{ gap: "var(--s-3)" }}>
            <TypeIcon type={m.type} size={24} />
            Edit {m.name}
          </span>
        }
        sub={`${typeLabel[m.type]}${app ? `, part of ${app.name}` : ""}.`}
      />
      <div className="add-layout">
        <MonitorForm s={s} type={m.type} appId={m.appId} appUrl={app?.url ?? ""} full={false} editing={m} onDone={() => router.push(`/app/monitors/${id}`)} />
        <aside className="sticky-side">
          <section className="panel panel-tight stack-sm" aria-labelledby="keeps">
            <h2 id="keeps" className="t-section">What saving keeps</h2>
            <p className="t-2">Its history, its incidents and its place on your status page{m.type === "heartbeat" ? ", and its ping URL" : ""}.</p>
            {m.type !== "heartbeat" && <p className="t-2">A new address starts again at Not checked yet.</p>}
          </section>
        </aside>
      </div>
    </>
  );
}
