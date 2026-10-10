#!/usr/bin/env bash
# Cloud sessions only (claude.ai/code): commit identity + workspace install. Local sessions exit immediately.
# Workflow and rules for cloud work: docs/mobile/CLOUD.md.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}"

# Owner rule: commits authored as SamyaDeb, no Claude trailers (attribution is off in .claude/settings.json).
# Cloud commits can't be SSH-signed; the owner re-signs them before merge (docs/mobile/CLOUD.md §5).
git config user.name "SamyaDeb"
git config user.email "sammodeb28@gmail.com"

# pnpm version pinned by package.json "packageManager"; repo .npmrc keeps node-linker=isolated (never change it).
if ! command -v pnpm >/dev/null 2>&1 || [ "$(pnpm --version 2>/dev/null)" != "10.18.3" ]; then
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@10.18.3 --activate >/dev/null 2>&1 || npm install -g pnpm@10.18.3 >/dev/null 2>&1
fi

# Install once per VM; resumed sessions skip it.
if [ ! -d node_modules/.pnpm ]; then
  pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -5
fi
echo "meridian cloud setup: node $(node -v), pnpm $(pnpm --version), branch $(git rev-parse --abbrev-ref HEAD)"
