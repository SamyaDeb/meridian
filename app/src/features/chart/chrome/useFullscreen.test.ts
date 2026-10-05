import { describe, expect, it } from "vitest";
import { nextFullscreenAction } from "./useFullscreen";

describe("nextFullscreenAction", () => {
  it("leaves native full screen first, whatever the element supports", () => {
    expect(nextFullscreenAction(true, true)).toBe("exit-native");
    expect(nextFullscreenAction(true, false)).toBe("exit-native");
  });
  it("enters natively when the element can request it, else toggles the in-page overlay", () => {
    expect(nextFullscreenAction(false, true)).toBe("enter-native");
    expect(nextFullscreenAction(false, false)).toBe("toggle-overlay");
  });
});
