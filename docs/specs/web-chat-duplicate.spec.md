# spec/web-chat-duplicate

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/server/adapters/driven/applyTool.ts` 의 `'duplicate'` 케이스 |
| 테스트 | `web/server/adapters/driven/applyTool.test.ts` (`describe('duplicate')` 블록 + 누적/혼합 undo 스트레스) |
| 의존 | `__msg__` sentinel patch + `rebuildDocumentFromMessage`, `between()` (fractional-index) |
| 형제 | `web-group-ungroup.spec.md` (동일 sentinel 패턴), `web-chat-leaf-tools.spec.md` (leaf 패턴), `web-undo-redo.spec.md` |

## 1. 목적

AI 채팅 도구 `duplicate` 는 단일 노드와 그 하위 트리 전체를 복제해 같은 부모의 다음 sibling 으로 삽입한다. group/ungroup 과 마찬가지로 트리 구조를 변경하므로 `__msg__` sentinel + `nodeChanges` 전체 스냅샷 patch 패턴을 사용한다.

쓰임:
- "이 카드 한 번 더 복사해줘" 같은 일상적 요청.
- 사용자 수동 Cmd+D 가 아직 인스펙터에 없을 때의 유일한 복제 경로 (채팅 전용).

## 2. Input / Output

```ts
input  = { guid: string, dx?: number, dy?: number }
output = void
label  = 'AI: duplicate'
patches = [{ guid: '__msg__', field: 'nodeChanges', before, after }]
```

- `guid` 는 복제할 root 노드. 이 노드의 모든 후손 (parentIndex.guid 로 연결된 직간접 자손) 이 함께 복제된다.
- `dx` / `dy` 는 root clone 의 transform offset (default 20px 씩). 후손 clone 들의 transform 은 변경하지 않음 — root 만 이동.

## 3. Invariants

### 3.1 Subtree discovery (BFS by parentIndex.guid)

- I-S1 root + 후손 집합은 `msg.nodeChanges` 의 flat list 위에서 BFS 로 수집한다 — `parentIndex.guid` 가 currently-known node 를 가리키는 노드들을 반복 추가.
- I-S2 root 의 후손이 0개여도 OK (단일 노드 복제). subtree.length === 1.
- I-S3 INSTANCE 노드의 symbolData 가 가리키는 master / component 노드는 후손이 아니다 — `parentIndex.guid` 가 가리키지 않으므로 BFS 범위 밖. 복제 결과는 원본 INSTANCE 와 동일한 master 를 참조한다 (instance 자체만 새 GUID, master 는 공유).

### 3.2 GUID 할당

- I-G1 `nextLocalId = max(localID in msg.nodeChanges) + 1`. subtree 의 모든 노드에 대해 `{sessionID: 0, localID: nextLocalId++}` 로 새 GUID 발급. group/ungroup 과 동일 규칙.
- I-G2 `guidMap: Map<oldKey, newGuid>` 에 모든 매핑을 저장 — 후손 clone 의 `parentIndex.guid` rewrite 에 사용.
- I-G3 sessionID 는 0 (현재 사용자 세션) 으로 통일. multi-user collaboration 은 비대상.

### 3.3 Root clone

- I-R1 root clone 의 `parentIndex.guid` = 원본의 `parentIndex.guid` (같은 부모 아래 sibling 으로 삽입).
- I-R2 root clone 의 `parentIndex.position` = `between(원본.position, null)` — 원본보다 lex 큰 새 position 문자열. 다음 sibling 이 실제로 존재해도 `between` 의 alphabet padding 으로 인해 원본 < clone < 다음sibling 이 보장된다.
- I-R3 root clone 의 `transform.m02 = 원본.m02 + dx`, `transform.m12 = 원본.m12 + dy`. 회전 채널 (m00/m01/m10/m11) 은 그대로.
- I-R4 root 가 `parentIndex` 가 없는 경우 (DOCUMENT 등 root 노드) → `parentIndex` 도 없는 채로 clone 된다 (현재 코드 경로). 의미 없는 호출이라 호출자 책임.

### 3.4 Descendant clone

- I-D1 후손 clone 의 `parentIndex.guid` = `guidMap` 에서 lookup 한 새 부모 GUID — 원본 부모 (subtree 안의 다른 노드) 가 아니라 그 노드의 clone 을 가리킨다.
- I-D2 후손 clone 의 `parentIndex.position` = 원본 그대로 — clone 된 부모 안에서의 sibling lex 순서가 원본과 동일하게 유지.
- I-D3 후손 clone 의 `transform`, `size`, `fillPaints`, `textData`, `symbolData` 등 나머지 필드는 원본의 deep clone 그대로. dx/dy offset 은 root 에만 적용.
- I-D4 INSTANCE 후손 clone 의 `symbolData.symbolOverrides` 는 verbatim copy — `guidPath` 가 master text 의 GUID 를 절대 경로로 참조하므로 parent 변경에 영향받지 않는다 (`web-group-ungroup.spec.md §10 `guidPath` 갱신` 와 동일 근거).

### 3.5 Journal / message / documentJson

- I-J1 `beforeNodeChanges = clone(msg.nodeChanges)` 를 진입 시점에 캡처.
- I-J2 mutation 후 `msg.nodeChanges = [...원본 배열, ...cloned]` (cloned 는 BFS 순서 — root 가 첫 항목, 후손은 그 뒤).
- I-J3 `writeFileSync(messagePath, JSON.stringify(msg))` 로 디스크 동기 반영.
- I-J4 `s.documentJson = rebuildDocumentFromMessage(JSON.stringify(msg))` 로 client tree 재생성. group/ungroup 과 동일 — leaf 도구의 `mirrorClient` 와 달리 wholesale rebuild.
- I-J5 `recordChatEdit('duplicate', [{guid: '__msg__', field: 'nodeChanges', before: beforeNodeChanges, after: clone(msg.nodeChanges)}])`. label = `"AI: duplicate"`.

## 4. Round-trip with Undo

- I-U1 Undo 는 `MSG_SENTINEL_GUID` 분기에서 `msg.nodeChanges = before` 로 swap 하고 `documentJson` 을 rebuild — clone 된 모든 노드가 사라진다 (`web-undo-redo.spec.md §4.2`).
- I-U2 N회 연속 duplicate 후 N회 Undo → `nodeChanges` 가 baseline byte-for-byte 동일 (테스트: `applyTool.test.ts` cumulative undo 블록).
- I-U3 duplicate 와 leaf 도구를 섞어 호출한 뒤 Undo 해도 baseline 으로 복원 (테스트: 동일 파일의 mixed leaf+structural interleave 블록).

## 5. Error cases

- I-E1 root 노드 미존재 → `Error("node <guid> not found")`. throw 전 어떤 disk write 도 일어나지 않는다.
- I-E2 `findNode` 가 root 만 검증 — 후손이 BFS 도중 사라지는 경우는 불가능 (단일 호출 안에서 race 없음).
- I-E3 `dx` / `dy` 가 NaN / non-numeric 이면 `Number(...)` 강제 변환 결과 NaN 이 transform 에 들어갈 수 있음 — 호출자 책임 (current 한계).
- I-E4 `nodeChanges` 가 매우 커서 `JSON.stringify` 가 메모리 한계에 닿는 경우는 비대상 (current PoC 35K-node 까지 검증).

## 6. 비대상

- **deep duplicate of an INSTANCE master** — INSTANCE 만 복제할 수 있고, INSTANCE 가 참조하는 master/component 는 복제하지 않는다. master 까지 복제하려면 별도 도구 (master-detach 등).
- **link-preserving duplicate** — clone 된 INSTANCE 끼리 변수/스타일이 자동으로 동기화되는 등의 동작 없음.
- **smart positioning** — dx/dy 는 단순 offset. 캔버스 빈 공간 자동 탐색은 별도 도구 (`mcp__pencil__find_empty_space_on_canvas` 류, 본 코드베이스 비대상).
- **multi-source duplicate** — 한 호출에 한 root 만. 여러 노드를 동시에 복제하려면 dispatcher 가 N회 호출.

## 7. 라우팅 결합

채팅 전용. 사용자 수동 인스펙터에 Cmd+D 추가 시:
- `POST /api/duplicate/:sid` body `{guid, dx?, dy?}` 로 노출 가능.
- 같은 use case (`applyTool` 의 duplicate 분기) 호출.

## 8. Resolved questions

- **default offset 20px 의 적정성** — Figma 자체 Cmd+D 도 ~20px offset 으로 복제 — 동일 UX 채택. 호출자가 0 을 명시하면 원본과 정확히 겹친다 (현재 의도된 동작).
- **descendant 의 parentIndex.position 보존 vs 재생성** — 원본 그대로 유지 (I-D2). 어차피 새 parent 안의 lex 순서만 의미 있으므로 충돌 없음. ungroup 처럼 `between` 으로 ladder 할 필요 없음.
- **`fillPaints` 의 `imageRef` 같은 binary asset 참조** — `clone(...)` = `JSON.parse(JSON.stringify(...))` 가 처리 — Uint8Array 는 `__bytes` reviver tag 로 round-trip (`messageJson.ts:25` 참조). 단순 hash 참조는 string 으로 그대로 복제됨.
