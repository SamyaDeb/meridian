// Design tokens (mobile/DESIGN.md). Colours = the web terminal's (app/src/app/globals.css) so both apps read as one.
export const colors = {
  bg: "#050507",
  card: "#0e0e13",
  border: "#23232d",
  text: "#eceef4",
  muted: "#8b90a3",
  brand: "#836ef9",
  brandSoft: "#a08ffb",
  brandTint: "#180b2b",
  onBrand: "#050507",
  long: "#3ddc97",
  short: "#ff5c7a",
  warn: "#f5b84a",
} as const;

/** Four sizes only (DESIGN.md "Type"). */
export const type = { hero: 34, title: 20, body: 15, caption: 12 } as const;
export const weight = { regular: "400", semibold: "600" } as const;

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radius = { card: 14, inner: 10, control: 8, pill: 999 } as const;

/** Minimum touch target (pt). */
export const HIT = 44;

export const motion = { pulseMs: 300, holdMs: 600, holdRewindMs: 150, toastMs: 200 } as const;
