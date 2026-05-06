/**
 * Use case: apply one step of the per-session edit history in either
 * direction.
 *
 * Replaces the symmetric pair Undo + Redo (deleted 2026-05-06). The two
 * differed only in: which stack to pop from, which value to apply
 * (`before` vs `after`), and which stack to push onto. All three become
 * functions of the `direction` input.
 *
 * Convention (matches `EditJournal` port):
 *   direction === 'undo' → pop from past, apply `before`, push to future
 *   direction === 'redo' → pop from future, apply `after`,  push to past
 */

import type { EditJournal, HistoryDirection } from '../ports/EditJournal.js';
import type { SessionStore } from '../ports/SessionStore.js';
import type { Session } from '../domain/entities/Session.js';
import { NotFoundError } from './errors.js';
import { tokenizePath, setPath } from '../domain/path.js';
import { rebuildDocumentFromMessage } from '../domain/messageJson.js';

/**
 * Sentinel guid for full-message-snapshot patches emitted by structural
 * chat tools (today: duplicate, group, ungroup). When `applyPatches`
 * sees this guid it replaces the whole `nodeChanges` array and re-derives
 * documentJson — the leaf-level setPath fan-out doesn't apply to tree
 * restructure.
 */
const MSG_SENTINEL_GUID = '__msg__';

interface FsLike {
  readMessage(id: string): string;
  writeMessage(id: string, json: string): void;
}

export interface HistoryInput {
  sessionId: string;
  direction: HistoryDirection;
}

export interface HistoryOutput {
  ok: boolean;
  direction: HistoryDirection;
  /** Label of the entry that was applied, or null if the stack was empty. */
  appliedLabel: string | null;
  past: number;
  future: number;
}

function opposite(direction: HistoryDirection): HistoryDirection {
  return direction === 'undo' ? 'redo' : 'undo';
}

export class History {
  constructor(
    private readonly sessionStore: SessionStore & FsLike,
    private readonly journal: EditJournal,
  ) {}

  async execute({ sessionId, direction }: HistoryInput): Promise<HistoryOutput> {
    const session = this.sessionStore.getById(sessionId);
    if (!session) throw new NotFoundError(`session ${sessionId} not found`);

    const entry = this.journal.popStep(sessionId, direction);
    if (!entry) {
      return {
        ok: false,
        direction,
        appliedLabel: null,
        ...this.journal.depths(sessionId),
      };
    }

    const pick = direction === 'undo' ? 'before' : 'after';
    applyPatches(this.sessionStore, sessionId, session, entry.patches, pick);
    this.journal.pushStep(sessionId, opposite(direction), entry);

    return {
      ok: true,
      direction,
      appliedLabel: entry.label,
      ...this.journal.depths(sessionId),
    };
  }
}

/**
 * Apply a journal entry's patches to message.json + documentJson.
 *
 * Exported for the rare caller that needs to apply a synthesized entry
 * outside the History stack (none in production today; kept exported so
 * a future test can drive it directly without going through History).
 */
export function applyPatches(
  store: SessionStore & FsLike,
  sessionId: string,
  session: Session,
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
    if (patch.guid === MSG_SENTINEL_GUID && patch.field === 'nodeChanges') {
      // Structural patch: swap the whole nodeChanges array. No need to
      // setPath — the new array IS the new state. documentJson is rebuilt
      // wholesale below.
      const value = pick === 'before' ? patch.before : patch.after;
      msg.nodeChanges = value as Array<Record<string, unknown>>;
      continue;
    }
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

  // If any structural patch landed, the in-place mirror above is incomplete —
  // re-derive documentJson from the freshly-written message.json so the
  // client tree reflects the new node set. Cheap to skip when no sentinel
  // patches are present.
  const hadStructural = patches.some(
    (p) => p.guid === MSG_SENTINEL_GUID && p.field === 'nodeChanges',
  );
  if (hadStructural) {
    const newDoc = rebuildDocumentFromMessage(JSON.stringify(msg));
    (session as { documentJson: unknown }).documentJson = newDoc;
  }
}
