/**
 * Driven port: serve image bytes by their content hash.
 *
 * The Canvas renders IMAGE fillPaints by GET-ing
 * `/api/asset/<sessionId>/<sha1-hex>` — this port abstracts the lookup so
 * the route handler is just routing. Today's adapter is `FsAssetServer`,
 * which reads from `extracted/01_container/images/<hash>` under the
 * session directory.
 *
 * Returning null (instead of throwing) on miss lets the route layer
 * decide on the HTTP shape — typically 404.
 */
export interface AssetServer {
  /**
   * @param sessionId   target session
   * @param hashHex     40-char lowercase hex SHA-1 (already validated by
   *                    the route layer; adapter may re-validate)
   */
  fetch(sessionId: string, hashHex: string): Promise<Asset | null>;
}

export interface Asset {
  bytes: Uint8Array;
  /** Sniffed MIME ('image/png' / 'image/jpeg' / 'image/gif' / 'image/webp'). */
  mime: string;
}
