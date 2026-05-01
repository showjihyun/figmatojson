import type { Hono } from 'hono';
import type { Deps } from './deps.js';
import { toHttpError } from './errors.js';

export function registerHistoryRoutes(app: Hono, deps: Deps): void {
  app.post('/api/undo/:id', async (c) => {
    try {
      const out = await deps.undo.execute({ sessionId: c.req.param('id') });
      return c.json(out);
    } catch (err) {
      return toHttpError(c, err);
    }
  });

  app.post('/api/redo/:id', async (c) => {
    try {
      const out = await deps.redo.execute({ sessionId: c.req.param('id') });
      return c.json(out);
    } catch (err) {
      return toHttpError(c, err);
    }
  });
}
