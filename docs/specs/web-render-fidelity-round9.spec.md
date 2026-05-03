# spec/web-render-fidelity-round9

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Canvas.tsx` (children 그루핑 + outer Group blendMode) + `web/client/src/lib/blurEffect.ts` + `web/client/src/components/canvas/LayerBlurWrapper.tsx` |
| 테스트 | `web/client/src/lib/blurEffect.test.ts` |
| 부모 | round 1~8 |

## 1. 목적

세 universal Figma 기능 — **LAYER_BLUR**, **isMask** (마스크 레이어), **노드-레벨 blendMode**. 모두 Figma 표준, 파일 종속 휴리스틱 없음. 메타리치 데이터엔 0 이지만 어느 .fig 에든 적용 가능한 표준 동작.

## 2. LAYER_BLUR

### 2.1 Field shape

```ts
effects: Array<{
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR',
  visible: boolean,
  radius: number,        // blur in px
  blendMode?: string,
  ...
}>
```

LAYER_BLUR 은 노드 자체를 흐리게 (밖으로 나간 픽셀이 흐려짐). BACKGROUND_BLUR 은 노드 *뒤* 의 픽셀을 흐리게 (frosted glass) — 후자는 캔버스 snapshot + composite 가 필요해 v1 비대상.

### 2.2 Konva 구현

- I-LB1 `layerBlurFromEffects(effects)` 가 첫 번째 `type === 'LAYER_BLUR' && visible !== false && (blendMode === 'NORMAL' || undefined)` entry 의 `radius` 를 반환. 없으면 null.
- I-LB2 `LayerBlurWrapper` 컴포넌트가 자식들을 `<Group ref>` 로 감싸고 `useEffect` 안에서:
  - `g.cache()` — Group 의 자식들을 비트맵으로 캐시.
  - `g.filters([Konva.Filters.Blur])`.
  - `g.blurRadius(r)`.
  - r 변경 시 다시 cache + filter 적용.
- I-LB3 cache 비용: blur 가 적용된 NodeShape 만 — 메타리치 같이 LAYER_BLUR 0 인 파일에선 path 자체가 활성화 안 됨.
- I-LB4 BACKGROUND_BLUR 은 v1 에서 무시 (no-op). 다음 라운드 후보.

## 3. isMask

### 3.1 Figma 의 mask 모델

Figma 에서 `isMask: true` 인 노드는 자기 *바로 다음 형제들 (next siblings)* 을 자기 모양으로 clip 한다. 즉 부모 children 의 [maskIndex+1 ... 다음 isMask 또는 끝] 구간이 마스크 영향권.

### 3.2 Render

- I-MK1 NodeShape 의 children loop 에서 `isMask: true` 노드를 발견하면:
  1. 그 mask 노드를 일반적으로 렌더 (기존 path 그대로).
  2. mask 다음 자식들 (다음 mask 또는 마지막 까지) 을 Konva.Group 으로 그룹화하고, 그 Group 에 `clipFunc` 를 mask 노드의 geometry 로 설정.
- I-MK2 Mask geometry: mask 노드가 RECTANGLE/FRAME 이면 cornerRadius 포함 rect; VECTOR 이면 Path data; 그 외 type 은 axis-aligned bbox 로 fallback.
- I-MK3 mask 노드 자체의 시각 (fill/stroke) 은 그대로 유지 — Figma 와 동일.
- I-MK4 v1 한계: mask 노드의 transform (rotation/translation) 이 자식 시야의 clip path 에 정확히 반영. children loop 는 단순 array slice 라 효율 OK.

## 4. Layer-level blendMode

### 4.1 Field

```ts
node.blendMode?: 'NORMAL' | 'PASS_THROUGH' | 'MULTIPLY' | ...
```

- I-NB1 `konvaBlendMode(node.blendMode)` 결과를 NodeShape 의 outer 요소 (Group / KText / Path) 의 `globalCompositeOperation` prop 으로 전달.
- I-NB2 `PASS_THROUGH` 는 Figma 그룹의 default — 부모로 합성을 위임. Konva 에는 직접 매핑 없음. v1: undefined 처리 (= 일반 source-over). 그룹 내 자식들이 각자 블렌드되므로 시각 차이 minimal.

## 5. 비대상 (v1)

- BACKGROUND_BLUR — 캔버스 snapshot + 별도 합성 필요. 별도 라운드.
- 다중 LAYER_BLUR (Konva 단일 cache 만).
- 마스크 노드의 visible=false 시 자식 처리 — Figma 는 마스크가 invisible 이어도 clip 적용. v1 에선 visible=false → 마스크 자체가 null return → 자식 unclipped. 발견 시 보강.
- mask 노드의 fillPaints 도 mask path 에 영향 — 우리 v1 은 geometry 만 사용, fill 무시 (Figma 도 동일).

## 6. Resolved questions

- **LAYER_BLUR 의 blendMode**: NORMAL 외엔 Konva.Filters.Blur 가 정확히 합성 못 함. NORMAL 만 처리. 이외는 무시 — 메타리치 데이터엔 모두 NORMAL.
- **mask 의 type 별 geometry**: RECTANGLE/FRAME = rounded rect, VECTOR = path data, ELLIPSE = ellipse path. 그 외 (TEXT/INSTANCE) 는 bbox. 메타리치엔 mask 0 이라 검증은 합성 fixture.
- **PASS_THROUGH 매핑**: 그룹 자체의 합성 모드를 부모에 위임 — Konva 에 정확한 등가 없음. undefined 처리 (= 일반 합성). 시각 차이는 그룹 안에 비-NORMAL 자식이 있을 때만 발생, 그 경우 자식의 globalCompositeOperation 이 부모에서 한 번 더 합성되는데 PASS_THROUGH 가 한 번 더 부모로 위임하는 의미라 실제 결과가 다를 수 있음. 별도 라운드에서 정밀화.
