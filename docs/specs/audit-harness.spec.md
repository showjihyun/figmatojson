# spec/audit-harness

| 항목 | 값 |
|---|---|
| 상태 | Approved (Phase 1 — round 30 transition) |
| 구현 | `web/scripts/audit-roundtrip.mjs`, `audit-roundtrip-canvas-diff.mjs`, `audit-rest-as-plugin.mjs` |
| 출력 | `docs/audit-roundtrip/<fixture-name>/report.json` + `canvas-diff.json` |
| 형제 | `audit-oracle.spec.md` (plugin oracle), `round-trip-invariants.spec.md` (parser self-roundtrip), `SPEC-repack.md` (3-mode contract), `docs/HARNESS.md` (CLI 측 harness) |

## 1. 목적

**Phase 1 baseline**: 우리 web 파이프라인 (`POST /api/upload` → `POST /api/save`)
이 *no-op load→save* 사이클에서 .fig 의 어느 부분을 보존하고 어느 부분을
잃는지를 자동 측정한다. 결과는 "Figma 가 다시 열어도 정상 표시" 의 *하한*
— 여기서 떨어지는 데이터는 Figma 에 다시 로드해도 살아남지 못한다.

3 스크립트가 *서로 다른 정밀도* 로 같은 round-trip 을 본다:

| 스크립트 | 정밀도 | 대상 |
|---|---|---|
| `audit-roundtrip.mjs` | ZIP entry byte-compare | container 레이어 (canvas.fig / images / meta.json) |
| `audit-roundtrip-canvas-diff.mjs` | Kiwi message field walk | canvas.fig 의 의미 변화 |
| `audit-rest-as-plugin.mjs` | `audit-oracle` 프로토콜 | Figma REST → 우리 parser 의 차이 |

본 spec 은 3 스크립트의 *공통 calling convention, 입출력, 분류 룰* 을
source of truth 로 둔다.

## 2. 공통 환경

- I-E1 모든 스크립트는 web backend 가 `:5274` 에 떠있어야 한다 (`cd web &&
  npm run dev:server`). port override 는 `AUDIT_BACKEND` 환경변수.
- I-E2 출력 루트 = `docs/audit-roundtrip/<basename(fixture, '.fig')>/`.
  스크립트마다 다른 파일 (`report.json`, `canvas-diff.json` 등) 을 같은
  fixture 디렉토리에 적재한다.
- I-E3 default fixtures = `['docs/bvp.fig', 'docs/메타리치 화면 UI Design.fig']`.
  CLI 인자로 절대 경로 또는 repo-relative 경로 N 개를 override 가능.
- I-E4 NaN 등치 룰: 두 값이 모두 number 이고 둘 다 `NaN` 이면 동일로 처리
  (`audit-oracle.spec.md §I-A14` 와 동일 정책 — kiwi schema 가 unset float
  default 로 NaN bit-pattern 을 emit).
- I-E5 byte 비교는 `bytesEqual(a, b)` 단일 helper — 각 스크립트가 같은
  구현을 carry. 차이 발견 시 첫 분기 offset 까지 기록 (triage 용).
- I-E6 스크립트는 fixture 마다 try/catch — 한 파일이 실패해도 나머지는
  진행. 종료 코드는 main 자체의 unhandled exception 만 1.

## 3. `audit-roundtrip.mjs` — Container 레이어 byte-compare

### 3.1 흐름

- I-R1 fixture bytes 를 `multipart/form-data` 로 `POST /api/upload` →
  `{ sessionId, pageCount, nodeCount, ...UploadFigOutput }` 응답.
- I-R2 동일 sessionId 로 `POST /api/save/:id` (no-op edit) →
  `application/octet-stream` 응답을 `Uint8Array` 로 수신.
- I-R3 원본 + round-trip 양쪽을 `unzipFig` 으로 푼다 — ZIP magic
  (`0x50 0x4b`) 검사 후 entry map. 비-ZIP raw fig-kiwi 는 single-entry map
  (`<raw>canvas.fig` 키) 으로 wrap — 전체 흐름이 ZIP 가정으로 통일.
