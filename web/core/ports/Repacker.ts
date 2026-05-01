/**
 * Driven port: encode a Document + extracted/ artifacts back into a .fig.
 *
 * Today's adapter is `KiwiCodec` — wraps `src/repack.ts` (`mode: 'json'`).
 * The interface is intentionally session-keyed because the repack pipeline
 * needs the working directory's `extracted/` tree (sidecars, schema,
 * images) — passing those through arguments would couple application code
 * to filesystem semantics.
 */
export interface Repacker {
  /**
   * Repack the session's current `documentJson` back to a .fig byte buffer
   * suitable for download. Implementations MUST flush any pending mutation
   * on the session (or accept a freshly-flushed session from the caller)
   * before encoding.
   */
  repack(sessionId: string): Promise<RepackResult>;
}

export interface RepackResult {
  bytes: Uint8Array;
  /** Round-trip diagnostics (bytes count per artifact) for the report panel. */
  files: Array<{ name: string; bytes: number }>;
}
