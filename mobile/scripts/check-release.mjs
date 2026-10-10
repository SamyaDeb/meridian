// Release-bundle guard (MOBILE_PLAN N3 §3, extended in N8). Exports the Android JS bundle the way EAS builds it
// (__DEV__ = false, each profile's env from eas.json) with the fake-passkey flag deliberately ON, then fails if:
//   - staging + production: the fake WebAuthn client, the Earn forced-fail flag or other dev-only markers made it in;
//   - production: first-party code (mobile/, packages/, deployments/) carries a localhost / 127.0.0.1 / 10.0.2.2 URL
//     (hits are attributed through the source map; library defaults such as viem's local chains or React Native's dev
//     server fallback are listed, not failed), or the bundle carries the testnet web URL at all;
//   - eas.json: a profile whose EXPO_PUBLIC_APP_ENV doesn't match its APP_ENV (the compile-time env the config folds on).
// Usage: pnpm --filter @meridian/mobile check:release
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), "..");
// fake passkey client (N3) + the Earn dev flag that forces the Meridian leg to fail (N6)
const FORBIDDEN = ["meridian-fake-webauthn-client", "devFakeWebAuthnClient", "createFakeWebAuthnClient", "meridian-dev-force-meridian-fail"];
const LOCAL_URL = /\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|10\.0\.2\.2)\b|\b10\.0\.2\.2\b/g;
const TESTNET_WEB = /https:\/\/meridian-testnet\.vercel\.app/g;

const problems = [];

// ── eas.json: the compile-time env must match the profile ──
const eas = JSON.parse(readFileSync(join(MOBILE, "eas.json"), "utf8"));
for (const [name, p] of Object.entries(eas.build ?? {})) {
  if (!p.env?.APP_ENV) problems.push(`eas.json ${name}: no APP_ENV`);
  else if (p.env.EXPO_PUBLIC_APP_ENV !== p.env.APP_ENV) problems.push(`eas.json ${name}: EXPO_PUBLIC_APP_ENV (${p.env.EXPO_PUBLIC_APP_ENV}) must equal APP_ENV (${p.env.APP_ENV})`);
}

/** Base64 VLQ → the generated column + source index of every segment, per generated line (only what we need). */
function decodeMappings(mappings) {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const val = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) val[B64.charCodeAt(i)] = i;
  const lines = [];
  let src = 0;
  for (const line of mappings.split(";")) {
    const segs = [];
    let col = 0;
    for (const seg of line.split(",")) {
      if (!seg) continue;
      const f = [];
      let shift = 0;
      let acc = 0;
      for (let i = 0; i < seg.length; i++) {
        const d = val[seg.charCodeAt(i)];
        acc += (d & 31) << shift;
        if (d & 32) shift += 5;
        else {
          f.push(acc & 1 ? -(acc >>> 1) : acc >>> 1);
          acc = 0;
          shift = 0;
        }
      }
      col += f[0];
      if (f.length > 1) src += f[1];
      segs.push([col, f.length > 1 ? src : -1]);
    }
    lines.push(segs);
  }
  return lines;
}

/** The source file a generated (line, column) came from, or undefined. */
function sourceAt(map, lines, line, column) {
  const segs = lines[line] ?? [];
  let best;
  for (const s of segs) {
    if (s[0] > column) break;
    best = s;
  }
  return best && best[1] >= 0 ? map.sources[best[1]] : undefined;
}

const firstParty = (src) => src !== undefined && !src.includes("/node_modules/") && !src.startsWith("\u0000") && src !== "__prelude__";

function exportBundle(profile) {
  const out = mkdtempSync(join(tmpdir(), `meridian-release-${profile}-`));
  const env = { ...process.env, ...eas.build[profile].env, NODE_ENV: "production", EXPO_PUBLIC_FAKE_PASSKEY: "1" };
  // --clear: Metro's transform cache doesn't key on EXPO_PUBLIC_* values, so a cached transform from another profile
  // would carry that profile's inlined env (EAS builds start from a clean cache)
  execFileSync("npx", ["expo", "export", "--platform", "android", "--output-dir", out, "--no-bytecode", "--source-maps", "--clear"], { cwd: MOBILE, stdio: "inherit", env });
  const files = [];
  const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".js") && files.push(join(d, f))));
  walk(out);
  return { out, files };
}

function check(profile) {
  const { out, files } = exportBundle(profile);
  try {
    if (files.length === 0) return void problems.push(`${profile}: no JS bundle exported`);
    const all = files.map((f) => readFileSync(f, "utf8"));
    for (const [i, s] of all.entries()) for (const m of FORBIDDEN) if (s.includes(m)) problems.push(`${profile}: ${m} in ${files[i]}`);
    // sanity: the real client is there
    if (!all.some((s) => s.includes("react-native-passkey") || s.includes("createPlatformKey"))) problems.push(`${profile}: real passkey client missing (unexpected bundle)`);
    if (profile !== "production") return;

    const library = new Map();
    for (const [i, s] of all.entries()) {
      if (TESTNET_WEB.test(s)) problems.push(`production: the testnet web URL is in ${files[i]}`);
      TESTNET_WEB.lastIndex = 0;
      const map = JSON.parse(readFileSync(`${files[i]}.map`, "utf8"));
      const lines = decodeMappings(map.mappings);
      const starts = [0];
      for (let k = 0; k < s.length; k++) if (s.charCodeAt(k) === 10) starts.push(k + 1);
      for (const m of s.matchAll(LOCAL_URL)) {
        let line = starts.length - 1;
        while (starts[line] > m.index) line--;
        // the `//# sourceMappingURL=http://localhost:8081/…` comment `--source-maps` appends for this check is not code
        if (s.startsWith("//# sourceMappingURL=", starts[line])) continue;
        const src = sourceAt(map, lines, line, m.index - starts[line]);
        // unattributed ⇒ treat as first-party (fail) rather than guess
        if (src === undefined || firstParty(src)) problems.push(`production: ${m[0]} from ${src ?? "an unmapped position"}`);
        else {
          const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*node_modules)/.exec(src)?.[1] ?? src;
          library.set(pkg, (library.get(pkg) ?? 0) + 1);
        }
      }
    }
    if (library.size) console.log(`production: local-URL strings from libraries (allowed): ${[...library].map(([p, n]) => `${p} ×${n}`).join(", ")}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

for (const profile of ["preview", "production"]) check(profile);

if (problems.length) {
  console.error("release bundle check FAILED:\n" + problems.join("\n"));
  process.exitCode = 1;
} else console.log(`release bundle check OK: preview + production bundles, none of ${FORBIDDEN.join(", ")}; production has no first-party local URL and no testnet web URL; eas.json envs consistent`);
