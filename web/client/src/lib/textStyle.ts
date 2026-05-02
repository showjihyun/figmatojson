/**
 * Conversions from Figma .fig text style fields → Konva.Text props.
 *
 * Spec: docs/specs/web-render-fidelity-high.spec.md §3.1–3.5
 *
 * All inputs come straight off the kiwi-decoded TEXT node (top-level
 * fields, not inside `textData`). Each helper returns `undefined` when
 * the input is absent or default — Canvas spreads the result so undefined
 * props are dropped and Konva picks its own defaults.
 */

interface LengthValue {
  value?: number;
  units?: string;
}

/**
 * letterSpacing → KText.letterSpacing in pixels.
 *
 * - PIXELS: pass-through.
 * - PERCENT: (value / 100) * fontSize. Negative values allowed (Korean
 *   typography commonly uses -0.5% as default tightening).
 * - 0 or missing: undefined (omit prop, use Konva default 0).
 *
 * Spec I-LS1..LS3.
 */
export function konvaLetterSpacing(
  ls: LengthValue | undefined,
  fontSize: number | undefined,
): number | undefined {
  if (!ls || typeof ls.value !== 'number' || ls.value === 0) return undefined;
  if (ls.units === 'PIXELS') return ls.value;
  if (ls.units === 'PERCENT') {
    if (typeof fontSize !== 'number' || fontSize <= 0) return undefined;
    return (ls.value / 100) * fontSize;
  }
  return undefined;
}

/**
 * lineHeight → KText.lineHeight as a fontSize multiplier.
 *
 * - RAW: pass-through (already a multiplier).
 * - PERCENT: value / 100.
 * - PIXELS: value / fontSize. Returns undefined if fontSize is 0/missing.
 * - missing or invalid: undefined (omit prop, use Konva default 1.0).
 *
 * Spec I-LH1..LH4.
 */
export function konvaLineHeight(
  lh: LengthValue | undefined,
  fontSize: number | undefined,
): number | undefined {
  if (!lh || typeof lh.value !== 'number' || lh.value <= 0) return undefined;
  if (lh.units === 'RAW') return lh.value;
  if (lh.units === 'PERCENT') return lh.value / 100;
  if (lh.units === 'PIXELS') {
    if (typeof fontSize !== 'number' || fontSize <= 0) return undefined;
    return lh.value / fontSize;
  }
  return undefined;
}

/**
 * textAlignVertical → KText.verticalAlign.
 *
 * Spec I-AV1..AV5. Returns undefined for unknown values so Konva keeps
 * its default (top).
 */
export function konvaVerticalAlign(
  av: string | undefined,
): 'top' | 'middle' | 'bottom' | undefined {
  switch (av) {
    case 'CENTER': return 'middle';
    case 'BOTTOM': return 'bottom';
    case 'TOP':    return 'top';
    default:       return undefined;
  }
}

/**
 * textAlignHorizontal → KText.align.
 *
 * Spec I-AH1..AH5. JUSTIFIED maps to 'justify' as the closest Konva
 * equivalent (not pixel-perfect with Figma but the only available option).
 */
export function konvaTextAlign(
  ah: string | undefined,
): 'left' | 'center' | 'right' | 'justify' | undefined {
  switch (ah) {
    case 'CENTER':    return 'center';
    case 'RIGHT':     return 'right';
    case 'JUSTIFIED': return 'justify';
    case 'LEFT':      return 'left';
    default:          return undefined;
  }
}

/**
 * fontName.style → KText.fontStyle ('normal' | 'bold' | 'italic' | 'italic bold').
 *
 * Konva.Text accepts only the four names — no numeric weights. Medium /
 * SemiBold / Light all collapse to 'normal'; the browser then picks the
 * closest weight available in the family. Spec I-FS1..FS3.
 */
export function konvaFontStyle(style: string | undefined): string | undefined {
  if (typeof style !== 'string' || style.length === 0) return undefined;
  const lower = style.toLowerCase();
  const isItalic = /italic|oblique/.test(lower);
  // Strip italic + spaces + hyphens to test the WEIGHT word in isolation.
  // SemiBold/Medium/Light/Regular leave a non-empty residual that doesn't
  // match the bold-set, so they correctly fall through to "normal".
  const weightWord = lower.replace(/italic|oblique/g, '').replace(/[\s-]/g, '').trim();
  const isBold = /^(bold|extrabold|ultrabold|heavy|black)$/.test(weightWord);
  if (isBold && isItalic) return 'italic bold';
  if (isBold) return 'bold';
  if (isItalic) return 'italic';
  return undefined; // Regular / Medium / SemiBold / Light → Konva default 'normal'
}
