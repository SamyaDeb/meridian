# Cloud sessions (claude.ai/code) for the Meridian mobile app

Read this before any `docs/mobile/prompts/*.md` prompt in a cloud session. Where a prompt and this file differ, **this
file wins** (the prompts were written for local sessions on the owner's Mac).

## 1. What's on GitHub
- Repo `SamyaDeb/meridian` (private). Branch **`mobile`** = the whole unmerged native-app stack in one line:
  N2 shell → N3 Mera passkeys → N4 Perpl onboarding → N4b UX polish → N5 Trade, plus this cloud setup. `main` has N1
  (`packages/core`) and the web app; N2–N5 are **not** on `main` yet.
- Plans: `docs/mobile/MOBILE_PLAN.md` (phases, status §3, log §5), `docs/mobile/LAUNCH_PLAN.md` (envs, hosting, go-live),
  `docs/mobile/MOBILE_UX_RESEARCH.md`, `docs/mobile/BOUNTY_MAP.md`. Prompts: `docs/mobile/prompts/`. QA: `docs/outputs/MOBILE_QA.md`.
- Skills (auto-loaded from the repo): `.claude/skills/{expo-native-app,mera-passkeys,perpl-api,phone-test,mobile-app-ui-design,frontend-design}`.

## 2. Path map (prompts → this checkout)
| Prompt says | In the cloud checkout |
|---|---|
| `/Users/samya/Downloads/meridian-m/…`, any `/Users/samya/Downloads/meridian-n*/…` worktree | repo root (`mobile` contains every phase's code) |
| `/Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md`, `LAUNCH_PLAN.md`, `MOBILE_UX_RESEARCH.md`, `BOUNTY_MAP.md` | `docs/mobile/<same name>` |
| `/Users/samya/Downloads/Meridian/docs/prompts/mobile/…` | `docs/mobile/prompts/…` |
| `~/.claude/skills/<name>` | `.claude/skills/<name>` |
| "create branch `nX-…` from `<prev phase>` in worktree …" | `git switch -c nX-… origin/mobile` (no worktrees) |
| "Metro port 80xx", "start Metro", "install on the phone" | not possible here → see §4 |

## 3. Environment
- Ubuntu VM, Node **22** on PATH (CI uses 22; all gates pass on 22). Node 24 is only needed by EAS builders (pinned in
  `mobile/eas.json`), not here. pnpm 10.18.3 + `pnpm install --frozen-lockfile` run in `.claude/hooks/session-start.sh`.
- Network "Trusted": npm + GitHub only. Monad RPC, Perpl API, expo.dev, Vercel are **not** reachable unless the owner
  added them as Custom domains. Tests never need network (recorded fixtures only) — don't add live calls to tests.
- `gh pr …` / `gh issue …` (GraphQL) are blocked by the GitHub proxy; use the session's "Create PR" button or
  `gh api repos/SamyaDeb/meridian/pulls -f title=… -f head=<branch> -f base=mobile -f body=…`.

## 4. What a cloud session does and doesn't do
Do: code + tests for a phase, refactors, fixes from the owner's phone-QA notes, docs (MOBILE_PLAN §3/§5, MOBILE_QA rows as
⏳ with exact owner steps).
Don't (owner does these locally on the Mac): phone runs / Metro, `eas build` / `eas credentials` (no Expo token here —
never ask for one in chat), Vercel deploys, any mainnet or testnet transaction, merging into `main` or `mobile`.
If a phase needs a **new native dependency**, say so at the top of the PR ("needs a new EAS dev build") — the current dev
client is EAS `4e91111a` and only works while native deps are unchanged since commit 4afa094.

## 5. Git rules in the cloud
- Branch from `origin/mobile`: `n6-earn`, `n7-home`, `n8-release-prep`, `fix-<topic>`. Never push to `main` or `mobile`.
- Conventional commits (`feat(mobile): …`). Author is set to SamyaDeb by the hook; attribution trailers are disabled in
  `.claude/settings.json` — never add `Co-Authored-By` / `Claude-Session` trailers by hand.
- Cloud commits are **unsigned**. Open the PR **into `mobile`** (not `main`). Before merging, the owner re-signs locally:
  ```
  git fetch origin && git switch <branch> && \
  git rebase origin/mobile -x 'git log -1 --format=%B | sed "/^Co-Authored-By:/d;/^Claude-Session:/d" | git commit --amend --no-verify -S --reset-author -F -' && \
  git push --force-with-lease origin <branch>
  ```
- Lockfile: only the `mobile` importer (or `packages/core`) may change in `pnpm-lock.yaml`. If `pnpm add` rewrites other
  importers, restore them by hand; `pnpm install --frozen-lockfile` must pass.

## 6. Gates before every PR
```
pnpm install --frozen-lockfile
pnpm --filter @meridian/core typecheck && pnpm --filter @meridian/core test
pnpm --filter @meridian/mobile typecheck && pnpm --filter @meridian/mobile test
pnpm --filter @meridian/mobile run check:release
pnpm -r --if-present run typecheck && pnpm -r --if-present run test   # whole repo, as CI
```
Report each result honestly in the PR body; device acceptance rows stay ⏳ with the owner's exact tap list.

## 7. Hard rules (unchanged from the prompts)
Never invent addresses, market ids, decimals, endpoints, JSON fields or package exports — use `deployments/*.json`,
`packages/core`, the skills, or write `> VERIFY: <what, where>`. viem only. bigint money math via core, round against the
user, gas = estimate × 1.2. Key material (PRF, private key, Ed25519 secret, mnemonic) only in memory; never in storage,
logs or tests; no hex keys or phrases pasted in tests. Real data only on screen; unknown shows "—".
