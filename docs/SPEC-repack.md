# SPEC-repack — `.fig` 재패키징 3-mode 통합 contract

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `src/repack.ts` (`repack()` 디스패처 + `repackByteLevel` / `repackKiwi` / `repackFromJson` + `buildByteLevelFigBuffer` 재사용 helper) |
| 테스트 | `test/e2e.test.ts` (`repack byte/kiwi/json mode` gates) |
| 형제 | `docs/adr/0002-roundtrip-equality-tiers.md` (lossy mode 금지), `docs/specs/json-repack-codec.spec.md` (JSON tag codec), `docs/specs/round-trip-invariants.spec.md` (parser self-roundtrip), `docs/SPEC.md §10` (CLI Stage 등재), `docs/specs/audit-harness.spec.md` (web 측 round-trip 검증) |

## 1. 목적

CLI 의 reverse 파이프라인 (`extracted/<name>/` → `<out>.fig`) 은 3 모드를
지원한다 — **byte / kiwi / json**. 각 모드의 *입력 위치 / 출력 동등성 /
trade-off* 가 그동안 SPEC.md, ADR-0002, json-repack-codec.spec.md 에 분산되어
있었다. 본 spec 은 3 모드의 *통합 contract* 를 단일 source 로 둔다.

핵심 invariant — **lossy mode 는 영원히 금지** (ADR-0002). 본 spec 의 모든
모드는 byte-identical 또는 semantically-equivalent 둘 중 하나를 보장해야
한다.

## 2. 모드 선택 기준

| 모드 | 입력 디렉토리 | 출력 동등성 | 사용처 |
|---|---|---|---|
| `byte` | `extracted/01_container/` | byte-identical (canvas.fig) | backup / archival baseline |
| `kiwi` | `extracted/03_decompressed/` | semantically equivalent | re-encode 검증, deflate 통일 |
| `json` | `extracted/04_decoded/message.json` (편집 가능) | semantically equivalent (편집 후) | user 가 트리를 *수정* 한 뒤 재패키징하는 유일한 경로 |

- I-M1 진입점 = `repack(extractedDir, outPath, { mode })` 단일 함수. 내부
  switch 로 3 함수 중 하나에 디스패치. 알 수 없는 모드는 throw.
- I-M2 모드 자동 선택 / 폴백 없음 — 호출자가 명시적으로 1 mode 지정.
  추측 동작은 lossy mode 와 같은 부류의 trust risk.
- I-M3 출력은 *항상 ZIP-wrapped `.fig`*. raw fig-kiwi 출력 모드는 비대상
  (input 만 자동 분기, output 은 통일).

## 3. Equality tier — 3 모드 별 contract

### 3.1 `byte` 모드

- I-B1 입력: `extracted/01_container/` 의 `canvas.fig` (필수) + `meta.json` /
  `thumbnail.png` (있으면) + `images/` (있으면 *전부*).
- I-B2 모든 file read 는 병렬 (`Promise.all`) — `buildByteLevelFigBuffer`
  helper 가 round-trip HTML 등 다른 모듈에서도 재사용.
- I-B3 출력 ZIP 의 entry 이름은 입력 디렉토리의 path 그대로 (`canvas.fig`,
  `meta.json`, `thumbnail.png`, `images/<sha1>`). `images/` 안의 파일은
  `readdirSync().sort()` 순서로 추가 — 결정성 보장.
- I-B4 ZIP 압축 mode = STORE (compression method 0). `forceStoreCompression`
  helper 가 모든 entry 의 `header.method` 를 0 으로 강제 — Figma 가 carry
  하는 wire 형식과 동일.
- I-B5 동등성: **inner `canvas.fig` 가 byte-identical** 보장. 그러나 outer
  ZIP 자체는 byte-identical 아님 — adm-zip 의 ZIP central directory metadata
  (timestamp / extra field) 가 다를 수 있음. 검증은 inner `canvas.fig` 만.
- I-B6 verification: `finalizeResult` 가 `comparison.canvasFigBytesIdentical:
  bytesEqual(rt.canvasFig, orig.canvasFig)` 를 기록 — `byte` 모드만 이 필드
  emit, 다른 모드는 미정의.
