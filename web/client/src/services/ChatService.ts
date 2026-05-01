/**
 * ChatService — AI chat round-trip.
 *
 * One call to `send()` produces the assistant's response + the list of
 * tool actions the agent applied. Chooses subscription vs api-key auth
 * based on the input; the api-key path adds the `x-anthropic-key`
 * header. Components don't see any of this — they call `send()` and
 * render the result.
 */

export type AuthMode = 'subscription' | 'api-key';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatAction {
  tool: string;
  input: unknown;
}

export interface ChatSendInput {
  sessionId: string;
  messages: ChatMessage[];
  selectedGuid?: string | null;
  model: string;
  authMode: AuthMode;
  apiKey?: string;
}

export interface ChatSendResult {
  assistantText: string;
  actions: ChatAction[];
}

export interface ChatService {
  send(input: ChatSendInput): Promise<ChatSendResult>;
}

export class ChatHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ChatHttpError';
  }
}

class HttpChatService implements ChatService {
  async send(input: ChatSendInput): Promise<ChatSendResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (input.authMode === 'api-key' && input.apiKey) {
      headers['x-anthropic-key'] = input.apiKey;
    }
    const r = await fetch(`/api/chat/${input.sessionId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: input.messages,
        selectedGuid: input.selectedGuid ?? null,
        model: input.model,
        authMode: input.authMode,
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new ChatHttpError(`chat failed: ${r.status} ${text}`, r.status);
    }
    return (await r.json()) as ChatSendResult;
  }
}

export const chatService: ChatService = new HttpChatService();
