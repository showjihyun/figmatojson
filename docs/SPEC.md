# SPEC — figma-reverse: `.fig` extract 파이프라인 deep-dive

| 항목 | 값 |
|---|---|
| 문서 버전 | v2.0 (2026-05-08 전체 재작성) |
| 패키지 버전 | `figma-reverse@0.1.11` |
| 적용 범위 | **extract 서브커맨드의 9-stage 파이프라인 + 자동 검증** |
| 언어/런타임 | TypeScript 5.7 / Node.js ≥ 20 / ESM |
| 자매 문서 | [`SPEC-architecture.md`](./SPEC-architecture.md) · [`SPEC-roundtrip.md`](./SPEC-roundtrip.md) · [`SPEC-repack.md`](./SPEC-repack.md) · [`SPEC-figma-to-pencil.md`](./SPEC-figma-to-pencil.md) |
| 대상 PRD | [`PRD.md`](./PRD.md) |

---

## 0. 범위

**IN scope (이 문서)**

- `extract` 서브커맨드의 9-stage 파이프라인 (`.fig` → `output/` + `extracted/`)
- 단계별 입력 / 처리 / 메모리·디스크 출력
- 자동 검증 V-01 ~ V-08
- `src/` 모듈 ↔ stage 매핑

**OUT of scope — 자매 문서 참조**

| 주제 | 문서 |
|---|---|
| Repack 3-mode (byte / kiwi / json) | [`SPEC-repack.md`](./SPEC-repack.md) |
| 라운드트립 보장 등급, JSON 무손실 태깅 | [`SPEC-roundtrip.md`](./SPEC-roundtrip.md) · [ADR-0002](./adr/0002-roundtrip-equality-tiers.md) |
| pencil.dev `.pen` exporter (좌표·ID·variant) | [`SPEC-figma-to-pencil.md`](./SPEC-figma-to-pencil.md) |
| Web editor (Clean+Hexagonal, Konva canvas) | [`SPEC-architecture.md`](./SPEC-architecture.md) |
| 도메인 용어 (Kiwi Record / Tree Node / Master / Instance / Pen ID / Effective Visibility …) | [`CONTEXT.md`](../CONTEXT.md) |
| `.fig` 와이어 포맷 byte-level 시각 레퍼런스 | [`fig-format/figma-fig-format.md`](./fig-format/figma-fig-format.md) |
| 외부 audit 하니스 (5 스크립트, 결정성·byte-compare·oracle) | [`specs/audit-harness.spec.md`](./specs/audit-harness.spec.md) · [`HARNESS.md`](./HARNESS.md) |
| 라운드별 작업 히스토리 (round 2 ~ 18-B) | [`specs/archive/`](./specs/archive/) |

다른 6개 CLI 서브커맨드(`repack`, `pen-export`, `editable-html`, `html-report`, `round-trip-html`, `tokens`)는 §7에 한 줄씩만 인덱싱하고 상세는 위 자매 문서로 위임.

---

## 1. 한눈에 보기

```
┌────────────────┐       ┌─────────────┐       ┌──────────────────┐
│  design.fig    │ ───►  │  extract    │ ───►  │  output/  +  extracted/    │
│  (ZIP wrapper) │       │  9 stages   │       │  (사람이 읽는 JSON +     │
└────────────────┘       └─────────────┘       │   stage-by-stage 산출물) │
                                                └──────────────────┘
```

**한 줄 요약** — Figma `.fig` 바이너리(ZIP → fig-kiwi archive → schema+data 청크 → kiwi message → 트리)를 9단계로 풀어 무손실 JSON·이미지·SVG로 export하고, 단계별 산출물을 disk에 남겨 추적·검증·재패키징을 가능하게 한다.

> 📘 **Wire-format 시각 레퍼런스**: [`fig-format/figma-fig-format.md`](./fig-format/figma-fig-format.md) — Stage 1~4 byte-level 레이아웃, fig-kiwi 컨테이너, 568 type schema, ENUM/STRUCT/MESSAGE 와이어 패턴, tag-matching 디코드.

---

## 2. 9-Stage Pipeline

> **읽는 법**: 각 stage = `[입력] → 처리 → [출력 (memory) + 출력 (disk)]`. **굵게** 표시된 path는 disk에 남는다.

### 2.0 한눈에 보기 (stage IO matrix)