- I-B7 사용자 *편집* 반영 안 됨 — 입력이 raw bytes 라 편집 entry point 없음.
  편집 + 재패키징은 `json` 모드 사용.

### 3.2 `kiwi` 모드

- I-K1 입력: `extracted/03_decompressed/` 의 `schema.kiwi.bin` + `data.kiwi.bin`
  (둘 다 필수). sidecar (`meta.json`, `images/`, etc.) 는 `01_container/`
  에서 그대로 차용.
- I-K2 처리: `kiwi.decodeBinarySchema` → `compileSchema` → `decodeMessage` →
  *그대로* `encodeMessage` + `encodeBinarySchema`. semantic identity 보장
  되는 한 byte 동일성은 *보장 안 함* (kiwi field ordering / variable-length
  encoding 의 결정성에 의존).
- I-K3 압축: 양쪽 chunk 모두 `pako.deflateRaw` 로 통일. 원본의 zstd chunk
  도 deflate 로 *변환* — `fzstd` 는 decode-only 이므로 통일이 강제.
- I-K4 archive header 재구성: `buildFigKiwiArchive(version, [compressedSchema,
  compressedData])` — `8B "fig-kiwi"` + `4B LE uint32 version` + chunk 별
  `4B LE uint32 size + bytes`. version 은 `02_archive/_info.json` 에서 읽음,
  부재 / 파싱 실패 시 `106` (관찰된 default) fallback.
- I-K5 동등성: **semantically equivalent** — 동일 node 개수 + 동일 schema
  definition 개수 + 동일 archive version + 동일 root message type
  (`finalizeResult.comparison` 4 필드 모두 match 필수). 어느 한 검사라도
  fail 이면 모드의 contract 위반.
- I-K6 사용자 편집 반영 안 됨 — 입력이 binary 라 편집 entry point 없음
  (json 모드와의 가장 큰 차이).
- I-K7 일반적 출력 사이즈는 원본보다 +10~20% (deflate vs zstd 차이 주범).
  `audit-roundtrip` baseline (메타리치 6.05 MB → ~6.5 MB) 가 정상 분포.

### 3.3 `json` 모드

- I-J1 입력: `extracted/04_decoded/message.json` (필수) + `extracted/03_decompressed/schema.kiwi.bin`
  (필수, schema 는 편집 대상 아님). sidecar 는 kiwi 모드와 동일.
- I-J2 prerequisite: `extract` 시 `--include-raw-message` 플래그 — 그렇지
  않으면 `04_decoded/message.json` 미생성. 입력 부재 시 친절한 에러 메시지
  emit 후 throw.
- I-J3 JSON 파싱: `JSON.parse(text, reviver)` 의 reviver 가 special tag 복원
  (§3.4 참조). 일반 object/array/scalar 는 통과.
- I-J4 인코딩: `kiwi.compileSchema(schema).encodeMessage(parsedMessage)` —
  user 가 편집한 트리가 schema 와 호환되어야 한다. 호환 실패 시 kiwi 가
  throw, 본 함수가 그대로 propagate.
- I-J5 동등성: **편집 적용 후 semantically equivalent** — 편집된 노드는
  user 의 의도대로 변경되되, *건드리지 않은 부분* 의 의미가 보존되어야
  한다. node 개수는 user 편집에 따라 변동 가능 (insert/delete) 이라
  `nodeCountMatch` 은 검증 *대상이 아니고* `comparison` 의 schema /
  archiveVersion 만 검증 의미가 있다.
- I-J6 lossless 보장의 토대 = §3.4 의 special-encoding tag system. 한 tag
  라도 raw JSON 으로 떨어지면 그 데이터는 손실 (e.g. blob bytes → null,
  bigint → TypeError, NaN → null).

### 3.4 JSON tag system (lossless 보장)

`json` 모드의 lossless invariant 는 다음 3 tag 의 양방향 sync 에 의존.
encode 측은 `intermediate.ts:roundTripReplacer`, decode 측은
`repack.ts:reviveBinary` — 두 함수가 *함께* 움직여야 한다 (ADR-0002 재진술).

