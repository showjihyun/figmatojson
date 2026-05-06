/**
 * Filesystem-backed EditJournal.
 *
 * Holds the same in-memory past/future stacks as InMemoryEditJournal, but
 * writes them through to `<session.dir>/.history.json` on every mutation
 * and lazy-hydrates from disk on first access per session. Two consequences:
 *
 *  1. Server restart preserves the undo/redo history — the working dirs
 *     under tmpdir() outlive the process, so the next server pickup sees
 *     the same .history.json.
 *  2. Snapshot save/load travels with the journal — SaveSnapshot reads the
 *     file into the snapshot bundle; LoadSnapshot writes it back into the
 *     adopted session's directory.
 *
 * Cap is 100 entries; oldest dropped on overflow (same as InMemory).
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

import type {
  EditJournal,
  HistoryDirection,
  JournalEntry,
} from '../../../core/ports/EditJournal.js';
import type { SessionStore } from '../../../core/ports/SessionStore.js';

interface SessionStacks {
  past: JournalEntry[];
  future: JournalEntry[];
}

const MAX_ENTRIES = 100;
const HISTORY_FILE = '.history.json';

function stackKey(direction: HistoryDirection): keyof SessionStacks {
  return direction === 'undo' ? 'past' : 'future';
}

export class FsEditJournal implements EditJournal {
  private readonly bySession = new Map<string, SessionStacks>();
  /**
   * Sessions whose stacks we've already attempted to hydrate from disk.
   * Without this set we'd reread the file on every operation.
   */
  private readonly hydrated = new Set<string>();

  constructor(private readonly sessionStore: SessionStore) {}

  private historyPath(sessionId: string): string | null {
    try {
      return this.sessionStore.resolvePath(sessionId, HISTORY_FILE);
    } catch {
      // Session not in store — nothing to read, will start with empty stacks.
      return null;
    }
  }

  private get(sessionId: string): SessionStacks {
    let stacks = this.bySession.get(sessionId);
    if (!stacks) {
      stacks = { past: [], future: [] };
      this.bySession.set(sessionId, stacks);
    }
    if (!this.hydrated.has(sessionId)) {
      this.hydrated.add(sessionId);
      const path = this.historyPath(sessionId);
      if (path && existsSync(path)) {
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8')) as SessionStacks;
          if (Array.isArray(parsed.past) && Array.isArray(parsed.future)) {
            stacks.past = parsed.past;
            stacks.future = parsed.future;
          }
        } catch (err) {
          // Corrupt file: ignore and keep empty stacks. The next mutation
          // will rewrite it cleanly.
          console.error('[FsEditJournal] failed to hydrate history', err);
        }
      }
    }
    return stacks;
  }

  private flush(sessionId: string): void {
    const path = this.historyPath(sessionId);
    if (!path) return;
    const stacks = this.bySession.get(sessionId);
    if (!stacks) return;
    try {
      writeFileSync(path, JSON.stringify(stacks));
    } catch (err) {
      console.error('[FsEditJournal] failed to persist history', err);
    }
  }

  record(sessionId: string, entry: JournalEntry): void {
    const stacks = this.get(sessionId);
    stacks.past.push(entry);
    if (stacks.past.length > MAX_ENTRIES) stacks.past.shift();
    stacks.future.length = 0;
    this.flush(sessionId);
  }

  popStep(sessionId: string, direction: HistoryDirection): JournalEntry | null {
    const stacks = this.get(sessionId);
    const entry = stacks[stackKey(direction)].pop() ?? null;
    if (entry) this.flush(sessionId);
    return entry;
  }

  pushStep(sessionId: string, direction: HistoryDirection, entry: JournalEntry): void {
    this.get(sessionId)[stackKey(direction)].push(entry);
    this.flush(sessionId);
  }

  depths(sessionId: string): { past: number; future: number } {
    const stacks = this.get(sessionId);
    return { past: stacks.past.length, future: stacks.future.length };
  }
}
