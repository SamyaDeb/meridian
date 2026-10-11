import { describe, expect, it } from "vitest";
import { checkRecord, clearRecord, readRecord, RECORD_KEY, writeRecord } from "./record";
import { memoryKV, SEQ_ADDRESS } from "./testing";

const ok = { credentialId: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", transports: ["internal", "hybrid"], createdAt: 1, addressHint: SEQ_ADDRESS.toLowerCase() };

describe("credential record", () => {
  it("round-trips and checksums the address", () => {
    const kv = memoryKV();
    writeRecord(kv, checkRecord(ok));
    expect(readRecord(kv)).toEqual({ ...ok, addressHint: SEQ_ADDRESS });
    clearRecord(kv);
    expect(readRecord(kv)).toBeUndefined();
  });
  it("rejects extra fields (nothing secret can ride along) and bad values", () => {
    expect(() => checkRecord({ ...ok, prf: "00" })).toThrow(/unexpected field prf/);
    expect(() => checkRecord({ ...ok, credentialId: "short" })).toThrow(/credentialId/);
    expect(() => checkRecord({ ...ok, transports: ["USB!"] })).toThrow(/transports/);
    expect(() => checkRecord({ ...ok, createdAt: 0 })).toThrow(/createdAt/);
    expect(() => checkRecord({ ...ok, addressHint: "0x12" })).toThrow(/addressHint/);
  });
  it("junk or throwing storage reads as no record", () => {
    const kv = memoryKV();
    kv.setItem(RECORD_KEY, "{not json");
    expect(readRecord(kv)).toBeUndefined();
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readRecord(throwing)).toBeUndefined();
    expect(() => writeRecord(throwing, checkRecord(ok))).not.toThrow();
    expect(() => clearRecord(throwing)).not.toThrow();
  });
});
