# spec/web-render-fidelity-round12

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/core/domain/clientNode.ts` (`toClientNode`: vector path scale 계산) + `web/client/src/Canvas.tsx` (`<Path>` 렌더 포인트) |
| 테스트 | `web/core/domain/clientNode.vectorPathScale.test.ts` |
| 부모 | round 11 |
| 형제 | `docs/specs/vector-decode.spec.md` (path 좌표 source of truth), `docs/specs/web-render-fidelity-round11.spec.md` (path inset) |

## 1. 배경

Round 11 은 `size >= normalizedSize` 케이스 (stroke outset 으로 노드 box
가 path 보다 *큼*) 에만 inset 을 적용했다. 그러나 figma 의 `ELLIPSE` /
`STAR` / `REGULAR_POLYGON` 같은 *parametric primitive* 는 normalizedSize
를 path 좌표 단위 (= path 의 정확한 bbox) 로 carry 하면서 노드 `size`
는 *축소된 layout box* 로 따로 carry 한다.

| 노드 | size | normalizedSize | 차이/2 | 의미 |
|---|---|---|---|---|
| HPAI 1440:621 (위험지도 ELLIPSE) | 80×80 | **120×120** | (-20, -20) | path 가 노드보다 큼 — 스케일링 필요 |

round 11 의 단순 inset 으로 처리하면 `_pathOffset = (-20, -20)` 가 셋팅돼
path 시작점이 노드 box 밖 음수 좌표로 밀려난다. 결과: ellipse 가 노드
size 영역보다 큰 영역 (-20, -20)~(100, 100) 에 그려져 클립되거나 인접
노드와 겹친다. 정확한 fix 는 `(size / normalizedSize)` 비율로 path 를
*스케일* 하는 것.

## 2. 분기 룰 (round 11 ↔ round 12)

`(size − normalizedSize)` 의 부호로 두 분기:

- I-1 **`dx >= 0 && dy >= 0`**: round 11 그대로 — `_pathOffset = (dx/2, dy/2)`,
  `_pathScale` 미셋. stroke outset 휴리스틱.
- I-2 **`dx < 0 || dy < 0`**: round 12 분기 — `_pathScale = (size.x/ns.x,
  size.y/ns.y)`, `_pathOffset` 미셋. 한 차원이라도 path 가 노드보다
  크면 scale 모드로 진입 — 두 차원 모두 스케일링.
- I-3 **양 분기 동시 활성 안 함** — 두 변환을 합성하면 stroke 두께가
  비대칭 변형되거나 컴포지션이 어긋남. 단순 OR 로 분기.

## 3. `_pathScale` 도메인 산출물

- I-4 `toClientNode` 의 `VECTOR_TYPES` 분기에서, `data.size` 와
  `data.vectorData.normalizedSize` 가 둘 다 객체 + 두 차원 모두 number
  + 둘 중 하나라도 size 가 normalizedSize 보다 작은 경우:
  ```
  out._pathScale = {
    x: data.size.x / vd.normalizedSize.x,
    y: data.size.y / vd.normalizedSize.y,
  }
  ```
- I-5 `_pathScale` 가 셋팅되면 같은 노드의 `_pathOffset` 은 *셋팅 안
  한다* (round 11 분기 skip). I-3 의 단순 분기 보장.
- I-6 `normalizedSize.x === 0` 또는 `normalizedSize.y === 0` (zero-divide)
  케이스는 `_pathScale` 미셋. 잘못된 figma 데이터로 가정.

## 4. 캔버스 렌더 — `<Path>` 의 scaleX/scaleY

- I-7 `web/client/src/Canvas.tsx` 의 VECTOR_TYPES 분기에서 inner `<Path>`
  엘리먼트에 `scaleX={node._pathScale?.x ?? 1}` /
  `scaleY={node._pathScale?.y ?? 1}` 를 추가한다. `x`/`y` 는 round 11
  의 `_pathOffset` 그대로.
- I-8 `_pathScale` 가 미셋된 노드는 `<Path>` 의 scale 기본값 1 — round
  11 까지의 동작과 byte-level 동등. 회귀 0.

## 5. Stroke alignment 와의 상호작용

- I-9 Konva 의 `<Path>` 는 scale 적용 시 stroke 도 함께 스케일된다 —
  즉 strokeWidth 는 scale 후 *시각적으로* 그만큼 두꺼워지거나 얇아진다.
  본 라운드는 1440:621 같은 케이스에서 **strokeWidth 가 의도된 size 비율
  로 스케일** 되는 동작이 figma 의 실제 렌더와 일치한다고 *가정*. 실측
  결과 불일치 시 별도 라운드에서 `strokeScaleEnabled={false}` 로 보정.

## 6. Invariants — 한 줄 요약

| ID | 명제 | 검증 |
|---|---|---|
| I-1 | size ≥ normalizedSize → round 11 inset | unit |
| I-2 | size < normalizedSize → `_pathScale` 셋팅 | unit |
| I-3 | `_pathOffset` 와 `_pathScale` 동시 셋팅 안 함 | unit |
| I-4 | `_pathScale = (sx/nx, sy/ny)` | unit |
| I-6 | normalizedSize 의 차원이 0 이면 미셋 | unit |
| I-7 | Konva `<Path>` 가 `scaleX/Y` 를 그대로 받는다 | snapshot/unit |
| I-8 | `_pathScale` 미셋 → round 11 결과와 동등 | regression test |

## 7. Out of scope

- ❌ asymmetric size 변형 (예: size.x > ns.x 이지만 size.y < ns.y) 의
  세부 정확도. 현재는 OR 분기 — 한 차원이라도 작으면 양쪽 모두 scale.
  비대칭 fix 가 필요한 케이스가 발견되면 별도 라운드.
- ❌ stroke scale 보정 (`strokeScaleEnabled`). I-9 의 가정이 빗나가면
  새 라운드.
- ❌ vector node 의 transform 회전/뒤집기 (m00/m11 부호) 와 path scale
  의 상호작용. 기존 round 3 의 transform 분해 정책 그대로.
- ❌ INSTANCE 의 `_renderChildren` 안 vector 의 scale (별도 검증 필요).

## 8. 참조

- `docs/specs/web-render-fidelity-round11.spec.md` — path inset (size ≥ normalizedSize)
- `docs/specs/vector-decode.spec.md` — `vectorNetworkToPath` 출력 좌표계 (`normalizedSize` 기준)
