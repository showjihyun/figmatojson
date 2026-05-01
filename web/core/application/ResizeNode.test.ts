import { describe, expect, it } from 'vitest';
import { ResizeNode } from './ResizeNode.js';
import { NotFoundError } from './errors.js';
import { FakeSessionStore } from './testing/fakeSessionStore.js';

function seed() {
  const store = new FakeSessionStore();
  const message = {
    nodeChanges: [
      {
        guid: { sessionID: 0, localID: 1 },
        type: 'FRAME',
        transform: { m00: 1, m01: 0, m10: 0, m11: 1, m02: 100, m12: 50 },
        size: { x: 200, y: 80 },
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
          {
            id: '0:1',
            guid: { sessionID: 0, localID: 1 },
            type: 'FRAME',
            transform: { m02: 100, m12: 50 },
            size: { x: 200, y: 80 },
          },
        ],
      },
    },
    JSON.stringify(message),
  );
  return store;
}

describe('ResizeNode', () => {
  it('atomically updates transform.m02/m12 and size on message.json + documentJson', async () => {
    const store = seed();
    const useCase = new ResizeNode(store);
    await useCase.execute({
      sessionId: 'sid',
      guid: '0:1',
      x: 250,
      y: 60,
      w: 400,
      h: 120,
    });

    const msg = JSON.parse(store.readMessage('sid'));
    const node = msg.nodeChanges[0];
    expect(node.transform.m02).toBe(250);
    expect(node.transform.m12).toBe(60);
    expect(node.size).toEqual({ x: 400, y: 120 });

    const session = store.getById('sid')!;
    const mirrored = (session.documentJson.children as any[])[0];
    expect(mirrored.transform.m02).toBe(250);
    expect(mirrored.size).toEqual({ x: 400, y: 120 });
  });

  // I-3: w/h <= 0 clamp to 1 so Konva doesn't reject negative size.
  it('clamps non-positive width/height to 1', async () => {
    const store = seed();
    await new ResizeNode(store).execute({
      sessionId: 'sid', guid: '0:1', x: 0, y: 0, w: 0, h: -5,
    });
    const node = JSON.parse(store.readMessage('sid')).nodeChanges[0];
    expect(node.size).toEqual({ x: 1, y: 1 });
  });

  it('throws NotFoundError for missing session / node', async () => {
    const store = seed();
    const useCase = new ResizeNode(store);
    await expect(
      useCase.execute({ sessionId: 'missing', guid: '0:1', x: 0, y: 0, w: 1, h: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      useCase.execute({ sessionId: 'sid', guid: '99:99', x: 0, y: 0, w: 1, h: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
