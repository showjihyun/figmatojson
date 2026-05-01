/**
 * Page-level viewport culling.
 *
 * Top-level CANVAS children (FRAMEs, typically) hold most of the document's
 * volume — culling them saves the recursive React reconciliation of all
 * their descendants. A page-level filter is enough to dominate the perf
 * win in typical Figma docs without needing per-node abs-bbox caches.
 *
 * Pure: takes the page's children + the visible Stage rect, returns the
 * subset of children whose bounding rect intersects the viewport. The
 * Canvas component re-runs this on every offset/scale/size change.
 */

import type { DocumentNode } from '@core/domain/entities/Document';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Convert the on-screen viewport (DOM container size) into the Stage's
 * coordinate space, given the current Stage transform.
 *
 * Screen point (x, y) maps to stage (sx, sy) by:
 *     screen = stage * scale + offset
 * inverse:
 *     stage  = (screen - offset) / scale
 *
 * `pad` (in screen px) extends the rect outward so nodes near the edge
 * stay mounted across small pans — avoids mount/unmount thrash.
 */
export function viewportInStageCoords(
  containerSize: { width: number; height: number },
  offset: { x: number; y: number },
  scale: number,
  pad = 200,
): Rect {
  if (scale <= 0) return { x: -Infinity, y: -Infinity, w: Infinity, h: Infinity };
  // `+ 0` normalizes JS's signed-zero quirk so callers and tests don't
  // have to compare against `-0`.
  const x = ((-offset.x - pad) / scale) + 0;
  const y = ((-offset.y - pad) / scale) + 0;
  const w = (containerSize.width + pad * 2) / scale;
  const h = (containerSize.height + pad * 2) / scale;
  return { x, y, w, h };
}

/** Standard rect-rect AABB intersection. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return false;
  if (a.x + a.w <= b.x) return false;
  if (b.x + b.w <= a.x) return false;
  if (a.y + a.h <= b.y) return false;
  if (b.y + b.h <= a.y) return false;
  return true;
}

/** Read a node's local bounding rect (already in CANVAS coords for top-level children). */
function nodeRect(n: DocumentNode): Rect {
  const x = (n.transform as { m02?: number } | undefined)?.m02 ?? 0;
  const y = (n.transform as { m12?: number } | undefined)?.m12 ?? 0;
  const w = (n.size as { x?: number } | undefined)?.x ?? 0;
  const h = (n.size as { y?: number } | undefined)?.y ?? 0;
  return { x, y, w, h };
}

/**
 * Return only the children that intersect `viewport`. Nodes without a
 * concrete bbox (no `size`) are kept — bailing wide is safer than hiding.
 */
export function cullChildrenByViewport(
  children: readonly DocumentNode[],
  viewport: Rect,
): DocumentNode[] {
  const out: DocumentNode[] = [];
  for (const c of children) {
    const r = nodeRect(c);
    if (r.w === 0 || r.h === 0) {
      out.push(c);
      continue;
    }
    if (rectsIntersect(r, viewport)) out.push(c);
  }
  return out;
}
