/**
 * Use case: repack the session's current state into a .fig binary.
 *
 * Driving adapter passes (sessionId); we fetch the session for its
 * origName + archive version (used for download headers), then call
 * the Repacker port for the actual encode. Returns bytes + filename
 * the route layer can stream as a download.
 */

import type { SessionStore } from '../ports/SessionStore.js';
import type { Repacker } from '../ports/Repacker.js';
import { NotFoundError } from './errors.js';

export interface ExportFigInput {
  sessionId: string;
}

export interface ExportFigOutput {
  bytes: Uint8Array;
  origName: string;
  filesReport: Array<{ name: string; bytes: number }>;
}

export class ExportFig {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly repacker: Repacker,
  ) {}

  async execute({ sessionId }: ExportFigInput): Promise<ExportFigOutput> {
    const session = this.sessionStore.getById(sessionId);
    if (!session) throw new NotFoundError(`session ${sessionId} not found`);
    // Flush any pending in-memory mutations to disk BEFORE repack reads
    // message.json. Today's PATCH paths (EditNode / ResizeNode / OverrideInstanceText
    // / chat tools) already write inline, so flush is typically a no-op —
    // but the explicit call here is the contract: Export .fig is "save +
    // export" in one step. No separate Save button click required.
    await this.sessionStore.flush(sessionId);
    const result = await this.repacker.repack(sessionId);
    return {
      bytes: result.bytes,
      origName: session.origName,
      filesReport: result.files,
    };
  }
}
