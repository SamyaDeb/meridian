# Third-party code and licences

Meridian's own code is [MIT](LICENSE). It depends on the libraries below, which are installed (`forge install` submodules, npm via pnpm) and not copied into this repository. Licences were read on 7 Oct 2026 from GitHub's licence API (forge libraries) and from `pnpm licenses list --prod` (npm).

## Solidity (`contracts/lib`, git submodules)
| Library | Used for | Licence |
|---|---|---|
| OpenZeppelin Contracts | `SafeERC20`, `ReentrancyGuardTransient`, `Ownable`, `ERC20` / `ERC4626`, `Math`, `SafeCast` | MIT |
| Solady | `FixedPointMathLib`, `SafeTransferLib`, `LibBit` | MIT |
| forge-std | tests and scripts only | MIT / Apache-2.0 (dual) |

## Vendored files (copied into this repository)
| File | From | Licence |
|---|---|---|
| `packages/core/src/perpl/abi.ts` | 11 entries copied verbatim from `indexer/abis/PerplExchange.json` (same dex-sdk @ `dbb37c5`), checked equal by `test/perpl-onboarding.test.ts` | MIT |
| `indexer/abis/PerplExchange.json` | Perpl's exchange ABI, [`PerplFoundation/dex-sdk`](https://github.com/PerplFoundation/dex-sdk) `crates/sdk/abi/dex/Exchange.json` @ `dbb37c5` (`abi` array only), to decode Perpl events in the indexer (`indexer/abis/README.md`) | MIT |

## TypeScript: direct dependencies
| Package | Workspace | Licence |
|---|---|---|
| viem | app, mfi, mm-bot, keepers, bench, packages/core | MIT |
| @noble/ed25519, @noble/hashes | packages/core (Perpl Ed25519 signing, SHA-256 / SHA-512, HKDF) | MIT |
| @scure/bip32, @scure/bip39 | packages/core (Mera EVM key path, recovery phrase) | MIT |
| wagmi, @tanstack/react-query | app | MIT |
| next, react, react-dom | app | MIT |
| lightweight-charts (TradingView) | app (price chart) | Apache-2.0; the attribution "Lightweight Charts by TradingView" is shown in the chart settings, as its licence asks |
| @privy-io/react-auth | app (login) | Apache-2.0 |
| @privy-io/wagmi | app (login) | no SPDX field in its package.json. > VERIFY: the LICENSE file shipped in the package |
| tsx | mfi | MIT |
| envio | indexer | **not OSI-approved** (Envio's own licence: source-available, self-hosting allowed). It's a dev/runtime dependency of the indexer only; none of its code is in this repo |

## Transitive npm dependencies (production, all workspaces)
Of 629 packages: MIT 472, Apache-2.0 70, ISC 33, BSD-3-Clause 13, BSD-2-Clause 3, 0BSD 2, plus single packages under MPL-2.0 (`@ethereumjs/*`, `webextension-polyfill`, 4), BlueOak-1.0.0, Unlicense, CC-BY-4.0 (`caniuse-lite`, data), and dual MIT/Apache or MIT/CC0. All of these are OSI-approved or permissive data licences.

Flagged:
- **LGPL-3.0-or-later**: `@img/sharp-libvips-darwin-arm64` (prebuilt libvips for Next's image optimiser; a dynamically loaded binary, platform-specific).
- **GPL-3.0**: `cfonts` (pulled in by the `envio` CLI's banner) and `envio-darwin-arm64` (Envio's binary). Both are tooling, not linked into anything we distribute.
- **No licence field (21)**: the wallet-connection stack pulled in by wagmi / Privy: `@reown/appkit*`, `@walletconnect/*`, `@metamask/sdk*`, `@metamask/eth-json-rpc-provider`, `@privy-io/api-base`, `@privy-io/wagmi`. > VERIFY: each package's shipped LICENSE file. They're installed from npm, not vendored, so this repo's MIT licence isn't affected.
