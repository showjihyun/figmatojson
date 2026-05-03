# spec/web-instance-variant-swap

| 항목 | 값 |
|---|---|
| 상태 | Draft (round 16) |
| 구현 | `web/core/domain/clientNode.ts` (`collectSwapTargetsAtPathFromInstance` + INSTANCE expansion 분기) |
| 테스트 | `web/core/domain/clientNode.test.ts` (hand-built fixtures) |
| 형제 | `web-instance-render-overrides.spec.md` §6 비대상 항목 ("Variant swap"); 본 spec 으로 그 항목 retire. |

## 1. 목적

Figma 의 "swap component instance" 메커니즘. 외곽 INSTANCE 의 `symbolOverrides[]` entry 가 `overriddenSymbolID` 를 carry 하면 그 path 가 가리키는 INSTANCE descendant 의 master 를 다른 master 로 교체한다. 메타리치 Dropdown 의 6번째 옵션 ("직접 선택") 이 이 메커니즘을 사용 — 기본 옵션 master (11:514, "state=기본") 대신 selected-state master (15:287, "state=selected") 로 swap 되고, swap target 의 child TEXT (15:288) 가 "직접 선택" 으로 override 됨.

`pen-export.ts:convertNode` (1064-1080줄) 이 이미 `instData.overriddenSymbolID ?? sd.overriddenSymbolID` 를 통해 swap 을 처리 — 외곽 override 가 `applySymbolOverrides` 로 inner instance 의 data 에 patch 된 후. 우리 web 측은 `applySymbolOverrides` 를 사용하지 않고 path-keyed override Map 으로 처리하므로, swap target 도 path-keyed Map 으로 따로 collect 해야 한다.

## 2. Data shape

```ts
// 외곽 INSTANCE 의 symbolOverrides[] 안의 한 entry:
{
  guidPath: { guids: [{ sessionID, localID }, ...] },  // 어느 inner INSTANCE 를 target
  overriddenSymbolID: { sessionID, localID },          // 어느 master 로 swap 할지
  componentPropAssignments: [...],                     // (선택) swap 후 prop assignments
  // visible 필드는 보통 없음 — swap 자체가 표시 의도 (§3.3 참조)
}
```

메타리치 Dropdown 의 "직접 선택" 케이스:
- Outer Dropdown (15:279) 의 symbolOverride entry: `guidPath: [15:300]`, `overriddenSymbolID: 15:287`
- Master 11:514 (default option) → swap → master 15:287 (selected option)
- 같은 outer 의 text override: `guidPath: [15:300, 15:288]`, `textData.characters: "직접 선택"` (15:288 은 15:287 의 child)

## 3. Invariants

### 3.1 Collection

- I-C1 `collectSwapTargetsAtPathFromInstance(symbolOverrides) → Map<pathKey, swapTargetGuid>`. `pathKey` 는 outer 의 path-key 스킴 그대로 (slash-joined). `swapTargetGuid` 는 `${sessionID}:${localID}` 형식.
- I-C2 entry 의 `overriddenSymbolID` 가 `{sessionID, localID}` integer 쌍이 아니면 entry 무시 (silent skip).
- I-C3 같은 path 에 여러 swap entry → 마지막 이 win.

### 3.2 Propagation

- I-P1 `toClientNode` 의 INSTANCE 분기에서 `collectSwapTargetsAtPathFromInstance` 호출, 결과 map 을 `toClientChildForRender` 에 새 인자 `swapTargetsByPath: Map<string, string>` 으로 전달.
- I-P2 `toClientChildForRender` 가 INSTANCE 노드를 visit 할 때 (nested-INSTANCE 분기, 자식 expansion 진입 직전):
  1. `swapTargetsByPath.get(currentKey)` 매칭이 있으면 그 guid 를 master lookup 키로 사용 (default `sd.symbolID` 무시).
  2. 매칭 없으면 default `sd.symbolID` 사용 (기존 동작).
- I-P3 swap 적용 후 inner INSTANCE 의 자손 expansion 은 swap target master 의 children 트리에 대해 진행. text/fill/visibility/prop overrides 는 이미 outer 가 swap target 의 GUID 를 path 에 반영해 등록한 상태이므로 자동 매칭됨 (메타리치 케이스: text override `[15:300, 15:288]` 가 swap target 15:287 의 child 15:288 을 정확히 가리킴).
- I-P4 nested-INSTANCE 의 own `symbolOverrides` 에서 collect 된 inner-swap-targets 도 outer 와 같은 prefix 룰로 머지 (path-keyed Map 모두 같은 패턴).

### 3.3 Implicit visibility

- I-V1 swap 이 적용된 INSTANCE 는 **implicit visible:true** 로 취급 — 즉 INSTANCE 자체의 master 데이터가 `visible: false` 라도, swap 이 active 하면 visible 로 렌더. **단**, explicit `visibilityOverrides` (Symbol Visibility Override) 가 다른 값을 명시하면 그 값이 우선 (round-12 §3.4 I-P8 의 우선순위 일관). 메타리치 Dropdown 의 "직접 선택" 케이스: 15:300 master 데이터가 `visible: false`, outer 가 explicit `visible` override 를 두지 않음, swap 적용 → implicit visible:true → render.
- I-V2 swap 이 *없는* INSTANCE 는 본 spec 영향 없음 — 기존 visibility 룰 그대로.

### 3.4 Visual property inheritance from swap target (round 17)

