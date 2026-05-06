/**
 * In-memory implementation of the EditJournal port.
 *
 * Two stacks per session — `past` for undo, `future` for redo. Cap at 100
 * entries (oldest dropped) so a long editing session doesn't grow without
 * bound. PoC scope; production might persist to disk so undo survives a
 * server restart.
 */

import type {
  EditJournal,
  HistoryDirection,
  JournalEntry,
} from '../../../core/ports/EditJournal.js';

interface SessionStacks {
  past: JournalEntry[];
  future: JournalEntry[];
}

const MAX_ENTRIES = 100;

function stackKey(direction: HistoryDirection): keyof SessionStacks {
  return direction === 'undo' ? 'past' : 'future';
}

export class InMemoryEditJournal implements EditJournal {
  private readonly bySession = new Map<string, SessionStacks>();

  private get(sessionId: string): SessionStacks {
    let stacks = this.bySession.get(sessionId);
    if (!stacks) {
      stacks = { past: [], future: [] };
      this.bySession.set(sessionId, stacks);
    }
    return stacks;
  }

  record(sessionId: string, entry: JournalEntry): void {
    const stacks = this.get(sessionId);
    stacks.past.push(entry);
    if (stacks.past.length > MAX_ENTRIES) stacks.past.shift();
    stacks.future.length = 0;
  }

  popStep(sessionId: string, direction: HistoryDirection): JournalEntry | null {
    const stacks = this.bySession.get(sessionId);
    return stacks?.[stackKey(direction)].pop() ?? null;
  }

  pushStep(sessionId: string, direction: HistoryDirection, entry: JournalEntry): void {
    this.get(sessionId)[stackKey(direction)].push(entry);
  }

  depths(sessionId: string): { past: number; future: number } {
    const stacks = this.bySession.get(sessionId);
    return {
      past: stacks?.past.length ?? 0,
      future: stacks?.future.length ?? 0,
    };
  }
}
