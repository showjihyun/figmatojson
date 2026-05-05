import type { Hono } from 'hono';
import type { Deps } from './deps.js';
import { toHttpError } from './errors.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');

export function registerAuditRoute(app: Hono, deps: Deps): void {
  app.post('/api/audit/compare', async (c) => {
    try {
      const body = await c.req.json<{ sessionId?: string; figmaTree?: unknown }>();
      if (typeof body.sessionId !== 'string' || !body.figmaTree) {
        return c.json({ error: 'sessionId and figmaTree required' }, 400);
      }
      // P3 verification — dump incoming Plugin tree for composite-ID
      // matching follow-up. Remove once round 31 closes.
      if (process.env.AUDIT_DUMP_PLUGIN_TREE === '1') {
        try {
          const dumpDir = resolve(repoRoot, 'docs', 'audit-roundtrip');
          mkdirSync(dumpDir, { recursive: true });
          writeFileSync(resolve(dumpDir, '_last-plugin-tree.json'), JSON.stringify({
            receivedAt: new Date().toISOString(),
            sessionId: body.sessionId,
            figmaTree: body.figmaTree,
          }, null, 2));
        } catch { /* non-fatal */ }
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
