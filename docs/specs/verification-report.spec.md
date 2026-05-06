# spec/verification-report

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `src/verify.ts` (`runVerification`, 7 check functions, `renderReport`) |
| 출력 | `<outputDir>/verification_report.md` |
| 테스트 | `test/verify.test.ts` (있는 한도 내) — check 별 PASS/FAIL/WARN/SKIP 분류 단위 |
| 형제 | `SPEC.md §Stage 9` (CLI 파이프라인 source), `PRD.md §7` (검증 전략 source), `round-trip-invariants.spec.md` (전체 파이프라인 invariant 검증), `audit-harness.spec.md` (web 측 round-trip 검증) |

## 1. 목적

CLI 의 마지막 stage — 추출 결과가 *알려진 invariant* 를 만족하는지 검사
하여 사람이 읽을 수 있는 `verification_report.md` 를 emit. PRD §7 의 V-01~V-06
이 *목표 invariant* 라면, 본 spec 은 *현재 구현된 7 check 의 입력 / 통과
기준 / 결과 해석* 을 single source 로 둔다.

**중요**: PRD 가 정의한 V-01~V-06 중 V-05 (결정성 — 동일 입력 2회 처리 →
SHA-256 동일) 는 **현재 미구현**. 추가로 V-07 (schema sanity) / V-08 (export
artifacts) 가 *PRD 외* 추가됨. 본 spec 이 *현실 구현* 을 source 로 다룸 —
PRD 와 차이는 §6 비대상에서 명시.

## 2. 진입점

```ts
function runVerification(inputs: VerifyInputs): {
  overall: 'PASS' | 'FAIL' | 'WARN';
  checks: CheckResult[];
  reportPath: string;
};

interface VerifyInputs {
  outputDir:   string;                           // verification_report.md 출력 위치
  container:   ContainerResult;                  // Stage 1 산출물
  decoded:     DecodedFig;                       // Stage 2-4 산출물
  tree:        BuildTreeResult;                  // Stage 5 산출물
  imageRefs:   Map<string, Set<string>>;         // Stage 6 산출물
  artifacts:   ExportArtifacts;                  // Stage 8 산출물
}
```

- I-E1 7 check 가 *고정 순서* 로 실행: V-01 → V-02 → V-03 → V-04 → V-06 →
  V-07 → V-08. (V-05 미실행 — §I-V5)
- I-E2 한 check 의 fail 이 다음 check 를 막지 않는다 — *모든* check 를 끝까지
  돌리고 종합 판정.
- I-E3 `overall` 종합 룰: `FAIL` 이 하나라도 있으면 `FAIL` / `WARN` 만 있으면
  `WARN` / 모두 `PASS` (또는 `SKIP`) 면 `PASS`.
- I-E4 출력은 markdown 파일 1개 — `outputDir/verification_report.md`. 별도
  JSON / structured artifact 미생성 (PR diff 용 markdown 만 carry).

## 3. CheckResult 형태

```ts
interface CheckResult {
  id:      string;                               // "V-01" 등 PRD 명명
  name:    string;                               // 한국어 검사 이름
  status:  'PASS' | 'FAIL' | 'WARN' | 'SKIP';
  detail:  string;                               // markdown table cell 에 그대로 들어감
}
```

- I-R1 `id` 는 PRD §7 의 V-XX 명명 그대로. V-05 가 *건너뛰는* 만큼 V-07/V-08
  은 PRD 에 없는 검사.
- I-R2 `status` 4 종:
  - `PASS` — invariant 만족.
  - `FAIL` — 근본적 corruption (트리 부재, schema 미디코드, 산출물 0).
  - `WARN` — 검증 실패지만 *비치명적* (asset orphan, message round-trip 미보장
    등 알려진 한계).
  - `SKIP` — invariant 적용 불가능한 상황 (raw fig-kiwi 입력에 meta.json
    부재 등).
- I-R3 `detail` 은 *한 줄 markdown* — table cell 호환을 위해 `|` 가 `\|`
  로 escape, newline 미허용.

## 4. 검사 목록

### 4.1 V-01 — 입력 파일 무결성

- I-V1 `container.canvasFig` 의 첫 8 byte 가 `"fig-kiwi"` ASCII (`66 69 67
  2d 6b 69 77 69`) 와 일치하는지 검사.
- I-V2 PASS 시 detail: `'canvas.fig magic = "fig-kiwi" (✓), ZIP wrapped: <bool>,
  canvas.fig size: <N> bytes'`.
