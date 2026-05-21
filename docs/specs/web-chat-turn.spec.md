# spec/web-chat-turn

| Item | Value |
|---|---|
| Status | Approved (Phase 7) |
| Implementation | `web/core/application/RunChatTurn.ts` |
| Tests | `web/core/application/RunChatTurn.test.ts` (mock ChatAdapter + ToolDispatcher) |

## 1. Purpose

Accept the user's natural-language request, send it to Claude, and apply tool calls Claude requests via ToolDispatcher. Two authentication modes are supported:

- **subscription** (default) — uses Claude Code's local login (`~/.claude/`). The AgentSdkChat adapter owns the SDK's multi-turn loop.
- **api-key** — calls Anthropic SDK directly with a `sk-ant-...` header. This use case owns the multi-turn loop (max 5 turns).

## 2. Input / Output

```ts
input = {
  sessionId: string,
  messages: Array<{role: 'user'|'assistant', content: string}>,
  selectedGuid: string | null,
  model: string,
  authMode: 'subscription' | 'api-key',
  apiKey?: string,
}
output = {
  assistantText: string,
  actions: Array<{tool: string, input: unknown}>,  // tool calls applied to doc
}
```

## 3. Invariants

- I-1 `authMode === 'api-key'` and `apiKey` missing → `AuthRequiredError`
- I-2 Session not found → `NotFoundError`
- I-3 The system prompt starts with the result of `summarizeDoc(documentJson, selectedGuid)` — the model sees the current session's document context
- I-4 All catalogue tools of ToolDispatcher are exposed to the model (in subscription mode, AgentSdkChat wires the same 5 tools via zod)
- I-5 Each tool call made by the model is applied via `ToolDispatcher.apply(sessionId, call)`. An outcome with `ok === false` is not thrown to the caller; it is dropped from the actions array as-is (in api-key mode, it is reported to the model on the next turn via a `(tool ... error: ...)` follow-up message)
- I-6 (api-key mode only) 5-turn limit — if the model does not terminate, break after the 5th turn

## 4. Error cases

- `AuthRequiredError` (api-key without key)
- `NotFoundError` (session)
- Internal ChatAdapter errors (Anthropic 401, 504 timeout, etc.) → `Error` propagated. AgentSdkChat's 90s abort propagates as the message `subscription chat timed out after 90s`

## 5. Out of scope

- Multilingual system prompts (currently fixed to English)
- Streaming responses (PoC returns the full response in one shot)
- Persistent storage of past conversations (the caller re-sends the messages array each turn)
- Safety guardrails (any mutation the model requests is applied as-is — the UI shows the actions, so they are visible, but they are not blocked)

## 6. Routing coupling

`POST /api/chat/:id`. If the body has `authMode === 'api-key'`, the route validates the `x-anthropic-key` header and then forwards it to the use case as `apiKey`. The model is passed in after the route validates it against the whitelist.
