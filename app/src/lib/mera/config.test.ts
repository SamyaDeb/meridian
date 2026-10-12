import { describe, expect, it } from "vitest";
import { PRODUCTION_RP_ID, rpIdProblem, STAGING_RP_ID } from "./config";

describe("rpIdProblem (the passkey domain is permanent: refuse anything but our host)", () => {
  it("ok: staging on staging (testnet), production on production (mainnet), localhost locally", () => {
    expect(rpIdProblem(STAGING_RP_ID, STAGING_RP_ID, 10143)).toBeUndefined();
    expect(rpIdProblem(PRODUCTION_RP_ID, PRODUCTION_RP_ID, 143)).toBeUndefined();
    expect(rpIdProblem("localhost", "localhost", 31337)).toBeUndefined();
  });
  it("refused: unset, unknown, host mismatch (preview deployments), mainnet off the production rpId", () => {
    expect(rpIdProblem(undefined, STAGING_RP_ID, 10143)).toMatch(/aren't set up/);
    expect(rpIdProblem("evil.example", "evil.example", 10143)).toMatch(/Unknown/);
    expect(rpIdProblem(STAGING_RP_ID, "meridian-testnet-git-branch.vercel.app", 10143)).toMatch(/work on meridian-testnet\.vercel\.app only/);
    expect(rpIdProblem(STAGING_RP_ID, STAGING_RP_ID, 143)).toMatch(/Mainnet/);
    expect(rpIdProblem("localhost", "localhost", 143)).toMatch(/Mainnet/);
  });
});
