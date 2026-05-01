// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditNode } from './EditNode.js';
import { NotFoundError, ValidationError } from './errors.js';
import { FakeSessionStore } from './testing/fakeSessionStore.js';

function seed() {
  const store = new FakeSessionStore();
  const message = {
    nodeChanges: [
      { guid: { sessionID: 0, localID: 1 }, type: 'TEXT', textData: { characters: 'hi' } },
      {
        guid: { sessionID: 0, localID: 2 },
        type: 'INSTANCE',
        _componentTexts: [{ guid: '0:1', name: 'label', path: '', characters: 'hi' }],
      },
    ],
  };
  store.seed(
    {
      id: 'sid',
      dir: '/tmp/fake',
      origName: 'x.fig',
      archiveVersion: 106,
      documentJson: {
        id: '0:0',
        guid: { sessionID: 0, localID: 0 },
        type: 'DOCUMENT',
        children: [
          { id: '0:1', guid: { sessionID: 0, localID: 1 }, type: 'TEXT', textData: { characters: 'hi' } },
          {
            id: '0:2',
            guid: { sessionID: 0, localID: 2 },
            type: 'INSTANCE',
            _componentTexts: [{ guid: '0:1', name: 'label', path: '', characters: 'hi' }],
          },
        ],
      },
    },
    JSON.stringify(message),
  );
  return store;
}

describe('EditNode', () => {
  it('writes the patch to message.json AND mirrors onto documentJson', async () => {
    const store = seed();
    const useCase = new EditNode(store);
    const result = await useCase.execute({
      sessionId: 'sid',
      nodeGuid: '0:1',
      field: 'textData.characters',
      value: 'hello',
    });
    expect(result).toEqual({ ok: true });

    const msg = JSON.parse(store.readMessage('sid'));
    expect(msg.nodeChanges[0].textData.characters).toBe('hello');

    const session = store.getById('sid')!;
    const node = (session.documentJson.children as any[])[0];
    expect(node.textData.characters).toBe('hello');
  });

  // Spec invariant I-3: master textData.characters edits propagate into the
  // INSTANCE's _componentTexts cache.
  it('refreshes _componentTexts cache when patching textData.characters', async () => {
    const store = seed();
    const useCase = new EditNode(store);
    await useCase.execute({
      sessionId: 'sid',
      nodeGuid: '0:1',
      field: 'textData.characters',
      value: 'updated',
    });
    const session = store.getById('sid')!;
    const inst = (session.documentJson.children as any[])[1];
    expect(inst._componentTexts[0].characters).toBe('updated');
  });

  // Negative-path coverage matching spec error cases.
  it('throws NotFoundError for unknown session', async () => {
    const useCase = new EditNode(new FakeSessionStore());
    await expect(
      useCase.execute({ sessionId: 'missing', nodeGuid: '0:1', field: 'x', value: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError for unknown node guid', async () => {
    const useCase = new EditNode(seed());
    await expect(
      useCase.execute({ sessionId: 'sid', nodeGuid: '99:99', field: 'x', value: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ValidationError for empty field path', async () => {
    const useCase = new EditNode(seed());
    await expect(
      useCase.execute({ sessionId: 'sid', nodeGuid: '0:1', field: '', value: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
