"use client";

import { statusHost } from "@/lib/status-host";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Info, Lock, Monitor as MonitorIcon, Plus, Smartphone, Trash2 } from "lucide-react";
import { CollapsibleSection, type SectionToggle } from "@/components/CollapsibleSection";
import { DeleteDialog } from "@/components/DeleteDialog";
import { PageDomain } from "@/components/PageDomain";
import { PageAssetPicker } from "@/components/PageAssetPicker";
import { Loading, PageHead } from "@/components/Shell";
import { BuilderTag, showOffer, SoonTag } from "@/components/Tags";
import { TypeIcon } from "@/components/TypeIcon";
import { StatusPageView } from "@/components/status/StatusPageView";
import { viewFromSim } from "@/lib/public-page";
import { isHex, nearStatus } from "@/components/status/data";
import { Copy } from "@/components/Copy";
import { pageHost, pageUrl } from "@/lib/derive";
import { holds } from "@/lib/plans";
import { pageDraftErrors, RESERVED_SLUGS, type PageDraft } from "@/lib/page-input";
import { moveComponent, pageErrorSections, type PageEditorSection } from "@/lib/page-editor";
import { useActs, useWorkspace, type Workspace } from "@/lib/workspace-store";
import type { StatusPage } from "@/lib/model";
import { ACCENT_PRESETS, accentShades, type AccentTheme } from "@/lib/accents";
import { isBuilt } from "@/lib/launch";

const swatches = ACCENT_PRESETS;

/** The editor's working copy. Components carry a key so React can follow them while they're
 *  renamed and reordered; the key never leaves the browser. */
type Comp = PageDraft["components"][number] & { key: string };
type Draft = Omit<PageDraft, "components"> & { components: Comp[] };

let seq = 0;
const newKey = () => `k${++seq}`;

function draftOf(p: StatusPage): Draft {
  return {
    slug: p.slug,
    name: p.name,
    logoText: p.logoText,
    homepage: p.homepage,
    accent: p.accent,
    theme: p.theme,
    poweredBy: p.poweredBy,
    noindex: p.noindex,
    membersOnly: p.membersOnly,
    historyDays: p.showHistoryDays === 30 ? 30 : 90,
    components: p.components.map((c) => ({ key: c.id, name: c.name, inApp: c.inApp, monitorIds: c.monitorIds })),
  };
}

const wire = (d: Draft): PageDraft => ({ ...d, components: d.components.map(({ name, inApp, monitorIds }) => ({ name, inApp, monitorIds })) });
const same = (a: Draft, b: Draft) => JSON.stringify(wire(a)) === JSON.stringify(wire(b));

function PageEditor({ s, id }: { s: Workspace; id: string }) {
  const page = s.pages.find((p) => p.id === id);
  if (!page) {
    return (
      <>
        <PageHead title="This status page isn't here any more" doc="Status page not found" back={{ href: "/app/status-pages", label: "Status pages" }} />
        <p className="t-2">Pick a page from <Link className="link" href="/app/status-pages">your status pages</Link>.</p>
      </>
    );
  }
  if (!s.can["pages:manage"]) {
    return (
      <>
        <PageHead title={page.name} back={{ href: "/app/status-pages", label: "Status pages" }} />
        <div className="empty"><strong>Editing status pages isn&apos;t part of your role in this workspace.</strong></div>
      </>
    );
  }
  return <Editor key={page.id} s={s} page={page} />;
}

