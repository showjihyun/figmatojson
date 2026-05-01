/**
 * Use case: atomically set position + size on a node.
 *
 * The legacy /api/resize endpoint patched transform.m02/m12 + size.x/y in
 * one round-trip so the canvas overlay's resize-handle drag produces a
 * single consistent state on disk (no flicker between half-applied
 * coordinates). Same atomicity preserved here.
 */

import type { SessionStore } from '../ports/SessionStore.js';
import type { EditJournal } from '../ports/EditJournal.js';
import { NotFoundError } from './errors.js';

interface FsLike {
  readMessage(id: string): string;
  writeMessage(id: string, json: string): void;
}

export interface ResizeNodeInput {
  sessionId: string;
  guid: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class ResizeNode {
  constructor(
    private readonly sessionStore: SessionStore & FsLike,
    private readonly journal?: EditJournal,
  ) {}

  async execute({ sessionId, guid, x, y, w, h }: ResizeNodeInput): Promise<{ ok: true }> {
    const session = this.sessionStore.getById(sessionId);
    if (!session) throw new NotFoundError(`session ${sessionId} not found`);

    const raw = this.sessionStore.readMessage(sessionId);
    const msg = JSON.parse(raw) as { nodeChanges?: Array<Record<string, unknown>> };
    const node = msg.nodeChanges?.find((n) => {
      const g = n.guid as { sessionID?: number; localID?: number } | undefined;
      return g && `${g.sessionID}:${g.localID}` === guid;
    });
    if (!node) throw new NotFoundError(`node ${guid} not found`);

    // Capture pre-state of the four fields we're about to mutate.
    const beforeT = (node.transform as Record<string, number> | undefined) ?? {};
    const beforeMx = beforeT.m02;
    const beforeMy = beforeT.m12;
    const beforeSize = (node.size as { x?: number; y?: number } | undefined) ?? {};
    const beforeSx = beforeSize.x;
    const beforeSy = beforeSize.y;

    const t = (node.transform ??= {}) as Record<string, number>;
    t.m02 = x;
    t.m12 = y;
    const newSize = { x: Math.max(1, w), y: Math.max(1, h) };
    node.size = newSize;
    this.sessionStore.writeMessage(sessionId, JSON.stringify(msg));

    // Mirror on documentJson.
    const doc = session.documentJson as unknown as Record<string, unknown>;
    function walk(n: Record<string, unknown>): boolean {
      const g = n.guid as { sessionID: number; localID: number } | undefined;
      if (g && `${g.sessionID}:${g.localID}` === guid) {
        const t2 = (n.transform ??= {}) as Record<string, number>;
        t2.m02 = x;
        t2.m12 = y;
        n.size = { x: Math.max(1, w), y: Math.max(1, h) };
        return true;
      }
      const ch = n.children as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(ch)) for (const c of ch) if (walk(c)) return true;
      return false;
    }
    walk(doc);

    this.journal?.record(sessionId, {
      label: 'Resize',
      patches: [
        { guid, field: 'transform.m02', before: beforeMx, after: x },
        { guid, field: 'transform.m12', before: beforeMy, after: y },
        { guid, field: 'size.x', before: beforeSx, after: newSize.x },
        { guid, field: 'size.y', before: beforeSy, after: newSize.y },
      ],
    });

    return { ok: true };
  }
}
