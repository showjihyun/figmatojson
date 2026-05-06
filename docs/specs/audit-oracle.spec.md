# spec/audit-oracle

| 항목 | 값 |
|---|---|
| 상태 | Approved (round 31) |
| 구현 | `figma-plugin/{manifest.json, code.js, ui.html}` + `web/core/application/AuditCompare.ts` + `web/server/adapters/driving/http/auditRoute.ts` |
| 테스트 | (TODO) `web/core/application/AuditCompare.test.ts` — 본 spec 의 Invariants 단위 |
| 형제 | `web-upload-fig.spec.md` (sessionId 발급), `round-trip-invariants.spec.md` (parser 자체 검증) |
| Baseline | bvp.fig current page: 704 matched / 18,304 비교 / **99.47% 일치** (round 31, commit 690e856). 잔여 97 diffs 중 30개는 round-26/27 nested-instance override 후속 work signal, 나머지는 §7 known artifacts. |
| Baseline (REST, R12) | HPAI fixture (`dZQkxC9NZJ0z5WpYRtXCRq`): 17,283 matched / 18,301 figma nodes / **204 diffs** (round 32, R12-A/B/D). 5,695 → 204 (96.4% 감소). 잔여 204 중 `rotation` 87 + `cornerRadius` 86 은 §7.2 known noise; 진짜 parser signal 후보는 `transform/size` 5건 + `strokes/fills.length` 13건 = ~18건. |

## 1. 목적

`figma-reverse` 의 parser 가 `.fig` 바이너리를 디코드한 결과가 *Figma 자신이*
같은 파일을 열었을 때 보는 트리와 일치하는지를 검증하는 *외부 oracle*.
Round-trip 검증 (parser → repack → re-parse) 은 우리 코드가 자기 자신과
일치하는지만 확인할 뿐 — Figma 의 해석과 진짜로 같은지는 가려내지 못한다.
본 spec 은 그 갭을 막는 plugin-기반 비교 파이프라인을 정의한다.

플러그인 sandbox 가 `figma.currentPage` 를 정규화 JSON 으로 직렬화 → backend
로 ship → 같은 `sessionId` 의 우리 parser tree 와 node id 매칭 → 필드별 diff
집계. 결과의 `topFields` 가 *다음에 고칠 가장 큰 parser 버그* 를 가리킨다.

## 2. 컴포넌트 분리

| 컴포넌트 | 책임 | 파일 |
|---|---|---|
| **Plugin sandbox** | `figma.currentPage` 트리 직렬화 | `figma-plugin/code.js` |
| **Plugin UI** | `.fig` 업로드 + sessionId 보유 + sandbox 호출 + diff 표시 | `figma-plugin/ui.html` |
| **HTTP route** | `POST /api/audit/compare` — `{ sessionId, figmaTree }` → diff JSON | `web/server/adapters/driving/http/auditRoute.ts` |
| **Use case** | tree 인덱싱, 필드 비교, diff 집계 | `web/core/application/AuditCompare.ts` |

## 3. Plugin sandbox — `serializeNode` 출력 계약

플러그인이 backend 로 보내는 트리 노드의 형태. **이 필드 목록이 곧 비교
대상의 상한선**이다 — 새 필드를 추가하려면 plugin 과 use case 양쪽을
동시 수정해야 한다.

- I-S1 모든 노드 공통: `id` (string), `type` (string), `name` (string),
  `visible` (boolean).
- I-S2 size-가능 노드: `size: { x, y }` (Figma plugin 의 `width`/`height`).
  width/height field 가 둘 다 있을 때만 emit.
- I-S3 위치-가능 노드: `transform: { m02, m12 }` (Figma plugin 의 `x`/`y`,
  parent 기준 절대 좌표). `m02`/`m12` 는 우리 parser 의 transform 행렬
  명명과 일치 — 평행이동 성분만 비교.
