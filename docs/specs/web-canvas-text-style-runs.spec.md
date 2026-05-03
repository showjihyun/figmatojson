# spec/web-canvas-text-style-runs

| 항목 | 값 |
|---|---|
| 상태 | Draft (round 13) |
| 구현 | `web/core/domain/clientNode.ts` (TEXT 노드 데이터 통과), `web/client/src/Canvas.tsx` (TEXT 분기 multi-segment rendering) |
| 테스트 | `web/core/domain/clientNode.test.ts` (style runs propagation), Pass 3 visual gate (input-box-9_42 state-text 행) |
| 형제 | `web-canvas-text-frame-fidelity.spec.md` (round 13 group C) |

## 1. 목적

Figma 의 한 TEXT 노드는 자기 `characters` 의 *부분 범위* 마다 다른 스타일
(fill / fontWeight / fontFamily 등) 을 지정할 수 있다 — `styleOverrideTable`
+ `characterStyleIDs` 메커니즘. 메타리치 input-box-9_42 의 state-text
행이 정확히 이 케이스: 한 TEXT 안에 `설명문구` (gray) `, ` (gray)
`오류문구` (red) `, ` (gray) `성공문구` (green) 가 들어있고, 글자 인덱스
범위마다 다른 fill 이 적용됨. 우리 Canvas 는 노드 전체의 단일 `fillPaints`
만 보므로 모두 gray 로 그려짐 — 이게 round-11 audit Pass 2 의
universal-primitive 결함 #5.

## 2. Figma 데이터 형태

TEXT 노드의 `data.textData`:

```ts
{
  characters: "설명문구, 오류문구, 성공문구",
  styleOverrideTable: {
    [styleID]: { fillPaints, fontWeight, fontFamily, ...overrides },
    ...
  },
  characterStyleIDs: number[]  // characters 와 같은 길이; 각 글자가
                                // 어느 styleID 를 쓰는지 매핑
}
```

`characterStyleIDs[i] === 0` 이면 노드 자체의 베이스 스타일 사용. 그 외
값이면 `styleOverrideTable[id]` 의 partial override 가 베이스 위로 머지.

## 3. Invariants

### 3.1 데이터 통과 (clientNode)

- I-C1 `clientNode.ts` 의 `toClientNode` / `toClientChildForRender` 가 TEXT 노드의 `textData.styleOverrideTable` 와 `textData.characterStyleIDs` 를 그대로 통과시킨다 (현재 spread 로직이 둘 다 자동 통과시키고 있는지 확인 — `derivedTextData` 만 명시적으로 strip 됨, line 98 / 307. style runs 데이터는 `textData` 안에 nested 되어 있어 통과될 가능성 큼).
- I-C2 INSTANCE 의 text 오버라이드 (`_renderTextOverride`) 가 적용되면 master 의 styleRun 매핑은 *그대로 보존* — Figma 동작상 텍스트만 바뀌고 스타일 인덱스는 master 의 것을 따른다 (검증 필요. 동작이 다르면 별도 분기).

### 3.2 렌더링 (Canvas)

- I-R1 `characterStyleIDs` 가 모두 `0` 이거나 `styleOverrideTable` 이 비어있으면 → 기존 단일 KText 렌더 그대로. 회귀 없음.
- I-R2 `characterStyleIDs` 의 unique 값이 2 이상이면 → 텍스트를 *연속 같은 styleID 의 글자 묶음 (run)* 으로 split. 각 run 은 별도 KText 로 렌더, x 좌표는 이전 run 들의 누적 너비.
- I-R3 각 run 의 effective 스타일 = `nodeBaseStyle (fillPaints, fontSize, fontFamily, ...) ⊕ styleOverrideTable[styleID] (있는 필드만 덮어씀)`. fillPaints 가 override 에 있으면 그 색을 쓴다 (state-text 의 빨강/녹색).
- I-R4 run split 시 measurement: 같은 fontFamily/fontSize/letterSpacing 으로 KText 의 `getTextWidth` 사용. 다국어 (한/영 mix) 에서도 작동하는지 확인.
- I-R5 textAlign / lineHeight / wrap 정책은 노드 레벨 그대로 — split 은 fill/fontWeight 같은 inline 스타일 범위만, 레이아웃 prop 은 노드 전체에 한 번 적용.
- I-R6 multi-line 텍스트 (newline 포함) 에서 run 이 줄을 가로지르면: 줄바꿈 시점 마다 run 도 다시 시작. (Konva 가 자동 wrap 하지 않으므로 우리가 manually 줄 분할 해야 할 가능성. 메타리치 케이스는 single-line 이라 v1 에선 single-line 만 다루고 multi-line 은 비대상.)

## 4. Error cases

- `characterStyleIDs.length !== characters.length` (corrupt 데이터) — fallback 으로 단일 노드 렌더 (I-R1 와 동일).
- `styleOverrideTable[id]` 가 없는데 `characterStyleIDs` 가 그 id 를 참조 — 베이스 스타일로 fallback.
- `_renderTextOverride` 와 `characterStyleIDs` 가 충돌 (override 텍스트 길이가 다름) — 검증 필요. v1 에선 override 가 있으면 단일 KText 로 fallback (style runs 무시) — 데이터 손실보다 시각적 충격이 큼.

## 5. 비대상

- multi-line 텍스트 의 run split — 메타리치에 케이스 없으므로 v1 비대상. 케이스 발견시 별도 라운드.
- styleOverrideTable 의 `fontFamily` / `fontWeight` 같은 *폰트 자체* override — fillPaints 만 v1 에서 처리 (메타리치 state-text 가 fill 만 바꿈). 다른 필드는 베이스 따름.
- 텍스트 selection / cursor 가 multi-segment 에서 하나의 노드처럼 동작하도록 보장 — 본 spec 은 *시각* fidelity 만, interactive editing 는 별도.
- `_renderTextOverride` 가 적용되면서 character-range 도 함께 바뀌어야 하는 경우 — 본 spec v1 미지원 (fallback to single KText).
