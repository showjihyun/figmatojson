import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyTool } from './applyTool.js';
import { InMemoryEditJournal } from './InMemoryEditJournal.js';
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
    const entry = journal.popUndo('sid-test');
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
    const entry = journal.popUndo('sid-test');
    expect(entry?.label).toBe('AI: set_position');
    expect(entry?.patches).toEqual([
      { guid: '0:1', field: 'transform.m02', before: 10, after: 99 },
      { guid: '0:1', field: 'transform.m12', before: 20, after: 77 },
    ]);
  });

  it('set_size clamps to >= 1 and records both dimensions', async () => {
    await applyTool(fx.session, 'set_size', { guid: '0:1', w: 0, h: 250 }, journal);
    const entry = journal.popUndo('sid-test');
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
    const entry = journal.popUndo('sid-test');
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
    const entry = journal.popUndo('sid-test');
    expect(entry?.label).toBe('AI: set_corner_radius');
    expect(entry?.patches).toEqual([
      { guid: '0:2', field: 'cornerRadius', before: 4, after: 12 },
    ]);
  });

  it('set_corner_radius clamps negatives to 0', async () => {
    await applyTool(fx.session, 'set_corner_radius', { guid: '0:2', value: -5 }, journal);
    const entry = journal.popUndo('sid-test');
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
    const entry = journal.popUndo('sid-test');
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
    const entry = journal.popUndo('sid-test');
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
    const entry = journal.popUndo('sid-test');
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
    const last = journal.popUndo('sid-test');
    expect(last?.label).toBe('AI: set_position');
    const second = journal.popUndo('sid-test');
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
      const entry = journal.popUndo('sid-test');
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
      const entry = journal.popUndo('sid-test');
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
      const entry = journal.popUndo('sid-test');
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
});
