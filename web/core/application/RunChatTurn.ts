/**
 * Use case: run one chat turn end-to-end.
 *
 * Picks the right ChatAdapter based on `authMode`, primes it with a
 * Document summary as system prompt, runs an agentic loop that lets the
 * model call up to 5 turns of tools, and returns the assistant text +
 * the actions that landed.
 *
 * Subscription path: AgentSdkChat owns the SDK loop internally — the
 * tool-hook injection lets us route MCP tool calls back through the
 * ToolDispatcher.
 *
 * API-key path: the multi-turn loop lives here (the model returns
 * tool_use blocks; we apply each via the dispatcher and feed
 * tool_result blocks back into the next turn).
 */

import type { ChatAdapter, ChatMessage, ToolSpec } from '../ports/ChatAdapter.js';
import type { ToolDispatcher } from '../ports/ToolDispatcher.js';
import type { SessionStore } from '../ports/SessionStore.js';
import { NotFoundError, AuthRequiredError } from './errors.js';
import { summarizeDoc } from '../domain/summary.js';

export type AuthMode = 'subscription' | 'api-key';

export interface RunChatTurnInput {
  sessionId: string;
  messages: ChatMessage[];
  selectedGuid: string | null;
  model: string;
  authMode: AuthMode;
  apiKey?: string;
}

export interface RunChatTurnOutput {
  assistantText: string;
  actions: Array<{ tool: string; input: unknown }>;
}

interface AgentSdkChatLike extends ChatAdapter {
  toolHook: (name: string, input: Record<string, unknown>) => Promise<void>;
}

export class RunChatTurn {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly tools: ToolDispatcher,
    private readonly adapters: { subscription: AgentSdkChatLike; apiKey: ChatAdapter },
  ) {}

  async execute(input: RunChatTurnInput): Promise<RunChatTurnOutput> {
    const session = this.sessionStore.getById(input.sessionId);
    if (!session) throw new NotFoundError(`session ${input.sessionId} not found`);

    if (input.authMode === 'api-key' && !input.apiKey) {
      throw new AuthRequiredError('api-key mode requires apiKey header');
    }

    const summary = summarizeDoc(session.documentJson, input.selectedGuid);
    const systemPrompt = `You are a design assistant editing a Figma file via tool calls.
Document summary:
${summary}`;
    const tools: ToolSpec[] = this.tools.catalogue();

    if (input.authMode === 'subscription') {
      const actions: Array<{ tool: string; input: unknown }> = [];
      // Wire the agent SDK's MCP tool callbacks back into our dispatcher.
      this.adapters.subscription.toolHook = async (name, toolInput) => {
        const outcome = await this.tools.apply(input.sessionId, { name, input: toolInput });
        if (!outcome.ok) throw new Error(outcome.error);
        actions.push({ tool: name, input: toolInput });
      };
      const result = await this.adapters.subscription.runTurn({
        model: input.model,
        messages: input.messages,
        systemPrompt,
        tools,
        timeoutMs: 90_000,
      });
      // The subscription SDK already accumulates `actions` via toolHook;
      // its runTurn's toolCalls echo is empty in this implementation.
      return { assistantText: result.assistantText, actions };
    }

    // api-key path: agentic loop owned here.
    const conversation = [...input.messages];
    const actions: Array<{ tool: string; input: unknown }> = [];
    let assistantText = '';
    for (let turn = 0; turn < 5; turn++) {
      const result = await this.adapters.apiKey.runTurn({
        model: input.model,
        messages: conversation,
        systemPrompt: `${systemPrompt}\nUse the tools to make the user's requested edits. Be concise.`,
        tools,
        apiKey: input.apiKey,
      });
      assistantText += result.assistantText;
      if (result.toolCalls.length === 0) break;
      // Apply each tool call locally; build tool_result content block (carried
      // as a synthetic assistant/user pair for the next turn).
      const followups: ChatMessage[] = [];
      for (const call of result.toolCalls) {
        const outcome = await this.tools.apply(input.sessionId, call);
        actions.push({ tool: call.name, input: call.input });
        followups.push({
          role: 'assistant',
          content: `(tool ${call.name} ${outcome.ok ? 'ok' : 'error: ' + outcome.error})`,
        });
      }
      conversation.push(...followups);
    }
    return { assistantText: assistantText || '(no text)', actions };
  }
}
