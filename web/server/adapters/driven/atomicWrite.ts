/**
 * Atomic file write — write-and-rename so the destination either contains
 * the previous bytes or the new bytes, never a half-written mix.
 *
 * Why: every chat-tool mutation in `applyTool.ts` and every leaf use case
 * via `FsSessionStore.writeMessage` overwrites the same `message.json`
 * which is the single source of truth for the session. A crash mid-write
 * (process kill, disk full, OS reboot) used to risk leaving a truncated
 * file that no longer parses — Undo can't recover from that because the
 * journal's `before` snapshot is also held in memory and lost on restart.
 *
 * Mechanism: write to a sibling `<dest>.tmp.<pid>.<rand>` first, then
 * `renameSync` it over the destination. On POSIX and NTFS, rename within
 * the same filesystem is atomic at the directory-entry level — concurrent
 * readers see either the old inode or the new one. If the writeFileSync
 * step fails (disk full, EACCES), the destination is untouched.
 *
 * The randomized suffix is defensive: PoC code is single-writer per
 * session, but two writers landing on the same destination at the same
 * millisecond would otherwise clobber each other's temp file mid-rename.
 *
 * The third argument is a test seam — production callers never pass it.
 * ESM module bindings are not spy-able, so explicit injection is the
 * cleanest way to simulate `writeFileSync` / `renameSync` failures.
 */

import { renameSync, rmSync, writeFileSync } from 'node:fs';

export interface AtomicFs {
  writeFileSync: (path: string, contents: string | Buffer) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  rmSync: (path: string, opts: { force: boolean }) => void;
}

const realFs: AtomicFs = {
  writeFileSync: (p, c) => writeFileSync(p, c),
  renameSync: (a, b) => renameSync(a, b),
  rmSync: (p, opts) => rmSync(p, opts),
};

export function atomicWriteFileSync(
  path: string,
  contents: string | Buffer,
  overrides?: Partial<AtomicFs>,
): void {
  const fs = overrides ? { ...realFs, ...overrides } : realFs;
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the orphaned temp. If writeFileSync itself
    // failed, the temp may not exist; if rename failed, the temp is still
    // there with the new bytes. Either way, swallow the cleanup error so
    // the original cause surfaces to the caller.
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}
