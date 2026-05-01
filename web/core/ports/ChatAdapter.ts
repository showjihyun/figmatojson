/**
 * Driven port: turn a chat transcript + tool definitions into an assistant
 * response, optionally with tool calls that the caller will dispatch.
 *
 * Two adapters today:
 *   - `AnthropicChat` (api-key path, uses the Anthropic SDK directly)
 *   - `AgentSdkChat` (subscription path, uses Claude Code's local login
 *     via @anthropic-ai/claude-agent-sdk, with a 90s abort timeout)
 *
 * The application use case (`RunChatTurn`) doesn't care which one is
 * wired — it picks based on the request's `authMode` and asks the
 * appropriate adapter for an assistant turn.
 */

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ToolSpec {
  /** Tool name as the model will see it (e.g. `set_text`). */
  name: string;
  description: string;
  /** JSON-Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface ChatTurnInput {
  model: string;
  /** User-visible prompt history; current user message is the last entry. */
  messages: ChatMessage[];
  /** Optional system prompt prepended by the adapter. */
  systemPrompt?: string;
  tools: ToolSpec[];
  /**
   * Adapter-specific credential. For AnthropicChat this is `sk-ant-...`;
   * for AgentSdkChat it's ignored (the adapter discovers the Claude Code
   * session locally).
   */
  apiKey?: string;
  /** Hard deadline in ms from the start of the call. */
  timeoutMs?: number;
}

export interface ChatTurnResult {
  /** Concatenated text content from the assistant turn. */
  assistantText: string;
  /** Tool invocations the assistant requested, in order. */
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
  }>;
}

export interface ChatAdapter {
  runTurn(input: ChatTurnInput): Promise<ChatTurnResult>;
}
