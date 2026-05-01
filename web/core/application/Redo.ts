/**
 * Use case: redo the most recently undone edit.
 *
 * Mirror of Undo — pops from `future`, applies `after`s, pushes onto
 * `past`. Returns the same shape as UndoOutput so the client can render
 * a single keyboard-shortcut state machine.
 */

import type { SessionStore } from '../ports/SessionStore.js';
import type { EditJournal } from '../ports/EditJournal.js';
import { NotFoundError } from './errors.js';
import { applyPatches } from './Undo.js';

interface FsLike {
  readMessage(id: string): string;
  writeMessage(id: string, json: string): void;
}

export interface RedoInput {
  sessionId: string;
}

export interface RedoOutput {
  ok: boolean;
  redoneLabel: string | null;
  past: number;
  future: number;
}

export class Redo {
  constructor(
    private readonly sessionStore: SessionStore & FsLike,
    private readonly journal: EditJournal,
  ) {}

  async execute({ sessionId }: RedoInput): Promise<RedoOutput> {
    const session = this.sessionStore.getById(sessionId);
    if (!session) throw new NotFoundError(`session ${sessionId} not found`);

    const entry = this.journal.popRedo(sessionId);
    if (!entry) {
      return { ok: false, redoneLabel: null, ...this.journal.depths(sessionId) };
    }

    applyPatches(this.sessionStore, sessionId, session, entry.patches, 'after');
    this.journal.pushPast(sessionId, entry);
    return { ok: true, redoneLabel: entry.label, ...this.journal.depths(sessionId) };
  }
}