- I-S4 *non-default 일 때만* emit: `rotation` (≠ 0), `opacity` (≠ 1),
  `cornerRadius` (≠ 0). plugin 측 wire 절약 + `FIELD_DEFAULTS` 와의 양방향
  생략 약속 (§5.4 참조).
- I-S5 *항상* emit (필드가 존재하면): `strokes`, `strokeWeight`. 빈 배열과
  필드 부재의 구분이 audit signal 에 의미가 있어 default omission 적용
  안 함.
- I-S6 paint 직렬화: `fills` / `strokes` 의 entry 는 `serializeFill` 통과.
  현재는 `SOLID` 만 본문 직렬화 (`{ type, color: {r,g,b}, opacity, visible }`).
  비-SOLID paint 는 `{ type }` 만 emit 하고 본문 비교 없음 — 본 spec v1
  에서는 *paint 길이만* 비교 대상 (§5.2 참조).
- I-S7 TEXT 노드만: `characters`, `fontSize`, `fontName: { family, style }`.
  비-TEXT 는 emit 안 함 (gate 가 §5.3 에서 강제).
- I-S8 auto-layout 가능 노드 (`layoutMode != null && != 'NONE'`):
  `stackMode` (= layoutMode), `stackSpacing` (= itemSpacing),
  `stackPaddingLeft/Right/Top/Bottom`, `stackPrimaryAlignItems`,
  `stackCounterAlignItems`. `layoutMode` 가 `NONE` 또는 부재면 emit 안 함.
- I-S9 컨테이너 노드: `children: SerializedNode[]` 재귀.
- I-S10 emit 제외 필드: prototyping (`reactions`), 런타임 전용 (`absoluteRenderBounds`),
  Figma plugin API 가 제공하지만 우리 parser 가 알 수 없는 항목 일체.
  필드 추가는 plugin sandbox + use case + 본 spec §3, §5 동시 변경 필요.

## 4. Plugin → backend 프로토콜

- I-P1 plugin UI 가 먼저 사용자 file picker 로부터 `.fig` 를 받아 backend
  의 `POST /api/upload` 로 업로드 → `sessionId` 획득 (web-upload-fig.spec.md
  계약).
- I-P2 plugin UI 가 sandbox 에 `{type: 'serialize-current-page'}`
  postMessage → sandbox 가 `figma.currentPage` 를 §3 직렬화 →
  `{type: 'serialize-result', tree}` 로 응답. 실패 시
  `{type: 'serialize-error', error: string}`.
- I-P3 plugin UI 가 backend 의 `POST /api/audit/compare` 에
  `{sessionId, figmaTree}` body 로 ship. 응답은 §6 의 `AuditCompareOutput`.
- I-P4 manifest `networkAccess.devAllowedDomains` 는 `http://localhost:5274`
  (dev backend port) 만 허용. `allowedDomains` 는 `["none"]` — production
  배포 안 함, audit 은 항상 local 개발 환경 전제.
- I-P5 sessionId life-cycle: backend restart 시 메모리 휘발 → plugin UI
  는 `404 session not found` 발생 시 *재업로드 후 재시도* 가 정답이고,
  서버 측 자동 복구 시도 안 함.

## 5. AuditCompare — 매칭과 비교 룰

### 5.1 인덱싱

- I-A1 양쪽 트리를 `id → node` Map 으로 인덱싱. id 미존재 노드는 skip.
- I-A2 `SKIP_TYPES = { VARIABLE, VARIABLE_SET }` — Figma 의 plugin/REST API
  는 변수를 트리 children 으로 노출하지 않지만 우리 parser 는 kiwi 트리에서
  walk 한다. 양쪽 모두에서 (그리고 그 subtree 전체) skip 해 `onlyInOurs`
  noise 제거.
- I-A3 매칭 단위는 `id` 1:1. plugin 트리에 있고 우리에 없으면
  `onlyInFigma++`, 반대는 `onlyInOurs++`. id 일치하면 §5.2~5.4 의 필드
  비교 진행.
