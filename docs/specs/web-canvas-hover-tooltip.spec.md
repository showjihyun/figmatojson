# spec/web-canvas-hover-tooltip

| 항목 | 값 |
|---|---|
| 상태 | Approved (v2 — Konva-rendered border + label pill) |
| 구현 | `web/client/src/Canvas.tsx` 의 hover state + `web/client/src/components/canvas/HoverOverlay.tsx` |
| 테스트 | `web/client/src/components/canvas/HoverOverlay.test.tsx` |
| 형제 | `web-left-sidebar.spec.md` (선택 동기화 / auto-reveal 과 별개 시스템) |

## 1. 목적

캔버스 노드 위에 마우스를 올리면 그 노드의 식별 정보를 작은 툴팁으로 표시한다 — Figma 의 hover affordance 와 동일. 사용자가 클릭으로 선택하기 전에 노드의 이름과 사이즈를 미리 확인할 수 있다.

배경:
- 35K-node 메타리치 같은 큰 디자인에서, 캔버스만 봐서는 어떤 컴포넌트인지 식별하기 어렵다 (이름이 보이지 않음).
- 인스펙터는 *선택된* 노드만 보여준다 — hover-only 식별 surface 는 별개로 필요.

## 2. 표시 내용 (v2 — Figma-style canvas overlay)

```
┌──┬──────┐ ← name pill at top-left of bbox
│  │ Card │
└──┴──────┘
┌────────────────────┐
│                    │ ← 1px stroke around bbox (no fill)
│                    │
└────────────────────┘
```

