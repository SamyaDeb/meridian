// Release-bundle guard (MOBILE_PLAN N3 §3): export a production Android JS bundle (__DEV__ = false) with the fake-passkey
// flag deliberately ON, then fail if the fake WebAuthn client or dev-only code made it in. Usage:
//   pnpm --filter @meridian/mobile check:release
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "meridian-release-"));
// fake passkey client (N3) + the Earn dev flag that forces the Meridian leg to fail (N6)
const FORBIDDEN = ["meridian-fake-webauthn-client", "devFakeWebAuthnClient", "createFakeWebAuthnClient", "meridian-dev-force-meridian-fail"];
try {
  execFileSync("npx", ["expo", "export", "--platform", "android", "--output-dir", out, "--no-bytecode"], {
    stdio: "inherit",
    env: { ...process.env, APP_ENV: "staging", NODE_ENV: "production", EXPO_PUBLIC_FAKE_PASSKEY: "1" },
  });
  const files = [];
  const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".js") && files.push(join(d, f))));
  walk(out);
  if (files.length === 0) throw new Error("no JS bundle exported");
  const hits = [];
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    for (const m of FORBIDDEN) if (s.includes(m)) hits.push(`${m} in ${f}`);
  }
  // sanity: the real client is there
  const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
  if (!all.includes("react-native-passkey") && !all.includes("createPlatformKey")) hits.push("real passkey client missing (unexpected bundle)");
  if (hits.length) {
    console.error("release bundle check FAILED:\n" + hits.join("\n"));
    process.exitCode = 1;
  } else console.log(`release bundle check OK: ${files.length} JS file(s), none of ${FORBIDDEN.join(", ")}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
