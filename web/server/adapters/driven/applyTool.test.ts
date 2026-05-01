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

  const msg = {
    nodeChanges: [
      {
        guid: { sessionID: 0, localID: 1 },
        type: 'TEXT',
        textData: { characters: 'hello' },
        transform: { m02: 10, m12: 20 },
        size: { x: 100, y: 50 },
        cornerRadius: 0,
        fillPaints: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 0, b: 0, a: 1 } }],
      },
      {
        guid: { sessionID: 0, localID: 2 },
        type: 'RECTANGLE',
        transform: { m02: 200, m12: 300 },
        size: { x: 80, y: 40 },
        cornerRadius: 4,
        fillPaints: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0, g: 0, b: 1, a: 1 } }],
      },
      {
        guid: { sessionID: 0, localID: 3 },
        type: 'INSTANCE',
        symbolData: { symbolOverrides: [] },
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
    expect((disk.nodeChanges[0] as { textData: { characters: string } }).textData.characters).toBe('world');
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
});
