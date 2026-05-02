# spec/web-canvas-hover-tooltip

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Canvas.tsx` 의 hover state + `web/client/src/components/canvas/HoverTooltip.tsx` |
| 테스트 | `web/client/src/components/canvas/HoverTooltip.test.tsx` |
| 형제 | `web-left-sidebar.spec.md` (선택 동기화 / auto-reveal 과 별개 시스템) |

## 1. 목적

캔버스 노드 위에 마우스를 올리면 그 노드의 식별 정보를 작은 툴팁으로 표시한다 — Figma 의 hover affordance 와 동일. 사용자가 클릭으로 선택하기 전에 노드의 이름과 사이즈를 미리 확인할 수 있다.

배경:
- 35K-node 메타리치 같은 큰 디자인에서, 캔버스만 봐서는 어떤 컴포넌트인지 식별하기 어렵다 (이름이 보이지 않음).
- 인스펙터는 *선택된* 노드만 보여준다 — hover-only 식별 surface 는 별개로 필요.

## 2. 표시 내용

```
┌──────────────────────────────┐
│ section 1                    │   ← node.name (truncate)
│ FRAME · 360 × 220            │   ← type + W × H (반올림된 정수)
└──────────────────────────────┘
```

- I-T1 1줄: `node.name` (빈 이름은 `<unnamed>`, italic muted).
- I-T2 2줄: `<type> · <round(size.x)> × <round(size.y)>`. type 은 그대로 (FRAME/INSTANCE/TEXT 등).
- I-T3 INSTANCE 의 경우 2줄 끝에 ` · → <master.name>` 추가 — master 식별 어시스트. master 가 symbolIndex 에 없으면 master 정보 생략.
- I-T4 사이즈가 없는 노드 (DOCUMENT/CANVAS 등) → 2줄 = `<type>` 만. dimensions 생략.
- I-T5 **Variant container** (Figma 의 variants 묶음): 2줄에 `· N variants` 세그먼트 추가. `N = countVariantChildren(node)` (`web/client/src/lib/variants.ts`). 0 이면 세그먼트 생략. Figma 가 hover 시 variant 수를 보여주는 동작과 일치.
- I-T5.1 **검출 규칙** (`countVariantChildren`):
  - (a) `node.type === 'COMPONENT_SET'` 이면 직속 자식 중 `type === 'COMPONENT'` 의 개수 (newer Figma).
  - (b) 그 외 — 직속 자식 중 `type === 'SYMBOL' || type === 'COMPONENT'` 이면서 `name` 이 `key=value` 패턴 (`/^[\w가-힣 ]+=/`) 으로 시작하는 노드의 개수. 2개 이상이면 그 개수, 1개 이하면 0 (legacy Figma — `메타리치 화면 UI Design.fig` 가 이 패턴).
  - (a) 가 우선, (b) 는 fallback. 둘 다 만족 안 하면 0.
- I-T5.2 type 표기 — 본 spec 의 2줄 type 라벨은 노드의 실제 type 을 그대로 (FRAME / SYMBOL / COMPONENT_SET 등). variant container 라고 해서 type 을 위조하지 않음 — variant 정보는 `· N variants` 세그먼트로만 표현.

## 3. Position

- I-P1 툴팁은 hovered 노드의 **screen-space bbox 의 좌상단 외부** 에 위치 — `(bboxLeft, bboxTop - tooltipHeight - 4px)`. 4px 갭으로 노드 자체와 겹치지 않게.
- I-P2 좌상단이 viewport 위로 잘려 나가면 (`bboxTop < tooltipHeight + 4`) bbox **하단** 으로 떨어진다 (`bboxLeft, bboxBottom + 4`). 우측이 잘리면 `right` 정렬로 보정.
- I-P3 노드 좌표는 parent-local. screen-space 변환은 stage 의 `offset / scale` 으로 — `(node.bbox + ancestor offsets) * scale + stage origin`. ancestor 누적은 parentIndex 체인을 따라간다 (이미 NodeShape 가 Konva Group 으로 중첩되어 있어, Konva node 의 `getAbsolutePosition()` / `getClientRect()` 로 한 줄에 가능).
- I-P4 stage 의 `pan/zoom` 변경 시 툴팁이 노드와 함께 움직여야 함 — 즉 hover state 에 fixed pixel 좌표를 박지 말고, 매 렌더에 변환 함수를 다시 호출.

## 4. State

- I-S1 `Canvas` 컴포넌트가 `hoveredGuid: string | null` state 를 보유.
- I-S2 NodeShape 의 Konva 이벤트:
  - `onMouseEnter(e)` → `setHoveredGuid(guidStr(node.guid))`. `e.cancelBubble = true` 로 부모 노드의 onMouseEnter 가 덮어쓰지 않게 — 가장 깊은 노드가 hover 의 주인공.
  - `onMouseLeave(e)` → `setHoveredGuid((cur) => cur === thisGuid ? null : cur)`. 다른 노드로 바로 진입한 경우 그 노드의 onMouseEnter 가 이미 갱신했을 수 있으므로 자기 자신일 때만 비움.
- I-S3 드래그 중 (drag 시작 ~ 끝) 은 hover 비활성 — `onDragStart` 에서 `setHoveredGuid(null)`, drag 도중의 mouseEnter 이벤트는 무시 (Konva 가 dragging 중에는 발생하지 않음).
- I-S4 stage 자체에서 마우스가 벗어나면 (`onMouseLeave` on Stage) 툴팁 숨김.
- I-S5 INSTANCE 의 master 자손 (`_renderChildren` 으로 expanded 된 vector/icon 등) 위에 hover 시, 그 자손의 guid 가 아니라 **outer instance** 의 guid 를 hovered 로 잡는다 — 사용자 관점에선 인스턴스 한 덩어리 (Figma 도 동일). 구현: `_isInstanceChild` 플래그를 가진 노드는 hover 무시 (`onMouseEnter` 의 cancelBubble 로 outer 까지 propagate 하지 않게 핸들러 자체를 등록하지 않음).

## 5. Render

- I-R1 툴팁은 **Konva 가 아닌 DOM** 으로 렌더 — Stage 옆에 absolute-positioned `<div>`. Konva.Text 보다 폰트 / 패딩 / shadow 컨트롤이 자연스러움.
- I-R2 `hoveredGuid` 가 null 이면 컴포넌트 자체가 `null` return — 빈 div 도 두지 않음.
- I-R3 `pointer-events: none` — 툴팁이 마우스 이벤트를 가로채지 않게.
- I-R4 z-index 는 selection overlay 보다 위 (selection 의 W×H 라벨이 정확히 같은 위치에 와도 hover 가 우선).
- I-R5 다크 톤 (`bg-popover text-popover-foreground` shadcn 토큰) + 1px border + 4px radius. shadow-md.

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
