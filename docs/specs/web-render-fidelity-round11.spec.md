# spec/web-render-fidelity-round11

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/core/domain/clientNode.ts` (`toClientNode`: vector path offset 계산) + `web/client/src/Canvas.tsx` (`<Path>` 렌더 포인트) |
| 테스트 | `web/core/domain/clientNode.vectorPathOffset.test.ts` |
| 부모 | round 10 |
| 형제 | `docs/specs/vector-decode.spec.md` (path 좌표 source of truth) |

## 1. 배경 (왜 이 라운드가 필요한가)

`vector.ts` 의 `vectorNetworkToPath(vn)` 출력은 vn 의 vertex 좌표를 그대로
직렬화한 SVG path. vertex 좌표는 vector 의 *path 좌표계* 즉
`vectorData.normalizedSize` 영역 안 (`0..normalizedSize.{x,y}`) 에 위치한다.

반면 노드의 `size` 는 **stroke outset 포함 bbox** 이므로 `size != normalizedSize`
가 흔하다 (특히 stroke 가 있는 아이콘):

| 노드 | size | normalizedSize | 차이/2 | strokeWeight/Align |
|---|---|---|---|---|
| 700:319 (Frame 2262 의 Icon) | 20×20 | 16×16 | (2, 2) | 2 / CENTER |
| 700:322 | 20×20 | 18×18 | (1, 1) | 2 / CENTER |
| 700:325 | 15.56×20 | 14×18 | (0.78, 1) | 2 / CENTER |

기존 클라이언트(라운드 1~10)는 path 를 `<Path data={node._path} />` 로
**좌상단 (0,0) 에서 시작** 하도록 그렸다. 결과: path 가 노드의 `size` 영역
좌상단 `normalizedSize` 만큼만 차지하고 우/하단 `(size − normalizedSize)`
영역이 빔 → 아이콘이 노드 영역 안에서 위쪽/왼쪽으로 치우쳐 보이고,
strokeAlign=CENTER 의 stroke outset 보정도 누락.

본 라운드는 그 시각적 어긋남을 한 가지 *작은 도메인-레벨 산출물*
(`_pathOffset`) 로 해결한다.

## 2. 적용 대상

- I-1 본 라운드의 invariant 는 `VECTOR_TYPES`
  (`VECTOR / STAR / LINE / ELLIPSE / REGULAR_POLYGON / BOOLEAN_OPERATION /
  ROUNDED_RECTANGLE`) 노드 중 `vectorData.normalizedSize` 가 정의된
  노드에만 적용. ROUNDED_RECTANGLE 등 normalizedSize 가 없는 케이스 (단순
  primitive) 는 *비대상* — 기존 동작 (`_path` 좌표 그대로) 유지.
- I-2 vectorNetworkBlob 디코드가 실패해 `_path` 가 없는 노드는 본 라운드와
  무관 (그릴 path 자체가 없음). path fallback 정책 자체는 round11 의 비대상
  (별도 라운드/스펙).

## 3. `_pathOffset` 도메인 산출물

- I-3 `toClientNode` 의 `VECTOR_TYPES` 분기에서, 노드 `data.size` 와
  `data.vectorData.normalizedSize` 가 둘 다 객체로 정의되고 두 차원
  (`x` / `y`) 모두 number 인 경우:
  ```
  out._pathOffset = {
    x: (data.size.x - vd.normalizedSize.x) / 2,
    y: (data.size.y - vd.normalizedSize.y) / 2,
  }
  ```
  `_path` 디코드 성공 여부와 *독립* — _path 가 없어도 _pathOffset 만 셋팅될
  수 있다 (그릴 path 가 없으면 Konva 가 아무것도 안 그리므로 무관).
- I-4 size 또는 normalizedSize 둘 중 하나라도 미정의이거나 비-number 차원이
  하나라도 있으면 `_pathOffset` 를 셋팅하지 않는다 (undefined 유지). 또한
  두 차원 모두 차이가 정확히 `0` 인 경우도 미셋 — 추가 필드를 줄여
  대다수 fill-only vector (예: 700:315) 의 노드 데이터를 round 10 과
  byte-level 동등하게 유지.
- I-5 `_pathOffset` 는 양수에만 셋팅. `dx < 0 || dy < 0` 케이스는 round 12
  의 `_pathScale` 분기로 위임 (parametric primitive — 1440:621 ELLIPSE 등).
  두 분기는 mutually exclusive — round 12 spec §I-2/3 참조.

## 4. 캔버스 렌더 — `<Path>` 의 x/y prop

- I-6 `web/client/src/Canvas.tsx` 의 VECTOR_TYPES 분기에서 inner `<Path>`
  엘리먼트에 `x={node._pathOffset?.x ?? 0}` / `y={node._pathOffset?.y ?? 0}`
  를 추가한다. outer `<Group>` 의 transform.m02 / m12 / rotation / opacity 등
  기존 props 는 그대로 유지.
- I-7 `_pathOffset` 가 undefined 인 노드는 `<Path>` 가 (0, 0) 에서 시작 —
  round 10 까지의 동작과 byte-level 동등. 회귀 0.

## 5. Stroke alignment 와의 상호작용

- I-8 strokeAlign 의 INSIDE / OUTSIDE 보정 (round 2 §2 `applyStrokeAlign`) 은
  background Rect 를 위한 별도 경로다. 본 라운드의 `_pathOffset` 는
  vector path 만 다루며 그 둘은 *직교* — 같이 적용되지 않는다.
- I-9 strokeAlign === 'CENTER' (Figma 기본) 의 outset 은 본 라운드에서 별도
  보정 안 함. `(size − normalizedSize) / 2` 가 이미 실측 데이터 상 stroke
  outset 을 흡수해 path bbox 의 시각 중심을 노드 size 의 시각 중심에
  맞춘다 (§1 표 참고). 만약 향후 더 정확한 align/outset 이 필요하면 별도
  라운드.

## 6. Invariants — 한 줄 요약

| ID | 명제 | 검증 |
|---|---|---|
| I-3 | `_pathOffset = (size − normalizedSize) / 2` (둘 다 정의된 vector 노드) | unit |
| I-4 | size 또는 normalizedSize 미정의 → `_pathOffset` 미셋 | unit |
| I-6 | Konva `<Path>` 가 `_pathOffset.x/y` 를 그대로 받는다 | unit (Canvas snapshot) |
| I-7 | `_pathOffset` 미정의 노드의 렌더 결과는 round 10 과 동등 | regression test |

## 7. Error cases

- E-1 `data.size` 가 객체가 아닌 다른 타입 (예: 누락된 raw 필드) →
  `_pathOffset` 미셋 (I-4).
- E-2 `vectorData.normalizedSize.{x,y}` 중 하나만 정의 → 정의된 차원만 계산,
  나머지는 0. 단순화: 둘 중 하나라도 누락이면 *둘 다 미셋* — invariant
  단순성 우선.
- E-3 NaN / Infinity 입력 → toClientNode 의 일반적인 raw spread 정책에
  따름 (특별 처리 안 함). 잘못된 figma 데이터로 더 깊은 디버깅 필요.

## 8. Out of scope

- ❌ stroke outline 의 정확한 outset 보정 (CENTER vs OUTSIDE/INSIDE 별
  서로 다른 inset). 단순 산술 평균만 적용.
- ❌ vector node 의 회전/뒤집기 (transform 의 m00/m11 부호) 와 path inset
  의 상호작용. 기존 round 3 의 transform 분해 정책을 그대로 따른다.
- ❌ INSTANCE 의 `_renderChildren` 안 vector 의 inset (별도 검증 필요 —
  master 의 size 가 instance size 와 다른 케이스).
- ❌ pen-export.ts / html-export.ts 등 비-Konva 출력 — 그쪽은 SVG viewBox /
  CSS layout 이 별개 책임.

## 9. 참조

- `docs/specs/vector-decode.spec.md` — vectorNetworkToPath 의 출력 좌표계
  (`normalizedSize` 기준) 정의
- `docs/specs/web-render-fidelity-round2.spec.md` §2 — strokeAlign 보정
  (background Rect 만 다룸)
- `docs/specs/web-render-fidelity-round3.spec.md` — transform 분해 (rotation
  vs translation-only fallback)
