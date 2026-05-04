# spec/web-instance-render-overrides

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/core/domain/clientNode.ts` 의 `collectFillOverridesFromInstance` + `toClientChildForRender` |
| 테스트 | `web/core/domain/clientNode.test.ts` |
| 형제 | `web-instance-override.spec.md` (mutation 쪽 — chat/HTTP 로 새 텍스트 override 를 *쓰는* 경로) |

## 1. 목적

Figma 가 만든 .fig 안의 INSTANCE 에는 종종 `symbolData.symbolOverrides[]` 가 들어있다 — 디자이너가 인스턴스별로 텍스트, 색, stroke 등을 변경해 둔 결과물. 본 spec 은 **읽기 경로** (kiwi → DocumentNode 변환) 가 이 override 를 master 의 expanded subtree (`_renderChildren`) 에 어떻게 캐스팅하는지를 정의한다.

배경 — `메타리치 화면 UI Design.fig` 의 Lucide 계열 아이콘 (`u:check-circle`, `u:check`, `u:sign-out-alt` 등 1,500+ master / 400+ instance) 은 모두 master vector 의 fill 색을 instance 단위로 override 해서 흰색/회색/파란색 다양한 버튼에 같은 모양 아이콘을 재사용한다. master 의 fill 만 읽으면 모든 인스턴스가 같은 색으로 보여 Figma 와 시각적 차이가 발생.

기존 spec `web-instance-override.spec.md §5` 는 "텍스트 외 다른 필드 override (글꼴/색상)" 을 *mutation* 쪽 비대상으로 명시. 본 spec 은 그 punt 를 *render* 쪽에서 제거 — 색 override 를 *쓰는* 도구는 여전히 비대상이지만, 이미 .fig 안에 들어있는 색 override 를 *읽어 화면에 반영* 하는 것은 필수 기능.

## 2. Override entry shape

`symbolOverrides[]` 의 각 entry 는 다음 형태:

```ts
{
  guidPath: { guids: [{ sessionID, localID }, ...] },
  textData?: { characters: string, lines: ... },
  fillPaints?: Array<Paint>,
  // 미래: strokes?, effects?, opacity?, ...
}
```

- `guidPath.guids` 는 master 안에서의 절대 경로 — outer instance 의 master root 직속 child 부터 target 까지의 chain. 본 spec **v2** 부터 **multi-step path 지원** (`메타리치 화면 UI Design.fig` 의 Dropdown 캘린더 케이스에서 single-step 만 처리하면 한 master 의 여러 인스턴스가 같은 마지막 guid 로 충돌해 오버라이드가 분실되는 문제를 발견 — v1 의 비대상 항목을 풀었다).
- 한 entry 가 여러 필드 (text + fill 등) 를 동시에 가지는 경우 가능 — 각 필드는 독립적으로 처리.

## 3. Invariants

### 3.1 Collection

- I-C1 `collectFillOverridesFromInstance(overrides)` 와 `collectTextOverridesFromInstance(overrides)` 는 모두 `Map<pathKey, value>` 형태를 반환. **`pathKey`** = `guids.map(g => '${sessionID}:${localID}').join('/')` — *Figma의 path-key scheme* 그대로 받아 그대로 키로 사용. **(v3, round-25)** Figma scheme의 의미: outer instance master root 부터 override 타겟까지 *INSTANCE-typed ancestor + 타겟 노드* 만 포함; **FRAME / GROUP / SECTION 등 non-INSTANCE 컨테이너 ancestor 는 path 에서 skip**. 예: master 64:376 (alret SYMBOL) → buttons FRAME 60:348 → 60:341 (Button INSTANCE) — 60:341 의 path-key 는 `"60:341"` (FRAME 60:348 미포함). master 64:376 → 60:340 (Button INSTANCE) → inner master 5:44 의 TEXT 5:45 — 5:45 의 path-key 는 `"60:340/5:45"`. ~~outer instance master root 부터 override 타겟까지의 full path~~ **(deprecated v3)** — round-22/24의 잠재 버그 (FRAME 안쪽 타겟 매칭 실패) 가 round-25 에서 해결.
- I-C2 `fillPaints` (또는 `textData.characters`) 가 없는 entry 는 무시. `Array.isArray` (또는 `typeof === 'string'`) 체크 통과해야 함.
- I-C3 `guidPath.guids` 가 비어있거나 어느 항목이라도 `{sessionID, localID}` 정수 쌍이 아니면 entry 무시 (silently skip — corrupt override 가 전체 instance 렌더를 깨면 안 됨).
- I-C4 ~~`guidPath.guids.length > 1` 은 v1 에서 무시~~ **(deprecated v2)** — multi-step path 를 정상 처리.
- I-C5 같은 pathKey 에 여러 entry 가 같은 필드를 정의하면 마지막 등장한 것이 이긴다 (Map.set 마지막 호출 win).

### 3.2 Propagation

- I-P1 `toClientNode` 의 INSTANCE 분기가 `collectTextOverridesFromInstance` 와 `collectFillOverridesFromInstance` 둘 다 호출.
- I-P2 두 override map 모두 `toClientChildForRender` 의 인자로 전달. 시그니처에 추가로 **`pathFromOuter: string[]`** 인자. **(v3, round-25)** `pathFromOuter` 의 의미: outer instance master root 부터 현재 노드의 *부모* 까지의 *INSTANCE-typed ancestor* chain (FRAME/GROUP/SECTION 컨테이너는 미포함). 자식 재귀 시 `pathFromOuter` 결정: `n.type === 'INSTANCE'` 이면 `[...pathFromOuter, n.guidStr]` (INSTANCE 가 ancestor chain 에 추가), 그 외에는 `pathFromOuter` 그대로 전달 (FRAME/GROUP/etc. 은 chain 에 추가 안 함). 진입 시 `[]`.
- I-P3 `toClientChildForRender` 진입 시 `currentPath = [...pathFromOuter, currentGuidStr]`, `currentKey = currentPath.join('/')`. 데이터 spread 직후 `fillOverrides.get(currentKey)` 매칭 시 `out.fillPaints` 교체. TEXT 의 경우 `textOverrides.get(currentKey)` 매칭 시 `out._renderTextOverride` 설정.
- I-P4 자식 재귀 시 `pathFromOuter = currentPath` 로 전달. master 의 모든 자손은 outer instance 기준 path 를 누적 보유.
- I-P5 **Nested INSTANCE 안의 자손에 대한 override 합치기**: 자식이 INSTANCE 이고 그 INSTANCE 가 자기 own `symbolData.symbolOverrides` 를 가지면, inner own override 의 path 키들을 *현재 path 로 prefix* 한 새 항목으로 outer overrides 에 merge 한 뒤 inner expansion 진행. 즉 inner 의 single-step `[innerTextGuid]` 는 `[...currentPath, innerTextGuid]` 와 동등한 키로 변환되어 inner 트리 안에서 매칭 가능. inner 가 자기 own override 를 *가지지 않아도* outer overrides 가 path 매칭으로 inner 자손까지 도달한다 (메타리치 Dropdown 케이스).

### 3.3 Master immutability

- I-M1 master 노드 자체 (`toClientNode` 가 visit 하는 SYMBOL/COMPONENT) 의 `fillPaints` 는 변경되지 않는다 — instance-별 override 는 `_renderChildren` 의 per-instance 복제본에만 적용.
- I-M2 같은 master 를 참조하는 다른 INSTANCE 는 자기 고유의 fillOverrides 를 들고 들어와 자기 `_renderChildren` 만 변형 — instance 간 cross-talk 없음.

### 3.4 Component-property visibility binding (v3, round-12)

배경 — `메타리치 화면 UI Design.fig` 의 alert / input-box / datepicker rail / dropdown 4 컴포넌트 모두 INSTANCE 안의 `u:arrow-right` 아이콘이 화면에 leak 한다 (figma는 hidden). 원인 조사 (round 11 audit) 결과 이 visibility는 `symbolOverrides[].visible` 가 아니라 **Component Properties 바인딩**으로 제어된다:

- 외곽 INSTANCE 에 `componentPropAssignments: [{ defID, value?: { boolValue }, varValue?: { value: { boolValue } } }]`
- 내부 master 자손 노드에 `componentPropRefs: [{ defID, componentPropNodeField: "VISIBLE" }]`
- 매칭되는 `defID` 의 `boolValue === false` → 자손 노드 `visible: false`

`pen-export.ts:920-1048` 가 이미 이 로직을 구현 (`buildPropAssignmentMap` + `isHiddenByPropAssignment`). 본 spec v3 는 동일 로직을 `web/core/domain/clientNode.ts` 로 포팅한다.

#### Collection

- I-C6 `collectPropAssignmentsFromInstance(instData)` 는 INSTANCE 의 `instData.componentPropAssignments[]` 를 읽어 `Map<defIdKey, boolean>` 반환. 키 형식은 `${sessionID}:${localID}`. 값은 `value.boolValue` 우선, 없으면 `varValue.value.boolValue` (variant default 경유 케이스). 둘 다 boolean 이 아니면 entry skip.
- I-C7 `componentPropAssignments` 가 array 가 아니거나 비어있으면 빈 Map 반환 (corrupt 데이터 silently skip).

#### Propagation

- I-P6 `toClientNode` 의 INSTANCE 분기 (line 69-92) 가 `collectPropAssignmentsFromInstance(data)` 도 호출. 결과 map 을 `toClientChildForRender` 에 새 인자 `propAssignments` 로 전달.
- I-P7 `toClientChildForRender` 시그니처에 `propAssignments: Map<string, boolean>` 추가. 자식 재귀에 그대로 forwarding.
- I-P8 데이터 spread 직후 (기존 `visOv` 적용 직전, line 311-319) `data.componentPropRefs` 검사: `componentPropNodeField === "VISIBLE"` 인 ref 가 있고 그 `defID` 가 `propAssignments` 에서 `false` 로 resolve 되면 `out.visible = false`. 명시 visibility override (`visOv`) 가 더 우선 — prop-binding 은 default 만 결정.
- I-P9 **Nested INSTANCE merge**: 내부 INSTANCE 가 자기 own `componentPropAssignments` 를 가지면, 그 assignments 는 그 INSTANCE 의 expansion 안에서만 유효 — outer 의 propAssignments 에 inner 의 entry 를 *덮어쓰기* 한 새 map 으로 inner expansion 진입. (text/fill override 와 달리 prop assignments 는 path-keyed 가 아니라 *defID-keyed* 이므로 prefix 가 필요 없다 — outer 와 inner 가 같은 defID 를 정의하면 inner 가 그 INSTANCE scope 안에서 우선.)
- I-P10 **Master immutability 유지**: prop-binding 적용은 `_renderChildren` 의 per-instance 복제본에만 일어남. master 트리 자체의 `componentPropRefs` 데이터는 변경되지 않는다 — 다른 INSTANCE 가 같은 master 를 다른 assignments 로 expand 할 수 있어야 함.
- I-P11 **(round 15) Outer symbolOverrides 의 componentPropAssignments**: outer INSTANCE 의 `symbolOverrides[]` 에는 entry 별로 `componentPropAssignments` 가 들어있을 수 있다 (메타리치 Dropdown 의 "금월"/"전월" 옵션 케이스). 이 assignments 는 **해당 entry 의 guidPath 가 가리키는 INSTANCE 자손** 에게만 유효 — outer 자체에 적용되지 않음. 처리: `collectPropAssignmentsAtPathFromInstance(symbolOverrides)` 가 `Map<pathKey, Map<defID, boolean>>` 를 반환. `toClientChildForRender` 가 `currentKey` 와 매칭되는 entry 를 찾으면 그 assignments 를 propAssignments map 에 *덮어쓰기 merge* 하여 그 자손 expansion 진입. 일반 inner-INSTANCE merge (I-P9) 와 같은 룰.

#### 비고

- prop-binding 의 `componentPropNodeField` 는 `VISIBLE` 외에 `TEXT`, `INSTANCE_SWAP` 도 존재 (Figma 의 4 종 boolean/text/instance-swap/variant property). 본 spec v3 는 `VISIBLE` 만 처리. 나머지는 별도 라운드.
- 외곽 INSTANCE 에 prop assignment 가 있는데 master 안에 매칭되는 `componentPropRefs` 가 없는 경우 → no-op (silently)
- prop ref 의 `defID` 가 outer assignments 에 없는 경우 → master 의 default visibility 가 유지 (`out.visible` 변경 없음). Figma 의 의미는 "property unbound = use master default".

## 4. Render-side behavior

`Canvas.tsx:244-265` 의 VECTOR 분기 (`Konva.Path`) 와 `Canvas.tsx:281-316` 의 일반 노드 분기 (`Konva.Rect` + 자식 재귀) 는 변경 없음 — 그냥 `node.fillPaints` 를 읽는다. 본 spec 의 작업은 전부 *데이터* 변환 단계 (clientNode.ts) 에서 끝난다.

## 5. Error cases

- 세션 미존재 / master 미존재 — 기존 INSTANCE 분기의 처리 그대로 (silently 빈 instance 로 fallback).
- override entry 의 `fillPaints` 가 null / 잘못된 타입 — I-C2/C3 로 silently skip.
- 같은 guidStr 에 충돌하는 텍스트+색 override 가 있을 때 — 두 map 모두 채워지고 둘 다 적용 (텍스트는 `_renderTextOverride`, 색은 `out.fillPaints` 교체) — 충돌 없음.

### 3.5 TEXT styling override (round-26)

배경 — round-4 가 추가한 텍스트 override 는 `textData.characters` (실제 글자) 만 다뤘다. 그런데 메타리치 audit corpus 의 INSTANCE symbolOverrides 분포를 측정하면 `fontSize` (1443), `fontName` (1436), `lineHeight` (1436), `letterSpacing` / `textTracking` (1423 each), `styleIdForText` (1418), `textAutoResize` (814), `fontVariations` 등 **TEXT 의 비-글자 스타일 필드들** 이 변형(variant)별 override 의 가장 큰 미처리 영역이다. round-26 은 이 필드들을 INSTANCE 확장 시 자손 TEXT 노드에 적용한다.

- I-S1 `collectTextStyleOverridesFromInstance(overrides) → Map<pathKey, TextStyleOverride>`. 각 entry 의 *whitelist 된 styling 필드* 만 추출 (전체 entry 가 아님 — text/fill 등은 별도 collector 처리). pathKey scheme 은 §3.1 I-C1 (round-25 v3) 그대로.
- I-S2 **whitelist** — 적용되는 TEXT 스타일 필드 목록:
  ```
  fontSize, fontName, fontVersion, lineHeight, letterSpacing, textTracking,
  styleIdForText, fontVariations, textAutoResize,
  fontVariantCommonLigatures, fontVariantContextualLigatures,
  textDecorationSkipInk, textAlignHorizontal, textAlignVertical
  ```
  목록 외 필드는 무시 (다른 collector 의 책임이거나 미지원 영역). whitelist 명시는 (a) 의도하지 않은 필드 overwrite 방지, (b) Canvas 가 실제로 읽는 필드와 align (`web/client/src/lib/textStyle.ts` + `textStyleRuns.ts` 가 위 필드들을 Konva.Text props 로 변환).
- I-S3 entry 가 위 필드를 *하나도* 가지지 않으면 (textData / fillPaints / size 등 만 있으면) map 에 추가하지 않음 (silent skip — 빈 record 가 남으면 무의미한 lookup).
- I-S4 `toClientChildForRender` 에서 **TEXT 노드만** 적용 (`n.type === 'TEXT'` guard). 다른 타입에 잘못 매칭되어도 적용 안 함 — Figma 의 ref 도 TEXT 노드를 가리킴.
- I-S5 적용은 **data spread 직후, fillPaints / visibility / derivedSize / derivedTransform 적용과 같은 layer**. 즉 master 의 fontSize 가 18 인데 override 가 14 로 patch 하면 `out.fontSize = 14`. 부분 override 보존 — override 가 fontName 만 가지면 fontSize 는 master 값 유지.
- I-S6 nested INSTANCE prefix-merge — round-25 path-key plumbing 그대로 재사용. inner INSTANCE 가 자체 textStyleOverride 를 가지면 inner key 들을 outer currentPath 로 prefix 한 새 map 으로 merge.
- I-S7 master immutability — 적용은 `_renderChildren` 의 per-instance 복제본에만. master TEXT 의 data 는 변경되지 않는다 — 같은 master 의 다른 INSTANCE 는 자기 고유 override 로 자기 자손만 변형.

소스 케이스: 메타리치의 1,443 INSTANCE 에서 `fontSize` 가 master 와 다르게 stamp 되어 있는 경우 (예: Dropdown 의 11:506 TEXT 는 master Regular-14 인데 11:529 INSTANCE 에서 Medium 으로 패치). round-25 까지는 master 의 Regular-14 가 그대로 렌더되어 시각적으로 figma 와 다름. round-26 부터는 instance 별 styled font 가 정확히 적용.

## 6. 비대상 (v1)

- **stroke / effects / opacity / blend mode override** — 같은 패턴으로 `collectStrokeOverridesFromInstance` 등 추가 필요. fillPaints 가 가장 흔한 케이스라 우선 처리. 다음 라운드에서 확장.
- ~~**TEXT 의 비-글자 스타일 필드 override** (`fontSize`, `fontName`, `lineHeight`, `letterSpacing` 등) — round-4 가 글자만 처리.~~ **(round-26 §3.5 부터 지원 — 14개 필드 whitelist)**
- **colorVar / variable alias 해석** — override 가 가진 `colorVar.value.alias.guid` 는 Figma 변수 참조. 우리 코드는 literal `color` 값만 읽고 변수 해석은 하지 않는다 (.fig 가 항상 literal 도 함께 저장하므로 시각적 손실 없음).
- ~~**다단 nested INSTANCE override** — guidPath.length > 1. v1 무시 (I-C4).~~ **(v2 부터 지원 — I-P5 참조)**
- ~~**Component property visibility binding** — `componentPropAssignments` ↔ `componentPropRefs[VISIBLE]`. v1/v2 무시.~~ **(v3 round-12 부터 지원 — §3.4 참조)**
- ~~**Variant swap** — `symbolOverrides[]` 안에 `symbolID` 가 들어있는 entry 는 그 INSTANCE 의 master 를 다른 master 로 교체하는 의미 (Figma 의 "swap component"). 메타리치 Dropdown 의 6번째 option 은 `state=selected` variant 로 swap 되고 그 variant 의 TEXT 가 "직접 선택" 으로 override 됨. 본 spec 의 path-keyed override 만으로는 이 케이스를 처리 못 함 — variant swap 은 별도 spec 으로 다룬다 (한 라운드 뒤).~~ **(round 16 부터 지원 — `web-instance-variant-swap.spec.md` 참조)**
- **Component property TEXT / INSTANCE_SWAP binding** — `componentPropNodeField` 가 `VISIBLE` 이외인 케이스. v3 미구현. 다음 라운드.
- **mutation tool (chat/HTTP)** — 색 override 를 새로 *쓰는* 도구는 별도 spec (`web-chat-leaf-tools.spec.md` 의 set_fill_color 도 master 만 변경, instance override 작성은 미구현).
- **rendering 측 동적 caching invalidation** — fillOverrides 적용은 toClientNode 빌드 타임에 한 번. 사용자가 색 override 를 mutation 으로 바꾸려면 documentJson 재빌드 필요 (현재 structural ops 가 그렇게 동작 — `web-undo-redo.spec.md §4.2`).

## 7. 라우팅 결합

라우팅 변경 없음 — `GET /api/doc/:id` 응답이 자동으로 새 _renderChildren 에 override 가 적용된 fillPaints 를 포함.

## 8. Resolved questions

- **fillOverrides 를 master 자손의 `fillPaints` 에 *교체* vs *마커* 로 표현?** — 교체 (Option A). `_renderChildren` 은 이미 per-instance 복사본이라 mutation 안전. render 코드 변경 0. 텍스트 override 는 마커 패턴 (`_renderTextOverride`) 인데 그건 `textData.characters` 가 깊게 nested 라 마커가 더 가벼웠고 — fillPaints 는 top-level 배열이라 직접 교체가 자연스럽다.
- **`fillPaints[1..]` 도 override 되는가?** — override entry 의 `fillPaints` 배열 전체로 교체. master 가 multi-paint 였어도 override 가 single paint 면 single 만 남는다 (Figma 의 동작). 호출자가 어레이 길이 보존이 필요하면 별도 정책.
- **deep clone 여부** — override fillPaints 를 그대로 참조 (`out.fillPaints = override`). 같은 master entry 가 여러 인스턴스에서 재사용되면 이론적으로 aliasing 이지만, render 코드는 read-only 라 실제 문제 없음. 회귀 발견 시 deep clone.
