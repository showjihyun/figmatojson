# spec/web-render-fidelity-round7

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Canvas.tsx` (findAbsBounds + SelectionOverlay + Hover wiring) + `web/client/src/components/canvas/HoverOverlay.tsx` + `web/client/src/lib/blendMode.ts` |
| 테스트 | `web/client/src/lib/blendMode.test.ts`, `web/client/src/components/canvas/HoverOverlay.test.tsx` (확장) |
| 부모 | round 1~6 |

## 1. 목적

두 universal Figma 기능 — **회전 노드의 OBB 선택/hover overlay** 와 **per-paint blendMode**. 둘 다 .fig 데이터에 standard 로 정의됨, 파일 종속 휴리스틱 없음.

이전 라운드들로 회전 자체는 렌더되지만 (round 3), 선택/hover overlay 는 axis-aligned bbox 로 그려져서 회전된 노드를 따라가지 못함 — 이번 라운드에서 정합. paint blendMode 는 multi-paint stacking 의 약속을 완성 — 적층된 paint 들이 NORMAL 외 모드로 합성되도록.

## 2. OBB rotated overlay

### 2.1 Background

현재:
- 노드 자체는 round 3 의 `rotationDegrees` + Konva Group rotation prop 으로 회전 렌더 OK.
- SelectionOverlay 는 `findAbsBounds` 가 반환한 axis-aligned `{x, y, w, h}` 만 받아 회전 정보 없이 그림.
- HoverOverlay 는 `e.target.getClientRect({relativeTo: stage})` 의 AABB 받아 회전 정보 없이 그림.

결과: 회전 노드 위에 axis-aligned 사각형이 떠 있어 시각적으로 어긋남.

### 2.2 Solution

- I-OB1 `findAbsBounds(root, guid, ...)` 의 반환 형식을 `{x, y, w, h, rotation}` 으로 확장. `rotation` = leaf 노드의 회전 각도 (`rotationDegrees(node.transform) ?? 0`).
- I-OB2 SelectionOverlay 의 props 에 `rotation: number` 추가. 그 outer Konva Group 에 `rotation={rotation}` 적용. Konva 가 group 의 `(x, y)` 를 pivot 으로 회전.
- I-OB3 HoverOverlay (props `bbox + name + scale`) 에 `rotation: number` 추가. 동일하게 outer Group 에 적용. 호출자 (Canvas) 는 hover state 에 rotation 도 저장.
- I-OB4 hoverApi.enter 에서 회전 추출:
  - 노드의 transform 에서 `rotationDegrees` 호출.
  - hover state 의 `designBbox` 는 회전 *전* 의 axis-aligned bbox (= node.transform.m02/m12 + size). `e.target.getClientRect({relativeTo: stage})` 는 회전 후의 AABB 를 반환하므로 회전 노드에서 부정확. 새 경로: `e.target.x()` / `e.target.y()` (Konva node 의 set 값) + `node.size`.
- I-OB5 **Nested ancestor rotation 은 v1 비대상** — leaf 노드의 회전만 반영. 부모 FRAME 이 회전된 경우 selection overlay 는 부정확해질 수 있음 (메타리치는 그런 케이스 없음, 일반 디자인 파일에서도 거의 없음).

### 2.3 다중 선택의 OBB

- I-OB6 다중 선택 시 (group bbox + corner handles) — 각 멤버가 다른 rotation 을 가질 수 있어 group bbox 자체를 OBB 로 만들 수 없음. v1: 다중 선택은 axis-aligned (현재 동작) 유지. 별도 라운드에서 union-of-OBBs 로 발전 가능.
- I-OB7 **Resize handles 는 rotation === 0 일 때만 렌더** (v1). 회전된 노드의 corner-drag resize 는 local-↔-parent 좌표 변환 매트릭스가 더 필요해 별도 라운드. 회전 노드는 outline + size badge 만 표시. 사용자는 인스펙터를 통해 resize 가능 (현행 동작).

## 3. Paint blendMode

### 3.1 Field shape

```ts
paint: {
  type: ...,
  visible: boolean,
  opacity: number,
  blendMode?: 'NORMAL' | 'DARKEN' | 'MULTIPLY' | 'COLOR_BURN' | 'LIGHTEN' | 'SCREEN' | 'COLOR_DODGE' | 'OVERLAY' | 'SOFT_LIGHT' | 'HARD_LIGHT' | 'DIFFERENCE' | 'EXCLUSION' | 'HUE' | 'SATURATION' | 'COLOR' | 'LUMINOSITY' | 'PASS_THROUGH'
}
```

### 3.2 Konva 매핑

- I-BM1 `konvaBlendMode(figma)` (lib/blendMode.ts):
  - 'NORMAL' / undefined → undefined (prop omit).
  - 'PASS_THROUGH' → undefined (Figma 의 PASS_THROUGH 는 그룹 합성을 부모로 통과시키는 의미 — 단일 paint 에는 적용 안 됨, undefined 로 fallback).
  - 그 외 → kebab-case CSS / canvas 모드명:
    - DARKEN → 'darken', MULTIPLY → 'multiply', COLOR_BURN → 'color-burn', LIGHTEN → 'lighten', SCREEN → 'screen', COLOR_DODGE → 'color-dodge', OVERLAY → 'overlay', SOFT_LIGHT → 'soft-light', HARD_LIGHT → 'hard-light', DIFFERENCE → 'difference', EXCLUSION → 'exclusion', HUE → 'hue', SATURATION → 'saturation', COLOR → 'color', LUMINOSITY → 'luminosity'.
- I-BM2 적용: multi-paint stack 의 각 paint Rect 에 `globalCompositeOperation={konvaBlendMode(paint.blendMode)}` prop. ImageFill 의 Konva.Image 에도 동일.
- I-BM3 첫 번째 paint (i === 0) 의 blendMode 는 underlying 캔버스가 transparent 라 NORMAL 과 동일한 결과. 그래도 prop 은 그대로 전달 (특수 케이스 없음).

## 4. 비대상 (v1)

- **Multi-select OBB**: 각 멤버의 회전 합 union. 별도 라운드.
- **Nested ancestor rotation 누적**: 부모 FRAME 이 회전된 경우 leaf 의 절대 회전 = 부모 + 자식. v1 leaf 만.
- **Skew transforms**: round 3 에서 punt 한 것과 동일 — `isPureRotation === false` 면 회전 0 으로 떨어짐.
- **Layer-level blendMode** (`node.blendMode`): 노드 전체의 blendMode (paint 가 아니라 노드). 동일한 매핑 함수 재사용 가능 — 발견 시 별도 라운드.

## 5. Resolved questions

- **Konva Group rotation pivot**: `(x, y)` 위치를 pivot 으로 회전. SelectionOverlay 의 outer Group 위치를 노드의 `(x, y)` 로 두고 rotation 적용 → 시각적으로 노드와 정확히 일치.
- **`globalCompositeOperation` 가 transparent canvas 에서 동작하는지**: 표준 canvas 동작. 이전 paint 가 그려진 픽셀과 새 paint 의 블렌드는 일반적인 합성 룰을 따른다 (multiply, screen 등 모두 표준).
- **PASS_THROUGH 처리**: Figma 의 그룹 PASS_THROUGH 는 부모로 합성을 위임하는 의미라 *paint* 단에선 의미 없음 — 무시.