- I-A3a (round 31) **Composite ID 매칭** — INSTANCE descendant 는 plugin
  쪽에서 `I<instance.guid>;<master.overrideKey>` 형태로 노출된다. 우리
  parser 는 같은 데이터를 `INSTANCE._renderChildren` 에 master 의 `overrideKey`
  와 함께 보관하므로, kiwi 인덱싱 시 INSTANCE 마다 `_renderChildren` 를
  walk 하며 `I<instanceId>;<sessionID>:<localID>` 키로 추가 등록한다.
  `overrideKey` 가 없는 합성 노드는 등록 안 함 (matched 못 됨, 하지만
  plain `id` 키로는 여전히 보임). 재귀는 child 의 `children` 과
  `_renderChildren` 둘 다 따라간다.
- I-A3b (round 31) **Group transform flattening** — Figma plugin 은 GROUP
  을 transform-transparent 로 취급해 자식의 `node.x/y` 를 *GROUP 의 부모*
  기준으로 emit. 우리 kiwi 는 transform 을 부모 기준 (group-relative)
  으로 저장. kiwi-side 인덱싱 시 GROUP-like 조상의 `transform.m02/m12`
  를 자손에게 누적해 effective coordinates 를 계산. plugin tree 는 이미
  flatten 돼 들어오므로 추가 처리 없음.
- I-A3c (round 31) **isGroupLike heuristic** — kiwi 가 Figma 의 `GROUP` 을
  type=`FRAME` + `resizeToFit=true` + 빈 `fillPaints` 로 저장한다. 매칭된
  노드 비교 직전에 우리 측 view 를 `{ ...n, type: 'GROUP', strokeWeight:
  undefined }` 로 정규화 — 그래야 §5.3 type 비교가 alias 와 함께 떨어지고
  kiwi 의 default `strokeWeight=1` 이 plugin-도 안 emit 하는 영역에서
  거짓양성을 만들지 않는다.

### 5.2 Comparable fields

`COMPARABLE_FIELDS` 가 단일 source of truth. 각 entry 는
`{ field, pickFigma, pickOurs, gate? }`.

- I-A4 같은 key 양쪽: `type`, `name`, `visible`, `size.x`, `size.y`,
  `transform.m02`, `transform.m12`, `opacity`, `cornerRadius`.
- I-A4a (round 31) `rotation` — plugin 은 degrees scalar 로 emit, kiwi 는
  transform matrix 안에 sin/cos 로 보관. `pickOurs` 가 `atan2(m01, m00)`
  로 derive 후 degrees 변환 (`* 180/π`). 부호 컨벤션은 plugin 의
  clockwise-from-baseline 과 직접 일치 (음수 부호 안 붙음).
  Identity matrix (m01≈0 && m00>0) 면 `undefined` 반환해 default 0
  치환에 맡긴다.
- I-A4b (round 31) `strokeWeight` — gate `figma.strokes.length > 0` 가
  true 일 때만 비교. plugin/REST 는 stroke-less 노드에서 strokeWeight
  를 omit 하지만, kiwi 는 default 1 을 carry. gate 없이 비교하면
  500+ 거짓양성.
- I-A4c (round 32, R12-A) **회전 노드 transform/size gate** — `transform.m02`,
  `transform.m12`, `size.x`, `size.y` 4 entry 는 양쪽 다 `rotation === 0`
  (또는 미정의 → default 0) 일 때만 비교. 회전된 노드에선 표현 의미가
  다르다:
    - kiwi `transform.m02`/`m12` = 회전 *전* anchor 의 parent-relative 좌표.
    - REST `absoluteBoundingBox.x`/`y` = 회전 *후* axis-aligned bbox 좌상단.
    - kiwi `size.x`/`y` = 회전 전 width/height. REST `absoluteBoundingBox.width`/
      `height` = 회전 후 axis-aligned bbox width/height.
  plugin trial 에선 `node.x`/`y`/`width`/`height` 가 전부 회전 전 값이라
  의미 일치 → 그쪽 baseline (bvp metarich 99.47%) 에는 영향 없음. 본 gate
  는 *오직* REST adapter 측 false-positive 만 정리. round 33+ 에서 양쪽을
  회전 후 axis-aligned bbox 로 정규화하면 gate 제거 가능.
  `isRotated(n)`:
    - figma 측: `typeof n.rotation === 'number' && n.rotation !== 0`.
    - ours 측: `transform.m01 !== 0 || (transform.m00 ?? 1) < 0`. m00<0
      혼자도 180° 회전을 의미해서 단순 m01 검사로 안 잡힘 — 700:160
      (m00=-1, m11=-1) 같은 케이스가 정확히 이 분기.