- I-R4 entry 별 byte-compare → `entries[]` 와 `summary` 생성 (§3.2).

### 3.2 분류

각 entry 는 다음 4 종 status 중 하나로 분류:

- I-R5 `identical`: byte-equal. `origBytes`, `rtBytes` 동일 값 기록.
- I-R6 `differs`: 양쪽 모두 존재하지만 bytes 다름. 추가 필드 `deltaBytes`
  (rt - orig), `firstDiffOffset` (양쪽 byte 가 처음 갈리는 offset, 길이가
  더 짧은 쪽 미만으로 한정) 기록.
- I-R7 `missing-in-roundtrip`: orig 에만 존재. (반드시 우리 측 손실)
- I-R8 `extra-in-roundtrip`: rt 에만 존재. (우리 측 추가 — 정상 케이스
  거의 없음, 발견 시 회귀 의심.)

### 3.3 `summary` 출력

```ts
interface RoundtripSummary {
  totalOrigBytes:    number;  // sum(origBytes)
  identicalBytes:    number;  // sum(origBytes) where status='identical'
  identicalRatio:    number;  // identicalBytes / totalOrigBytes (0..1)
  identicalCount:    number;
  differingCount:    number;
  missingCount:      number;
  extraCount:        number;
  totalEntries:      number;
}
```

- I-R9 `report.json` 의 entries 는 entry name `sort()` 순. 결정성 보장.
- I-R10 `identicalRatio` 는 entry *byte 합* 기준 — entry 개수 기준 아님
  (canvas.fig 가 보통 가장 큰 단일 entry 라 의미 있는 가중).

### 3.4 출력 schema (`report.json`)

```ts
{
  fixture:    string;        // CLI 입력 그대로 (rel/abs 보존)
  origBytes:  number;        // 원본 .fig 전체 바이트
  rtBytes:    number;        // round-trip .fig 전체 바이트
  upload:     UploadFigOutput;
  summary:    RoundtripSummary;
  entries:    Array<RoundtripEntry>;
}
```

## 4. `audit-roundtrip-canvas-diff.mjs` — Kiwi message field walk

`audit-roundtrip.mjs` 가 *canvas.fig 가 다르다* 만 알려줄 때, 본 스크립트가
*어느 필드가, 어떻게 다른지* 를 알려준다.

### 4.1 흐름

- I-C1 §3.1 의 upload→save 와 동일 — 그러나 `report.json` 을 읽지 않고
  자체적으로 round-trip 다시 수행 (스크립트 독립성).
- I-C2 양쪽 .fig 에서 `canvas.fig` entry 만 추출 (`extractCanvasFig`).
  비-ZIP raw 도 그대로 통과.
- I-C3 양쪽 canvas.fig 를 `decodeFigCanvas` (dist/decoder.js) 로 디코드 —
  archive version + schema definition 수 + message tree 산출.
- I-C4 `walkDiff(orig.message, rt.message)` 로 generator-based 재귀 walk.

### 4.2 Diff 분류

`walkDiff` 가 emit 하는 record 의 `kind`:

- I-C5 `type-mismatch`: `typeOf(orig) !== typeOf(rt)`. type set =
  `{ object, array, bytes, number, string, boolean, nullish }`.
- I-C6 `added`: rt object 에 있고 orig 에 없는 key.
- I-C7 `removed`: orig object 에 있고 rt 에 없는 key.
- I-C8 `array-len`: 같은 path 의 array 길이가 다름. 길이 차이만 emit
  하고 이어서 `min(orig.length, rt.length)` 까지 element 별 walkDiff
  재귀 (앞부분 element 의 diff 도 모두 collect).
- I-C9 `changed`: scalar 또는 bytes 가 다름. NaN==NaN 은 동일로 처리
  (§I-E4).

### 4.3 집계

- I-C10 `aggregateDiffs(diffs)` 가 `byKind` (kind→count), `byField`
  (path 의 array 인덱스를 `[]` 로 normalize 한 키 → count + per-kind
  breakdown) 를 계산. `topFields` = byField top-30 desc.
