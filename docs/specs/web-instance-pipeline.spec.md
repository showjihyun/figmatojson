# spec/web-instance-pipeline

| 항목 | 값 |
|---|---|
| 상태 | Approved (round 29) |
| 구현 | `web/core/domain/clientNode.ts` (`toClientNode`, `toClientChildForRender`, `applyInstanceReflow`) + `src/instanceOverrides.ts` (모든 path-keyed collectors + `mergeOverridesForNested`) + `src/masterIndex.ts` + `src/effectiveVisibility.ts` |
| 테스트 | `web/core/domain/clientNode.test.ts` |
| 형제 (per-feature) | `web-instance-render-overrides.spec.md`, `web-instance-autolayout-reflow.spec.md`, `web-instance-variant-swap.spec.md`, `web-canvas-instance-clip.spec.md` |
| 형제 (감사) | `audit-oracle.spec.md`, `audit-round11/GAPS.md` (라운드별 시각 검증) |

## 1. 목적

INSTANCE 의 *읽기* 변환 파이프라인 — kiwi `Tree Node` 의 `INSTANCE` →
`DocumentNode._renderChildren` (master 의 per-instance 복제본, override 와
auto-layout 결과 적용 완료) — 의 **cross-cutting 계약** 을 한 곳에 둔다.

배경: 라운드 12~28 동안 INSTANCE 파이프라인은 7가지 path-keyed override
종류 + variant swap + auto-layout reflow 의 조합으로 성장. 각 기능별 spec
이 자체적으로 "§3.1 I-C1 path-key 정의" 를 carry 하면서 contract 가 *3중
중복* 되었고, round-25 의 FRAME-skip 발견 (WHATS-NOVEL §4.2) 시 세 spec
모두 동시 수정해야 하는 drift cost 가 발생. 본 spec 은 그 cross-cutting
contract 를 단일 source 로 끌어올린다.

per-feature spec (override / reflow / swap / clip) 는 각자의 *whitelist
와 semantics* 를 source 로 유지. 본 spec 은 *공통 표기·순서·불변식* 만.

## 2. 단일 진입점

```
toClientNode(treeNode, blobs, symbolIndex) : DocumentNode
  └ if treeNode.type === 'INSTANCE' && children.length === 0:
       1. resolve master via symbolIndex
       2. collect 10 path-keyed maps + 1 defID-keyed map (§4)
       3. expand master subtree → _renderChildren
            (recursion via toClientChildForRender, threading the maps)
       4. applyInstanceReflow(_renderChildren, masterData, finalSize, ...)
```

- I-E1 본 파이프라인의 **유일한 진입점** = `toClientNode` 의 INSTANCE
  분기. 다른 호출자 (LoadSnapshot, FsSessionStore, messageJson) 는 항상
  이 함수를 통과한다 — INSTANCE 확장 로직이 두 곳 이상에 살면 즉시
  divergence 위험.
- I-E2 master 가 symbolIndex 에 없으면 (deleted master / cross-file ref) —
  `_renderChildren` 미생성, fallback 으로 빈 INSTANCE shell. silent
  degrade — 에러 던지지 않는다 (round-trip 검증의 95% 성공률 보장 전제와
  같은 정책).
- I-E3 INSTANCE 가 *이미* children 을 가지면 (test fixture / 수동 expand)
  본 분기 skip — `n.children.length === 0` guard.
- I-E4 master immutability: 모든 변환은 `_renderChildren` 의 *복제본* 에만.
  master `TreeNode` 자체는 mutation 금지. 같은 master 를 N 개 INSTANCE
  가 참조해도 cross-talk 없음 (`web-instance-render-overrides.spec.md
  §3.3 I-M1/M2` 가 source).

## 3. Path-key contract — round-25 FRAME-skip

**모든** path-keyed collector·propagation 에 공통. round-25 에서 확정 —
이 단일 contract 가 깨지면 7+ override 종류가 동시에 silent miss.

### 3.1 표기

- I-K1 `pathKey = guids.map(g => '${g.sessionID}:${g.localID}').join('/')`.
- I-K2 빈 path 의 키는 빈 문자열. master root 자체에 직접 적용되는
  override (예: stackSpacing root override) 는 master 의 `guidStr` 단일
  segment 키 사용.