- I-V3 FAIL 시 detail: `'canvas.fig magic invalid: <hex bytes>'`. 주된 원인 =
  비-Figma 파일 또는 corruption.
- I-V4 *ZIP CRC 검증은 본 검사 미포함* — adm-zip 이 `loadContainer` 단계
  에서 implicit 검증 (CRC mismatch 시 throw). 명시적 ZIP CRC 보고는 별도
  enhancement.

### 4.2 V-02 — 디코딩 round-trip

- I-V5 schema 측 byte-equal 검증: `kiwi.encodeBinarySchema(decoded.schema)`
  vs `decoded.rawSchemaBytes` byte-by-byte 비교. PASS 시 `bytesMatch = true`.
- I-V6 message 측은 *encode 가능 여부* 만 검증 (byte-equal 아님). 원본
  data bytes (`decoded.rawDataBytes`) 와 re-encoded message bytes 의 *길이
  비교* + deflate 압축 사이즈 비교 — diagnostic only.
- I-V7 status 룰:
  - schema match + message encode 성공 → PASS.
  - schema match + message encode 실패 → WARN ("message round-trip not
    guaranteed").
  - schema mismatch → WARN.
  - throw → WARN (graceful degrade).
- I-V8 *FAIL 으로 escalate 안 함* — kiwi 의 일부 encoding 차이 (default 값
  explicit emit 등) 는 semantic 에 영향 없는 회귀 noise. round-trip 이
  진짜 깨지는 경우는 별도 raw byte diff 검사 (e.g. `audit-roundtrip-canvas-diff.mjs`).

### 4.3 V-03 — 트리 일관성

- I-V9 `tree.allNodes` 의 모든 node 에 대해:
  - `parentGuid` 부재 또는 `allNodes` 에 존재 → 정상.
  - `parentGuid` 있는데 `allNodes` 에 미존재 → `dangling++`.
- I-V10 DFS 사이클 검출: `stack` set 에 들어있는 노드를 다시 만나면
  `cycles++`. visited set 으로 중복 walk 방지.
- I-V11 `tree.document` 부재 → DOCUMENT root 미생성, 치명적.
- I-V12 status 룰:
  - dangling=0, cycles=0, document=true → PASS.
  - dangling=0, cycles=0, document=false → WARN.
  - dangling>0 또는 cycles>0 → FAIL.
- I-V13 detail 은 `nodes / document / dangling / cycles / orphans` 카운트.
  `orphans` 는 `tree.orphans.length` (root 가 아닌데 parent 도 없는 노드).

### 4.4 V-04 — 에셋 일관성

`container.images` (디스크 상의 image hash → bytes) vs `imageRefs` (트리
에서 walk 한 hash → owner 노드 set) 양방향 검사.

- I-V14 `imagesLower` / `refsLower` 모두 lowercase 정규화 — Kiwi 가 case-mix
  hash 를 carry 하는 wire 변동 흡수.
- I-V15 `missing` = ref 에 있는데 disk 에 없는 hash. orphan reference.
- I-V16 `unused` = disk 에 있는데 ref 에 없는 hash. unused image.
- I-V17 status 룰:
  - 둘 다 0 → PASS.
  - 둘 중 하나라도 > 0 → WARN. *FAIL 으로 escalate 안 함* — 디자인 의도일
    수 있음 (예: 임시로 hide 된 image).
- I-V18 SKIP: `container.images.size === 0 && refs.size === 0` (raw fig-kiwi
  + 이미지 없는 디자인).

### 4.5 V-06 — meta.json 일치

- I-V19 `container.metaJson` 부재 시 SKIP (raw fig-kiwi 입력).
- I-V20 PASS 항상 — *검증* 이 아니라 *요약 emit*. detail 에:
  - `file_name`
  - `client_meta.background_color` (4 자리 소수 rgba)
  - `client_meta.render_coordinates` (`<width>x<height> @ (<x>, <y>)`)
  - `exported_at`
  - `pages in tree` (CANVAS type 자식 카운트)
- I-V21 진짜 invariant 검증은 *user-confirm* (PRD §7.2 U-01~U-04) 영역 —
  자동 검증 부재. 본 check 는 *시각 비교 입력* 만 제공.

### 4.6 V-07 — Kiwi 스키마 sanity

(PRD 외 추가 검사)

- I-V22 `decoded.schemaStats.definitionCount` 검사:
  - `> 100` → PASS (Figma 의 wire 가 normally ~568 type).
  - `> 0` → WARN (수상함, 그러나 디코드 자체는 작동).
  - `0` → FAIL (스키마 파싱 실패 가능성).
- I-V23 detail: definition count + root type + archive version + 압축 알고리즘
  (schema/data) 4 항목 carry.

### 4.7 V-08 — Export artifacts

(PRD 외 추가 검사)

- I-V24 `artifacts.files.length > 0` → PASS, `0` → FAIL.
- I-V25 detail: 파일 수 + 총 byte (formatBytes) + 노드 수 + 페이지 수.

## 5. Report 렌더링

`renderReport(overall, checks, artifacts)` 가 markdown 문자열 emit.

- I-W1 헤더: `# Verification Report` + overall badge (`🟢 PASS` / `🟡 WARN` /
  `🔴 FAIL`) + 생성 timestamp (ISO 8601).
- I-W2 검사 결과 테이블: `| ID | Check | Status | Detail |` 헤더, check 별
  한 행. detail 의 `|` 는 `\|` 로 escape.
- I-W3 추출 통계 섹션:
  - `artifacts.stats.totalNodes`, `pages`, `topLevelFrames`, `imagesReferenced`,
    `imagesUnused`, `vectorsConverted`, `vectorsFailed`.
- I-W4 *알 수 없는 노드 타입* 섹션 (forward-compat) — `unknownTypes` map 이
  비어있지 않을 때만 emit. 새 Figma type 등장 시 carry.
- I-W5 *산출물 목록* 섹션: 파일 별 한 줄 `- `<rel-path>` — <size> (sha256:
  <16 chars>…)`. relative path 변환은 `outputDir` prefix 제거 + Windows
  backslash → forward slash.
- I-W6 footer: `--- Generated by figma-reverse v0.1.0`.
- I-W7 status badge 매핑: `PASS=🟢`, `FAIL=🔴`, `WARN=🟡`, `SKIP=⚪`.

## 6. 비대상 (PRD 와 다른 점)

- ❌ **V-05 결정성 (동일 입력 2회 처리 → SHA-256 동일)** — *현재 미구현*.
  `runVerification` 의 7 check 에서 빠짐. 구현 시 별도 round 후보 — `audit-roundtrip.mjs`
  의 `outSha256` 비교를 CLI 측에 옮기는 자연스러운 path.
- ❌ **V-CRC** (ZIP central directory CRC 명시적 검증) — adm-zip 이 implicit
  하게 검증하지만 결과 보고 없음. 추가 시 `checkInputIntegrity` 확장.
- ❌ **사용자 확인 검증** (PRD §7.2 U-01~U-04) — Figma 클라우드와의 시각
  비교 등은 자동화 대상 아님 (`audit-oracle.spec.md` / `audit-harness.spec.md`
  가 부분적으로 자동화).
- ❌ **structured JSON output** — markdown 만. JSON 으로 CI 파이프라인 통합
  은 별도 enhancement.
- ❌ **회귀 baseline 비교** — 이전 verification report 와 diff 자동 비교
  없음. 사람이 git diff 로 본다.
- ❌ **performance budget** — 처리 시간 / 메모리 사용 검증 (PRD NF-01/NF-02)
  은 본 spec 비대상.

## 7. Resolved questions

- **V-02 가 schema match 시에도 message encode 실패면 WARN 인 이유?** 메타리치
  의 일부 unknown type entry 가 kiwi 의 encode path 에 없는 경우가 있고,
  그 자체가 디코드/렌더에는 영향 없음 — schema 호환만 보장되면 *후방 호환
  의미는 보존*. 진짜 round-trip 깨짐은 audit-harness 의 byte-diff 가 잡음.
- **왜 V-04 가 WARN 만 emit 하고 FAIL 안 되나?** 디자이너가 임시로 hide
  한 이미지가 디스크에는 있는 케이스가 정상 패턴. orphan reference 도
  Figma 가 임시 cache 로 carry 한 데이터일 수 있음. 사람이 보고 판단할
  영역.
- **`unknownTypes` 가 carry 되는 이유?** Figma 가 schema 를 자주 update —
  새 type 이 우리 normalize / verify 코드 길에 등장해도 *crash 없이 carry*
  하고 사람에게 *보고* 하는 forward-compat 정책. 발견 시 다음 라운드에
  핸들링.
- **`detail` 한 줄 제약은 진짜 강제인가?** markdown table cell 의 limitation
  — `\n` 가 들어가면 table 깨짐. 다중 라인 정보는 별도 섹션으로 분리. 본
  spec 의 7 check 모두 한 줄에 fit 하는 형태로 디자인.
