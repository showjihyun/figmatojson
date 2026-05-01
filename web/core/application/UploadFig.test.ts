import { describe, expect, it } from 'vitest';
import { UploadFig } from './UploadFig.js';
import type { Session } from '../domain/entities/Session.js';
import type { SessionStore } from '../ports/SessionStore.js';

/**
 * UploadFig delegates the heavy work to SessionStore.create, so a fake that
 * just hands back a synthetic Session is enough to exercise the use case's
 * own logic — which is mostly counting CANVAS children and total nodes.
 */
class CreateOnlyFakeStore implements SessionStore {
  constructor(private readonly session: Session) {}
  async create(): Promise<Session> { return this.session; }
  getById(): Session | null { return null; }
  async flush(): Promise<void> { /* no-op */ }
  resolvePath(): string { return ''; }
  async destroy(): Promise<void> { /* no-op */ }
}

const sampleDoc = {
  id: '0:0',
  guid: { sessionID: 0, localID: 0 },
  type: 'DOCUMENT',
  children: [
    {
      id: '0:1',
      guid: { sessionID: 0, localID: 1 },
      type: 'CANVAS',
      children: [
        { id: '0:2', guid: { sessionID: 0, localID: 2 }, type: 'FRAME' },
        { id: '0:3', guid: { sessionID: 0, localID: 3 }, type: 'TEXT' },
      ],
    },
    {
      id: '0:4',
      guid: { sessionID: 0, localID: 4 },
      type: 'CANVAS',
      children: [{ id: '0:5', guid: { sessionID: 0, localID: 5 }, type: 'TEXT' }],
    },
    {
      id: '0:6',
      guid: { sessionID: 0, localID: 6 },
      type: 'NOT_A_PAGE',
    },
  ],
};

describe('UploadFig', () => {
  it('returns sessionId, origName, pageCount (CANVAS children only), nodeCount (all)', async () => {
    const session: Session = {
      id: 'newsid',
      dir: '/tmp/x',
      origName: 'design.fig',
      archiveVersion: 106,
      documentJson: sampleDoc,
    };
    const useCase = new UploadFig(new CreateOnlyFakeStore(session));
    const out = await useCase.execute({ bytes: new Uint8Array([0x50, 0x4b]), origName: 'design.fig' });
    expect(out.sessionId).toBe('newsid');
    expect(out.origName).toBe('design.fig');
    // Two CANVAS children at depth 1; one NOT_A_PAGE sibling that doesn't count.
    expect(out.pageCount).toBe(2);
    // All 7 nodes: DOCUMENT + 2 CANVAS + 1 NOT_A_PAGE + 3 grandchildren.
    expect(out.nodeCount).toBe(7);
  });

  it('returns pageCount=0 for a tree with no CANVAS children', async () => {
    const session: Session = {
      id: 'newsid',
      dir: '/tmp/x',
      origName: 'empty.fig',
      archiveVersion: 106,
      documentJson: { id: '0:0', guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', children: [] },
    };
    const useCase = new UploadFig(new CreateOnlyFakeStore(session));
    const out = await useCase.execute({ bytes: new Uint8Array(), origName: 'empty.fig' });
    expect(out.pageCount).toBe(0);
    expect(out.nodeCount).toBe(1);
  });
});
