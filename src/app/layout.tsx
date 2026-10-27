import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import localFont from "next/font/local";
import { ClerkProvider } from "@clerk/nextjs";
import { THEME_COOKIE } from "@/lib/theme-cookie";
import { metadataBase } from "@/lib/public-metadata";
import "@fontsource-variable/jetbrains-mono";
import "../../design/tokens.css";
import "../../design/kit.css";
import "@/styles/site.css";
import "@/styles/app.css";
import "@/styles/status.css";
import "@/styles/pages-a.css";
import "@/styles/pages-b.css";
import "@/styles/pages-c.css";
import "@/styles/landing.css";

// Switzer (Fontshare, ITF Free Font License) is the one typeface for the site and the app.
// JetBrains Mono sets real code only.
const switzer = localFont({ src: "./fonts/Switzer-Variable.woff2", weight: "100 900", display: "swap", variable: "--font-switzer" });

// No page declares `openGraph` or `twitter` (`AGENTS.md § 1.3`, share cards).
export const metadata: Metadata = {
  metadataBase: metadataBase(),
  title: { default: "Staygreen: your app is up. Is it working?", template: "%s – Staygreen" },
  description: "Monitoring that reads what your app returns, runs your crons' heartbeats and watches Stripe webhooks. Alerts on Telegram, a status page, and read access for your coding agent.",
  robots: { index: false, follow: false },
  openGraph: { type: "website", siteName: "Staygreen", locale: "en_US" },
  twitter: { card: "summary_large_image" },
  // Explicit metadata lets a status page override this with its uploaded favicon or logo.
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Clerk's components wear the kit's tokens, so they follow the theme with the rest of the page.
const appearance = {
  variables: {
    colorPrimary: "var(--clerk-primary)",
    // Clerk can't read a contrast from a variable, and guessed dark text on dark mode's lighter accent.
    colorPrimaryForeground: "var(--on-accent)",
    colorBackground: "var(--surface)",
    colorForeground: "var(--ink)",
    colorMutedForeground: "var(--ink-3)",
    colorInput: "var(--surface)",
    colorInputForeground: "var(--ink)",
    colorDanger: "var(--down)",
    colorSuccess: "var(--up)",
    colorWarning: "var(--warn)",
    colorNeutral: "var(--ink)",
    fontFamily: "var(--f-sans)",
    borderRadius: "var(--r-2)",
  },
};

// The sign-up card's first words say what's being made: a workspace, on Free.
const localization = {
  signUp: {
    start: {
      title: "Create your free workspace",
      titleCombined: "Create your free workspace",
      subtitle: "Free plan, no card. Then you name your first app and add its monitors.",
      subtitleCombined: "Free plan, no card. Then you name your first app and add its monitors.",
    },
  },
};

// The theme is rendered on the server from a first-party cookie (`AGENTS.md § 1.3`).
// "system" sets no attribute, so prefers-color-scheme decides.
//
// `<ClerkProvider>` takes the CSP nonce Clerk's middleware issued, and never `dynamic`, which
// would read the session into every page it wraps, the front door included (`§ 1.5`). Sign-in
// and sign-up land on the member home; signing out goes to the front door.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get(THEME_COOKIE)?.value;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const dataTheme = theme === "light" || theme === "dark" ? theme : undefined;
  return (
    <ClerkProvider
      nonce={nonce}
      appearance={appearance}
      localization={localization}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/app"
      signUpFallbackRedirectUrl="/app"
      afterSignOutUrl="/"
    >
      <html lang="en" data-theme={dataTheme} className={switzer.variable}>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