| # | 단계 | 모듈 | 입력 타입 | 출력 타입 | 핵심 |
|--:|---|---|---|---|---|
| 1 | 컨테이너 분해 | `container.ts` | `<input>.fig` 경로 | `ContainerResult` (canvasFig + meta + thumbnail + images) | ZIP / raw 자동 분기 |
| 2 | fig-kiwi 청크 분해 | `archive.ts` | `canvas.fig` byte | `FigArchive { prelude, version, chunks[] }` | 8B magic + 4B version + length-prefixed chunks |
| 3 | 압축 해제 | `decompress.ts` | 두 압축 chunk | `Uint8Array × 2` | **schema=deflate-raw, data=zstd** auto-detect |
| 4 | Kiwi 디코드 | `decoder.ts` | uncompressed schema + data | `DecodedFig { schema, message }` | rootType `NODE_CHANGES`, 568 type defs |
| 5 | 트리 재구성 | `tree.ts` | `message.nodeChanges[]` | `BuildTreeResult { document, allNodes, orphans }` | parent GUID + fractional-index 정렬 |
| 6 | 이미지 ref 매핑 | `assets.ts` | 트리 + `images` Map | `Map<hash, Set<ownerGuid>>` | magic byte → 확장자 추론 |
| 7 | 벡터 추출 | `vector.ts` | 트리 + `message.blobs[]` | SVG path × N | best-effort (sample 95%) |
| 8 | 정규화 + Export | `normalize.ts`, `export.ts` | 트리 + refs + decoded | `output/<figName>/**` | REST API 호환 별칭 + 페이지별 분리 |
| 9 | 검증 보고서 | `verify.ts` | 위 모든 결과 | `verification_report.md` | V-01~V-04 · V-06~V-08 (V-05 reserved) |

> Stage 6은 메모리만 사용. Stage 8이 ref 매핑을 토대로 disk에 일괄 저장한다.

### Stage 1️⃣ 컨테이너 분해

> Figma Cloud export `.fig`는 사실 **ZIP 파일**이다. 안의 `canvas.fig`만 진짜 바이너리.

| | |
|---|---|
| **모듈** | `src/container.ts` |
| **입력** | `<input>.fig` 파일 경로 |
| **처리** | 1. 파일 첫 4 byte로 ZIP/raw 자동 분기 (ZIP magic `50 4B 03 04` 또는 fig-kiwi magic `66 69 67 2D 6B 69 77 69`)<br>2. ZIP이면 `adm-zip`으로 entries 순회 → `canvas.fig`, `meta.json`, `thumbnail.png`, `images/<hash>` 분리<br>3. raw fig-kiwi이면 그대로 `canvasFig`로 사용 |
| **출력 (memory)** | `ContainerResult { isZipWrapped, canvasFig, metaJson, thumbnail, images }` |
| **출력 (disk)** | **`extracted/<figName>/01_container/`** (세부 §3.2) |

### Stage 2️⃣ fig-kiwi 아카이브 청크 분해

> `canvas.fig`는 Evan Wallace의 **Kiwi 직렬화 포맷** + 청크 컨테이너. 두 청크(스키마 + 데이터).

| | |
|---|---|
| **모듈** | `src/archive.ts` |
| **입력** | `canvas.fig` byte (Stage 1) |
| **처리** | 1. 8 byte `fig-kiwi` magic 검증<br>2. 4 byte LE uint32 → archive version (예: 106)<br>3. 루프: `[4 byte LE size][size bytes data]` → `chunks[]` 추출 |
| **출력 (memory)** | `FigArchive { prelude, version, chunks[] }` |
| **출력 (disk)** | **`extracted/.../02_archive/chunks/00_schema.bin`** (압축, ~26 KB)<br>**`extracted/.../02_archive/chunks/01_data.bin`** (압축, ~3.7 MB) |

### Stage 3️⃣ 압축 해제 (deflate-raw / zstd 자동 분기)

> 첫 청크는 **deflate-raw**, 두 번째 청크는 **zstd** — 한 파일 안에 다른 알고리즘. 본 프로젝트의 핵심 발견 (PRD §1.2.3 가설을 실증).

| | |
|---|---|
| **모듈** | `src/decompress.ts` |
| **입력** | 두 압축 chunk byte |
| **처리** | 1. Magic byte로 알고리즘 자동 감지<br>&nbsp;&nbsp;• `28 B5 2F FD` → zstd<br>&nbsp;&nbsp;• `78 xx` → deflate-zlib<br>&nbsp;&nbsp;• 그 외 → deflate-raw<br>2. 감지된 알고리즘으로 시도, 실패 시 다른 알고리즘 fallback |
| **출력 (memory)** | `Uint8Array` × 2 (uncompressed schema + data) |
| **출력 (disk)** | **`extracted/.../03_decompressed/schema.kiwi.bin`** (~64 KB, deflate-raw 해제)<br>**`extracted/.../03_decompressed/data.kiwi.bin`** (~20 MB, **zstd** 해제) |

