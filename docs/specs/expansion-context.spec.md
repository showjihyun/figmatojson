# spec/expansion-context

| 항목 | 값 |
|---|---|
| 상태 | Draft (round 13) |
| 구현 | `src/expansion.ts` (entry), `src/masterIndex.ts` (private), `src/effectiveVisibility.ts` (private) |
| 테스트 | `src/expansion.test.ts` (vitest, hand-built TreeNode fixtures — 기존 `web/core/domain/clientNode.test.ts` 의 override-pipeline 테스트들이 이쪽으로 reshape) |
| 형제 | `web-instance-render-overrides.spec.md` (round 12 v3 — prop-binding); `CONTEXT.md` "Expansion", "Expansion Context", "Master Index" |
| ADR | `docs/adr/0004-shared-modules-live-in-src.md` (placement) |

## 1. 목적

현재 Master/Instance Expansion 의 **Resolve** 단계 (`Master + Instance + Overrides → 해결된 Tree Node 서브트리`) 는 두 군데에 독립 구현되어 있다:

- `src/pen-export.ts` — `applySymbolOverrides` + `buildPropAssignmentMap` + `isHiddenByPropAssignment` + nested INSTANCE recursion (~line 600-1080)
- `web/core/domain/clientNode.ts` — `toClientChildForRender` + 각종 `collect*FromInstance` + `mergeOverridesForNested` (line 234-321)

Round-12 audit 가 이 중복의 비용을 직접 노출함: `pen-export.ts` 가 `componentPropAssignments → componentPropRefs[VISIBLE]` 바인딩을 수년 전부터 처리하고 있었지만 web 측은 모르고 있었고, 그 결과 4개 컴포넌트에서 arrow-icon leak 이 audit 까지 발견되지 않음. 본 spec 은 **Resolve 를 단일 모듈로 추출하여 두 pipeline 이 같은 답을 보장**한다.

`Reduce-to-Pen` (Pen Node 4-type 축소, auto-layout reflow, Pen ID 발급) 는 Pencil 출력 한정 책임이므로 `pen-export.ts` 에 그대로 남는다 — 본 spec 의 범위 밖.

## 2. Interface

```ts
import { createExpansionContext, type ExpansionContext } from './expansion';

const ctx = createExpansionContext(allNodes);   // 한 .fig 마다 한 번
const resolved = ctx.expandInstance(instance);  // N instances → N calls
```

`ResolvedSubtree` (정확한 타입 이름은 구현시 결정) 의 형태:

```ts
{
  // Tree Node 형태 그대로 유지 — guid, type, name, children, data
  // + 다음 추가 필드들이 노드별로 stamp 됨:
  parentInstancePath: string[];   // outer instance master root → 현재 노드의 부모까지
  effectiveVisibility: boolean;   // Direct ⊕ PropertyToggle ⊕ SymbolOverride 합성 결과
  resolvedFillPaints?: Paint[];   // Override 적용된 fillPaints (있으면)
  resolvedText?: string;          // Override 적용된 characters (TEXT 노드에 있을 때만)
}
```

호출자가 알아야 할 것은 `createExpansionContext` 와 `expandInstance` 두 함수, 그리고 `ResolvedSubtree` 의 위 4 필드. 그 외 모든 것 (override 수집 helper, path-keyed map merge, nested INSTANCE recursion, prop-binding 해석, MasterIndex 빌드) 은 구현 내부.

## 3. Invariants

### 3.1 Expansion Context

- I-CT1 `createExpansionContext(allNodes)` 는 `allNodes` 를 한 번 walk 해서 **Master Index** (`Map<GUID, Master>`) 를 빌드. `node.type ∈ {SYMBOL, COMPONENT, COMPONENT_SET}` 인 노드만 들어간다 — 일반 Tree Node 는 인덱스되지 않음. (현행 `web/core/domain/clientNode.ts:456-465` 의 무조건 set 버그 수정.)
- I-CT2 ExpansionContext 는 read-only — 같은 컨텍스트로 동일 instance 를 여러 번 호출하면 항상 같은 결과. allNodes 가 변경되면 새 컨텍스트를 만든다.
- I-CT3 ExpansionContext 빌드 비용은 O(allNodes); expandInstance 호출 비용은 O(master subtree size). 컨텍스트 재사용으로 N instances 를 N × buildIndex 가 아니라 1 × buildIndex + N × walk 로 amortize.

