# spec/audit-oracle

| 항목 | 값 |
|---|---|
| 상태 | Approved (Phase 2 MVP) |
| 구현 | `figma-plugin/{manifest.json, code.js, ui.html}` + `web/core/application/AuditCompare.ts` + `web/server/adapters/driving/http/auditRoute.ts` |
| 테스트 | (TODO) `web/core/application/AuditCompare.test.ts` — 본 spec 의 Invariants 단위 |
| 형제 | `web-upload-fig.spec.md` (sessionId 발급), `round-trip-invariants.spec.md` (parser 자체 검증) |

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

### 5.2 Comparable fields

`COMPARABLE_FIELDS` 가 단일 source of truth. 각 entry 는
`{ field, pickFigma, pickOurs, gate? }`.

- I-A4 같은 key 양쪽: `type`, `name`, `visible`, `size.x`, `size.y`,
  `transform.m02`, `transform.m12`, `rotation`, `opacity`, `cornerRadius`,
  `strokeWeight`.
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
  - 그 외 type 명은 그대로.

### 5.4 Field defaults

- I-A10 `FIELD_DEFAULTS` map 이 `figma=undefined ↔ ours=<default>` 등치
  관계를 강제. 현재 등록된 default:
  - `opacity: 1`, `rotation: 0`, `cornerRadius: 0`, `strokeWeight: 0`,
    `visible: true`, `fills.length: 0`, `strokes.length: 0`,
    `transform.m02: 0`, `transform.m12: 0`.
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

## 7. 비대상 (v1)

- ❌ paint 본문 비교 (color rgba, gradient stops, image hash). v1 은 길이만
  (§I-A5). round 31+ 작업으로 `serializeFill` 확장 + `pickOurs` 정렬.
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
