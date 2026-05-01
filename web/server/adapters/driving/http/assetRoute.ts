import type { Hono } from 'hono';
import type { Deps } from './deps.js';
import { toHttpError } from './errors.js';

export function registerAssetRoute(app: Hono, deps: Deps): void {
  app.get('/api/asset/:id/:hash', async (c) => {
    try {
      const asset = await deps.serveAsset.execute({
        sessionId: c.req.param('id'),
        hashHex: c.req.param('hash'),
      });
      return c.body(asset.bytes as unknown as ArrayBuffer, 200, {
        'Content-Type': asset.mime,
        'Content-Length': String(asset.bytes.byteLength),
        'Cache-Control': 'private, max-age=3600',
      });
    } catch (err) {
      return toHttpError(c, err);
    }
  });
}
