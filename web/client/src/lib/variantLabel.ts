/**
 * Variant property label text extraction (round 10 §3).
 *
 * Component Set / state group variant children are named with the pattern
 *   `prop=value, prop=value, ...`
 * Figma's editor renders the *values only* as labels above each variant.
 *
 * Examples:
 *   "size=L, State=hover, Type=primary" → "L, hover, primary"
 *   "속성 1=기본"                       → "기본"
 *   "plain name"                       → "plain name"
 *   "" / null                          → null
 */

const VARIANT_NAME_RE = /^[\w가-힣 ]+=/;

export function variantLabelText(name: string | undefined | null): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  // No `key=` anywhere → not a variant-shaped name; render as-is.
  if (!VARIANT_NAME_RE.test(trimmed)) return trimmed;

  const parts = trimmed.split(',');
  const values: string[] = [];
  for (const raw of parts) {
    const seg = raw.trim();
    const eq = seg.indexOf('=');
    if (eq < 0) {
      // Non key=value segment — keep verbatim. Defensive; shouldn't happen for
      // Figma-shaped names but guards against malformed inputs.
      if (seg.length > 0) values.push(seg);
      continue;
    }
    const v = seg.slice(eq + 1).trim();
    if (v.length > 0) values.push(v);
  }
  if (values.length === 0) return null;
  return values.join(', ');
}

/**
 * Approximate the rendered pixel width of `text` at the variant-label font
 * size (11px Inter). Used to size the rounded background pill before
 * mounting Konva. CJK characters get ~1.5× width vs latin.
 */
export function variantLabelTextWidth(text: string): number {
  let units = 0;
  for (const ch of text) {
    // 가–힣 hangul syllables, 　–ヿ CJK punctuation/kana, etc.
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x1100 && code <= 0xD7A3) units += 1.5;
    else if (code >= 0x3000 && code <= 0x9FFF) units += 1.5;
    else units += 1;
  }
  return units * 6.2;
}
