import { describe, expect, it } from 'vitest';
import { OverrideInstanceText } from './OverrideInstanceText.js';
import { NotFoundError, ValidationError } from './errors.js';
import { FakeSessionStore } from './testing/fakeSessionStore.js';

function seed() {
  const store = new FakeSessionStore();
  const message = {
    nodeChanges: [
      // The INSTANCE node — currently no overrides.
      { guid: { sessionID: 0, localID: 1 }, type: 'INSTANCE', symbolData: {} },
      // The master TEXT node — characters intentionally `MASTER` so we can
      // assert it doesn't change after an override.
      { guid: { sessionID: 0, localID: 2 }, type: 'TEXT', textData: { characters: 'MASTER' } },
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
          { id: '0:1', guid: { sessionID: 0, localID: 1 }, type: 'INSTANCE' },
        ],
      },
    },
    JSON.stringify(message),
  );
  return store;
}

describe('OverrideInstanceText', () => {
  it('appends a symbolOverrides entry without touching master text', async () => {
    const store = seed();
    await new OverrideInstanceText(store).execute({
      sessionId: 'sid',
      instanceGuid: '0:1',
      masterTextGuid: '0:2',
      value: 'OVERRIDDEN',
    });

    const msg = JSON.parse(store.readMessage('sid'));
    const inst = msg.nodeChanges.find((n: any) => n.guid.localID === 1);
    expect(inst.symbolData.symbolOverrides).toHaveLength(1);
    const entry = inst.symbolData.symbolOverrides[0];
    expect(entry.guidPath).toEqual({ guids: [{ sessionID: 0, localID: 2 }] });
    expect(entry.textData.characters).toBe('OVERRIDDEN');

    // Master remains untouched.
    const master = msg.nodeChanges.find((n: any) => n.guid.localID === 2);
    expect(master.textData.characters).toBe('MASTER');
  });

  it('updates the existing override entry when one already exists', async () => {
    const store = seed();
    const useCase = new OverrideInstanceText(store);
    await useCase.execute({
      sessionId: 'sid', instanceGuid: '0:1', masterTextGuid: '0:2', value: 'first',
    });
    await useCase.execute({
      sessionId: 'sid', instanceGuid: '0:1', masterTextGuid: '0:2', value: 'second',
    });

    const msg = JSON.parse(store.readMessage('sid'));
    const inst = msg.nodeChanges.find((n: any) => n.guid.localID === 1);
    expect(inst.symbolData.symbolOverrides).toHaveLength(1);
    expect(inst.symbolData.symbolOverrides[0].textData.characters).toBe('second');
  });

  // I-4: in-memory documentJson gets _instanceOverrides[masterGuid] = value.
  it('mirrors the override onto documentJson._instanceOverrides', async () => {
    const store = seed();
    await new OverrideInstanceText(store).execute({
      sessionId: 'sid', instanceGuid: '0:1', masterTextGuid: '0:2', value: 'X',
    });
    const session = store.getById('sid')!;
    const inst = (session.documentJson.children as any[])[0];
    expect(inst._instanceOverrides).toEqual({ '0:2': 'X' });
  });

  it('rejects malformed masterTextGuid', async () => {
    await expect(
      new OverrideInstanceText(seed()).execute({
        sessionId: 'sid', instanceGuid: '0:1', masterTextGuid: 'not-a-guid', value: 'x',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws NotFoundError when INSTANCE is missing', async () => {
    await expect(
      new OverrideInstanceText(seed()).execute({
        sessionId: 'sid', instanceGuid: '99:99', masterTextGuid: '0:2', value: 'x',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
