/* The theme cookie's name and lifetime, in a module with no directive so the server (the root
   layout, the privacy policy) and the browser (`src/components/theme.ts`) read the same values.
   A `"use client"` module's exports reach a server component as client references, not values,
   which is why these don't live in `theme.ts`. */

export const THEME_COOKIE = "sg-theme";

/** One year, in seconds. */
export const THEME_COOKIE_MAX_AGE = 31_536_000;