### Stage 4️⃣ Kiwi 디코드 (스키마 → 메시지)

> 첫 청크는 **스키마 정의 자체**(568개 타입), 두 번째 청크는 그 스키마로 인코딩된 **NodeChanges 메시지**.

| | |
|---|---|
| **모듈** | `src/decoder.ts` |
| **입력** | uncompressed schema + data byte (Stage 3) |
| **처리** | 1. `kiwi.decodeBinarySchema(schemaBytes)` → Schema 객체<br>2. `kiwi.compileSchema(schema)` → CompiledSchema (decoder 클래스)<br>3. `compiled.decodeMessage(dataBytes)` → 메시지 객체 (root: `NODE_CHANGES`) |
| **출력 (memory)** | `DecodedFig { schema, message, ... }` |
| **출력 (disk)** | **`extracted/.../04_decoded/schema.json`** (~812 KB, 사람이 읽는 스키마 정의)<br>`extracted/.../04_decoded/message.json` (~150 MB, **`--include-raw-message` 시에만**) |

### Stage 5️⃣ 노드 트리 재구성

> 메시지의 `nodeChanges[]`는 평탄한 배열. parent GUID로 **트리 복원** + position 문자열로 **형제 정렬**.

| | |
|---|---|
| **모듈** | `src/tree.ts` |
| **입력** | `message.nodeChanges[]` (sample: 35,660개) |
| **처리** | 1. 각 노드를 `(sessionID:localID)` 키로 Map에 저장<br>2. 각 노드의 `parentIndex.guid`로 부모 찾고 children에 추가<br>3. `parentIndex.position` 문자열로 형제 정렬 (Figma의 fractional indexing — 자세한 spec: [`specs/parent-index-position.spec.md`](./specs/parent-index-position.spec.md))<br>4. `DOCUMENT` 타입 = root, parent 못 찾은 노드 = orphans |
| **출력 (memory)** | `BuildTreeResult { document, allNodes, orphans }` |
| **출력 (disk)** | **`extracted/.../05_tree/nodes-flat.json`** (~3.6 MB, 평탄 테이블 — grep 가능)<br>`extracted/.../05_tree/orphans.json` (있을 때만) |

### Stage 6️⃣ 이미지 참조 매핑

> 트리 walk → image hash 수집 → ZIP에서 추출한 `images/`와 cross-check.

| | |
|---|---|
| **모듈** | `src/assets.ts` |
| **입력** | 트리 root + Stage 1의 `images` Map |
| **처리** | 1. 모든 노드 데이터 재귀 walk<br>2. `image.hash`, `imageRef`, `hash` 필드에서 SHA-1 해시 수집 (자세한 spec: [`specs/asset-walk.spec.md`](./specs/asset-walk.spec.md))<br>3. `hash → Set<owner-guid>` 매핑 생성<br>4. magic byte로 이미지 확장자 추론 (PNG / JPG / WebP / GIF / SVG / PDF) |
| **출력 (memory)** | `Map<hash, Set<guid>>` |
| **출력 (disk)** | (Stage 8에서 `output/assets/images/<hash>.<ext>`로 일괄 저장) |

### Stage 7️⃣ 벡터 추출 (best-effort)

> VECTOR 노드의 `fillGeometry[*].commandsBlob` → `message.blobs[]` 인덱스 → byte 디코드 → SVG path. 자세한 spec: [`specs/vector-decode.spec.md`](./specs/vector-decode.spec.md).

| | |
|---|---|
| **모듈** | `src/vector.ts` |
| **입력** | 트리 + `message.blobs[]` |
| **처리** | 1. VECTOR / STAR / LINE / ELLIPSE / REGULAR_POLYGON 노드 순회<br>2. `fillGeometry`/`strokeGeometry`의 `commandsBlob` → `blobs[]` 인덱스<br>3. blob byte → path command 디코드:<br>&nbsp;&nbsp;• `0x01` MOVE_TO + 2×float32<br>&nbsp;&nbsp;• `0x02` LINE_TO + 2×float32<br>&nbsp;&nbsp;• `0x03` CUBIC + 6×float32<br>&nbsp;&nbsp;• `0x04` QUAD + 4×float32<br>&nbsp;&nbsp;• `0x05` CLOSE<br>4. 두 시작 offset(0, 1) 시도하고 더 많은 명령을 디코드한 쪽 채택<br>5. fill / stroke 색상까지 SVG에 반영 |
| **출력 (disk)** | **`output/<figName>/assets/vectors/<node-id>.svg`** (sample: 1,599 / 1,681 ≈ 95% 성공) |

