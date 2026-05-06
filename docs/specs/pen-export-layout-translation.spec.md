# spec/pen-export-layout-translation

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `src/pen-export.ts` (`layoutFromNode`, `omitDimensions`, `computeFillContainer`, `shouldOmitPosition`, `reflowMasterChildren`) |
| 테스트 | `test/pen-export.test.ts` (있는 한도 내) — 본 spec 의 axis-별 매핑 단위 단위 |
| 형제 | `SPEC-figma-to-pencil.md §4` (사이즈 정책 의 *target* — pencil 의 TQ/uw/VZ 함수), `web-instance-pipeline.spec.md §7` (web 측 reflow), `CONTEXT.md §Auto-layout` (의도적으로 punt 한 영역 — 본 spec 으로 채움) |

## 1. 목적

`CONTEXT.md` 가 의도적으로 미문서화 punt 한 영역 — Figma 의 stack* 필드를
Pencil 의 layout/gap/padding/sizing 으로 변환하는 *우리 코드의 함수 매핑*.
SPEC-figma-to-pencil.md §4 가 *Pencil 의* 알고리즘 (TQ/uw/VZ 함수) 을 산문화
했다면, 본 spec 은 *우리 pen-export.ts 의* 함수가 그 알고리즘을 어떻게
구현하는지 명시한다.

`reflowMasterChildren` 은 추가로 — INSTANCE 확장 시점에 master tree 를
instance size 에 맞춰 *재배치* 하는 책임. web 측의 `applyInstanceReflow`
(`web-instance-pipeline.spec.md §7`) 와 다른 코드 경로지만 같은 의도 — 본 spec 이
pen-export 측 contract 를 single source.

## 2. 함수 책임 매핑

| 함수 | 입력 | 출력 | SPEC-figma-to-pencil 대응 |
|---|---|---|---|
| `layoutFromNode(data)` | node.data | `{ layout, alignItems, justifyContent, gap, padding }` | §4 (사이즈 정책의 *컨테이너 측* 결정) |
| `omitDimensions(data, type, parentData)` | node + type + parent.data | `{ width: bool, height: bool }` | §4.2 `uw/VZ` (size emit/omit) |
| `computeFillContainer(data, parentData, type?)` | node + parent.data | `{ width: bool, height: bool }` | §4.1 `TQ` 의 FillContainer 분기 |
| `shouldOmitPosition(data, parentData, parentIsInstanceReplaced, type, effectiveVisible)` | node + parent + flag + type + visibility | `bool` | §4.3 (위치 명시 vs omit) |
| `reflowMasterChildren(children, masterData, masterSize, instSize)` | INSTANCE expansion 결과 children + master.data + 두 size | new children[] | (web-instance-pipeline §7 와 평행) |

## 3. `layoutFromNode` — Figma stack* → Pencil layout

### 3.1 Layout direction 매핑

- I-L1 `data.stackMode` 가 부재 / `'NONE'` / `'GRID'` 면 `{ layout: 'none' }`
  반환. **GRID 는 fallback** — Pencil 미지원이므로 'none' 으로 강등.
- I-L2 `'HORIZONTAL'` → Pencil layout `'row'`.
- I-L3 `'VERTICAL'` → Pencil layout `'column'`.

### 3.2 Alignment 매핑

- I-L4 `stackPrimaryAlignItems` (Figma) → `justifyContent` (Pencil):
  - `MIN` (또는 undefined default) → `flex-start`
  - `CENTER` → `center`
  - `MAX` → `flex-end`
  - `SPACE_BETWEEN` → `space-between`
  - `SPACE_EVENLY` → `space-evenly`
- I-L5 `stackCounterAlignItems` (Figma) → `alignItems` (Pencil):
  - `MIN` (또는 undefined) → `flex-start`
  - `CENTER` → `center`
  - `MAX` → `flex-end`
  - `BASELINE` → `baseline` (TEXT 포함 mixed-baseline 케이스)

### 3.3 Gap 과 padding

- I-L6 `gap = stackSpacing` (number, default omit). 음수 가능 (Figma 의
  overlap layout) — Pencil 도 그대로 carry.
- I-L7 `padding`: `getPadding(data)` helper 가 *4-tuple* 반환:
  - `stackPaddingLeft / Right / Top / Bottom` 우선
  - 위 per-side 부재 시 `stackHorizontalPadding` (left/right 공통) +
    `stackVerticalPadding` (top/bottom 공통) fallback
  - 모두 부재 시 `0` 으로 fallback
