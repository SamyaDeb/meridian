import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FALLBACK_LABEL, REFERENCE_LABEL, SeriesNotes } from "./SeriesNotes";
import { SOURCE_LABEL, sourceOptions } from "./TopBar";

describe("SeriesNotes: every substituted series is labelled", () => {
  it("the reference view carries its label for as long as it is shown", () => {
    const h = renderToStaticMarkup(<SeriesNotes source="reference" fellBack={false} />);
    expect(h).toContain(REFERENCE_LABEL);
    expect(REFERENCE_LABEL).toBe("Reference price, not Meridian trades");
  });
  it("a Last view that fell back to the mark says so", () => {
    expect(renderToStaticMarkup(<SeriesNotes source="mark" fellBack />)).toContain("No trades yet: showing Mark");
    expect(FALLBACK_LABEL).toBe("No trades yet: showing Mark");
  });
  it("our own series without substitution: no label", () => {
    for (const s of ["last", "mark", "index"] as const) expect(renderToStaticMarkup(<SeriesNotes source={s} fellBack={false} />)).toBe("");
  });
});

describe("toolbar sources", () => {
  it("flag off hides the reference source; flag on lists it last, never first", () => {
    expect(sourceOptions(false)).toEqual(["last", "mark", "index"]);
    expect(sourceOptions(true)).toEqual(["last", "mark", "index", "reference"]);
    expect(SOURCE_LABEL.reference.label).toBe("MON/USD ref (Monad DEX)");
  });
});
