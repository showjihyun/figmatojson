/**
 * Subscription-mode chat adapter.
 *
 * Uses `@anthropic-ai/claude-agent-sdk`'s `query()` which auto-discovers the
 * user's local Claude Code login (`~/.claude/`). Tools are exposed via an
 * in-process MCP server so the agent can invoke them by name.
 *
 * Implements ChatAdapter — the RunChatTurn use case will pick this adapter
 * when `authMode === 'subscription'`.
 *
 * Includes the 90s abort timeout the legacy route added during the /qa pass:
 * if `claude login` hasn't run on this machine, the call hangs without an
 * error — the timeout surfaces a clear "run claude login or switch to
 * api-key mode" message.
 */

import type {
  ChatAdapter,
  ChatTurnInput,
  ChatTurnResult,
} from '../../../core/ports/ChatAdapter.js';

/**
 * Hook the use case provides for the adapter to invoke a tool call:
 * the use case wraps it around the dispatcher so action records are
 * produced inside the SDK's MCP plumbing.
 */
export type AgentToolHook = (
  name: string,
  input: Record<string, unknown>,
) => Promise<void>;

export class AgentSdkChat implements ChatAdapter {
  /**
   * The use case sets this before calling runTurn() so that tool invocations
   * from inside the SDK go through the right ToolDispatcher. Falling back
   * to throwing prevents a silent no-op if the use case forgets.
   */
  toolHook: AgentToolHook = async () => {
    throw new Error('AgentSdkChat: toolHook not wired by caller');
  };

  async runTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { query, tool, createSdkMcpServer } = sdk;
    const z = (await import('zod')).z;

    const actions: Array<{ name: string; input: Record<string, unknown> }> = [];

    // The Agent SDK's `tool()` factory wants zod field shapes (not JSON
    // Schema). Rather than derive zod from the catalogue's JSON Schema
    // (which is what the api-key path consumes), we hardcode the 5 tool
    // shapes here — they match the catalogue exactly.
    const wrap = <T extends Record<string, unknown>>(
      name: string,
      fn: (i: T) => Promise<void>,
    ) =>
      async (raw: T) => {
        await fn(raw);
        actions.push({ name, input: raw });
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      };

    const editServer = createSdkMcpServer({
      name: 'figma_editor',
      tools: [
        tool('set_text', 'Set textData.characters of a TEXT node.',
          { guid: z.string(), value: z.string() },
          wrap('set_text', async (i: { guid: string; value: string }) =>
            this.toolHook('set_text', i)),
        ),
        tool('override_instance_text', 'Set per-instance text override; master is untouched.',
          { instanceGuid: z.string(), masterTextGuid: z.string(), value: z.string() },
          wrap('override_instance_text', async (i: { instanceGuid: string; masterTextGuid: string; value: string }) =>
            this.toolHook('override_instance_text', i)),
        ),
        tool('set_position', 'Move a node by setting transform.m02/m12.',
          { guid: z.string(), x: z.number(), y: z.number() },
          wrap('set_position', async (i: { guid: string; x: number; y: number }) =>
            this.toolHook('set_position', i)),
        ),
        tool('set_size', 'Resize a node by setting size.x and size.y.',
          { guid: z.string(), w: z.number(), h: z.number() },
          wrap('set_size', async (i: { guid: string; w: number; h: number }) =>
            this.toolHook('set_size', i)),
        ),
        tool('set_fill_color', 'Set fillPaints[0].color RGBA (each 0..1).',
          { guid: z.string(), r: z.number(), g: z.number(), b: z.number(), a: z.number() },
          wrap('set_fill_color', async (i: { guid: string; r: number; g: number; b: number; a: number }) =>
            this.toolHook('set_fill_color', i)),
        ),
      ],
    });

    const transcript = input.messages
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    const prompt = `${transcript}\n\nApply edits via the figma_editor tools. Be concise.`;

    const TIMEOUT_MS = input.timeoutMs ?? 90_000;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);

    let assistantText = '';
    try {
      const q = query({
        prompt,
        options: {
          model: input.model,
          abortController,
          mcpServers: { figma_editor: editServer },
          allowedTools: input.tools.map((t) => `mcp__figma_editor__${t.name}`),
          systemPrompt: input.systemPrompt,
          maxTurns: 5,
          permissionMode: 'bypassPermissions',
        } as never,
      });
      for await (const msg of q) {
        if ((msg as Record<string, unknown>).type === 'assistant') {
          const m = msg as { message?: { content?: Array<{ type: string; text?: string }> } };
          for (const block of m.message?.content ?? []) {
            if (block.type === 'text' && block.text) assistantText += block.text;
          }
        }
      }
    } catch (err) {
      const aborted = abortController.signal.aborted;
      if (aborted) {
        throw new Error(
          `subscription chat timed out after ${TIMEOUT_MS / 1000}s. ` +
            `Likely cause: Claude Code is not logged in on this machine. ` +
            `Run 'claude login' in a terminal, or switch to API Key mode.`,
        );
      }
      throw new Error(`subscription chat failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    return { assistantText: assistantText || '(no text)', toolCalls: actions };
  }
}
