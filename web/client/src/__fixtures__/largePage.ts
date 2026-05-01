/**
 * Synthetic Document fixture for perf tests / benchmarks.
 *
 * Produces a CANVAS page laid out as a uniform grid of FRAME nodes, each
 * containing N children. Total node count is `frames * (1 + childrenPerFrame)`
 * (one for the frame, N for its children) plus the CANVAS itself.
 *
 * Shape matches the live `Document` tree the server emits — same property
 * names the renderer reads (`transform.m02/m12`, `size.x/y`, `fillPaints[0].color`).
 *
 * Pure / synchronous / no IO. Lives under `client/src/__fixtures__/` so it's
 * tree-shaken out of production builds.
 */

import type { Document, DocumentNode } from '@core/domain/entities/Document';

export interface LargePageOptions {
  /** Top-level frames laid out in a grid. */
  frames: number;
  /** Children per frame (RECTANGLE nodes laid out in a sub-grid). */
  childrenPerFrame: number;
  /** Width/height of each frame, px. */
  frameSize?: number;
  /** Gap between frames, px. */
  frameGap?: number;
}

/**
 * Build a Document with one CANVAS page filled with `frames` FRAMEs, each
 * carrying `childrenPerFrame` RECTANGLE children. GUIDs are deterministic
 * `(0, idx)` so tests can target specific nodes by guid string.
 */
export function makeLargePage(opts: LargePageOptions): Document {
  const {
    frames,
    childrenPerFrame,
    frameSize = 400,
    frameGap = 60,
  } = opts;

  // Pack frames into a near-square grid so the page bbox stays roughly square.
  const cols = Math.max(1, Math.ceil(Math.sqrt(frames)));
  const stride = frameSize + frameGap;

  let nextLocalId = 100;
  const newGuid = () => ({ sessionID: 0, localID: nextLocalId++ });

  const frameNodes: DocumentNode[] = [];
  for (let i = 0; i < frames; i++) {
    const fx = (i % cols) * stride;
    const fy = Math.floor(i / cols) * stride;
    const frameGuid = newGuid();

    // Children: laid out in a 4-column grid inside the frame.
    const childCols = 4;
    const childW = (frameSize - 20) / childCols;
    const childH = 30;
    const childStrideY = childH + 4;
    const children: DocumentNode[] = [];
    for (let j = 0; j < childrenPerFrame; j++) {
      const cx = (j % childCols) * (childW + 4) + 10;
      const cy = Math.floor(j / childCols) * childStrideY + 10;
      const cGuid = newGuid();
      children.push({
        id: `${cGuid.sessionID}:${cGuid.localID}`,
        guid: cGuid,
        type: 'RECTANGLE',
        name: `rect-${i}-${j}`,
        transform: { m02: cx, m12: cy } as Record<string, number>,
        size: { x: childW, y: childH },
        fillPaints: [
          { type: 'SOLID', visible: true, opacity: 1, color: { r: 0.4, g: 0.4, b: 0.4, a: 1 } },
        ],
      } as DocumentNode);
    }

    frameNodes.push({
      id: `${frameGuid.sessionID}:${frameGuid.localID}`,
      guid: frameGuid,
      type: 'FRAME',
      name: `frame-${i}`,
      transform: { m02: fx, m12: fy } as Record<string, number>,
      size: { x: frameSize, y: frameSize },
      fillPaints: [
        { type: 'SOLID', visible: true, opacity: 1, color: { r: 0.95, g: 0.95, b: 0.95, a: 1 } },
      ],
      children,
    } as DocumentNode);
  }

  const canvas: DocumentNode = {
    id: '0:1',
    guid: { sessionID: 0, localID: 1 },
    type: 'CANVAS',
    name: 'page',
    children: frameNodes,
  };

  return {
    id: '0:0',
    guid: { sessionID: 0, localID: 0 },
    type: 'DOCUMENT',
    children: [canvas],
  } as Document;
}

/** Convenience: just the CANVAS subtree (what Canvas.tsx receives as `page`). */
export function makeLargeCanvas(opts: LargePageOptions): DocumentNode {
  const doc = makeLargePage(opts);
  return doc.children![0]!;
}
