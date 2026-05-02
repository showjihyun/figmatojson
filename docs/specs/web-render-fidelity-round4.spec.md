# spec/web-render-fidelity-round4

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Canvas.tsx` 의 default Rect 분기 + `web/client/src/lib/gradient.ts`, `web/client/src/lib/paint.ts` |
| 테스트 | `web/client/src/lib/gradient.test.ts`, `web/client/src/lib/paint.test.ts` |
| 부모 | round 1~3 (typography / strokeAlign / clip / shadow / rotation / opacity / cap-join) |

## 1. 목적

Universal Figma 기능 3종 — **gradient 채우기 (LINEAR / RADIAL)**, **multi-paint 의 top-paint 선택 정정**, **dashPattern (점선)**. 모두 Figma 의 공개 데이터 모델에 정의된 표준 필드. 파일 종속 휴리스틱 없음.

## 2. Gradient fills

### 2.1 Field shape

```ts
paint: {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND'
  visible: boolean
  opacity?: number              // paint-level alpha multiplier
  blendMode?: string
  stops: Array<{ color: { r,g,b,a }, position: number }>   // position 0..1
  transform: {                  // 2x3 matrix mapping unit gradient space → bbox-normalized
    m00, m01, m02, m10, m11, m12
  }
}
```

### 2.2 Coordinate model

Figma 의 gradient 좌표 시스템:
- 단위 gradient 공간: t-축이 (0,0.5) → (1,0.5) 직선. center 라인을 따라 stop 들이 배치.
- `paint.transform` 은 이 공간에서 bbox-normalized 공간 (0..1, 0..1) 으로 매핑하는 affine.

Konva 가 받는 좌표는 **노드의 로컬 픽셀 좌표** (0..w, 0..h). 따라서 두 단계 변환:
1. unit point → bbox-normalized: `applyTransform(paint.transform, point)`
2. bbox-normalized → pixel: `(p.x * w, p.y * h)`

### 2.3 LINEAR gradient

- I-G1 start point (Konva `fillLinearGradientStartPoint`): `applyTransform(paint.transform, (0, 0.5))` × `(w, h)`.
- I-G2 end point (`fillLinearGradientEndPoint`): `applyTransform(paint.transform, (1, 0.5))` × `(w, h)`.
- I-G3 color stops (`fillLinearGradientColorStops`): flat array `[pos1, css1, pos2, css2, ...]` where `cssN = rgbaToCss(stops[N].color, paint.opacity)`. position 은 `stops[N].position` 그대로 (Konva 도 0..1 사용).

### 2.4 RADIAL gradient

- I-G4 start point (center, `fillRadialGradientStartPoint`): `applyTransform(paint.transform, (0.5, 0.5))` × `(w, h)`.
- I-G5 end point (`fillRadialGradientEndPoint`) = same as start (radial gradient 의 end 위치는 center 와 동일; Konva 가 startRadius~endRadius 로 실제 표현).
- I-G6 startRadius = 0; endRadius = bbox-normalized space 의 (1, 0.5) 와 (0.5, 0.5) 사이 거리 × bbox 크기 — `dx = m00*0.5 = halfWidth_in_paint_space`, similar for dy. radius = `sqrt((m00*0.5)² * w² + (m10*0.5)² * h²)` 같은 공식. 단순화: `radius = sqrt((dx*w)² + (dy*h)²)` where `(dx, dy) = applyTransform(t, (1, 0.5)) - applyTransform(t, (0.5, 0.5))`.
- I-G7 color stops 형식 LINEAR 와 동일.

### 2.5 ANGULAR / DIAMOND

- I-G8 Konva 는 angular / diamond 를 native 로 지원하지 않음. v1 fallback: paint 의 첫 번째 stop 의 색상 (with paint.opacity 합성) 을 SOLID 처럼 사용. Figma 와 시각 차이 있으나 사용자 노드 식별은 유지.

### 2.6 Helper

```ts
// lib/gradient.ts
export function gradientFromPaint(paint, w, h): KonvaGradient | null
```

반환:
- LINEAR / RADIAL — Konva fill 관련 prop 들 (start, end, color stops, radii)
- ANGULAR / DIAMOND — `null` (caller 가 first-stop fallback 처리)
- 그 외 / 잘못된 paint — `null`

## 3. Multi-paint: top-paint 선택

### 3.1 Background

Figma 의 `fillPaints` 배열은 **bottom-up 적층** — `fillPaints[0]` 이 가장 아래, `fillPaints[N-1]` 이 가장 위 (사용자에게 보이는 면). 기존 `solidFillCss` 는 *첫 번째* visible SOLID 를 픽 — 즉 가장 아래 paint 가 채택되어 *위 paint 가 가려지는 효과* 가 시각화되지 않음.

### 3.2 정정 규칙

- I-MP1 `pickTopPaint(fillPaints)` = `fillPaints` 를 **역순으로 순회**, `visible !== false` 이면서 IMAGE 가 아닌 첫 항목 (= 위에서 가려진 가장 윗 paint) 반환.
- I-MP2 모든 paint 가 IMAGE 거나 hidden 이면 `null` 반환 → caller 가 `transparent` 또는 image fill 처리.
- I-MP3 IMAGE 는 별도 처리 (`ImageFill` 컴포넌트가 이미 존재). `pickTopPaint` 는 IMAGE 를 건너뜀.
- I-MP4 **완전한 multi-paint 적층** (alpha-blending, gradient over solid 등) 은 v2 비대상. 현재는 위 paint 한 개만 적용.

### 3.3 Caller wiring

`Canvas.tsx` 의 default Rect 분기:
1. `top = pickTopPaint(node.fillPaints)`
2. `top.type === 'SOLID'` → fill = rgba string
3. `top.type === 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'` → fill = gradient props (Konva.Rect 가 받음)
4. `top` 이 GRADIENT_ANGULAR/DIAMOND 면 first-stop solid fallback
5. `top === null` → `transparent` (fill 없음)

