# spec/web-chat-turn

| 항목 | 값 |
|---|---|
| 상태 | Approved (Phase 7) |
| 구현 | `web/core/application/RunChatTurn.ts` |
| 테스트 | `web/core/application/RunChatTurn.test.ts` (mock ChatAdapter + ToolDispatcher) |

## 1. 목적

사용자의 자연어 요청을 받아 Claude 에게 보내고, Claude 가 요청한 tool 호출을 ToolDispatcher 로 적용한다. 두 가지 인증 모드를 모두 지원한다:

- **subscription** (default) — Claude Code 로컬 로그인 (`~/.claude/`) 사용. AgentSdkChat 어댑터가 SDK 의 multi-turn 루프를 소유.
- **api-key** — `sk-ant-...` 헤더로 Anthropic SDK 직접 호출. multi-turn 루프 (최대 5턴) 는 본 use case가 소유.

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

- I-1 `authMode === 'api-key'` 이고 `apiKey` 미제공 → `AuthRequiredError`
- I-2 세션 미존재 → `NotFoundError`
- I-3 시스템 프롬프트는 `summarizeDoc(documentJson, selectedGuid)` 결과로 시작 — 모델은 현재 세션의 문서 컨텍스트를 본다
- I-4 ToolDispatcher 의 모든 catalogue tool 이 모델에게 노출 (subscription 의 경우 AgentSdkChat 가 동일한 tool 5개를 zod로 wire)
- I-5 모델이 호출한 각 tool 은 `ToolDispatcher.apply(sessionId, call)` 로 적용되며, `ok === false` 인 outcome 은 호출자에게 throw 되지 않고 actions 배열에 그대로 누락 (api-key 모드: `(tool ... error: ...)` follow-up 메시지로 다음 턴에 모델에게 알림)
- I-6 (api-key 모드만) 5턴 한도 — 모델이 종료하지 않으면 5번째 턴 후 break

## 4. Error cases

- `AuthRequiredError` (api-key without key)
- `NotFoundError` (session)
- ChatAdapter 내부 오류 (Anthropic 401, 504 timeout 등) → `Error` 전파. AgentSdkChat 의 90s abort 는 `subscription chat timed out after 90s` 메시지로 전파

## 5. 비대상

- 다국어 시스템 프롬프트 (현재 영어 고정)
- streaming 응답 (현 PoC: 전체 응답 후 한 번에 반환)
- 이전 conversation 의 영구 저장 (호출자가 messages 배열을 매 턴 다시 보냄)
- 안전 가드레일 (모델이 원하는 임의 mutation 을 그대로 적용 — UI 가 actions 를 표시하므로 가시적이지만 차단은 안 함)

## 6. 라우팅 결합

`POST /api/chat/:id`. body 의 `authMode === 'api-key'` 이면 라우트가 `x-anthropic-key` 헤더를 검증 후 use case에 `apiKey` 로 전달. model 은 라우트가 화이트리스트 검증 후 전달.
