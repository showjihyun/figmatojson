/**
 * Pure geometry helpers for the multi-select resize overlay.
 *
 * Bbox = axis-aligned bounding box in canvas coordinates.
 *   x, y = top-left corner; w, h = positive dimensions.
 *
 * Corner labels follow CSS reading order:
 *   tl = top-left, tr = top-right, bl = bottom-left, br = bottom-right.
 */

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

/** Smallest axis-aligned bbox enclosing every member. Members may be disjoint. */
export function groupBbox(members: Bbox[]): Bbox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const m of members) {
    if (m.x < minX) minX = m.x;
    if (m.y < minY) minY = m.y;
    if (m.x + m.w > maxX) maxX = m.x + m.w;
    if (m.y + m.h > maxY) maxY = m.y + m.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Given a group bbox and the cursor position of a dragged corner, compute
 * the new group bbox. The corner opposite the dragged one stays pinned.
 */
export function cornerDrag(orig: Bbox, corner: Corner, cursorX: number, cursorY: number): Bbox {
  const right = orig.x + orig.w;
  const bottom = orig.y + orig.h;
  let x = orig.x;
  let y = orig.y;
  let w = orig.w;
  let h = orig.h;
  if (corner === 'br') {
    w = cursorX - orig.x;
    h = cursorY - orig.y;
  } else if (corner === 'bl') {
    x = cursorX;
    w = right - cursorX;
    h = cursorY - orig.y;
  } else if (corner === 'tr') {
    y = cursorY;
    w = cursorX - orig.x;
    h = bottom - cursorY;
  } else {
    x = cursorX;
    y = cursorY;
    w = right - cursorX;
    h = bottom - cursorY;
  }
  // Clamp minimums; pin the opposite edge so the bbox doesn't fly off when
  // the cursor is dragged through it.
  if (w < 1) {
    w = 1;
    if (corner === 'tl' || corner === 'bl') x = right - 1;
  }
  if (h < 1) {
    h = 1;
    if (corner === 'tl' || corner === 'tr') y = bottom - 1;
  }
  return { x, y, w, h };
}

/**
 * Project each member's bbox from the original group bbox (`orig`) into a
 * new group bbox (`live`). Each member's relative position and size within
 * the group is preserved; absolute coordinates scale with the group.
 */
export function projectMembers<T extends { bounds: Bbox }>(orig: Bbox, live: Bbox, members: T[]): T[] {
  const sx = live.w / orig.w;
  const sy = live.h / orig.h;
  return members.map((m) => ({
    ...m,
    bounds: {
      x: live.x + (m.bounds.x - orig.x) * sx,
      y: live.y + (m.bounds.y - orig.y) * sy,
      w: m.bounds.w * sx,
      h: m.bounds.h * sy,
    },
  }));
}