- I-T1 **Border**: 노드 bbox 를 둘러싸는 stroke-only Konva.Rect. fill = transparent. stroke = primary 색 (Figma 의 #0a84ff 와 동일 톤). strokeWidth = `1 / scale` 로 zoom 에 무관하게 1px 유지.
- I-T2 **Name pill**: bbox 의 top-left 외부에 작은 Konva.Group — primary-색 채워진 Rect 배경 + 흰색 Konva.Text 로 노드 이름. 위치 = `(bbox.x, bbox.y - pillHeight)` (label 이 노드 위에 살짝 떠 있음). 좌상단이 stage 밖으로 잘리면 (음수 y) 라벨을 노드 안쪽 (`bbox.y`) 으로 푸시 — Figma 동일 동작.
- I-T3 라벨 텍스트 = `node.name`. 빈 이름은 `<unnamed>`. 길이 제한 없이 표시 (Figma 동일).
- I-T4 라벨/border 색은 selection overlay 의 색과 동일 (`#0a84ff`) — Figma 도 hover/select 가 같은 색.
- I-T5 **이미 selected 인 노드는 hover overlay 미표시** — selection overlay 가 같은 자리를 이미 차지하므로 중복 표시 회피.

## 3. Position (Konva-rendered)

- I-P1 hover overlay 는 **selection overlay 와 같은 Layer** 에서 그린다 (z-order 가 캔버스 콘텐츠 위, selection 과 동일 레벨). Stage 의 transform (offset/scale) 을 자동으로 받으므로 pan/zoom 시 별도 수학 없이 노드와 함께 움직인다.
- I-P2 bbox 좌표 = `hover.designBbox` (이미 stage-local 디자인 좌표) 를 그대로 Konva.Rect 의 x/y/width/height 로 사용.
- I-P3 라벨 폰트 / 패딩 / 두께는 모두 `1/scale` / `12/scale` 등 zoom-corrected — 줌에 무관하게 픽셀 일정.

## 4. State

- I-S1 `Canvas` 컴포넌트가 `hoveredGuid: string | null` state 를 보유.
- I-S2 NodeShape 의 Konva 이벤트:
  - `onMouseEnter(e)` → `setHoveredGuid(guidStr(node.guid))`. `e.cancelBubble = true` 로 부모 노드의 onMouseEnter 가 덮어쓰지 않게 — 가장 깊은 노드가 hover 의 주인공.
  - `onMouseLeave(e)` → `setHoveredGuid((cur) => cur === thisGuid ? null : cur)`. 다른 노드로 바로 진입한 경우 그 노드의 onMouseEnter 가 이미 갱신했을 수 있으므로 자기 자신일 때만 비움.
- I-S3 드래그 중 (drag 시작 ~ 끝) 은 hover 비활성 — `onDragStart` 에서 `setHoveredGuid(null)`, drag 도중의 mouseEnter 이벤트는 무시 (Konva 가 dragging 중에는 발생하지 않음).
- I-S4 stage 자체에서 마우스가 벗어나면 (`onMouseLeave` on Stage) 툴팁 숨김.
- I-S5 INSTANCE 의 master 자손 (`_renderChildren` 으로 expanded 된 vector/icon 등) 위에 hover 시, 그 자손의 guid 가 아니라 **outer instance** 의 guid 를 hovered 로 잡는다 — 사용자 관점에선 인스턴스 한 덩어리 (Figma 도 동일). 구현: `_isInstanceChild` 플래그를 가진 노드는 hover 무시 (`onMouseEnter` 의 cancelBubble 로 outer 까지 propagate 하지 않게 핸들러 자체를 등록하지 않음).

## 5. Render (v2 — Konva)

- I-R1 hover overlay 는 **Konva** 로 렌더 (`HoverOverlay.tsx`) — selection overlay 와 같은 Layer 에 배치. Figma 와 동일한 in-canvas 표시. (v1 의 DOM tooltip 은 deprecated.)
- I-R2 `hover === null` 또는 `selectedGuids.has(hover.guid)` 인 경우 컴포넌트가 `null` return — 빈 노드 안 만듦.
- I-R3 `listening = false` — overlay 가 마우스 이벤트를 가로채지 않게 (NodeShape 의 hover 핸들러가 계속 작동해야 함).
- I-R4 z-order: selection overlay 와 같은 Layer 안에서 render 순서 = selection 다음 (코드상 뒤). 같은 노드가 selected + hovered 인 경우 I-R2 로 hover 가 미표시되므로 충돌 없음.
- I-R5 색상: `#0a84ff` (selection 과 동일). 라벨 텍스트는 흰색.

## 6. 성능

- I-PE1 mouseEnter/Leave 만 사용 — mousemove 핸들러는 등록 안 함. shape 경계 통과 시에만 fire 하므로 35K 노드에서도 부담 없음.
- I-PE2 hoveredGuid 변경은 React state 로 한 번 — Canvas 가 리렌더되지만 NodeShape 는 useIsSelected 와 같은 패턴의 useSyncExternalStore 가 아닌 단순 prop 비교로 충분 (hover 가 바뀌어도 NodeShape 의 props 는 변하지 않음 — hovered 정보는 Canvas 가 자체 보유). NodeShape memo 는 깨지지 않음.

## 7. 비대상 (v1)

- 키보드만으로 hover 트리거 (focus 기반 툴팁) — 마우스 only.
- 모바일 / 터치 — 캔버스 자체가 터치 first 가 아님.
- 툴팁의 fade in/out transition — 즉시 표시/사라짐.
- 다중 라인 컨텐츠 (text content preview, color swatch 등) — 이름 + 타입 + 사이즈 만.
- 툴팁 안의 액션 버튼 (Go to / Rename) — 정보 표시만.
- 호버 vs 선택 오버레이의 시각 구분 — selection overlay 와 hover tooltip 은 서로 다른 surface 라 색이 같아도 됨.

## 8. Resolved questions

- **DOM overlay vs Konva.Label** — DOM. Konva.Label 은 Stage 안에 있어 panning 시 자동 따라가지만, 텍스트 렌더링 / 자동 width 측정이 Konva 한계 안에 갇힘. DOM overlay 는 변환 함수만 매 렌더 호출하면 동기화 충분.
- **bbox 계산 — node.transform 직접 vs Konva node.getClientRect()** — `getClientRect()` 사용. ancestor transform 누적이 Konva 안에서 이미 처리되므로 우리 계산보다 정확.
- **드래그 중 hover 표시 여부** — 비활성 (I-S3). 드래그 인디케이터가 이미 충분히 시각적 — 툴팁이 추가로 따라다니면 시야 방해.
