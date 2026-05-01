/**
 * api-key-mode chat adapter.
 *
 * Talks to the Anthropic SDK directly with a user-supplied `sk-ant-...` key.
 * Implements the ChatAdapter port — the RunChatTurn use case (Phase 4) will
 * own the agentic loop on top.
 *
 * Today this adapter does ONE messages.create() call and returns the first
 * tool_use block it sees. The agentic multi-turn loop (5 iterations,
 * apply tool calls, send tool_result back) lives in the legacy route
 * handler and will move into the use case as part of Phase 4 — the port
 * is shaped to match that future caller.
 */

import type {
  ChatAdapter,
  ChatTurnInput,
  ChatTurnResult,
} from '../../../core/ports/ChatAdapter.js';

export class AnthropicChat implements ChatAdapter {
  async runTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
    if (!input.apiKey) throw new Error('AnthropicChat requires apiKey');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: input.apiKey });
    const response = await client.messages.create({
      model: input.model,
      max_tokens: 1024,
      system: input.systemPrompt,
      tools: input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as never,
      })) as never,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    let assistantText = '';
    const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
    for (const block of response.content) {
      if (block.type === 'text') assistantText += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }
    return { assistantText, toolCalls };
  }
}
