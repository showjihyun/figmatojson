# spec/web-undo-redo

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/core/application/Undo.ts`, `web/core/application/Redo.ts` |
| 테스트 | `web/core/application/UndoRedo.test.ts`, `web/server/adapters/driven/applyTool.test.ts` (cumulative + interleave 블록), `web/e2e/undo-redo.spec.ts` |
| 의존 | `EditJournal` port (`web/core/ports/EditJournal.ts`), `applyPatches` 헬퍼 (Undo.ts에서 export) |

## 1. 목적

세션의 편집 히스토리를 LIFO로 되감고/되감기를 취소한다. 모든 mutation 유스케이스(EditNode / ResizeNode / OverrideInstanceText / applyTool 의 모든 chat tool)는 성공 시 한 건의 `JournalEntry` 를 `record` 한다. Undo 는 가장 최근 `past` 엔트리를 꺼내 각 patch 의 `before` 를 적용하고, Redo 는 가장 최근 `future` 엔트리의 `after` 를 적용한다.

세션 단위 (`sessionId`) 로 격리 — 다른 세션의 히스토리는 서로에게 보이지 않는다. 메모리 기반 (`InMemoryEditJournal`) 으로 서버 재시작 시 휘발한다 (PoC 범위; production 은 별도 작업).

## 2. Input / Output

```ts
UndoInput  = { sessionId: string }
RedoInput  = { sessionId: string }
UndoOutput = { ok: boolean, undoneLabel: string | null, past: number, future: number }
RedoOutput = { ok: boolean, redoneLabel: string | null, past: number, future: number }
```

- `ok=false` 는 빈 스택에서 호출됐음을 의미한다 — 에러가 아니다 (UI 에서 버튼 disabled 처리용).
- `undoneLabel` / `redoneLabel` 는 `JournalEntry.label` 그대로 (예: `"Edit"`, `"Resize"`, `"AI: duplicate"`).
- `past` / `future` 는 호출 후의 스택 깊이. UI 가 매 호출마다 별도 GET 없이 affordance 를 갱신할 수 있도록 응답에 포함.

## 3. Stack invariants

- I-1 `record(entry)` → `past.push(entry)` 한 뒤 `future` 를 비운다 (모든 표준 undo-stack 의 표준 동작 — 새 분기가 생기면 redo 미래는 사라짐).
- I-2 `popUndo` 성공 후, 동일 엔트리가 `future` 로 옮겨진다. Undo→Redo 는 같은 엔트리를 사용해 라운드트립한다.
- I-3 `popRedo` 성공 후, 동일 엔트리가 `past` 로 옮겨진다.
- I-4 `MAX_ENTRIES` (`InMemoryEditJournal` 에서 100) 초과 시 `record` 는 가장 오래된 past 엔트리를 drop. Redo 미래는 cap 의 영향을 받지 않는다 (Redo 진행 중에는 새 record 가 들어올 일이 없으므로).
- I-5 빈 스택에서 `popUndo` / `popRedo` 는 `null` 을 반환 — 어떤 mutation 도 일어나지 않고, message.json / documentJson 도 변경되지 않는다.
- I-6 세션이 destroy 되어도 journal 은 그대로 남는다 (PoC; production 은 cascade 가 필요할 수 있음). 다만 destroy 된 세션에 대한 `Undo.execute` 는 `NotFoundError` 로 throw 한다 — `popUndo` 가 호출되기 전에.

## 4. Patch invariants

`JournalEntry.patches` 의 각 `PatchPair = {guid, field, before, after}` 는 두 종류 중 하나:

### 4.1 Leaf patch (set_text / set_position / set_size / fill / cornerRadius / align / instance-override / EditNode / ResizeNode)

- I-L1 `guid` 는 실제 노드 GUID (`"sessionID:localID"`). `field` 는 도트/브래킷 경로 (예: `"textData.characters"`, `"transform.m02"`).
- I-L2 `applyPatches` 는 `findNode(guid)` 로 `msg.nodeChanges` 에서 해당 노드를 찾아 `setPath(node, tokens, value)` 로 in-place mutation 한다. 그 후 `documentJson` 에서 같은 GUID 노드를 walk 로 찾아 동일 mutation 을 mirror.
- I-L3 노드가 발견되지 않으면 (`findNode` returns undefined) 해당 patch 는 silently skip — 다른 patch 들은 계속 적용된다 (atomic 보장 없음, 단일 entry 안의 부분 실패는 허용).
- I-L4 leaf patch 만 든 entry 는 `documentJson` 의 wholesale rebuild 를 트리거하지 않는다.

### 4.2 Structural patch (duplicate / group / ungroup)

- I-S1 `guid === MSG_SENTINEL_GUID` (= `"__msg__"`) 이고 `field === "nodeChanges"` 인 patch 는 sentinel 로 인식된다.
- I-S2 sentinel patch 의 `before` / `after` 는 각각 `nodeChanges` 배열 전체의 deep clone (`clone(msg.nodeChanges)`). leaf patch 와 달리 단일 필드 경로가 아니라 트리 전체의 스냅샷.
- I-S3 sentinel 처리: `msg.nodeChanges = pick === 'before' ? patch.before : patch.after`. `setPath` / `findNode` 경로를 거치지 않고 `continue`.
- I-S4 entry 안에 sentinel patch 가 한 건이라도 있으면, `applyPatches` 는 모든 patch 처리 후 `s.documentJson = rebuildDocumentFromMessage(JSON.stringify(msg))` 로 클라이언트 트리를 재생성한다.
- I-S5 leaf + sentinel 혼합 entry 는 발행되지 않는다 (현재 mutation use case 중 어느 것도 둘을 한 entry 에 묶지 않음). 만약 미래에 발행되면 patch 적용 순서에 의존하게 되므로 spec 변경이 선행되어야 한다.

## 5. Round-trip property

- I-R1 임의의 mutation 시퀀스 `M1, M2, ..., Mn` 후 `Undo×n` 을 적용하면, 각 mutation 의 `before` 가 LIFO 순으로 적용되어 message.json 은 baseline 과 byte-for-byte 동일해진다 (단일 mutation entry 내부에 leaf-skip(I-L3)이 발생하지 않은 경우에 한해). `after` 클론 시점에 `JSON.stringify` 가 결정적이고 노드별 key 삽입 순서가 보존되기 때문.
- I-R2 동일 시퀀스 후 `Undo×n → Redo×n` 은 message.json 을 시퀀스 직후 상태로 되돌린다.
- I-R3 group/ungroup 의 ungroup-side 는 `between()` 으로 새 position 문자열을 생성하므로 자기 자신이 idempotent 하지 않다 (`web-group-ungroup.spec.md §5`). Undo 는 idempotence 가 아니라 **journal-recorded snapshot 의 정확한 재적용** 으로 baseline 을 보장한다 — 두 성질을 혼동하지 말 것.

## 6. Error cases

- I-E1 `getById(sessionId)` 가 null → `NotFoundError(\`session \${id} not found\`)` 로 throw. journal 은 건드리지 않는다.
- I-E2 빈 스택 → `ok: false`, `undoneLabel: null` (또는 `redoneLabel`). throw 하지 않는다 (I-5).
- I-E3 `applyPatches` 도중 fs 쓰기 실패 → 호출자에게 throw, journal 은 이미 pop 된 상태이므로 sequence 가 깨진다. (현재 PoC 한계 — atomic write 도입 후 별도 보강 필요. `#3 Atomic write` 작업 참조.)

## 7. 라우팅 결합

- `POST /api/undo/:id` — body 없음. 응답: `UndoOutput`.
- `POST /api/redo/:id` — body 없음. 응답: `RedoOutput`.
- 클라이언트는 키보드 단축키 (`Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z`) 를 이 엔드포인트에 매핑.

## 8. 비대상

- **Branching history (tree-style undo)** — 단순 LIFO 두 스택만. 다중 분기는 선언적으로 폐기.
- **Persistent journal** — 메모리 한정. 서버 재시작 시 모든 히스토리 손실. snapshot save/load (`web-snapshot.spec.md`) 도 journal 을 포함하지 않는다.
- **Cross-session undo** — 다른 세션의 mutation 을 되돌릴 수 없음 (각 세션의 stack 은 독립).
- **Undo-of-undo collapse** — 동일한 mutation 을 두 번 연속 record 해도 합쳐지지 않는다 (예: 같은 노드의 set_text 를 빠르게 두 번 → 두 entry). UX 에서 debounce 가 필요하면 호출자 책임.
- **Selective undo** — 특정 entry 만 골라 되돌리는 동작은 없음. 항상 stack top.

## 9. Resolved questions

- **`_componentTexts` refresh on undo of set_text master** — Undo 의 leaf patch 처리는 master 노드의 `textData.characters` 만 되돌린다. INSTANCE 들의 `_componentTexts` 캐시는 갱신하지 않으므로, undo 후 인스펙터를 다시 열 때까지 stale 한 master 텍스트를 보일 수 있다. 알려진 한계 — UX 가 문제될 경우 별도 보강.
- **structural patch 와 leaf patch 의 entry 통합 가능성** — 현재 mutation use case 중 어느 것도 둘을 한 entry 에 섞지 않는다. 만약 미래에 한 turn 에 leaf + structural 을 묶어 atomic 하게 처리하려면, `applyPatches` 의 patch 적용 순서가 documentJson rebuild 와 충돌하지 않도록 명시해야 한다 (현재는 sentinel 처리 후 leaf walk 가 rebuild 직전에 일어나므로 leaf walk 결과가 손실될 수 있음 — I-S4 참조).
- **`MAX_ENTRIES` 정책** — 100 은 PoC 임의값. user 세션 길이 추적이 가능해지면 재조정. cap 도달 시 oldest 가 silently drop 되므로 UI 상에서 affordance 변화 없음 — 그게 적정한지 별도 검증.
