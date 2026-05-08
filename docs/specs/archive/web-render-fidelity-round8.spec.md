# spec/web-render-fidelity-round8

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Canvas.tsx` ImageFill + 일반 분기 stroke 부분 + `web/client/src/lib/imageScale.ts` |
| 테스트 | `web/client/src/lib/imageScale.test.ts` |
| 부모 | round 1~7 |

## 1. 목적

두 universal Figma 기능 — **IMAGE scaleMode** (FILL/FIT/CROP/STRETCH/TILE) 와 **stroke gradient fallback**. 둘 다 Figma 표준 필드. 파일 종속 휴리스틱 없음.

이전 라운드들에선 모든 IMAGE paint 가 box 사이즈로 단순 stretch — 사진 비율이 box 와 다르면 늘어진 형태. Figma 는 기본 FILL (object-fit: cover) 동작이라 큰 visible 격차. 메타리치 86개 image fill 중 86개가 FILL, 5개가 STRETCH.

Stroke gradient 는 메타리치엔 없지만 Figma 의 universal 기능. Konva 의 stroke prop 은 단일 색상만 받음 — gradient stroke 는 별도 path geometry 가 필요해 v1 에서 first-stop solid 로 fallback.

## 2. IMAGE scaleMode

### 2.1 Field shape

```ts
paint: {
  type: 'IMAGE',
  visible: boolean,
  imageScaleMode: 'FILL' | 'FIT' | 'CROP' | 'STRETCH' | 'TILE',
  rotation?: number,
  scalingFactor?: number,    // TILE 의 scale
  image: { hash: ... },
  filters?: { ... },          // brightness/contrast/saturation 등 — v1 비대상
}
```

### 2.2 Konva crop 계산

Konva.Image 의 `crop` prop = `{x, y, width, height}` — 원본 이미지의 어느 부분을 잘라 사용할지. width/height prop = destination box. 둘을 조합해서 object-fit 효과 emulate.

`computeImageCrop(scaleMode, imgW, imgH, boxW, boxH)` 반환:
```ts
{
  crop?: { x, y, width, height },   // Konva.Image crop prop
  dstX: number, dstY: number,        // image's x/y inside the box
  dstW: number, dstH: number,        // image's width/height
  tile: boolean,                     // TILE → caller falls back / skips
}
```

### 2.3 FILL (= object-fit: cover)

- I-IS1 비율 유지 + box 채우도록 crop. 이미지가 box 보다 wide → 좌우 잘림. 이미지가 narrow → 위아래 잘림.
- 알고리즘:
  ```
  imgAspect = imgW / imgH
  boxAspect = boxW / boxH
  if imgAspect > boxAspect:
    // image wider — crop sides
    cropH = imgH
    cropW = imgH * boxAspect
    cropX = (imgW - cropW) / 2
    cropY = 0
  else:
    // image taller — crop top/bottom
    cropW = imgW
    cropH = imgW / boxAspect
    cropX = 0
    cropY = (imgH - cropH) / 2
  ```
- dst = (0, 0, boxW, boxH) — Konva 가 cropped portion 을 dst 영역에 fit.

### 2.4 FIT (= object-fit: contain)

- I-IS2 비율 유지 + box 안에 들어가도록. 가장자리에 letterbox 빈 공간.
- crop = 전체 이미지 (`{x:0, y:0, width: imgW, height: imgH}`).
- dst = box 안에 fit 하는 사각형 — 이미지가 wider → height 줄임, narrow → width 줄임. 중심 정렬.

### 2.5 CROP

- I-IS3 1:1 scale (no resize), 중심 정렬, box 밖 부분 잘림.
- crop = box 사이즈만큼의 중앙 영역.
- dst = (0, 0, boxW, boxH).
- 이미지가 box 보다 작으면 letterbox (가장자리 transparent 또는 border).

### 2.6 STRETCH (= 현재 동작)

- I-IS4 비율 무시. crop = full image. dst = (0, 0, boxW, boxH). Konva 의 `width / height` prop 만으로 충분 — crop 생략.

### 2.7 TILE

- I-IS5 v1 비대상. caller 가 STRETCH 처럼 fallback 해서 일단 stretch 로 표시. Konva 의 Pattern fill 로 구현하려면 별도 `Konva.Image` + `fillPatternImage` 패턴 사용 — 복잡도 높아 미루기.

### 2.8 imageScaleMode 외 paint 필드

- I-IS6 `paint.rotation` 회전: v1 비대상. 0 이 아닌 경우 별도 Konva Group 으로 wrap 해서 crop 영역 회전 필요. 메타리치 모두 0.
- I-IS7 `paint.filters` (brightness/contrast/saturation/hue/temperature/tint): canvas filter 필요. v1 비대상.

## 3. Stroke gradient fallback

### 3.1 Background

`strokePaints[0]` 가 GRADIENT_* 타입인 경우 Konva.Rect / Path 의 stroke prop 은 단일 색상만 받음. Gradient stroke 를 정확히 그리려면 stroke 영역에 해당하는 path geometry 를 만들어 그 안을 gradient 로 채워야 함 — 복잡도 높음.

### 3.2 Fallback rule

- I-SG1 stroke paint 가 GRADIENT_LINEAR / RADIAL / ANGULAR / DIAMOND 인 경우, `firstStopRgba(paint)` 결과를 stroke color 로 사용. 단일 stop 색상이 디자인의 dominant 색을 대표하므로 시각 차이 minimal.
- I-SG2 stroke paint 가 IMAGE 인 경우 v1 미지원 — stroke 그리지 않음.
- I-SG3 SOLID 는 기존 경로 그대로.

### 3.3 Implementation

기존 `strokeOf(node) = solidStrokeCss(node)` 가 SOLID 만 처리. 새 helper `strokeFromPaints(node)` 가 SOLID + GRADIENT 둘 다 처리. Canvas.tsx 의 `strokeOf` 호출을 `strokeFromPaints` 로 교체.

## 4. 비대상 (v1)

- TILE imageScaleMode (Konva pattern 필요)
- IMAGE paint rotation
- IMAGE paint filters (brightness/contrast/...)
- 진짜 gradient stroke (path geometry 필요)
- IMAGE stroke paint

## 5. Resolved questions

- **FILL vs FIT 의 시각 차이**: FILL = cover (잘림), FIT = contain (letterbox). Figma 기본은 FILL. 메타리치 86개 모두 FILL.
- **CROP 와 FILL 의 차이**: CROP 은 1:1 scale (이미지 원래 크기 유지), FILL 은 box 에 맞게 scale up/down 하면서 비율 유지. CROP 이 더 specific 한 케이스.
- **Konva.Image 의 crop prop 동작**: source image 의 (x, y, width, height) 영역을 (dstX, dstY, dstW, dstH) 에 그림 — `ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)` 와 동일.
