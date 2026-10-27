import type { App } from "@/lib/model";

/** The sizes an app's logo is drawn at. Its stored image is the largest at 3x
 *  (`PAGE_ASSET_BOX.app`, `src/lib/page-assets.ts`), which `tests/unit/page-assets.test.ts` holds. */
export const APP_LOGO_SIZES = [20, 24, 32] as const;
export type AppLogoSize = (typeof APP_LOGO_SIZES)[number];

/** An app's logo beside its name, wherever an app is named: the image it has, chosen in Settings
 *  or imported from its site's icon, or its first letter on a neutral square. Decorative, since
 *  the name is always beside it. Never a status colour, and never the accent: it is neither a
 *  state nor something to press. */
export function AppLogo({ app, size = 24 }: { app: Pick<App, "name" | "logoUrl">; size?: AppLogoSize }) {
  if (app.logoUrl) {
    // A same-origin image from `/page-assets/`, already the size it is drawn at.
    return <img className="app-logo" src={app.logoUrl} alt="" width={size} height={size} />;
  }
  const initial = [...app.name.trim()][0]?.toUpperCase() ?? "";
  return (
    <span className="app-logo app-logo-none" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}>
      {initial}
    </span>
  );
}
