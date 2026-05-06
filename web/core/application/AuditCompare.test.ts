// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { AuditCompare, type FigmaNode } from './AuditCompare.js';
import { FakeSessionStore } from './testing/fakeSessionStore.js';

/**
 * Spec: docs/specs/audit-oracle.spec.md round 32 (R12-A/B/D).
 *
 *  R12-A — `transform.m02/m12` and `size.x/y` are gated when either side
 *          carries a non-zero rotation. REST emits axis-aligned bbox after
 *          rotation; kiwi emits the pre-rotation anchor — different meaning
 *          → false-positive without the gate.
 *  R12-B — `rotation` field uses 360°-wrap modular tolerance so 180/-180,
 *          270/-90, etc. compare equal (atan2 derivation noise + plugin
 *          wraparound).
 *  R12-D — `stackPrimaryAlignItems` aliases `SPACE_EVENLY` (kiwi schema
 *          name) ↔ `SPACE_BETWEEN` (Figma current name). Same binary value.
 */

function seedStore(documentJson: Record<string, unknown>): FakeSessionStore {
  const store = new FakeSessionStore();
  store.seed(
    {
      id: 'sid',
      dir: '/tmp/fake',
      origName: 'x.fig',
      archiveVersion: 106,
      documentJson: documentJson as never,
    },
    JSON.stringify({ nodeChanges: [] }),
  );
  return store;
}

function topByField(out: Awaited<ReturnType<AuditCompare['execute']>>, field: string): number {
  return out.topFields.find((f) => f.field === field)?.count ?? 0;
}

describe('AuditCompare R12-A — rotation gate on transform/size', () => {
  it('does NOT flag transform.m02/m12 when a node is rotated 180° (m00=-1, m11=-1)', async () => {
    // 700:160 reproduction. REST emits absoluteBoundingBox (post-rotation
    // axis-aligned bbox top-left); kiwi emits pre-rotation anchor.
    const figmaTree: FigmaNode = {
      id: 'root', type: 'PAGE', name: 'P', visible: true,
      children: [{
        id: '700:160',
        type: 'POLYGON',
        name: 'Polygon 12',
        visible: true,
        size: { x: 12, y: 10 },
        // post-rotation bbox top-left (REST style)
        transform: { m02: 62, m12: 9 },
        rotation: 180,
      }],
    };
    const documentJson = {
      id: '0:0', guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT',
      children: [{ id: 'root', type: 'PAGE', name: 'P', visible: true, children: [
        {
          id: '700:160',
          type: 'POLYGON',
          name: 'Polygon 12',
          visible: true,
          size: { x: 12, y: 10 },
          // pre-rotation anchor (kiwi style)
          transform: { m00: -1, m01: 0, m02: 74, m10: 0, m11: -1, m12: 19 },
        },
      ]}],
    };
    const out = await new AuditCompare(seedStore(documentJson)).execute({
      sessionId: 'sid',
      figmaTree,
    });
    expect(out.summary.matchedNodes).toBe(2); // root + 700:160
    expect(topByField(out, 'transform.m02')).toBe(0);
    expect(topByField(out, 'transform.m12')).toBe(0);
    // size in this reproduction matches; the gate must still skip a *would-
    // be* size mismatch on rotated nodes — verified separately below.
  });

  it('skips size.x/y on rotated nodes even when bbox-derived sizes differ', async () => {
    const figmaTree: FigmaNode = {
      id: 'root', type: 'PAGE', name: 'P', visible: true,
      children: [{
        id: 'A',
        type: 'RECTANGLE', name: 'A', visible: true,
        // post-rotation bbox of a 100×20 rect rotated 90° = 20×100
        size: { x: 20, y: 100 },
        rotation: 90,
      }],
    };
    const documentJson = {
      id: '0:0', guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT',
      children: [{ id: 'root', type: 'PAGE', name: 'P', visible: true, children: [
        {
          id: 'A', type: 'RECTANGLE', name: 'A', visible: true,
          size: { x: 100, y: 20 },
          transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 0 },
        },
      ]}],
    };
    const out = await new AuditCompare(seedStore(documentJson)).execute({
      sessionId: 'sid',
      figmaTree,
    });
    expect(topByField(out, 'size.x')).toBe(0);
    expect(topByField(out, 'size.y')).toBe(0);
  });

  it('still flags transform/size on UNROTATED nodes (regression guard)', async () => {
    const figmaTree: FigmaNode = {
      id: 'root', type: 'PAGE', name: 'P', visible: true,
      children: [{
        id: 'A',
        type: 'RECTANGLE', name: 'A', visible: true,
        size: { x: 100, y: 20 },
        transform: { m02: 50, m12: 30 },
      }],
    };
    const documentJson = {
      id: '0:0', guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT',
      children: [{ id: 'root', type: 'PAGE', name: 'P', visible: true, children: [
        {
          id: 'A', type: 'RECTANGLE', name: 'A', visible: true,
          size: { x: 110, y: 20 },                                       // 10px size diff
          transform: { m00: 1, m01: 0, m02: 70, m10: 0, m11: 1, m12: 30 }, // 20px x diff
        },
      ]}],
    };
    const out = await new AuditCompare(seedStore(documentJson)).execute({
      sessionId: 'sid',
      figmaTree,
    });
    expect(topByField(out, 'transform.m02')).toBe(1);
    expect(topByField(out, 'size.x')).toBe(1);
  });

  it('treats m00<0 alone as rotated (180° mirror-like case)', async () => {
    const figmaTree: FigmaNode = {
      id: 'root', type: 'PAGE', name: 'P', visible: true,
      children: [{
        id: 'A', type: 'RECTANGLE', name: 'A', visible: true,
        size: { x: 50, y: 20 },
        transform: { m02: 0, m12: 0 },
        rotation: 180,
      }],
    };
    const documentJson = {
      id: '0:0', guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT',
      children: [{ id: 'root', type: 'PAGE', name: 'P', visible: true, children: [
        {
          id: 'A', type: 'RECTANGLE', name: 'A', visible: true,
          size: { x: 50, y: 20 },
          transform: { m00: -1, m01: 0, m02: 50, m10: 0, m11: -1, m12: 20 },
        },
      ]}],
    };
    const out = await new AuditCompare(seedStore(documentJson)).execute({
      sessionId: 'sid',
      figmaTree,
    });
    expect(topByField(out, 'transform.m02')).toBe(0);
    expect(topByField(out, 'transform.m12')).toBe(0);
  });
});

