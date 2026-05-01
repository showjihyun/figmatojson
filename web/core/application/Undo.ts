/**
 * Use case: undo the most recent recorded edit.
 *
 * Pops the past stack, applies each `before` value to the message.json
 * (and mirrors onto documentJson) in order, then pushes the same entry
 * onto the future stack so a subsequent Redo can replay the `after`s.
 *
 * Symmetric with Redo — same body, opposite stack pull/push and opposite
 * value selection (after vs before). Kept as separate classes so route
 * handlers can wire them by name.
 */

import type { SessionStore } from '../ports/SessionStore.js';
import type { EditJournal } from '../ports/EditJournal.js';
import { NotFoundError } from './errors.js';
import { tokenizePath, setPath } from '../domain/path.js';

interface FsLike {
  readMessage(id: string): string;
  writeMessage(id: string, json: string): void;
}

export interface UndoInput {
  sessionId: string;
}

export interface UndoOutput {
  ok: boolean;
  /** Label of the entry that was undone, or null if nothing was on the stack. */
  undoneLabel: string | null;
  past: number;
  future: number;
}

export class Undo {
  constructor(
    private readonly sessionStore: SessionStore & FsLike,
    private readonly journal: EditJournal,
  ) {}

  async execute({ sessionId }: UndoInput): Promise<UndoOutput> {
    const session = this.sessionStore.getById(sessionId);
    if (!session) throw new NotFoundError(`session ${sessionId} not found`);

    const entry = this.journal.popUndo(sessionId);
    if (!entry) {
      return { ok: false, undoneLabel: null, ...this.journal.depths(sessionId) };
    }

    applyPatches(this.sessionStore, sessionId, session, entry.patches, 'before');
    this.journal.pushFuture(sessionId, entry);
    return { ok: true, undoneLabel: entry.label, ...this.journal.depths(sessionId) };
  }
}

/**
 * Apply a journal entry's patches to message.json + documentJson.
 *
 * Shared with Redo — exported only via the Undo module. Kept here so the
 * mutation logic stays in one place.
 */
export function applyPatches(
  store: SessionStore & FsLike,
  sessionId: string,
  session: import('../domain/entities/Session.js').Session,
  patches: import('../ports/EditJournal.js').PatchPair[],
  pick: 'before' | 'after',
): void {
  const raw = store.readMessage(sessionId);
  const msg = JSON.parse(raw) as { nodeChanges?: Array<Record<string, unknown>> };
  const findNode = (guid: string): Record<string, unknown> | undefined =>
    msg.nodeChanges?.find((n) => {
      const g = n.guid as { sessionID?: number; localID?: number } | undefined;
      return g && `${g.sessionID}:${g.localID}` === guid;
    });

  for (const patch of patches) {
    const node = findNode(patch.guid);
    if (!node) continue;
    const value = pick === 'before' ? patch.before : patch.after;
    const tokens = tokenizePath(patch.field);
    setPath(node, tokens, value);

    // Mirror onto documentJson too.
    const doc = session.documentJson as unknown as Record<string, unknown>;
    function walk(n: Record<string, unknown>): boolean {
      const g = n.guid as { sessionID: number; localID: number } | undefined;
      if (g && `${g.sessionID}:${g.localID}` === patch.guid) {
        setPath(n, tokens, value);
        return true;
      }
      const ch = n.children as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(ch)) for (const c of ch) if (walk(c)) return true;
      return false;
    }
    walk(doc);
  }

  store.writeMessage(sessionId, JSON.stringify(msg));
}