### 3.2 Resolve walk

- I-R1 `expandInstance(instance)` 는 `instance.symbolData.symbolID` 로 Master Index 조회 → master 의 children 을 per-instance 복제하며 walk. master 자체 노드는 변경하지 않음 (I-M1, round-12 spec §3.3).
- I-R2 walk 의 각 노드에서 다음을 stamp:
  - `parentInstancePath`: outer instance master root → 현재 노드의 부모까지의 guidStr 배열 (현재 web 의 `pathFromOuter` 와 동등)
  - `effectiveVisibility`: §3.4 의 EffectiveVisibility 모듈이 (Direct, PropertyToggle, SymbolOverride) 합성한 boolean
  - `resolvedFillPaints`: SymbolOverride 의 fillPaints 가 매칭되면 그 값으로 교체
  - `resolvedText`: TEXT 노드에서 SymbolOverride 의 textData.characters 가 매칭되면 그 값
- I-R3 Override 매칭은 **path-keyed**: outer instance master root 부터의 full guidStr chain 이 키. round-12 spec §3.1 I-C1 / §3.2 I-P3 의 규칙 그대로.
- I-R4 Nested INSTANCE 안의 자손에 대한 outer overrides 는 자동 도달 (round-12 §3.2 I-P5). inner instance 가 자기 own overrides 를 가지면 path-prefix 후 outer 와 merge. inner 의 own `componentPropAssignments` 는 defID-keyed flat merge (round-12 §3.4 I-P9).

### 3.3 Effective Visibility

`src/effectiveVisibility.ts` (private to expansion):

- I-V1 입력: `(node.data, propAssignments: Map<defID, boolean>, currentPath, visibilityOverrides)` 모든 메커니즘을 한 자리에서 합성.
- I-V2 합성 규칙 — **OR-of-hidden**, 단 SymbolOverride 의 `visible: true` 가 모든 다른 메커니즘을 누른다:
  1. SymbolOverride 가 매칭되고 `visible: true` → return `true` (강제 표시)
  2. SymbolOverride 가 매칭되고 `visible: false` → return `false`
  3. PropertyToggle (componentPropRefs[VISIBLE] + propAssignments[defID]=false) → return `false`
  4. Direct Visibility (`data.visible === false`) → return `false`
  5. 그 외 → return `true` (default visible)
- I-V3 단일 함수, 단일 테스트 surface. 새 visibility 메커니즘 (e.g. layer blend mode hiding) 은 이 함수 안에 case 추가.

### 3.4 Master Index

`src/masterIndex.ts` (private to expansion):

- I-MI1 `buildMasterIndex(allNodes): Map<GUID, Master>` — `node.type ∈ {SYMBOL, COMPONENT, COMPONENT_SET}` 만 인덱스. 그 외 type 은 인덱스되지 않음 (현재 `clientNode.ts:462` 의 무조건 set 버그 수정).
- I-MI2 같은 GUID 가 여러 master type 으로 나타나면 마지막 등장 win — 현재 동작 유지 (Figma 가 같은 GUID 를 두 master 에 할당하는 케이스는 spec 위반이므로 fallback).

## 4. 호출자 변경

### 4.1 `web/core/domain/clientNode.ts`

- `collect*FromInstance` 4 함수 + `mergeOverridesForNested` + `visibleFromPropRefs` + `pathKeyFromGuids` + `buildSymbolIndex` → **모두 삭제** (expansion 내부로 이동, export 안 함)
- `toClientChildForRender` → expansion.expandInstance 호출하는 thin wrapper 로 축소. ResolvedSubtree 를 받아 `_renderChildren` / `_renderTextOverride` / `visible` / `fillPaints` 같은 web-side DocumentNode 필드를 stamp.
- `toClientNode` → INSTANCE 분기에서 expansion.ctx 를 만들고 expandInstance 호출. ctx 는 한 toClientNode 호출 동안 cache.
- `collectTexts` → 그대로 유지 (다른 용도 — Component Texts UI).

