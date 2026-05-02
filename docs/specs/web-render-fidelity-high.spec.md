# spec/web-render-fidelity-high

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Canvas.tsx` 의 TEXT 분기 + 일반 노드 분기 |
| 테스트 | `web/client/src/components/canvas/text-style.test.tsx` (신규), 기존 `Canvas.tsx` 회귀 |
| 부모 | Dropdown 노드 audit (Phase W) HIGH 항목들 |

## 1. 목적

`메타리치 화면 UI Design.fig` Dropdown audit 에서 발견된 HIGH 시각 격차를 한 번에 닫는다. 모두 .fig 데이터에 이미 들어있는 필드인데 Canvas 가 읽지 않아서 Figma 와 시각이 어긋났던 케이스 — 추가 데이터 변환 없이 KText / Group 의 prop 으로 전달만 하면 되는 read-only 작업.

영향 범위 (전체 메타리치 기준):
- letterSpacing 적용: ~10,000 TEXT 노드 (99.7%)
- lineHeight 적용: ~8,640 TEXT 노드 (86%)
- textAlignVertical CENTER: ~9,551 TEXT 노드 (95%)
- textAlignHorizontal CENTER/RIGHT: ~320 TEXT 노드 (3%)
- per-side stroke 차등: ~10,574 노드

본 spec 의 작업 후 화면이 광범위하게 더 Figma 에 가까워짐 — 유저가 보고했던 캘린더 라벨 (이전 PR 에서 텍스트 자체는 복원) 의 자간/줄간격/세로정렬도 함께 정합.

## 2. Field shape (입력 데이터)

모든 필드는 노드의 **top-level** (TextData 안이 아님). Figma kiwi schema 가 그렇게 직렬화.

```ts
// TEXT 노드 위
letterSpacing?: { value: number, units: 'PIXELS' | 'PERCENT' }
lineHeight?: { value: number, units: 'PIXELS' | 'PERCENT' | 'RAW' }
textAlignVertical?: 'TOP' | 'CENTER' | 'BOTTOM'
textAlignHorizontal?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'
fontName?: { family: string, style: string, postscript?: string }
fontSize?: number

