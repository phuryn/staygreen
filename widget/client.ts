/** The only browser network request is the public summary, without cookies or referrers.
 * This is bundled separately: no application/identity code enters a customer's page. */
export function installWidget(doc: Document, win: Window) {
  try {
    const script = doc.currentScript as HTMLScriptElement | null;
    const slug = script?.dataset.page ?? "";
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) return;
    const nonce = script?.nonce;
    const source = new URL(script!.src);
    if (source.protocol !== "https:" || source.username || source.password) return;
    const page = `${source.origin}/${slug}`;
    const key = `staygreen:${slug}:dismissed`;
    let dismissed = "";
    try { dismissed = win.localStorage.getItem(key) ?? ""; } catch { /* Memory dismissal still works. */ }
    type Host = { root: ShadowRoot; banner: boolean; view?: {
      style: HTMLElement; box: HTMLElement; label: HTMLElement; mark?: HTMLElement; noteId: string;
    } };
    const hosts: Host[] = [];
    const start = () => {
      for (const el of doc.querySelectorAll<HTMLElement>('[data-staygreen="banner"], [data-staygreen="pill"]')) {
        try { if (!el.shadowRoot) hosts.push({ root: el.attachShadow({ mode: "open" }), banner: el.dataset.staygreen === "banner" }); } catch { /* A host may not support a shadow root. */ }
      }
      if (!hosts.length) return;
      const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
      const element = (tag: string, label = "") => { const el = doc.createElement(tag); el.textContent = label; return el; };
      const link = (label: string) => { const el = element("a", label) as HTMLAnchorElement; el.href = page; el.target = "_blank"; el.rel = "noopener noreferrer"; return el; };
      const clear = (host: Host) => { if (host.view) { host.root.replaceChildren(); host.view = undefined; } };
      const setText = (el: HTMLElement, value: string) => { if (el.textContent !== value) el.textContent = value; };
      const poll = async () => {
        if (doc.visibilityState === "hidden") return;
        const controller = new AbortController(); const timer = win.setTimeout(() => controller.abort(), 8000);
        try {
          const response = await win.fetch(`${page}/summary.json`, { credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
          if (!response.ok || !response.body) throw Error();
          const reader = response.body.getReader(); let size = 0; let body = ""; const decoder = new TextDecoder();
          try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) { await reader.cancel(); throw Error(); } body += decoder.decode(value, { stream: true }); } }
          finally { reader.releaseLock(); }
          const data = JSON.parse(body + decoder.decode());
          if (data.page !== slug || !text(data.headline, 4000) || !Array.isArray(data.components) || data.components.length > 100 || !data.branding || typeof data.branding.mark !== "boolean") throw Error();
          const states = ["operational", "degraded", "down", "paused", "unchecked"];
          if (!states.includes(data.status)) throw Error();
          const colour = (value: unknown, fallback: string) => (typeof value === "string" && /^#[a-f0-9]{6}$/i.test(value) ? value : fallback).toLowerCase();
          const affected = data.components.some((c: { in_app?: boolean; status?: string }) => c?.in_app === true && ["down", "degraded"].includes(c.status ?? ""));
          const note = data.incident;
          const show = affected && note && text(note.note, 2000) && text(note.update_id, 200) && note.update_id && note.update_id !== dismissed;
          // Copies of the kit's light/dark ink and surface; no host selector or global CSS.
          const css = ':host{font:14px/1.5 system-ui,sans-serif;color:#0B0C0E}section{display:flex;gap:12px;align-items:center;padding:12px 16px;background:#FFFFFF;border:1px solid #D3D7DE;border-radius:8px}p{margin:0;flex:1;overflow-wrap:anywhere}a{color:inherit;text-decoration:underline;text-underline-offset:3px}button{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:8px;min-width:32px;min-height:32px;cursor:pointer}a:focus-visible,button:focus-visible{outline:2px solid currentColor;outline-offset:3px}small{display:block}@media(prefers-color-scheme:dark){:host{color:#F2F3F5}section{background:#121418;border-color:#353A43}}' +
            `a{color:${colour(data.branding.link_light, "#0B0C0E")}}@media(prefers-color-scheme:dark){a{color:${colour(data.branding.link_dark, "#F2F3F5")}}}`;
          for (const host of hosts) {
            const { root, banner } = host;
            if (banner && !show) { clear(host); continue; }
            const mount = !host.view;
            if (!host.view) {
              const style = element("style"); if (nonce) style.nonce = nonce;
              const box = element("section"); const label = banner ? element("span") : link("");
              host.view = { style, box, label, noteId: "" };
              if (banner) {
                box.setAttribute("role", "status"); box.setAttribute("aria-live", "polite");
                const p = element("p"); p.append(label, element("br"), link("See the status page"));
                const close = element("button", "×") as HTMLButtonElement; close.type = "button"; close.setAttribute("aria-label", "Dismiss this update");
                close.addEventListener("click", () => { try { if (!host.view) return; dismissed = host.view.noteId; try { win.localStorage.setItem(key, dismissed); } catch { /* Memory fallback. */ } for (const h of hosts) if (h.banner) clear(h); } catch { /* Never escape into the host's event handler. */ } });
                box.append(p, close);
              } else box.append(label);
            }
            // Keep controls and the live region mounted. An unchanged poll makes no DOM writes;
            // a changed sentence updates only its label, preserving focus and the status link.
            const view = host.view;
            view.noteId = banner ? note.update_id : "";
            setText(view.label, banner ? note.note : data.headline);
            setText(view.style, css);
            if (data.branding.mark && !view.mark) { view.mark = element("small", "Powered by Staygreen"); view.box.append(view.mark); }
            else if (!data.branding.mark && view.mark) { view.mark.remove(); view.mark = undefined; }
            if (mount) root.append(view.style, view.box);
          }
        } catch { try { for (const host of hosts) clear(host); } catch { /* Host removed a node while rendering. */ } }
        finally { win.clearTimeout(timer); }
      };
      // Sequential polling: no overlapping requests, and no work while hidden.
      const tick = async () => { try { await poll(); win.setTimeout(() => { void tick(); }, 5000); } catch { /* A host may disable timers. */ } };
      void tick();
    };
    const safeStart = () => { try { start(); } catch { /* A host can disable DOM APIs. */ } };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", safeStart, { once: true }); else safeStart();
  } catch { /* A blocked API or malformed embed must never break the host app. */ }
}
if (typeof document !== "undefined") installWidget(document, window);