- I-L8 padding 직렬화 형식:
  - 4면 동일 → 단일 number
  - 2개 페어 동일 (`top===bottom && left===right`) → `[v, h]` 2-tuple
  - 그 외 → `{ top, right, bottom, left }` object

## 4. `omitDimensions` — width/height emit 결정

axis 별 emit (false) / omit (true) 을 독립 결정.

### 4.1 TEXT 노드 분기 (우선)

- I-O1 `nodeType === 'TEXT'` 이면 `data.textAutoResize` 로 결정 (다른
  필드 무시):
  - `'WIDTH_AND_HEIGHT'` (Figma 의 "Auto width") → `{ w: omit, h: omit }`.
  - `'HEIGHT'` (Figma 의 "Auto height") → `{ w: emit, h: omit }`.
  - `'NONE'` / `'TRUNCATE'` (또는 default) → `{ w: emit, h: emit }` —
    sizing 명시.

### 4.2 Auto-layout container 분기

자기 자신이 stack container (`stackMode in {HORIZONTAL, VERTICAL}`) 일 때.

- I-O2 *primary axis* (HORIZONTAL → width, VERTICAL → height) 의 omit 룰:
  - `stackPrimarySizing === 'FIXED'` → emit (Pencil `Fixed`)
  - 그 외 (undefined / `'AUTO'` / `'RESIZE_TO_FIT_*'`) → omit (Pencil
    `FitContent` — 사이즈가 자식이 결정).
- I-O3 *counter axis* 의 omit 룰:
  - `stackCounterSizing === 'FIXED'` 또는 undefined → emit (Pencil `Fixed` —
    counter 의 default 가 FIXED).
  - `stackCounterSizing === 'RESIZE_TO_FIT_*'` 또는 `'AUTO'` → omit.
- I-O4 GRID stackMode 는 *비-auto-layout* 으로 처리 — 다음 분기 §4.3 으로
  내려감 (Pencil 미지원).

### 4.3 일반 노드 (auto-layout container 아닌 모든 케이스)

- I-O5 *항상 emit* — `{ width: false, height: false }`. Pencil convention:
  auto-layout 부모의 자식도 사이즈 명시 (Figma 와 다름; Figma 는 부모가
  layout 결정). Pencil paste reference 와의 conformance 가 우선.

## 5. `computeFillContainer` — fill_container 표기 결정

- I-F1 부모가 stack container 가 아니면 (`!parentStack || parentStack ===
  'NONE' || 'GRID'`) → `{ width: false, height: false }`.
- I-F2 자식의 *layoutGrow*: `data.stackChildPrimaryGrow ?? data.layoutGrow`
  값 1 이면 *primary axis fill* (`primaryFill = true`).
- I-F3 자식의 *layoutAlign*: `data.stackChildAlignSelf ?? data.layoutAlign`
  이 `'STRETCH'` 면 *counter axis fill* (`counterFill = true`).
- I-F4 STRETCH 의 추가 검증: 자식의 counter axis size 가 부모의 counter
  available (size - padStart - padEnd) 와 *0.01 미만* 차이일 때만 진짜
  fill. 차이가 크면 `counterFill = false` 로 demote — Figma 가 `STRETCH`
  를 stamp 했지만 실제 사이즈가 맞지 않는 케이스 (디자이너의 의도 vs
  현재 baking 결과 mismatch).
- I-F5 axis 매핑:
  - `parentStack === 'HORIZONTAL'` → `{ width: primaryFill, height:
    counterFill }`.
  - `'VERTICAL'` → `{ width: counterFill, height: primaryFill }`.
- I-F6 Pencil 직렬화는 SPEC-figma-to-pencil §4.2 의 `fill_container` /
  `fill_container(N)` 정책 — 본 함수의 boolean 출력을 호출자가 같은 spec
  의 룰로 변환.

## 6. `shouldOmitPosition` — x/y emit 결정

자식 노드의 `transform.m02 / m12` 을 .pen 출력에 emit 할지 결정.

- I-S1 부모가 stack container 가 아니면 → emit (return false). NONE/GRID
  포함.
- I-S2 자식의 `stackPositioning === 'ABSOLUTE'` (Figma 의 floating) → emit.
- I-S3 자식이 *effective hidden* (`effectiveVisible === false`) → emit. flow
  에서 빠진 노드는 위치 결정 mechanism 부재 → 명시 필요.
- I-S4 TEXT 노드 → 항상 omit (textAutoResize 무관, `_showPos` 무시) — Pencil
  의 텍스트는 layout 의 일부로 자동 배치, 위치 명시 안 함.
