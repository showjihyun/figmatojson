import { describe, expect, it, vi } from 'vitest';
import { ExportFig } from './ExportFig.js';
import { NotFoundError } from './errors.js';
import { FakeSessionStore } from './testing/fakeSessionStore.js';
import type { Repacker, RepackResult } from '../ports/Repacker.js';

class FakeRepacker implements Repacker {
  readonly calls: string[] = [];
  constructor(private readonly bytes: Uint8Array) {}
  async repack(sessionId: string): Promise<RepackResult> {
    this.calls.push(sessionId);
    return { bytes: this.bytes, files: [{ name: 'canvas.fig', bytes: this.bytes.byteLength }] };
  }
}

function seed() {
  const store = new FakeSessionStore();
  store.seed(
    {
      id: 'sid',
      dir: '/tmp/fake',
      origName: '디자인.fig',
      archiveVersion: 106,
      documentJson: { id: '0:0', guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT' },
    },
    '{}',
  );
  return store;
}

describe('ExportFig', () => {
  it('delegates to Repacker and returns bytes + origName for the route to use', async () => {
    const store = seed();
    const repacker = new FakeRepacker(new Uint8Array([0x50, 0x4b]));
    const useCase = new ExportFig(store, repacker);
    const out = await useCase.execute({ sessionId: 'sid' });
    expect(repacker.calls).toEqual(['sid']);
    expect(out.bytes.byteLength).toBe(2);
    // Non-ASCII filenames must be carried through verbatim — the route handles
    // RFC 5987 encoding, not the use case.
    expect(out.origName).toBe('디자인.fig');
    expect(out.filesReport[0]).toEqual({ name: 'canvas.fig', bytes: 2 });
  });

  it('throws NotFoundError without calling the Repacker for unknown session', async () => {
    const store = seed();
    const repacker = new FakeRepacker(new Uint8Array());
    const repackSpy = vi.spyOn(repacker, 'repack');
    await expect(new ExportFig(store, repacker).execute({ sessionId: 'missing' }))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(repackSpy).not.toHaveBeenCalled();
  });
});