function Editor({ s, page }: { s: Workspace; page: StatusPage }) {
  const acts = useActs();
  const router = useRouter();
  const del = useRef<HTMLDialogElement>(null);
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [saved, setSaved] = useState<Draft>(() => draftOf(page));
  const [draft, setDraft] = useState<Draft>(saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Partial<Record<PageEditorSection, boolean>>>({});
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState({ logoUrl: page.logoUrl, faviconUrl: page.faviconUrl });
  useEffect(() => setImages({ logoUrl: page.logoUrl, faviconUrl: page.faviconUrl }), [page.logoUrl, page.faviconUrl]);
  const dirty = !same(draft, saved);
  const app = s.apps.find((a) => a.id === page.appId);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const section = (name: PageEditorSection): SectionToggle => ({
    expanded: !collapsed[name],
    onToggle: () => setCollapsed(current => ({ ...current, [name]: !current[name] })),
  });
  const showErrors = (next: Record<string, string>) => {
    setErrors(next);
    setCollapsed(current => ({ ...current, ...Object.fromEntries(pageErrorSections(next).map(name => [name, false])) }));
  };

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // The preview is the public page itself, rendered from the working copy.
  const preview = useMemo<StatusPage>(
    () => ({
      ...page,
      ...draft,
      ...images,
      membersOnly: draft.membersOnly ?? false,
      showHistoryDays: draft.historyDays,
      components: draft.components.map((c) => ({ id: c.key, name: c.name, inApp: c.inApp, monitorIds: c.monitorIds })),
    }),
    [page, draft, images],
  );

  async function save() {
    if (busy) return;
    const body = wire(draft);
    const local = pageDraftErrors(body);
    setReason(null);
    showErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    const r = await acts.savePage(page.id, body);
    setBusy(false);
    if (!r.ok) {
      showErrors(r.fieldErrors ?? {});
      setReason(r.reason);
      return;
    }
    setSaved(draft);
  }

  // Where the saved page answers, from what this screen saved: the snapshot catches up a refresh later.
  const live: StatusPage = { ...page, slug: saved.slug, membersOnly: saved.membersOnly ?? false };

  function discard() {
    setDraft(saved);
    setErrors({});
    setReason(null);
  }

  return (
    <>
      <PageHead
        back={{ href: "/app/status-pages", label: "Status pages" }}
        doc={saved.name || "Status page"}
        title={saved.name || "Untitled page"}
        sub={<>The public page for {app?.name} at <span className="addr">{pageHost(live)}</span> <Copy text={pageUrl(live)} label="Copy address" icon /></>}
        actions={
          <>
            <Link href={`/s/${saved.slug}`} className="btn" target="_blank">View public page</Link>
            <button type="button" className="btn btn-quiet btn-icon" aria-label="Delete status page" onClick={() => del.current?.showModal()}><Trash2 aria-hidden="true" /></button>
          </>
        }
      />
      <div className="editor">
        <div className="stack">
          <div className={`pe-savebar ${dirty ? "dirty" : ""}`} role="region" aria-label="Save changes">
            <span className="t-2" aria-live="polite">{busy ? "Saving…" : dirty ? "You have changes that aren't public yet." : "Everything here is what visitors see."}</span>
            <div className="cluster">
              <button type="button" className="btn btn-sm" onClick={discard} disabled={!dirty || busy}>Discard</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || busy} aria-busy={busy}>{busy ? "Saving…" : "Save changes"}</button>
            </div>
          </div>
          {(reason || Object.keys(errors).length > 0) && (
            <div className="callout callout-down" role="alert">
              <span>{reason ?? "Check the highlighted fields."}{errors.components && <> {errors.components}.</>}</span>
            </div>
          )}
          <Branding {...section("branding")} draft={draft} set={set} errors={errors} pageId={page.id} images={images} setImages={setImages} />
          <Address {...section("address")} draft={draft} set={set} saved={saved} errors={errors} />
          <PageDomain page={page} canVerify={s.can["monitors:write"]} />
          <Components {...section("components")} s={s} page={page} draft={draft} set={set} />
          <Options {...section("options")} s={s} draft={draft} set={set} />
        </div>
        <aside className="preview-frame" aria-label="Preview">
          <div className="pe-preview-bar">
            <span className="preview-url">
              <Lock aria-hidden="true" width={14} height={14} />
              <span className="addr">https://{pageHost(preview)}</span>
            </span>
            <div className="seg pe-seg" role="radiogroup" aria-label="Preview size">
              <label>
                <input type="radio" name="pe-device" checked={device === "desktop"} onChange={() => setDevice("desktop")} />
                <span><MonitorIcon aria-hidden="true" />Desktop</span>
              </label>
              <label>
                <input type="radio" name="pe-device" checked={device === "phone"} onChange={() => setDevice("phone")} />
                <span><Smartphone aria-hidden="true" />Phone</span>
              </label>
            </div>
          </div>
          <div
            className={`preview-viewport${device === "phone" ? " phone" : ""}`}
            onClickCapture={(e) => {
              // Links in the preview would leave the editor; the public page has them working.
              if ((e.target as HTMLElement).closest("a")) e.preventDefault();
            }}
          >
            <StatusPageView view={viewFromSim(s, preview)} embedded />
          </div>
          <p className="t-meta">{dirty ? "The preview shows your changes. Visitors see them once you save." : "This is the public page as visitors see it. Links are switched off here."}</p>
        </aside>
      </div>

      <DeleteDialog ref={del} title={`Delete ${saved.name || "this status page"}?`} confirm="Delete status page" run={() => acts.deletePage(page.id)} onDone={() => router.replace("/app/status-pages")}>
        <p>The page at <span className="addr">{pageHost(live)}</span> stops answering, and links to its incidents stop working. The monitors it shows stay as they are. This can&apos;t be undone.</p>
      </DeleteDialog>
    </>
  );
}

