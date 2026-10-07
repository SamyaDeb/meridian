import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FALLBACK_LABEL, PERPL_LABEL, REFERENCE_LABEL, SeriesNotes } from "./SeriesNotes";
import { SOURCE_LABEL, sourceOptions } from "./sources";

describe("SeriesNotes: every substituted series is labelled", () => {
  it("the reference view carries its label for as long as it is shown", () => {
    const h = renderToStaticMarkup(<SeriesNotes source="reference" fellBack={false} />);
    expect(h).toContain(REFERENCE_LABEL);
    expect(REFERENCE_LABEL).toBe("Reference price, not Meridian trades");
  });
  it("the Perpl view names the venue and says it is not Meridian's trades", () => {
    const h = renderToStaticMarkup(<SeriesNotes source="perpl" fellBack={false} />);
    expect(h).toContain(PERPL_LABEL);
    expect(PERPL_LABEL).toBe("Perpl MON-PERP · Monad mainnet · reference, not Meridian trades");
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
  it("flags off hide the outside sources; flags on list them after Meridian's own, never first", () => {
    expect(sourceOptions(false, false)).toEqual(["last", "mark", "index"]);
    expect(sourceOptions(true, false)).toEqual(["last", "mark", "index", "reference"]);
    expect(sourceOptions(false, true)).toEqual(["last", "mark", "index", "perpl"]);
    expect(sourceOptions(true, true)).toEqual(["last", "mark", "index", "reference", "perpl"]);
    expect(SOURCE_LABEL.reference.label).toBe("MON/USD ref (Monad DEX)");
    expect(SOURCE_LABEL.perpl.label).toBe("Perpl MON-PERP (ref)");
    expect(SOURCE_LABEL.perpl.hint).toContain("Not Meridian trades");
  });
});