### 3.2 어떤 ancestor 가 path 에 들어가는가 (Figma scheme)

- I-K3 **포함**: outer INSTANCE master root 부터 target 까지의 walk 에서,
  `type === 'INSTANCE'` 인 ancestor + target 자체.
- I-K4 **제외 (skip)**: `FRAME / GROUP / SECTION / COMPONENT_SET` 등 모든
  *non-INSTANCE container* ancestor. 이들은 path 에 contribute 하지 않는다.
- I-K5 SYMBOL/COMPONENT (master 그 자체) 도 path 에 contribute 안 함 —
  master root 는 "path 가 시작하는 좌표계" 일 뿐 path 의 segment 가 아니다.
- I-K6 예시 (메타리치 alret SYMBOL 64:376):
  - master 64:376 → buttons FRAME 60:348 → Button INSTANCE 60:341
    → `pathKey("60:341") = "60:341"` (FRAME 60:348 미포함).
  - master 64:376 → Button INSTANCE 60:340 → inner master 5:44 의
    TEXT 5:45 → `pathKey("60:340", "5:45") = "60:340/5:45"`
    (60:340 은 INSTANCE 라서 포함, inner master 5:44 는 SYMBOL 이라
    제외).

### 3.3 누가 키를 사용하나

- I-K7 *Collection 측*: Figma 의 wire format 이 이 scheme 으로 stamp 한
  `guidPath.guids` 를 그대로 키로 사용. collector 가 별도 normalize 안 함.
- I-K8 *Propagation 측*: `toClientChildForRender` 가 자식 재귀 시
  `pathFromOuter` chain 을 §3.2 와 동일하게 누적 — `n.type === 'INSTANCE'`
  이면 chain 에 push, 그 외에는 chain 그대로 forwarding. 진입 시 빈 배열.
- I-K9 같은 노드의 `currentKey = [...pathFromOuter, currentGuidStr].join('/')`
  로 collector map 에 lookup. wire 와 walker 가 동일 scheme 을 쓰므로 키
  매칭 보장.

## 4. Path-keyed collectors — 정식 목록

`src/instanceOverrides.ts` 가 모두 정의. 각 collector 의 *whitelist 와
semantics* 는 형제 spec 에 source — 본 spec 은 이름과 *application-order
표* 만.

| # | collector | 키 형태 | 적용 시점 | source spec |
|---|---|---|---|---|
| 1 | `collectTextOverridesFromInstance` | `Map<pathKey, characters>` | TEXT data spread 직후 | render-overrides §3.1~3.2 |
| 2 | `collectFillOverridesFromInstance` | `Map<pathKey, Paint[]>` | data spread 직후 | render-overrides §2~3 |
| 3 | `collectVisibilityOverridesFromInstance` | `Map<pathKey, boolean>` | data spread 직후 | render-overrides §3.2 (visOv) |
| 4 | `collectTextStyleOverridesFromInstance` | `Map<pathKey, TextStyleOverride>` | TEXT data spread 직후 (round-26) | render-overrides §3.5 |
| 5 | `collectVisualStyleOverridesFromInstance` | `Map<pathKey, VisualStyleOverride>` | data spread 직후 (round-27) | render-overrides §3.6 |
| 6 | `collectStackOverridesFromInstance` | `Map<pathKey, StackOverride>` | reflow 호출 직전 (master root) / data spread (descendant) | render-overrides §3.7 |
| 7 | `collectSwapTargetsAtPathFromInstance` | `Map<pathKey, masterGuid>` | inner-INSTANCE master lookup | variant-swap §3.1~3.2 |
| 8 | `collectPropAssignmentsAtPathFromInstance` | `Map<pathKey, Map<defID, boolean>>` | inner-INSTANCE expansion 진입 직전 | render-overrides §3.4 (I-P11) |
| 9 | `collectDerivedSizesFromInstance` | `Map<pathKey, {x,y}>` | data spread 직후 (round-22) | autolayout-reflow §3.9 |
| 10 | `collectDerivedTransformsFromInstance` | `Map<pathKey, Transform2D>` | data spread 직후 (round-24) | autolayout-reflow §3.10 |

