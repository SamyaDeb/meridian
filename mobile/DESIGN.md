# Meridian mobile: design plan (N2)

One idea carries the app: **two venues, one gap**. Every screen puts Meridian and Perpl side by side and makes the
difference between them the loudest thing on the screen (the spread on Welcome, the better venue on Trade, the
carry on Earn). Everything else stays quiet: near-black surfaces, one violet accent, numbers that never jump.

## Palette (`src/ui/tokens.ts`, same values as the web terminal's `app/src/app/globals.css`)
| Token | Hex | Use |
|---|---|---|
| `bg` | `#050507` | screen, splash, adaptive-icon background |
| `card` | `#0e0e13` | cards, sheets, tab bar |
| `border` | `#23232d` | hairlines (1 px), dividers, skeleton base |
| `text` | `#eceef4` | values, headings |
| `muted` | `#8b90a3` | labels, secondary text (contrast 6.4:1 on `bg`, 6.1:1 on `card`) |
| `brand` | `#836ef9` | the one accent: primary button, focus, Meridian marker, block pulse |
| `long` / `short` | `#3ddc97` / `#ff5c7a` | sign of PnL / funding, always with a `+` / `−` sign too |
| `warn` | `#f5b84a` | stale data, public RPC, offline |
Perpl is drawn in `text` (neutral), Meridian in `brand`: the venue colour is never the only cue (labels always).

## Type (system face: Roboto on Android, SF on iOS; `fontVariant: tabular-nums` on every number)
Four sizes only: **34** hero value · **20** screen title · **15** body / values · **12** captions and labels.
Two weights: 400 regular, 600 semibold. Labels are sentence case, smaller and muted; values are larger than their labels.
`allowFontScaling` stays on; number rows wrap instead of truncating (`Num` never sets `numberOfLines`).

## Space and shape
8-pt grid (`space`: 4, 8, 12, 16, 24, 32, 48). Screen gutter 16. Card padding 16, gap between groups 24.
Radii match the web terminal: **card 14 · inner 10 · control 8**; pills (segmented, badges) fully round.
No shadows on dark (elevation = `card` on `bg` + 1 px `border`).

## Motion (Reanimated, UI thread only)
- Block pulse: the dot flashes `brand` → transparent over 300 ms on each new block. The only ambient motion.
- Hold-to-confirm ring fills in 600 ms linear; release before the end rewinds in 150 ms.
- Sheets: gesture-driven (@gorhom/bottom-sheet) with its spring; toasts slide 16 px + fade 200 ms.
- `useReducedMotion()` ⇒ no pulse flash, ring still fills (it is the progress signal), sheets snap.

## Haptics map (`expo-haptics`; never the only signal)
| Event | Haptic |
|---|---|
| Segment change, slider detent | `selectionAsync` |
| Hold start | `impactAsync(Light)` |
| Hold complete | `notificationAsync(Success)` |
| Error toast / failed action | `notificationAsync(Error)` |

## Data honesty
Unknown = "—". Zero = "0.00". Stale (no new block for 3 s, core `STALE_AFTER_MS`) = value dims to `muted` + a "stale"
tag. Empty book = "No liquidity right now", never placeholder levels. Public RPC and non-production chains get a
visible badge.

## Accessibility
Every control: `accessibilityRole` + `accessibilityLabel` (+ `accessibilityState`/`Value` where it has one), hit
area ≥ 44 × 44. Hold-to-confirm exposes an `activate` accessibility action (TalkBack double-tap confirms; no hold).
Swipe rows always have visible button fallbacks. Contrast ≥ 4.5:1 for all text (lowest: brand on card 5.1:1, muted on card 6.1:1).
