/**
 * Driven port: per-session undo/redo journal.
 *
 * Each `JournalEntry` is a list of (guid, field, before, after) tuples
 * captured by a mutation use case. Resize-style "atomic 3-field" edits
 * land as a single entry with 3 tuples; a simple text edit lands as
 * one entry with one tuple. Either way, undo replays `before`s in the
 * same order and redo replays `after`s.
 *
 * The journal is bounded — adapters MAY drop the oldest entries past a
 * cap (e.g. 100). When a fresh edit lands and there's redo history, the
 * future stack MUST be cleared (typical undo-stack semantics).
 */

export interface PatchPair {
  guid: string;
  field: string;
  before: unknown;
  after: unknown;
}

export interface JournalEntry {
  /** Human-readable label for UI ("Edit text", "Resize", ...). */
  label: string;
  patches: PatchPair[];
}

export interface EditJournal {
  /** Push a new entry onto the past stack and clear the future stack. */
  record(sessionId: string, entry: JournalEntry): void;

  /** Pop the most recent past entry; null if nothing to undo. */
  popUndo(sessionId: string): JournalEntry | null;

  /** Pop the most recent future entry; null if nothing to redo. */
  popRedo(sessionId: string): JournalEntry | null;

  /** Push an entry onto the future stack (called after a successful undo). */
  pushFuture(sessionId: string, entry: JournalEntry): void;

  /** Push an entry onto the past stack (called after a successful redo). */
  pushPast(sessionId: string, entry: JournalEntry): void;

  /** For UI affordances: counts of available undo/redo without popping. */
  depths(sessionId: string): { past: number; future: number };
}
