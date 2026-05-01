/**
 * Kiwi codec adapter — implements the Repacker port today.
 *
 * Wraps `src/repack.js` from the parent CLI tool, which knows how to
 * stitch a session's `extracted/` directory back into a .fig binary.
 * The Decoder side of the codec lives inside FsSessionStore.create today
 * (because it's tightly coupled with directory dump). When the decode path
 * needs reuse (e.g. for the snapshot-load use case), we'll lift it here
 * too — for now this file is single-port.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { repack } from '../../../../src/repack.js';
import type { Repacker, RepackResult } from '../../../core/ports/Repacker.js';
import type { SessionStore } from '../../../core/ports/SessionStore.js';

export class KiwiCodec implements Repacker {
  constructor(private readonly sessionStore: SessionStore) {}

  async repack(sessionId: string): Promise<RepackResult> {
    const extractedDir = this.sessionStore.resolvePath(sessionId, 'extracted');
    const outFig = this.sessionStore.resolvePath(sessionId, 'out.fig');
    const result = await repack(extractedDir, outFig, { mode: 'json' });
    const bytes = new Uint8Array(readFileSync(outFig));
    return { bytes, files: result.files };
  }
}