- I-T1 `Uint8Array` ↔ `{ __bytes: <base64> }`. 디코드는 `Buffer.from(...,
  'base64')` 의 backing buffer 에 view 를 씌운 `Uint8Array` 반환 (zero-copy).
- I-T2 `bigint` ↔ `{ __bigint: <decimal-string> }`. `BigInt(str)` 로 복원.
- I-T3 비-finite number ↔ `{ __num: "NaN" | "Infinity" | "-Infinity" }`.
  나머지 finite number 는 raw JSON 그대로.
- I-T4 일반 object/array/scalar 는 reviver 그대로 통과 — magic key (`__bytes`
  / `__bigint` / `__num`) 가 *없는* object 는 변형 없이 반환.
- I-T5 새 tag 추가 = 한 파일 (`json-repack-codec.spec.md` 의 `jsonRepackCodec.ts`
  refactor 후) 안에 한 entry 추가 + replacer 한 case + reviver 한 case +
  단위 테스트. 한 case 빠지면 lossy → ADR-0002 violation.

## 4. 공통 흐름 — `finalizeResult`

3 모드 모두 출력 작성 후 동일 `finalizeResult` 호출 — 자기 출력을 *우리
자신의 파서로 다시 읽어* round-trip 검증.

- I-F1 `loadContainer(outPath)` + `decodeFigCanvas(canvasFig)` — 본 함수가
  실패하면 `verify.extracted = false` + error message. 다른 검증 skip.
- I-F2 성공 시 `verify` 에 다음 기록: `isZipWrapped`, `archiveVersion`,
  `schemaDefCount`, `nodeChangesCount`, `blobsCount`, `rootMessageType`.
- I-F3 `originalFig` 옵션 제공 시 추가로 `comparison` 4 필드 (§3.2 I-K5):
  `nodeCountMatch`, `schemaDefCountMatch`, `archiveVersionMatch` — `byte`
  모드는 `canvasFigBytesIdentical` 까지.
- I-F4 출력 SHA-256 = `outSha256`. round-trip 식별자로 사용 가능.

## 5. RepackResult schema

```ts
type RepackMode = 'byte' | 'kiwi' | 'json';

interface RepackOptions {
  mode:        RepackMode;
  originalFig?: string;  // round-trip 비교 활성화
}

interface RepackResult {
  mode:        RepackMode;
  outPath:     string;
  outBytes:    number;
  outSha256:   string;             // SHA-256 of outPath
  files:       Array<{ name: string; bytes: number }>;  // ZIP entry inventory
  verify: {
    extracted:        boolean;
    isZipWrapped?:    boolean;
    archiveVersion?:  number;
    schemaDefCount?:  number;
    nodeChangesCount?: number;
    blobsCount?:      number;
    rootMessageType?: string;
    error?:           string;
  };
  comparison?: {                   // originalFig 제공 시
    originalNodeCount:        number;
    nodeCountMatch:           boolean;
    originalSchemaDefCount:   number;
    schemaDefCountMatch:      boolean;
    originalArchiveVersion:   number;
    archiveVersionMatch:      boolean;
    canvasFigBytesIdentical?: boolean;  // byte 모드에서만 정의
  };
}
```

- I-S1 `comparison` 필드는 `originalFig` 옵션이 *제공되었고 파일이 존재할
  때만* 정의. 그렇지 않으면 undefined — round-trip 검증 자체가 optional.
- I-S2 `verify.extracted = false` 일 때 다른 verify 필드는 모두 undefined +
  `error` 만 정의. partial state 로 호출자가 햇갈리는 것 방지.

## 6. Error policy

- I-E1 입력 디렉토리 / 파일 부재는 *친절한 에러* — "어느 파일이 어느 mode
  에서 필요한지 + 어느 명령으로 생성하는지" 까지 message 에 포함. 예:
  `"extracted/04_decoded/message.json not found. Run \`figma-reverse extract
  <fig> --include-raw-message\`"`.
