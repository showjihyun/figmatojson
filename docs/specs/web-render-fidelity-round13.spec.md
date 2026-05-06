# spec/web-render-fidelity-round13

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/lib/strokeAlign.ts` (`applyStrokeAlignToVectorPath`) + `web/client/src/Canvas.tsx` (VECTOR 분기) |
| 테스트 | `web/client/src/lib/strokeAlignVector.test.ts` |
| 부모 | round 2 (§I-SA5 의 명시적 v1 비대상) |
| 형제 | round 11 (path inset), round 12 (path scale) |

## 1. 배경

`web-render-fidelity-round2.spec.md §I-SA5` 가 명시적으로 *VECTOR Path 분기에는
strokeAlign 미적용* 으로 둠 (이유: SVG `stroke-alignment` 가 비표준이라 Konva
도 native 미지원). 그 결과 `strokeAlign === 'INSIDE'` 가 있는 vector 노드는
Konva 의 default CENTER stroke 로 그려져 stroke 의 절반이 path 외측으로
나간다. HPAI fixture 에서 `2625:1343 ELLIPSE "Ellipse 150"` 가 정확히 이
케이스:

| 필드 | 값 |
|---|---|
| size | 80×80 |
| normalizedSize | 80×80 (round 11/12 미발동) |
| fillPaints | SOLID 흰색 |
| strokePaints | SOLID 빨강 (`#ED0000`) |
| **strokeWeight** | **5** |
| **strokeAlign** | **`INSIDE`** |
| effects | DROP_SHADOW |

Figma 의도: 80px 직경 흰 원, 외측 경계는 정확히 80, 안쪽 5px 만 빨강. 우리
현재 동작: 직경 85px (stroke 양쪽 outset 2.5px) 의 흰 원 + 빨강 외곽선 →
overall 더 크고 stroke 이 frame 밖으로 나감.

## 2. Konva paint-order plumbing

Konva.Path 는 `stroke-alignment` native prop 이 없지만 두 가지 paint-order
plumbing 이 있다:

| Konva mode | 그림 순서 | 시각 결과 (CENTER stroke 기준) |
|---|---|---|
| default (`fillAfterStrokeEnabled=false`) | fill → stroke | stroke 의 *inside half* 가 fill 위에 그려짐. outside half + inside half 모두 보임 (CENTER) |
| `fillAfterStrokeEnabled=true` | stroke → fill | fill 이 stroke 의 *inside half* 를 덮음. **outside half 만 보임** ⇒ **OUTSIDE 효과** |
| Group `clipFunc(path)` wrap | 자식들이 path 모양 안쪽으로 clip | stroke 의 *outside half* 가 잘림. **inside half 만 보임** ⇒ **INSIDE 효과** |

따라서:
- **INSIDE**: Konva.Group `clipFunc` 으로 path 안쪽 clip 영역 셋팅 + 자식
  Konva.Path 의 strokeWidth 2 배. clip 이 외측 절반을 잘라 내측 절반만
  남음 = original strokeWidth.
- **OUTSIDE**: `fillAfterStrokeEnabled=true` + strokeWidth 2 배. fill 이
  내측 절반을 덮어 외측 절반만 남음 = original strokeWidth.
- **CENTER / 미지정**: pass-through (Konva 기본).

(주: round 13 의 emulation 매핑은 두 번 정정됐다.
- **round 13.0**: INSIDE 를 `fillAfterStrokeEnabled=true` 로 매핑 — Konva
  소스 (`Context.fillStrokeShape`) 가 stroke→fill 순서라 결과는 *outside-only*.
  방향 거꾸로.
- **round 13.1**: INSIDE 를 Group `clipFunc` wrap 으로 변경. 그러나
  clipFunc 안에서 `ctx.fill(path2d)` 호출 — 이게 *실제 그림을 그려서*
  default fillStyle (검정) 으로 ELLIPSE 가 전부 검게 보이는 회귀.
  Konva clipFunc 은 sub-path 만 정의해야 하고, 반환값으로 `ctx.clip()`
  의 인자를 줄 수 있다 (`Container._drawChildren`:
  `ctx.clip.apply(ctx, clipArgs)`).
- **round 13.2 (현재)**: clipFunc 이 `[new Path2D(plan.path)]` 를 *반환* —
  Konva 가 `ctx.clip(path2d)` 자동 호출. 그림 안 그림, clip 만 셋팅.)

### 2.1 변환 룰

