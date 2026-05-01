/**
 * Use case: bundle a session's editing state into a JSON-portable snapshot.
 *
 * Output is the message.json + base64'd binary sidecars (schema.kiwi.bin,
 * 02_archive/_info.json, 01_container/* including images). The route layer
 * downloads it as a single .json file the user can resume from later.
 *
 * IO is direct fs reads via SessionStore.resolvePath — file traversal is
 * intentional here (the entire container directory may contain assets we
 * don't want to enumerate via a typed port). A future refactor could
 * expose `SessionStore.materializeSnapshot(id)` if more callers need it.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';

import type { SessionStore } from '../ports/SessionStore.js';
import { NotFoundError } from './errors.js';

export interface SaveSnapshotInput {
  sessionId: string;
}

export interface SnapshotV1 {
  version: 1;
  origName: string;
  archiveVersion: number;
  archiveInfo: Record<string, unknown> | null;
  schemaBinB64: string | null;
  messageJson: string;
  sidecars: Array<{ name: string; b64: string }>;
}

export class SaveSnapshot {
  constructor(private readonly sessionStore: SessionStore) {}

  async execute({ sessionId }: SaveSnapshotInput): Promise<SnapshotV1> {
    const session = this.sessionStore.getById(sessionId);
    if (!session) throw new NotFoundError(`session ${sessionId} not found`);
    const messagePath = this.sessionStore.resolvePath(sessionId, 'extracted', '04_decoded', 'message.json');
    const schemaBinPath = this.sessionStore.resolvePath(sessionId, 'extracted', '03_decompressed', 'schema.kiwi.bin');
    const containerDir = this.sessionStore.resolvePath(sessionId, 'extracted', '01_container');
    const archiveInfoPath = this.sessionStore.resolvePath(sessionId, 'extracted', '02_archive', '_info.json');

    if (!existsSync(messagePath)) {
      throw new Error('message.json missing');
    }
    const messageJson = readFileSync(messagePath, 'utf8');
    const schemaBinB64 = existsSync(schemaBinPath)
      ? readFileSync(schemaBinPath).toString('base64')
      : null;
    const archiveInfo = existsSync(archiveInfoPath)
      ? (JSON.parse(readFileSync(archiveInfoPath, 'utf8')) as Record<string, unknown>)
      : null;

    const sidecars: Array<{ name: string; b64: string }> = [];
    function collect(dirPath: string, prefix: string): void {
      if (!existsSync(dirPath)) return;
      for (const f of readdirSync(dirPath).sort()) {
        const p = `${dirPath}/${f}`;
        if (statSync(p).isDirectory()) collect(p, `${prefix}${f}/`);
        else sidecars.push({ name: `${prefix}${f}`, b64: readFileSync(p).toString('base64') });
      }
    }
    collect(containerDir, '');

    return {
      version: 1,
      origName: session.origName,
      archiveVersion: session.archiveVersion,
      archiveInfo,
      schemaBinB64,
      messageJson,
      sidecars,
    };
  }
}
