/**
 * Driven port: per-session undo/redo journal.
 *
 * Each `JournalEntry` is a list of (guid, field, before, after) tuples
 * captured by a mutation use case. Resize-style "atomic 3-field" edits
 * land as a single entry with 3 tuples; a simple text edit lands as
 * one entry with one tuple. Either way, undoing replays `before`s in
 * the same order and redoing replays `after`s.
 *
 * Two stacks per session, indexed by `direction`:
 *   'undo' = past stack (what undo pops from)
 *   'redo' = future stack (what redo pops from)
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

export type HistoryDirection = 'undo' | 'redo';

export interface EditJournal {
  /** Push a new entry onto the past stack and clear the future stack. */
  record(sessionId: string, entry: JournalEntry): void;

  /**
   * Pop the most recent entry from the stack indexed by `direction`
   * ('undo' = past, 'redo' = future). Returns null when the stack is empty.
   */
  popStep(sessionId: string, direction: HistoryDirection): JournalEntry | null;

  /**
   * Push an entry onto the stack indexed by `direction`. Used to move an
   * entry across stacks during a History step — after popping from one
   * direction the use case pushes onto the opposite, so the operation is
   * itself reversible. Does NOT enforce MAX_ENTRIES (the entry was
   * already inside the cap when `record` first admitted it).
   */
  pushStep(sessionId: string, direction: HistoryDirection, entry: JournalEntry): void;

  /** For UI affordances: counts of available undo/redo without popping. */
  depths(sessionId: string): { past: number; future: number };
}
