import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";

// The workspace is a Clerk organization (`AGENTS.md § 2.3`), created by Clerk with no form
// (*Automatically create organizations* is on). Clerk's card is the page, as on sign-in; its
// first heading and subtitle are worded in the root layout's `localization`. The copy promises
// nothing about the ways in, which the Clerk dashboard decides.

export const metadata: Metadata = { title: "Create your workspace" };

export default function SignUpPage() {
  return (
    <div className="wrap band-tight">
      <div className="narrow pb-touch pb-signin">
        <SignUp path="/sign-up" signInUrl="/sign-in" />
      </div>
    </div>
  );
}