- I-S5 `_showPos === true` 마커 → emit. `reflowMasterChildren` 이 stamp 한
  마커 (overlap-group 의 LAST one, 또는 primary-shrunk 의 모든 자식).
- I-S6 부모가 INSTANCE 치환 결과 (`parentIsInstanceReplaced === true`) +
  자식의 `_showPos` 가 explicit `false` 가 아니면 → emit. Pencil 동작:
  INSTANCE 치환된 부모는 자식 위치를 *항상 명시* 하는 게 default.
- I-S7 그 외 → omit (auto-layout flow 가 결정).

## 7. `reflowMasterChildren` — INSTANCE 확장 시점의 master 자식 재배치

INSTANCE 의 effective size 가 master size 와 다를 때, master 의 stack
contract 를 *코드로 시뮬레이션* 해서 자식들의 위치/사이즈를 instance 에
맞춘다. web 측 `applyInstanceReflow` (`web-instance-pipeline §7`) 와 평행.

### 7.1 발동 조건

- I-R1 master 가 stack container (`stackMode in {HORIZONTAL, VERTICAL}`) 여야
  함. NONE/GRID 면 즉시 children 그대로 반환.
- I-R2 `masterSize`, `instSize` 둘 다 정의되어야 함. 어느 한쪽이라도 부재면
  reflow 안 함.
- I-R3 axis 명명: `isHorizontal = stackMode === 'HORIZONTAL'`. *primary*
  = primary axis (HORIZONTAL → x, VERTICAL → y), *counter* = 반대축.

### 7.2 Counter axis 처리

- I-R4 `availCounter = instCounter - padStart - padEnd` (counter 축의 사용
  가능 길이).
- I-R5 STRETCH 자식 (`stackChildAlignSelf === 'STRETCH'`): counter axis size
  를 `availCounter` 로 *재계산*. 원래 master size 는 `_masterCounterSize`
  마커로 보존 — Pencil 의 `fill_container(N)` 표기가 N 으로 사용.
- I-R6 counter axis 위치 재계산 (자식 size 변경 또는 instance counter ≠
  master counter):
  - `stackCounterAlignItems === 'CENTER'` → `padStart + (availCounter -
    childCounterSize) / 2`.
  - `'MAX'` → `instCounter - padEnd - childCounterSize`.
  - 그 외 (default MIN) → `padStart`.
- I-R7 `_showPos === true` (위치 명시) 인 자식은 *counter 재계산 skip* —
  master 의 정확한 위치 보존.

### 7.3 Primary axis 처리

- I-R8 `expectedPrimary[i]` 계산 (MIN 정렬일 때만):
  ```
  cur = padStart;
  for each child: expectedPrimary.push(cur); cur += childPrimary + gap;
  ```
  CENTER / MAX / SPACE_* 는 expectedPrimary 를 NaN 으로 채움 (단순 누적
  으로 위치 결정 안 됨 — 호출자가 별도 계산 또는 emit).
- I-R9 `primaryShrunk = instPrimary < masterPrimary` (instance 가 master
  보다 작아진 케이스). 이 경우 *모든 자식* 에 `_showPos = true` 마킹 →
  auto-flow 가 결정 못 하므로 명시 강제.
- I-R10 *Overlap-group* 감지: master 에서 같은 primary 위치에 *여러 자식*
  이 있는 케이스. 그룹 별 LAST one 만 `_showPos = true` 마킹 + expected
  flow 위치로 *재배치*. 다른 overlap 자식들은 omit (auto-flow 가 결정).
  Pencil 동작과 일치.

### 7.4 마커 emit

`reflowMasterChildren` 이 자식 노드에 stamp 하는 *내부 마커* (Pencil 출력
변환 단계에서만 사용, .pen 결과에는 직접 등장 안 함):

- I-R11 `_showPos: boolean` — `shouldOmitPosition` (§6) 의 §I-S5 / I-S6
  분기에 사용. true → 위치 명시, false → omit hint, undefined → 기본
  로직 사용.
- I-R12 `_masterCounterSize: number` — STRETCH 자식의 *원래 master counter
  size*. Pencil 의 `fill_container(N)` 직렬화에서 N 으로 사용 — 부모가
  layout 이 아닌 컨텍스트로 paste 될 때 fallback.

### 7.5 결정성

