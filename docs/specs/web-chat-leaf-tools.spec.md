# spec/web-chat-leaf-tools

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/server/adapters/driven/applyTool.ts` 의 `set_text` / `set_position` / `set_size` / `set_fill_color` / `set_corner_radius` / `align_nodes` 케이스 |
| 테스트 | `web/server/adapters/driven/applyTool.test.ts` |
| 의존 | `EditJournal` port, `ToolDispatcher` 카탈로그 (`InProcessTools.ts`) |
| 형제 | `web-chat-duplicate.spec.md` (structural), `web-group-ungroup.spec.md` (structural), `web-edit-node.spec.md` / `web-resize-node.spec.md` / `web-instance-override.spec.md` (HTTP route 측면) |

## 1. 목적

AI 채팅 (`Apply edits via the figma_editor tools.`) 으로부터 호출되는 leaf-mutation 도구들을 한 곳에서 정의한다. 각 도구는 단일 노드(또는 align 의 경우 N개 노드의 m02/m12) 의 특정 필드를 mutation 하고, 한 건의 `JournalEntry` 를 발행한다.

leaf 도구들의 공통 패턴:
- `applyTool(s, name, input, journal)` 로 진입.
- `findNode(guid)` 로 `msg.nodeChanges` 에서 대상 노드를 찾는다.
- 노드 in-place mutation → `writeFileSync(messagePath, JSON.stringify(msg))` → `mirrorClient(guid, mutator)` 로 client tree 동기화 → `recordChatEdit(label, patches)` 로 journal 에 기록.
- 출력은 void — `ToolDispatcher` 가 `{ok: true}` 로 wrap.

structural 도구 (`duplicate` / `group` / `ungroup`) 와 달리:
- patch 는 leaf shape `{guid, field, before, after}` 로 발행 (`MSG_SENTINEL_GUID` 사용 금지).
- `documentJson` 의 wholesale rebuild 트리거하지 않음 (`mirrorClient` 로 in-place 갱신).

`web-edit-node` / `web-resize-node` / `web-instance-override` 는 같은 의미의 mutation 을 HTTP route 로 받는 **별개의 surface** 다 — 본 spec 은 chat tool 분기만 다룬다.

## 2. 공통 invariants

이하 모든 도구에 적용:

- I-C1 진입 시 `findNode` 가 노드를 찾지 못하면 `Error("node <guid> not found")` (또는 도구별 prefix). throw 전에 어떤 write 도 일어나지 않는다 — disk / journal 미오염.
- I-C2 성공 시 정확히 한 건의 `JournalEntry` 가 record 된다. label = `"AI: <tool>"` (align 은 `"AI: align <axis>"`).
- I-C3 patch 의 `before` 는 mutation 직전의 값, `after` 는 mutation 직후의 값. 두 값 모두 deep clone (객체/배열은 `clone(...)` = `JSON.parse(JSON.stringify(...))` 로) — 이후 추가 mutation 으로 인한 aliasing 을 방지.
- I-C4 mutation 은 `msg.nodeChanges` 의 해당 노드를 in-place 로 변경한 뒤 `writeFileSync` 로 디스크에 동기 반영. 동일 변경이 `s.documentJson` 에도 `mirrorClient` 로 mirror.
- I-C5 `record` 호출은 disk write 이후에 일어난다 — write 가 throw 하면 journal 도 오염되지 않는다 (atomic write 도입 후 보장 강화 — `web-undo-redo.spec.md §6 I-E3` 참조).
- I-C6 동일한 `applyTool` 호출 안에서는 한 도구만 실행 (switch). 여러 도구를 batch 하는 contract 는 dispatcher 레벨에서 N회 호출로 표현.

## 3. set_text

```ts
input  = { guid: string, value: string }
output = void
label  = 'AI: set_text'
patches = [{ guid, field: 'textData.characters', before, after }]
```

- I-T1 `node.textData.characters` 가 `String(value)` 로 설정. `textData` 가 없으면 빈 객체로 만든 뒤 설정.
- I-T2 `before` 는 mutation 직전의 `textData.characters` 값. textData 자체가 없었다면 `undefined`.
- I-T3 master text(`guid`) 가 INSTANCE 들의 `_componentTexts[]` 에 캐시되어 있는 경우, `documentJson` 트리를 walk 하며 `r.guid === input.guid` 인 모든 항목의 `r.characters` 도 `after` 로 갱신 (인스펙터 component-text 패널 즉시 반영).
- I-T4 INSTANCE 의 per-instance override (`symbolData.symbolOverrides` / `_instanceOverrides`) 는 변경하지 않음 — 이 도구는 master 만 건드린다 (override 는 `override_instance_text` 의 책임).
- I-T5 (알려진 한계) Undo of set_text 는 `_componentTexts` 캐시를 갱신하지 않음 (`web-undo-redo.spec.md §9` 참조).

## 4. set_position

```ts
input  = { guid: string, x: number, y: number }
output = void
label  = 'AI: set_position'
patches = [
  { guid, field: 'transform.m02', before, after },
  { guid, field: 'transform.m12', before, after },
]
```

- I-P1 `node.transform.m02 ← Number(x)`, `node.transform.m12 ← Number(y)`. transform 객체가 없으면 빈 객체로 만든 뒤 설정.
- I-P2 회전 채널 (`m00/m01/m10/m11`) 은 변경하지 않음 — 이 도구는 translation 만.
- I-P3 patch 는 항상 두 건 (`m02`, `m12`) — x/y 중 하나만 바뀌었어도 둘 다 발행 (호출자가 기존값 그대로 다시 넣은 경우 before === after 인 patch 가 기록됨).
- I-P4 단위는 `transform` 의 native 단위 (px). 호출자가 음수를 보내면 음수 그대로 적용.

## 5. set_size

```ts
input  = { guid: string, w: number, h: number }
output = void
label  = 'AI: set_size'
patches = [
  { guid, field: 'size.x', before, after },
  { guid, field: 'size.y', before, after },
]
```

- I-Z1 `node.size = { x: max(1, Number(w)), y: max(1, Number(h)) }`. 0 이하 입력은 1 로 클램프.
- I-Z2 `before` 는 mutation 직전의 `size.x` / `size.y`. size 가 없었다면 둘 다 `undefined`.
- I-Z3 `transform` 은 변경하지 않음 — 위치 고정.
- I-Z4 size 객체 전체가 새 객체로 교체된다 (in-place 가 아닌 reassign) — 기존 size 의 다른 키 (`width`/`height` 등 비표준) 가 있었다면 사라진다. 현재 kiwi 출력에는 `x`/`y` 만 있어 회귀 위험 없음.

## 6. set_fill_color

```ts
input  = { guid: string, r: number, g: number, b: number, a: number }
output = void
label  = 'AI: set_fill_color'
patches = [{ guid, field: 'fillPaints', before, after }]
```

- I-F1 `node.fillPaints[0].color = { r, g, b, a }` (모두 `Number(...)` 로 강제). `fillPaints[0]` 가 없으면 `{type:'SOLID', visible:true, opacity:1}` 로 새로 생성.
- I-F2 `fillPaints[1..]` 는 변경하지 않음 — 첫 번째 paint 만 색을 바꾼다.
- I-F3 patch 의 `before` / `after` 는 fillPaints 배열 전체의 deep clone. 단일 색상 변경이라도 배열 전체가 들어가는 이유: paint 는 type / visible / opacity / blendMode / color / gradientStops / image 등 다층 객체라 단일 path 로 표현하기 부담스럽다.
- I-F4 r/g/b/a 는 0..1 범위 가정. 범위 밖 값에 대한 clamp 는 없음 — 호출자가 책임.

## 7. set_corner_radius

```ts
input  = { guid: string, value: number }
output = void
label  = 'AI: set_corner_radius'
patches = [{ guid, field: 'cornerRadius', before, after }]
```

- I-R1 `node.cornerRadius = max(0, Number(value))`. 음수 입력은 0 으로 클램프.
- I-R2 `rectangleCornerRadiiData` (per-corner) 는 건드리지 않음 — uniform radius 만.
- I-R3 노드 타입 검증 없음 — TEXT 같이 cornerRadius 가 의미 없는 노드에 호출해도 그대로 적용. 렌더링이 무시한다.

## 8. align_nodes

```ts
input  = { guids: string[], axis: 'left'|'center'|'right'|'top'|'middle'|'bottom' }
output = void
label  = `AI: align ${axis}`
patches = (axis 에 따라 transform.m02 또는 transform.m12 의 N건)
```

- I-A1 `guids.length < 2` → `Error("align_nodes needs >= 2 guids")`. 0 / 1 은 정렬 의미 없음.
- I-A2 모든 `guids` 는 존재해야 함 — 한 개라도 `findNode` 실패하면 `Error("node <guid> not found")`. 부분 mutation 없음.
- I-A3 그룹 bbox = `(min(x), min(y))` ~ `(max(x+w), max(y+h))` — 멤버들의 `transform.m02/m12` 와 `size.x/y` 만으로 계산 (회전 고려 안 함, AABB).
- I-A4 axis 별 새 m02/m12:
  - `left`   → `m02 = groupX`
  - `center` → `m02 = (groupX + groupRight) / 2 - w/2`
  - `right`  → `m02 = groupRight - w`
  - `top`    → `m12 = groupY`
  - `middle` → `m12 = (groupY + groupBottom) / 2 - h/2`
  - `bottom` → `m12 = groupBottom - h`
- I-A5 patch 는 변경된 축에 대한 것만 발행 — horizontal axis (`left`/`center`/`right`) 는 m02 N건, vertical (`top`/`middle`/`bottom`) 은 m12 N건. 변경되지 않은 축은 patch 에 없다 (Undo 가 잘못된 축으로 이동시키는 것을 방지).
- I-A6 멤버 중 일부가 이미 정렬 위치에 있어도 patch 는 발행 (before === after). I-P3 와 동일한 이유.
- I-A7 미지원 axis → `Error("align_nodes: unknown axis <axis>")`.
- I-A8 멤버들의 `parentIndex` 는 변경하지 않음 — align 은 transform 만 만진다.

## 9. Error cases (모든 도구 공통)

- 세션 미존재 → 호출자 (`ToolDispatcher`) 가 `findNode` 도달 전에 throw.
- 노드 미존재 → I-C1.
- mutation 도중 `writeFileSync` 실패 → 호출자에게 throw, journal 미오염 (atomic write 도입 후 보장 강화).
- align 의 axis 검증 → I-A7. 다른 도구는 input 검증 없음 — 호출자가 잘못된 타입을 보내면 `Number(...)` / `String(...)` 로 강제 변환.

## 10. 비대상

- **input schema validation** — JSON-schema / zod 검증 없음. `ToolDispatcher` 가 카탈로그 레벨에서 wrap 하지만, 본 dispatcher 레벨에서는 type coercion 만 (예: `Number(input.x)`).
- **batch in single tool call** — 한 도구는 한 노드만 (align 제외). 여러 노드 변경은 dispatcher 가 도구를 N회 호출.
- **stride / step alignment** — align_nodes 는 그룹 정렬만. 일정 간격 분배 (distribute horizontally 등) 는 별도 도구 후보.
- **rotated bbox** — align_nodes 의 bbox 계산은 회전된 멤버에 대해 OBB 가 아닌 AABB (`web-group-ungroup.spec.md §8` 와 동일 한계).
- **textData 의 lines 배열 동기화** — set_text 는 `characters` 만 갱신, `lines` 의 styling segments 는 그대로. 1줄 / 단일-스타일 가정. 다중 스타일 텍스트의 부분 수정은 별도 도구.

## 11. 라우팅 결합

- 채팅 전용 — HTTP 직접 노출 없음. `POST /api/chat/:id` → `RunChatTurn` → `ToolDispatcher.dispatch` → `applyTool`.
- 사용자 수동 인스펙터의 leaf 편집은 별도 surface 로 진입 (`PATCH /api/doc/:id` → `EditNode` 등) — 본 spec 은 채팅 분기만.

## 12. Resolved questions

- **set_text 의 `_componentTexts` 즉시 갱신 vs Undo 시 갱신** — forward 경로(I-T3)에서는 mirror 하지만 Undo 의 `applyPatches` 는 master 만 되돌리고 `_componentTexts` 캐시는 그대로. 의도된 차이 — Undo 는 leaf-level 만 처리하며 도구별 후처리(component-text refresh)는 모르는 게 옳다고 판단. UX 가 문제 시 Undo 후 인스펙터 재오픈으로 갱신 가능.
- **set_size 의 1px 클램프** — 0 이하는 렌더링 사이드에서 NaN/Infinity 의 원인이 될 수 있어 도구 진입 시 1로 강제. 호출자는 클램프된 값이 disk 에 들어간 것을 확인하고 다음 호출에 반영해야 함.
- **set_fill_color 의 fillPaints[0] 만 변경** — multi-paint 노드의 두 번째 이상 fill 을 변경하는 케이스는 매우 드물어 v1 에서 punt. 필요 시 `fillIndex` 옵션 추가 (별도 spec).