- I-C11 `fieldKey(path)` = `path.replace(/\[\d+\]/g, '[]')` — `nodeChanges[42].size.x`
  와 `nodeChanges[1280].size.x` 는 같은 field 로 집계.

### 4.4 출력 schema (`canvas-diff.json`)

```ts
{
  fixture:           string;
  canvasOrigBytes:   number;
  canvasRtBytes:     number;
  schemaDefsOrig:    number;     // schema definition 개수 (의미적 동등 검증용)
  schemaDefsRt:      number;
  aggregate: {
    total:           number;
    byKind:          Record<DiffKind, number>;
    topFields:       Array<[fieldPath, { count, kinds: Record<DiffKind, number> }]>;
  };
  sample:            DiffRecord[];   // 최대 200 entries (truncation)
}
```

- I-C12 `sample` 은 발견된 순서 첫 200개. truncation 시 빈도 분포 보존
  안 함 — sampling 은 triage 용이고 빈도 신호는 `aggregate` 가 carry.

## 5. `audit-rest-as-plugin.mjs` — Plugin oracle 의 REST simulation

`audit-oracle.spec.md` 가 정의한 plugin sandbox 출력을 **Figma 데스크탑
plugin 없이** 재현 — REST API (`/v1/files/:key`) 응답을 adapter 로 변환.
human-in-the-loop 없이 oracle 프로토콜 검증 가능.

### 5.1 환경 + 코퍼스

- I-X1 `.env.local` 에서 `FIGMA_TOKEN` (필수) + per-corpus key
  (`FIGMA_FILE_KEY` for metarich / `FIGMA_FILE_KEY_BVP` for bvp).
- I-X2 코퍼스 map = `{ bvp: { figPath, keyEnv }, metarich: { figPath, keyEnv } }`.
  CLI 인자로 코퍼스 이름 N 개 (default `['bvp']`).
- I-X3 `.env.local` 부재 / 토큰 부재 / key 부재는 *fixture-level* 에러
  (catch + 계속) — main 종료 안 함.

### 5.2 흐름

- I-X4 REST `GET https://api.figma.com/v1/files/<KEY>` (header
  `X-Figma-Token`) → `restJson.document` 가 root.
- I-X5 `adaptNode(restJson.document)` 가 `audit-oracle.spec.md §3` 의
  plugin sandbox 출력 shape 을 emit (§5.3).
- I-X6 같은 fixture 의 local `.fig` 를 `POST /api/upload` 으로 우리 backend
  에 적재 → `sessionId`.
- I-X7 `POST /api/audit/compare { sessionId, figmaTree: adaptedTree }` →
  `AuditCompareOutput` 응답.
- I-X8 console 에 `summary` + `topFields` top-15 + sample diffs top-5 를
  출력. **JSON 파일 미저장** — diff 분포가 발견 즉시 사람이 읽는 게 목적.

### 5.3 REST → plugin shape adaptation

`audit-oracle.spec.md §3 (I-S1~10)` 의 직렬화 계약을 REST 응답으로 재현.
주요 변환 포인트:

- I-X9 좌표계: REST 의 `absoluteBoundingBox` 를 *parent 기준 상대 좌표* 로
  역변환. `parentAbs = { x, y }` 를 자식 walk 시 누적, `transform.m02 = bbox.x
  - parentAbs.x`, `m12 = bbox.y - parentAbs.y`. 우리 parser 의 `transform`
  이 parent-relative 라 직접 비교 가능해진다.
- I-X10 fontName: REST 가 `style.fontFamily` (display) + `style.fontPostScriptName`
  (실제 PS 이름) 을 carry. plugin 측이 emit 하는 `fontName.style` 은 PS
  이름 끝의 `-<style>` 토큰. adapter 는 `ps.lastIndexOf('-')` 로 split —
  display `family` 와 PS `family` 가 다른 경우 (예: `Pretendard` vs
  `PretendardVariable`) 도 처리.
