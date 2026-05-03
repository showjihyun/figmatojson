# spec/web-instance-autolayout-reflow

| 항목 | 값 |
|---|---|
| 상태 | Draft (round 14) |
| 구현 | `web/core/domain/clientNode.ts` (`applyInstanceReflow` helper, INSTANCE 분기에서 호출) |
| 테스트 | `web/core/domain/clientNode.test.ts` (hand-built fixtures) |
| 형제 | `web-instance-render-overrides.spec.md` (override pipeline), `web-canvas-instance-clip.spec.md` (round-12 INSTANCE clip — 본 spec 으로 alert text-clip 의 *진짜* 원인 해결) |

## 1. 목적

Round-12 의 INSTANCE auto-clip 이 `Defa미분배` 같은 명백한 leak 은 막았지만, INSTANCE 의 size 가 master 보다 작을 때 *figma 가 의도한* layout — auto-layout 재실행으로 child 들이 INSTANCE bbox 안에 자동 재배치 — 이 우리 web 측에서는 일어나지 않는다. 결과: alert dialog 의 "취소"/"삭제" 버튼, input-box 의 "확인" 버튼 안의 텍스트가 master 좌표에 머물러 INSTANCE 클립으로 잘림 (round-13 의 visual gate 에서 확인).

`pen-export.ts:reflowMasterChildren` (709-852줄) 은 이 케이스에서 `_showPos` flag + counter axis 위치 재계산만 하고 실제 primary axis flow 는 Pencil 에 위임한다. 우리 web 은 Pencil 이 없으므로 *우리가 직접* layout 시뮬레이션 해야 한다. 본 spec 은 메타리치 audit 의 두 케이스 (alert + input-box) 가 의존하는 좁은 부분집합 — `HORIZONTAL/VERTICAL` stack + `CENTER` primary + `CENTER` counter — 만 v1 에서 시뮬레이션 한다. 나머지는 status quo.

## 2. Trigger

`toClientNode` 의 INSTANCE 분기에서, master 가 expand 되어 `_renderChildren` 이 만들어진 직후, **다음 모든 조건이 참**일 때 reflow 발동:

- I-T1 INSTANCE 의 effective size (`finalSize = instData.size`) 가 master 의 size 와 다르다 (x 또는 y 중 하나 이상이 다름).
- I-T2 master 의 `stackMode === 'HORIZONTAL' || stackMode === 'VERTICAL'`. (NONE / GRID / undefined → 발동 안 함.)
- I-T3 master 의 `stackPrimaryAlignItems` 가 v1 지원 값 (`CENTER` 또는 undefined treated as default — Figma 의 기본값은 일반적으로 MIN). v1 에서는 **CENTER 만 처리**, 다른 값 (MIN/MAX/SPACE_BETWEEN/SPACE_EVENLY) 은 §3.6 overlap-group 만 처리, 다른 reflow 는 status quo.
- I-T4 master 의 `stackCounterAlignItems` 가 v1 지원 값 (`CENTER` 또는 undefined). 다른 값은 status quo.

조건 중 하나라도 실패 → `_renderChildren` 그대로 (master 좌표 유지, INSTANCE clip 으로 leak 방지). 시각 결함은 spec §6 의 비대상으로 명시.

### 3.6 Overlap-group reflow (round-15 Phase B)

**별개의 trigger** — alignment 와 무관. master 가 `stackMode === 'HORIZONTAL'` 또는 `'VERTICAL'` 이고, master.children 중 *visible 인* 자식들이 master 좌표 기준 같은 primary axis 위치에 *겹쳐 있을* 때 발동. Figma 의 패턴: 디자이너가 같은 flow 슬롯에 여러 variant 슬롯을 미리 stack 시켜두고, instance 시점에 `visible: true` 로 선택적 표시 → Figma 가 auto-flow 로 재분배.

- I-O1 visible 자식들 중 master 의 `transform.m02` (HORIZONTAL) 또는 `transform.m12` (VERTICAL) 이 다른 visible 자식과 동일하면 그 그룹은 "overlap group". (invisible 자식은 무시.)
- I-O2 overlap group 의 첫 자식은 master 좌표 그대로 유지. 그 다음 자식들은 master 의 stack 순서대로 *primary axis 위치를 누적 분배* — 첫 자식의 primary 위치 + (이전 visible 자식들의 primary 사이즈 + spacing) 합.
- I-O3 counter axis 위치는 master 값 그대로 (overlap reflow 가 counter 를 건드리지 않음).
- I-O4 overlap 이 없는 케이스 (모든 visible 자식의 primary 위치가 unique) → I-T1~T4 의 일반 reflow 로 폴백; 둘 다 적용 안 되면 master 좌표 유지.
- I-O5 overlap reflow 와 일반 CENTER reflow 가 동시에 적용되어야 할 때 → 일반 reflow 가 우선 (모든 visible 자식 위치를 새로 계산). overlap 은 그 안에서 자연 해소.

메타리치 Dropdown rail 케이스: master 11:532 (VERTICAL, primary 정렬 undefined = MIN) 에서 자식 15:292/15:296/15:300 모두 master 좌표 y=127 에 stack. Outer Dropdown INSTANCE 가 visible:true 로 15:292 + 15:296 표시. overlap-group reflow 가 첫 자식 (15:292) 은 y=127 유지, 두 번째 (15:296) 는 y=127+40+1(spacing)=168 로 이동. 결과: 5 rows visible (오늘/최근 1주일/최근 30일/금월/전월). "직접 선택" (15:300) 은 visible:false 그대로 (variant-swap 별 spec).

## 3. Layout simulation

### 3.1 입력

