import type { Hono } from 'hono';
import type { Deps } from './deps.js';
import { toHttpError } from './errors.js';

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);

export function registerChatRoute(app: Hono, deps: Deps): void {
  app.post('/api/chat/:id', async (c) => {
    try {
      const body = (await c.req.json()) as {
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        selectedGuid?: string | null;
        model?: string;
        authMode?: 'subscription' | 'api-key';
      };
      const authMode: 'subscription' | 'api-key' =
        body.authMode === 'api-key' ? 'api-key' : 'subscription';
      const model = body.model && ALLOWED_MODELS.has(body.model) ? body.model : 'claude-opus-4-6';

      let apiKey: string | undefined;
      if (authMode === 'api-key') {
        const headerKey = c.req.header('x-anthropic-key') ?? '';
        if (!headerKey.startsWith('sk-ant-')) {
          return c.json({ error: 'missing or invalid x-anthropic-key header' }, 401);
        }
        apiKey = headerKey;
      }

      const out = await deps.runChatTurn.execute({
        sessionId: c.req.param('id'),
        messages: body.messages,
        selectedGuid: body.selectedGuid ?? null,
        model,
        authMode,
        apiKey,
      });
      return c.json({ assistantText: out.assistantText, actions: out.actions });
    } catch (err) {
      return toHttpError(c, err);
    }
  });
}