- I-A5 다른 key: `fills.length` (plugin `fills` ↔ kiwi `fillPaints`),
  `strokes.length` (plugin `strokes` ↔ kiwi `strokePaints`). v1 은 *길이만*
  비교 — paint 본문 (color, gradient stops, image) 은 §7 비대상.
- I-A6 TEXT 전용 (gate = `type === 'TEXT'`): `characters` (plugin
  `characters` ↔ kiwi `textData.characters`), `fontSize`, `fontName.family`,
  `fontName.style`.
- I-A7 auto-layout 전용 (gate = `stackMode != null && stackMode !== 'NONE'`,
  Figma 측 기준 — 우리 parser 는 latent value 를 항상 carry 하므로 plugin
  쪽이 켜져있을 때만 비교): `stackSpacing`, `stackPaddingLeft/Right/Top/Bottom`,
  `stackPrimaryAlignItems`, `stackCounterAlignItems`.
- I-A8 padding fallback: 우리 parser 의 `pickOurs` 는 per-side 값
  (`stackPaddingLeft`) 이 없을 때 legacy axis-paired 필드
  (`stackHorizontalPadding` / `stackVerticalPadding`) 로 fallback.
  Inspector.tsx 의 fallback 정책과 동일.

### 5.3 Type aliases

- I-A9 `TYPE_ALIASES` 로 양쪽을 정규화한 뒤 `type` 필드 비교:
  - `SYMBOL` (kiwi) → `COMPONENT` (Figma plugin/REST 명명)
  - `ROUNDED_RECTANGLE` (kiwi) → `RECTANGLE` (Figma — corner-radius 는
    별도 type 이 아니라 property)
  - `CANVAS` (kiwi) → `PAGE` (plugin 의 `figma.currentPage.type`)
  - 그 외 type 명은 그대로.
- I-A9a (round 31) `FRAME` (kiwi) → `GROUP` (plugin/REST) — type 직접
  alias 가 아니라 `isGroupLike` 검사 후 `type: 'GROUP'` 강제 (§5.1
  I-A3c). 단순 alias 로는 `FRAME` 일반 케이스를 깨뜨려서 분리.

### 5.4 Field defaults / value aliases

- I-A9b (round 32, R12-D) **`VALUE_ALIASES` — 같은 enum binary value 의
  schema 간 rename**. `stackPrimaryAlignItems` 의 `SPACE_EVENLY` (kiwi
  schema, value=3) 와 `SPACE_BETWEEN` (Figma 의 현재 명명, REST/plugin
  emit) 은 같은 binary value 를 schema 버전 간에 rename 한 것. 비교
  직전 양쪽 값을 alias map 으로 정규화 — `pickFigma` / `pickOurs` 자체
  는 그대로 두고 `fieldDiffers` 의 entry-level alias 통해 실행. 다른
  enum 도 같은 패턴이 발견되면 본 map 에 추가. 현재 등록:
    - `stackPrimaryAlignItems`: `SPACE_EVENLY` ↔ `SPACE_BETWEEN`
