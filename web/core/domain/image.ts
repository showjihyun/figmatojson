/**
 * Image-related pure helpers (no IO, no framework).
 *
 * Two consumers today:
 *   - Server's GET /api/asset/:id/:hash — sniffs MIME from the bytes
 *   - Client's Canvas.tsx — converts a Figma image-hash byte object into
 *     the lowercase-hex form used as the asset URL key
 */

/**
 * Magic-byte MIME sniff for image bytes served from `extracted/01_container/
 * images/<hash>`. Returns 'application/octet-stream' on no match — the
 * route layer can decide what to do (today: still served, browser falls
 * back to its own sniff).
 */
export function sniffImageMime(buf: ArrayLike<number>): string {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  )
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return 'image/jpeg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
    return 'image/gif';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  )
    return 'image/webp';
  return 'application/octet-stream';
}

/**
 * Convert a Figma image hash (20-byte SHA-1) into its lowercase hex form.
 *
 * After JSON serialization the byte array arrives as either:
 *   - a plain object `{0: byte, 1: byte, ...}` (Uint8Array's default toJSON)
 *   - a regular array
 *   - a Uint8Array
 *
 * Returns null when the input doesn't conform to a 20-byte sequence —
 * caller treats that as "no image fill on this node".
 */
export function imageHashHex(node: any): string | null {
  const fills = node?.fillPaints;
  if (!Array.isArray(fills)) return null;
  const fp = fills.find((p: any) => p?.type === 'IMAGE' && p?.visible !== false);
  const h = fp?.image?.hash;
  if (!h) return null;
  const bytes: number[] = [];
  if (Array.isArray(h)) {
    for (const b of h) bytes.push(b as number);
  } else if (h instanceof Uint8Array) {
    for (let i = 0; i < h.length; i++) bytes.push(h[i]!);
  } else if (typeof h === 'object') {
    for (let i = 0; i < 20; i++) {
      const v = (h as Record<string, unknown>)[String(i)];
      if (typeof v !== 'number') return null;
      bytes.push(v);
    }
  } else {
    return null;
  }
  if (bytes.length !== 20) return null;
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
