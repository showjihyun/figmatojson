/**
 * Domain entity: a working session — one uploaded .fig in a workspace.
 *
 * The session owns:
 *   - an opaque id (used as URL key)
 *   - a working directory layout that mirrors `extracted/` from the CLI
 *     (01_container/canvas.fig, 03_decompressed/schema.kiwi.bin,
 *      04_decoded/message.json, 01_container/images/<sha1>)
 *   - the in-memory decoded Document tree
 *   - the original filename (preserved for export download headers)
 *   - the .fig archive version (needed when repacking — kiwi schema
 *     compatibility)
 *
 * `dir` is a string here (not a typed file handle) on purpose: the port
 * `SessionStore` is what owns the actual filesystem semantics. Callers that
 * receive a `Session` should treat `dir` as opaque and only pass it back
 * to the SessionStore that produced it.
 */

import type { Document } from './Document';

export interface Session {
  id: string;
  dir: string;
  origName: string;
  archiveVersion: number;
  documentJson: Document;
}
