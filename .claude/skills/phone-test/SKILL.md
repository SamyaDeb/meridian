---
name: phone-test
description: Get the Meridian mobile app (or any Next.js web app) onto the user's real iPhone and Android phone and test it there — LAN dev URL, HTTPS staging deploy on Vercel with a terminal QR code, installing to the home screen / Android APK, remote debugging with Safari Web Inspector and chrome://inspect, Playwright phone-viewport checks, and the mobile QA matrix. Use when the user says "check it on my phone", "test on mobile", "send me a link", or at the end of any MOBILE_PLAN phase.
---

# Phone testing

## 1. Pick the level
| Level | Use for | How |
|---|---|---|
| A. LAN | Quick layout look, no passkeys/install/push | `pnpm --filter @meridian/app dev -- -H 0.0.0.0`; URL `http://<mac-ip>:3000` (`ipconfig getifaddr en0`); phone on same Wi‑Fi |
| B. Staging HTTPS (default) | Everything: Mera Face ID, install, push | Deploy the branch to Vercel preview bound to the fixed staging domain; print URL + QR |
| C. Installed | Final feel | iPhone: Safari → Share → Add to Home Screen. Android: Chrome install prompt or the TWA APK (`adb install …apk`) |

Passkeys need HTTPS and are tied to the hostname: test passkeys live on staging only; never create a real user's passkey on staging or on a random tunnel URL. A tunnel (`cloudflared tunnel --url http://localhost:3000`) works for one-off checks but its host changes, so passkeys made there are throwaway.

## 2. Deploy + QR
- Deploy: `vercel deploy` from `app/` (or push the branch and let the Vercel Git integration build), then alias/assign the staging domain per the project setup (> VERIFY the project's Vercel config before running; deploying is outward-facing — confirm with the user the first time).
- QR in the terminal: `npx qrcode-terminal "<url>"` (or `qrencode -t ansiutf8 "<url>"` if installed). Always also print the plain URL.
- Env for staging lives in Vercel (Preview); never echo secrets.

## 3. Remote debugging
- iPhone: Settings → Apps → Safari → Advanced → Web Inspector ON; cable to the Mac; Mac Safari → Develop → <iPhone> → the page (works for home-screen apps too).
- Android: Developer options → USB debugging ON; desktop Chrome `chrome://inspect#devices` → inspect (works for the TWA).
- Ask the user for a screenshot or screen recording when you can't attach; read it.

## 4. Before handing the phone link over
- Playwright at 390×844 (+360, 430): screenshot every touched screen, look at them, check no horizontal scroll and tap targets ≥ 44 px (existing e2e in `app/e2e/`).
- typecheck + vitest green.

## 5. QA matrix (record in `docs/outputs/MOBILE_QA.md`, ✅/❌ + note + iOS/Android version)
Login Face ID (create, reload, second device) · email login · switch logins · Perpl onboarding (resume after app kill) · Trade Meridian open/close · Trade Perpl open/close · Earn open/close + forced unwind · Portfolio totals vs each venue's UI · push alert · offline open · no horizontal scroll / 44 px / smooth 60 fps · install + shortcuts.

Report honestly: which rows you verified yourself (Playwright/emulation) vs which only the user can verify on a real phone.
