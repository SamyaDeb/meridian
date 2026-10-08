// Ported from app/src/lib/blocks.test.ts (main @ 0ba1664).
import { describe, expect, it } from "vitest";
import { liveness, observeHead, STALE_AFTER_MS } from "../src/meridian/blocks";

describe("block head liveness", () => {
  it("waiting before the first block", () => {
    expect(liveness(undefined, 0)).toBe("waiting");
  });
  it("live while blocks advance, stale after STALE_AFTER_MS without one", () => {
    let h = observeHead(undefined, 100n, 0);
    h = observeHead(h, 101n, 300);
    expect(liveness(h, 300 + STALE_AFTER_MS)).toBe("live");
    expect(liveness(h, 301 + STALE_AFTER_MS)).toBe("stale");
  });
  it("a repeated or lower head does not refresh liveness", () => {
    const h = observeHead(undefined, 100n, 0);
    expect(observeHead(h, 100n, 2_000)).toBe(h);
    expect(observeHead(h, 99n, 2_000)).toBe(h);
    expect(liveness(observeHead(h, 100n, 5_000), 5_000)).toBe("stale");
  });
  it("recovers from stale on the next block", () => {
    const h = observeHead(observeHead(undefined, 1n, 0), 2n, 10_000);
    expect(liveness(h, 10_100)).toBe("live");
  });
});