type Part = SectionToggle & { draft: Draft; set: (p: Partial<Draft>) => void; errors: Record<string, string> };

/** The themes this page can show in which the accent isn't the colour picked: the shade its links
 *  wear and the one its focus ring and logo mark wear (`accents.ts`). */
function shiftedShades(accent: string, theme: StatusPage["theme"]) {
  const picked = accent.toLowerCase();
  const themes: AccentTheme[] = theme === "visitor" ? ["light", "dark"] : [theme];
  return themes.map((t) => ({ theme: t, picked, ...accentShades(accent, t) })).filter((s) => s.text !== picked || s.accent !== picked);
}

/** Says what a visitor sees where it differs from the input, so a dark page's lighter blue is
 *  no surprise. The hex is in the words; the chip beside it only shows it. */
function ShadeNotes({ id, shifted }: { id: string; shifted: ReturnType<typeof shiftedShades> }) {
  const shade = (c: string) => <><span className="pe-shade" style={{ background: c }} aria-hidden="true" /><span className="num">{c}</span></>;
  return (
    <div id={id} className="hint pe-shades">
      {shifted.map((s) => (
        <p key={s.theme}>
          On a {s.theme} page it&apos;s {s.theme === "light" ? "darkened" : "lightened"} to stay readable:{" "}
          {s.text === s.picked ? "links keep your colour" : <>links use {shade(s.text)}</>}, and{" "}
          {s.accent === s.picked ? "the focus ring and logo mark keep it" : <>the focus ring and logo mark use {shade(s.accent)}</>}.
        </p>
      ))}
    </div>
  );
}

