# spec/web-render-fidelity-round2

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Canvas.tsx` (TEXT / VECTOR / 일반 분기) + `web/client/src/lib/strokeAlign.ts`, `web/client/src/lib/shadow.ts` |
| 테스트 | `web/client/src/lib/strokeAlign.test.ts`, `web/client/src/lib/shadow.test.ts` |
| 부모 | `web-render-fidelity-high.spec.md` (이전 라운드 — letterSpacing / lineHeight / textAlignVertical / per-side stroke) |

## 1. 목적

이전 HIGH 라운드 이후, 메타리치 데이터를 file-wide 로 다시 분포 분석한 결과 세 개의 큰 visual 격차가 남음 — 모두 .fig 데이터에 이미 들어있는 필드인데 Canvas 가 무시했던 것:

| 격차 | 영향 (메타리치) | 시각 차이 |
|---|---|---|
| `strokeAlign === 'INSIDE' \| 'OUTSIDE'` | 10,955 / 11,061 visible-stroke (99.5%) | Konva 기본 CENTER → 모든 stroke 가 fill 영역 안으로 절반, 밖으로 절반 — 사각형 모서리에서 fill 이 stroke 안쪽으로 새는 현상 |
| `frameMaskDisabled === false` (clipsContent) | 2,148 FRAME/SYMBOL/INSTANCE | 자식이 부모 frame 밖으로 삐져나감 |
| `effects[].type === 'DROP_SHADOW'` | 109 nodes | 카드/버튼/모달의 그림자 없음 → 평평하게 보임 |

본 spec 의 라운드 후 Figma 와 기본 톤 매치가 거의 완성. 미세 차이 (회전 65/35,660 = 0.2%, opacity 16개, gradient 5개 등) 는 별도 라운드.

## 2. strokeAlign

### 2.1 Field shape

```ts
node.strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER'
node.strokeWeight?: number
node.strokePaints?: Paint[]   // visible stroke only when length>0 and paints[0].visible !== false
```

기본값 (Konva): stroke 는 도형 경계선 중심에 그려짐 (CENTER). 즉 `strokeWidth=2` 의 절반 1px 은 fill 영역 안쪽, 나머지 1px 은 바깥쪽.

Figma 기본값 (`strokeAlign === undefined` 또는 `'CENTER'`): Konva 와 동일.

### 2.2 INSIDE 변환

- I-SA1 `strokeAlign === 'INSIDE'` 이고 visible stroke 가 있는 경우:
  - 그리는 Rect 의 위치/크기를 `strokeWeight/2` 만큼 안쪽으로 inset 한다 — `(x + sw/2, y + sw/2, w - sw, h - sw)`.
  - `strokeWidth` 는 원본 그대로.
  - 결과: stroke 의 outer edge 가 원본 도형 경계와 정확히 일치 → fill 이 stroke 안쪽으로 새지 않음.
- I-SA2 `w - strokeWeight <= 0` 또는 `h - strokeWeight <= 0` 이면 strokeAlign 을 무시하고 CENTER 처럼 그린다 (음수 dim 회피).

### 2.3 OUTSIDE 변환

- I-SA3 `strokeAlign === 'OUTSIDE'`:
  - Rect 의 위치/크기를 `strokeWeight/2` 만큼 바깥쪽으로 expand 한다 — `(x - sw/2, y - sw/2, w + sw, h + sw)`.
  - `strokeWidth` 는 원본 그대로.
  - 결과: stroke 의 inner edge 가 원본 도형 경계와 일치 → fill 영역이 stroke 만큼 줄어들지 않음.

### 2.4 적용 범위

- I-SA4 일반 노드 (FRAME/RECTANGLE 등) 의 background `Rect` 에 적용 — fill+stroke 한 번에 변환.
- I-SA5 VECTOR `Path` 분기에는 미적용 — Konva.Path 의 strokeAlign 은 SVG `stroke-alignment` 에 해당하는 비표준 속성이라 브라우저 호환성 미달. v1 비대상.
- I-SA6 per-side stroke (이전 라운드의 4개 Konva.Line) 에는 미적용 — INSIDE/OUTSIDE 가 차등 stroke 와 결합된 케이스는 메타리치 데이터에 없음. 발견 시 별도 라운드.
- I-SA7 cornerRadius > 0 이면 inset/expand 후의 cornerRadius 도 동일하게 조정 — INSIDE 면 `cornerR - sw/2` (음수 clamp 0), OUTSIDE 면 `cornerR + sw/2`.

## 3. Frame clip (clipsContent)

### 3.1 Field shape

```ts
node.frameMaskDisabled?: boolean   // false ⇒ clip enabled (기본 true 이면 clip disabled)
```

Figma 의 "Clip content" 토글이 `frameMaskDisabled === false` 로 직렬화. 명명이 헷갈리지만 데이터는 그렇게 들어있음.

### 3.2 Clip behavior

- I-FC1 `frameMaskDisabled === false` 인 일반 노드의 Konva Group 에 `clipFunc` 를 추가:
  - cornerRadius === 0 인 경우: 단순 `ctx.rect(0, 0, w, h)` clip.
  - cornerRadius > 0 인 경우: rounded rect path. 4개 corner 를 quadraticCurveTo 또는 arcTo 로 그리는 표준 패턴.
- I-FC2 `frameMaskDisabled` 가 undefined 이거나 `true` 인 경우 clipFunc 없음 (기본 — 자식이 frame 밖으로 보일 수 있음).
- I-FC3 TEXT / VECTOR 분기에는 미적용 — clip 은 컨테이너에만 의미.
- I-FC4 selection overlay 는 clip 의 영향을 받지 않게 별도 Layer 로 그리는 기존 구조 유지 — clipping 은 레이어 안의 자식 NodeShape 에만 영향.

## 4. Drop shadow

### 4.1 Field shape

```ts
node.effects?: Array<{
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR'
  visible: boolean
  offset?: { x: number, y: number }
  radius?: number     // blur radius
  spread?: number
  color?: { r: number, g: number, b: number, a: number }
  blendMode?: string
  showShadowBehindNode?: boolean
}>
```

메타리치는 109개 DROP_SHADOW 만 사용 (다른 effect 타입 0개).

### 4.2 Konva 매핑

- I-DS1 `effects` 배열에서 첫 번째 `type === 'DROP_SHADOW'` 이고 `visible !== false` 인 entry 를 사용. 둘 이상은 v1 에서 첫 번째만 (Konva.Shape 가 단일 shadow 만 지원).
- I-DS2 매핑:
  - `shadowOffsetX = effect.offset.x ?? 0`
  - `shadowOffsetY = effect.offset.y ?? 0`
  - `shadowBlur = effect.radius ?? 0`
  - `shadowColor = rgba(round(r*255), round(g*255), round(b*255), 1)` — alpha 는 별도 prop 으로
  - `shadowOpacity = effect.color.a ?? 1`
- I-DS3 `spread` 는 Konva 가 지원하지 않음 — v1 비대상. 메타리치 109개 entry 모두 `spread === 0` 이라 시각 차이 없음.
- I-DS4 `blendMode !== 'NORMAL' && blendMode !== undefined` 인 경우 shadow 적용 안 함 — Konva 의 shadow blendMode 가 항상 normal 이라 잘못 그릴 위험. 알려진 한계 — 메타리치는 모두 NORMAL 이라 영향 없음.
- I-DS5 INNER_SHADOW / LAYER_BLUR / BACKGROUND_BLUR 는 v1 비대상. INNER_SHADOW 는 Konva 에서 stroke + clip 조합으로 구현 가능하지만 별도 라운드. BLUR 는 filter chain 필요.

### 4.3 적용 범위

- I-DS6 일반 노드 (Rect 분기) 에 적용 — Konva.Rect 가 shadow prop 받음.
- I-DS7 TEXT 분기에도 적용 — 라벨 텍스트에 그림자가 붙은 케이스가 메타리치에 있을 수 있음 (직접 데이터 분포는 확인 안 했지만 affordance 누락은 회귀).
- I-DS8 VECTOR Path 분기에도 적용 — 아이콘 그림자.

## 5. 비대상 (v1)

- INNER_SHADOW / LAYER_BLUR / BACKGROUND_BLUR.
- Multiple drop shadows on the same node (메타리치 단일만 사용).
- DROP_SHADOW 의 `spread` (메타리치 모두 0).
- VECTOR Path 의 strokeAlign (브라우저 호환성).
- Per-side stroke + INSIDE/OUTSIDE 조합 (데이터에 없음).
- 회전/skew transform — 65 nodes (다음 라운드).
- opacity ≠ 1 — 16 nodes (다음 라운드 또는 layer-level).
- gradient / image-fill multi-paints — 12 nodes (이미 image fill 일부 처리).
- dashPattern — 16 nodes.
- styleIdForText / fillStyleId / strokeStyleId / effectStyleId — 0 nodes (메타리치 비사용).

## 6. Performance

- I-PE1 strokeAlign 변환은 inline 산수 — 추가 노드/객체 없음.
- I-PE2 clipFunc 는 frame 당 하나의 함수 prop — Konva 가 매 draw 마다 호출하지만 단순 rect path 라 비용 미미.
- I-PE3 shadow 는 Konva 의 native shadow filter 사용 — 35K 노드 중 109개만 적용되므로 perf 영향 없음.

## 7. Resolved questions

- **strokeAlign 의 INSIDE 가 Konva.Rect 에서 자연스럽게 그려지는가?** 아니. Konva 는 항상 CENTER. 우리 변환은 Rect dims 를 shrink + cornerR 도 보정해서 시각적으로 INSIDE 와 동일한 결과를 만듦. SVG `stroke-alignment` 처럼 native 지원이 아니라 emulated.
- **`frameMaskDisabled` 명명 — true 가 clip 비활성?** 그렇게 직렬화됨. Figma UI 에서 "Clip content" 가 ON 이면 `frameMaskDisabled === false`. 헷갈리는 이름이지만 .fig 가 그렇게 저장하므로 그대로 사용.
- **Konva 의 shadowOpacity vs color alpha** — Konva 는 `shadowColor` 의 alpha 와 `shadowOpacity` 둘 다 곱한 결과로 그림. 한 가지로 통일하기 위해 color 는 항상 alpha=1 로 고정하고 opacity 만 사용 — 합산 alpha 가 정확히 색의 a 가 됨.
