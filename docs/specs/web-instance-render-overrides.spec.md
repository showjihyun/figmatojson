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

- I-C1 `collectFillOverridesFromInstance(overrides)` 와 `collectTextOverridesFromInstance(overrides)` 는 모두 `Map<pathKey, value>` 형태를 반환. **`pathKey`** = `guids.map(g => '${sessionID}:${localID}').join('/')` — outer instance master root 부터 override 타겟까지의 full path. 예: `"11:524/11:506"`. v1 의 single-step 케이스도 자동 호환 — 길이 1이면 `"11:506"` 처럼 슬래시 없는 키가 되어 동일하게 매칭.
- I-C2 `fillPaints` (또는 `textData.characters`) 가 없는 entry 는 무시. `Array.isArray` (또는 `typeof === 'string'`) 체크 통과해야 함.
- I-C3 `guidPath.guids` 가 비어있거나 어느 항목이라도 `{sessionID, localID}` 정수 쌍이 아니면 entry 무시 (silently skip — corrupt override 가 전체 instance 렌더를 깨면 안 됨).
- I-C4 ~~`guidPath.guids.length > 1` 은 v1 에서 무시~~ **(deprecated v2)** — multi-step path 를 정상 처리.
- I-C5 같은 pathKey 에 여러 entry 가 같은 필드를 정의하면 마지막 등장한 것이 이긴다 (Map.set 마지막 호출 win).

### 3.2 Propagation

- I-P1 `toClientNode` 의 INSTANCE 분기가 `collectTextOverridesFromInstance` 와 `collectFillOverridesFromInstance` 둘 다 호출.
- I-P2 두 override map 모두 `toClientChildForRender` 의 인자로 전달. 시그니처에 추가로 **`pathFromOuter: string[]`** 인자 (outer instance master root 부터 현재 노드의 *부모* 까지의 guidStr chain — 진입 시 `[]`).
- I-P3 `toClientChildForRender` 진입 시 `currentPath = [...pathFromOuter, currentGuidStr]`, `currentKey = currentPath.join('/')`. 데이터 spread 직후 `fillOverrides.get(currentKey)` 매칭 시 `out.fillPaints` 교체. TEXT 의 경우 `textOverrides.get(currentKey)` 매칭 시 `out._renderTextOverride` 설정.
- I-P4 자식 재귀 시 `pathFromOuter = currentPath` 로 전달. master 의 모든 자손은 outer instance 기준 path 를 누적 보유.
- I-P5 **Nested INSTANCE 안의 자손에 대한 override 합치기**: 자식이 INSTANCE 이고 그 INSTANCE 가 자기 own `symbolData.symbolOverrides` 를 가지면, inner own override 의 path 키들을 *현재 path 로 prefix* 한 새 항목으로 outer overrides 에 merge 한 뒤 inner expansion 진행. 즉 inner 의 single-step `[innerTextGuid]` 는 `[...currentPath, innerTextGuid]` 와 동등한 키로 변환되어 inner 트리 안에서 매칭 가능. inner 가 자기 own override 를 *가지지 않아도* outer overrides 가 path 매칭으로 inner 자손까지 도달한다 (메타리치 Dropdown 케이스).

### 3.3 Master immutability

- I-M1 master 노드 자체 (`toClientNode` 가 visit 하는 SYMBOL/COMPONENT) 의 `fillPaints` 는 변경되지 않는다 — instance-별 override 는 `_renderChildren` 의 per-instance 복제본에만 적용.
- I-M2 같은 master 를 참조하는 다른 INSTANCE 는 자기 고유의 fillOverrides 를 들고 들어와 자기 `_renderChildren` 만 변형 — instance 간 cross-talk 없음.

## 4. Render-side behavior

`Canvas.tsx:244-265` 의 VECTOR 분기 (`Konva.Path`) 와 `Canvas.tsx:281-316` 의 일반 노드 분기 (`Konva.Rect` + 자식 재귀) 는 변경 없음 — 그냥 `node.fillPaints` 를 읽는다. 본 spec 의 작업은 전부 *데이터* 변환 단계 (clientNode.ts) 에서 끝난다.

