# spec/web-render-fidelity-round10

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Canvas.tsx` (variant 라벨 렌더 포인트) + `web/client/src/lib/variantLabel.ts` + `web/client/src/components/canvas/VariantLabel.tsx` |
| 테스트 | `web/client/src/lib/variantLabel.test.ts` + `web/client/src/components/canvas/VariantLabel.test.tsx` |
| 부모 | round 9 |

## 1. 목적

Figma 에디터가 Component Set / state group 의 각 variant 자식 위에 자동으로
그려주는 **variant property 라벨**을 우리 캔버스에서도 똑같이 그린다.
유저 스크린샷에서 페이지네이션 컴포넌트의 보라색 점선 박스 안에서 `기본`,
`컴포넌트2` 같은 변형 이름이 라벨로 보이는 부분이 정확히 이 기능이다.

이 라벨들은 .fig 파일 데이터에 텍스트 노드로 존재하지 **않는다** — Figma 에디터가
COMPONENT_SET / `isStateGroup === true` 컨테이너의 자식들을 시각적으로 구분하기
위해 런타임에 그리는 UI 오버레이다. 따라서 우리도 동일하게 “데이터에 없지만
그려주는” 오버레이로 구현한다.

## 2. Variant 컨테이너 감지

- I-V1 노드 N 이 다음 중 하나일 때 “variant 컨테이너”다:
  - `N.type === 'COMPONENT_SET'` (newer Figma)
  - `N.isStateGroup === true` (legacy / metarich format)
- I-V2 variant 컨테이너의 직계 자식 중 `type === 'SYMBOL' || 'COMPONENT'` 인 노드가
  variant 자식. 이름이 `prop=value, prop=value, …` 패턴(`/^[\w가-힣 ]+=/`) 이면
  라벨을 표시. 그 외 자식은 라벨 없음.

## 3. 라벨 텍스트 추출

- I-V3 `variantLabelText(name)`:
  - 입력 예: `"size=L, State=hover, Type=primary"` → `"L, hover, primary"`
  - 입력 예: `"속성 1=기본"` → `"기본"`
  - 입력 예: `"plain name"` (= 없음) → `"plain name"` (그대로)
  - 빈 문자열 / null → `null` (라벨 안 그림)
  - 각 `key=value` 토큰의 value 부분만 trim 후 join. 단일 prop variant 는 단순히
    그 값 한 개. 다중 prop variant 는 ", " 로 join.

## 4. 렌더 — VariantLabel 컴포넌트

- I-V4 `<VariantLabel x y text />` 가 다음을 그린다:
  - 둥근 직사각형 배경 (Konva.Rect): `cornerRadius=4`, `fill='#E5E5E5'`,
    stroke 없음. 너비 = `text` 너비 + 좌우 패딩 8px 씩, 높이 18px.
  - 라벨 텍스트 (Konva.Text): `fontSize=11`, `fontFamily='Inter, sans-serif'`,
    `fill='#1f1f1f'`, 좌우 padding 8 / 상하 padding 3.
  - 텍스트 너비는 `text.length * 6.2` 로 근사 (정확한 metrics 는 Konva 가
    런타임에 잡지만, 배경 사이즈를 미리 정해야 하므로 보수적 근사. 한글 1자
    ≈ 영문 1.5자로 처리.)
- I-V5 컨테이너 안에 그려지므로 클리핑/회전/투명도가 부모로부터 자동 상속된다.
  `listening={false}` 로 두어 셀렉션/드래그/호버 이벤트는 본 라벨이 가로채지
  않는다.

## 5. Canvas 통합

- I-V6 `NodeShape` 가 자기 자식을 렌더할 때, 자기 자신이 variant 컨테이너면
  variant 자식 직전에 그 자식의 라벨을 함께 emit. 위치:
  - `labelX = childTransform.m02`
  - `labelY = childTransform.m12 - 18 - 4` (라벨 높이 18 + 위 여백 4)
  - 즉 variant 자식의 좌상단 바로 위에 정렬.
- I-V7 라벨은 컨테이너의 clipFunc 영향권 안에 있다. metarich 의 pagenation 처럼
  컨테이너에 top padding 이 있으면 잘 보이고, padding 이 없는 컨테이너는 라벨이
  잘릴 수 있다. v1 의 한계.

## 6. 비대상 (v1)

- 라벨 클릭으로 variant 토글 — 우리 앱은 .fig 뷰어이지 variant 편집기가 아님.
- 다중 라인 라벨 — 항상 단일 라인.
- 다른 컨테이너의 라벨 위치 자동 보정 (top padding 없는 경우) — Figma 도 동일
  케이스에선 컨테이너 외부에 그리지만, 우리 v1 은 안에 머문다.
- COMPONENT_SET 자체의 우상단 “Properties” 패널 표기 — 별도 라운드.

## 7. Resolved questions

- **라벨 배경색**: Figma 에디터는 옅은 회색 배경 (#E5E5E5 근사). 흰 배경은 흰
  variant 와 충돌하므로 회색으로 통일.
- **라벨 위치**: 위(top) vs 좌(left). Figma 의 vertical-stacked variant 들은
  위에, horizontal-stacked 는 좌에 보이는데, v1 은 모두 “위” 로 통일. 메타리치의
  pagenation/Button 등 모두 vertical stack 이라 시각적 차이 없음.
- **단일 prop 일 때 prop 명 생략**: `"속성 1=기본"` → `"기본"` (값만). 다중 prop
  variant 도 값만. 이는 Figma 와 동일.