- `expanded`: `_renderChildren` (이미 override + visibility resolved, 단 transform 은 master 좌표 유지)
- `masterData`: master TreeNode 의 data (stackMode, alignments, padding 읽기 위함)
- `masterSize`: `{x, y}`
- `instSize`: `{x, y}` (INSTANCE 의 override 후 final size)

### 3.2 Effective visible children

I-S1 layout 계산은 *visible* children 에 대해서만. `child.visible === false` (visibility override 또는 prop-binding 으로 hidden) 인 child 는 layout 에서 제외 — 위치 재계산 안 함, master 좌표 유지 (어차피 Canvas 가 안 그림).

### 3.3 Primary axis (CENTER)

I-S2 HORIZONTAL → primary = x. VERTICAL → primary = y.
I-S3 visible children 의 primary 사이즈 합계 = `Σ child.size[primary] + (count-1) × stackSpacing`.
I-S4 시작 위치 = `(instSize[primary] - 합계) / 2`. (CENTER alignment, padding 무시 — v1 단순화. 메타리치 케이스의 padding 은 R/B 만 있어 CENTER 와 충돌 — status quo 가 더 나은 결과.)
I-S5 visible children 을 master 의 원래 *순서대로* 시작 위치부터 spacing 두고 배치.

### 3.4 Counter axis (CENTER)

I-S6 HORIZONTAL → counter = y. VERTICAL → counter = x.
I-S7 각 visible child 의 counter 위치 = `(instSize[counter] - child.size[counter]) / 2`.

### 3.5 Mutation

I-S8 visible children 의 `transform.m02` (x) 와 `transform.m12` (y) 를 위 계산값으로 *교체*. transform 의 다른 필드 (m00/m01/m10/m11 = 회전/스케일) 는 보존.
I-S9 transform 이 없는 child → 새 transform `{m00:1, m01:0, m02:newX, m10:0, m11:1, m12:newY}` 생성.
I-S10 child 자체는 새 객체로 생성 (master 트리 mutation 금지 — round-12 §3.3 I-M1).
I-S11 invisible children 은 변경 없음.

## 4. Error cases

- I-E1 master 또는 instance 의 size 가 undefined / 잘못된 형태 → reflow skip (return expanded as-is). 안전한 fallback.
- I-E2 visible children 이 0개 → return expanded as-is (no-op).
- I-E3 visible children 의 size 합계가 instance primary axis 보다 큼 → 시작 위치가 음수가 되어 좌측으로 leak. 그래도 적용 (CENTER 의 자연스러운 결과 — Figma 도 같은 동작). round-12 INSTANCE clip 이 visual 처리.

## 5. Tests

`web/core/domain/clientNode.test.ts` 에 새 describe 블록 `applyInstanceReflow`. Hand-built fixtures:

- T-1: HORIZONTAL master with 1 visible TEXT child (icon hidden via visibility override). INSTANCE size shrunk. Assert TEXT transform.m02 = expected center.
- T-2: HORIZONTAL master with 2 visible children. INSTANCE size unchanged. No reflow expected (transform unchanged).
- T-3: VERTICAL master with 1 visible child. INSTANCE size shrunk on y axis. Assert child transform.m12 = expected center.
- T-4: master with stackMode === 'NONE'. No reflow expected.
- T-5: master with stackPrimaryAlignItems === 'MIN'. No reflow (v1 doesn't support MIN).
- T-6: invisible children (visible:false) excluded from primary-sum calculation but their own transforms unchanged.
- T-7: INSTANCE size override only on counter axis (primary unchanged) → counter recompute, primary keeps master values.
- T-8: missing transform on a visible child → new transform generated with computed (x, y).
- T-9: integration via `toClientNode`: alert button INSTANCE fixture (master 88×32 HORIZONTAL CENTER, instance size 48×32, prop-binding hides icon, text override "삭제") — assert resolved TEXT transform centers in 48×32.

## 6. 비대상

- **Primary alignment ≠ CENTER** (MIN, MAX, SPACE_BETWEEN, SPACE_EVENLY) — v1 미지원. Master 좌표 유지 + INSTANCE clip. 메타리치 케이스 모두 CENTER 라 불필요.
- **Counter alignment ≠ CENTER** (MIN, MAX, STRETCH) — v1 미지원. STRETCH 는 별도 spec 가치 (child size 변경).
- **Padding 처리** — v1 은 padding 무시. 메타리치 Button master 의 R=12, B=10 padding 이 CENTER 와 충돌 — padding 적용 시 정확한 Figma 동작이 더 복잡. status quo (무시) 가 visual 적으로 더 가까움.
- **Nested INSTANCE 안의 reflow** — `toClientChildForRender` 의 INSTANCE 분기에는 v1 추가 안 함 (inner INSTANCE 는 자기 master coords 그대로). 메타리치 케이스에는 outer INSTANCE 만 reflow 필요.
- **Auto-layout proportional sizing** (`stackPrimarySizing: AUTO` 등 child size auto-grow) — v1 미지원.
- **Master 가 stackMode === 'NONE' 인 경우의 proportional scale** — `pen-export.ts` 의 `scaleNode` 로직. 본 spec 은 stackMode 케이스만 다룸. NONE 케이스가 metarich 에 있는지는 별도 audit 으로 평가.

## 7. CLI 와의 관계

본 spec 은 web 측 단독 구현 — `pen-export.ts:reflowMasterChildren` 과 *동일 동작이 아님* (CLI 는 Pencil flow 에 위임). 두 구현이 *다른 각도에서* 같은 문제 (INSTANCE size override) 를 다루는 셈. 미래에 cluster A (Expansion 추출) 가 trigger 되면 둘을 통합하는 것이 자연스럽지만, 본 spec 은 그 추출 *없이도* 메타리치 audit 의 시각 결함을 해결한다.