describe('AuditCompare R12-B — rotation modular tolerance', () => {
  function buildPair(figmaRotation: number | undefined, oursMatrix: { m00: number; m01: number }) {
    const figmaTree: FigmaNode = {
      id: 'root', type: 'PAGE', name: 'P', visible: true,
      children: [{
        id: 'A', type: 'RECTANGLE', name: 'A', visible: true,
        size: { x: 100, y: 20 }, transform: { m02: 0, m12: 0 },
        rotation: figmaRotation,
      }],
    };
    const documentJson = {
      id: '0:0', guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT',
      children: [{ id: 'root', type: 'PAGE', name: 'P', visible: true, children: [
        {
          id: 'A', type: 'RECTANGLE', name: 'A', visible: true,
          size: { x: 100, y: 20 },
          transform: { m00: oursMatrix.m00, m01: oursMatrix.m01, m02: 0, m10: 0, m11: oursMatrix.m00, m12: 0 },
        },
      ]}],
    };
    return { figmaTree, documentJson };
  }

  it('treats 180 and -180 as equal (same rotation)', async () => {
    const { figmaTree, documentJson } = buildPair(-180, { m00: -1, m01: 0 }); // ours derives +180
    const out = await new AuditCompare(seedStore(documentJson)).execute({
      sessionId: 'sid', figmaTree,
    });
    expect(topByField(out, 'rotation')).toBe(0);
  });

  it('treats 270 and -90 as equal (modular wrap)', async () => {
    const { figmaTree, documentJson } = buildPair(270, { m00: 0, m01: -1 }); // ours derives -90
    const out = await new AuditCompare(seedStore(documentJson)).execute({
      sessionId: 'sid', figmaTree,
    });
    expect(topByField(out, 'rotation')).toBe(0);
  });

  it('still flags rotation mismatches outside the 0.5° tolerance', async () => {
    // figma=10°, ours derives ~20° from a (cos20, -sin20) matrix
    const c = Math.cos((20 * Math.PI) / 180);
    const s = Math.sin((20 * Math.PI) / 180);
    const { figmaTree, documentJson } = buildPair(10, { m00: c, m01: s });
    const out = await new AuditCompare(seedStore(documentJson)).execute({
      sessionId: 'sid', figmaTree,
    });
    expect(topByField(out, 'rotation')).toBe(1);
  });
});

describe('AuditCompare R12-D — VALUE_ALIASES for stackPrimaryAlignItems', () => {
  function buildPair(figmaValue: string, oursValue: string) {
    const figmaTree: FigmaNode = {
      id: 'root', type: 'PAGE', name: 'P', visible: true,
      children: [{
        id: 'A', type: 'FRAME', name: 'A', visible: true,
        size: { x: 100, y: 20 }, transform: { m02: 0, m12: 0 },
        stackMode: 'HORIZONTAL', stackPrimaryAlignItems: figmaValue,
      }],
    };
    const documentJson = {
      id: '0:0', guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT',
      children: [{ id: 'root', type: 'PAGE', name: 'P', visible: true, children: [
        {
          id: 'A', type: 'FRAME', name: 'A', visible: true,
          size: { x: 100, y: 20 },
          transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
          stackMode: 'HORIZONTAL', stackPrimaryAlignItems: oursValue,
        },
      ]}],
    };
    return { figmaTree, documentJson };
  }

  it('SPACE_EVENLY (kiwi) ↔ SPACE_BETWEEN (Figma) compare equal', async () => {
    const { figmaTree, documentJson } = buildPair('SPACE_BETWEEN', 'SPACE_EVENLY');
    const out = await new AuditCompare(seedStore(documentJson)).execute({
      sessionId: 'sid', figmaTree,
    });
    expect(topByField(out, 'stackPrimaryAlignItems')).toBe(0);
  });

  it('still flags real mismatches (CENTER vs SPACE_BETWEEN)', async () => {
    const { figmaTree, documentJson } = buildPair('SPACE_BETWEEN', 'CENTER');
    const out = await new AuditCompare(seedStore(documentJson)).execute({
      sessionId: 'sid', figmaTree,
    });
    expect(topByField(out, 'stackPrimaryAlignItems')).toBe(1);
  });

  it('exact equality on identical values', async () => {
    const { figmaTree, documentJson } = buildPair('CENTER', 'CENTER');
    const out = await new AuditCompare(seedStore(documentJson)).execute({
      sessionId: 'sid', figmaTree,
    });
    expect(topByField(out, 'stackPrimaryAlignItems')).toBe(0);
  });
});