추가로 path-keyed *아닌* defID-keyed collector 1종:

| # | collector | 키 형태 | source spec |
|---|---|---|---|
| 11 | `collectPropAssignmentsFromInstance` | `Map<defID, boolean>` | render-overrides §3.4 (I-C6) |

이 11번은 outer INSTANCE 자기 자신의 prop assignments — path 가 아니라
INSTANCE-scope 안에서 모든 자손이 같은 defID lookup 을 공유 (prop binding
mechanism, §6 참조).

## 5. Application order — 한 노드에 여러 override 가 매칭될 때

INSTANCE 자손의 한 노드에 위 collector 들이 여러 개 hit 할 수 있다. 적용
순서는 *데이터 변환 layer 단일* — 동일 `toClientChildForRender` 호출 안
에서 모두 처리되므로 *순서가 정해져 있어야 결정성 보장*.

### 5.1 노드 자체의 데이터 patch (data spread 직후)

`toClientChildForRender` 본문에서 `out = { ...spread, ...patches }` 패턴.
patches 의 적용 순서:

- I-A1 `out.fillPaints = fillOverrides.get(currentKey) ?? out.fillPaints`
  (collector #2)
- I-A2 visual style whitelist 를 spread (collector #5) — `strokePaints`,
  `opacity`, `cornerRadius`, 4 corner 별 필드.
- I-A3 TEXT 노드면 text style whitelist 를 spread (collector #4) — fontSize
  / fontName / lineHeight 등 14 필드.
- I-A4 TEXT 노드면 `out._renderTextOverride = textOverrides.get(currentKey)`
  (collector #1) — 글자 자체.
- I-A5 derived size 적용: `out.size = derivedSizes.get(currentKey) ?? out.size`
  (collector #9, round-22).
- I-A6 derived transform 적용: `out.transform = derivedTransforms.get(currentKey)
  ?? out.transform` (collector #10, round-24).
- I-A7 explicit visibility override: `visibilityOverrides.get(currentKey) ===
  false` 이면 `out.visible = false` (collector #3).
- I-A8 prop-binding visibility (collector #11 + #8 의 merge): explicit
  visibility 가 *적용되지 않은* 노드에 대해서만 `data.componentPropRefs`
  + `propAssignments` 평가 → `false` 면 `out.visible = false`. **explicit
  override 가 prop-binding 보다 우선** (`render-overrides §3.4 I-P8` 의
  source).
- I-A9 descendant FRAME 의 stack override (collector #6, round-28) 도 spread
  적용 — 단 descendant 에서는 시각 효과가 round-22+24 에 의해 redundant
  일 가능성 큼.

### 5.2 Inner INSTANCE 진입 직전 (master lookup 단계)

자식이 `INSTANCE` 이면 본 노드를 expand 하기 전에 다음을 *순서대로* 결정:

- I-A10 **swap target 결정** (collector #7): `swapTargetsByPath.get(currentKey)`
  매칭 시 그 GUID 가 master lookup 키. 매칭 없으면 `data.symbolData.symbolID`.
  swap 이 다른 모든 path-keyed override 보다 *먼저* 결정되어야 한다 — 이후
  collector 들이 swap target 의 GUID 를 path 의 segment 로 가정하기 때문.
- I-A11 **propAssignments 합성**: outer 의 defID-keyed map 위에 collector
  #8 의 entry (현재 currentKey 매칭) 를 *덮어쓰기 merge* (`render-overrides
  §3.4 I-P11`).
- I-A12 inner INSTANCE 의 own `symbolOverrides` collect → outer overrides
  와 *prefix merge* (§5.4 참조).

### 5.3 Reflow — 노드 patch 와 자식 재귀가 끝난 뒤

- I-A13 master 가 `applyInstanceReflow` 의 trigger 조건을 만족하면 (master
  `stackMode = HORIZONTAL/VERTICAL` + INSTANCE size ≠ master size 등 —
  `web-instance-autolayout-reflow.spec.md §2` 가 source) reflow 가 *expand
  된 _renderChildren 위에서* fire.
- I-A14 reflow 호출 시점에 `effectiveMasterData = master root path 에 매칭
  되는 stack override (collector #6) 를 master.data 위에 spread 한 임시
  객체` (`render-overrides §3.7 I-AL3`). reflow 가 spacing/padding 을
  override 값으로 계산.
- I-A15 reflow 의 좌표 변경은 자식들의 `transform.m02/m12` 를 *추가
  patch* — 이 patch 는 round-24 derivedTransform (I-A6) 보다 *나중* 에
  발생하지만, 사실상 derivedTransform 이 이미 stamp 한 케이스에서는 reflow
  결과가 같거나 redundant.

### 5.4 Nested INSTANCE prefix-merge

자식 INSTANCE 가 자신의 `symbolOverrides` 를 carry 할 때, inner 의 path-keyed
map 들의 키를 outer 의 currentPath 로 prefix 한 새 map 으로 inner expansion
진입 (`render-overrides §3.2 I-P5` 가 source).

- I-A16 prefix-merge 대상 = collector #1~10 의 path-keyed maps.
  defID-keyed (collector #11) 는 prefix 가 의미 없어 *덮어쓰기 merge* 만.
- I-A17 prefix-merge helper = `mergeOverridesForNested` (single source —
  collector 마다 쓰지 말 것).

## 6. Effective visibility — 3-mechanism 합산

`Pen Node` / `DocumentNode` 의 최종 visibility 는 다음 3 mechanism 의 **OR-of-hidden**
(어느 하나라도 hidden → hidden). `CONTEXT.md §Visibility model` 의 source
와 일치.

| mechanism | 적용 layer | source spec |
|---|---|---|
| Direct (`data.visible: false`) | data spread 단계 (자연 carry) | CONTEXT |
| Property-Toggle (componentPropRefs + propAssignments, collector #11/#8) | I-A8 | render-overrides §3.4 |
| Symbol Visibility Override (collector #3) | I-A7 | render-overrides §3.2 |

- I-V1 Direct false → hidden.
- I-V2 Property-Toggle: `componentPropNodeField === "VISIBLE"` 의 ref 가
  있고 매칭 defID 의 `boolValue === false` → hidden.
- I-V3 Symbol Override `visible: false` → hidden. **`visible: true` 는 Direct
  false 를 덮어 *visible* 로 만들 수 있다** — 메커니즘 중 유일하게 hidden→visible
  unhide 가 가능 (CONTEXT.md `Symbol Visibility Override` 항목과 일치).
- I-V4 hidden 결과: `out.visible = false`. Canvas 가 이 노드를 그리지 않고,
  auto-layout 의 reflow `visible-only` walk 에서도 제외 (round-19 MIN-pack /
  round-15 overlap-group).

## 7. Reflow 와 변형의 상호작용 — 누가 좌표를 결정하나

같은 자식 노드의 `transform.m02/m12` 와 `size.x/y` 에 영향을 주는 mechanism
이 4 종 — 적용 *우선순위* (뒤가 앞을 덮음):

1. master 의 raw 좌표 (data spread).
2. round-22 derived size (collector #9, I-A5).
3. round-24 derived transform (collector #10, I-A6).
4. `applyInstanceReflow` (I-A13) — 가장 마지막. derived* 가 부재한 자손에
   대해 fallback 좌표 계산.

- I-R1 derivedSymbolData 가 *모든* 자손을 cover 하면 reflow 는 시각적 no-op.
  메타리치의 1,570 INSTANCE 가 `entry.transform` 을 carry — 이 케이스에서
  reflow 는 거의 항상 redundant 결과 produce.
- I-R2 derivedSymbolData 가 *부분* cover 면 reflow 가 빈 자리를 채움 —
  alret modal 의 round-25 회귀 케이스가 예시 (round-25 이전엔 path-key
  mismatch 로 derived* 매칭 실패 → reflow 가 잘못된 결과 calc).
- I-R3 두 mechanism 의 결과 *값이 같지 않을* 수 있음 (Figma 가 디자이너
  편집 후 재계산하기 전 baking 이 stale 인 경우). 둘 중 우선은 reflow
  (I-A13 가 마지막) 이지만 round-22+24 가 정착된 이후로는 Figma 의 baking
  을 *권위* 로 취급 — 향후 reflow 비활성화 옵션 후보 (§9 비대상).

## 8. Render-side 책임

`web/client/src/Canvas.tsx` 와 `Inspector.tsx` 는 본 파이프라인이 만든
`DocumentNode` 트리를 *읽기만* 한다. 추가 변형 없음.

- I-D1 Canvas 는 `node._renderChildren` 이 있으면 그것을 자식으로 사용 —
  master tree 가 아니라 patched expansion. INSTANCE auto-clip
  (`web-canvas-instance-clip.spec.md`) 도 이 자식 위에 적용.
- I-D2 Canvas 는 `node._renderTextOverride` 를 우선 사용 (있을 때) —
  `textData.characters` 보다 앞.
- I-D3 Canvas 는 `node.visible === false` 노드를 렌더 skip + auto-layout
  flow 에서 제거 (Konva 의 listening:false + null return).
- I-D4 데이터 변환 책임은 본 파이프라인에 *전적* — Canvas 에서 추가
  override / merge / reflow 금지. UI 측 spec 변경은 데이터 layer 의 일을
  client 로 leak 시키지 않는다 (architecture invariant — `docs/SPEC-architecture.md`).

## 9. 비대상 (cross-cutting)

본 spec 은 통합 contract 만 — 다음은 형제 spec 의 *비대상* 절을 그대로
승계.

- **mutation 도구 (chat/HTTP) 가 INSTANCE override 를 *쓰는* 경로** — 본
  파이프라인은 *읽기* 전용. mutation 은 별도 spec
  (`web-chat-leaf-tools.spec.md`, `web-instance-override.spec.md`).
- **componentPropNodeField TEXT / INSTANCE_SWAP** — render-overrides §3.4
  의 비대상 그대로. 메타리치 corpus 분포 0 (round-26 pre-flight 측정).
- **effects / blendMode override** — round-27 미커버.
- **colorVar / variable alias 해석** — literal value 만.
- **derivedSymbolData 와 reflow 의 통합 비활성화 옵션** — round-22+24 가
  정착했으므로 *reflow 를 끄고 derived\* 만 신뢰* 옵션이 후보. 미시행.
- **multi-page audit 자동화** — `audit-oracle.spec.md` 의 비대상 그대로.
- **boolean operation 정확 합성** — `vector-decode.spec.md §6` 그대로.

## 10. Resolved questions

- **왜 단일 use-case 가 아니라 함수 합성?** `toClientNode` 는 `application/`
  layer 의 use-case 가 아니라 `domain/` 의 pure 변환 — IO/세션 없음. 진입점은
  `UploadFig` / `LoadSnapshot` / `messageJson reviver` 셋. 단일 함수 contract
  로 묶이는 게 SDD 원칙에 맞고, 본 spec 이 그 contract 를 정의.
- **path-key contract 를 본 spec 으로 끌어올린 뒤 형제 spec 에서 삭제하지
  않은 이유** — round-25 의 변경 이력이 형제 spec 의 §3.1 안에 도큐먼트
  되어 있음 (deprecated-v3 마킹). 이력 보존 vs DRY 절충 — 새 라운드가 추가
  될 때는 본 spec §3 만 업데이트, 형제 spec 의 §3.1 은 "see web-instance-pipeline
  §3" 로 점진적으로 교체.
- **collector #6 (stack) 의 master root vs descendant 처리 차이가 형제
  spec 에 명확한가?** render-overrides §3.7 I-AL3 (root) / I-AL4 (descendant)
  에 source. 본 spec §5.1 I-A9 + §5.3 I-A14 가 application order 만 표시.
- **prop-binding 이 path-keyed (#8) 와 defID-keyed (#11) 둘 다인 이유** —
  Figma 의 wire format 이 그렇다. outer INSTANCE 자체의 prop assignments 는
  INSTANCE-scope 전체에 broadcast (defID), descendant INSTANCE 의 swap-context
  prop assignments 는 그 path 안에서만 (path-keyed). 두 collector 는 separately
  collect 하고 application 시점에 merge (I-A11).
