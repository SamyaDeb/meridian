// WCAG 2.x contrast (relative luminance of sRGB). Used by the token contrast check (FRONTEND_TRADE_PLAN §3).

/** "#rrggbb" → [r, g, b] in 0..255. Throws on anything else (tokens must be plain hex). */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function relativeLuminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parseHex(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `--name: #hex;` declarations of the first `:root { … }` block of a stylesheet. */
export function rootTokens(css: string): Record<string, string> {
  const block = /:root\s*{([^}]*)}/.exec(css)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const [, name, hex] of block.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) if (name && hex) out[name] = hex;
  return out;
}
