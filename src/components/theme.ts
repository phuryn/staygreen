"use client";

import { THEME_COOKIE, THEME_COOKIE_MAX_AGE } from "@/lib/theme-cookie";

export type ThemeChoice = "system" | "light" | "dark";

export function currentTheme(): ThemeChoice {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}

export function setTheme(t: ThemeChoice) {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme;
  else root.dataset.theme = t;
  document.cookie = `${THEME_COOKIE}=${t}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
}
