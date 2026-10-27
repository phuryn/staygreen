import { describe, expect, it } from "vitest";
import { colourDistance, isBrandColour, oklch, parseColour } from "@/lib/colour";
import { accentShades, contrast, MARK_RATIO, PAGE_NEUTRALS, TEXT_RATIO } from "@/lib/accents";

/* Colours as sites write them, and which of them count as a brand colour (`colour.ts`): the
   first step of finding a site's accent (`brand.ts`). The numbers are the design skill's
   `color.py`, measured on 2026-10-22. */

describe("parseColour", () => {
  it.each([
    ["#635BFF", "#635bff"],
    ["#63f", "#6633ff"],
    ["#6633ffee", "#6633ff"],
    ["#63fe", "#6633ff"],
    ["rgb(99, 91, 255)", "#635bff"],
    ["rgb(99 91 255)", "#635bff"],
    ["rgba(99, 91, 255, 1)", "#635bff"],
    ["rgb(99 91 255 / 95%)", "#635bff"],
    ["rgb(79 70 229/var(--tw-bg-opacity))", "#4f46e5"],
    ["rgb(79 70 229 / var(--tw-bg-opacity, 1))", "#4f46e5"],
    ["hsl(243, 75%, 59%)", "#5048e5"],
    ["hsl(243deg 75% 59%)", "#5048e5"],
    ["oklch(0.585 0.233 277.117)", "#615fff"],
    ["oklch(58.5% 0.233 277.117)", "#615fff"],
    // The bare channel lists design systems keep in custom properties.
    ["222.2 47.4% 11.2%", "#0f172a"],
    ["99 91 255", "#635bff"],
    ["13,110,253", "#0d6efd"],
    ["#1F2DE6 !important", "#1f2de6"],
  ])("reads %s as %s", (raw, hex) => {
    expect(parseColour(raw)).toBe(hex);
  });

  it.each([
    "transparent",
    "red",
    "currentColor",
    "var(--brand)",
    "rgba(99, 91, 255, 0.5)",
    "#635bff80",
    "#63f8",
    "rgb(300 0 0)",
    "hsl(240 150% 50%)",
    "linear-gradient(#635bff, #fff)",
    "#12345",
    "99 91",
    "1 2 3 4",
    "",
  ])("reads %s as no colour", (raw) => {
    expect(parseColour(raw)).toBeNull();
  });
});

describe("isBrandColour", () => {
  it.each([
    ["#635bff", "Stripe's blurple"],
    ["#0a2540", "Stripe's navy, dark but not black (L 0.26, C 0.06)"],
    ["#1b2a4a", "a navy just over the neutral line (C 0.062)"],
    ["#1f2de6", "Staygreen's own cobalt"],
    ["#ffff00", "pure yellow, light but saturated (L 0.97, C 0.21)"],
    ["#e11d48", "a red: a site's brand may be one"],
    ["#16a34a", "and so may a green"],
  ])("counts %s, %s", (hex) => {
    expect(isBrandColour(hex)).toBe(true);
  });

  it.each([
    ["#64748b", "Tailwind's slate-500 (C 0.041)"],
    ["#808080", "a grey"],
    ["#0f172a", "slate-900, near-black (L 0.21)"],
    ["#1a1033", "a deep purple that reads black (L 0.21)"],
    ["#000000", "black"],
    ["#ffffff", "white"],
    ["#e0e7ff", "a pale wash behind content (L 0.93, C 0.04)"],
    ["#f8fafc", "slate-50"],
  ])("never counts %s, %s", (hex) => {
    expect(isBrandColour(hex)).toBe(false);
  });

  it("agrees with the design skill's numbers", () => {
    const navy = oklch("#0a2540");
    expect(navy.L).toBeCloseTo(0.26, 2);
    expect(navy.C).toBeCloseTo(0.06, 2);
    expect(oklch("#64748b").C).toBeCloseTo(0.041, 3);
  });

  it("gives every colour it counts shades that hold the kit's contrast floors, in both themes", () => {
    // `accentShades` is what a status page wears (`accents.test.ts` holds it across the wheel);
    // a brand colour needs nothing from the run beyond being one.
    for (const hex of ["#635bff", "#0a2540", "#ffff00", "#1f2de6", "#000080", "#e11d48", "#16a34a", "#06b6d4"]) {
      expect(isBrandColour(hex)).toBe(true);
      for (const theme of ["light", "dark"] as const) {
        const s = accentShades(hex, theme);
        for (const ground of PAGE_NEUTRALS[theme].grounds) {
          expect(contrast(s.text, ground)).toBeGreaterThanOrEqual(TEXT_RATIO);
          expect(contrast(s.accent, ground)).toBeGreaterThanOrEqual(MARK_RATIO);
        }
        expect(contrast(s.onAccent, s.accent)).toBeGreaterThanOrEqual(TEXT_RATIO);
      }
    }
  });
});

describe("colourDistance", () => {
  it("is zero for one colour written two ways, and large between two colours", () => {
    expect(colourDistance(parseColour("rgb(99 91 255)")!, "#635bff")).toBe(0);
    expect(colourDistance("#635bff", "#625bfe")).toBeLessThan(0.01);
    expect(colourDistance("#635bff", "#e11d48")).toBeGreaterThan(0.3);
  });
});