- I-R13 같은 input → 같은 output. `Math.fround` 로 float32 truncation 강제
  (Pencil 의 Skia 내부 float32 와 호환 — SPEC-figma-to-pencil §5.6 의
  "1 ULP 잔여 오차" 와 같은 정책).
- I-R14 in-place mutation 안 함 — 원본 children array 를 그대로 두고 새
  객체 array 반환 (변경 없는 자식은 동일 reference 재사용).

## 8. 함수 호출 그래프

```
convertNode(treeNode)                     // pen-export 의 메인 변환
  ├ layoutFromNode(data)                  // 부모 측: layout/gap/padding 계산
  ├ omitDimensions(data, type, parent)    // 자식 측: w/h emit 결정
  ├ computeFillContainer(data, parent)    // 자식 측: fill_container 표기
  ├ shouldOmitPosition(data, parent, ...) // 자식 측: x/y emit 결정
  └ (INSTANCE expansion 시:)
     reflowMasterChildren(children, ...)  // master 자식 재배치 → 위 4개로 반환
```

- I-G1 본 spec 의 5 함수는 *호출 순서* 고정 — `convertNode` 가 자식 순회
  중 자식별로 4개 함수를 한 번씩 호출, INSTANCE 분기에서만 reflow 추가.
- I-G2 다른 모듈에서 본 함수들을 직접 호출하지 않는다 (`pen-export.ts`
  내부 helper). web 측의 동일 contract 는 별도 구현 (`applyInstanceReflow`
  in `clientNode.ts`) — 두 구현이 결과 호환됨이 round-trip 검증의 일부.

## 9. 비대상

- ❌ **GRID layout 의 정확한 변환** — Pencil 미지원이므로 layout='none' 으로
  강등. Figma 의 GRID 로 그려진 자식은 위치 명시로 fallback.
- ❌ **Web 측 `applyInstanceReflow` 와의 binary-compatible 보장** — 두 구현이
  *결과 호환* 이지만 *byte-identical* 보장 안 함. round-trip 검증 (canvas-diff
  audit) 이 차이 측정.
- ❌ **stackPositioning 외 *위치 modifier*** — Pencil v1.1.55 가 carry 하는
  추가 modifier (있을 경우) 미지원.
- ❌ **STRETCH 의 0.01 tolerance 자체** — `computeFillContainer` 의 hardcoded
  tolerance 값 (§I-F4) 의 정밀도 변경은 본 spec 비대상. 변경 시 round-trip
  audit 으로 영향 측정 후 별도 round.
- ❌ **CENTER/MAX/SPACE_\* 의 expectedPrimary 계산** (§I-R8 의 NaN fallback).
  현재는 호출자가 별도 처리 — 본 spec 의 future work 는 정확한 위치 계산
  로직 추가.

## 10. Resolved questions

- **`layoutFromNode` 가 Figma 의 stack 매핑을 *모두* 다루나?**
  거의 — `BASELINE` align 같은 일부 edge case 는 `web/client/src/lib/textStyle.ts`
  와 분담. layout 자체는 본 함수가 single source.
- **`omitDimensions` 의 TEXT 분기가 다른 분기보다 *우선* 인 이유?** TEXT 는
  Figma 와 Pencil 모두에서 size 결정이 *content-driven* — auto-layout 이
  override 못 한다. textAutoResize 가 항상 정답이라 auto-layout container
  분기보다 앞서야 함.
- **`computeFillContainer` 의 0.01 tolerance 가 너무 큰가?** Figma 가 carry
  하는 size 는 `Math.fround` 후 5 자리 truncate — 0.001 수준의 error 가
  baseline. 0.01 은 안전 마진. 회귀 발견 시 0.001 로 줄여 검증.
- **`reflowMasterChildren` 가 web 측과 *코드 공유* 안 하는 이유?** pen-export
  은 `TreeNode` (kiwi 직속) 위에서 동작, web 측 `applyInstanceReflow` 는
  `DocumentNode` (clientNode 변환 후) 위에서. 두 type 의 shape 가 다르고
  consumer 도 다름 (CLI 의 .pen 출력 vs web 의 canvas 렌더링). 공유 layer
  를 만들면 *type 일반화* 비용이 더 커서 의도적 duplication.
- **`_showPos` / `_masterCounterSize` 마커를 .pen 직접 emit 으로 바꾸면?**
  안 됨 — Pencil 의 .pen schema 에 해당 필드 없음. 내부 hint 로 carry 하다
  최종 직렬화 단계에서 `fill_container(N)` / explicit `x/y` 로 변환되는 게
  spec 의 의도.