### Stage 8️⃣ 정규화 + Export

> Kiwi 원본 키 보존 + REST API 호환 별칭 추가, 페이지별로 분리. REST 정규화 spec: [`specs/rest-api-normalize.spec.md`](./specs/rest-api-normalize.spec.md).

| | |
|---|---|
| **모듈** | `src/normalize.ts`, `src/export.ts` |
| **입력** | 트리 + 이미지 refs + 디코드 결과 |
| **처리** | 1. 트리 노드를 `NormalizedNode`로 변환:<br>&nbsp;&nbsp;• `id` (S:L 문자열), `parentId` 추가<br>&nbsp;&nbsp;• `fillPaints` → `fills` 별칭<br>&nbsp;&nbsp;• `strokePaints` → `strokes` 별칭<br>&nbsp;&nbsp;• `size + transform` → `absoluteBoundingBox`<br>&nbsp;&nbsp;• `Uint8Array` → hex 문자열, `BigInt` → 문자열<br>2. CANVAS 노드별로 페이지 분리<br>3. 이미지 magic 추론 후 disk 저장<br>4. SHA-256 manifest 생성 |
| **출력 (disk)** | `output/<figName>/document.json` (전체 트리, `--no-document` 시 생략)<br>**`output/<figName>/pages/<idx>_<name>.json`** (CANVAS별)<br>**`output/<figName>/assets/images/<hash>.<ext>`**<br>**`output/<figName>/assets/vectors/<id>.svg`**<br>**`output/<figName>/assets/thumbnail.png`**<br>**`output/<figName>/schema.json`** (~812 KB)<br>**`output/<figName>/metadata.json`**<br>**`output/<figName>/manifest.json`** (모든 산출물 인덱스 + sha256) |

### Stage 9️⃣ 검증 보고서

> 자동 V-01 ~ V-08 체크 + 통계 + Markdown 보고서. 상세 contract: [`specs/verification-report.spec.md`](./specs/verification-report.spec.md).

| | |
|---|---|
| **모듈** | `src/verify.ts` |
| **입력** | 모든 단계 결과 |
| **처리** | §4의 활성 7개 체크(V-01·02·03·04·06·07·08) 순차 실행 후 마크다운 보고서 작성. V-05(결정성)는 `runChecks()`에서 제외 — §4 footnote 참조 |
| **출력 (disk)** | **`output/<figName>/verification_report.md`** |

---

## 3. 출력 디렉토리 구조 (실측)

`<figName>` = 입력 `.fig` basename에서 `.fig` 확장자 제거한 문자열 (한글·공백 OK). 예: `메타리치 화면 UI Design`.

### 3.1 `output/<figName>/` — 사용자 소비용

> 사람이 읽고 검색하기 좋은 형태. REST API와 호환되는 별칭 포함.
> 아래 사이즈는 sample(`docs/메타리치 화면 UI Design.fig`, 6 페이지·35,660 노드, `--no-document --minify`) 기준 ≈ 87 MB.

```
output/<figName>/
├── pages/                                   # 페이지별 트리 (CANVAS 단위 분리)
│   ├── 00_design setting.json     2.5 MB    # ← sample 페이지 크기. 실제는 입력 fig에 따라 다름
│   ├── 01_Internal Only Canvas.json 258 KB
│   ├── 02_WEB.json                67.5 MB
│   ├── 03_MOBILE.json              3.6 MB
│   ├── 04_dash board.json          2.4 MB
│   └── 05_icons.json               1.4 MB
├── assets/
│   ├── images/                              # SHA-1 해시 + magic 기반 확장자
│   │   ├── 01953550...256875bb6b.png
│   │   ├── ... (sample: 12개 PNG)
│   │   └── ce4146cf...62e7736dd.png
│   ├── vectors/                             # commandsBlob → SVG path
│   │   └── <node-id>.svg × 1,599
│   └── thumbnail.png
├── schema.json                              # Kiwi schema 568 defs (~812 KB)
├── metadata.json                            # meta.json + 추출 통계
├── manifest.json                            # 산출물 인덱스 + SHA-256 (~204 KB)
└── verification_report.md                   # V-01 ~ V-08 결과 (~120 KB)
```

