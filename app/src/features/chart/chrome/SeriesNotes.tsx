// On-chart labels for any series that isn't simply "trades on Meridian's book" (no silent switches): the outside
// reference view says so for as long as it is shown, and a Last view that fell back to the mark says so too.
import { Chip } from "@/components/ds";
import type { PriceSource } from "../datafeed/types";

export const REFERENCE_LABEL = "Reference price, not Meridian trades";
export const FALLBACK_LABEL = "No trades yet: showing Mark";

export function SeriesNotes({ source, fellBack }: { source: PriceSource; fellBack: boolean }) {
  if (source !== "reference" && !fellBack) return null;
  return (
    <div className="pointer-events-none absolute bottom-8 right-16 z-10 flex flex-col items-end gap-1">
      {source === "reference" && (
        <Chip tone="warn" dot>
          <span data-testid="reference-label">{REFERENCE_LABEL}</span>
        </Chip>
      )}
      {fellBack && (
        <Chip tone="neutral">
          <span data-testid="fallback-chip">{FALLBACK_LABEL}</span>
        </Chip>
      )}
    </div>
  );
}
