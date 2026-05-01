import { describe, expect, it } from 'vitest';
import { EditNode } from './EditNode.js';
import { ResizeNode } from './ResizeNode.js';
import { OverrideInstanceText } from './OverrideInstanceText.js';
import { Undo } from './Undo.js';
import { Redo } from './Redo.js';
import { FakeSessionStore } from './testing/fakeSessionStore.js';
import { InMemoryEditJournal } from '../../server/adapters/driven/InMemoryEditJournal.js';

function seed() {
  const store = new FakeSessionStore();
  const message = {
    nodeChanges: [
      {
        guid: { sessionID: 0, localID: 1 },
        type: 'TEXT',
        textData: { characters: 'INITIAL' },
      },
      {
        guid: { sessionID: 0, localID: 2 },
        type: 'FRAME',
        transform: { m02: 100, m12: 50 },
        size: { x: 200, y: 80 },
      },
      {
        guid: { sessionID: 0, localID: 3 },
        type: 'INSTANCE',
        symbolData: { symbolOverrides: [] },
      },
    ],
  };
  store.seed(
    {
      id: 'sid',
      dir: '/tmp/x',
      origName: 'x.fig',
      archiveVersion: 106,
      documentJson: {
        id: '0:0',
        guid: { sessionID: 0, localID: 0 },
        type: 'DOCUMENT',
        children: [
          { id: '0:1', guid: { sessionID: 0, localID: 1 }, type: 'TEXT', textData: { characters: 'INITIAL' } },
          { id: '0:2', guid: { sessionID: 0, localID: 2 }, type: 'FRAME', transform: { m02: 100, m12: 50 }, size: { x: 200, y: 80 } },
          { id: '0:3', guid: { sessionID: 0, localID: 3 }, type: 'INSTANCE' },
        ],
      },
    },
    JSON.stringify(message),
  );
  return store;
}

describe('Undo / Redo', () => {
  it('round-trips a text edit through undo → redo', async () => {
    const store = seed();
    const journal = new InMemoryEditJournal();
    const editNode = new EditNode(store, journal);
    const undo = new Undo(store, journal);
    const redo = new Redo(store, journal);

    await editNode.execute({
      sessionId: 'sid', nodeGuid: '0:1', field: 'textData.characters', value: 'EDITED',
    });
    expect(JSON.parse(store.readMessage('sid')).nodeChanges[0].textData.characters).toBe('EDITED');

    const u = await undo.execute({ sessionId: 'sid' });
    expect(u.ok).toBe(true);
    expect(u.undoneLabel).toBe('Edit');
    expect(JSON.parse(store.readMessage('sid')).nodeChanges[0].textData.characters).toBe('INITIAL');

    const r = await redo.execute({ sessionId: 'sid' });
    expect(r.ok).toBe(true);
    expect(r.redoneLabel).toBe('Edit');
    expect(JSON.parse(store.readMessage('sid')).nodeChanges[0].textData.characters).toBe('EDITED');
  });

  // ResizeNode writes 4 fields atomically; one undo restores all of them.
  it('undo of a resize restores all four fields in one shot', async () => {
    const store = seed();
    const journal = new InMemoryEditJournal();
    const resize = new ResizeNode(store, journal);
    const undo = new Undo(store, journal);

    await resize.execute({
      sessionId: 'sid', guid: '0:2', x: 999, y: 888, w: 777, h: 666,
    });
    let node = JSON.parse(store.readMessage('sid')).nodeChanges[1];
    expect(node.transform.m02).toBe(999);
    expect(node.size).toEqual({ x: 777, y: 666 });

    await undo.execute({ sessionId: 'sid' });
    node = JSON.parse(store.readMessage('sid')).nodeChanges[1];
    expect(node.transform.m02).toBe(100);
    expect(node.transform.m12).toBe(50);
    expect(node.size).toEqual({ x: 200, y: 80 });
  });

  it('a fresh edit clears the redo stack', async () => {
    const store = seed();
    const journal = new InMemoryEditJournal();
    const editNode = new EditNode(store, journal);
    const undo = new Undo(store, journal);
    const redo = new Redo(store, journal);

    await editNode.execute({
      sessionId: 'sid', nodeGuid: '0:1', field: 'textData.characters', value: 'first',
    });
    await undo.execute({ sessionId: 'sid' });
    expect(journal.depths('sid')).toEqual({ past: 0, future: 1 });

    // New edit while there's redo history → future stack must clear.
    await editNode.execute({
      sessionId: 'sid', nodeGuid: '0:1', field: 'textData.characters', value: 'second',
    });
    expect(journal.depths('sid')).toEqual({ past: 1, future: 0 });

    // Redo now does nothing.
    const r = await redo.execute({ sessionId: 'sid' });
    expect(r.ok).toBe(false);
    expect(r.redoneLabel).toBeNull();
  });

  it('undo on an empty stack returns ok=false without touching the doc', async () => {
    const store = seed();
    const journal = new InMemoryEditJournal();
    const undo = new Undo(store, journal);
    const before = store.readMessage('sid');
    const r = await undo.execute({ sessionId: 'sid' });
    expect(r.ok).toBe(false);
    expect(store.readMessage('sid')).toBe(before);
  });

  it('undo of an instance text override restores the symbolOverrides array', async () => {
    const store = seed();
    const journal = new InMemoryEditJournal();
    const override = new OverrideInstanceText(store, journal);
    const undo = new Undo(store, journal);

    await override.execute({
      sessionId: 'sid', instanceGuid: '0:3', masterTextGuid: '0:1', value: 'PER_INSTANCE',
    });
    let inst = JSON.parse(store.readMessage('sid')).nodeChanges[2];
    expect(inst.symbolData.symbolOverrides).toHaveLength(1);

    await undo.execute({ sessionId: 'sid' });
    inst = JSON.parse(store.readMessage('sid')).nodeChanges[2];
    expect(inst.symbolData.symbolOverrides).toEqual([]);
  });
});