function Branding({ draft, set, errors, pageId, images, setImages, expanded, onToggle }: Part & {
  pageId: string; images: Pick<StatusPage, "logoUrl" | "faviconUrl">;
  setImages: React.Dispatch<React.SetStateAction<Pick<StatusPage, "logoUrl" | "faviconUrl">>>;
}) {
  const [hex, setHex] = useState(draft.accent);
  const near = nearStatus(draft.accent);
  // Only for a colour the box holds: while it's mid-edit, the preview keeps the last one.
  const shifted = isHex(hex) ? shiftedShades(draft.accent, draft.theme) : [];
  const err = (k: string) => (errors[k] ? { "aria-invalid": true as const, "aria-describedby": `pe-${k}-err` } : {});

  // A discard or a swatch resets the text box to the colour in use.
  useEffect(() => setHex(draft.accent), [draft.accent]);

  return (
    <CollapsibleSection id="pe-brand" title="Branding" expanded={expanded} onToggle={onToggle}>
      <div className="stack">
        <div className="field">
          <label className="label" htmlFor="pe-name">Page name</label>
          <input id="pe-name" className="input" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} {...err("name")} />
          {errors.name ? <span className="error" id="pe-name-err">{errors.name}</span> : <span className="hint">The browser tab and search results show this.</span>}
        </div>
        <div className="field">
          <label className="label" htmlFor="pe-logo">Logo text</label>
          <input id="pe-logo" className="input" maxLength={40} value={draft.logoText} onChange={(e) => set({ logoText: e.target.value })} {...err("logoText")} />
          {errors.logoText && <span className="error" id="pe-logoText-err">{errors.logoText}</span>}
        </div>
        <PageAssetPicker pageId={pageId} kind="logo" url={images.logoUrl} onSaved={(logoUrl) => setImages((current) => ({ ...current, logoUrl }))} />
        <PageAssetPicker pageId={pageId} kind="favicon" url={images.faviconUrl} onSaved={(faviconUrl) => setImages((current) => ({ ...current, faviconUrl }))} />
        <div className="field">
          <label className="label" htmlFor="pe-home">Homepage link <span className="t-3">(optional)</span></label>
          <input id="pe-home" className="input mono" type="url" inputMode="url" spellCheck={false} value={draft.homepage} onChange={(e) => set({ homepage: e.target.value })} placeholder="https://example.com" {...err("homepage")} />
          {errors.homepage ? <span className="error" id="pe-homepage-err">{errors.homepage}</span> : <span className="hint">Your logo and the link at the top go here.</span>}
        </div>

        <fieldset className="pe-fieldset">
          <legend className="label">Accent colour</legend>
          <div className="swatches">
            {swatches.map((w) => (
              <button
                key={w.hex}
                type="button"
                className="swatch-btn"
                style={{ background: w.hex }}
                aria-pressed={draft.accent.toLowerCase() === w.hex}
                aria-label={`${w.name}, ${w.hex}`}
                title={w.name}
                onClick={() => set({ accent: w.hex })}
              />
            ))}
          </div>
          <div className="pe-hex">
            <label className="sr-only" htmlFor="pe-hex">Hex colour</label>
            <span className="pe-chip" style={{ background: isHex(draft.accent) ? draft.accent : undefined }} aria-hidden="true" />
            <input
              id="pe-hex"
              className="input mono"
              value={hex}
              maxLength={7}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!isHex(hex) || undefined}
              aria-describedby={shifted.length ? "pe-hex-h pe-hex-shades" : "pe-hex-h"}
              onChange={(e) => {
                let v = e.target.value.trim();
                if (v && !v.startsWith("#")) v = `#${v}`;
                setHex(v);
                if (isHex(v)) set({ accent: v.toLowerCase() });
              }}
            />
          </div>
          <span id="pe-hex-h" className={isHex(hex) ? "hint" : "error"}>
            {isHex(hex) ? "Colours your page's links, its keyboard focus ring, and the logo mark when there's no logo image. Status keeps its own colours." : `Enter # and six hex digits, like ${ACCENT_PRESETS[0].hex}.`}
          </span>
          {shifted.length > 0 && <ShadeNotes id="pe-hex-shades" shifted={shifted} />}
          {near && (
            <div className="callout callout-info">
              <Info aria-hidden="true" />
              <span>
                Your accent is close to the {near} that means {near === "amber" ? "degraded" : near === "red" ? "an outage" : "operational"} on a status page. That&apos;s fine: status always shows its icon and its word as well as its colour, so visitors won&apos;t read your brand as a status.
              </span>
            </div>
          )}
        </fieldset>

        <fieldset className="pe-fieldset">
          <legend className="label">Theme</legend>
          <div className="seg" role="radiogroup" aria-label="Theme">
            {(
              [
                ["light", "Light"],
                ["dark", "Dark"],
                ["visitor", "Follow the visitor"],
              ] as const
            ).map(([v, l]) => (
              <label key={v}>
                <input type="radio" name="pe-theme" checked={draft.theme === v} onChange={() => set({ theme: v })} />
                <span>{l}</span>
              </label>
            ))}
          </div>
          <span className="hint">{draft.theme === "visitor" ? "Light or dark, from each visitor's device setting." : `Always ${draft.theme}, whatever the visitor's device prefers.`}</span>
        </fieldset>
      </div>
    </CollapsibleSection>
  );
}

