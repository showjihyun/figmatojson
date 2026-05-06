import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyTool } from './applyTool.js';
import { InMemoryEditJournal } from './InMemoryEditJournal.js';
import { History } from '../../../core/application/History.js';
import type { Session } from '../../../core/domain/entities/Session.js';
import type { Document } from '../../../core/domain/entities/Document.js';

/**
 * Build a minimal session whose message.json has two text/rect/instance nodes
 * the chat tools can mutate. The on-disk shape mirrors what FsSessionStore
 * lays out; the documentJson mirror is the same data in client-tree form so
 * `mirrorClient` can find a node by guid.
 */
function buildFixture(): { dir: string; session: Session; messagePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'apply-tool-'));
  const decodedDir = join(dir, 'extracted', '04_decoded');
  mkdirSync(decodedDir, { recursive: true });

  // Build a small DOCUMENT/CANVAS skeleton plus the leaf nodes the existing
  // tool tests use. parentIndex.guid + position links match what kiwi
  // produces — required so the duplicate tool's subtree walk + the
  // rebuildDocumentFromMessage helper see the same parent linkage.
  const msg = {
    nodeChanges: [
      {
        guid: { sessionID: 0, localID: 0 },
        type: 'DOCUMENT',
      },
      {
        guid: { sessionID: 0, localID: 100 },
        type: 'CANVAS',
        name: 'page',
        parentIndex: { guid: { sessionID: 0, localID: 0 }, position: 'V' },
      },
      {
        guid: { sessionID: 0, localID: 1 },
        type: 'TEXT',
        textData: { characters: 'hello' },
        transform: { m02: 10, m12: 20 },
        size: { x: 100, y: 50 },
        cornerRadius: 0,
        fillPaints: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 0, b: 0, a: 1 } }],
        parentIndex: { guid: { sessionID: 0, localID: 100 }, position: 'V' },
      },
      {
        guid: { sessionID: 0, localID: 2 },
        type: 'RECTANGLE',
        transform: { m02: 200, m12: 300 },
        size: { x: 80, y: 40 },
        cornerRadius: 4,
        fillPaints: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0, g: 0, b: 1, a: 1 } }],
        parentIndex: { guid: { sessionID: 0, localID: 100 }, position: 'X' },
      },
      {
        guid: { sessionID: 0, localID: 3 },
        type: 'INSTANCE',
        symbolData: { symbolOverrides: [] },
        parentIndex: { guid: { sessionID: 0, localID: 100 }, position: 'Z' },
      },
    ],
  };
  const messagePath = join(decodedDir, 'message.json');
  writeFileSync(messagePath, JSON.stringify(msg));

  // Client-tree mirror — what `s.documentJson` looks like in the running
  // server. Same nodes, but wrapped in a DOCUMENT root with a CANVAS page.
  const documentJson: Document = {
    id: 'DOCUMENT',
    guid: { sessionID: 0, localID: 0 },
    type: 'DOCUMENT',
    children: [
      {
        id: 'CANVAS',
        guid: { sessionID: 0, localID: 100 },
        type: 'CANVAS',
        children: [
          {
            id: '0:1',
            guid: { sessionID: 0, localID: 1 },
            type: 'TEXT',
            textData: { characters: 'hello' },
            transform: { m02: 10, m12: 20 },
            size: { x: 100, y: 50 },
            cornerRadius: 0,
            fillPaints: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 0, b: 0, a: 1 } }],
          },
          {
            id: '0:2',
            guid: { sessionID: 0, localID: 2 },
            type: 'RECTANGLE',
            transform: { m02: 200, m12: 300 },
            size: { x: 80, y: 40 },
            cornerRadius: 4,
            fillPaints: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0, g: 0, b: 1, a: 1 } }],
          },
          {
            id: '0:3',
            guid: { sessionID: 0, localID: 3 },
            type: 'INSTANCE',
            _instanceOverrides: {},
          },
        ],
      },
    ],
  } as Document;

  const session: Session = {
    id: 'sid-test',
    dir,
    origName: 'fixture.fig',
    archiveVersion: 106,
    documentJson,
  };
  return { dir, session, messagePath };
}

/**
 * Disk-backed SessionStore + FsLike shim for tests that need a real History
 * step against the same on-disk message.json that applyTool writes through
 * `s.dir`. Both halves share state so History.readMessage observes applyTool's
 * mutations without any in-memory caching layer to keep in sync.
 */
function buildDiskStore(
  f: ReturnType<typeof buildFixture>,
): {
  getById: (id: string) => Session | null;
  readMessage: (id: string) => string;
  writeMessage: (id: string, json: string) => void;
  create: () => Promise<Session>;
  flush: (id: string) => Promise<void>;
  resolvePath: (id: string, ...segments: string[]) => string;
  destroy: (id: string) => Promise<void>;
} {
  return {
    getById: (id) => (id === f.session.id ? f.session : null),
    readMessage: () => readFileSync(f.messagePath, 'utf8'),
    writeMessage: (_id, json) => writeFileSync(f.messagePath, json),
    create: () => { throw new Error('not used in tests'); },
    flush: async () => {},
    resolvePath: () => f.dir,
    destroy: async () => {},
  };
}