## 5. Error cases

- 세션 미존재 / master 미존재 — 기존 INSTANCE 분기의 처리 그대로 (silently 빈 instance 로 fallback).
- override entry 의 `fillPaints` 가 null / 잘못된 타입 — I-C2/C3 로 silently skip.
- 같은 guidStr 에 충돌하는 텍스트+색 override 가 있을 때 — 두 map 모두 채워지고 둘 다 적용 (텍스트는 `_renderTextOverride`, 색은 `out.fillPaints` 교체) — 충돌 없음.

## 6. 비대상 (v1)

- **stroke / effects / opacity / blend mode override** — 같은 패턴으로 `collectStrokeOverridesFromInstance` 등 추가 필요. fillPaints 가 가장 흔한 케이스라 우선 처리. 다음 라운드에서 확장.
- **colorVar / variable alias 해석** — override 가 가진 `colorVar.value.alias.guid` 는 Figma 변수 참조. 우리 코드는 literal `color` 값만 읽고 변수 해석은 하지 않는다 (.fig 가 항상 literal 도 함께 저장하므로 시각적 손실 없음).
- ~~**다단 nested INSTANCE override** — guidPath.length > 1. v1 무시 (I-C4).~~ **(v2 부터 지원 — I-P5 참조)**
- **Variant swap** — `symbolOverrides[]` 안에 `symbolID` 가 들어있는 entry 는 그 INSTANCE 의 master 를 다른 master 로 교체하는 의미 (Figma 의 "swap component"). 메타리치 Dropdown 의 6번째 option 은 `state=selected` variant 로 swap 되고 그 variant 의 TEXT 가 "직접 선택" 으로 override 됨. 본 spec 의 path-keyed override 만으로는 이 케이스를 처리 못 함 — variant swap 은 별도 spec 으로 다룬다 (한 라운드 뒤). 현재 동작: master 의 원본 자손이 그대로 렌더되고 swap target 의 자손에 붙은 override 는 적용되지 않는다.
- **mutation tool (chat/HTTP)** — 색 override 를 새로 *쓰는* 도구는 별도 spec (`web-chat-leaf-tools.spec.md` 의 set_fill_color 도 master 만 변경, instance override 작성은 미구현).
- **rendering 측 동적 caching invalidation** — fillOverrides 적용은 toClientNode 빌드 타임에 한 번. 사용자가 색 override 를 mutation 으로 바꾸려면 documentJson 재빌드 필요 (현재 structural ops 가 그렇게 동작 — `web-undo-redo.spec.md §4.2`).

## 7. 라우팅 결합

라우팅 변경 없음 — `GET /api/doc/:id` 응답이 자동으로 새 _renderChildren 에 override 가 적용된 fillPaints 를 포함.

## 8. Resolved questions

- **fillOverrides 를 master 자손의 `fillPaints` 에 *교체* vs *마커* 로 표현?** — 교체 (Option A). `_renderChildren` 은 이미 per-instance 복사본이라 mutation 안전. render 코드 변경 0. 텍스트 override 는 마커 패턴 (`_renderTextOverride`) 인데 그건 `textData.characters` 가 깊게 nested 라 마커가 더 가벼웠고 — fillPaints 는 top-level 배열이라 직접 교체가 자연스럽다.
- **`fillPaints[1..]` 도 override 되는가?** — override entry 의 `fillPaints` 배열 전체로 교체. master 가 multi-paint 였어도 override 가 single paint 면 single 만 남는다 (Figma 의 동작). 호출자가 어레이 길이 보존이 필요하면 별도 정책.
- **deep clone 여부** — override fillPaints 를 그대로 참조 (`out.fillPaints = override`). 같은 master entry 가 여러 인스턴스에서 재사용되면 이론적으로 aliasing 이지만, render 코드는 read-only 라 실제 문제 없음. 회귀 발견 시 deep clone.
