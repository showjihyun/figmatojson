import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFileSync } from './atomicWrite.js';

describe('atomicWriteFileSync', () => {
  let dir: string;
  let dest: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    dest = join(dir, 'message.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the destination and leaves no temp file behind', () => {
    atomicWriteFileSync(dest, '{"hello":"world"}');
    expect(readFileSync(dest, 'utf8')).toBe('{"hello":"world"}');
    // Directory should contain only the destination — temp file renamed away.
    expect(readdirSync(dir)).toEqual(['message.json']);
  });

  it('overwrites an existing destination', () => {
    writeFileSync(dest, 'OLD');
    atomicWriteFileSync(dest, 'NEW');
    expect(readFileSync(dest, 'utf8')).toBe('NEW');
    expect(readdirSync(dir)).toEqual(['message.json']);
  });

  it('accepts Buffer contents (binary write)', () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    atomicWriteFileSync(dest, bytes);
    const out = readFileSync(dest);
    expect(out.equals(bytes)).toBe(true);
  });

  // The whole point of this helper: a crash mid-write (writeFileSync errors,
  // process killed, disk full) must NOT leave the canonical destination in
  // an undecodable state. Simulate by injecting a failing writeFileSync —
  // the pre-existing destination must survive untouched.
  it('leaves the destination untouched if the temp write fails', () => {
    writeFileSync(dest, 'PRESERVED');

    expect(() =>
      atomicWriteFileSync(dest, 'CORRUPT', {
        writeFileSync: () => { throw new Error('ENOSPC: no space left on device'); },
      }),
    ).toThrow(/ENOSPC/);

    // Destination still has the OLD bytes. No half-written file replaced it.
    expect(readFileSync(dest, 'utf8')).toBe('PRESERVED');
    // No orphan .tmp.* files — the failed writeFileSync didn't create one,
    // and the best-effort rmSync cleanup ran anyway.
    expect(readdirSync(dir)).toEqual(['message.json']);
  });

  // If the rename itself fails (rare — partition / cross-fs / EACCES on
  // rename), the temp exists and has the new bytes, but the destination
  // must still hold the pre-call bytes. Cleanup of the temp is best-effort.
  it('leaves the destination untouched if the rename fails', () => {
    writeFileSync(dest, 'PRESERVED');

    expect(() =>
      atomicWriteFileSync(dest, 'WOULD_BE_NEW', {
        renameSync: () => { throw new Error('EXDEV: cross-device link not permitted'); },
      }),
    ).toThrow(/EXDEV/);

    expect(readFileSync(dest, 'utf8')).toBe('PRESERVED');
    // Best-effort cleanup ran — orphaned temp is removed.
    expect(readdirSync(dir)).toEqual(['message.json']);
  });

  // If both the rename AND the cleanup rmSync fail (very rare — disk
  // gone), the original error propagates, never the cleanup error. The
  // destination is still untouched (proven by the rename never having
  // landed); only the orphan temp lingers.
  it('surfaces the original error when cleanup fails too', () => {
    writeFileSync(dest, 'PRESERVED');

    expect(() =>
      atomicWriteFileSync(dest, 'NEW', {
        renameSync: () => { throw new Error('EXDEV: rename failed'); },
        rmSync: () => { throw new Error('EIO: cleanup also failed'); },
      }),
    ).toThrow(/EXDEV/);

    expect(readFileSync(dest, 'utf8')).toBe('PRESERVED');
  });

  it('writes to a fresh path that does not yet exist', () => {
    const fresh = join(dir, 'subdir-existed-but-file-did-not.json');
    expect(existsSync(fresh)).toBe(false);
    atomicWriteFileSync(fresh, 'first-write');
    expect(readFileSync(fresh, 'utf8')).toBe('first-write');
  });
});
