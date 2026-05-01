import type { Hono } from 'hono';
import type { Deps } from './deps.js';
import { toHttpError } from './errors.js';

export function registerSaveRoute(app: Hono, deps: Deps): void {
  app.post('/api/save/:id', async (c) => {
    try {
      const out = await deps.exportFig.execute({ sessionId: c.req.param('id') });
      // Content-Disposition: HTTP headers are ByteString (≤ 0xFF) so we use
      // RFC 5987 filename* for non-ASCII (Korean / etc.) plus an ASCII fallback.
      const baseAscii = out.origName.replace(/\.fig$/, '').replace(/[^\x20-\x7e]/g, '_');
      const baseUtf8 = encodeURIComponent(out.origName.replace(/\.fig$/, ''));
      return new Response(out.bytes as unknown as ArrayBuffer, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition':
            `attachment; filename="${baseAscii}-edited.fig"; filename*=UTF-8''${baseUtf8}-edited.fig`,
          'X-Repack-Bytes': String(out.bytes.byteLength),
        },
      });
    } catch (err) {
      return toHttpError(c, err);
    }
  });
}