// 모든 노드 위 (per-side stroke 만 해당)
borderTopWeight?: number
borderRightWeight?: number
borderBottomWeight?: number
borderLeftWeight?: number
strokeWeight?: number
strokePaints?: Paint[]
```

## 3. Conversion to Konva props

### 3.1 letterSpacing → `KText.letterSpacing` (px)

- I-LS1 `units === 'PIXELS'` → `KText.letterSpacing = value`.
- I-LS2 `units === 'PERCENT'` → `KText.letterSpacing = (value / 100) * fontSize`. 음수 허용 (Figma 가 -0.5% 같은 값을 기본으로 사용).
- I-LS3 letterSpacing 객체가 없거나 `value === 0` → prop 자체를 omit (Konva 기본값 0 사용).

### 3.2 lineHeight → `KText.lineHeight` (multiplier)

- I-LH1 `units === 'RAW'` → `KText.lineHeight = value` 그대로 (이미 multiplier).
- I-LH2 `units === 'PERCENT'` → `KText.lineHeight = value / 100`.
- I-LH3 `units === 'PIXELS'` → `KText.lineHeight = value / fontSize` (multiplier 로 환산). fontSize 가 0/undefined 면 prop omit.
- I-LH4 lineHeight 객체가 없으면 prop omit (Konva 기본 1.0). Figma 의 baseline 기준이 다를 수 있어 1.0 이 정확한 매치는 아니지만 가장 안전한 fallback.

### 3.3 textAlignVertical → `KText.verticalAlign`

- I-AV1 `'TOP'` → `'top'` (또는 prop omit; Konva 기본).
- I-AV2 `'CENTER'` → `'middle'`.
- I-AV3 `'BOTTOM'` → `'bottom'`.
- I-AV4 unknown 값 → prop omit (안전 fallback).
- I-AV5 KText 의 `height` prop 이 set 된 경우에만 의미 있음 — Figma TEXT 노드는 항상 size.y 를 가지므로 충족.

### 3.4 textAlignHorizontal → `KText.align`

- I-AH1 `'LEFT'` → `'left'` (또는 prop omit).
- I-AH2 `'CENTER'` → `'center'`.
- I-AH3 `'RIGHT'` → `'right'`.
- I-AH4 `'JUSTIFIED'` → `'justify'`. Konva 의 justify 가 Figma 와 정확 일치하지는 않지만 가장 가까운 매핑.
- I-AH5 unknown / undefined → prop omit.

### 3.5 fontName.style → `KText.fontStyle`

- I-FS1 fontName.style 의 normalize: 소문자 + 공백/하이픈 제거.
  - `'Bold'` / `'700'` 포함 → `'bold'`
  - `'Italic'` 포함 → `'italic'`
  - 둘 다 → `'italic bold'` (Konva 가 받는 포맷)
- I-FS2 그 외 (Regular, Medium, SemiBold 등) → prop omit (Konva 기본 normal).
- I-FS3 v1 한계 — Konva.Text 는 numeric font weight 를 직접 지원하지 않음. Medium (500) / SemiBold (600) 는 Bold 가 아닌 한 normal 로 fallback. browser 가 family 안의 가장 가까운 weight 를 자동 선택 (Pretendard 같은 풀 family 에서는 시각 차이가 미미).

### 3.6 Per-side stroke

- I-PS1 노드의 4개 `border{Top,Right,Bottom,Left}Weight` 값이 *모두 동일* 하면 기존 단일 `Rect` 의 `strokeWidth = strokeWeight` 그대로 — 추가 작업 없음.
- I-PS2 *어느 하나라도 다르면* (또는 없으면 `strokeWeight` 와 비교) per-side 모드로 전환:
  - `Rect` 의 `stroke` prop 을 끈다 (`undefined` 또는 `'transparent'`).
  - 4개 `Konva.Line` 을 추가로 그린다 (`strokePaints[0]` 의 색을 사용).
    - top: `(0, 0) → (w, 0)`, weight = `borderTopWeight ?? 0`
    - right: `(w, 0) → (w, h)`, weight = `borderRightWeight ?? 0`
    - bottom: `(0, h) → (w, h)`, weight = `borderBottomWeight ?? 0`
    - left: `(0, 0) → (0, h)`, weight = `borderLeftWeight ?? 0`
  - weight === 0 인 side 는 Line 자체를 omit (불필요한 Konva 노드 생성 방지).
- I-PS3 `strokePaints` 가 비어있으면 (`length === 0` 또는 undefined) 모든 stroke 작업 skip — per-side 도 안 그림.
- I-PS4 strokeAlign (CENTER/INSIDE/OUTSIDE) 은 v1 비대상 — 단일 strokeWeight 든 per-side 든 Konva 의 default (centered) 그대로. Figma 의 INSIDE 는 약간 다르게 보이지만 1~2px 차이.

## 4. Implementation guard rails

- I-IM1 변경 범위는 `Canvas.tsx` 의 TEXT 렌더 분기 + 일반 노드 (Group + Rect) 분기. 다른 파일 / 데이터 레이어 변경 없음.
- I-IM2 NodeShape 는 여전히 memo — 새 prop 들이 모두 props 의 일부 (node) 에서 파생되므로 기존 memoization 유효.
- I-IM3 per-side stroke 의 4개 Line 은 Group 안에 배치해서 부모 transform 을 그대로 받게 함. 별도 좌표 계산 불필요.
- I-IM4 letterSpacing/lineHeight 변환 헬퍼는 inline (다른 파일에서 재사용 안 함). 변환 1줄짜리들이라 추출 불필요.

## 5. Render side performance

- I-PE1 letterSpacing/lineHeight/align 은 모두 KText 의 단일 prop — 추가 Konva 노드 0개.
- I-PE2 per-side stroke 는 차등 노드에 한해 최대 4 Line 추가. ~10,500 노드에 대해 평균 ~2 Line 추가 → 35K-node 샘플 기준 ~21K Line 추가 = ~6% 노드 증가. 측정 후 회귀 시 culling 으로 보강 (이미 `cullChildrenByViewport` 가 있음).

## 6. 비대상

- **auto-layout reflow** — Figma 가 저장 시 children 의 `transform.m02/m12` 에 stack-computed 위치를 baked-in 함 (확인: 메타리치의 Button frame). 읽기 경로에서는 visual 차이 없음. 편집 시 reflow 가 필요한 별개 라운드.
- **textCase / textDecoration / textDecorationSkipInk** — 비대상. Konva.Text 가 직접 지원하지 않고 우회 (text 변형 사전처리 / underline 별도 Line) 필요.
- **fontVariations / fontVariantCommonLigatures / fontVariantContextualLigatures** — 변형 폰트 / 합자. 폰트 자체가 Pretendard 류 정적 family 라 시각 차 미미.
- **strokeAlign / strokeCap / strokeJoin / dashPattern** — Konva 가 지원하지만 메타리치 데이터 분포상 default 가 압도적. 차등 케이스 발견 시 별도 라운드.
- **effects (drop shadow / blur)** — 별도 라운드.
- **gradient / image fills** — 별도 라운드.
- **styleIdForText / fillStyleId / strokeStyleId** — 디자인 토큰 참조 해석 — 별도 spec.

## 7. Resolved questions

- **letterSpacing 음수 허용 여부** — Figma 가 -0.5% 를 한국어 텍스트의 기본 조판으로 사용 (메타리치 99.7%). Konva 도 음수 letterSpacing 받음 → 그대로 통과.
- **lineHeight RAW vs Konva multiplier** — Konva.Text 의 lineHeight 는 fontSize 의 multiplier (예: 1.42 → 1.42×fontSize 줄간격). Figma RAW 도 multiplier 의미 → 직접 통과 가능. 단위 PIXELS 만 fontSize 로 나눠 환산.
- **fontStyle 의 weight 매핑 한계** — Konva 가 numeric weight (300/400/500/700) 를 받지 않음. 'normal' / 'bold' 만. Pretendard family 의 Medium/SemiBold 는 일단 normal 로 보내고, 실제 weight 차이는 browser 가 family 내에서 fallback. 추후 numeric weight 전달이 필요하면 KText 가 아닌 raw `<text>` SVG 로 fallback.
