import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsEditJournal } from './FsEditJournal.js';
import type { SessionStore } from '../../../core/ports/SessionStore.js';
import type { Session } from '../../../core/domain/entities/Session.js';

/**
 * Minimal SessionStore stub that maps a known sessionId to a real tmpdir
 * — enough surface for FsEditJournal to call resolvePath().
 */
class StubStore implements SessionStore {
  constructor(private readonly id: string, private readonly dir: string) {}
  async create(): Promise<Session> { throw new Error('not used'); }
  getById(): Session | null { return null; }
  async flush(): Promise<void> {}
  resolvePath(id: string, ...segs: string[]): string {
    if (id !== this.id) throw new Error(`unknown session ${id}`);
    return join(this.dir, ...segs);
  }
  async destroy(): Promise<void> {}
}

describe('FsEditJournal', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fs-journal-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes through to .history.json on every record', () => {
    const journal = new FsEditJournal(new StubStore('sid', dir));
    journal.record('sid', {
      label: 'Edit',
      patches: [{ guid: '0:1', field: 'textData.characters', before: 'a', after: 'b' }],
    });
    const file = join(dir, '.history.json');
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed.past).toHaveLength(1);
    expect(parsed.past[0].label).toBe('Edit');
    expect(parsed.future).toEqual([]);
  });

  it('hydrates stacks from disk on a fresh journal instance (server restart simulation)', () => {
    const journal1 = new FsEditJournal(new StubStore('sid', dir));
    journal1.record('sid', {
      label: 'first',
      patches: [{ guid: '0:1', field: 'x', before: 1, after: 2 }],
    });
    journal1.record('sid', {
      label: 'second',
      patches: [{ guid: '0:1', field: 'x', before: 2, after: 3 }],
    });
    expect(journal1.depths('sid')).toEqual({ past: 2, future: 0 });

    // Simulate a server restart — new journal instance, same dir.
    const journal2 = new FsEditJournal(new StubStore('sid', dir));
    expect(journal2.depths('sid')).toEqual({ past: 2, future: 0 });
    const popped = journal2.popStep('sid', 'undo');
    expect(popped?.label).toBe('second');
    expect(journal2.depths('sid')).toEqual({ past: 1, future: 0 });
  });

  it('flush after popStep persists the new state so a subsequent restart sees the pop', () => {
    const journal = new FsEditJournal(new StubStore('sid', dir));
    journal.record('sid', {
      label: 'only',
      patches: [{ guid: '0:1', field: 'x', before: 1, after: 2 }],
    });
    journal.popStep('sid', 'undo');
    // History.execute would also call pushStep('redo', entry) here; we
    // assert just past=[] to keep the test focused on the popStep persist.
    const parsed = JSON.parse(readFileSync(join(dir, '.history.json'), 'utf8'));
    expect(parsed.past).toEqual([]);
  });

  it('depths() on an unknown session returns zeros without creating a file', () => {
    const journal = new FsEditJournal(new StubStore('sid', dir));
    expect(journal.depths('sid')).toEqual({ past: 0, future: 0 });
    expect(existsSync(join(dir, '.history.json'))).toBe(false);
  });

  it('caps the past stack at 100 entries (oldest dropped)', () => {
    const journal = new FsEditJournal(new StubStore('sid', dir));
    for (let i = 0; i < 105; i++) {
      journal.record('sid', {
        label: `e${i}`,
        patches: [{ guid: '0:1', field: 'x', before: i, after: i + 1 }],
      });
    }
    expect(journal.depths('sid').past).toBe(100);
    // Top of the stack is the most recent.
    const top = journal.popStep('sid', 'undo');
    expect(top?.label).toBe('e104');
    // Bottom: the first 5 should have been dropped, so #5 is now the oldest.
    let last: string | null = null;
    while (true) {
      const e = journal.popStep('sid', 'undo');
      if (!e) break;
      last = e.label;
    }
    expect(last).toBe('e5');
  });
});