Figma 의 swap semantic 은 "use this variant's appearance" — 단순히 children 만 교체하는 게 아니라 **swap target 의 시각 속성을 INSTANCE 자체에 적용**. 메타리치 "직접 선택" 케이스: 기본 master 11:514 는 fillPaints 없음, swap target 15:287 은 fillPaints `{r:0.097, g:0.441, b:0.957}` (BLUE) + cornerRadius 12 + 흰 텍스트. swap 후 INSTANCE 가 swap target 의 fillPaints 를 inherit 하지 않으면 흰 텍스트가 흰 컨테이너 위에 그려져 시각적으로 사라짐.

- I-V3 swap 이 적용되면 swap target 의 `data` 필드를 instance `data` 에 머지 (read 전, data spread 직전). 머지 룰: **instance own field wins** — 이미 instance.data 에 값이 있으면 유지; 없을 때만 swap target 값 채움.
- I-V4 머지에서 제외하는 필드: `guid`, `type`, `name` (identity), `children`, `symbolData` (instance-specific), `transform` (instance position), `parentIndex`, `phase` (tree-structure). 그 외는 inherit 후보.
- I-V5 visual fields (fillPaints, strokePaints, cornerRadius, rectangle*CornerRadius, opacity 등) 가 inherit 되어 시각적 outcome 이 swap target 의 것과 일치.

`pen-export.ts:1146-1158` 의 `merged` 객체 생성 로직과 동등한 효과 — 거기서는 `{ ...masterData, ...rootOverrideFields, ... }` 로 master 값이 base, override 가 상위. 본 spec 의 I-V3 는 같은 방향: swap target 이 base, instance own 이 상위.

### 3.4 Master immutability

- I-M1 swap target master 의 데이터 자체는 건드리지 않음 — round-12 spec §3.3 의 master immutability 와 동일 룰. swap 결과는 per-instance `_renderChildren` 복제본에만 적용.

## 4. Error cases

- I-E1 `swapTargetsByPath.get(currentKey)` 가 매칭하지만 `symbolIndex` 에 swap target 이 없음 (master 미존재, corrupt 데이터) → swap fallback to default `sd.symbolID`. 안전한 폴백.
- I-E2 swap target master 가 INSTANCE 의 default master 와 *완전히 다른 트리* (다른 child GUID 들) → outer text/fill 등의 path-keyed overrides 가 swap target 트리의 GUID 와 매칭되지 않으면 그 override 는 무효 (default 값 노출). 메타리치 케이스는 outer 가 swap target 의 GUID 를 정확히 알고 있어 매칭됨.
- I-E3 같은 path 에 swap + visibility override 가 모두 있으면 visibility override 가 우선 (I-V1 명시).

## 5. Tests

`web/core/domain/clientNode.test.ts` 의 새 describe 블록 `collectSwapTargetsAtPathFromInstance` + `toClientChildForRender — variant swap`:

- Unit tests (`collectSwapTargetsAtPathFromInstance`): empty/undefined/corrupt entries handled; multi-step path keys; last-wins on duplicate path.
- Integration: outer INSTANCE with one nested INSTANCE child, outer override has `overriddenSymbolID` pointing to a different SYMBOL with different child TEXT. Assert resolved `_renderChildren` use swap target's children.
- Implicit visibility: nested INSTANCE has `visible: false` in master data, swap entry doesn't explicitly set visible — assert resolved node has `visible !== false`.
- explicit visibility override wins: same as above but outer also has `visible: false` for the same path → swap still uses swap target master, but resolved node is `visible: false`.
- Metarich Dropdown rail "직접 선택" fixture: full path-keyed text override on swap target's child resolves to overridden text.

## 6. 비대상

- **Component property INSTANCE_SWAP** — `componentPropRefs` with `componentPropNodeField === 'INSTANCE_SWAP'`. v1 미지원. 메타리치 Dropdown rail 케이스는 직접 `overriddenSymbolID` 를 사용하므로 prop-binding 경유는 불필요.
- **Recursive variant swap** — swap target 자체가 INSTANCE 인 케이스. v1 은 swap target 이 SYMBOL/COMPONENT 라고 가정.
- **Swap target 의 visibility 가 false** — swap target master 자체의 `visible: false` 케이스. v1 은 swap target 이 visible: true 라고 가정 (메타리치 케이스 충족).
- **Swap target 의 master tree 가 변경된 후 다른 outer override 처리** — v1 은 swap target 의 children 에 outer 의 *나머지* overrides 적용. 만약 다른 path-keyed override 가 default master 의 children 을 target 으로 작성되어 있으면 그 override 는 (다른 GUID 트리이므로) 매칭 안 됨 — 무효. 메타리치는 outer override 가 swap target 의 GUID 를 알고 있어 자동 매칭.

## 7. Round 17 visual fix history (resolved)

Round 16 초안 commit 직후 데이터 layer 는 정상 작동했지만 audit 스크린샷에 6번째 행이 보이지 않았다. 원인 가설은 audit harness bbox 미스매치였으나, Konva tree dump 로 직접 확인하니 "직접 선택" TEXT 가 `fill: rgba(255,255,255,1)` (white) + 배경 Rect 부재로 흰 컨테이너 위 흰 텍스트 = 시각적으로 사라진 상태였다. Audit harness 와 무관한 bug.

진짜 원인: swap 이 적용되면 swap target master 의 fillPaints (blue background) 를 INSTANCE 에 inherit 해야 하는데, round-16 코드는 children 만 교체하고 visual 속성은 inherit 안 함. round 17 가 §3.4 I-V3~V5 로 visual 속성 inheritance 추가. fix 후 6번째 행이 figma 와 동일하게 BLUE 배경 + WHITE 텍스트로 정상 표시됨.
