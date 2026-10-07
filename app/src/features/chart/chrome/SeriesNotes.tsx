// On-chart labels for any series that isn't simply "trades on Meridian's book" (no silent switches): an outside venue's
// view says so, naming the venue, for as long as it is shown, and a Last view that fell back to the mark says so too.
import { Chip } from "@/components/ds";
import { PERPL_VENUE } from "../datafeed/perpl";
import type { PriceSource } from "../datafeed/types";

export const REFERENCE_LABEL = "Reference price, not Meridian trades";
export const PERPL_LABEL = `${PERPL_VENUE} · reference, not Meridian trades`;
export const FALLBACK_LABEL = "No trades yet: showing Mark";

const OUTSIDE_LABEL: Partial<Record<PriceSource, string>> = { reference: REFERENCE_LABEL, perpl: PERPL_LABEL };

export function SeriesNotes({ source, fellBack }: { source: PriceSource; fellBack: boolean }) {
  const outside = OUTSIDE_LABEL[source];
  if (!outside && !fellBack) return null;
  return (
    <div className="pointer-events-none absolute bottom-8 left-12 right-16 z-10 flex flex-col items-end gap-1">
      {outside && (
        <Chip tone="warn" dot className="!whitespace-normal">
          <span data-testid="reference-label">{outside}</span>
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
