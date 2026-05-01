import { describe, expect, it } from 'vitest';
import { cornerDrag, groupBbox, projectMembers } from './multiResize';

describe('cornerDrag', () => {
  it('moves the bottom-right corner to the cursor while pinning top-left', () => {
    const orig = { x: 100, y: 100, w: 50, h: 40 };
    const next = cornerDrag(orig, 'br', 200, 180);
    expect(next).toEqual({ x: 100, y: 100, w: 100, h: 80 });
  });

  it('pins the opposite edges when each non-br corner is dragged', () => {
    const orig = { x: 100, y: 100, w: 50, h: 40 };
    // tl: top-left moves to cursor; bottom-right (150, 140) must stay put.
    const tl = cornerDrag(orig, 'tl', 80, 70);
    expect(tl.x + tl.w).toBe(150);
    expect(tl.y + tl.h).toBe(140);
    expect(tl).toEqual({ x: 80, y: 70, w: 70, h: 70 });

    // tr: top-right moves; bottom-left (100, 140) must stay put.
    const tr = cornerDrag(orig, 'tr', 200, 70);
    expect(tr.x).toBe(100);
    expect(tr.y + tr.h).toBe(140);
    expect(tr).toEqual({ x: 100, y: 70, w: 100, h: 70 });

    // bl: bottom-left moves; top-right (150, 100) must stay put.
    const bl = cornerDrag(orig, 'bl', 80, 200);
    expect(bl.x + bl.w).toBe(150);
    expect(bl.y).toBe(100);
    expect(bl).toEqual({ x: 80, y: 100, w: 70, h: 100 });
  });

  it('clamps to a 1x1 bbox pinned at the opposite edge when the cursor passes through', () => {
    const orig = { x: 100, y: 100, w: 50, h: 40 };
    // Drag bottom-right cursor far above and to the left of the top-left corner.
    // Result: 1x1 bbox pinned at (100, 100), since top-left is the opposite of br.
    const collapsed = cornerDrag(orig, 'br', 50, 50);
    expect(collapsed).toEqual({ x: 100, y: 100, w: 1, h: 1 });

    // Drag top-left cursor far below and to the right of the bottom-right.
    // Result: 1x1 bbox pinned at (149, 139) — the bottom-right of the original
    // group minus 1 pixel on each axis (so width/height stay at 1).
    const collapsedTL = cornerDrag(orig, 'tl', 999, 999);
    expect(collapsedTL).toEqual({ x: 149, y: 139, w: 1, h: 1 });
  });
});

describe('projectMembers', () => {
  it('scales each member proportionally and preserves their relative positions', () => {
    // Group bbox enclosing two members in opposite quadrants.
    const orig = { x: 0, y: 0, w: 100, h: 100 };
    const members = [
      { guid: 'a', bounds: { x: 0, y: 0, w: 20, h: 20 } },          // top-left of group
      { guid: 'b', bounds: { x: 80, y: 80, w: 20, h: 20 } },        // bottom-right of group
    ];
    // Double the group's width and height.
    const live = { x: 0, y: 0, w: 200, h: 200 };
    const out = projectMembers(orig, live, members);
    expect(out).toEqual([
      { guid: 'a', bounds: { x: 0, y: 0, w: 40, h: 40 } },
      { guid: 'b', bounds: { x: 160, y: 160, w: 40, h: 40 } },
    ]);
  });
});

describe('groupBbox', () => {
  it('returns the smallest bbox enclosing every member, even when they are disjoint', () => {
    const members = [
      { x: 10, y: 20, w: 30, h: 40 },   // rightmost-x = 40, bottommost-y = 60
      { x: 100, y: 5, w: 5, h: 200 },   // rightmost-x = 105, bottommost-y = 205
      { x: -10, y: 80, w: 20, h: 10 },  // leftmost-x = -10, top-y = 80
    ];
    expect(groupBbox(members)).toEqual({ x: -10, y: 5, w: 115, h: 200 });
  });
});