> `document.json` (전체 트리 단일 파일)은 `--no-document` 플래그로 생략 가능 (페이지 파일과 중복).

### 3.2 `extracted/<figName>/` — 디버그·재패키징용

> 파이프라인 stage-by-stage breadcrumb. 각 폴더에 `_info.json` 메타파일.
> 아래 사이즈는 동일 sample 기준 ≈ 34 MB.

```
extracted/<figName>/
├── 01_container/                            # Stage 1
│   ├── canvas.fig                3.74 MB    # ZIP 내부의 fig-kiwi 바이너리
│   ├── meta.json                 341 B      # file_name, background_color 등
│   ├── thumbnail.png             17.7 KB
│   ├── images/                              # 해시 파일명, raw byte
│   └── _info.json                           # sha256, byteLength, magic byte
│
├── 02_archive/                              # Stage 2 (압축 상태)
│   ├── chunks/
│   │   ├── 00_schema.bin         26 KB      # firstBytes: b5 bd 09 98...
│   │   └── 01_data.bin           3.72 MB    # firstBytes: 28 b5 2f fd... (zstd)
│   └── _info.json                           # version=106, chunkCount=2
│
├── 03_decompressed/                         # Stage 3 (압축 해제)
│   ├── schema.kiwi.bin           64 KB      # Kiwi schema 바이너리
│   ├── data.kiwi.bin             20 MB      # NodeChanges 메시지 바이너리
│   └── _info.json                           # 알고리즘 (deflate-raw / zstd)
│
├── 04_decoded/                              # Stage 4 (JSON)
│   ├── schema.json               812 KB     # 568 type 정의
│   └── _info.json                           # rootMessageType, nodeChangesCount
│   # message.json (~150 MB) — `--include-raw-message` 시에만 생성
│
└── 05_tree/                                 # Stage 5
    ├── nodes-flat.json           3.6 MB     # (id, type, name, parentId, childCount)
    └── _info.json                           # totalNodes, pageCount, typeDistribution
```

> 다른 서브커맨드가 추가하는 폴더 — `06_report/` (round-trip viewer), `07_editable/` (single-file HTML), `08_pen/` (pencil.dev .pen) — 는 §7과 자매 문서 참조.

### 3.3 `_info.json` 예시 (`02_archive/_info.json`)

```json
{
  "stage": "02_archive",
  "description": "fig-kiwi 청크 분해 (압축 상태). 첫 청크 = Kiwi 스키마, 두 번째 = 데이터 메시지.",
  "prelude": "fig-kiwi",
  "version": 106,
  "chunkCount": 2,
  "chunks": [
    {
      "index": 0, "role": "schema", "compressedBytes": 26022,
      "firstBytesHex": "b5 bd 09 98 64 57 59 30",
      "sha256": "5a27244b6e0b375d69d4762499224b357d5fe3df132021f2ee42774ec02257f1"
    },
    {
      "index": 1, "role": "data", "compressedBytes": 3898560,
      "firstBytesHex": "28 b5 2f fd 80 58 fc ce",
      "sha256": "35ce8522934ab134cdae64910c703ab0d0cbbf1e3cc65be38222cd70440363a4"
    }
  ]
}
```

---

## 4. 자동 검증 (V-01 ~ V-08)

> 구현: `src/verify.ts`. Stage 9에서 일괄 실행 후 `output/<figName>/verification_report.md` 생성.

| ID | 항목 | 무엇을 본다 | Sample 결과 |
|---|---|---|---|
| **V-01** | 입력 무결성 | ZIP CRC + `canvas.fig` magic 재확인 | 🟢 `fig-kiwi` (✓), 3,924,602 bytes |
| **V-02** | 디코딩 round-trip | schema decode → re-encode → byte-level diff | 🟢 byte-level identical (sample: 64,341 byte schema) |
| **V-03** | 트리 일관성 | 모든 child의 parent 존재, 순환 없음 | 🟢 35,660 nodes, orphans=0, cycles=0 |
| **V-04** | 에셋 일관성 | imageRef ↔ `images/` cross-check, missing/unused 카운트 | 🟢 12/12 매칭, missing=0, unused=0 |
| **V-05** | 결정성 (선택) | 동일 입력 2회 처리 → 출력 SHA-256 동일 | (현재 `runChecks`에서 미실행 — 명세상 reserved) |
| **V-06** | meta.json 일치 | meta.json 값 ↔ document root 메타 비교 (file_name, background_color) | 🟢 일치 |
| **V-07** | Kiwi 스키마 sanity | 정의 수 + 두 청크의 압축 알고리즘 라벨 | 🟢 568 defs, schema=deflate-raw, **data=zstd** |
| **V-08** | Export 산출물 | 모든 manifest entry가 disk에 실재 + sha256 일치 | 🟢 1,621 files, 83 MB |