function Address({ draft, set, saved, errors, expanded, onToggle }: Part & { saved: Draft }) {
  const moved = draft.slug !== saved.slug;
  const reserved = RESERVED_SLUGS.includes(draft.slug);
  return (
    <CollapsibleSection id="pe-addr" title="Address" expanded={expanded} onToggle={onToggle}>
      <div className="stack">
        <div className="field">
          <div className="cluster">
            <label className="label" htmlFor="pe-slug">Staygreen address</label>
            {/* The input is an unsaved draft; hide Copy while it differs so it never copies
                an address that has not been saved or silently copies a different visible slug. */}
            {!moved && <Copy text={saved.membersOnly ? `https://staygreen.io/s/${saved.slug}` : `https://${statusHost()}/${saved.slug}`} label="Copy Staygreen address" icon />}
          </div>
          <div className="input-group pe-slug">
            <span className="input-prefix addr">{saved.membersOnly ? "staygreen.io/s/" : `${statusHost()}/`}</span>
            <input
              id="pe-slug"
              className="input mono"
              value={draft.slug}
              maxLength={40}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
              aria-invalid={!!errors.slug || reserved || undefined}
              aria-describedby="pe-slug-h"
            />
          </div>
          <span id="pe-slug-h" className={errors.slug || reserved ? "error" : "hint"}>
            {errors.slug ?? (reserved ? "That address is reserved. Pick another" : moved ? `Once you save, ${saved.membersOnly ? "staygreen.io/s/" : `${statusHost()}/`}${saved.slug} stops working. Update any links to it.` : "Lowercase letters, digits and dashes.")}
          </span>
        </div>

      </div>
    </CollapsibleSection>
  );
}

