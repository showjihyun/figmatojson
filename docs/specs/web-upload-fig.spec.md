# spec/web-upload-fig

| 항목 | 값 |
|---|---|
| 상태 | Approved (Phase 7) |
| 구현 | `web/core/application/UploadFig.ts` |
| 테스트 | `web/core/application/UploadFig.test.ts` |
| 부모 | [docs/SPEC-architecture.md](../SPEC-architecture.md), [SDD.md](../SDD.md) |

## 1. 목적

raw `.fig` 바이트를 받아 워킹 세션을 생성한다. 디코드 + 추출은 `SessionStore.create`에 위임하고, 결과의 요약(페이지/노드 카운트)을 클라이언트가 헤더에 표시할 수 있게 반환한다.

## 2. Input / Output

```ts
input  = { bytes: Uint8Array, origName: string }
output = { sessionId: string, origName: string, pageCount: number, nodeCount: number }
```

## 3. Invariants

- I-1 `output.sessionId` 는 새로 생성된 세션의 ID이며 `SessionStore.getById(id)` 로 조회 가능
- I-2 `output.pageCount` = 생성된 documentJson의 children 중 `type === 'CANVAS'` 개수
- I-3 `output.nodeCount` = documentJson 트리의 모든 노드 개수 (children 재귀 포함)
- I-4 디코드 실패 시 호출자에게 `Error`가 전파되며 임시 디렉터리는 정리된다 (SessionStore.create 책임)

## 4. Error cases

- 잘못된 .fig 바이트 → `Error` (kiwi decode failure)
- 빈 입력 (length 0) → `Error`
- `tree.document` 미존재 → `Error: 'no DOCUMENT root in tree'`

## 5. 비대상

- 인증 (이 PoC는 세션 단위 인증 없음)
- 사용자/조직 분리
- 파일 검증 (확장자, 사이즈 제한)

## 6. 라우팅 결합

`POST /api/upload` 라우트(`web/server/adapters/driving/http/uploadRoute.ts`)가 multipart body를 파싱 후 본 use case 호출. 응답은 `output`을 그대로 JSON으로 반환.