> V-05는 verify.ts 주석에는 정의되어 있으나 `runChecks()`의 호출 목록에서 빠져 있음. 결정성 검증은 외부 round-trip 스크립트(`audit-*`, [`specs/audit-harness.spec.md`](./specs/audit-harness.spec.md))로 위임.

---

## 5. 모듈 매핑 (`src/`)

### 5.1 이 SPEC이 다루는 모듈 (Stage 1~9)

| 파일 | 역할 | LOC |
|---|---|---:|
| `src/cli.ts` | CLI 진입점 + 7-subcommand 디스패처 | 961 |
| `src/container.ts` | Stage 1 — ZIP / raw 자동 분기 | 107 |
| `src/archive.ts` | Stage 2 — fig-kiwi 청크 분해 | 62 |
| `src/decompress.ts` | Stage 3 — deflate-raw / deflate-zlib / zstd 자동 감지 | 67 |
| `src/decoder.ts` | Stage 4 — Kiwi 스키마 + 메시지 디코드 | 85 |
| `src/tree.ts` | Stage 5 — parent-child 트리 재구성 | 90 |
| `src/assets.ts` | Stage 6 — 이미지 참조 매핑 + magic-based 확장자 | 131 |
| `src/vector.ts` | Stage 7 — `commandsBlob` → SVG path 디코더 | 480 |
| `src/normalize.ts` | Stage 8 — REST API 호환 별칭 | 134 |
| `src/export.ts` | Stage 8 — 산출물 disk export | 352 |
| `src/intermediate.ts` | `extracted/.../_info.json` 등 중간 산출물 dumper | 385 |
| `src/verify.ts` | Stage 9 — V-01 ~ V-08 + 보고서 작성 | 339 |
| `src/types.ts` | 공통 타입 정의 | — |

### 5.2 다른 자매 문서가 다루는 모듈 (cross-ref)

| 파일 | 자매 문서 |
|---|---|
| `src/repack.ts` | [`SPEC-repack.md`](./SPEC-repack.md) — byte / kiwi / json 3 모드 |
| `src/pen-export.ts` | [`SPEC-figma-to-pencil.md`](./SPEC-figma-to-pencil.md) — pencil.dev 좌표·ID·variant |
| `src/instanceOverrides.ts`, `src/masterIndex.ts` | [`specs/expansion-context.spec.md`](./specs/expansion-context.spec.md) — INSTANCE expansion |
| `src/effectiveVisibility.ts` | [`CONTEXT.md`](../CONTEXT.md) — 3-mechanism visibility 합성 |
| `src/fractional-index.ts` | [`specs/parent-index-position.spec.md`](./specs/parent-index-position.spec.md) |
| `src/html-export.ts`, `src/html-export-templates.ts` | [`specs/html-dashboard.spec.md`](./specs/html-dashboard.spec.md) |
| `src/editable-html.ts`, `src/editable-html-css.ts` | [`specs/editable-html.spec.md`](./specs/editable-html.spec.md) |
| `src/tokens.ts` | [`specs/tokens.spec.md`](./specs/tokens.spec.md) |

### 5.3 Web editor 모듈 (`web/`)

`web/core/{domain,ports,application}` + `web/server/adapters/{driven,driving/http}` + `web/client/src/`. Clean+Hexagonal layering 상세는 [`SPEC-architecture.md`](./SPEC-architecture.md) 참조.

---

## 6. 의존성

런타임 deps — 단 4개:

| 패키지 | 용도 | 버전 |
|---|---|---|
| `adm-zip` | ZIP 컨테이너 read/write | ^0.5.17 |
| `pako` | deflate / inflate | ^2.1.0 |
| `fzstd` | zstd decompression (decode-only) | ^0.1.1 |
| `kiwi-schema` | Kiwi 직렬화 codec (Evan Wallace) | ^0.5.0 |

> `fig-kiwi@0.0.1` (npm)은 `optionalDependencies`로 설치되지만 런타임에서 사용하지 않는다. 그 패키지는 schema/data 둘 다 `inflateRaw`로 처리하나, **본 프로젝트의 실측에서 data 청크는 zstd**임을 발견함 — 그래서 자체 `decompress.ts`로 자동 분기 구현.

---

## 7. CLI

