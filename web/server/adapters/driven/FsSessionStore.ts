/**
 * Filesystem-backed implementation of the SessionStore port.
 *
 * Owns:
 *   - the in-memory id → Session map (no Redis / DB; PoC scope)
 *   - the per-session tmp working directory layout
 *     (figrev-web-XXXXX/ with in.fig + extracted/{01_container,
 *      03_decompressed, 04_decoded}/...)
 *   - flushing in-memory documentJson back to extracted/04_decoded/message.json
 *     so the Repacker picks up the latest edit
 *
 * Uses the same kiwi pipeline as the CLI (loadContainer → decodeFigCanvas →
 * dumpStage*) so a session directory is bit-identical to what
 * `figma-reverse extract` produces, and `repack --mode json` works on it.
 */

import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadContainer } from '../../../../src/container.js';
import { decodeFigCanvas } from '../../../../src/decoder.js';
import { buildTree } from '../../../../src/tree.js';
import {
  dumpStage1Container,
  dumpStage3Decompressed,
  dumpStage4Decoded,
  dumpStage5Tree,
} from '../../../../src/intermediate.js';

import type { Session } from '../../../core/domain/entities/Session.js';
import type { SessionStore } from '../../../core/ports/SessionStore.js';
import {
  toClientNode,
  buildSymbolIndex,
} from '../../../core/domain/clientNode.js';

export class FsSessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  async create(figBytes: Uint8Array, origName: string): Promise<Session> {
    const dir = mkdtempSync(join(tmpdir(), 'figrev-web-'));
    try {
      const inPath = join(dir, 'in.fig');
      writeFileSync(inPath, figBytes);
      const container = loadContainer(inPath);
      const decoded = decodeFigCanvas(container.canvasFig);
      const tree = buildTree(decoded.message);
      if (!tree.document) throw new Error('no DOCUMENT root in tree');

      const intOpts = {
        enabled: true,
        dir: join(dir, 'extracted'),
        includeFullMessage: true,
        minify: true,
      };
      dumpStage1Container(intOpts, container);
      dumpStage3Decompressed(intOpts, decoded);
      dumpStage4Decoded(intOpts, decoded);
      dumpStage5Tree(intOpts, tree);

      const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const blobs = (decoded.message as { blobs?: Array<{ bytes: Uint8Array }> }).blobs ?? [];
      const symbolIndex = buildSymbolIndex(tree.allNodes.values());
      const documentJson = toClientNode(tree.document, blobs, symbolIndex);

      const session: Session = {
        id,
        dir,
        origName,
        archiveVersion: decoded.archiveVersion,
        documentJson,
      };
      this.sessions.set(id, session);
      return session;
    } catch (err) {
      // Best-effort cleanup if extraction failed — caller surfaces the error.
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Adopt an already-prepared working directory as a new session — used by
   * the snapshot-load path, which materializes extracted/ from base64 sidecars
   * and then needs to register the directory with the store.
   */
  adopt(session: Session): void {
    this.sessions.set(session.id, session);
  }

  getById(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }

  /**
   * Flush the in-memory documentJson back to message.json. The Repacker
   * reads from disk, so without this the export would lose recent edits.
   *
   * Today the inspector's PATCH endpoint already writes message.json
   * inline before mutating documentJson; this method is the canonical
   * surface for use cases that don't yet do their own write.
   */
  async flush(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    const messagePath = join(s.dir, 'extracted', '04_decoded', 'message.json');
    if (!existsSync(messagePath)) return;
    // documentJson is the spread-data view, NOT the raw kiwi message — so
    // we DON'T blindly serialize it. Instead, the inline PATCH path already
    // mirrors edits to message.json. This method is a no-op placeholder
    // until use cases stop writing message.json themselves; when they do,
    // we'll serialize the patch journal here.
    void messagePath;
  }

  resolvePath(id: string, ...segments: string[]): string {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session ${id} not found`);
    return join(s.dir, ...segments);
  }

  async destroy(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    rmSync(s.dir, { recursive: true, force: true });
    this.sessions.delete(id);
  }

  /** Direct access for the legacy route handlers during the migration. */
  rawMap(): Map<string, Session> {
    return this.sessions;
  }

  /** Allow the snapshot-load handler to write its own message.json bytes. */
  writeMessage(id: string, json: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session ${id} not found`);
    writeFileSync(join(s.dir, 'extracted', '04_decoded', 'message.json'), json);
  }

  /** Read message.json — used by the legacy PATCH/instance-override paths. */
  readMessage(id: string): string {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session ${id} not found`);
    return readFileSync(join(s.dir, 'extracted', '04_decoded', 'message.json'), 'utf8');
  }
}
