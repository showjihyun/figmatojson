import type { Document } from '../domain/entities/Document';

/**
 * Driven port: decode .fig binary bytes into a Document tree + sidecar
 * metadata that downstream Repacker / SessionStore needs.
 *
 * Today's adapter is `KiwiCodec` — wraps `src/decoder.ts` and
 * `src/intermediate.ts` from the CLI tool. Defining the port lets us
 * swap to a streaming decoder, a remote service, or a fixture for tests
 * without changing application code.
 */
export interface Decoder {
  decode(figBytes: Uint8Array): Promise<DecodeResult>;
}

export interface DecodeResult {
  document: Document;
  archiveVersion: number;
  /** Files we'll need to repack later: schema, images, sidecars. */
  extracted: ExtractedArtifacts;
}

export interface ExtractedArtifacts {
  /** Raw bytes of `01_container/canvas.fig` (kiwi-encoded payload + header). */
  canvasFig: Uint8Array;
  /** Decompressed kiwi schema (`03_decompressed/schema.kiwi.bin`). */
  schemaBin: Uint8Array;
  /** The decoded message as JSON-compatible object (`04_decoded/message.json`). */
  messageJson: unknown;
  /**
   * Sidecar files keyed by `name` relative to the container root, e.g.
   * `meta.json`, `thumbnail.png`, `images/<sha1>`.
   */
  sidecars: Array<{ name: string; bytes: Uint8Array }>;
}
