// How Clerk's components are dressed: the kit's tokens, so they follow the theme with the rest of the page.
//
// The variables alone can't make Clerk's edges visible. Clerk draws every border, input ring and divider as a
// 7 to 11 % tint of `colorBorder` (28 % on hover), and at 11 % even pure white on a dark card or black on a white
// one stays under 1.5:1. Measured on the rendered page on 2026-11-21, every Clerk edge, divider and section line
// was 1.01 to 1.06:1 against what is behind it, in both themes: an email field with no visible box, a "Continue
// with Google" button with no outline, profile sections with no line between them. So the elements below set the
// edges outright, each to the token the kit uses for the same part, never to a Clerk variable, which would refer
// to itself:
//   - an input's edge is the kit input's, `--edge` (3.17:1 light, 3.81:1 dark on a surface: WCAG 2.2 SC 1.4.11);
//   - an outlined button's edge is the kit button's, `--line-strong`, and `--edge` on hover, as `.btn` does;
//   - a divider, a section line and a layer's edge are the kit's `--line`, as `.divider` and `.panel` are, and
//     `--line-strong` on Clerk's grey footers and plan-card bands, where `--line` reads fainter than a divider;
//   - text Clerk paints in `colorPrimary` is the kit's `--accent-text`: in dark the accent fill (#3d5cff) reads
//     2.8 to 3.7:1 as text, and the kit's text shade 4.5:1 or more. In light the two are the same colour.
// Every edge is `!important`. Clerk restates its tint in rules keyed on its own state (`[data-variant]`, `:hover`,
// `:focus-within`, a parent's `> :not(:first-of-type)`), each more specific than an element style, so without it
// the field and the Google button kept their 1.03:1 ring. Clerk's rules carry no `!important`, so ours win in every
// state; a state of ours (hover, focus, an error) is more specific than our own resting rule, so it wins over that.
// Every value names a kit token Clerk doesn't set itself: on its buttons Clerk defines `--border` (read 2026-11-21,
// Clerk UI 1.44.2), and an element style reading a name Clerk defines gets Clerk's value, not the kit's.
// `tests/e2e/clerk-contrast.spec.ts` measures the sign-in page in both themes.

const important = (value: string) => `${value} !important`;
const ring = (colour: string) => important(`0 0 0 1px ${colour}`);
const EDGE = "var(--edge)";
const LINE = "var(--line)";
const LINE_STRONG = "var(--line-strong)";
const ACCENT_TEXT = important("var(--accent-text)");
const FOCUS = important("0 0 0 2px var(--accent)");

// A text field, a code box, a select: the kit input's edge at rest and on hover, the accent's 2px ring while focused,
// and Clerk's own verdicts in the kit's state colours: a password that meets the rules (`success`), a weak one
// (`warning`), and an invalid field. Focus outranks the first two, which sit before it; an error outranks focus,
// and a focused field in error keeps a 2px ring, so the field being typed in still stands out. (The code field's
// boxes don't take focus themselves: one hidden input does, and the active box carries `data-focus-within`.)
const input = {
  boxShadow: ring(EDGE),
  "&[data-feedback='success']": { boxShadow: ring("var(--up)") },
  "&[data-feedback='warning']": { boxShadow: ring("var(--warn)") },
  "&:focus, &:focus-visible, &[data-focus-within='true']": { boxShadow: FOCUS },
  "&[aria-invalid='true'], &[data-feedback='error']": { boxShadow: ring("var(--down)") },
  "&[aria-invalid='true']:focus, &[data-feedback='error']:focus, &[aria-invalid='true'][data-focus-within='true'], &[data-feedback='error'][data-focus-within='true']":
    { boxShadow: important("0 0 0 2px var(--down)") },
};

// An outlined button, as `.btn`: a `--line-strong` edge, `--edge` and the sunk fill on hover.
const outlined = {
  boxShadow: ring(LINE_STRONG),
  "&:hover": { boxShadow: ring(EDGE), backgroundColor: important("var(--sunk)") },
  "&:focus-visible": { boxShadow: FOCUS },
};

const line = (colour = LINE) => ({ borderColor: important(colour) });

// A layer that floats over the page, as `[popover].pop`: a `--line` edge and the kit's lift.
const layer = { boxShadow: important(`0 0 0 1px ${LINE}, var(--lift)`) };

