import type { Hono } from 'hono';
import type { Deps } from './deps.js';
import { toHttpError } from './errors.js';

export function registerSnapshotRoutes(app: Hono, deps: Deps): void {
  app.get('/api/session/:id/snapshot', async (c) => {
    try {
      const out = await deps.saveSnapshot.execute({ sessionId: c.req.param('id') });
      return c.json(out);
    } catch (err) {
      return toHttpError(c, err);
    }
  });

  app.post('/api/session/load', async (c) => {
    try {
      const body = (await c.req.json()) as {
        version: number;
        origName: string;
        archiveVersion: number;
        schemaBinB64: string | null;
        messageJson: string;
        sidecars: Array<{ name: string; b64: string }>;
        archiveInfo?: Record<string, unknown>;
        historyJson?: string | null;
      };
      const out = await deps.loadSnapshot.execute({
        version: body.version as 1,
        origName: body.origName,
        archiveVersion: body.archiveVersion,
        schemaBinB64: body.schemaBinB64,
        messageJson: body.messageJson,
        sidecars: body.sidecars,
        archiveInfo: body.archiveInfo ?? null,
        historyJson: body.historyJson ?? null,
      });
      return c.json(out);
    } catch (err) {
      return toHttpError(c, err);
    }
  });
}