- I-E2 kiwi decode/encode 실패는 그대로 propagate — 사용자 편집이 schema
  를 위반했을 가능성이 압도적이고, `kiwi` lib 의 에러 메시지 자체가
  진단 정보 충분.
- I-E3 `verify` 단계의 실패는 *throw 없음* — `verify.extracted = false` +
  `error` 만 기록. round-trip 검증은 *informational* 이고 출력 파일 자체는
  이미 작성 완료.
- I-E4 알 수 없는 mode 는 디스패처에서 즉시 throw — 호출자 인자 검증을
  본 함수에서 늦지 않게 잡는다.

## 7. 비대상

- ❌ **lossy mode** (`derivedSymbolData` / `derivedTextData` / glyph cache
  trim) — ADR-0002 가 명시적으로 금지. PR 으로 제안되면 reject 후 ADR
  포인터.
- ❌ **byte 모드의 outer ZIP byte-identity** — adm-zip 이 carry 하는 metadata
  (CDFH timestamp / version-needed-to-extract 등) 가 byte-identical 보장
  대상 아님. inner `canvas.fig` 만 보장 (§I-B5).
- ❌ **kiwi 모드의 zstd 보존** — `fzstd` 가 decode-only 이라 deflate 로 통일.
  Figma 가 zstd chunk 를 carry 한 원본은 우리 측 출력에서 deflate 로 변경됨.
  로드는 정상 (decode 자동 감지) — write 만 deflate 통일.
- ❌ **json 모드의 schema 편집** — schema 는 user 편집 대상 아님. schema 만
  변경하려면 kiwi 모드 (그러나 그것도 schema *내용* 은 변경 불가, 재인코드만).
- ❌ **편집 충돌 detection** — user 가 `04_decoded/message.json` 을 편집하는
  사이 schema 가 변경되는 race 는 다루지 않는다. user 책임.
- ❌ **streaming repack** — 모든 모드가 file-in-memory. >500MB fixture 는
  미지원 (CLI 의 다른 stage 와 동일 가정).
- ❌ **partial fixture repack** — `01_container/` / `03_decompressed/` /
  `04_decoded/` 중 *일부만* 가지고 mode 자동 선택 안 함. 모드 별 입력은
  엄격 (§3 의 I-B1 / I-K1 / I-J1).

## 8. Resolved questions

- **3 모드 중 어느 것이 default 인가?** 없음 — CLI 가 항상 `--mode <byte|kiwi|json>`
  명시 요구. 기본값을 두는 순간 *어느 모드로 round-trip 했는지 잊을 가능성*
  발생, equality tier 가 흐려진다.
- **byte 모드는 정말 byte-identical 인가, 아니면 ZIP timestamp 등 변동?**
  inner `canvas.fig` 만 byte-identical (§I-B5). outer ZIP 자체는 adm-zip
  metadata 변동. test/e2e 의 byte mode gate 가 inner 만 검증.
- **kiwi 모드 출력이 원본보다 큰 이유?** zstd → deflate 변환 + kiwi 의 가변
  길이 인코딩에서 일부 default-value 가 explicit 로 emit 됨. semantic
  equivalence 는 유지되지만 byte 동일성은 깨짐. ADR-0002 가 이걸 lossy 로
  보지 않는 이유 = *모든 필드가 보존됨*; 단지 default 의 explicit 표현일
  뿐.
- **json 모드의 NaN tag 가 정말 wire 에 등장하는가?** 등장. kiwi schema 가
  unset float field 의 default 를 NaN bit-pattern 으로 emit (메타리치 corpus
  에서 stack* spacing 의 unset state 로 흔함). json reviver 가 NaN 복원
  안 하면 그 unset 상태가 0 으로 *변환* 되어 lossy.
- **`audit-harness.spec.md` 의 web round-trip 과 본 spec 의 CLI repack 은
  같은 contract 를 따르나?** 부분적. web 의 `POST /api/save` 는 kiwi 모드
  와 동등 (`extracted` 디렉토리 거치지 않고 in-memory document → encode →
  zip). byte 모드와 json 모드는 web 측에 대응 없음 — CLI 전용. equality
  tier 는 같은 ADR-0002 framework 안.