- I-V1 `strokeAlign === 'INSIDE'` && visible fill && `strokeWeight > 0`:
  - strokeWidth → `strokeWeight * 2`
  - 호출자 (Canvas.tsx VECTOR 분기) 가 `<Path>` 를 `<Group clipFunc>` 으로
    wrap. `clipFunc` 은 Path2D(`node._path`) 를 `_pathOffset` / `_pathScale`
    동일 transform 으로 fill — Konva 가 그 결과를 자식 clip 으로 사용.
  - `fillAfterStrokeEnabled` 는 false (default).
- I-V2 `strokeAlign === 'OUTSIDE'` && visible fill && `strokeWeight > 0`:
  - strokeWidth → `strokeWeight * 2`
  - `fillAfterStrokeEnabled` → true.
  - clipFunc wrap 미적용.
- I-V3 그 외 (CENTER / undefined / fill 없음 / strokeWeight ≤ 0):
  pass-through — strokeWidth 원본, 두 plumbing 모두 false.
- I-V4 fill 없는 stroke-only vector (700:319 등): `fill` 이 없으므로 INSIDE
  / OUTSIDE 모두 시각적으로 CENTER 와 동일. emulation 미적용 — 원본 strokeWidth
  그대로.

### 2.2 헬퍼 시그니처

```ts
// web/client/src/lib/strokeAlign.ts (round 13 — 정정)
export interface VectorStrokeAlignProps {
  strokeWidth: number;
  fillAfterStrokeEnabled: boolean;
  clipToPath: boolean;       // INSIDE 시 호출자가 Group clipFunc wrap
}
export function applyStrokeAlignToVectorPath(
  strokeWeight: number | undefined,
  strokeAlign: StrokeAlign,
  hasVisibleFill: boolean,
): VectorStrokeAlignProps;
```

반환 룰:
- INSIDE + fill: `{ strokeWidth: w*2, fillAfterStrokeEnabled: false, clipToPath: true }`
- OUTSIDE + fill: `{ strokeWidth: w*2, fillAfterStrokeEnabled: true, clipToPath: false }`
- 그 외: `{ strokeWidth: w, fillAfterStrokeEnabled: false, clipToPath: false }` — 원본.

`hasVisibleFill` 검사는 호출자가 한다. 일반적으로 `pathFill !== 'transparent'`.

## 3. 적용 범위

- I-3 `web/client/src/Canvas.tsx` 의 VECTOR_TYPES 분기 — `<Path>` 의
  `strokeWidth` / `fillAfterStrokeEnabled` 를 헬퍼 결과로 셋팅.
- I-4 일반 노드 (FRAME/RECTANGLE 의 background Rect) 는 round 2 의
  `applyStrokeAlign` (rect 좌표 inset) 그대로. 본 라운드 영향 없음.
- I-5 round 11 의 `_pathOffset` / round 12 의 `_pathScale` 와 직교 —
  같은 노드에 둘 다 적용 가능. INSIDE 시뮬레이션의 strokeWidth 변경은
  Konva scale 의 영향을 받음 (scale 0.5 면 stroke 도 절반). 본 라운드는
  의도된 동작 — figma 의 vector node 도 size 가 작아지면 stroke 도 시각적으로
  비례 축소되는 것이 일반적.

## 4. Invariants — 한 줄 요약

| ID | 명제 | 검증 |
|---|---|---|
| I-V1 | INSIDE + visible fill → `strokeWidth*2` + `fillAfterStrokeEnabled=true` | unit |
| I-V2 | CENTER / undefined → 원본 strokeWidth, `fillAfterStrokeEnabled=false` | unit |
| I-V3 | OUTSIDE → 원본 strokeWidth (비대상, 회귀 0) | unit |
| I-V4 | INSIDE + fill 없음 → 원본 strokeWidth (시각 회귀 방지) | unit |
| I-V4a | strokeWeight 0 또는 undefined → 원본 0 / undefined 그대로 | unit |

## 5. Out of scope

- ❌ OUTSIDE strokeAlign — 별도 라운드 필요 (Konva.Path 에 OUTSIDE emulation
  은 stroke twice + fill mask 같은 더 복잡한 기법).
- ❌ vector node 의 dashed stroke 와 INSIDE 의 상호작용 — fillAfterStrokeEnabled
  가 dash 사이 빈 공간에서도 fill 로 덮는지 확인 필요. 발견 시 보정.
- ❌ INNER_SHADOW / multi-stroke vector. 메타리치/HPAI 데이터에 없음.
- ❌ `strokeAlign` 의 plugin/REST audit 비교 — `audit-oracle.spec.md` 의
  COMPARABLE_FIELDS 비대상 (감지만 가능, fix 후 audit signal 영향 0).

## 6. 참조

- `docs/specs/web-render-fidelity-round2.spec.md §I-SA5` — 본 라운드의 출발점
- Konva docs — `Shape#fillAfterStrokeEnabled`
