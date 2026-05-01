# spec/web-group-ungroup

| 항목 | 값 |
|---|---|
| 상태 | Draft |
| 구현 | (예정) `web/server/adapters/driven/applyTool.ts` 의 `'group'` / `'ungroup'` 케이스 |
| 테스트 | (예정) `web/server/adapters/driven/applyTool.test.ts` |
| 의존 | `__msg__` sentinel patch + `rebuildDocumentFromMessage` (이미 `duplicate` 로 검증됨) |

## 1. 목적

AI 채팅 (`Apply edits via the figma_editor tools.`) 도구로 GROUP 노드를 만들고 해체할 수 있게 한다. 사용자 수동 group/ungroup 도 동일 use case에 위임하면 코드 일원화.

기존 leaf-only 채팅 도구들과 달리 트리 구조를 바꾸는 작업 — `duplicate` 가 도입한 `__msg__` sentinel + `nodeChanges` 전체 스냅샷 patch 패턴 위에 올린다.

## 2. Input / Output

```ts
group   = { name: 'group',   input: { guids: string[], parentGuid?: string, name?: string } }
ungroup = { name: 'ungroup', input: { guid: string } }
```

- `group`: 2개 이상의 형제(sibling) 노드를 새 GROUP 으로 감싼다.
- `ungroup`: 정확히 한 GROUP 의 내용을 부모로 끌어올리고 GROUP 자체를 삭제.
- 출력은 다른 채팅 도구와 동일하게 void — `applyTool` 의 try/catch 밖에서 ToolDispatcher 가 `{ok}` 결과로 wrap.

## 3. Group invariants

- I-G1 `guids` 가 모두 같은 부모를 공유해야 함. 다른 부모면 `Error("group: guids must share a parent")`.
- I-G2 새 GROUP 의 `guid` 는 `nodeChanges` 의 max localID + 1 (sessionID 0). `duplicate` 와 동일 규칙.
- I-G3 새 GROUP 의 `parentIndex.guid` = 멤버들의 공통 부모. `parentIndex.position` = `between(min(memberPos), null)` — 멤버 중 가장 앞선 형제 자리에 들어간다 (즉 첫 번째 멤버가 있던 자리).
- I-G4 새 GROUP 의 `transform.m02 = min(member.transform.m02)`, `transform.m12 = min(member.transform.m12)` — 즉 멤버 bbox 의 좌상단.
- I-G5 새 GROUP 의 `size` = bbox of members (`{x: maxX - minX, y: maxY - minY}`).
- I-G6 각 멤버 노드:
  - `parentIndex.guid` ← 새 GROUP 의 guid
  - `parentIndex.position` ← 멤버들 사이 상대 순서 보존 (원래 position 그대로 — 새 부모 안에서도 lex 순서가 같으므로)
  - `transform.m02 -= GROUP.transform.m02` (부모-로컬 좌표로 변환)
  - `transform.m12 -= GROUP.transform.m12`
- I-G7 멤버의 `size`, 회전 채널 (`transform.m00/m01/m10/m11`), fillPaints, children 등은 변경되지 않음.
- I-G8 멤버 자식들은 변경되지 않음 — 자식들의 `parentIndex.guid` 는 여전히 멤버를 가리킨다 (간접 자손은 group 영향권 밖).
- I-G9 `journal.record` 는 `{guid: '__msg__', field: 'nodeChanges', before, after}` 한 건. label = `AI: group`.

## 4. Ungroup invariants

- I-U1 대상 노드의 `type === 'GROUP'` 이어야 함. 아니면 `Error("ungroup: target is not a GROUP")`.
- I-U2 GROUP 의 직속 자식 N개 각각:
  - `parentIndex.guid` ← GROUP 의 `parentIndex.guid` (할아버지)
  - `parentIndex.position` ← GROUP 이 차지하던 자리에서 시작해 `regenerate(N)` 비율로 분배. 즉 `between(GROUP.position, nextSiblingPos)` 구간을 N등분.
  - `transform.m02 += GROUP.transform.m02` (할아버지-로컬 좌표로 환원)
  - `transform.m12 += GROUP.transform.m12`
