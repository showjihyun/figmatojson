/**
 * Pick the visually-topmost paint from `fillPaints[]`.
 *
 * Spec: docs/specs/web-render-fidelity-round4.spec.md §3
 *
 * Figma stacks paints bottom-up: `fillPaints[0]` is at the bottom of
 * the visual stack and `fillPaints[N-1]` sits on top. The earlier
 * `solidFillCss` picked the FIRST visible SOLID paint, which selected
 * the bottom paint and hid any overlay above it — wrong for the (rare)
 * multi-paint nodes.
 *
 * This helper iterates back-to-front and returns the topmost visible
 * non-IMAGE paint. IMAGE fills are handled separately by the existing
 * ImageFill component, so they're skipped here.
 */

interface Paint {
  type?: string;
  visible?: boolean;
}

export function pickTopPaint<P extends Paint>(paints: P[] | undefined): P | null {
  if (!Array.isArray(paints)) return null;
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = paints[i];
    if (!p) continue;
    if (p.visible === false) continue;
    if (p.type === 'IMAGE') continue;
    return p;
  }
  return null;
}
