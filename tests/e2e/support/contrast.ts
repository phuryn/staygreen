import type { Locator } from "@playwright/test";

/* WCAG contrast of an element's edge and of a thin divider, measured on the rendered page.
   Each colour is composited in a 1x1 canvas over the backgrounds behind it, so a tint, a
   `color-mix()` or any other format the browser computes is measured as it is painted. The edge
   is the element's border if it has one, otherwise a 1px ring drawn with `box-shadow` (no blur,
   no offset, a spread), which is how Clerk outlines its inputs and buttons. */

export type Measured = { edge: number; fill: number };

/** Waits out the element's running transitions (Clerk animates its box-shadow), so the next reading is the state's
 *  end, never a frame on the way to it. Two frames first, so a transition the last action started has begun. */
export async function settled(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
}

export function edgeContrast(locator: Locator): Promise<Measured> {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (colours: string[]) => {
      ctx.globalCompositeOperation = "copy";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 1, 1);
      ctx.globalCompositeOperation = "source-over";
      for (const colour of colours) { ctx.fillStyle = "#000000"; ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1); }
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const alpha = (colour: string) => {
      ctx.globalCompositeOperation = "copy";
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = "#000000";
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data[3];
    };
    const luminance = ([r, g, b]: number[]) => {
      const f = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
      return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
    };
    const behind = (e: Element | null) => {
      const out: string[] = [];
      for (let n = e; n; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        if (alpha(bg) > 0) out.unshift(bg);
        if (alpha(bg) === 255) break;
      }
      return out;
    };
    const style = getComputedStyle(element);
    const outside = behind(element.parentElement);
    const around = paint(outside);
    // A divider drawn as a fill. A box with no area paints nothing, so it measures as no edge at all.
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height || style.visibility !== "visible") return { edge: 1, fill: 1 };
    if (alpha(style.backgroundColor) > 0 && (box.height <= 2 || box.width <= 2)) {
      const line = paint([...outside, style.backgroundColor]);
      return { edge: ratio(line, around), fill: ratio(line, around) };
    }
    const fill = paint([...outside, ...(alpha(style.backgroundColor) > 0 ? [style.backgroundColor] : [])]);
    let edge: number[] | undefined;
    const width = parseFloat(style.borderTopWidth) || parseFloat(style.borderBottomWidth);
    const borderColour = parseFloat(style.borderTopWidth) ? style.borderTopColor : style.borderBottomColor;
    if (width >= 0.5 && alpha(borderColour) > 0) edge = paint([...outside, ...(alpha(style.backgroundColor) > 0 ? [style.backgroundColor] : []), borderColour]);
    else {
      const parts: string[] = [];
      let depth = 0, current = "";
      for (const ch of style.boxShadow) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; } else current += ch;
      }
      if (current.trim()) parts.push(current.trim());
      const rings = parts.flatMap((p) => {
        const colour = p.match(/^(rgba?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|lab\([^)]*\)|#[0-9a-f]+)/i)?.[0] ?? "";
        const [x = 0, y = 0, blur = 0, spread = 0] = p.replace(colour, "").match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
        return colour && !/inset/.test(p) && x === 0 && y === 0 && blur === 0 && spread >= 0.5 ? [colour] : [];
      });
      if (rings.length) edge = paint([...outside, ...rings.reverse()]);
    }
    return { edge: edge ? ratio(edge, around) : 1, fill: ratio(fill, around) };
  });
}