- I-X11 fills/strokes/strokeWeight: 항상 emit (배열이 빈 경우에도) — plugin
  sandbox 와 동일 정책. `fills.length` / `strokes.length` 비교가 adapter
  생략으로 흐려지는 것 방지.
- I-X12 default omission: `opacity !== 1`, `rotation !== 0`, `cornerRadius !== 0`
  일 때만 emit (plugin sandbox 와 동일 — `audit-oracle §I-S4`).

### 5.4 Caveats vs. real plugin trial

- I-X13 REST 는 Figma 클라우드의 *현재* 파일 상태 — desktop plugin 은 desktop
  app 이 *로드한* 상태. 같은 `.fig` 로 둘 다 시작하면 실용상 동일.
- I-X14 REST 는 일부 plugin 전용 필드를 노출하지 않는다 — 그러나 oracle 의
  COMPARABLE_FIELDS (§audit-oracle §5.2) 안 모든 필드는 REST 에 존재.

## 6. 비대상

- ❌ **출력 파일 schema 의 backward-compatibility 보장**. round 30+ 에서
  `report.json` / `canvas-diff.json` 의 형태가 변경될 수 있음 — diff 자료는
  *다음 라운드의 입력* 이지 production artifact 아님. 변경 시 본 spec
  업데이트 필요.
- ❌ **CI 통합**. 본 harness 는 dev local 에서 수동 실행 — backend 가 떠있어야
  하고 fixture 가 git LFS 가 아니라 docs/ 에 raw 로 들어있다. CI 전환은
  별도 라운드.
- ❌ **자동 회귀 alert**. report.json 이 baseline 보다 떨어지는지 자동
  비교 안 함. 사람이 git diff 로 본다.
- ❌ **canvas-diff.mjs 의 round-trip 검증**. orig=rt 가 의미상 동등이면
  diff `total = 0` 이 정답이지만, 현재 baseline 은 *0 이 아닌 값* 이고
  본 harness 는 그 값을 *측정* 만 한다. "0 으로 만들기" 는 후속 라운드.
- ❌ **multi-page 별도 audit**. REST as plugin 은 root document 부터 walk —
  `audit-oracle §I-X4` 는 `figma.currentPage` 만 다룸. REST 는 모든 페이지
  를 한 번에 받으므로 본 스크립트는 root 부터 비교 (sandbox 와 다른 점).
  결과: REST 측 노드 수가 plugin 측보다 항상 큼 — `summary.onlyInFigma` 가
  플러그인 trial 보다 더 노이즈 한 신호.

## 7. Resolved questions

- **`audit-roundtrip.mjs` 가 entry name 을 sort 한 결과 순서로 emit 하는
  이유?** report.json 이 git 에 들어가는 *artifact* — diff noise 를 줄이려면
  결정적 순서 필요. ZIP entry 의 자연 순서는 OS / adm-zip 버전에 따라 변동.
- **`canvas-diff.mjs` 가 sample 200 으로 자르는 이유?** 메타리치 35K 노드
  decode → walkDiff 로 발생할 수 있는 record 가 수만 단위. JSON 파일 10MB+
  를 git 에 두는 건 비용 대비 가치 낮음. aggregate 가 분포 신호의 진짜
  source.
- **REST adapter 가 plugin sandbox 와 *완벽히* 일치해야 하나?** 아니. oracle
  의 비교 룰 (`audit-oracle §5`) 이 default omission / type alias / NaN
  등치 / 0.5px tolerance 로 representational 차이 대부분 흡수. adapter 는
  *의미적 등가* 만 책임 — wire 형태는 살짝 달라도 oracle 결과는 같다.
- **왜 3 스크립트가 같은 unzipFig / bytesEqual / loadEnv 를 carry 하나
  (DRY 위반)?** 각 스크립트가 *독립 실행 가능* 해야 한다 — backend down
  추적, individual fixture audit 등. 공유 helper 화는 round 30+ 에서
  스크립트 수가 5개 넘으면 재고려.
