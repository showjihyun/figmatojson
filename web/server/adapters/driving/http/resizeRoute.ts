import type { Hono } from 'hono';
import type { Deps } from './deps.js';
import { toHttpError } from './errors.js';

export function registerResizeRoute(app: Hono, deps: Deps): void {
  app.post('/api/resize/:id', async (c) => {
    try {
      const body = (await c.req.json()) as {
        nodeGuid: string;
        x: number;
        y: number;
        w: number;
        h: number;
      };
      const out = await deps.resizeNode.execute({
        sessionId: c.req.param('id'),
        guid: body.nodeGuid,
        x: body.x,
        y: body.y,
        w: body.w,
        h: body.h,
      });
      return c.json(out);
    } catch (err) {
      return toHttpError(c, err);
    }
  });
}
