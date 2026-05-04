# spec/web-instance-autolayout-reflow

| 항목 | 값 |
|---|---|
| 상태 | Draft (round 24) — 마지막 spec 항목 (§3.10 derivedSymbolData transform baking) 추가 |
| 구현 | `web/core/domain/clientNode.ts` (`applyInstanceReflow` helper + `toClientChildForRender` derived* baking, INSTANCE 분기에서 호출), `src/instanceOverrides.ts` (`collectDerivedSizesFromInstance` round-22, `collectDerivedTransformsFromInstance` round-24) |
| 테스트 | `web/core/domain/clientNode.test.ts` (hand-built fixtures, round-22 T-deriv-1~5, round-24 T-deriv-6a~e / 7a~c / 8 / 9 / 10 / 11) |
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

### 3.7 MIN/start-aligned reflow with visibility filtering (round-19)

**Trigger:** master 가 `stackMode === 'HORIZONTAL'` 또는 `'VERTICAL'`, **`stackPrimaryAlignItems === undefined` 또는 `'MIN'`** (Figma 의 default = start), AND 일부 master children 이 outer override 로 visible:false 처리 (즉 visible 자식 수 < 전체 자식 수).

WEB lnb-400_4266 의 sidemenu (master 23:1635) 케이스: VERTICAL, primary undefined (=MIN), 9 master children 중 outer Dropdown 의 symbolOverrides 가 5개를 visible:false 로 hide → 4개만 visible. Figma 는 auto-layout 으로 visible 4개를 packed (y=4, 53, 102, 151). 우리는 master 좌표 (y=102, 298, 347, 396) 그대로 → 3개가 section 밖으로 overflow → INSTANCE auto-clip 에 잘림 → "DB 계약관리/DB 관리/DB 분배" 미표시.

- I-O6 visible 자식 수가 expanded 자식 수와 같으면 (= 모두 visible) 발동 안 함 — master 좌표가 이미 packed 상태.
- I-O7 발동 시 anchor: `startPrimary = expanded[0].transform.m02 (HORIZONTAL) 또는 .m12 (VERTICAL)` — master 의 첫 자식 위치 (visibility 무관). 디자이너의 hard-coded padding-style offset 보존.
- I-O8 visible 자식들을 master 순서대로 walk, 누적 위치 계산: `cursor = startPrimary; for each visible: assign cursor; cursor += childPrimary + spacing`.
- I-O9 invisible 자식의 transform 은 변경 안 함 (Canvas 에서 어차피 안 그려짐).
- I-O10 counter axis: counter alignment 가 `CENTER` 면 §3.4 룰 적용; 아니면 master 값 유지.
- I-O11 §3.1-3.5 (CENTER+CENTER reflow) 가 먼저 fire 했으면 본 룰 skip — CENTER reflow 가 이미 모든 visible 자식 위치를 새로 계산. §3.6 overlap-group 도 비슷; trigger 우선순위는 (CENTER+CENTER) > (overlap-group) > (MIN-pack).

본 룰은 §3.6 overlap-group reflow 의 일반화 케이스 — overlap 이 *완전 동일* primary 위치일 때만 fire 였던 것을, hidden-children 으로 인한 *gap* 도 수정. 두 룰은 다른 trigger 조건이지만 비슷한 packing logic 공유.

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
- T-deriv-1: `collectDerivedSizesFromInstance` picks up `entry.size` (existing v1 behavior).
- T-deriv-2: `collectDerivedSizesFromInstance` picks up `entry.derivedTextData.layoutSize` when no `entry.size`.
- T-deriv-3: `entry.size` wins over `entry.derivedTextData.layoutSize` when both present (size is more general).
- T-deriv-4: `toClientChildForRender` overrides `out.size` from `derivedSizesByPath` for matching descendant currentKey.
- T-deriv-5: integration via `toClientNode` — outer INSTANCE has `derivedSymbolData` with size delta for a child; expanded child renders at derived size, and CENTER reflow uses the new size for spacing.

### 3.7.5 CENTER reflow trigger narrowing (round-21)