describe('applyTool — chat-driven mutations record to the journal', () => {
  let fx: ReturnType<typeof buildFixture>;
  let journal: InMemoryEditJournal;

  beforeEach(() => {
    fx = buildFixture();
    journal = new InMemoryEditJournal();
  });
  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  it('set_text records before/after with AI-prefixed label', async () => {
    await applyTool(fx.session, 'set_text', { guid: '0:1', value: 'world' }, journal);

    expect(journal.depths('sid-test')).toEqual({ past: 1, future: 0 });
    const entry = journal.popStep('sid-test', 'undo');
    expect(entry?.label).toBe('AI: set_text');
    expect(entry?.patches).toEqual([
      { guid: '0:1', field: 'textData.characters', before: 'hello', after: 'world' },
    ]);
    // Disk + in-memory mirror both reflect the new value
    const disk = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
      nodeChanges: Array<Record<string, unknown>>;
    };
    const textNode = disk.nodeChanges.find((n) => {
      const g = n.guid as { localID?: number } | undefined;
      return g?.localID === 1;
    }) as { textData: { characters: string } } | undefined;
    expect(textNode?.textData.characters).toBe('world');
  });

  it('set_position records both axes', async () => {
    await applyTool(fx.session, 'set_position', { guid: '0:1', x: 99, y: 77 }, journal);
    const entry = journal.popStep('sid-test', 'undo');
    expect(entry?.label).toBe('AI: set_position');
    expect(entry?.patches).toEqual([
      { guid: '0:1', field: 'transform.m02', before: 10, after: 99 },
      { guid: '0:1', field: 'transform.m12', before: 20, after: 77 },
    ]);
  });

  it('set_size clamps to >= 1 and records both dimensions', async () => {
    await applyTool(fx.session, 'set_size', { guid: '0:1', w: 0, h: 250 }, journal);
    const entry = journal.popStep('sid-test', 'undo');
    expect(entry?.patches).toEqual([
      { guid: '0:1', field: 'size.x', before: 100, after: 1 },
      { guid: '0:1', field: 'size.y', before: 50, after: 250 },
    ]);
  });

  it('set_fill_color records the full fillPaints array (deep clone)', async () => {
    await applyTool(
      fx.session,
      'set_fill_color',
      { guid: '0:1', r: 0, g: 1, b: 0, a: 0.5 },
      journal,
    );
    const entry = journal.popStep('sid-test', 'undo');
    expect(entry?.label).toBe('AI: set_fill_color');
    expect(entry?.patches).toHaveLength(1);
    const p = entry!.patches[0];
    expect(p.field).toBe('fillPaints');
    expect((p.before as Array<{ color: { r: number } }>)[0].color.r).toBe(1);
    expect((p.after as Array<{ color: { g: number; a: number } }>)[0].color.g).toBe(1);
    expect((p.after as Array<{ color: { a: number } }>)[0].color.a).toBe(0.5);
  });

  it('set_corner_radius records cornerRadius', async () => {
    await applyTool(fx.session, 'set_corner_radius', { guid: '0:2', value: 12 }, journal);
    const entry = journal.popStep('sid-test', 'undo');
    expect(entry?.label).toBe('AI: set_corner_radius');
    expect(entry?.patches).toEqual([
      { guid: '0:2', field: 'cornerRadius', before: 4, after: 12 },
    ]);
  });

  it('set_corner_radius clamps negatives to 0', async () => {
    await applyTool(fx.session, 'set_corner_radius', { guid: '0:2', value: -5 }, journal);
    const entry = journal.popStep('sid-test', 'undo');
    expect(entry?.patches[0].after).toBe(0);
  });

  it('align_nodes (left) records only m02 patches with correct before/after', async () => {
    // Two nodes at x=10 and x=200 → group left = 10. After left-align both
    // sit at m02=10. Node at 0:1 is unchanged but still gets a patch
    // (before === after). Node at 0:2 moves from 200 → 10.
    await applyTool(
      fx.session,
      'align_nodes',
      { guids: ['0:1', '0:2'], axis: 'left' },
      journal,
    );
    const entry = journal.popStep('sid-test', 'undo');
    expect(entry?.label).toBe('AI: align left');
    expect(entry?.patches).toHaveLength(2);
    expect(entry?.patches.every((p) => p.field === 'transform.m02')).toBe(true);
    const byGuid = Object.fromEntries(entry!.patches.map((p) => [p.guid, p]));
    expect(byGuid['0:1']).toEqual({ guid: '0:1', field: 'transform.m02', before: 10, after: 10 });
    expect(byGuid['0:2']).toEqual({ guid: '0:2', field: 'transform.m02', before: 200, after: 10 });
  });

  it('align_nodes (top) records only m12 patches', async () => {
    await applyTool(
      fx.session,
      'align_nodes',
      { guids: ['0:1', '0:2'], axis: 'top' },
      journal,
    );
    const entry = journal.popStep('sid-test', 'undo');
    expect(entry?.patches.every((p) => p.field === 'transform.m12')).toBe(true);
  });

  it('align_nodes rejects fewer than 2 guids', async () => {
    await expect(
      applyTool(fx.session, 'align_nodes', { guids: ['0:1'], axis: 'left' }, journal),
    ).rejects.toThrow(/needs >= 2 guids/);
    expect(journal.depths('sid-test')).toEqual({ past: 0, future: 0 });
  });

  it('override_instance_text records the full symbolOverrides array (before vs. after)', async () => {
    await applyTool(
      fx.session,
      'override_instance_text',
      { instanceGuid: '0:3', masterTextGuid: '0:1', value: 'overridden!' },
      journal,
    );
    const entry = journal.popStep('sid-test', 'undo');
    expect(entry?.label).toBe('AI: override_instance_text');
    expect(entry?.patches).toHaveLength(1);
    const p = entry!.patches[0];
    expect(p.field).toBe('symbolData.symbolOverrides');
    expect(p.before).toEqual([]);
    expect(Array.isArray(p.after)).toBe(true);
    expect((p.after as Array<unknown>)).toHaveLength(1);
  });

  it('multiple chat tools accumulate as separate journal entries', async () => {
    await applyTool(fx.session, 'set_text', { guid: '0:1', value: 'A' }, journal);
    await applyTool(fx.session, 'set_text', { guid: '0:1', value: 'B' }, journal);
    await applyTool(fx.session, 'set_position', { guid: '0:1', x: 5, y: 5 }, journal);
    expect(journal.depths('sid-test')).toEqual({ past: 3, future: 0 });

    // Top of the past stack is the most recent edit.
    const last = journal.popStep('sid-test', 'undo');
    expect(last?.label).toBe('AI: set_position');
    const second = journal.popStep('sid-test', 'undo');
    expect(second?.label).toBe('AI: set_text');
    expect(second?.patches[0].before).toBe('A');
    expect(second?.patches[0].after).toBe('B');
  });

  it('throws on unknown tool name without recording anything', async () => {
    await expect(
      applyTool(fx.session, 'delete_universe', { guid: '0:1' }, journal),
    ).rejects.toThrow(/unknown tool/);
    expect(journal.depths('sid-test')).toEqual({ past: 0, future: 0 });
  });

  it('throws on missing guid without recording', async () => {
    await expect(
      applyTool(fx.session, 'set_text', { guid: '99:99', value: 'x' }, journal),
    ).rejects.toThrow(/not found/);
    expect(journal.depths('sid-test')).toEqual({ past: 0, future: 0 });
  });

  describe('duplicate', () => {
    it('appends a cloned node with a fresh GUID, offset by default 20px', async () => {
      const before = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const beforeCount = before.nodeChanges.length;

      await applyTool(fx.session, 'duplicate', { guid: '0:1' }, journal);

      const after = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      expect(after.nodeChanges).toHaveLength(beforeCount + 1);
      const cloned = after.nodeChanges[after.nodeChanges.length - 1] as {
        guid: { sessionID: number; localID: number };
        type: string;
        transform: { m02: number; m12: number };
        textData: { characters: string };
        parentIndex: { guid: { localID: number }; position: string };
      };
      expect(cloned.type).toBe('TEXT');
      // Fresh GUID — outside the 0..3 + 100 range used in the fixture.
      expect(cloned.guid.localID).toBeGreaterThan(100);
      expect(cloned.transform.m02).toBe(30); // 10 + 20
      expect(cloned.transform.m12).toBe(40); // 20 + 20
      expect(cloned.textData.characters).toBe('hello');
      // Same parent (CANVAS, localID 100) but a fresh sibling-position
      // string strictly greater than the original's.
      expect(cloned.parentIndex.guid.localID).toBe(100);
      expect(cloned.parentIndex.position > 'V').toBe(true);
    });

    it('respects custom dx/dy offsets', async () => {
      await applyTool(fx.session, 'duplicate', { guid: '0:2', dx: 5, dy: -10 }, journal);
      const after = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const cloned = after.nodeChanges[after.nodeChanges.length - 1] as {
        transform: { m02: number; m12: number };
      };
      expect(cloned.transform.m02).toBe(205); // 200 + 5
      expect(cloned.transform.m12).toBe(290); // 300 - 10
    });

    it('records a __msg__ sentinel patch with full nodeChanges before/after', async () => {
      await applyTool(fx.session, 'duplicate', { guid: '0:1' }, journal);
      const entry = journal.popStep('sid-test', 'undo');
      expect(entry?.label).toBe('AI: duplicate');
      expect(entry?.patches).toHaveLength(1);
      const p = entry!.patches[0];
      expect(p.guid).toBe('__msg__');
      expect(p.field).toBe('nodeChanges');
      expect(Array.isArray(p.before)).toBe(true);
      expect(Array.isArray(p.after)).toBe(true);
      // before has 5 (DOCUMENT, CANVAS, TEXT, RECT, INSTANCE), after has 6.
      expect((p.before as unknown[]).length).toBe(5);
      expect((p.after as unknown[]).length).toBe(6);
    });

    it('rebuilds documentJson so the new clone is reachable via the client tree', async () => {
      await applyTool(fx.session, 'duplicate', { guid: '0:1' }, journal);
      // The page now has 4 children (the 3 originals + 1 clone).
      const doc = fx.session.documentJson as { children: Array<{ children?: unknown[] }> };
      const canvas = doc.children[0];
      expect(canvas.children).toBeDefined();
      expect(canvas.children!.length).toBe(4);
    });

    it('throws on missing guid without recording or mutating disk', async () => {
      const beforeRaw = readFileSync(fx.messagePath, 'utf8');
      await expect(
        applyTool(fx.session, 'duplicate', { guid: '99:99' }, journal),
      ).rejects.toThrow(/not found/);
      expect(journal.depths('sid-test')).toEqual({ past: 0, future: 0 });
      expect(readFileSync(fx.messagePath, 'utf8')).toBe(beforeRaw);
    });

    it('clones an entire subtree — every descendant gets a fresh GUID with parentIndex re-pointed', async () => {
      // Add a child under 0:2 (RECT) so we have a 2-deep subtree to clone.
      const raw = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      raw.nodeChanges.push({
        guid: { sessionID: 0, localID: 50 },
        type: 'TEXT',
        textData: { characters: 'inside-rect' },
        transform: { m02: 0, m12: 0 },
        size: { x: 20, y: 10 },
        parentIndex: { guid: { sessionID: 0, localID: 2 }, position: 'V' },
      });
      writeFileSync(fx.messagePath, JSON.stringify(raw));
      // Reset documentJson so the next duplicate re-derives it cleanly.
      // (The fixture's hand-built tree didn't include the new descendant.)

      await applyTool(fx.session, 'duplicate', { guid: '0:2' }, journal);

      const after = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      // We started at 6 (after the manual push above), duplicated 2 nodes
      // (RECT + its TEXT child) → 8 total.
      expect(after.nodeChanges).toHaveLength(8);

      // The two new clones are at the end.
      const last2 = after.nodeChanges.slice(-2) as Array<{
        guid: { localID: number };
        parentIndex?: { guid?: { localID: number } };
        type: string;
      }>;
      const cloneIds = new Set(last2.map((n) => n.guid.localID));
      // The clone of 0:50 should have its parentIndex point at the new
      // RECT clone (not the original 0:2).
      const innerClone = last2.find((n) => n.type === 'TEXT')!;
      const rectClone = last2.find((n) => n.type === 'RECTANGLE')!;
      expect(innerClone.parentIndex?.guid?.localID).toBe(rectClone.guid.localID);
      expect(cloneIds.has(2)).toBe(false);
      expect(cloneIds.has(50)).toBe(false);
    });
  });

  describe('group', () => {
    it('wraps two siblings in a fresh GROUP at their bbox; members move to GROUP-local coords', async () => {
      // Members 0:1 (TEXT at 10,20 size 100x50) and 0:2 (RECT at 200,300
      // size 80x40). bbox = (10,20)..(280,340), so GROUP origin = (10,20),
      // size = (270, 320). Members translate to (0,0) and (190,280).
      await applyTool(
        fx.session,
        'group',
        { guids: ['0:1', '0:2'] },
        journal,
      );
      const after = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };

      // GROUP appended at the end.
      const groupNode = after.nodeChanges[after.nodeChanges.length - 1] as {
        guid: { localID: number };
        type: string;
        name: string;
        transform: { m02: number; m12: number };
        size: { x: number; y: number };
        fillPaints: unknown[];
        parentIndex: { guid: { localID: number }; position: string };
      };
      expect(groupNode.type).toBe('GROUP');
      expect(groupNode.name).toBe('Group');
      expect(groupNode.transform.m02).toBe(10);
      expect(groupNode.transform.m12).toBe(20);
      expect(groupNode.size).toEqual({ x: 270, y: 320 });
      expect(groupNode.fillPaints).toEqual([]);
      // GROUP parented to the CANVAS (localID 100), at position 'V'
      // (the lex-first member's position).
      expect(groupNode.parentIndex.guid.localID).toBe(100);
      expect(groupNode.parentIndex.position).toBe('V');

      // Members re-parented to GROUP and translated.
      const findByLocal = (id: number) => after.nodeChanges.find((n) => {
        const g = n.guid as { localID?: number } | undefined;
        return g?.localID === id;
      })!;
      const text = findByLocal(1) as { transform: { m02: number; m12: number }; parentIndex: { guid: { localID: number } } };
      expect(text.transform.m02).toBe(0);
      expect(text.transform.m12).toBe(0);
      expect(text.parentIndex.guid.localID).toBe(groupNode.guid.localID);

      const rect = findByLocal(2) as { transform: { m02: number; m12: number }; parentIndex: { guid: { localID: number } } };
      expect(rect.transform.m02).toBe(190); // 200 - 10
      expect(rect.transform.m12).toBe(280); // 300 - 20
      expect(rect.parentIndex.guid.localID).toBe(groupNode.guid.localID);
    });

    it('records a __msg__ sentinel patch labelled "AI: group"', async () => {
      await applyTool(fx.session, 'group', { guids: ['0:1', '0:2'] }, journal);
      const entry = journal.popStep('sid-test', 'undo');
      expect(entry?.label).toBe('AI: group');
      expect(entry?.patches).toHaveLength(1);
      expect(entry!.patches[0].guid).toBe('__msg__');
      expect(entry!.patches[0].field).toBe('nodeChanges');
    });

    it('respects a custom name', async () => {
      await applyTool(
        fx.session,
        'group',
        { guids: ['0:1', '0:2'], name: 'Header bar' },
        journal,
      );
      const after = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const last = after.nodeChanges[after.nodeChanges.length - 1] as { name: string };
      expect(last.name).toBe('Header bar');
    });

    it('rejects fewer than 2 guids', async () => {
      await expect(
        applyTool(fx.session, 'group', { guids: ['0:1'] }, journal),
      ).rejects.toThrow(/needs >= 2 guids/);
      expect(journal.depths('sid-test')).toEqual({ past: 0, future: 0 });
    });

    it('rejects guids that do not share a parent', async () => {
      // Re-parent 0:2 onto a different node (the INSTANCE 0:3) before calling
      // group. The fixture's 0:1 stays under CANVAS so they no longer share.
      const raw = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const rect = raw.nodeChanges.find((n) => {
        const g = n.guid as { localID?: number } | undefined;
        return g?.localID === 2;
      })! as { parentIndex: { guid: { sessionID: number; localID: number }; position: string } };
      rect.parentIndex.guid = { sessionID: 0, localID: 3 };
      writeFileSync(fx.messagePath, JSON.stringify(raw));

      await expect(
        applyTool(fx.session, 'group', { guids: ['0:1', '0:2'] }, journal),
      ).rejects.toThrow(/must share a parent/);
      expect(journal.depths('sid-test')).toEqual({ past: 0, future: 0 });
    });

    it('rebuilds documentJson so the new GROUP is reachable in the client tree', async () => {
      await applyTool(fx.session, 'group', { guids: ['0:1', '0:2'] }, journal);
      const doc = fx.session.documentJson as { children: Array<{ children?: Array<{ type: string }> }> };
      const canvas = doc.children[0];
      // Originally CANVAS had 3 children (TEXT, RECT, INSTANCE). After group:
      // GROUP + INSTANCE (TEXT and RECT moved into GROUP). So 2 direct
      // children, with the GROUP containing the 2 originals.
      expect(canvas.children).toHaveLength(2);
      const types = new Set(canvas.children!.map((c) => c.type));
      expect(types.has('GROUP')).toBe(true);
      expect(types.has('INSTANCE')).toBe(true);
    });
  });

  describe('ungroup', () => {
    it('round-trips group → ungroup back to original transforms / parentage', async () => {
      // Snapshot the pre-group state of the two members.
      const pre = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const findById = (
        arr: Array<Record<string, unknown>>,
        local: number,
      ) => arr.find((n) => (n.guid as { localID?: number } | undefined)?.localID === local)!;
      const preText = findById(pre.nodeChanges, 1) as {
        transform: { m02: number; m12: number };
        parentIndex: { guid: { localID: number } };
      };
      const preRect = findById(pre.nodeChanges, 2) as {
        transform: { m02: number; m12: number };
        parentIndex: { guid: { localID: number } };
      };

      await applyTool(fx.session, 'group', { guids: ['0:1', '0:2'] }, journal);
      const mid = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const groupNode = mid.nodeChanges[mid.nodeChanges.length - 1] as {
        guid: { sessionID: number; localID: number };
      };
      const groupGuid = `${groupNode.guid.sessionID}:${groupNode.guid.localID}`;

      await applyTool(fx.session, 'ungroup', { guid: groupGuid }, journal);
      const after = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };

      // GROUP gone — original 5 nodes again.
      expect(after.nodeChanges).toHaveLength(5);
      const postText = findById(after.nodeChanges, 1) as {
        transform: { m02: number; m12: number };
        parentIndex: { guid: { localID: number } };
      };
      const postRect = findById(after.nodeChanges, 2) as {
        transform: { m02: number; m12: number };
        parentIndex: { guid: { localID: number } };
      };
      // Transforms restored exactly (no float noise — both translations are
      // by integer offsets in this fixture).
      expect(postText.transform.m02).toBe(preText.transform.m02);
      expect(postText.transform.m12).toBe(preText.transform.m12);
      expect(postRect.transform.m02).toBe(preRect.transform.m02);
      expect(postRect.transform.m12).toBe(preRect.transform.m12);
      // Re-parented to CANVAS (localID 100).
      expect(postText.parentIndex.guid.localID).toBe(100);
      expect(postRect.parentIndex.guid.localID).toBe(100);
    });

    it('records a __msg__ sentinel patch labelled "AI: ungroup"', async () => {
      await applyTool(fx.session, 'group', { guids: ['0:1', '0:2'] }, journal);
      const mid = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const groupNode = mid.nodeChanges[mid.nodeChanges.length - 1] as {
        guid: { sessionID: number; localID: number };
      };
      const groupGuid = `${groupNode.guid.sessionID}:${groupNode.guid.localID}`;

      await applyTool(fx.session, 'ungroup', { guid: groupGuid }, journal);
      // Most recent journal entry is the ungroup.
      const entry = journal.popStep('sid-test', 'undo');
      expect(entry?.label).toBe('AI: ungroup');
      expect(entry?.patches[0].guid).toBe('__msg__');
    });

    it('rejects targets that are not GROUP', async () => {
      // 0:1 is a TEXT node, not a GROUP.
      await expect(
        applyTool(fx.session, 'ungroup', { guid: '0:1' }, journal),
      ).rejects.toThrow(/not a GROUP/);
      expect(journal.depths('sid-test')).toEqual({ past: 0, future: 0 });
    });

    it('promotes children in lex order with new positions strictly between groupPos and nextSibling', async () => {
      // Group 0:1 + 0:2; the GROUP sits at position 'V', INSTANCE at 'Z'.
      // After ungroup, both children should land in (V, Z).
      await applyTool(fx.session, 'group', { guids: ['0:1', '0:2'] }, journal);
      const mid = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const groupNode = mid.nodeChanges[mid.nodeChanges.length - 1] as {
        guid: { sessionID: number; localID: number };
      };
      const groupGuid = `${groupNode.guid.sessionID}:${groupNode.guid.localID}`;
      await applyTool(fx.session, 'ungroup', { guid: groupGuid }, journal);

      const after = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const findByLocal = (id: number) => after.nodeChanges.find((n) => {
        const g = n.guid as { localID?: number } | undefined;
        return g?.localID === id;
      })!;
      const text = findByLocal(1) as { parentIndex: { position: string } };
      const rect = findByLocal(2) as { parentIndex: { position: string } };
      expect(text.parentIndex.position > 'V').toBe(true);
      expect(text.parentIndex.position < 'Z').toBe(true);
      expect(rect.parentIndex.position > text.parentIndex.position).toBe(true);
      expect(rect.parentIndex.position < 'Z').toBe(true);
    });
  });

  // Spec §8 calls nesting "허용 (제약 없음)" — group of GROUPs works because
  // every member type is treated identically by the bbox math and re-parent
  // logic. These tests pin that down so a future refactor can't accidentally
  // reject GROUP members.
  describe('group — nested (group of groups)', () => {
    it('groups two existing GROUPs into a new GROUP — children re-parented, bbox spans both', async () => {
      // Give INSTANCE a transform/size so the outer bbox is meaningful.
      const raw = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const inst = raw.nodeChanges.find(
        (n) => (n.guid as { localID?: number } | undefined)?.localID === 3,
      )! as Record<string, unknown>;
      inst.transform = { m02: 500, m12: 600 };
      inst.size = { x: 50, y: 50 };
      writeFileSync(fx.messagePath, JSON.stringify(raw));

      // G1 := group(TEXT, RECT). Origin (10,20), size (270,320) — same math
      // as the leaf-level group test above.
      await applyTool(fx.session, 'group', { guids: ['0:1', '0:2'], name: 'G1' }, journal);
      const mid = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const g1 = mid.nodeChanges[mid.nodeChanges.length - 1] as {
        guid: { sessionID: number; localID: number };
      };
      const g1Guid = `${g1.guid.sessionID}:${g1.guid.localID}`;

      // G2 := group(G1, INSTANCE). G1 has transform (10,20) size (270,320);
      // INSTANCE at (500,600) size (50,50). Combined bbox = (10,20)..(550,650),
      // so G2 origin = (10,20), size = (540,630).
      await applyTool(fx.session, 'group', { guids: [g1Guid, '0:3'], name: 'G2' }, journal);

      const after = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const g2 = after.nodeChanges[after.nodeChanges.length - 1] as {
        type: string;
        guid: { localID: number };
        transform: { m02: number; m12: number };
        size: { x: number; y: number };
      };
      expect(g2.type).toBe('GROUP');
      expect(g2.transform.m02).toBe(10);
      expect(g2.transform.m12).toBe(20);
      expect(g2.size).toEqual({ x: 540, y: 630 });

      const findByLocal = (id: number) => after.nodeChanges.find(
        (n) => (n.guid as { localID?: number } | undefined)?.localID === id,
      )!;

      // Both members re-parented to G2 and translated to G2-local coords.
      const g1After = findByLocal(g1.guid.localID) as {
        parentIndex: { guid: { localID: number } };
        transform: { m02: number; m12: number };
      };
      const instAfter = findByLocal(3) as {
        parentIndex: { guid: { localID: number } };
        transform: { m02: number; m12: number };
      };
      expect(g1After.parentIndex.guid.localID).toBe(g2.guid.localID);
      expect(instAfter.parentIndex.guid.localID).toBe(g2.guid.localID);
      expect(g1After.transform.m02).toBe(0);    // 10 - 10
      expect(g1After.transform.m12).toBe(0);    // 20 - 20
      expect(instAfter.transform.m02).toBe(490); // 500 - 10
      expect(instAfter.transform.m12).toBe(580); // 600 - 20

      // I-G8: TEXT/RECT inside G1 are untouched — the second group only
      // affects its direct members (G1 and INSTANCE), not their descendants.
      const text = findByLocal(1) as {
        parentIndex: { guid: { localID: number } };
        transform: { m02: number; m12: number };
      };
      const rect = findByLocal(2) as {
        parentIndex: { guid: { localID: number } };
        transform: { m02: number; m12: number };
      };
      expect(text.parentIndex.guid.localID).toBe(g1.guid.localID);
      expect(rect.parentIndex.guid.localID).toBe(g1.guid.localID);
      // TEXT/RECT transforms are still G1-local, NOT G2-local.
      expect(text.transform.m02).toBe(0);
      expect(text.transform.m12).toBe(0);
      expect(rect.transform.m02).toBe(190);
      expect(rect.transform.m12).toBe(280);
    });

    it('ungroup of an outer GROUP only dissolves one level — inner GROUP survives', async () => {
      // Spec §8: "ungroup 은 한 단계만 — 재귀 ungroup 은 사용자가 반복 호출."
      const raw = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const inst = raw.nodeChanges.find(
        (n) => (n.guid as { localID?: number } | undefined)?.localID === 3,
      )! as Record<string, unknown>;
      inst.transform = { m02: 500, m12: 600 };
      inst.size = { x: 50, y: 50 };
      writeFileSync(fx.messagePath, JSON.stringify(raw));

      await applyTool(fx.session, 'group', { guids: ['0:1', '0:2'] }, journal);
      let mid = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const g1 = mid.nodeChanges[mid.nodeChanges.length - 1] as {
        guid: { sessionID: number; localID: number };
      };
      const g1Guid = `${g1.guid.sessionID}:${g1.guid.localID}`;

      await applyTool(fx.session, 'group', { guids: [g1Guid, '0:3'] }, journal);
      mid = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const g2 = mid.nodeChanges[mid.nodeChanges.length - 1] as {
        guid: { sessionID: number; localID: number };
      };
      const g2Guid = `${g2.guid.sessionID}:${g2.guid.localID}`;

      // Ungroup the OUTER group only.
      await applyTool(fx.session, 'ungroup', { guid: g2Guid }, journal);

      const after = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      // 5 originals + G1 (G2 dissolved) = 6 total.
      expect(after.nodeChanges).toHaveLength(6);
      const findByLocal = (id: number) => after.nodeChanges.find(
        (n) => (n.guid as { localID?: number } | undefined)?.localID === id,
      );
      expect(findByLocal(g2.guid.localID)).toBeUndefined();
      expect(findByLocal(g1.guid.localID)).toBeDefined();

      // G1 promoted up to CANVAS, transform restored from G2-local back to
      // grandparent (CANVAS) coords: (0,0) + (10,20) = (10,20).
      const g1After = findByLocal(g1.guid.localID) as {
        parentIndex: { guid: { localID: number } };
        transform: { m02: number; m12: number };
      };
      expect(g1After.parentIndex.guid.localID).toBe(100);
      expect(g1After.transform.m02).toBe(10);
      expect(g1After.transform.m12).toBe(20);

      // INSTANCE also promoted — restored to its pre-outer-group position.
      const instAfter = findByLocal(3) as {
        parentIndex: { guid: { localID: number } };
        transform: { m02: number; m12: number };
      };
      expect(instAfter.parentIndex.guid.localID).toBe(100);
      expect(instAfter.transform.m02).toBe(500);
      expect(instAfter.transform.m12).toBe(600);

      // I-U4: inner GROUP's children are untouched. TEXT/RECT remain inside G1.
      const text = findByLocal(1) as { parentIndex: { guid: { localID: number } } };
      const rect = findByLocal(2) as { parentIndex: { guid: { localID: number } } };
      expect(text.parentIndex.guid.localID).toBe(g1.guid.localID);
      expect(rect.parentIndex.guid.localID).toBe(g1.guid.localID);
    });
  });

  // Spec §8 lists "비대상" (out-of-scope) cases for the v1 group tool —
  // multi-parent (rejected, already covered above), rotated members
  // (accepted, AABB instead of OBB), nested GROUPs (allowed, covered above),
  // and BOOLEAN_OPERATION (only GROUP is emitted). The behaviors below have
  // no runtime guard today; these tests pin them so a regression is caught.
  describe('group — spec §8 non-target items (current behavior is documented)', () => {
    it('accepts rotated members but computes GROUP size as AABB (rotation channels ignored)', async () => {
      const raw = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const text = raw.nodeChanges.find(
        (n) => (n.guid as { localID?: number } | undefined)?.localID === 1,
      )! as { transform: Record<string, number> };
      // 45° rotation around the node's origin, keeping (m02, m12) at (10, 20).
      const c = Math.cos(Math.PI / 4);
      const s = Math.sin(Math.PI / 4);
      text.transform = { m00: c, m01: -s, m02: 10, m10: s, m11: c, m12: 20 };
      writeFileSync(fx.messagePath, JSON.stringify(raw));

      await applyTool(fx.session, 'group', { guids: ['0:1', '0:2'] }, journal);
      const after = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };

      // GROUP origin/size match the unrotated case — confirms the bbox math
      // reads only (m02, m12, size.x, size.y). If OBB support ever lands,
      // this expectation flips to the corrected envelope.
      const groupNode = after.nodeChanges[after.nodeChanges.length - 1] as {
        type: string;
        transform: { m02: number; m12: number };
        size: { x: number; y: number };
      };
      expect(groupNode.type).toBe('GROUP');
      expect(groupNode.transform.m02).toBe(10);
      expect(groupNode.transform.m12).toBe(20);
      expect(groupNode.size).toEqual({ x: 270, y: 320 });

      // I-G7: rotation channels of the member survive untouched; only m02/m12
      // are translated into GROUP-local coords.
      const textAfter = after.nodeChanges.find(
        (n) => (n.guid as { localID?: number } | undefined)?.localID === 1,
      )! as { transform: Record<string, number> };
      expect(textAfter.transform.m00).toBeCloseTo(c);
      expect(textAfter.transform.m01).toBeCloseTo(-s);
      expect(textAfter.transform.m10).toBeCloseTo(s);
      expect(textAfter.transform.m11).toBeCloseTo(c);
      expect(textAfter.transform.m02).toBe(0);
      expect(textAfter.transform.m12).toBe(0);
    });

    it('emits type: "GROUP" only — never "BOOLEAN_OPERATION" (vector boolean is a separate tool)', async () => {
      await applyTool(fx.session, 'group', { guids: ['0:1', '0:2'] }, journal);
      const after = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const last = after.nodeChanges[after.nodeChanges.length - 1] as { type: string };
      expect(last.type).toBe('GROUP');
    });
  });

  // Each structural tool emits a __msg__ sentinel patch carrying the full
  // pre/post nodeChanges array. Looping apply N times then undo N times must
  // bring message.json back byte-for-byte — the only proof that every entry
  // captures a complete, replayable snapshot (no subtle aliasing through the
  // live nodeChanges array between successive operations).
  describe('cumulative undo stress (apply ×N → undo ×N restores baseline byte-for-byte)', () => {
    it('duplicate ×10 → undo ×10 reverts message.json bytes to baseline', async () => {
      const baseline = readFileSync(fx.messagePath, 'utf8');
      for (let i = 0; i < 10; i++) {
        await applyTool(fx.session, 'duplicate', { guid: '0:1' }, journal);
      }
      expect(journal.depths('sid-test').past).toBe(10);

      const history = new History(
        buildDiskStore(fx) as unknown as ConstructorParameters<typeof History>[0],
        journal,
      );
      for (let i = 0; i < 10; i++) {
        const r = await history.execute({ sessionId: 'sid-test', direction: 'undo' });
        expect(r.ok).toBe(true);
      }
      expect(journal.depths('sid-test').past).toBe(0);
      expect(readFileSync(fx.messagePath, 'utf8')).toBe(baseline);
    });

    it('group ×10 (nested) → undo ×10 reverts message.json bytes to baseline', async () => {
      const baseline = readFileSync(fx.messagePath, 'utf8');
      // After iter 1, 0:1 and 0:2 share parent G1; iter 2 nests them in G2
      // inside G1; iter k yields k nested GROUPs around the same two leaves.
      for (let i = 0; i < 10; i++) {
        await applyTool(fx.session, 'group', { guids: ['0:1', '0:2'] }, journal);
      }
      expect(journal.depths('sid-test').past).toBe(10);

      const history = new History(
        buildDiskStore(fx) as unknown as ConstructorParameters<typeof History>[0],
        journal,
      );
      for (let i = 0; i < 10; i++) {
        const r = await history.execute({ sessionId: 'sid-test', direction: 'undo' });
        expect(r.ok).toBe(true);
      }
      expect(journal.depths('sid-test').past).toBe(0);
      expect(readFileSync(fx.messagePath, 'utf8')).toBe(baseline);
    });

    it('(group → ungroup) ×10 → undo ×20 reverts message.json bytes to baseline', async () => {
      // Round-trip pairs aren't byte-idempotent (ungroup re-ladders position
      // strings via between() — see spec §5), but every individual entry's
      // before/after pair IS exact, so unwinding the journal must still land
      // on the literal baseline bytes.
      const baseline = readFileSync(fx.messagePath, 'utf8');
      for (let i = 0; i < 10; i++) {
        await applyTool(fx.session, 'group', { guids: ['0:1', '0:2'] }, journal);
        const mid = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
          nodeChanges: Array<{ guid: { sessionID: number; localID: number } }>;
        };
        const g = mid.nodeChanges[mid.nodeChanges.length - 1];
        const gGuid = `${g.guid.sessionID}:${g.guid.localID}`;
        await applyTool(fx.session, 'ungroup', { guid: gGuid }, journal);
      }
      expect(journal.depths('sid-test').past).toBe(20);

      const history = new History(
        buildDiskStore(fx) as unknown as ConstructorParameters<typeof History>[0],
        journal,
      );
      for (let i = 0; i < 20; i++) {
        const r = await history.execute({ sessionId: 'sid-test', direction: 'undo' });
        expect(r.ok).toBe(true);
      }
      expect(journal.depths('sid-test').past).toBe(0);
      expect(readFileSync(fx.messagePath, 'utf8')).toBe(baseline);
    });
  });

  // The structural tools (duplicate / group / ungroup) rebuild documentJson
  // wholesale via rebuildDocumentFromMessage, while the leaf tools mutate
  // documentJson in place via mirrorClient. When the two are interleaved,
  // the risk is subtle: a leaf undo running after a structural undo reads a
  // freshly-rebuilt documentJson and must still find its target node; a leaf
  // undo running BEFORE a structural undo must mutate a node that the
  // structural undo will then erase. These tests pin both directions.
  describe('mixed leaf + structural undo interleaving', () => {
    it('undo of [set_text, then duplicate] reverts in order — clone removed first, then text restored', async () => {
      await applyTool(fx.session, 'set_text', { guid: '0:1', value: 'A' }, journal);
      await applyTool(fx.session, 'duplicate', { guid: '0:1' }, journal);

      // After both: 6 nodes; both master and clone carry the leaf-edited 'A'.
      let snap = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      expect(snap.nodeChanges).toHaveLength(6);
      const cloneAfterB = snap.nodeChanges[snap.nodeChanges.length - 1] as {
        textData: { characters: string };
      };
      expect(cloneAfterB.textData.characters).toBe('A');

      const history = new History(
        buildDiskStore(fx) as unknown as ConstructorParameters<typeof History>[0],
        journal,
      );

      // Undo B (structural): clone gone; master still 'A'.
      await history.execute({ sessionId: 'sid-test', direction: 'undo' });
      snap = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      expect(snap.nodeChanges).toHaveLength(5);
      const masterAfterUndoB = snap.nodeChanges.find(
        (n) => (n.guid as { localID?: number } | undefined)?.localID === 1,
      ) as { textData: { characters: string } };
      expect(masterAfterUndoB.textData.characters).toBe('A');

      // Undo A (leaf, after a structural undo just rebuilt documentJson):
      // master back to 'hello'; documentJson mirror also reverts.
      await history.execute({ sessionId: 'sid-test', direction: 'undo' });
      snap = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const masterAfterUndoA = snap.nodeChanges.find(
        (n) => (n.guid as { localID?: number } | undefined)?.localID === 1,
      ) as { textData: { characters: string } };
      expect(masterAfterUndoA.textData.characters).toBe('hello');
      const docCanvas = (fx.session.documentJson as {
        children: Array<{ children?: Array<{ guid: { localID: number }; textData?: { characters: string } }> }>;
      }).children[0];
      const docText = docCanvas.children!.find((c) => c.guid.localID === 1);
      expect(docText?.textData?.characters).toBe('hello');
    });

    it('leaf-edits a clone (created by duplicate), then undoes both — clone fully removed', async () => {
      // Tests that a leaf op targeting a guid that ONLY EXISTS because of an
      // earlier structural op survives undo: the leaf's findNode must hit
      // the clone (still in msg), and the structural undo must then remove
      // the clone entirely.
      await applyTool(fx.session, 'duplicate', { guid: '0:1' }, journal);
      const mid = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const clone = mid.nodeChanges[mid.nodeChanges.length - 1] as {
        guid: { sessionID: number; localID: number };
      };
      const cloneGuid = `${clone.guid.sessionID}:${clone.guid.localID}`;

      await applyTool(
        fx.session,
        'set_text',
        { guid: cloneGuid, value: 'CLONE_EDITED' },
        journal,
      );
      let snap = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const cloneAfterB = snap.nodeChanges.find(
        (n) => (n.guid as { localID?: number } | undefined)?.localID === clone.guid.localID,
      ) as { textData: { characters: string } };
      expect(cloneAfterB.textData.characters).toBe('CLONE_EDITED');

      const history = new History(
        buildDiskStore(fx) as unknown as ConstructorParameters<typeof History>[0],
        journal,
      );

      // Undo B (leaf on clone): clone's text reverts to the source's value.
      await history.execute({ sessionId: 'sid-test', direction: 'undo' });
      snap = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      const cloneAfterUndoB = snap.nodeChanges.find(
        (n) => (n.guid as { localID?: number } | undefined)?.localID === clone.guid.localID,
      ) as { textData: { characters: string } };
      expect(cloneAfterUndoB.textData.characters).toBe('hello');

      // Undo A (structural duplicate): clone disappears entirely.
      await history.execute({ sessionId: 'sid-test', direction: 'undo' });
      snap = JSON.parse(readFileSync(fx.messagePath, 'utf8')) as {
        nodeChanges: Array<Record<string, unknown>>;
      };
      expect(snap.nodeChanges).toHaveLength(5);
      expect(
        snap.nodeChanges.find(
          (n) => (n.guid as { localID?: number } | undefined)?.localID === clone.guid.localID,
        ),
      ).toBeUndefined();
    });

    it('5-step interleave [leaf, structural, leaf, structural, leaf] — undo×5 → baseline, redo×5 → final state', async () => {
      // Worst-case alternation: each leaf op runs against a node whose parent
      // linkage has been changing under it (B duplicates 0:1, D moves 0:1
      // into a fresh GROUP), and every undo crosses a structural↔leaf
      // boundary. Byte-equality on both ends is the strong proof.
      const baseline = readFileSync(fx.messagePath, 'utf8');

      await applyTool(fx.session, 'set_text', { guid: '0:1', value: 'A' }, journal);
      await applyTool(fx.session, 'duplicate', { guid: '0:1' }, journal);
      await applyTool(fx.session, 'set_position', { guid: '0:1', x: 5, y: 5 }, journal);
      await applyTool(fx.session, 'group', { guids: ['0:1', '0:2'] }, journal);
      await applyTool(fx.session, 'set_text', { guid: '0:1', value: 'FINAL' }, journal);

      const stateE = readFileSync(fx.messagePath, 'utf8');
      expect(journal.depths('sid-test').past).toBe(5);

      const history = new History(
        buildDiskStore(fx) as unknown as ConstructorParameters<typeof History>[0],
        journal,
      );
      for (let i = 0; i < 5; i++) {
        const r = await history.execute({ sessionId: 'sid-test', direction: 'undo' });
        expect(r.ok).toBe(true);
      }
      expect(readFileSync(fx.messagePath, 'utf8')).toBe(baseline);
      expect(journal.depths('sid-test')).toEqual({ past: 0, future: 5 });

      // Use the same History instance for the redo half.
      for (let i = 0; i < 5; i++) {
        const r = await history.execute({ sessionId: 'sid-test', direction: 'redo' });
        expect(r.ok).toBe(true);
      }
      expect(readFileSync(fx.messagePath, 'utf8')).toBe(stateE);
      expect(journal.depths('sid-test')).toEqual({ past: 5, future: 0 });
    });
  });
});
