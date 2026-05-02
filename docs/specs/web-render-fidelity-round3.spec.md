# spec/web-render-fidelity-round3

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Canvas.tsx` 3개 render 분기 + `web/client/src/lib/transform.ts`, `web/client/src/lib/strokeCapJoin.ts` |
| 테스트 | `web/client/src/lib/transform.test.ts`, `web/client/src/lib/strokeCapJoin.test.ts` |
| 부모 | `web-render-fidelity-high.spec.md`, `web-render-fidelity-round2.spec.md` |

## 1. 목적

Figma 의 **universal feature** 3종 — 회전, 레이어 투명도, stroke cap/join — 을 렌더 파이프라인에 추가한다. 모두 .fig 데이터에 이미 들어있는 필드인데 Canvas 가 무시했던 것. 이 라운드 후 대부분의 디자인 파일에서 추가 문제 없이 보일 수 있을 정도가 된다.

**파일 종속성 없음** — 본 spec 의 모든 invariant 는 Figma 의 공개 데이터 모델에 정의된 필드만을 다루며, 특정 sample (`메타리치`, `bvp.fig`) 에 종속적인 휴리스틱은 없다. 테스트는 모두 합성 fixture 로 작성.

## 2. Rotation

### 2.1 Field shape

Figma 의 `transform` 은 2x3 affine 행렬:
```
[ m00 m01 m02 ]    [ scaleX*cos(θ)  -scaleY*sin(θ)  tx ]
[ m10 m11 m12 ]  ≈ [ scaleX*sin(θ)   scaleY*cos(θ)  ty ]
```

기본값 (translation only): `m00=1, m01=0, m10=0, m11=1`.

### 2.2 Rotation extraction

- I-R1 `rotationDegrees(transform)` 는 다음 알고리즘으로 회전 각을 추출:
  - `m00`, `m10` 으로 `atan2(m10, m00)` (라디안) → 도(degree) 변환.
  - 결과가 ±0.01° 이내면 0 으로 clamp (부동소수 잡음 회피).
  - identity (`m00===1 && m01===0 && m10===0 && m11===1`) 면 `undefined` 반환.
- I-R2 **순수 회전 검출**: skew 나 non-uniform scale 이 섞여 있으면 단순 rotation 만으로 정확히 그릴 수 없음. `isPureRotation(transform)` 은 다음 조건 모두 만족 시 true:
  - `m00 ≈ m11` (uniform scale, 보통 1)
  - `m01 ≈ -m10` (회전만, skew 없음)
  - tolerance ±0.001
- I-R3 `isPureRotation === false` 인 경우 (skew / non-uniform 포함) 본 라운드에서는 회전 미적용 — translation 만 적용 (원래 동작 그대로). 향후 raw matrix 변환은 별도 라운드 후보.

### 2.3 Konva 매핑

- I-RM1 outer Konva element (TEXT 의 KText, VECTOR 의 Group, 일반 노드의 Group) 에 `rotation={deg}` prop 추가.
- I-RM2 Konva 의 rotation 은 노드의 `(x, y)` 위치를 pivot 으로 그 자리에서 회전 — Figma 의 transform 도 부모 origin 에 위치한 후 그 점을 중심으로 회전이므로 시각적으로 일치.
- I-RM3 `rotation === undefined` 면 prop omit (Konva 기본 0).
- I-RM4 회전 노드가 자식을 가지는 경우 (FRAME 등), 자식의 transform 은 회전된 부모 좌표계 기준으로 이미 baked 되어 있으므로 추가 작업 없음 — Konva 가 부모 회전을 자식에 자동 전파.

## 3. Layer opacity

### 3.1 Field shape

```ts
node.opacity?: number   // 0..1, 기본 1
```

### 3.2 Konva 매핑

- I-OP1 outer Konva element 에 `opacity={node.opacity}` prop. `undefined` 또는 `1` 이면 prop omit.
- I-OP2 `opacity === 0` 도 그린다 — 노드는 invisible 이지만 layout 공간 차지 (Figma 동일). `visible === false` 인 노드는 별도 경로로 이미 `null` 반환 (NodeShape impl 도입부의 가드).
- I-OP3 자식 노드가 자기만의 opacity 를 가진 경우, Konva 가 부모 opacity 와 곱해서 자동 처리 (예: 부모 0.5, 자식 0.5 → 최종 0.25). Figma 동일 동작.
- I-OP4 fillPaints / strokePaints 의 paint-level opacity 는 별개 — paint 가 자기 `opacity` 를 가지면 색상에 미리 합성됨. 본 spec 의 opacity 는 *레이어 단위* 한정.

## 4. strokeCap / strokeJoin

### 4.1 Field shape

```ts
node.strokeCap?:  'NONE' | 'ROUND' | 'SQUARE' | 'LINE_ARROW' | 'TRIANGLE_ARROW'
node.strokeJoin?: 'MITER' | 'ROUND' | 'BEVEL'
```

### 4.2 Konva 매핑

- I-SC1 strokeCap 매핑 (Konva.Path/Line `lineCap`):
  - `'NONE'` → `'butt'` (또는 prop omit — Konva 기본 butt)
  - `'ROUND'` → `'round'`
  - `'SQUARE'` → `'square'`
  - `'LINE_ARROW'` / `'TRIANGLE_ARROW'` → 미지원 (v1 비대상). butt 로 fallback.
- I-SC2 strokeJoin 매핑 (Konva.Path/Line `lineJoin`):
  - `'MITER'` → `'miter'` (또는 prop omit)
  - `'ROUND'` → `'round'`
  - `'BEVEL'` → `'bevel'`
- I-SC3 적용 범위 — VECTOR `Path` 분기와 per-side stroke 의 `Konva.Line` 4개. 일반 Rect 의 stroke 도 lineJoin 은 MITER 가 기본이지만 ROUND/BEVEL 인 경우 cornerRadius 와 상호작용 가능 — Konva.Rect 도 `lineJoin` prop 받음.

## 5. Implementation guard rails

- I-IM1 변경 범위는 `Canvas.tsx` 의 3개 render 분기 + 두 helper 파일. 다른 layer 변경 없음.
- I-IM2 NodeShape memoization 은 영향 없음 — 추가 props 모두 `node` 에서 파생.
- I-IM3 selection overlay / hover overlay 의 위치 계산 — 회전 노드의 bbox 가 회전 후에는 axis-aligned 가 아니지만, 본 라운드에서는 selection overlay 를 회전 *전* bbox 에 그대로 그린다 (시각적으로 약간 어긋남). 정확한 OBB 표시는 별도 라운드.

## 6. 비대상 (v1)

- **Skew / non-uniform scale transforms** — `isPureRotation === false` 케이스. 정확하게 그리려면 Konva.Group 의 raw transform matrix 를 설정해야 하는데 react-konva 가 직접 노출하지 않음. 별도 라운드 (드물게 사용).
- **회전된 노드의 selection / hover overlay** — overlay 가 axis-aligned bbox 로 그려져 회전 노드를 약간 못 따라감. 별도 라운드.
- **strokeCap LINE_ARROW / TRIANGLE_ARROW** — Konva 미지원. 화살표 그리려면 별도 도형 추가 필요.
- **Path miterLimit** — Konva 기본값 사용.
- **strokeAlign INSIDE/OUTSIDE 와 회전 결합** — round2 의 strokeAlign 변환 (rect dims 조정) 은 회전 후에도 정상 동작 (Konva 가 transform 적용 전 좌표 기준으로 그림). 별도 케이스 처리 불필요.

## 7. Resolved questions

- **Skew 가 데이터에 얼마나 있는가?** 메타리치 35K 노드 중 0건. bvp.fig 도 거의 없을 것 (디자인 파일은 보통 회전만 사용). 별도 라운드 punt 가 안전.
- **Konva rotation 의 pivot 이 Figma 와 일치하는가?** 일치. Konva `rotation` 은 `(x, y)` 점을 pivot 으로 회전, Figma transform 도 부모 origin (= node 의 x/y) 기준 회전. 단 `offsetX/Y` prop 을 설정하면 pivot 이 바뀌므로 본 spec 에서는 `offsetX/Y` 를 사용하지 않음.
- **opacity 와 fill alpha 의 관계** — Konva 가 둘을 곱해서 그림 (Figma 와 동일). 별도 처리 불필요.
