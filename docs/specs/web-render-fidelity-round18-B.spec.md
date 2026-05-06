# spec/web-render-fidelity-round18-B

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/core/domain/colorStyleRef.ts` (`colorVarTrail`) + `web/client/src/Inspector.tsx` (FillSection / StrokeSection Style row) |
| 테스트 | `web/core/domain/colorStyleRef.test.ts` (trail case set) |
| 형제 | round 15 (`colorVarName` single-hop), round 18-A (`resolveVariableChain` chain walker) |

## 1. 배경

Round 15 의 Inspector Style row 는 첫 hop name 만 표시 — 메타리치 5:8
fill 의 `colorVar` alias `11:434` → `"Button/Primary/Default"`. 사용자
가 실제로 보고 싶은 정보는 종종 *그 변수가 어디서 오는지* — alias chain
의 leaf 까지 따라간 trail. 예:

```
Button/Primary/Default  →  Color/Blue/600
                                 ↑ 이게 원래 색의 이름
```

본 라운드는 round 18-A 의 `resolveVariableChain` 위에 얇은 *trail
formatter* 를 얹어 Inspector 가 "A → B → C" 형태로 표시한다. round 15
의 single-hop label 동작은 *그대로 유지* — round 15 의 helper 는 변경
안 함, round 18-B 는 *추가 옵션*.

## 2. 신규 헬퍼 — `colorVarTrail`

```ts
// web/core/domain/colorStyleRef.ts (round 18-B 추가)

export interface ColorVarTrailEntry {
  /** GUID of the chain node (always set). */
  id: string;
  /** Display name. null when the node has no string `name` (rare). */
  name: string | null;
}

export interface ColorVarTrailResult {
  /** Chain entries from the immediate alias to the leaf (or break-point). */
  entries: ColorVarTrailEntry[];
  /**
   * End-state from the underlying `resolveVariableChain` walk. Used by
   * the Inspector to append a small marker on cycle / dead-end / cap.
   */
  end: VariableChainEnd;
}

export function colorVarTrail(paint: unknown, root: unknown): ColorVarTrailResult | null;
```

### 2.1 Invariants

- I-1 입력 paint 가 falsy / `colorVar.alias.guid` 추출 실패 → `null` (round 15 와 동일 gate).
- I-2 alias guid lookup 실패 또는 가리킨 노드의 `type !== 'VARIABLE'` →
  *round 18-A 에선 non-variable leaf 이지만 본 라운드는 colorVar 전용이라*
  `null` 반환 (round 15 의 `colorVarName` 룰과 일관).
- I-3 입력 VARIABLE 부터 시작해 `resolveVariableChain` 호출. 결과의 chain[]
  으로 `entries[]` 구성. 각 entry 는 chain 의 GUID + 그 노드의 `name`.
- I-4 첫 entry 는 round 15 의 `colorVarName` 결과와 같은 노드. 즉 round 15 의
  사용자가 보던 라벨이 trail 의 *첫 항목* 이고 round 18-B 가 *그 뒤에*
  계속 추가.
- I-5 `entries.length` 는 항상 ≥ 1 (입력 VARIABLE 자체) — 단 raw entry 만
  있는 VARIABLE 도 chain 길이 1 로 OK.
- I-6 `name` 은 노드의 `name` 필드가 string 이면 그대로, 아니면 `null`.
  Inspector 는 `null` 을 fallback (예: GUID literal) 로 처리.

## 3. Inspector UI 변경

- I-7 `FillSection` / `StrokeSection` 의 round 15 `Style` row 가 *trail*
  텍스트로 갱신:
  ```
  <Row label="Style">
    <span>{trail formatted}</span>
  </Row>
  ```
- I-8 trail format 룰 (single helper `formatTrail(result)` — Inspector
  내부 또는 small util):
  - `entries.length === 1` → 그 한 항목 name (or "<unnamed>") — round 15 동작과 동일.
  - `entries.length ≥ 2` → `entries.map(e => e.name ?? '<unnamed>').join(' → ')`.
  - end 가 `cycle` 인 경우 끝에 ` ⟲` 추가. `dead-end` 면 ` ⚠`. `depth-cap` 이면 ` …`.
    `non-variable` 은 colorVarTrail 자체에서 null 반환 (I-2) 이므로 도달
    안 함.
- I-9 길어질 수 있어 `<span>` 에 `class="text-xs text-muted-foreground"` 외에
  `title={fullText}` 도 carry — hover 시 전체 텍스트 tooltip.

## 4. Test cases

| ID | 입력 | 기대 |
|---|---|---|
| TR-1 | paint 에 colorVar 없음 | `null` |
| TR-2 | colorVar 있지만 guid 미존재 lookup | `null` |
| TR-3 | 1-hop (raw VARIABLE) | entries.length=1, end=leaf |
| TR-4 | 2-hop chain | entries.length=2, end=leaf, names 순서 정확 |
| TR-5 | 3-hop with depth-cap=2 | entries.length=2, end=depth-cap |
| TR-6 | cycle | end=cycle, entries 보존 |
| TR-7 | dead-end | end=dead-end |
| TR-8 | non-variable target | `null` (I-2) |
| TR-9 | name 이 null/undefined 인 노드 포함 | entry.name=null carry |

## 5. Out of scope

- ❌ TextSection 의 textStyleName trail. text-style asset 은 단일 노드라 chain 없음. 변경 불필요.
- ❌ Multi-mode (entries[N] 의 두 번째 이상) — round 18-A 와 동일 single-mode.
- ❌ Trail clickable navigation (chain 노드 selecting). 별도 라운드.
- ❌ Audit script (.mjs) 의 helper 통합 — round 18-C 후보.
- ❌ Round 15 의 `colorVarName` 함수 변경. 본 라운드는 *추가 헬퍼* 이고
  round 15 호출 site (만약 있다면) 에 영향 없음.

## 6. 참조

- `docs/specs/web-render-fidelity-round15.spec.md` — single-hop 라벨 정책
- `docs/specs/web-render-fidelity-round18-A.spec.md` — `resolveVariableChain` API