## 4. dashPattern

### 4.1 Field shape

```ts
node.dashPattern?: number[]   // 예: [10, 5] → 10px 채움, 5px 빈, 10px 채움, ...
```

### 4.2 Konva 매핑

- I-DP1 `node.dashPattern` 이 **non-empty array** 이면 stroke 가 적용되는 모든 Konva 요소 (Rect / Path / per-side Line) 의 `dash` prop 으로 그대로 전달.
- I-DP2 `dashPattern` 이 빈 배열이거나 missing → `dash` prop omit (실선).
- I-DP3 짝수 길이 보장 — Konva 가 홀수 길이 받으면 알아서 반복하므로 변환 불필요.

## 5. 비대상 (v1)

- **Multi-paint stacking** — alpha 가 섞이는 multi-paint 의 진짜 합성. 현재는 top-paint 만 보임. 12개 노드 중 대부분이 단순 "흰색 위 light-blue" 형식 — top-paint 가 정답.
- **GRADIENT_ANGULAR / GRADIENT_DIAMOND** — Konva 미지원, first-stop solid fallback.
- **Image fills 의 multi-paint 결합** — IMAGE + SOLID 적층은 ImageFill 컴포넌트 + Rect 두 개로 분리 가능하지만 별도 라운드.
- **stroke gradient** — `strokePaints` 가 GRADIENT 인 경우. 데이터 분포상 거의 없음.
- **gradient transform 의 skew/회전 매트릭스** — `applyTransform` 이 모든 affine 을 처리 (회전된 gradient 도 동작). 다만 Konva 의 gradient 자체가 항상 직선 / 원형이라 skew 결과는 시각적으로 약간 다를 수 있음.

## 6. Resolved questions

- **Gradient transform 의 해석 방향** — Figma 는 unit gradient space → bbox-normalized 매핑. start = `t(0, 0.5)`, end = `t(1, 0.5)`. 공식 spec / figma-js 라이브러리 / fig-kiwi 분석 모두 일치.
- **Multi-paint: first vs last** — Figma UI 에서 paint 추가 시 "Add fill" 버튼이 stack 의 *위* 에 추가. 즉 array[N-1] 이 시각적으로 위. 우리 `solidFillCss` 가 first-pick 이었던 건 단순한 PoC 누락. 이번에 정정.
- **dashPattern 적용 범위** — Konva 의 dash prop 은 stroke 에 한해 동작 (fill 에 영향 없음). 따라서 dashPattern 이 set 되어도 fill 은 정상 — Figma 동일.