function Components({ s, page, draft, set, expanded, onToggle }: SectionToggle & { s: Workspace; page: StatusPage; draft: Draft; set: (p: Partial<Draft>) => void }) {
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const mons = s.monitors.filter((m) => m.appId === page.appId);
  const save = (components: Comp[]) => set({ components });
  const update = (key: string, patch: Partial<Comp>) => save(draft.components.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const listRef = useRef<HTMLUListElement>(null);
  const movedButton = useRef<{ key: string; direction: -1 | 1 } | null>(null);

  useLayoutEffect(() => {
    if (!movedButton.current) return;
    const { key, direction } = movedButton.current;
    const button = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-move]") ?? [])
      .find(el => el.dataset.key === key && el.dataset.move === String(direction));
    button?.focus();
    movedButton.current = null;
  }, [draft.components]);

  const move = (key: string, direction: -1 | 1) => {
    const components = moveComponent(draft.components, key, direction);
    if (components === draft.components) return;
    movedButton.current = { key, direction };
    save(components);
  };

  useEffect(() => {
    if (!focusKey) return;
    const el = listRef.current?.querySelector<HTMLInputElement>(`input[data-key="${focusKey}"]`);
    el?.focus();
    el?.select();
    setFocusKey(null);
  }, [focusKey]);

  return (
    <CollapsibleSection id="pe-comps" title="Components" expanded={expanded} onToggle={onToggle} actions={
        <button
          type="button"
          className="btn btn-sm"
          disabled={draft.components.length >= 50}
          onClick={() => {
            const key = newKey();
            save([...draft.components, { key, name: "New component", monitorIds: [], inApp: false }]);
            setFocusKey(key);
          }}
        >
          <Plus aria-hidden="true" />
          Add component
        </button>
      }>
      <p className="t-2 pe-lead">What your users recognise, each checked by one or more monitors. A component is as healthy as its worst monitor.</p>
      {draft.components.length === 0 ? (
        <p className="t-meta">No components yet. The page says so until you add one.</p>
      ) : (
        <ul className="pe-comps" ref={listRef}>
          {draft.components.map((c, i) => {
            const names = c.monitorIds.map((id) => mons.find((m) => m.id === id)?.name).filter(Boolean);
            const inputId = `pe-c-${i}`;
            return (
              <li key={c.key} className="pe-comp">
                <div className="pe-comp-head">
                  <div className="field grow">
                    <label className="label" htmlFor={inputId}>Name</label>
                    <input id={inputId} data-key={c.key} className="input" maxLength={80} value={c.name} aria-invalid={!c.name.trim() || undefined} onChange={(e) => update(c.key, { name: e.target.value })} />
                  </div>
                  <div className="cluster">
                    {/* aria-disabled keeps the moved button focusable even at an end; move()
                        refuses that direction for mouse and keyboard alike. Native disabled
                        would drop focus just when the row reaches its destination. */}
                    <button type="button" className="btn btn-sm btn-icon btn-quiet" aria-label={`Move ${c.name || "this component"} up`} aria-disabled={i === 0}
                      data-key={c.key} data-move={-1} onClick={() => move(c.key, -1)}><ArrowUp aria-hidden="true" /></button>
                    <button type="button" className="btn btn-sm btn-icon btn-quiet" aria-label={`Move ${c.name || "this component"} down`} aria-disabled={i === draft.components.length - 1}
                      data-key={c.key} data-move={1} onClick={() => move(c.key, 1)}><ArrowDown aria-hidden="true" /></button>
                    <button type="button" className="btn btn-sm btn-icon btn-quiet" aria-label={`Remove ${c.name || "this component"}`} title="Remove component" onClick={() => save(draft.components.filter((x) => x.key !== c.key))}>
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {!c.name.trim() && <span className="error">Give it a name your users would recognise, like Website.</span>}
                <details className="pe-mons">
                  <summary>
                    <span>{names.length ? <>Checked by {names.join(", ")}</> : "Choose the monitors that check it"}</span>
                    <ChevronDown className="pe-mons-chev" aria-hidden="true" />
                  </summary>
                  <fieldset className="pe-fieldset">
                    <legend className="sr-only">Monitors for {c.name}</legend>
                    {mons.length === 0 && <p className="t-meta">This app has no monitors yet. <Link className="link" href={`/app/monitors/new?app=${page.appId}`}>Add one</Link>.</p>}
                    {mons.map((m) => (
                      <label key={m.id} className="check pe-mon">
                        <input type="checkbox" checked={c.monitorIds.includes(m.id)} onChange={(e) => update(c.key, { monitorIds: e.target.checked ? [...c.monitorIds, m.id] : c.monitorIds.filter((x) => x !== m.id) })} />
                        <TypeIcon type={m.type} size={16} />
                        <span>{m.name}</span>
                      </label>
                    ))}
                  </fieldset>
                </details>
                {c.monitorIds.length === 0 && <span className="hint">Not on the page until a monitor checks it.</span>}
                {/* The switch says which components the in-app banner reports; shown once the
                    banner is served (`BACKLOG.md`). */}
                {isBuilt("widget") && (
                  <div className="stack-sm">
                  <label className="switch">
                    <input type="checkbox" role="switch" checked={c.inApp} onChange={(e) => update(c.key, { inApp: e.target.checked })} />
                    <span>Show in your app&apos;s banner</span>
                  </label>
                  <p className="hint">With the widget installed at the top of your app, this component can show a banner while degraded or down and its incident has a published update. A dismissal lasts until the next update.</p>
                  <div className="sg-banner degraded"><p className="sg-banner-body">Example: {c.name} is delayed. We&apos;re investigating. <span className="sg-banner-link">See the status page</span></p></div>
                  <p className="hint">Example only. Install the script from Widget and badge. Members-only pages never show a banner.</p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </CollapsibleSection>
  );
}

function Options({ s, draft, set, expanded, onToggle }: SectionToggle & { s: Workspace; draft: Draft; set: (p: Partial<Draft>) => void }) {
  const white = holds(s, "white_label");
  const priv = holds(s, "private_pages");
  return (
    <CollapsibleSection id="pe-opts" title="Options" expanded={expanded} onToggle={onToggle}>
      <ul className="pe-switches">
        <li className="pe-switch">
          <fieldset className="pe-fieldset">
            <legend className="label">Incident history</legend>
            <div className="seg" role="radiogroup" aria-label="Incident history">
              {([30, 90] as const).map((d) => (
                <label key={d}>
                  <input type="radio" name="pe-hist" checked={draft.historyDays === d} onChange={() => set({ historyDays: d })} />
                  <span>{d} days</span>
                </label>
              ))}
            </div>
            <span className="hint">How far back the page lists past incidents and draws uptime. On a phone the bars show the last 30 days.</span>
          </fieldset>
        </li>
        <li className="pe-switch">
          <div className="pe-switch-row">
            <label className="switch">
              {/* Without the feature the switch stays as it is and opens what Builder adds, rather
                  than sitting disabled (`design/README.md`, principle 8). */}
              <input type="checkbox" role="switch" checked={white && !draft.poweredBy} aria-describedby="pe-sw-white"
                onClick={(e) => { if (!white) { e.preventDefault(); showOffer("pe-offer-white"); } }}
                onChange={(e) => { if (white) set({ poweredBy: !e.target.checked }); }} />
              <span>Remove “Powered by Staygreen”</span>
            </label>
            <BuilderTag locked={!white} offer="whiteLabel" id="pe-offer-white" />
          </div>
          <span id="pe-sw-white" className="hint">The page footer shows only your brand.{!white && " Comes with Builder."}</span>
        </li>
        <li className="pe-switch">
          <div className="pe-switch-row">
            <label className="switch">
              <input type="checkbox" role="switch" checked={priv && draft.noindex} aria-describedby="pe-sw-noindex"
                onClick={(e) => { if (!priv) { e.preventDefault(); showOffer("pe-offer-noindex"); } }}
                onChange={(e) => { if (priv) set({ noindex: e.target.checked }); }} />
              <span>Hide from search engines</span>
            </label>
            <BuilderTag locked={!priv} offer="privatePages" id="pe-offer-noindex" />
          </div>
          <span id="pe-sw-noindex" className="hint">Search engines are asked not to list the page.{!priv && " Comes with Builder."}</span>
        </li>
        <li className="pe-switch">
          <div className="pe-switch-row">
            <label className="switch">
              <input type="checkbox" role="switch" checked={draft.membersOnly ?? false} aria-describedby="pe-sw-members"
                onClick={(e) => { if (!priv && !draft.membersOnly) { e.preventDefault(); showOffer("pe-offer-members"); } }}
                onChange={(e) => { if (priv || draft.membersOnly) set({ membersOnly: e.target.checked }); }} />
              <span>Members only</span>
            </label>
            <BuilderTag locked={!priv} offer="privatePages" id="pe-offer-members" />
          </div>
          <span id="pe-sw-members" className="hint">Only members of this workspace, signed in, can open the page and its incidents. No public badge, summary or custom domain. Existing members-only pages stay private after a plan change.</span>
        </li>
        <li className="pe-switch">
          <div className="pe-switch-row">
            <label className="switch">
              <input type="checkbox" role="switch" checked={false} disabled aria-describedby="pe-sw-subs" />
              <span>Email subscribers</span>
            </label>
            <SoonTag />
          </div>
          <span id="pe-sw-subs" className="hint">Visitors subscribe with double opt-in and hear about incidents. Part of Builder when it ships.</span>
        </li>
      </ul>
    </CollapsibleSection>
  );
}

export function PageEditorScreen({ id }: { id: string }) {
  const s = useWorkspace();
  return s ? <PageEditor s={s} id={id} /> : <Loading />;
}