### 7.1 `extract` (이 문서가 정의하는 서브커맨드)

```bash
# 기본
figma-reverse extract <input.fig> [output-dir]
figma-reverse <input.fig> [output-dir]    # 'extract' 생략 가능 (backwards-compat)

# 권장 (output 사이즈 ~30% 절약)
figma-reverse extract design.fig --no-document --minify

# npm scripts
npm run extract -- design.fig ./out
npm run extract:sample          # docs/메타리치 화면 UI Design.fig
npm run extract:bvp             # docs/bvp.fig
```

| 옵션 | 효과 |
|---|---|
| `--minify` | JSON 들여쓰기 제거 (~30% 감소) |
| `--no-document` | `output/<figName>/document.json` 생략 (페이지 파일과 중복 회피) |
| `--include-raw-message` | `extracted/.../04_decoded/message.json` 포함 (~150 MB) |
| `--no-vector` | 벡터 SVG 추출 skip |
| `--no-intermediate` | `extracted/` 생성 안함 |
| `--extracted-dir <path>` | extracted 위치 변경 (default: `./extracted`) |
| `--verbose` | stage-by-stage 진행 로그 |

### 7.2 다른 6개 서브커맨드 (인덱스만)

| 서브커맨드 | 역할 | 자세히 |
|---|---|---|
| `repack` | `extracted/` → `.fig` 재생성 (byte / kiwi / json 3 모드) | [`SPEC-repack.md`](./SPEC-repack.md) |
| `pen-export` | `.fig` → pencil.dev `.pen` + `.pen.json` (페이지별) | [`SPEC-figma-to-pencil.md`](./SPEC-figma-to-pencil.md) |
| `editable-html` | `.fig` → 단일 HTML(임베디드 `.fig` 포함) | [`specs/editable-html.spec.md`](./specs/editable-html.spec.md) |
| `html-report` | `extracted/` + `output/` → 브라우저 대시보드 | [`specs/html-dashboard.spec.md`](./specs/html-dashboard.spec.md) |
| `round-trip-html` | `extracted/06_report/figma-round-trip.html` 뷰어 | [`SPEC-roundtrip.md`](./SPEC-roundtrip.md) |
| `tokens` | `.fig` → 디자인 토큰 JSON (colors / typography / spacing) | [`specs/tokens.spec.md`](./specs/tokens.spec.md) |

전체 옵션은 각 서브커맨드의 `--help`.

---

## 8. 비기능: 비동기 / 성능

extract 파이프라인은 가능한 한 비동기·non-blocking으로 동작한다. 단일 `.fig` 처리 시간뿐 아니라 다중 `.fig`를 동시 실행할 때의 처리량을 결정짓는 핵심 비기능 요구사항. 본 절의 규칙은 `src/` 전체에 적용되지만, 검증 기준은 extract 파이프라인을 대상으로 한다 (다른 서브커맨드의 성능 SLA는 자매 SPEC 참조).

### 8.1 적용 규칙 (MUST)

| 규칙 | 적용 대상 | 구현 |
|---|---|---|
| **파일 I/O는 async** | `.fig` 읽기, JSON 쓰기, 이미지·벡터 추출 | `fs/promises` (`readFile` / `writeFile`) — `*Sync`는 단일 파일 보장 컨텍스트만 |
| **페이지·이미지·벡터 병렬화** | Stage 7 SVG 추출, Stage 8 page split, asset 저장 | `Promise.all` 로 페이지·리소스 동시 처리 |
| **CPU-heavy 작업의 컨커런시 한계** | Stage 4 kiwi 디코드, Stage 5 트리 빌드 | event-loop block 회피 위해 페이지 단위 split, 필요 시 `worker_threads` |
| **다중 `.fig` 풀-병렬** | `npm run extract:all`, 라운드트립 검증 | `Promise.all` + 파일별 worker. 메모리 압박 시 `os.availableParallelism()`로 cap |
| **블로킹 hash·encode는 stream으로** | manifest sha256, deflate-raw 인코딩 | `crypto.createHash` / `zlib.createDeflateRaw` stream API 우선; 일괄 hash는 < 10 MB |

### 8.2 회피 패턴 (MUST NOT)

- `readFileSync` / `writeFileSync`를 페이지·이미지 루프 안에서 사용
- `await` 없이 Promise 체이닝 후 fire-and-forget — 에러 lost
- 페이지·`.fig` 단위 외 nested `Promise.all` 폭주 — file descriptor 고갈 위험
- `JSON.stringify` 대용량 객체 → main thread block; 대용량은 stream JSON or worker

