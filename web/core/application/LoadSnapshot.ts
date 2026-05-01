/**
 * Use case: re-create a working session from a v1 snapshot.
 *
 * Builds the same on-disk extracted/ layout the upload path produces, then
 * adopts it as a session. Returns the new session id + summary.
 *
 * IO is direct fs because the snapshot encoding is JSON-portable bytes
 * (base64'd binary sidecars) — wrapping each write in a port doesn't pay
 * off here. A `SessionStore.adopt(session)` method registers the synthetic
 * Session in the in-memory map after the directory is materialized.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildTree } from '../../../src/tree.js';
import type { TreeNode } from '../../../src/types.js';

import type { Session } from '../domain/entities/Session.js';
import { ValidationError } from './errors.js';
import { toClientNode, buildSymbolIndex } from '../domain/clientNode.js';
import type { SnapshotV1 } from './SaveSnapshot.js';

interface FsLikeStore {
  adopt(session: Session): void;
}

export interface LoadSnapshotOutput {
  sessionId: string;
  origName: string;
  pageCount: number;
  nodeCount: number;
}

function ensureDirSync(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export class LoadSnapshot {
  constructor(private readonly sessionStore: FsLikeStore) {}

  async execute(snapshot: SnapshotV1): Promise<LoadSnapshotOutput> {
    if (snapshot.version !== 1) {
      throw new ValidationError(`unsupported snapshot version: ${snapshot.version}`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'figrev-web-'));
    try {
      const extractedDir = join(dir, 'extracted');
      const decompDir = join(extractedDir, '03_decompressed');
      const decodedDir = join(extractedDir, '04_decoded');
      const archiveDir = join(extractedDir, '02_archive');
      const containerDir = join(extractedDir, '01_container');
      for (const d of [decompDir, decodedDir, archiveDir, containerDir]) ensureDirSync(d);

      if (snapshot.schemaBinB64) {
        writeFileSync(join(decompDir, 'schema.kiwi.bin'), Buffer.from(snapshot.schemaBinB64, 'base64'));
      }
      writeFileSync(join(decodedDir, 'message.json'), snapshot.messageJson);
      writeFileSync(
        join(archiveDir, '_info.json'),
        JSON.stringify({ version: snapshot.archiveVersion ?? 106, ...(snapshot.archiveInfo ?? {}) }),
      );
      for (const sc of snapshot.sidecars) {
        const dest = join(containerDir, sc.name);
        ensureDirSync(dirname(dest));
        writeFileSync(dest, Buffer.from(sc.b64, 'base64'));
      }
      // Restore the undo journal if the snapshot carried one — FsEditJournal
      // lazy-hydrates from this file on first access against the new sessionId.
      if (snapshot.historyJson) {
        writeFileSync(join(dir, '.history.json'), snapshot.historyJson);
      }

      const messageObj = JSON.parse(snapshot.messageJson, (_, v) => {
        if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).__bytes === 'string') {
          return Uint8Array.from(Buffer.from((v as { __bytes: string }).__bytes, 'base64'));
        }
        return v;
      });
      const tree = buildTree(messageObj as never);
      if (!tree.document) throw new Error('snapshot has no DOCUMENT root');
      const blobs = (messageObj as { blobs?: Array<{ bytes: Uint8Array }> }).blobs ?? [];
      const symbolIndex: Map<string, TreeNode> = buildSymbolIndex(tree.allNodes.values());
      const documentJson = toClientNode(tree.document, blobs, symbolIndex);

      const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      this.sessionStore.adopt({
        id,
        dir,
        origName: snapshot.origName,
        archiveVersion: snapshot.archiveVersion,
        documentJson,
      });
      return {
        sessionId: id,
        origName: snapshot.origName,
        pageCount: tree.document.children.filter((n) => n.type === 'CANVAS').length,
        nodeCount: tree.allNodes.size,
      };
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }
}
