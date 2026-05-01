import type { Hono } from 'hono';
import type { Deps } from './deps.js';
import { toHttpError } from './errors.js';

export function registerUploadRoute(app: Hono, deps: Deps): void {
  app.post('/api/upload', async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) {
      return c.json({ error: 'no file uploaded' }, 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const out = await deps.uploadFig.execute({ bytes, origName: file.name });
      return c.json(out);
    } catch (err) {
      return toHttpError(c, err);
    }
  });
}