export const clerkAppearance = {
  variables: {
    colorPrimary: "var(--clerk-primary)",
    // Clerk can't read a contrast from a variable, and guessed dark text on dark mode's lighter accent.
    colorPrimaryForeground: "var(--on-accent)",
    colorBackground: "var(--surface)",
    colorForeground: "var(--ink)",
    colorMuted: "var(--sunk)",
    colorMutedForeground: "var(--ink-3)",
    colorInput: "var(--surface)",
    colorInputForeground: "var(--ink)",
    colorBorder: "var(--line-strong)",
    colorRing: "var(--clerk-primary)",
    colorDanger: "var(--down)",
    colorSuccess: "var(--up)",
    colorWarning: "var(--warn)",
    colorNeutral: "var(--ink)",
    fontFamily: "var(--f-sans)",
    fontFamilyButtons: "var(--f-sans)",
    borderRadius: "var(--r-2)",
  },
  elements: {
    // Inputs.
    formFieldInput: input,
    otpCodeFieldInput: input,
    selectButton: input,
    organizationProfileMembersSearchInput: input,
    // The sign-up consent box. Its resting edge would hide Clerk's own focus ring, so focus is set here too.
    formFieldCheckboxInput: { boxShadow: ring(EDGE), "&:focus-visible": { boxShadow: FOCUS } },

    // Outlined buttons: "Continue with Google", and the organization switcher's "Manage".
    socialButtonsBlockButton: outlined,
    socialButtonsIconButton: outlined,
    organizationSwitcherPopoverActionButton__manageOrganization: outlined,

    // Dividers and section lines.
    dividerLine: { backgroundColor: important(LINE) },
    profileSection: line(),
    userButtonPopoverActions: line(),
    userButtonPopoverActionButton: line(),
    organizationSwitcherPopoverActions: line(),
    organizationSwitcherPopoverActionButton: line(),
    organizationSwitcherPopoverInvitationActions: line(),
    tabListContainer: line(),
    table: { boxShadow: ring(LINE) },
    tableBody: line(),
    tableBodyCell: line(),
    pricingTableCard: { boxShadow: ring(LINE) },
    // On Clerk's grey bands.
    footerItem: line(LINE_STRONG),
    pricingTableCardFeatures: line(LINE_STRONG),
    pricingTableCardFooter: line(LINE_STRONG),

    // Layers: the sign-in card, the popovers, and the profiles' menu. Below 48em (Clerk's `md`) Clerk hides the
    // sidebar and draws its ≡ menu as a panel over the page, under the same element name; only that panel floats.
    cardBox: { boxShadow: ring(LINE) },
    userButtonPopoverCard: layer,
    organizationSwitcherPopoverCard: layer,
    navbar: { ...line(), "@media (max-width: 48em)": layer },

    // Text Clerk paints in the accent: every link-styled button ("See all features"), and the named ones below.
    button: { "&[data-variant='link'][data-color='primary']": { color: ACCENT_TEXT } },
    footerActionLink: { color: ACCENT_TEXT },
    formResendCodeLink: { color: ACCENT_TEXT },
    formFieldAction: { color: ACCENT_TEXT },
    identityPreviewEditButton: { color: ACCENT_TEXT },
    profileSectionPrimaryButton: { color: ACCENT_TEXT },
    menuButton__connectedAccounts: { color: ACCENT_TEXT },
    // The sign-up consent's links to the terms and the privacy policy.
    formFieldCheckboxLabel: { "& a": { color: ACCENT_TEXT } },
    navbarButton: {
      "&[data-active='true'], &[data-active='true'] .cl-navbarButtonText, &[data-active='true'] .cl-navbarButtonIcon": {
        color: ACCENT_TEXT,
      },
    },
    tabButton: { "&[aria-selected='true']": { color: ACCENT_TEXT } },

    // A label such as "Primary" or "You", as the kit's `.tag`: Clerk's own read 1.2 to 1.3:1.
    badge: {
      "&[data-color='primary']": {
        color: important("var(--ink-2)"),
        backgroundColor: important("var(--sunk)"),
        boxShadow: important("none"),
      },
    },
  },
} as const;
