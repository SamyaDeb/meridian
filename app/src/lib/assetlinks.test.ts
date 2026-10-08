import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// public/.well-known/assetlinks.json lets the Android app (MOBILE_PLAN N3) use passkeys on this rpId.
type Statement = { relation: string[]; target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] } };
const statements = JSON.parse(readFileSync(new URL("../../public/.well-known/assetlinks.json", import.meta.url), "utf8")) as Statement[];

describe("assetlinks.json", () => {
  it("delegates passkey login for the Android staging app", () => {
    const s = statements.find((x) => x.target.package_name === "xyz.meridianfi.app.staging");
    expect(s).toBeDefined();
    expect(s!.target.namespace).toBe("android_app");
    expect(s!.relation).toContain("delegate_permission/common.get_login_creds");
    expect(s!.relation).toContain("delegate_permission/common.handle_all_urls");
    expect(s!.target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
  });

  it("lists SHA-256 fingerprints as 32 colon-separated upper-case hex bytes", () => {
    for (const s of statements)
      for (const f of s.target.sha256_cert_fingerprints) expect(f).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});
