import { cloneReturnPath } from "@/lib/clone-return-path";
import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";

// Clerk's own component is the sign-in surface (`AGENTS.md § 1.5`), dressed by the root
// layout's `appearance`. Its card is the page: it carries the heading, which changes with each
// step, and the link to sign up, so nothing around it repeats them. Which ways in it offers is
// set in the Clerk dashboard, not here: Google, or an email with a password and a code sent to
// it, in both instances (spec.md § 12).

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ redirect_url?: string | string[] }> }) {
  const returnTo = cloneReturnPath((await searchParams).redirect_url);
  const otherUrl = returnTo ? `/sign-up?redirect_url=${encodeURIComponent(returnTo)}` : "/sign-up";

  return (
    <div className="wrap band-tight">
      <div className="narrow pb-touch pb-signin">
        <SignIn path="/sign-in" signUpUrl={otherUrl}
          fallbackRedirectUrl={returnTo} signUpFallbackRedirectUrl={returnTo} />
      </div>
    </div>
  );
}
