# spec/web-render-fidelity-round6

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Canvas.tsx` (default Rect 분기 재구조) + `web/client/src/lib/paintRender.ts` + `web/client/src/components/canvas/InnerShadowOverlay.tsx` |
| 테스트 | `web/client/src/lib/paintRender.test.ts`, `web/client/src/components/canvas/InnerShadowOverlay.test.tsx` |
| 부모 | round 1~5 |

## 1. 목적

두 universal Figma 기능 — **multi-paint stacking** 과 **INNER_SHADOW**. 둘 다 .fig 데이터에 standard 로 정의된 필드. 파일 종속 휴리스틱 없음.

이전 라운드 round4 의 multi-paint top-pick 은 임시 단순화 — 위쪽 paint 한 개만 보였고 그 아래 layer 들은 무시됨. 본 라운드는 모든 visible paint 를 z-order 로 stacking 한다 (Figma 의 진짜 동작).

INNER_SHADOW 는 Konva 가 native 로 지원하지 않지만 canvas API 의 `globalCompositeOperation` + 양수-짝수 fill rule 로 emulation 가능.

## 2. Multi-paint stacking

### 2.1 데이터 모델

`fillPaints` 는 bottom-up 적층 — `[0]` 이 가장 아래, `[N-1]` 이 가장 위. 각 paint:
- `type`: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND' | 'IMAGE'
- `visible`: boolean
- `opacity`: number 0..1
- `blendMode`: string

### 2.2 Render order

- I-MP1 default Rect 분기는 다음 순서로 그린다 (z-order, 아래 → 위):
  1. **Background paints** — `fillPaints` 의 `visible !== false` 인 모든 항목, array 순서대로 (`[0]` 이 가장 먼저). 각 paint 가 한 Konva 요소:
     - SOLID → `<Rect fill={css}>`
     - GRADIENT_LINEAR / RADIAL → `<Rect ...gradientProps>`
     - GRADIENT_ANGULAR / DIAMOND → `<Rect fill={firstStopCss}>` (Konva 미지원 fallback)
     - IMAGE → `<ImageFill src={asset}>`
  2. **Inner shadow** (있는 경우) — InnerShadowOverlay 한 개.
  3. **Stroke** — `strokePaints[0]` 와 `strokeWeight` 가 있으면 dedicated stroke-only `<Rect fill={undefined} stroke={...} dash={...}>` 한 개. strokeAlign 으로 dims 조정.
  4. **Per-side stroke** lines (있는 경우).
  5. **Children** (자식 노드).
- I-MP2 모든 paint Rect 와 stroke Rect 의 cornerRadius 는 동일 (Konva 가 round corners 매칭).
- I-MP3 strokeAlign INSIDE/OUTSIDE 의 dims 조정은 stroke Rect 에만 적용; paint Rect 들은 base dims 사용.

### 2.3 Drop shadow attachment

- I-MP4 DROP_SHADOW 는 z-order 의 가장 아래 paint Rect 에 설정 — 그 paint 의 silhouette 이 shadow 의 source. paint 가 0개면 drop shadow 미렌더 (Figma 동일 — 빈 frame 은 그림자 없음).
- I-MP5 paint[0] 가 IMAGE 인 경우, ImageFill 컴포넌트가 Konva.Image 를 그리는데 이건 Konva 가 image-pixel-shape 의 shadow 를 그리지 않음 (기술적 한계). 우회: ImageFill 안에 추가로 Rect 하나를 같은 dims 로 깔고 거기에 shadow 부착 — 별도 라운드 후보. v1: image-only fill + drop shadow 조합은 shadow 누락 가능.

### 2.4 IMAGE paint 의 위치

- I-MP6 ImageFill 컴포넌트는 자기 cornerRadius clip 을 자체 적용 (round5 에서 array form 지원 추가). 따라서 paint stack 내 어떤 z-position 에서도 자연스럽게 그림.
- I-MP7 IMAGE paint 가 visible=false 면 ImageFill 컴포넌트를 만들지 않음.

### 2.5 Listening / 이벤트

- I-MP8 paint Rect 들과 stroke Rect 모두 `listening` 은 그룹 클릭 디스패치를 위해 기본 (true). 클릭은 Group 에서 처리 (현재 모델 그대로).

## 3. INNER_SHADOW

### 3.1 데이터 모델

```ts
effects: Array<{
  type: 'INNER_SHADOW',
  visible: boolean,
  offset: { x, y },
  radius: number,        // blur
  spread?: number,       // unsupported
  color: { r, g, b, a },
  blendMode: string,
}>
```

### 3.2 Konva sceneFunc 기법

INNER_SHADOW 는 노드의 *내부* 에 그림자가 떨어진 느낌을 그린다. 다음 기법으로 emulation:

1. 노드 bbox 와 동일한 path 로 clip (`ctx.clip()`).
2. **Outer-rect-minus-inner-rect** path 를 `evenodd` fill rule 로 그림. shadow* 파라미터가 set 된 상태로.
3. fill 은 outer 영역 (bbox 바깥) 을 칠하지만 clip 때문에 보이지 않음. 그러나 shadow 는 clip 안쪽으로 떨어지면서 보임.

```ts
sceneFunc(ctx) {
  ctx.save();
  drawRoundedPath(ctx, 0, 0, w, h, corners);
  ctx.clip();

  const PAD = Math.max(blur * 3 + max(|sx|, |sy|), 100);
  ctx.beginPath();
  ctx.rect(-PAD, -PAD, w + 2*PAD, h + 2*PAD); // outer (clockwise)
  drawRoundedPathReverse(ctx, 0, 0, w, h, corners); // inner (counter-clockwise)
  ctx.shadowOffsetX = sx;
  ctx.shadowOffsetY = sy;
  ctx.shadowBlur = blur;
  ctx.shadowColor = `rgba(r,g,b,a)`;
  ctx.fillStyle = 'rgb(0,0,0)';
  ctx.fill('evenodd');

  ctx.restore();
}
```

### 3.3 Invariants

- I-IS1 effects 배열에서 첫 번째 `type === 'INNER_SHADOW' && visible !== false` entry 만 사용 (Konva 의 단일-shadow 한계와 동일).
- I-IS2 `blendMode` 가 NORMAL 이 아니면 InnerShadow 비렌더 (Konva 가 정확히 못 합성 — DROP_SHADOW 와 동일 정책).
- I-IS3 `spread` 미지원 (canvas API 한계).
- I-IS4 cornerRadius array (per-corner) 도 그대로 처리 — `drawRoundedPath` 가 4 corner 받음.
- I-IS5 InnerShadowOverlay 는 `listening = false` — 이벤트 가로채지 않음.

## 4. 비대상 (v1)

- **여러 INNER_SHADOW 가 동시 적용**: 단일만.
- **INNER_SHADOW spread**: canvas 미지원.
- **LAYER_BLUR / BACKGROUND_BLUR**: canvas filter API 필요. 별도 라운드.
- **Multi-paint blendMode (multiply / screen 등)**: 각 paint 의 blendMode 가 NORMAL 이 아니면 stacking 결과가 정확히 일치하지 않음. v1 은 NORMAL 만.
- **IMAGE paint + DROP_SHADOW 조합**: image-only fill 은 shadow 누락 가능 (I-MP5).
- **Multi-paint per-paint opacity 와 layer opacity 이중 합성**: Konva 가 자동 처리 (각 Rect 의 fill alpha 와 부모 Group 의 opacity).

## 5. Resolved questions

- **paint stack 에서 stroke 의 z-order**: 모든 fill paint *위*. Figma UI 에서 stroke 토글이 paint 와 별개 섹션이고 strokeAlign 까지 따로 있으므로 stroke 가 fill 위에 있다고 보는 것이 자연스럽다 (Konva 의 단일 fill+stroke Rect 도 stroke 가 위에 그려짐).
- **Drop shadow 위치**: 가장 아래 paint Rect. shadow 의 source 가 그 paint 의 silhouette 이 됨 — 시각적으로 노드 전체 silhouette 의 shadow 와 동일 (paint stack 이 같은 dims).
- **INNER_SHADOW 대 clip 이 frameMaskDisabled 와 충돌하는지**: 두 clip 이 별개 Konva 요소에서 적용되므로 충돌 없음. InnerShadowOverlay 의 ctx.clip() 은 자기 sceneFunc 내부에서만 유효 (ctx.save/restore).
