---
name: mera-passkeys
description: Integrate Mera (Category Labs' passkey library, @category-labs/mera) for Face ID / fingerprint crypto accounts on Monad — create/sign-in with WebAuthn PRF, derive an EVM account, wrap it as a viem account and wagmi connector next to Privy, derive extra keys (e.g. a Perpl Ed25519 API key) from the same passkey, session security, error handling and testing. Use whenever the task mentions Mera, passkeys, Face ID login, PRF, seedless wallet, or the Meridian M1 phase.
---

# Mera passkeys

Facts below are from docs.monad.xyz/guides/mera and mera.category.xyz (checked 8 Oct 2026). Anything not listed here: open those docs, or write `> VERIFY:` — never guess an export name.

## 1. API (verified)
```bash
npm install @category-labs/mera viem @scure/bip32 @scure/bip39   # pin exact versions
```
- `createPasskeyWithPrfOutput({ rp: { id, name }, user: { name, displayName } })` → `{ prfOutput (32 bytes), credentialId, transports }`. Store only `{credentialId, transports}`.
- `getPasskeyPrfOutput({ rpId, credential? })` → `{ prfOutput, credentialId }` (same 32 bytes every time for that passkey).
- `createSecp256k1SigningSession({ privateKey })` → session; `session.end()` zeroes the key.
- `toViemAccount(session)` from `@category-labs/mera/viem` → viem `LocalAccount`.
- `createEd25519SigningSession` / `getSolanaAddress` exist (Solana); check their exact signatures before using them for anything else.
- Errors: `isMeraError(e)` then `e.code` ∈ `PRF_UNAVAILABLE`, `PASSKEY_OPERATION_FAILED`, `CRYPTO_UNAVAILABLE`, `SESSION_ENDED`.
- React Native support since v0.2.0 (native WebAuthn client; same rpId as web; iOS 18+/Android 9+).

EVM key (from the docs):
```ts
const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
const pk = HDKey.fromMasterSeed(seed).derive(`m/44'/60'/0'/0/${index}`).privateKey!;
```
The mnemonic `entropyToMnemonic(prfOutput)` imports into MetaMask/Rabby → same address (recovery path).

## 2. Platform rules
- HTTPS or `localhost` only. The passkey is bound to the **rpId** (hostname) forever: changing domain = accounts unreachable except via the mnemonic. Use separate staging and production hosts; create real users' passkeys only on production.
- PRF-capable providers: iCloud Keychain, Google Password Manager, 1Password. Desktop Chrome returns PRF only when the passkey is saved to Google Password Manager (else `PRF_UNAVAILABLE`, the most common failure).
- iPhone: test on iOS ≥ 18.4 (a native competitor reported wrong PRF values on 18.0–18.3).
- Check devices first on the demo: mera.category.xyz/demo (support list: mera.category.xyz/authenticator-support).

## 3. Wiring next to Privy (Meridian)
- Custom wagmi connector (`createConnector`, `type: "mera"`) wrapping `toViemAccount(session)`; its EIP-1193 provider signs locally and sends `eth_sendRawTransaction` through the configured transport; gas = estimate × 1.2 (`app/src/lib/gas.ts`).
- Add it in `connectorsFor()` (`app/src/lib/wagmi.ts`) — the Privy config already accepts extra connectors (the anvil `mock` one is there).
- Mutual exclusion: connecting Mera → Privy `logout()` first; Privy login → disconnect Mera. Login state = Privy authenticated OR Mera connected. `WalletKind` gets `"passkey"`; passkey wallets are never Privy-sponsored (mainnet is never sponsored anyway).

## 4. Extra keys from one passkey
Derive other secrets with HKDF-SHA256 from `prfOutput` using a unique, versioned salt per purpose, e.g. Perpl API key:
`HKDF(ikm = prfOutput, salt = "meridian/perpl-api-key/v1", info = String(chainId), L = 32)` → Ed25519 secret (`@noble/hashes/hkdf`, `@noble/ed25519`).
Never reuse the EVM private key bytes for another algorithm. Add test vectors (fixed PRF → fixed address / public key).

## 5. Session security
- Hold the signing session in memory only; idle timeout (10 min), end on sign-out, on long tab hide, and on timeout.
- Re-prompt Face ID (fresh per-transaction session) for value-moving actions: withdrawals, deposits to another venue, mnemonic export.
- Nothing secret in localStorage/sessionStorage/IndexedDB — add a test that scans storage after login.
- Assert at startup that the configured rpId equals `location.hostname`; refuse to create a passkey on mismatch.

## 6. User-facing errors (plain language)
- `PRF_UNAVAILABLE` → "This browser can't use Face ID passkeys. Use Safari on iOS 18.4+ or Chrome with Google Password Manager — or continue with email."
- `PASSKEY_OPERATION_FAILED` (user cancelled/timeout) → "Face ID was cancelled. Try again."
- `SESSION_ENDED` → silently re-prompt on the next action.

## 7. Testing
- Unit: derivation vectors, connector behaviour with a fake session, login state machine, storage scan.
- E2E: Chromium virtual authenticator via CDP (`WebAuthn.enable`, `WebAuthn.addVirtualAuthenticator` with `hasPrf: true` — confirm the installed Chromium supports PRF); fallback: an e2e-only fake `navigator.credentials` behind `NEXT_PUBLIC_E2E=1`, never in production builds.
- Real devices: create → reload → sign in → second device (synced passkey) shows the same address.
