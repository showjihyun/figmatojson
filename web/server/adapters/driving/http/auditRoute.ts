import type { Hono } from 'hono';
import type { Deps } from './deps.js';
import { toHttpError } from './errors.js';

export function registerAuditRoute(app: Hono, deps: Deps): void {
  app.post('/api/audit/compare', async (c) => {
    try {
      const body = await c.req.json<{ sessionId?: string; figmaTree?: unknown }>();
      if (typeof body.sessionId !== 'string' || !body.figmaTree) {
        return c.json({ error: 'sessionId and figmaTree required' }, 400);
      }
      const out = await deps.auditCompare.execute({
        sessionId: body.sessionId,
        figmaTree: body.figmaTree as never,
      });
      return c.json(out);
    } catch (err) {
      return toHttpError(c, err);
    }
  });
}
