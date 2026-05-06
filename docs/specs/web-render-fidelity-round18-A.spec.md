# spec/web-render-fidelity-round18-A

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/core/domain/colorStyleRef.ts` (신규 함수 `resolveVariableChain`) |
| 테스트 | `web/core/domain/colorStyleRef.test.ts` (신규 case set) |
| 형제 | round 15 (`colorVarName`/`textStyleName` single-hop), round 17 (audit-properties-coverage broken-chain 측정) |

## 1. 배경

Round 15 의 `colorVarName` 은 **single hop** — `paint.colorVar.alias.guid` 가
가리키는 VARIABLE 노드의 `name` 만 반환한다 (Figma editor 의 "가까운
alias" 표시와 일치). 그러나 Figma 의 design system 에서는 한 VARIABLE
이 또 다른 VARIABLE 을 alias 로 carry 하는 **alias chain** 패턴이 흔하다:

```
paint.colorVar  →  VARIABLE A "Button/Primary/Default"
                   variableDataValues.entries[0].variableData (ALIAS)
                   →  VARIABLE B "Color/Blue/600"
                      variableDataValues.entries[0].variableData (COLOR raw)
                      →  { r, g, b, a }   ← leaf
```

Round 17 의 `audit-properties-coverage.mjs` 가 chain reachability 를
측정하면서 bvp 50+ / 메타리치 6 건의 dead-end / cycle 을 발견했는데,
audit script 는 .mjs 이고 web/core/domain 은 TypeScript 라 헬퍼 공유가
어려워 inline 검증을 carry 하고 있었다.

본 라운드는:

1. **신규 도메인 헬퍼** `resolveVariableChain(node, root)` — pure, single
   `entries[0]` chain 의 leaf + 거쳐간 chain 노드 배열 반환
2. **chain end-state 분류** — leaf 도달 / cycle / dead-end / depth-cap 4 종

audit script 는 본 라운드에서 변경하지 않는다 (별도 라운드 후보 — .mjs
가 web/core dist 를 consume 하도록 빌드 path 설계 또는 helper 를 ESM
export 가능한 .js 로 mirror).

## 2. 헬퍼 시그니처

```ts
// web/core/domain/colorStyleRef.ts (round 18-A 추가)

export type VariableChainEnd =
  | { kind: 'leaf' }                         // ALIAS 가 아닌 entry 도달
  | { kind: 'non-variable' }                 // alias 가 가리키는 노드의 type !== 'VARIABLE'
  | { kind: 'cycle'; cycledAt: string }      // 이미 본 GUID 재방문
  | { kind: 'dead-end' }                     // alias guid lookup 실패
  | { kind: 'depth-cap'; cap: number };       // hop 수 초과

export interface VariableChainResult {
  /** chain 의 마지막 *resolved* VARIABLE 노드. cycle/dead-end 시 마지막 도달한 노드. */
  leaf: unknown | null;
  /** 거쳐간 GUID 들의 배열 — 입력 VARIABLE 부터 leaf 또는 break-point 까지. */
  chain: string[];
  /** chain 종료 사유. */
  end: VariableChainEnd;
}

export function resolveVariableChain(
  node: unknown,
  root: unknown,
  options?: { maxDepth?: number },
): VariableChainResult | null;
```

## 3. Invariants

- I-1 입력 `node` 가 falsy / 비-object / `type !== 'VARIABLE'` → `null` 반환.
- I-2 `maxDepth` default = 8 (audit script 와 일치). 옵션으로 override 가능.
- I-3 입력 VARIABLE 자체가 raw value (`variableDataValues.entries[0].variableData.dataType !== 'ALIAS'`)
  이면 `{ leaf: node, chain: [node.id], end: { kind: 'leaf' } }`. chain 길이 1.
- I-4 chain walk 룰 (각 hop):
  1. 현재 노드의 `variableDataValues.entries[0]` 가 없거나 `variableData.dataType !== 'ALIAS'`
     → leaf, end = `{ kind: 'leaf' }`. 현재 노드가 leaf.
  2. `entries[0].variableData.value.alias.guid` 추출 실패 → end = `{ kind: 'dead-end' }`.
     leaf = 현재 노드 (마지막으로 정상 도달한 곳).
  3. guid 가 chain 에 이미 있음 → end = `{ kind: 'cycle', cycledAt: id }`.
     leaf = 현재 노드.
  4. root 에서 lookup 실패 → end = `{ kind: 'dead-end' }`. leaf = 현재 노드.
  5. lookup 성공한 노드의 `type !== 'VARIABLE'` → end = `{ kind: 'non-variable' }`.
     leaf = 그 non-VARIABLE 노드 (재미 있는 케이스: 일부 schema 가 raw color
     를 별도 type 으로 carry).
  6. 그 외 — 다음 hop 으로.
- I-5 hop 수가 `maxDepth` 도달 → end = `{ kind: 'depth-cap', cap: maxDepth }`.
  leaf = depth-cap 시점의 노드.
- I-6 `entries` 가 multi-mode (light / dark 등) 인 경우 본 라운드는 **첫
  entry 만** 따라간다. multi-mode 처리는 별도 라운드.

## 4. 사용 예

```ts
import { resolveVariableChain } from '@core/domain/colorStyleRef';

const node = findById(root, '11:434');             // "Button/Primary/Default"
const result = resolveVariableChain(node, root);

if (result?.end.kind === 'leaf') {
  const leaf = result.leaf;                         // "Color/Blue/600"
  console.log(`chain: ${result.chain.join(' → ')}`); // "11:434 → 2:69"
  console.log(`leaf name: ${leaf.name}`);
}
```

## 5. Test cases (Invariants → assertions)

| ID | 입력 | 기대 |
|---|---|---|
| T-1 | `node = null` | `null` 반환 |
| T-2 | type=FRAME node | `null` 반환 |
| T-3 | VARIABLE 의 첫 entry 가 raw COLOR | leaf=node, chain=[id], end=leaf |
| T-4 | 2-hop chain (A → B raw) | leaf=B, chain=[A.id, B.id], end=leaf |
| T-5 | 3-hop chain (A → B → C raw) | leaf=C, chain=3, end=leaf |
| T-6 | dead-end (A → 미존재 guid) | leaf=A, end=dead-end |
| T-7 | cycle (A → B → A) | leaf=B, end=cycle, cycledAt=A.id |
| T-8 | depth-cap (10-hop chain, maxDepth=3) | end=depth-cap, cap=3 |
| T-9 | non-VARIABLE leaf (A → FRAME) | leaf=FRAME, end=non-variable |
| T-10 | entries 자체 없음 | leaf=node, end=leaf, chain=[id] |

## 6. Out of scope

- ❌ audit-properties-coverage.mjs 의 helper 통합 (별도 라운드 — .mjs ↔ ts 빌드 경로).
- ❌ Multi-mode (`entries[]` 의 두 번째 이상 entry) chain. 첫 entry 만.
- ❌ Inspector UI 변경 — 본 라운드는 도메인 헬퍼 추가만. round 15 의 single-hop 라벨 표시는 그대로.
- ❌ leaf 의 raw color 변환 (rgba CSS string 등). leaf 노드 자체만 반환.

## 7. 참조

- `docs/specs/web-render-fidelity-round15.spec.md` §I-3 (single hop policy)
- `docs/specs/audit-raw-coverage.spec.md` §4.2 I-P6 (audit broken-chain 정의)
