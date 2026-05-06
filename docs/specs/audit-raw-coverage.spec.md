# spec/audit-raw-coverage

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/scripts/audit-raw-coverage.mjs` (raw field coverage), `web/scripts/audit-properties-coverage.mjs` (component / variable properties) |
| 출력 | `docs/audit-raw-coverage/<fixture>/coverage.json`, `properties.json` |
| 형제 | `audit-harness.spec.md` (Phase 1 baseline 스크립트 3개), `audit-oracle.spec.md` (plugin oracle 비교) |

## 1. 목적

기존 audit harness 3 스크립트 (`audit-roundtrip.mjs` byte 비교, `audit-roundtrip-canvas-diff.mjs` field-walk diff,
`audit-rest-as-plugin.mjs` plugin oracle) 는 *round-trip* 또는 *외부 oracle* 과의 비교를 본다. 그러나 **우리
parser/exporter 가 raw kiwi message 안의 어떤 wire-format 필드들을 *전혀 사용하지 않거나*, 어떤 필드의 값이
JSON 직렬화 단계에서 손실되는지** 는 측정하지 않는다.

본 spec 의 두 스크립트는 그 빈자리를 채운다:

1. **`audit-raw-coverage.mjs`** — 모든 노드의 모든 raw 필드를 enumerate 하고 JSON 직렬화 / 클라이언트
   `documentJson` 도달 여부를 검증. *어떤 wire-format 필드가 silent 하게 사라지는지* 가 출력.
2. **`audit-properties-coverage.mjs`** — `componentPropDefs` / `componentPropAssignments` / VARIABLE 의
   `variableDataValues` 정합성. *디자인 시스템 메타데이터의 broken / orphan 케이스* 가 출력.

두 스크립트 모두 *측정 도구* — 발견된 문제는 후속 라운드에서 fix 한다. 본 라운드는 baseline 만 produce.

## 1.1 Baseline (round 17.2 — 2026-05-06)

| Fixture | raw nodes | client nodes | presentBoth | lostUnexp | extraUnexp | serializationFailures |
|---|---|---|---|---|---|---|
| bvp | 3,155 | 4,968 | 1,406 | **0** | 52 | **0** |
| 메타리치 | 35,660 | 64,902 | 1,855 | **0** | 88 | **0** |

| Fixture | propDefs | propDefs orphan | propAssignments | propAssignments broken | VARIABLEs | broken chains |
|---|---|---|---|---|---|---|
| bvp | 308 | 275 | 21 | **0** | 138 | 50 (capped) |
| 메타리치 | 96 | 59 | 2,056 | **0** | 82 | 6 |

핵심 발견:
- **lost-unexpected = 0** — 모든 raw wire-format 필드가 toClientNode 단계에서 client doc 으로 carry
  됨. parser 가 silent 하게 drop 하는 raw 필드 0건.
- **JSON serialization failures = 0** — BigInt / function / cycle / undefined 케이스 0건.
  documentJson 직렬화는 100% 안전.
- **broken propAssignments = 0** — INSTANCE 의 모든 componentPropAssignment 가 master 의
  componentPropDef 로 매칭. 디자인 시스템 metadata 의 *struct level* 정합성 OK.
- **extra-unexpected** ~50–88 — INSTANCE 노드의 master-inherit 필드들 (publishID,
  isSymbolPublishable, variantPropSpecs[]…). 진짜 합성이 아니고 wire format 상 INSTANCE
  자체가 carry 하는데 우리 EXPECTED_LOSS_KEYS / SYNTH 분류가 그 패턴을 못 잡았을 가능성.
  후속 라운드에서 expected-list 확장 여부 결정.
- **propDefs orphan** 275 / 59 — 정의됐지만 어떤 INSTANCE 도 그 prop 을 assign 하지 않음.
  **figma 디자이너 의도** — UI 에서만 보이는 "available property" 인 경우 정상. parser bug 아님.
- **VARIABLE broken chains** bvp 50+ / 메타리치 6 — alias chain 이 dead-end 또는 cycle 로
  끝남. 별도 라운드에서 deep-resolve 정책 + audit fix 후 재측정.

## 2. 공통 환경 (audit-harness.spec.md §2 와 동일)

- I-E1 web backend 가 `:5274` 에 떠있어야 한다 (`cd web && npm run dev:server`). 두 스크립트 모두 fixture 를
  POST `/api/upload` 로 적재해 `sessionId` + `documentJson` 을 받는다.
- I-E2 출력 루트 = `docs/audit-raw-coverage/<basename(fixture, '.fig')>/`.
- I-E3 default fixtures = `['docs/bvp.fig', 'docs/메타리치 화면 UI Design.fig']`. CLI 인자로 절대 / repo-relative
  경로 N 개 override.
- I-E4 NaN 등치 룰 (audit-oracle.spec.md §I-A14 와 동일).
- I-E5 fixture 별 try/catch — 한 파일 실패해도 나머지 진행. 종료 코드는 main exception 만 1.
- I-E6 출력은 `git` 추적 제외 (`.gitignore` 의 `docs/audit-roundtrip/` 패턴 확장 — `docs/audit-raw-coverage/`
  추가). 결과는 *측정 산출물* 이지 production artifact 아님.

## 3. `audit-raw-coverage.mjs` — Wire-format coverage

### 3.1 흐름

- I-R1 fixture bytes 를 `POST /api/upload` 로 전송 → `{ sessionId, … }` 응답.
- I-R2 동일 sessionId 로 `GET /api/doc/:id` → `documentJson` (전체 tree). 별도로 server-side 의 raw
  `decodeFigCanvas(...).message` 와 비교하기 위해 fixture bytes 를 *클라이언트 측* `decodeFigCanvas` 로 직접
  디코드 (web backend 미사용, `dist/decoder.js` 통해).
- I-R3 `decodeFigCanvas` 결과의 `message.nodeChanges` (= raw kiwi nodes 배열) 를 진실 source 로,
  `documentJson` 의 클라이언트 view 를 비교 대상으로.

### 3.2 Field walk

- I-R4 `walkRawFields(node)` generator — 노드 객체의 모든 own enumerable key 를 path 와 함께 yield.
  중첩 객체 / 배열은 재귀. `Uint8Array` 는 `<bytes>` leaf 로 표시 (재귀 안 함).
- I-R5 path 정규화: `fieldKey(path)` = `path.replace(/\[\d+\]/g, '[]')` — `nodeChanges[42].size.x` 와
  `nodeChanges[1280].size.x` 는 같은 field key 로 집계.
- I-R6 노드 type 별 field 등장 횟수 누적. 결과: `byTypeAndField[<type>][<fieldKey>] = count`.

### 3.3 Coverage 분류

각 (type, field) pair 를 4 종 status 로 분류:

- I-R7 `present-in-both` — raw 와 documentJson 양쪽에 존재 (현재 정상 carry 되는 필드).
- I-R8 `lost-in-client` — raw 에 있고 documentJson 에 없음. *우리 toClientNode 가 drop 하는 필드*.
  알려진 drop 룰 (`derivedSymbolData`, `fillGeometry`, `strokeGeometry`, `vectorData`, `Uint8Array`,
  `guid`/`type`/`name`) 은 *expected loss* 로 라벨; 그 외는 *unexpected loss* 로 분류.
- I-R9 `extra-in-client` — documentJson 에 있고 raw 에 없음 (= toClientNode 가 합성하는 필드: `_path`,
  `_pathOffset`, `_pathScale`, `_renderChildren`, `_componentTexts`, `_isInstanceChild`, …). *expected
  synthesis* 라벨; 그 외는 *unexpected synthesis*.
- I-R10 `serialization-failure` — raw 값이 `JSON.stringify` 에서 throw 또는 `undefined` 반환. 케이스:
  순환 참조, `BigInt`, `function`, undefined-only 객체. 발견 즉시 sample 1개 + path + reason 기록.

### 3.4 출력 schema (`coverage.json`)

```ts
{
  fixture:       string;
  origBytes:     number;
  rawNodes:      number;        // message.nodeChanges.length
  clientNodes:   number;        // documentJson 의 traversal count (children + _renderChildren)
  expectedLossRules:   string[]; // I-R8 의 알려진 drop 룰 이름
  expectedSynthRules:  string[]; // I-R9 의 합성 prefix (_xxx)
  summary: {
    totalFields:               number; // distinct (type, field) pairs in raw
    presentBoth:               number;
    lostExpected:              number;
    lostUnexpected:            number;
    extraExpected:             number;
    extraUnexpected:           number;
    serializationFailures:     number;
  };
  byType: Record<string, {
    nodeCount: number;
    presentBoth:        Array<[fieldKey, count]>;     // sorted desc by count
    lostExpected:       Array<[fieldKey, count, rule]>;
    lostUnexpected:     Array<[fieldKey, count]>;
    extraExpected:      Array<[fieldKey, count]>;
    extraUnexpected:    Array<[fieldKey, count]>;
  }>;
  serializationFailures: Array<{ path, reason, sampleType }>;  // up to 50
}
```

- I-R11 `presentBoth` / `lostExpected` 등 list 는 count desc 정렬, top 30 만 carry. *전체 분포는 byType
  level 의 nodeCount 와 함께 추측 가능*.
- I-R12 `serializationFailures` 는 발견 순서 첫 50 — sampling 만, 분포 신호는 summary.

### 3.5 보고 (console)

- I-R13 stdout 에 fixture 별 한 줄 요약 + top-3 unexpected loss / unexpected synthesis 출력.
- I-R14 `coverage.json` 가 git 추적 제외 (I-E6) 라 console + 디스크 둘 다 emit. fix 작업 시 디스크 fseek.

## 4. `audit-properties-coverage.mjs` — Component & variable properties

### 4.1 대상 데이터

- I-P1 component property defs: 노드 — SYMBOL / COMPONENT_SET / `isStateGroup === true` 인 FRAME /
  `componentPropDefs.length > 0` 인 임의의 노드 — 의 `componentPropDefs[]` 배열.
  entry 형태 (실측 메타리치 5:9 "Button"): `{ id: { sessionID, localID }, name, type ('BOOL'|'INSTANCE_SWAP'|'TEXT'|'VARIANT'), initialValue, sortPosition, varValue?, … }`.
  **주의**: `id` 가 GUID 객체이며, audit 의 첫 안 (round 17.0) 이 가정한 `propRef.id` 형태가 아니다.
  Round 17.1 정정 — guidStr 추출 후 `def.id` 와 `assignment.defID` GUID 매칭.
- I-P2 component property assignments: 노드 (보통 INSTANCE) 의 `componentPropAssignments[]` 또는
  `componentPropertyAssignments[]` (schema 변종). entry 형태 (실측):
  `{ defID: { sessionID, localID }, value: {}, varValue?: { value, dataType, resolvedDataType } }`.
  매칭 룰: `assignment.defID === def.id` (GUID 동등).
- I-P3 variable data values: VARIABLE 노드의 `variableDataValues.entries[]`. entry 형태:
  `{ modeID, variableData: { value, dataType, resolvedDataType } }`.

### 4.2 Invariants 검증

- I-P4 **propAssignment.propRef.id** 는 ancestor (가장 가까운 component master) 의 `componentPropDefs[].propRef.id`
  중 하나여야 한다. 매칭 안 되면 `broken-assignment` 분류.
- I-P5 **componentPropDef** 가 정의됐지만 어떤 INSTANCE/SYMBOL 의 assignment 에서도 *한 번도* 사용되지
  않으면 `orphan-def` (사용자가 정의했지만 미사용 — 정상일 수 있으나 신호).
- I-P6 **VARIABLE.variableDataValues** 의 alias guid 가 다른 VARIABLE 을 가리킬 때 (round 15 의 deep chain),
  체인 끝까지 resolve 가능한지 확인 — cycle 또는 dead-end 발견 시 `broken-variable-chain`.
- I-P7 **VARIABLE_SET** 노드의 `localVariables[]` (또는 schema 변종) 가 가리키는 VARIABLE 들 중 tree 에서
  찾을 수 없는 것 → `dangling-variable-ref`.

### 4.3 출력 schema (`properties.json`)

```ts
{
  fixture: string;
  summary: {
    componentPropDefsTotal:     number;
    componentPropDefsOrphan:    number;
    propAssignmentsTotal:       number;
    propAssignmentsBroken:      number;
    variablesTotal:             number;
    variableChainsBroken:       number;
    danglingVariableRefs:       number;
  };
  brokenAssignments:    Array<{ instanceId, propRefId, ancestorId? }>;  // top 50
  orphanDefs:           Array<{ masterId, propRefId, type }>;            // top 50
  brokenVariableChains: Array<{ variableId, chainHeads, dataType }>;      // top 50
  danglingVariableRefs: Array<{ setId, refs }>;                          // top 50
}
```

### 4.4 보고

- I-P8 stdout 에 fixture 별 summary + top-3 broken assignment / orphan def. file 도 emit.

## 5. 비대상

- ❌ 발견된 누락 / broken 의 *fix*. 본 라운드는 측정 only — fix 는 후속 라운드 (round 18+).
- ❌ field-by-field equality (audit-roundtrip-canvas-diff.mjs 가 이미 다룸).
- ❌ wire-format schema validation against kiwi schema definitions. schema 자체 검증은 별도.
- ❌ effect / paint 본문 (gradient stops, image hash) 의 coverage. round 15 에서 다룸.

## 6. 운영

- I-O1 `web/package.json` scripts 추가 (선택): `"audit:raw": "node scripts/audit-raw-coverage.mjs"`,
  `"audit:props": "node scripts/audit-properties-coverage.mjs"`. 본 라운드 mvp 는 직접 `node ...mjs`.
- I-O2 baseline 실행 빈도: 매 round 머지 후 1회 — 새 라운드가 새 unexpected loss 를 만드는지 회귀 감지.
  결과 비교는 사람이 git stash / disk 로.

## 7. 참조

- `audit-harness.spec.md` — Phase 1 baseline (3 기존 스크립트), 본 라운드는 그 위에 +2.
- `audit-oracle.spec.md §5.4 VALUE_ALIASES` — schema rename 사례 (R12-D). 비슷한 패턴이 raw coverage 에서
  발견되면 본 spec § 갱신.
- `web/scripts/audit-roundtrip-canvas-diff.mjs` — `walkDiff` / `fieldKey` / `aggregateDiffs` 패턴 재사용.
