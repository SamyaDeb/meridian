import { describe, expect, it } from "vitest";
import { TERMS_VERSION, acceptanceRecord, isAccepted, parseRecord } from "./terms";

describe("terms acceptance", () => {
  it("round-trips the current version", () => {
    const raw = acceptanceRecord(1_700_000_000_000);
    expect(parseRecord(raw)).toEqual({ version: TERMS_VERSION, acceptedAt: 1_700_000_000_000 });
    expect(isAccepted(raw)).toBe(true);
  });
  it("a different version asks again", () => {
    expect(isAccepted(acceptanceRecord(1, "old"))).toBe(false);
  });
  it("the pre-rename (Meridian) acceptance asks again after the Meridian bump (D5)", () => {
    expect(TERMS_VERSION).not.toBe("2026-09-30-draft");
    expect(isAccepted(acceptanceRecord(1, "2026-09-30-draft"))).toBe(false);
  });
  it("missing, garbage or wrong-shaped storage is not acceptance", () => {
    expect(isAccepted(null)).toBe(false);
    expect(isAccepted("")).toBe(false);
    expect(isAccepted("{not json")).toBe(false);
    expect(isAccepted(JSON.stringify({ version: TERMS_VERSION }))).toBe(false);
    expect(isAccepted(JSON.stringify({ version: 1, acceptedAt: 2 }))).toBe(false);
  });
});