### 8.3 검증 기준 (extract 파이프라인)

- 단일 `.fig` end-to-end ≤ 1 s (sample 35,660 노드 기준)
- 다중 `.fig` wall-clock ≤ **1.5 N배** (단순 N배 직렬이 아닌 병렬 이득)
- Stage 1~9 어느 단계도 sync I/O loop를 페이지·이미지 단위로 돌리지 않음

---

## 9. 알려진 제약 (extract 파이프라인 한정)

| 제약 | 단계 | 영향 | 대응 |
|---|---|---|---|
| Vector 디코드 best-effort | Stage 7 | sample 1,681 vector 중 82개(≈ 5%)는 `BOOLEAN_OPERATION` 등 합성으로 `fillGeometry` 부재 → SVG 출력 없음 | v1 한계로 명시. `commandsBlob` 디코더 자체는 결정적 (95%는 byte-level identical) |
| 알 수 없는 노드 타입 3종 | Stage 5 | `VARIABLE_SET`(sample 6개), `BRUSH`(25), `CODE_LIBRARY`(1) | 트리에 포함하되 정규화는 raw 보존. JSON으로는 무손실 |
| `--include-raw-message` 시 메모리 ~150 MB | Stage 4 | 큰 fig에서 OOM 가능 | 기본 OFF. 디버그 시에만 활성 |
| Stage 7 fallback offset(0/1) 휴리스틱 | Stage 7 | 새 fig-kiwi 버전이 다른 prefix를 도입할 경우 둘 다 실패 가능 | sample(v106)에서는 0/1 시도로 충분. 위반 시 `vector-decode.spec.md` 갱신 |

**Repack / pen-export / 클라우드 임포트 등 cross-domain 제약**은 자매 SPEC으로 위임:
- `fzstd@0.1.1` decode-only → repack 사이즈 영향: [`SPEC-repack.md`](./SPEC-repack.md)
- `.pen` 매칭 99.6% (5 mismatch): [`SPEC-figma-to-pencil.md`](./SPEC-figma-to-pencil.md) · [`specs/audit-oracle.spec.md`](./specs/audit-oracle.spec.md)
- repack한 `.fig`의 Figma Cloud 임포트 검증: [`SPEC-roundtrip.md`](./SPEC-roundtrip.md)

---

## 10. 빠른 시작

```bash
# 1. 의존성 설치
npm install

# 2. 타입체크
npm run typecheck

# 3. 추출 (sample)
npm run extract:sample
#  → output/메타리치 화면 UI Design/, extracted/메타리치 화면 UI Design/ 생성
#  → verification_report.md PASS 확인

# 4. 임의 파일 추출
npx tsx src/cli.ts extract /path/to/your.fig ./my-output

# 5. 도움말
npx tsx src/cli.ts --help
```

테스트는 `npm test` (CLI) + `cd web && npm test` (Web). 갯수 / 커버리지 현황은 [`README.md`](../README.md) 참조.

---

## 11. 참고

**Project docs**

- [`PRD.md`](./PRD.md) — 원본 요구사항
- [`CONTEXT.md`](../CONTEXT.md) — 도메인 용어 단일 소스
- [`SDD.md`](./SDD.md) — Spec-Driven Development 방법론
- [`HARNESS.md`](./HARNESS.md) — 5-layer 검증 하니스
- [`SPEC-architecture.md`](./SPEC-architecture.md) · [`SPEC-roundtrip.md`](./SPEC-roundtrip.md) · [`SPEC-repack.md`](./SPEC-repack.md) · [`SPEC-figma-to-pencil.md`](./SPEC-figma-to-pencil.md)
- [`adr/`](./adr/) — 0001 pen ID format · 0002 round-trip equality tiers · 0003 rendering strategy · 0004 shared modules
- [`fig-format/figma-fig-format.md`](./fig-format/figma-fig-format.md) — `.fig` byte-level reverse-engineered 노트
- [`dev-guide.html`](./dev-guide.html) — 단일 파일 개발자 가이드 (한·영, 8 mermaid)
- [`specs/`](./specs/) — 60+ 활성 feature spec · [`specs/archive/`](./specs/archive/) — round 2 ~ 18-B 기록

**External**

- Evan Wallace, [Kiwi schema-based binary format](https://github.com/evanw/kiwi)
- Albert Sikkema (2026-01), [Reverse-Engineering Figma Make Files](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html)
- npm, [`fig-kiwi`](https://www.npmjs.com/package/fig-kiwi) — 참고용 (런타임 미사용)
