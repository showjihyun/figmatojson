# spec/web-edit-node

| 항목 | 값 |
|---|---|
| 상태 | Approved (Phase 7) |
| 구현 | `web/core/application/EditNode.ts` |
| 테스트 | `web/core/application/EditNode.test.ts` |
| 부모 | [docs/ARCHITECTURE.md](../ARCHITECTURE.md) |

## 1. 목적

세션의 단일 노드에서 임의 필드를 PATCH한다. 수정은 `extracted/04_decoded/message.json`(repack source-of-truth)에 즉시 기록되며, 클라이언트가 새로 fetch하지 않아도 다음 `GET /api/doc/:id` 가 변경을 보도록 in-memory documentJson에도 동시 반영한다.

## 2. Input / Output

```ts
input  = { sessionId: string, nodeGuid: string, field: string, value: unknown }
output = { ok: true }
```

`field` 는 도트/브래킷 경로 (`textData.characters`, `fillPaints[0].color.r`).

## 3. Invariants

- I-1 PATCH 후 `extracted/04_decoded/message.json`을 다시 디코드하면 새 `value`가 `field` 위치에 존재
- I-2 `session.documentJson` 트리에서 동일 GUID 노드를 찾으면 같은 `value`가 같은 `field` 위치에 존재
- I-3 `field === 'textData.characters'` 이고 `value`가 string이면, 트리 내 모든 INSTANCE의 `_componentTexts[]` 중 `guid === nodeGuid` 인 항목의 `characters` 가 새 값으로 갱신됨 (인스펙터의 component-text 패널이 재로드 없이 갱신된다)
- I-4 message.json의 다른 노드/필드는 변경되지 않음 (단일 노드 단일 필드 변경)

## 4. Error cases

- 세션 미존재 → `NotFoundError(\`session \${id} not found\`)`
- 노드 미존재 → `NotFoundError(\`node \${guid} not found\`)`
- `field` 가 빈 문자열 → `ValidationError('empty field path')`

## 5. 비대상

- 트랜잭션/롤백 (단일 mutation)
- 다중 필드 batch (호출자가 N번 호출)
- 타입 검증 (서버는 `value`를 그대로 둠 — 호출자 책임)

## 6. 라우팅 결합

`PATCH /api/doc/:id`. body = `{nodeGuid, field, value}`.
