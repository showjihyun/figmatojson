import type { Hono } from 'hono';
import type { Deps } from './deps.js';
import { toHttpError } from './errors.js';

export function registerDocRoutes(app: Hono, deps: Deps): void {
  app.get('/api/doc/:id', (c) => {
    const session = deps.sessionStore.getById(c.req.param('id'));
    if (!session) return c.json({ error: 'session not found' }, 404);
    return c.json(session.documentJson);
  });

  app.patch('/api/doc/:id', async (c) => {
    try {
      const body = (await c.req.json()) as {
        nodeGuid: string;
        field: string;
        value: unknown;
      };
      const out = await deps.editNode.execute({
        sessionId: c.req.param('id'),
        nodeGuid: body.nodeGuid,
        field: body.field,
        value: body.value,
      });
      return c.json(out);
    } catch (err) {
      return toHttpError(c, err);
    }
  });
}