- I-A10 `FIELD_DEFAULTS` map 이 `figma=undefined ↔ ours=<default>` 등치
  관계를 강제. 현재 등록된 default:
  - `opacity: 1`, `rotation: 0`, `cornerRadius: 0`, `strokeWeight: 0`,
    `visible: true`, `fills.length: 0`, `strokes.length: 0`,
    `transform.m02: 0`, `transform.m12: 0`.
  - (round 31) `stackSpacing: 0`, `stackPaddingLeft/Right/Top/Bottom: 0`,
    `stackPrimaryAlignItems: 'MIN'`, `stackCounterAlignItems: 'MIN'`.
    Plugin 의 "always emit resolved value" 와 우리의 "kiwi-stored only"
    emission 차이를 메운다. 이 default 들은 §5.2 의 stack-gate 가 fire
    한 후에만 실제 비교에 영향.
- I-A11 default 적용 순서: 한쪽이 `undefined` 면 default 로 치환 → 그
  뒤에 §5.5 의 등치 룰 적용.

### 5.5 Equality and tolerance

- I-A12 `===` 등치면 동일.
- I-A13 둘 다 `null` 또는 `undefined` 면 동일 (default 치환 후에도 살아있는
  null pair).
- I-A14 두 값이 모두 number 이고 둘 다 `NaN` 이면 동일 — kiwi 가 unset
  stack* spacing 의 default 로 NaN bit-pattern 을 emit, plugin sandbox 도
  같은 값을 그대로 carry 한다.
- I-A15 두 값이 모두 number 이고 `Math.abs(orig - rt) < 0.5` 이면 동일.
  근거: plugin 은 native float, 우리 parser 는 일부 경로에서 Float32
  (`Math.fround`) round-trip → 0.5px 미만 차이는 화면에서 invisible.
- I-A15a (round 32, R12-B) **rotation modular tolerance**: `field === 'rotation'`
  일 때 일반 0.5 절대값 tolerance 대신 *360° wrap-around* tolerance 적용.
  `((a - b) mod 360 + 540) mod 360 - 180` 으로 [-180, 180] 정규화 후
  `Math.abs(diff) < 0.5` 면 동일. 180 ↔ -180, 270 ↔ -90 등 같은 회전을
  표현하는 다른 부호 쌍이 differ 로 잡히는 것 + ±90° 근방 atan2
  derivation 의 부호 변동 (`audit-oracle.spec.md §7.2`) 을 흡수. HPAI
  baseline 에서 잔여 193 rotation diffs 의 대부분이 이 modular wrap
  으로 정리될 것으로 예상.
- I-A16 그 외에는 differ.

## 6. AuditCompare — 출력 계약

```ts
interface AuditCompareOutput {
  summary: {
    figmaNodeCount:  number;  // §5.1 인덱싱 후 Figma 측 entry 수
    ourNodeCount:    number;  // 우리 측 entry 수
    matchedNodes:    number;  // 양쪽에 모두 있는 id 수
    onlyInFigma:     number;
    onlyInOurs:      number;
    totalDiffs:      number;  // 매칭 노드의 differ 필드 합산
  };
  topFields: Array<{ field: string; count: number }>; // count desc
  sample:    DiffEntry[]; // 최대 200 entries: { id, field, origValue, rtValue }
}
```

- I-O1 `topFields` 는 `field` 별 differ count 의 desc 정렬. tie-break 는
  insertion order (Map iteration).
- I-O2 `sample` 은 *발견된 순서대로* 최대 200개 — round 33+ 의 truncation
  정책은 본 spec 의 future work.
- I-O3 응답 본문은 JSON; 에러는 use case 가 던지는 `NotFoundError` →
  HTTP 404 (`session ${sessionId} not found`). 그 외 unhandled exception
  은 `errors.toHttpError` 가 500 으로 매핑.

## 7. 비대상 + 알려진 noise (round 31)

### 7.1 비대상 (코드 외부 영역)

- ❌ paint 본문 비교 (color rgba, gradient stops, image hash). v1 은 길이만
  (§I-A5). round 32+ 작업으로 `serializeFill` 확장 + `pickOurs` 정렬.
- ❌ effect 비교 (`effects[]` — DROP_SHADOW / INNER_SHADOW / LAYER_BLUR).
- ❌ vector geometry (`vectorNetwork`, `commandsBlob`). vector-decode 는
  별도 spec 참조.