Round-14 spec §3.2 I-T1 originally said "fire CENTER+CENTER reflow when sizes differ". Round-20 wired CENTER reflow into nested-INSTANCE expansion as well. Combined, this fired CENTER for ANY size mismatch — including the case where INSTANCE is *bigger* than master (e.g. WEB Dropdown rail's option-row INSTANCEs are 233 wide vs master 117 — designer intentionally extended). CENTER-recentering pushed text past the parent Dropdown's clip.

Trigger narrowed to **`instance.primary < master.primary` OR `instance.counter < master.counter`** (any axis shrunk). Grown instances keep master positions — they reflect the designer's intent to extend.

### 3.8 stackPrimarySizing AUTO/RESIZE_TO_FIT_* support (round-20)

Figma 의 `stackPrimarySizing: "RESIZE_TO_FIT*"` 는 INSTANCE 가 children content 에 맞게 primary axis 를 auto-grow 하는 모드. 디자이너가 size override 에 *hint* 또는 *minSize* 를 두지만, 실제 렌더 size 는 content 길이에 따라 결정.

- I-AG1 INSTANCE 의 root override (path = [masterID]) 가 `stackPrimarySizing` 을 `RESIZE_TO_FIT_WITH_IMPLICIT_SIZE` 또는 다른 `RESIZE_TO_FIT*` 로 설정하면 AUTO-grow 모드.
- I-AG2 v1 fallback: 정확한 text natural-width 측정 인프라가 없으므로, `instance.size.primary < master.size.primary` 일 때 master size 를 사용. 작은 hint (e.g. 44px) 가 master (101px) 보다 작은 케이스에서 leading clip 방지.
- I-AG3 `instance.size.primary >= master.size.primary` (이미 grown 상태) 는 본 룰 영향 없음 — content 가 master 보다 길어도 우리는 모름. round-21 spec 후보 (text measurement-based reflow).
- I-AG4 `out.size` 를 grown size 로 업데이트 (`Canvas` 의 INSTANCE auto-clip 도 grown bbox 사용).

소스 케이스: 메타리치 dashboard 의 Excel 다운로드 button INSTANCE 587:7495 size override 44 + RESIZE_TO_FIT → master 101 로 grow → leading clip 회피.

### 3.9 derivedSymbolData 사이즈 baking (round-22)

Figma 의 INSTANCE 노드는 `derivedSymbolData: Array<{guidPath, size?, transform?, derivedTextData?, fillGeometry?, ...}>` 필드를 통해 *모든 descendant 의 post-layout 결과 delta* 를 보낸다 — 즉 master 와 다를 때만 entry 를 두고, 그 entry 가 권위 있는 사이즈/위치/glyph 레이아웃이다.

Round-21 의 시도 (TEXT 만 derivedSize 적용) 는 *부분 적용* 이라 실패했다 — outer Dropdown 의 size override 가 children INSTANCE 도 같이 줄여야 (e.g. 233→103) 하는데 우리는 master child size (233) + 작은 derived TEXT size 만 적용 → 텍스트가 wide container 안에서 misaligned. 본 룰은 *모든* descendant 에 적용한다.

- I-DS1 outer INSTANCE 의 `derivedSymbolData` 를 walk, `entry.size` 가 있는 entry 는 path-key (slash-joined GUIDs) → `{x, y}` map 으로 수집. `derivedTextData.layoutSize` 도 같은 map 에 등록 (TEXT descendant 의 자연-폭).
- I-DS2 `toClientChildForRender` 에서 descendant emit 시점, `derivedSizesByPath.get(currentKey)` 가 있으면 `out.size` 로 *override*. master 의 size 가 wins 가 아니라 derived 가 wins (Figma 의 post-layout 값이 더 정확).
- I-DS3 nested INSTANCE 의 own size 도 동일 룰 — `nestedInstSize` 우선순위는 `nestedGrownSize (round-20) > derivedSize (round-22) > nestedOrigInstSize (data.size) > master`. AUTO-grow 와 derived 모두 가지면 AUTO-grow wins (round-20 이 더 명시적).
- I-DS4 nested INSTANCE 의 `derivedSymbolData` 도 inner-prefix-merge 후 outer 와 합쳐 사용 (round-21 의 plumbing 그대로 — outer 가 deeper descendant 의 derived 를 알면 inner override 보다 우선).
- I-DS5 적용 후 `applyInstanceReflow` (§3.1-3.7.5) 가 *변경된 자식 사이즈* 기반으로 재flow → INSTANCE 경계의 spacing/center 계산이 정확해진다. derivedSymbolData 가 위치 (transform) 를 포함하지 않는 일반 케이스 (sidemenu 35 entries 중 transform 0) 에서 우리의 reflow 룰이 위치를 채운다.
- ~~I-DS6 단일-entry INSTANCE 의 `transform` 이 있는 케이스 (e.g. icon u:sign-out-alt 7:208 의 derivedSymbolData[0].transform) 는 v1 미적용 — 본 라운드는 size 만 적용. transform 적용은 round-23 후보 (현재 케이스에서 visual 영향 미관찰).~~ **(round-24 §3.10 에서 해결 — `entry.transform` 도 모든 descendant 에 baking)**

소스 케이스: 메타리치 design-setting datepicker 12:749 의 중간 calendar 라벨 (수/목/금/토) 클립 — outer dropdown rail 의 derived sizes 가 children INSTANCE 를 수축시키면 텍스트가 narrower container 안에 정확히 배치되어 클립 면적이 사라짐.

### 3.10 derivedSymbolData transform baking (round-24)

§3.9 가 `entry.size` (와 `entry.derivedTextData.layoutSize`) 를 baking 한 다음 마지막으로 남은 항목 — `entry.transform` (Figma 가 stamp 한 *post-layout 6-field 2D-affine*) 도 권위 있는 데이터다. 메타리치 audit 코퍼스에서 1,570 INSTANCE 가 적어도 한 entry 에 transform 을 가진다 (대부분은 reflow 가 발동하지 않는 케이스 — 디자이너가 INSTANCE 를 master 사이즈 그대로 두고 Figma 가 placement 만 baking 한 경우). 본 라운드는 §3.9 의 size baking plumbing 을 그대로 transform 에 확장한다.

- I-DT1 `collectDerivedTransformsFromInstance(instData)` 는 outer INSTANCE 의 `derivedSymbolData` 를 walk, `entry.transform` 이 있는 entry 만 path-key → `Transform2D` map 으로 수집. `Transform2D` = `{m00, m01, m02, m10, m11, m12}` 6-field 모두 number 일 때만 통과; 하나라도 비정형이면 silent skip (§3.9 I-DS1 과 동일 정책).
- I-DT2 `toClientChildForRender` 에서 descendant emit 시점, `derivedTransformsByPath.get(currentKey)` 가 있으면 `out.transform` 을 *통째 교체* (m02/m12 만 patch 가 아니라 rotation/scale 포함 6-field 전체). 적용 위치는 §3.9 의 `out.size` 적용 직후 — 같은 currentKey 를 size + transform 둘 다 가지는 entry 도 두 적용이 독립적으로 일어난다.
- I-DT3 nested INSTANCE 의 `derivedSymbolData` 도 inner-prefix-merge 후 outer 와 합쳐 사용 (§3.9 I-DS4 의 plumbing 재사용 — 같은 path-key scheme). outer 가 deeper descendant 의 derivedTransform 을 알면 inner own data 보다 우선.
- I-DT4 **reflow 와의 충돌 — v1 punt**: `applyInstanceReflow` 는 INSTANCE 의 *직접 자식* 만 mutate (m02/m12). reflow 가 fire 한 케이스 (instance < master) 에서 직접 자식의 path 가 derivedTransform 에 등록되어 있어도 reflow 가 wins — Figma 의 derivedTransform 을 *덮어쓴다*. 깊은 descendant 는 reflow 가 건드리지 않으므로 derivedTransform 이 항상 final. v1 punt 의 정당화: (a) 1,570 INSTANCE 코퍼스의 대부분은 reflow trigger 를 만족하지 않음 (round-21 narrowing 이후 instance < master 에서만 fire), (b) reflow 가 fire 하는 shrunk 케이스는 derivedTransform 과 reflow 의 계산이 *원리적으로 일치* 해야 함 (Figma 의 post-layout = 우리 simulation 의 목표). 둘이 visible 하게 다르면 별도 라운드로 reflow 의 룰을 derivedTransform 에 align.
- I-DT5 master immutability — derivedTransform 적용은 `_renderChildren` 의 per-instance 복제본에만 (§3.3 I-M1 그대로). 같은 master 를 참조하는 다른 INSTANCE 가 자기 고유의 derivedTransform 으로 자기 자손만 변형.

소스 케이스: 메타리치 audit 코퍼스의 1,570 INSTANCE 중 reflow 비fire 케이스가 dominant — 디자이너가 button/icon INSTANCE 를 master 와 같은 사이즈로 두고 Figma 가 자식의 글자 폭/아이콘 위치를 post-layout 으로 stamp 한 경우. round-22 size 만으로는 자식이 master 위치에 머물러 클립 면적 발생; transform baking 이 들어가면 Figma 와 픽셀 일치.

테스트: `web/core/domain/clientNode.test.ts` 의 round-24 블록 (T-deriv-6a~e: collector, T-deriv-7a~c: walk apply, T-deriv-8: 깊은 descendant, T-deriv-9: nested prefix-merge, T-deriv-10: reflow 와의 conflict 케이스 v1 punt 검증, T-deriv-11: 직접 자식 + reflow 비fire = derivedTransform 살아남음).

## 6. 비대상

- **Primary alignment ≠ CENTER** (MIN, MAX, SPACE_BETWEEN, SPACE_EVENLY) — v1 미지원. Master 좌표 유지 + INSTANCE clip. 메타리치 케이스 모두 CENTER 라 불필요.
- **Counter alignment ≠ CENTER** (MIN, MAX, STRETCH) — v1 미지원. STRETCH 는 별도 spec 가치 (child size 변경).
- **Padding 처리** — v1 은 padding 무시. 메타리치 Button master 의 R=12, B=10 padding 이 CENTER 와 충돌 — padding 적용 시 정확한 Figma 동작이 더 복잡. status quo (무시) 가 visual 적으로 더 가까움.
- **Nested INSTANCE 안의 reflow** — `toClientChildForRender` 의 INSTANCE 분기에는 v1 추가 안 함 (inner INSTANCE 는 자기 master coords 그대로). 메타리치 케이스에는 outer INSTANCE 만 reflow 필요.
- **Auto-layout proportional sizing** (`stackPrimarySizing: AUTO` 등 child size auto-grow) — v1 미지원.
- **Master 가 stackMode === 'NONE' 인 경우의 proportional scale** — `pen-export.ts` 의 `scaleNode` 로직. 본 spec 은 stackMode 케이스만 다룸. NONE 케이스가 metarich 에 있는지는 별도 audit 으로 평가.
- **(round-24) reflow 가 fire 한 직접 자식의 derivedTransform 보존** — §3.10 I-DT4 의 v1 punt. reflow 의 CENTER/MIN-pack 시뮬레이션이 Figma 의 derivedTransform 을 덮어쓴다. shrunk INSTANCE 케이스에서만 발생하고, 두 계산이 원리적으로 일치해야 하므로 visual 영향이 미관찰될 가능성이 높지만, audit 에서 conflict 케이스가 발견되면 reflow 가 derivedTransform 의 m02/m12 를 *anchor* 로 삼도록 라운드를 분리.
- **(round-24) `entry.fillGeometry` / `entry.strokeGeometry` baking** — Figma 가 vector 의 post-tessellation 윤곽도 stamp 하지만 본 라운드는 transform/size 만. Vector descendants 는 master 의 `vectorData` 로 충분히 커버되므로 우선순위 낮음.

본 spec 은 web 측 단독 구현 — `pen-export.ts:reflowMasterChildren` 과 *동일 동작이 아님* (CLI 는 Pencil flow 에 위임). 두 구현이 *다른 각도에서* 같은 문제 (INSTANCE size override) 를 다루는 셈. 미래에 cluster A (Expansion 추출) 가 trigger 되면 둘을 통합하는 것이 자연스럽지만, 본 spec 은 그 추출 *없이도* 메타리치 audit 의 시각 결함을 해결한다.
