/**
 * Filesystem-backed AssetServer.
 *
 * Streams image bytes from the session's `extracted/01_container/images/<hash>`
 * file and sniffs the MIME type from the magic bytes. Returns null on miss
 * so the route layer can format the 404 response as it likes.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { Asset, AssetServer } from '../../../core/ports/AssetServer.js';
import type { SessionStore } from '../../../core/ports/SessionStore.js';
import { sniffImageMime } from '../../../core/domain/image.js';

export class FsAssetServer implements AssetServer {
  constructor(private readonly sessionStore: SessionStore) {}

  async fetch(sessionId: string, hashHex: string): Promise<Asset | null> {
    const session = this.sessionStore.getById(sessionId);
    if (!session) return null;
    if (!/^[0-9a-f]{40}$/.test(hashHex)) return null;
    const path = this.sessionStore.resolvePath(
      sessionId,
      'extracted',
      '01_container',
      'images',
      hashHex,
    );
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    return {
      bytes: new Uint8Array(buf),
      mime: sniffImageMime(buf),
    };
  }
}