- ❌ prototyping / interaction / reactions.
- ❌ variants 의 `componentPropDefs` / `componentPropAssignments` 비교 —
  Figma plugin API 의 노출 형태와 우리 kiwi field 가 1:1 정렬 안 됨.
- ❌ multi-page audit. v1 은 항상 `figma.currentPage` 1페이지만. 사용자가
  Figma Desktop 에서 페이지 전환 후 다시 Run audit 하는 패턴.
- ❌ production 배포. manifest 의 `networkAccess.allowedDomains: ["none"]`
  이 강제 — 본 plugin 은 dev-only audit oracle.

### 7.2 알려진 noise (실제 parser 버그 아님 — audit signal 평가 시 빼야 함)

- ✅ **Schema enum rename**: `stackPrimaryAlignItems` 의 `SPACE_EVENLY`
  (kiwi value=3) ↔ Figma 현재 명명 `SPACE_BETWEEN`. round 32 (R12-D) 의
  `VALUE_ALIASES` 로 처리. 잔여 0.
- 🟢 **Plugin Mixed font omission**: TEXT 노드의 `fontName` 이 mixed
  fonts (한 텍스트 안에 여러 폰트) 인 경우 plugin sandbox 가 omit. 우리
  parser 는 master 노드의 단일 fontName 을 emit → 거짓양성. 향후 plugin
  side gate `fontName !== figma.mixed` 로 개선 가능하지만 audit signal
  영향 미미.
- ✅ **Rotation matrix edge**: `±90°` rotation 등 matrix m00 이 거의 0
  근방에서 atan2 derivation 이 약간 어긋남. round 32 (R12-B) 의
  modular wrap tolerance (§I-A15a) 로 흡수. 잔여 ~0.
- 🟢 **VECTOR icon `cornerRadius`** (REST 한정): REST 가 path geometry
  에서 곡률을 추정해 cornerRadius 를 emit. Plugin 은 안 함. 우리 parser
  는 VECTOR 의 cornerRadius 를 따로 보관 안 함. REST 에서만 보임.
- ✅ **GROUP↔FRAME 명명**: §5.1 I-A3c / I-A9a 로 처리됨. 잔여 0.
- ✅ **회전 노드 transform/size 표현 차이** (round 32 R12-A, REST 한정):
  §I-A4c gate 로 회전 노드의 transform.m02/m12/size.x/y 비교 skip.
  HPAI baseline 에서 ~5K signal 정리. plugin trial 영향 없음.

## 8. Resolved questions

- **plugin 이 자체적으로 .fig 를 업로드할 필요가 있나?** 있음. plugin
  sandbox 에는 file system 접근이 없어서 backend 가 어떤 파일을 들여다보고
  있는지 plugin 이 직접 알 수 없다. 사용자가 수동으로 plugin UI 에 같은
  파일을 한 번 더 picker 로 제공 → `sessionId` 획득 → sandbox 트리와 매칭.
- **왜 `figma.currentPage` 만?** plugin sandbox 의 `figma.root.children`
  walk 는 모든 페이지의 SceneNode 를 lazy-load 시키는데, 페이지가 많으면
  Figma Desktop 이 sluggish 해진다. 한 번에 한 페이지만 보는 게 *audit
  oracle 로서의 비용 모델* 에 맞다. 모든 페이지 audit 이 필요하면 사용자가
  페이지 전환 후 다시 실행.
- **NaN === NaN 등치를 spec 에 박아도 되나?** 됨. kiwi schema 가
  unset float 의 default 로 NaN bit-pattern 을 emit 한다는 게 wire-format
  사실이고, 이 점이 Figma 와 우리 parser 모두에 동일하게 적용됨이 검증됨
  (round 29 setup-only 단계의 spot check). NaN 비교를 differ 로 처리하면
  audit signal 의 80%+ 가 stack* default 로 채워진다.