- I-U3 GROUP 노드 자체는 `nodeChanges` 에서 제거.
- I-U4 GROUP 의 직계 외 후손은 변경 없음 (자식의 자식 등은 자식 기준 로컬 좌표를 유지).
- I-U5 GROUP 이 비어있는 경우 (children 0개) → 단순 GROUP 삭제. 새로운 자식이 할아버지에 추가되지 않음.
- I-U6 `journal.record` label = `AI: ungroup`.

## 5. Round-trip property

`group([a, b]) → ungroup(g)` 이후 `nodeChanges` 는 a, b 의 transform/size/parentIndex 가 group 호출 직전과 동일해야 한다 (위치 부동소수 잡음 제외).
- 단 `parentIndex.position` 은 동일하지 않을 수 있다 — ungroup 의 N등분 결과 새 position 문자열이 들어간다. 형제 lex 순서는 보존.
- 즉 "wire-level identical" 이 아니라 "semantically identical" — 시각/구조는 동일.

## 6. Error cases

- 세션 미존재 → 기존 `applyTool` 의 처리 — `findNode` 가 throw.
- group 의 `guids.length < 2` → `Error("group needs >= 2 guids")`.
- group 의 멤버가 다른 부모 → I-G1.
- ungroup 의 대상이 GROUP 이 아님 → I-U1.
- group / ungroup 모두: 디스크 / journal 미변경 보장 (try 밖에서 throw, write 전에 검증).

## 7. Undo 모델

`duplicate` 와 동일 패턴 — `Undo.applyPatches` 의 `MSG_SENTINEL_GUID` 분기가 그대로 처리한다. 추가 코드 없음.

`group` 의 inverse 는 `before === pre-group nodeChanges`, `after === post-group nodeChanges`. Undo → before 복원 → `rebuildDocumentFromMessage` 로 documentJson 재생성. 같은 메커니즘.

## 8. 비대상

- **다중 부모 group**: 다른 부모를 가진 노드들을 한 group 에 모으기. 멤버를 공통 조상까지 끌어올려야 하는데 부모 컨테이너의 의미(`FRAME` vs `INSTANCE` 등)를 추론하기 어려움. v1 은 같은 부모만.
- **회전된 멤버**: 멤버가 0이 아닌 m00/m01/m10/m11 을 가지면 bbox 계산이 정확하지 않다 (회전 사각형의 AABB 가 아니라 OBB 가 필요). v1: 회전 멤버는 group 가능하지만 GROUP 의 size 가 OBB 가 아닌 AABB 로 계산되어 시각적으로 약간 어긋날 수 있음. 회전 노드 group 은 별도 spec 후보.
- **GROUP 안에 GROUP**: 중첩 자체는 허용 (제약 없음). 하지만 ungroup 은 한 단계만 — 재귀 ungroup 은 사용자가 반복 호출.
- **vector boolean group** (`BOOLEAN_OPERATION` 타입): 별도 도구. v1 은 `type: 'GROUP'` 만 생성.

## 9. 라우팅 결합

채팅 전용 — HTTP 직접 노출 없음. 사용자 수동 group/ungroup UI 가 추후 추가되면:
- `POST /api/group/:sid` — body `{guids, name?}`
- `POST /api/ungroup/:sid` — body `{guid}`
같은 use case (`applyTool`) 호출.

## 10. Open questions

- **`name` 자동생성**: 사용자가 `name` 을 안 줄 때 `"Group N"` (counter) 인지 첫 멤버 이름의 `"<name> group"` 인지. Figma 본 동작 확인 필요.
- **GROUP 의 fillPaints**: GROUP 은 본래 fill 을 가지지 않음 (자식이 그린다). 새 GROUP 노드의 fillPaints 는 빈 배열로 둘지 omit 할지 — kiwi schema 에서 required 인지 확인 후 결정.
- **`guidPath` 갱신**: instance override (`symbolData.symbolOverrides[].guidPath`) 가 group 멤버의 guid 를 참조하면 group 후에도 유효한가? guidPath 는 노드 guid 를 직접 가리키므로 부모 변경에 영향받지 않을 가능성이 높지만 e2e 검증 필요.
