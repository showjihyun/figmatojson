/**
 * Figma textCase / textDecoration → render-time string transform +
 * Konva.Text textDecoration prop value.
 *
 * Spec: docs/specs/web-render-fidelity-round5.spec.md §3, §4
 *
 * textCase is render-only — Figma keeps `textData.characters` in the
 * original case and applies the transform when displaying. CJK / Hangul
 * have no case mapping so toUpperCase / toLowerCase are no-ops there
 * (preserving Korean text intact).
 */

/**
 * Apply Figma textCase to the rendered string. Returns the input
 * unchanged for ORIGINAL / unknown values so callers can spread the
 * helper without branching.
 */
export function applyTextCase(chars: string, textCase: string | undefined): string {
  switch (textCase) {
    case 'UPPER': return chars.toUpperCase();
    case 'LOWER': return chars.toLowerCase();
    case 'TITLE': return titleCase(chars);
    default:      return chars;
  }
}

/** Word-by-word "Title Case" — split on whitespace, capitalize each. */
function titleCase(s: string): string {
  return s.replace(/(\S+)/g, (word) => {
    if (word.length === 0) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

/**
 * Map Figma textDecoration → Konva.Text textDecoration prop value.
 * Returns undefined for NONE / missing so the prop is omitted (Konva
 * default = no decoration).
 */
export function konvaTextDecoration(figma: string | undefined): string | undefined {
  switch (figma) {
    case 'UNDERLINE':     return 'underline';
    case 'STRIKETHROUGH': return 'line-through';
    default:              return undefined;
  }
}