### 4.2 `src/pen-export.ts`

- `applySymbolOverrides` + `buildPropAssignmentMap` + `isHiddenByPropAssignment` + `mergeOverrideMaps` 등 → **삭제**. expansion 으로 이동.
- Master 트리 walk 위치 — Pen Node convertNode 가 INSTANCE 를 만나면 expansion.expandInstance 호출. 결과 ResolvedSubtree 를 받아 자기 Pen Node 4-type 축소 (Reduce-to-Pen) 진행.
- `vectorPathMap` 룩업 키 — 현재의 `Expansion Path` 문자열 (`outerInstanceGuid/.../masterGuid`) 은 ResolvedSubtree 의 `parentInstancePath` 배열로부터 *호출 측에서* 조립 (§3.2 I-R2). 형식 변경 없음.

## 5. Tests

### 5.1 새 위치

`src/expansion.test.ts` 가 expansion 의 primary test surface. 시험 fixtures 는 hand-built TreeNode 들 (현재 `web/core/domain/clientNode.test.ts` 의 `makeNode` 패턴 재사용).

기존 `web/core/domain/clientNode.test.ts` 의 31 테스트 중:

- 22 테스트 (`collect*` helpers, `toClientChildForRender` 의 path 관련 케이스, prop-binding 케이스) → expansion.test.ts 로 reshape. 새 surface 는 expandInstance 의 입출력. internal helper 호출 하지 않음.
- 9 테스트 (`toClientNode` 의 web-side wrapper, `_renderTextOverride` 같은 DocumentNode-shape 검증) → clientNode.test.ts 에 그대로 유지. expansion 호출은 mock 또는 실 호출.

### 5.2 회귀 가드

- 기존 e2e `web/e2e/instance-fill-override.spec.ts` 는 변경 없이 통과해야 함 — 인터페이스가 바뀌어도 외부 동작은 동일.
- `test/e2e.test.ts` 의 pen-export 관련 fixture 도 동일.

## 6. 마이그레이션 순서

1. `src/masterIndex.ts` 만 먼저 추출 + 테스트 + `pen-export.ts` 와 `clientNode.ts` 가 import 하도록 변경. 가장 작은 PR.
2. `src/effectiveVisibility.ts` 추출 + 테스트. `pen-export.ts` 의 `isHiddenByPropAssignment` + `clientNode.ts` 의 `visibleFromPropRefs` 를 둘 다 호출하도록 변경.
3. `src/expansion.ts` 추출 — Resolve walk + 위 두 모듈 호출 통합. 두 호출자 (pen-export, clientNode) 를 expansion.expandInstance 호출로 전환. 가장 큰 PR.
4. 기존 `web/core/domain/clientNode.ts` 의 죽은 helper 들 삭제.

각 단계 후 `npm test` (vitest) + 기존 e2e 통과 확인. 시각 회귀는 round-11 audit harness 로 spot-check.

## 7. 비대상

- **Reduce-to-Pen** (Pen Node 4-type 축소, auto-layout reflow, Pen ID 발급) — Pencil 한정 책임, `pen-export.ts` 에 잔류.
- **Variant swap** (round-12 spec §6 의 "직접 선택" 케이스) — `symbolOverrides[].symbolID` 또는 `componentPropNodeField === "INSTANCE_SWAP"` 으로 master 가 다른 것으로 교체되는 케이스. 본 spec v1 에서는 master 의 원본을 그대로 expand. 별도 라운드.
- **componentPropNodeField !== "VISIBLE"** (TEXT / INSTANCE_SWAP 같은 다른 prop 타입) — round-12 spec §6 의 비대상 그대로.
- **CLI 가 web 의 DocumentNode 형태를 알아야 하는 케이스** — 없음. expansion 은 ResolvedSubtree (Tree Node 확장형) 를 반환, 두 호출자가 각자 자기 형태로 어댑트.
