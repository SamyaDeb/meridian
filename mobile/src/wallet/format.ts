/** 0x12ab…cd34 (display only; screen readers get the full address). */
export const shortAddress = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
