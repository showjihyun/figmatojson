# spec/web-render-fidelity-round14

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Inspector.tsx`, `web/client/src/components/sidebar/LayerTree.tsx`, `web/client/src/components/sidebar/AssetList.tsx` |
| 테스트 | (기존) `web/client/src/lib/variantLabel.test.ts` 재사용 — 헬퍼 본체는 동일 |
| 부모 | round 10 (Canvas variant 라벨) |

## 1. 배경

Round 10 이 도입한 `variantLabelText` 는 *Canvas* 위에 그리는 variant 라벨
(보라색 점선 박스 위 작은 pill 텍스트) 에만 적용됐다. 그러나 같은 노드의
이름이 노출되는 다른 UI 영역 — Inspector 의 selected node 헤더, 좌측
LayerTree 의 노드 라벨, AssetList 의 INSTANCE 카드 — 에서는 raw name 이
그대로 보인다.

HPAI / 메타리치 모두 Figma 의 component-set variant 명명 규칙
(`prop=value, prop=value, …`) 을 그대로 carry — 예시:

| 노드 | raw name | Figma UI 표시 |
|---|---|---|
| `5:8` (메타리치 SYMBOL) | `size=XL, State=default, Type=primary` | `XL, default, primary` |
| `5:20` | `size=L, State=default, Type=primary` | `L, default, primary` |

라벨 변환은 round 10 의 헬퍼 본체를 그대로 재사용한다 — Canvas 와 의미가
같고, 휴리스틱 (`=` 없는 raw name 은 그대로 반환) 이라 일반 노드 이름에
영향 0.

## 2. 적용 범위

- I-1 `web/client/src/Inspector.tsx` — selected-node 헤더 (`node.name`
  렌더 포인트). raw `node.name` 대신 `variantLabelText(node.name) ?? ''`
  적용. 이름이 빈 문자열일 때 기존 `(unnamed)` placeholder fallback 그대로.
- I-2 `web/client/src/components/sidebar/LayerTree.tsx` — `displayName`
  계산에 `variantLabelText` 적용. 노드가 빈 이름인 경우 기존 fallback
  로직 (`(node type)` 등) 유지.
- I-3 `web/client/src/components/sidebar/AssetList.tsx` — INSTANCE 카드의
  `name` 필드에 적용. 이 또한 raw name 그대로 노출되던 영역.
- I-4 `Inspector.tsx` 의 *편집 가능한* name 필드 (`TextInput value={node.name}`)
  에는 변환 *적용 안 함*. 사용자가 raw name 을 직접 편집할 수 있어야 하기
  때문 — variant 컨테이너 안에서는 `prop=value` 형태가 wire-format 의
  source-of-truth.

## 3. Out of scope

- ❌ name 편집 UX: variant variant 안에서 편집을 막거나 두 표현 (raw vs
  pretty) 을 동시에 보여주는 별도 widget. 현재는 raw name 만 편집 노출.
- ❌ ChatPanel / Search 결과 등 다른 UI 영역. 발견 시 동일 휴리스틱 적용.
- ❌ variantLabelText 본체의 동작 변경. round 10 spec 그대로.

## 4. Invariants

| ID | 명제 | 검증 |
|---|---|---|
| I-1 | Inspector header 가 variant-shaped name 을 stripped 형태로 렌더 | unit (existing variantLabel.test.ts cover) + manual UI |
| I-2 | LayerTree row 가 variant-shaped name 을 stripped 형태로 렌더 | manual UI |
| I-3 | AssetList card 가 variant-shaped name 을 stripped 형태로 렌더 | manual UI |
| I-4 | name 편집 input 은 raw name 그대로 carry | manual UI |
| I-5 | non-variant 일반 이름 (e.g. "Frame 2262") 에서 동작 회귀 0 | unit (existing) |

## 5. 참조

- `docs/specs/web-render-fidelity-round10.spec.md` — variant label spec (Canvas)
- `web/client/src/lib/variantLabel.ts` — 헬퍼 본체 (변경 없음)
