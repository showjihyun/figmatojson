import type { Hono } from 'hono';
import type { Deps } from './deps.js';
import { toHttpError } from './errors.js';

export function registerOverrideRoute(app: Hono, deps: Deps): void {
  app.post('/api/instance-override/:id', async (c) => {
    try {
      const body = (await c.req.json()) as {
        instanceGuid: string;
        masterTextGuid: string;
        value: string;
      };
      const out = await deps.overrideInstanceText.execute({
        sessionId: c.req.param('id'),
        instanceGuid: body.instanceGuid,
        masterTextGuid: body.masterTextGuid,
        value: body.value,
      });
      return c.json(out);
    } catch (err) {
      return toHttpError(c, err);
    }
  });
}
