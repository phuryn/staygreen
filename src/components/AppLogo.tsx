import type { App } from "@/lib/model";
import { accentShades, isHex } from "@/lib/accents";

/** The sizes an app's logo is drawn at. App uploads use the largest at 3x
 *  (`PAGE_ASSET_BOX.app`, `src/lib/page-assets.ts`), which `tests/unit/page-assets.test.ts` holds.
 *  A copied page header image may be wider; object-fit contains it in the same box. */
export const APP_LOGO_SIZES = [20, 24, 32] as const;
export type AppLogoSize = (typeof APP_LOGO_SIZES)[number];

/** An app's logo beside its name, wherever an app is named: the image it has, chosen in Settings
 *  or imported from its site's icon, or its first letter in the app's brand colour. Decorative,
 *  since the name is always beside it. Without a brand colour it keeps the neutral fallback. */
export function AppLogo({ app, size = 24 }: { app: Pick<App, "name" | "logoUrl" | "accent">; size?: AppLogoSize }) {
  if (app.logoUrl) {
    // A same-origin image from `/page-assets/`; copied artwork keeps its original bytes.
    return <img className="app-logo" src={app.logoUrl} alt="" width={size} height={size} />;
  }
  const initial = [...app.name.trim()][0]?.toUpperCase() ?? "";
  // The same brand fill in either dashboard theme; the existing contrast function chooses
  // readable ink. This is the app's artwork, not a dashboard action or monitor state.
  const brand = app.accent && isHex(app.accent) ? accentShades(app.accent, "light") : null;
  return (
    <span className="app-logo app-logo-none" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.5),
      ...(brand ? { "--app-logo-fill": brand.accent, "--app-logo-ink": brand.onAccent } : {}) }}>
      {initial}
    </span>
  );
}
