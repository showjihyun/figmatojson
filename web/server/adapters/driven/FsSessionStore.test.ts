/**
 * Unit gate: FsSessionStore's `maxCount` LRU eviction.
 *
 * Round-23 commit 977f24c bumped the e2e suite's NODE heap to 8 GB to work
 * around an OOM crash that reproduced after ~17 sessions accumulated in
 * the FsSessionStore Map without ever being garbage-collected (gcSessions
 * runs every 5 min and only drops 1 h-old entries). The architectural
 * fix in this round is to cap the Map at `maxCount` and evict the oldest
 * session whenever we'd exceed it. This test pins that contract.
 *
 * We use `adopt(session)` — bypasses the whole .fig-decode pipeline so the
 * test is fast and doesn't pull a real fixture in. The eviction logic
 * applies to both `create()` and `adopt()`; `adopt()` is the cheaper
 * surface to verify.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FsSessionStore } from './FsSessionStore.js';
import type { Session } from '../../../core/domain/entities/Session.js';

function makeSession(idSuffix: string): { session: Session; dir: string } {
  // Match FsSessionStore.create's id format: "s" + base36(now) + 4 random base36 chars.
  // We append idSuffix to keep ids unique across rapid calls in a single ms.
  const dir = mkdtempSync(join(tmpdir(), 'figrev-test-'));
  const id = `s${Date.now().toString(36)}${idSuffix}xyz`;
  const session: Session = {
    id,
    dir,
    origName: `${idSuffix}.fig`,
    archiveVersion: 1,
    documentJson: { id: '0:0', type: 'DOCUMENT', children: [] } as unknown as Session['documentJson'],
  };
  return { session, dir };
}

describe('FsSessionStore — maxCount LRU eviction', () => {
  const tmpDirs: string[] = [];
  beforeEach(() => { tmpDirs.length = 0; });
  afterEach(() => {
    // Whatever survived eviction is still on disk via session.dir; clean up
    // so we don't leak tmp directories across tests.
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
    }
  });

  it('cap defaults to a sane value (>=1) and accepts a custom value', () => {
    const def = new FsSessionStore();
    // 100 adopts should succeed when default is generous enough.
    for (let i = 0; i < 5; i++) {
      const { session, dir } = makeSession(`d${i}`);
      tmpDirs.push(dir);
      def.adopt(session);
    }
    expect(def.rawMap().size).toBe(5);

    const tiny = new FsSessionStore({ maxCount: 2 });
    expect(tiny.rawMap().size).toBe(0);
  });

  it('adopt() evicts oldest when at capacity — Map order is creation order', async () => {
    const store = new FsSessionStore({ maxCount: 3 });
    const created: Array<{ session: Session; dir: string }> = [];
    for (let i = 0; i < 5; i++) {
      const fixture = makeSession(`s${i}`);
      // Tiny delay so id timestamps are distinct enough that we can
      // reason about ordering. (Map insertion order is preserved
      // regardless of id content, so this is purely for the test's
      // mental model.)
      await new Promise((r) => setTimeout(r, 2));
      const next = makeSession(`s${i}`);
      created.push(next);
      tmpDirs.push(next.dir);
      store.adopt(next.session);
    }
    expect(store.rawMap().size).toBe(3);
    // First two should be evicted; last three retained.
    expect(store.getById(created[0].session.id)).toBeNull();
    expect(store.getById(created[1].session.id)).toBeNull();
    expect(store.getById(created[2].session.id)).not.toBeNull();
    expect(store.getById(created[3].session.id)).not.toBeNull();
    expect(store.getById(created[4].session.id)).not.toBeNull();
    // Evicted sessions' working dirs are unlinked.
    expect(existsSync(created[0].dir)).toBe(false);
    expect(existsSync(created[1].dir)).toBe(false);
    // Surviving ones still on disk.
    expect(existsSync(created[2].dir)).toBe(true);
  });

  it('maxCount=1 always keeps only the most recent session', async () => {
    const store = new FsSessionStore({ maxCount: 1 });
    const a = makeSession('a');
    const b = makeSession('b');
    tmpDirs.push(a.dir, b.dir);

    store.adopt(a.session);
    expect(store.rawMap().size).toBe(1);
    expect(store.getById(a.session.id)).not.toBeNull();

    store.adopt(b.session);
    expect(store.rawMap().size).toBe(1);
    expect(store.getById(a.session.id), 'a evicted when b adopted').toBeNull();
    expect(store.getById(b.session.id), 'b retained').not.toBeNull();
    expect(existsSync(a.dir), 'a dir cleaned up on eviction').toBe(false);
  });

  it('destroy() still works alongside cap-based eviction', async () => {
    const store = new FsSessionStore({ maxCount: 5 });
    const fixtures: Array<{ session: Session; dir: string }> = [];
    for (let i = 0; i < 3; i++) {
      const f = makeSession(`d${i}`);
      tmpDirs.push(f.dir);
      fixtures.push(f);
      store.adopt(f.session);
    }
    expect(store.rawMap().size).toBe(3);
    await store.destroy(fixtures[1].session.id);
    expect(store.rawMap().size).toBe(2);
    expect(store.getById(fixtures[1].session.id)).toBeNull();
    expect(existsSync(fixtures[1].dir)).toBe(false);
    // Other entries unaffected.
    expect(store.getById(fixtures[0].session.id)).not.toBeNull();
    expect(store.getById(fixtures[2].session.id)).not.toBeNull();
  });

  it('clamps maxCount to at least 1 (defends against env misconfig)', () => {
    const a = new FsSessionStore({ maxCount: 0 });
    const b = new FsSessionStore({ maxCount: -5 });
    const fixtureA = makeSession('a');
    const fixtureB = makeSession('b');
    tmpDirs.push(fixtureA.dir, fixtureB.dir);
    // Both should still accept at least one session.
    a.adopt(fixtureA.session);
    expect(a.rawMap().size).toBe(1);
    b.adopt(fixtureB.session);
    expect(b.rawMap().size).toBe(1);
  });
});
