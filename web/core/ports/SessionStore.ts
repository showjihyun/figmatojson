import type { Session } from '../domain/entities/Session';

/**
 * Driven port: persistence for working sessions.
 *
 * Today's only adapter is `FsSessionStore` (mkdtempSync + readFileSync +
 * AdmZip), but defining the port keeps `application/` use cases ignorant
 * of "tmp dir" and "writeFile" — they get a Session by id and can read/
 * mutate `documentJson` without touching disk.
 *
 * Implementations are responsible for:
 *  - Atomic writeback of `documentJson` → `extracted/04_decoded/message.json`
 *    after every mutation, so subsequent reads (and Repacker) see the latest.
 *  - TTL / cleanup of orphaned sessions (PoC may skip; production must).
 */
export interface SessionStore {
  /**
   * Create a new working session from raw .fig bytes. Must extract and
   * decode the bytes such that `getById` can return a Session whose
   * `documentJson` reflects the file. Returns the new session id.
   */
  create(figBytes: Uint8Array, origName: string): Promise<Session>;

  /**
   * Resolve an existing session, or null if expired / unknown. Adapters
   * MUST NOT throw on miss — that's a 404 at the routing layer.
   */
  getById(id: string): Session | null;

  /**
   * Persist any in-memory mutations on the session's `documentJson` back
   * to disk so a subsequent Repacker pickup sees the change.
   */
  flush(id: string): Promise<void>;

  /**
   * Resolve an absolute path under the session's working directory.
   * Used by AssetServer to locate `extracted/01_container/images/<hash>`
   * without leaking the directory layout to the application layer.
   */
  resolvePath(id: string, ...segments: string[]): string;

  /** Drop the session and release its working directory. */
  destroy(id: string): Promise<void>;
}
