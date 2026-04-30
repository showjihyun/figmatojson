# SPEC — figma-reverse: `.fig` ⇄ 구조화 데이터 파이프라인

| 항목 | 값 |
|---|---|
| 문서 버전 | v1.1 (성능 개선 반영) |
| 작성일 | 2026-04-29 |
| 대상 PRD | [PRD.md](./PRD.md) |
| 언어/런타임 | TypeScript / Node.js v20+ |
| 상태 | v1 구현 완료 (PRD §6.3 Iteration 0~9 + Repack v2 scope) |

---

## 0. 한눈에 보기

```
┌────────────────┐       ┌─────────────┐       ┌──────────────────┐
│  design.fig    │ ───►  │  파이프라인   │ ───►  │  output/ + extracted/  │
│  (5.77 MB ZIP) │       │  9단계       │       │  (사람이 읽는 JSON +   │
└────────────────┘       └─────────────┘       │   디버그 산출물)       │
                                ▲              └──────────────────┘
                                │
                          ┌─────┴────┐
                          │  repack  │  (역방향: extracted/ → .fig)
                          └──────────┘
```

**한 줄 요약**: Figma의 `.fig` 바이너리를 9단계 파이프라인으로 풀어 무손실 JSON·이미지·SVG로 export하고, 단계별 산출물을 폴더로 남겨 추적·검증·재패키징을 가능하게 한다.

---

## 1. 처리 프로세스 (9 단계)

> **읽는 법**: 각 단계는 `[입력] → 처리 → [출력]` 형식으로 구성. 출력 중 **굵게** 표시된 것이 디스크에 남는 산출물.

### Stage 1️⃣ 컨테이너 분해

> Figma Cloud export `.fig`는 사실 **ZIP 파일**이다. 안의 `canvas.fig`만 진짜 바이너리.

| | |
|---|---|
| **모듈** | `src/container.ts` |
| **입력** | `<input>.fig` 파일 경로 |
| **처리** | 1. 파일 첫 4 byte로 ZIP/raw 자동 분기 (ZIP magic `50 4B 03 04` 또는 fig-kiwi magic `66 69 67 2D 6B 69 77 69`)<br>2. ZIP이면 `adm-zip`으로 entries 순회 → `canvas.fig`, `meta.json`, `thumbnail.png`, `images/<hash>` 분리<br>3. raw fig-kiwi이면 그대로 사용 |
| **출력 (memory)** | `ContainerResult { isZipWrapped, canvasFig, metaJson, thumbnail, images }` |
| **출력 (disk)** | **`extracted/01_container/`** ← (자세한 구조는 §3 참고) |

### Stage 2️⃣ fig-kiwi 아카이브 청크 분해

> `canvas.fig`는 Evan Wallace의 **Kiwi 직렬화 포맷** + 청크 컨테이너. 두 청크(스키마 + 데이터)로 나뉜다.

| | |
|---|---|
| **모듈** | `src/archive.ts` |
| **입력** | `canvas.fig` byte (Stage 1) |
| **처리** | 1. 8 byte `fig-kiwi` magic 검증<br>2. 4 byte LE uint32 → archive version (예: 106)<br>3. 루프: `[4 byte LE size][size bytes data]` → chunks[] 추출 |
| **출력 (memory)** | `FigArchive { prelude, version, chunks[] }` |
| **출력 (disk)** | **`extracted/02_archive/chunks/00_schema.bin`** (압축, 26 KB)<br>**`extracted/02_archive/chunks/01_data.bin`** (압축, 3.81 MB) |

### Stage 3️⃣ 압축 해제 (deflate-raw / zstd 자동 분기)

> 첫 청크는 **deflate-raw**, 두 번째 청크는 **zstd** — 한 파일 안에 다른 알고리즘. 본 프로젝트의 핵심 발견.

| | |
|---|---|
| **모듈** | `src/decompress.ts` |
| **입력** | 두 압축 chunk |
| **처리** | 1. Magic byte 검사로 알고리즘 자동 감지<br>&nbsp;&nbsp;&nbsp;• `28 B5 2F FD` → zstd<br>&nbsp;&nbsp;&nbsp;• `78 xx` → deflate-zlib<br>&nbsp;&nbsp;&nbsp;• 그 외 → deflate-raw<br>2. 감지된 알고리즘으로 시도, 실패 시 다른 알고리즘 fallback |
| **출력 (memory)** | `Uint8Array` × 2 (uncompressed schema + data) |
| **출력 (disk)** | **`extracted/03_decompressed/schema.kiwi.bin`** (64 KB, deflate-raw)<br>**`extracted/03_decompressed/data.kiwi.bin`** (20 MB, **zstd**) |

### Stage 4️⃣ Kiwi 디코드 (스키마 → 메시지)

> 첫 청크는 **스키마 정의 자체**(568개 타입), 두 번째 청크는 그 스키마로 인코딩된 **NodeChanges 메시지**.

| | |
|---|---|
| **모듈** | `src/decoder.ts` |
| **입력** | uncompressed schema + data byte |
| **처리** | 1. `kiwi.decodeBinarySchema(schemaBytes)` → Schema 객체<br>2. `kiwi.compileSchema(schema)` → CompiledSchema (decoder 클래스)<br>3. `compiled.decodeMessage(dataBytes)` → 메시지 객체 (root: `NODE_CHANGES`) |
| **출력 (memory)** | `DecodedFig { schema, message, ... }` |
| **출력 (disk)** | **`extracted/04_decoded/schema.json`** (812 KB, 사람이 읽는 스키마 정의)<br>**`extracted/04_decoded/message.json`** (~150 MB, `--include-raw-message` 시) |

### Stage 5️⃣ 노드 트리 재구성

> 메시지의 `nodeChanges[]`는 평탄한 배열. parent GUID로 **트리 복원** + position 문자열로 **형제 정렬**.

| | |
|---|---|
| **모듈** | `src/tree.ts` |
| **입력** | `message.nodeChanges[]` (35660개) |
| **처리** | 1. 각 노드를 `(sessionID:localID)` 키로 Map에 저장<br>2. 각 노드의 `parentIndex.guid`로 부모 찾고 children에 추가<br>3. `parentIndex.position` 문자열로 형제 정렬 (Figma의 fractional indexing)<br>4. `DOCUMENT` 타입 = root, parent 못 찾은 노드 = orphans |
| **출력 (memory)** | `BuildTreeResult { document, allNodes, orphans }` |
| **출력 (disk)** | **`extracted/05_tree/nodes-flat.json`** (3.6 MB, 평탄 테이블 — grep 가능)<br>**`extracted/05_tree/orphans.json`** (있을 때만) |

### Stage 6️⃣ 이미지 참조 매핑

> 트리 walk → image hash 수집 → ZIP에서 추출한 `images/`와 cross-check.

| | |
|---|---|
| **모듈** | `src/assets.ts` |
| **입력** | 트리 root + Stage 1의 `images` Map |
| **처리** | 1. 모든 노드 데이터 재귀 walk<br>2. `image.hash`, `imageRef`, `hash` 필드에서 SHA-1 해시 수집<br>3. `hash → Set<owner-guid>` 매핑 생성<br>4. magic byte로 이미지 확장자 추론 (PNG/JPG/WebP/GIF/SVG/PDF) |
| **출력 (memory)** | `Map<hash, Set<guid>>` |
| **출력 (disk)** | (이 단계 자체는 디스크 출력 없음, Stage 8에서 `output/assets/images/<hash>.<ext>`로 저장) |

### Stage 7️⃣ 벡터 추출 (best-effort)

> VECTOR 노드의 `fillGeometry[*].commandsBlob` → `message.blobs[]` 인덱스 → byte 디코드 → SVG path.

| | |
|---|---|
| **모듈** | `src/vector.ts` |
| **입력** | 트리 + `message.blobs[]` |
| **처리** | 1. VECTOR/STAR/LINE/ELLIPSE/REGULAR_POLYGON 노드 순회<br>2. fillGeometry/strokeGeometry의 `commandsBlob` → blobs[] 인덱스<br>3. blob byte → path command 디코드:<br>&nbsp;&nbsp;&nbsp;• `0x01` MOVE_TO + 2×float32<br>&nbsp;&nbsp;&nbsp;• `0x02` LINE_TO + 2×float32<br>&nbsp;&nbsp;&nbsp;• `0x03` CUBIC + 6×float32<br>&nbsp;&nbsp;&nbsp;• `0x04` QUAD + 4×float32<br>&nbsp;&nbsp;&nbsp;• `0x05` CLOSE<br>4. 두 시작 offset(0, 1) 시도하고 더 많은 명령을 디코드한 쪽 채택<br>5. fill/stroke 색상까지 SVG에 반영 |
| **출력 (disk)** | **`output/assets/vectors/<node-id>.svg`** × 1599 (95% 성공률) |

### Stage 8️⃣ 정규화 + Export

> Kiwi 원본 키 보존 + REST API 호환 별칭 추가, 페이지별로 분리.

| | |
|---|---|
| **모듈** | `src/normalize.ts`, `src/export.ts` |
| **입력** | 트리 + 이미지 refs + 디코드 결과 |
| **처리** | 1. 트리 노드를 `NormalizedNode`로 변환:<br>&nbsp;&nbsp;&nbsp;• `id` (S:L 문자열), `parentId` 추가<br>&nbsp;&nbsp;&nbsp;• `fillPaints` → `fills` 별칭<br>&nbsp;&nbsp;&nbsp;• `strokePaints` → `strokes` 별칭<br>&nbsp;&nbsp;&nbsp;• `size + transform` → `absoluteBoundingBox`<br>&nbsp;&nbsp;&nbsp;• `Uint8Array` → hex 문자열, `BigInt` → 문자열<br>2. CANVAS 노드별로 페이지 분리<br>3. 이미지 magic 추론 후 disk 저장<br>4. SHA-256 manifest 생성 |
| **출력 (disk)** | `output/document.json` (전체 트리, `--no-document` 시 생략)<br>**`output/pages/<idx>_<name>.json`** × 6<br>**`output/assets/images/<hash>.<ext>`** × 12<br>**`output/assets/vectors/<id>.svg`** × 1599<br>**`output/assets/thumbnail.png`**<br>**`output/schema.json`** (812 KB)<br>**`output/metadata.json`**<br>**`output/manifest.json`** (모든 산출물 인덱스 + sha256) |

### Stage 9️⃣ 검증 보고서

> 자동 V-01~V-08 체크 + 통계 + Markdown 보고서.

| | |
|---|---|
| **모듈** | `src/verify.ts` |
| **입력** | 모든 단계 결과 |
| **처리** | V-01 입력 무결성 (canvas.fig magic 재확인)<br>V-02 디코딩 round-trip (schema re-encode byte 비교)<br>V-03 트리 일관성 (parent 존재, 사이클 없음)<br>V-04 에셋 일관성 (imageRef ↔ images/ cross-check)<br>V-06 meta.json 일치<br>V-07 Kiwi 스키마 sanity (정의 수 + 압축 알고리즘)<br>V-08 Export 산출물 검증 |
| **출력 (disk)** | **`output/verification_report.md`** |

---

## 2. 역방향 파이프라인: Repack

> `extracted/` → `.fig` 재생성. PRD §2.2의 v1 비목표였으나 v2 scope 확장.

```
                    ┌──────────────┐
extracted/01_container/  ───►  │  byte mode   │  ─── 1:1 ZIP STORE  ───►  out.fig
                    └──────────────┘
                           OR
extracted/03_decompressed/  ───►  ┌──────────────┐
                            │  kiwi mode   │  ─── re-encode + deflate-raw + ZIP ──►  out.fig
                            └──────────────┘
```

| 모드 | 모듈 | 처리 | 결과 사이즈 | canvas.fig 동등성 |
|---|---|---|---|---|
| **byte** | `src/repack.ts::repackByteLevel` | extracted/01_container/의 raw 파일을 ZIP STORE로 묶기 | 5.77 MB (원본 ≈) | 🟢 byte-identical |
| **kiwi** | `src/repack.ts::repackKiwi` | 03_decompressed/의 schema+data를 kiwi 재인코드 → deflate-raw 압축 → fig-kiwi archive 작성 → ZIP | 6.82 MB (+18%) | 🔴 (의미는 동등) |

**자동 round-trip 검증**: 두 모드 모두 결과 .fig를 즉시 우리 자신의 파서로 다시 추출하여 nodes/schema/version 일치 확인.

---

## 3. 출력 디렉토리 구조 (실측 결과)

### 3.1 `output/` — 사용자 소비용 (87 MB)

> 사람이 읽고 검색하기 좋은 형태. REST API와 호환되는 별칭 포함.

```
output/
├── pages/                                      # 페이지별 트리 (CANVAS 단위 분리)
│   ├── 00_design setting.json       2.5 MB
│   ├── 01_Internal Only Canvas.json   258 KB
│   ├── 02_WEB.json                   67.5 MB
│   ├── 03_MOBILE.json                3.6 MB
│   ├── 04_dash board.json            2.4 MB
│   └── 05_icons.json                 1.4 MB
├── assets/
│   ├── images/                                 # SHA-1 해시 파일명 + magic 기반 확장자
│   │   ├── 01953550...256875bb6b.png   8.7 KB
│   │   ├── 0f14a2f9...3977d529.png    20.2 KB
│   │   ├── 37999f9a...eb35c569.png    35.7 KB
│   │   ├── ... (총 12개 PNG)
│   │   └── ce4146cf...62e7736dd.png    1.5 MB
│   ├── vectors/                                # commandsBlob → SVG path
│   │   └── <node-id>.svg × 1,599
│   └── thumbnail.png                           17.7 KB
├── schema.json                                 # Kiwi 스키마 정의 568개  (812 KB)
├── metadata.json                               # meta.json + 추출 통계 (1 KB)
├── manifest.json                               # 모든 산출물 인덱스 + SHA-256 (204 KB)
└── verification_report.md                      # V-01~V-08 검증 보고서 (120 KB)
```

> `document.json` (전체 트리 단일 파일)은 `--no-document` 시 생략. 위 결과는 `--no-document --minify`로 생성.

### 3.2 `extracted/<figName>/` — 디버그·재패키징용 (34 MB)

> 파이프라인 각 단계의 breadcrumb. 각 `.fig` 파일은 자기 이름의 디렉토리를 가진다 (충돌 회피). 각 폴더에 `_info.json` 메타파일.

```
extracted/
└── <figName>/                                  # 예: "메타리치 화면 UI Design"
    ├── 01_container/                           # Stage 1 결과
    │   ├── canvas.fig                  3.74 MB # ZIP 내부의 fig-kiwi 바이너리
    │   ├── meta.json                   341 B   # file_name, background_color 등
    │   ├── thumbnail.png               17.7 KB
    │   ├── images/                             # 해시 파일명, 확장자 없음 (raw)
    │   └── _info.json                          # sha256, byteLength, magic byte 등
    │
    ├── 02_archive/                             # Stage 2 결과 (압축 상태)
    │   ├── chunks/
    │   │   ├── 00_schema.bin           26 KB   # firstBytes: b5 bd 09 98...
    │   │   └── 01_data.bin             3.72 MB # firstBytes: 28 b5 2f fd... (zstd)
    │   └── _info.json                          # version=106, chunkCount=2
    │
    ├── 03_decompressed/                        # Stage 3 결과 (압축 해제)
    │   ├── schema.kiwi.bin             64 KB   # Kiwi schema 바이너리
    │   ├── data.kiwi.bin               20 MB   # NodeChanges 메시지 바이너리
    │   └── _info.json                          # 압축 알고리즘 (deflate-raw / zstd)
    │
    ├── 04_decoded/                             # Stage 4 결과 (JSON)
    │   ├── schema.json                 812 KB  # 568개 type 정의를 JSON으로
    │   └── _info.json                          # rootMessageType, nodeChangesCount=35660
    │   # message.json (~150 MB)은 --include-raw-message 시에만 생성
    │
    └── 05_tree/                                # Stage 5 결과
        ├── nodes-flat.json             3.6 MB  # 평탄 테이블 (id, type, name, parentId, childCount)
        └── _info.json                          # totalNodes=35660, pageCount=6, typeDistribution
```

`<figName>`은 입력 `.fig`의 basename에서 `.fig` 확장자 제거한 문자열 (한글·공백 OK).

### 3.3 `extracted/*/_info.json` 예시

각 단계의 `_info.json`은 그 단계에서 무슨 일이 일어났는지 기록. 예 (`02_archive/_info.json`):

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

## 4. 모듈 구조 (`src/`)

```
src/
├── cli.ts              CLI 진입점 + 서브커맨드 디스패처 (extract / repack)
├── container.ts        Stage 1: ZIP / raw 자동 분기
├── archive.ts          Stage 2: fig-kiwi 청크 분해
├── decompress.ts       Stage 3: deflate-raw / deflate-zlib / zstd 자동 감지
├── decoder.ts          Stage 4: Kiwi 스키마 + 메시지 디코드
├── tree.ts             Stage 5: parent-child 트리 재구성
├── assets.ts           Stage 6: 이미지 참조 매핑 + magic-based 확장자
├── normalize.ts        Stage 8: REST API 호환 별칭
├── vector.ts           Stage 7: commandsBlob → SVG path 디코더
├── export.ts           Stage 8: 산출물 export (output/)
├── intermediate.ts     중간 산출물 dumper (extracted/*/_info.json 포함)
├── verify.ts           Stage 9: V-01~V-08 검증 + report
├── repack.ts           역방향 파이프라인 (byte / kiwi 모드)
└── types.ts            공통 타입 정의
```

### 4.1 의존성

| 패키지 | 용도 | 버전 |
|---|---|---|
| `adm-zip` | ZIP 컨테이너 read/write | 0.5.17 |
| `pako` | deflate / inflate | 2.1.0 |
| `fzstd` | zstd decompression (decode-only) | 0.1.1 |
| `kiwi-schema` | Kiwi 직렬화 codec (Evan Wallace) | 0.5.0 |
| `tsx`, `typescript` | dev | latest |

> `fig-kiwi@0.0.1` (npm)은 optional dependency로 설치되었지만 런타임에서 사용하지 않는다 (참고용). 그 패키지는 schema/data 둘 다 `inflateRaw`로 처리하나, **본 프로젝트의 실측에서 data 청크는 zstd**임을 발견함 — 그래서 자체 `decompress.ts`로 자동 분기 구현.

---

## 5. CLI 사용법

### 5.1 추출 (extract)

```bash
# 기본
figma-reverse extract <input.fig> [output-dir]
figma-reverse <input.fig> [output-dir]    # 'extract' 생략 가능

# 실용 권장 (output 사이즈 90% 절약)
figma-reverse extract design.fig --no-document --minify

# npm scripts
npm run extract -- design.fig ./out
npm run extract:sample          # docs/메타리치 화면 UI Design.fig 추출
```

| 옵션 | 효과 |
|---|---|
| `--minify` | JSON 들여쓰기 제거 (~30% 감소) |
| `--no-document` | `output/document.json` 생략 (페이지 파일과 중복 회피) |
| `--include-raw-message` | `extracted/04_decoded/message.json` 포함 (~150 MB) |
| `--no-vector` | 벡터 SVG 추출 skip |
| `--no-intermediate` | `extracted/` 생성 안함 |
| `--extracted-dir <path>` | extracted 위치 변경 (default: `./extracted`) |

### 5.2 재패키징 (repack)

```bash
# (a) byte mode — 안전 (canvas.fig 1:1 보존)
figma-reverse repack ./extracted ./out.fig

# (b) kiwi mode — binary roundtrip (decode→encode, deflate-raw 압축)
figma-reverse repack ./extracted ./out.fig --mode kiwi

# (c) json mode — extracted/04_decoded/message.json 편집 후 재인코드
#   (extract 시 --include-raw-message 필요)
figma-reverse repack ./extracted ./out.fig --mode json

# 원본과 자동 비교
figma-reverse repack ./extracted ./out.fig --original docs/design.fig
```

JSON 라운드트립(`message.json` ⇄ `.fig`)은 무손실:
- `Uint8Array` → `{__bytes: "base64..."}`
- `bigint` → `{__bigint: "123"}`
- `NaN`/`Infinity` → `{__num: "NaN"|"Infinity"|"-Infinity"}` (JSON에서 손실되는 값들)

자세한 검토: [docs/JSON_TO_FIG_FEASIBILITY.md](JSON_TO_FIG_FEASIBILITY.md)

---

## 6. 검증 (V-01 ~ V-08)

| ID | 항목 | 결과 (sample 기준) |
|---|---|---|
| V-01 | canvas.fig magic 재확인 | 🟢 `fig-kiwi` (✓), 3,924,602 bytes |
| V-02 | 스키마 round-trip | 🟢 byte-level identical (64,341 bytes) |
| V-03 | 트리 일관성 (parent 존재, 사이클 없음) | 🟢 35,660 nodes, orphans=0, cycles=0 |
| V-04 | 에셋 일관성 (imageRef ↔ images/) | 🟢 12/12 일치, missing=0, unused=0 |
| V-06 | meta.json 일치 | 🟢 file_name, background_color 일치 |
| V-07 | Kiwi 스키마 sanity | 🟢 568 defs, schema=deflate-raw, **data=zstd** |
| V-08 | Export 산출물 | 🟢 1,621 files, 83 MB |

---

## 7. PRD 가설 검증 결과

| PRD §6.3 가설 | 결과 |
|---|---|
| #1 ZIP 컨테이너 외부 래핑 | ✅ ZIP STORE 확인 |
| #2 8B magic + 4B LE version + chunks | ✅ archive v106 |
| #3 Schema chunk 디코드 (~534 type) | ✅ 568개 (가설보다 많음 — 최신 스키마) |
| #4 Data chunk = NodeChanges | ✅ rootType=NODE_CHANGES 확인 |
| #5 parent ID 트리 빌드 | ✅ 35660 노드, orphan 0 |
| #6 이미지 ↔ imageRef 매핑 | ✅ 12/12 모두 매칭 |
| #7 REST API 호환 정규화 | ✅ fills/strokes/absoluteBoundingBox 별칭 |
| #8 commandsBlob → SVG | ✅ 1599/1681 (95%) |
| #9 G1~G6 검증 | ✅ V-01~V-08 모두 PASS |

> **추가 발견**: PRD §1.2.3에서 추정만 했던 "이중 압축 (deflate + zstd)"가 실증됨. fig-kiwi npm 패키지가 가정하는 단일 deflate-raw와 다름 — 본 프로젝트의 자동 감지 로직이 결정적.

---

## 7.5 성능 / 비동기 처리 원칙

본 파이프라인은 가능한 한 비동기·non-blocking으로 동작해야 한다. 단일 `.fig` 파일 처리 시간뿐 아니라 다중 `.fig`/페이지/검증 작업을 동시 실행할 때의 처리량을 결정짓는 핵심 비기능 요구사항.

### 7.5.1 적용 규칙 (MUST)

| 규칙 | 적용 대상 | 구현 방법 |
|---|---|---|
| **파일 I/O는 async** | `.fig` 읽기, `.pen.json`/`.json` 쓰기, 이미지 추출 | `fs/promises` (`readFile` / `writeFile`) — `*Sync`는 단일 파일 보장 컨텍스트만 |
| **페이지·이미지·벡터는 병렬화** | pen-export 페이지 변환, vector SVG 추출, asset 배치 | `Promise.all` 로 페이지/리소스를 동시 처리 |
| **CPU-heavy 작업의 컨커런시 한계** | kiwi 디코드, 트리 빌드 등 단일 페이지 내부 | event-loop block을 피하기 위해 페이지 단위로 split하고, 필요 시 `worker_threads` 도입 |
| **다중 `.fig` / 다중 검증은 풀-병렬** | `npm run extract:all`, 매칭 비교, round-trip 검증 | Promise.all + 파일별 worker. 단, 메모리 압박 시 concurrency cap (예: `os.availableParallelism()`) |
| **블로킹 hash·encode는 stream으로 분할** | sha256, deflate-raw 인코딩 | `crypto.createHash`/`zlib.createDeflateRaw` 의 stream API 우선, 한 번에 전체 버퍼 hash는 < 10MB 때만 |

### 7.5.2 회피 패턴 (MUST NOT)

- `readFileSync`/`writeFileSync`를 페이지·이미지 루프 안에서 사용 (한 번에 하나만 처리됨)
- `await` 없이 Promise 체이닝 후 fire-and-forget — 에러 lost
- 페이지·.fig 단위 외 nested Promise.all 폭주 — file descriptor 고갈 위험
- `JSON.stringify` 대용량 객체 → main thread block; 대용량은 stream JSON or worker

### 7.5.3 매칭/비교 (`.pen` ↔ reference) 병렬 처리

`_tmp_pen_diff.cjs` 등 매칭 스크립트는 다음 원칙을 따른다:

```
COMPARISONS.map(comp => compareAsync(comp))  // Promise.all 로 병렬 실행
  ↓
각 comp 내부:
  await Promise.all([readFile(ref), readFile(ours)])  // 두 파일 동시 읽기
  ↓
  buildMap → diff (CPU; 페이지당 < 50ms 이내라 worker 불필요)
```

### 7.5.4 검증 기준

- pen-export 4페이지 동시 변환 시 `Promise.all` 병렬 실행 (서로 독립)
- 매칭 비교는 페이지 수만큼 병렬 (현재 단일 페이지지만 향후 6페이지 모두 비교 시 병렬)
- 단일 `.fig` end-to-end 시간 ≤ 1초 (35660 노드 기준), 다중 `.fig` 시 wall-clock 시간이 최대 N배가 아니라 1.5N배 미만

---

## 8. 알려진 제약

| 제약 | 영향 | 대응 |
|---|---|---|
| `fzstd@0.1.1`이 decode-only | repack kiwi 모드는 deflate-raw로 통일 (사이즈 +18%) | zstd encoder 추가 가능 (`@bokuweb/zstd-wasm` 등) |
| Vector 디코드 95% 성공 | 82개 노드는 fillGeometry 없이 BOOLEAN_OPERATION 등 합성 | v1 best-effort |
| Figma 클라우드 임포트 미검증 | repack한 .fig를 Figma가 받아주는지 미확인 | 사용자 임포트 시도 후 결과 공유 |
| 알 수 없는 노드 타입 3종 | `VARIABLE_SET`(6), `BRUSH`(25), `CODE_LIBRARY`(1) | 데이터는 raw 보존, 트리에는 포함 |
| `.pen` 매칭 99.6% (1397 중 5 mismatch) | (a) 1개 Button INSTANCE의 `fit_content(48)` trigger 미식별, (b) 1개 Vector path scaling 차이, (c) breadscrum frame의 master 표현 차이 | 모두 데이터로 식별 가능한 차이가 없거나 매우 specific한 edge case. 운영 영향 미미 → 후속 PR로 보류 |

---

## 9. 빠른 시작 체크리스트

```bash
# 1. 의존성 설치
npm install

# 2. 타입체크
npm run typecheck

# 3. 추출 (sample)
npm run extract:sample
#  → output/ + extracted/ 생성, verification_report.md PASS 확인

# 4. 임의 파일 추출
npx tsx src/cli.ts extract /path/to/your.fig ./my-output

# 5. 재패키징 (byte mode)
npx tsx src/cli.ts repack ./extracted ./repacked.fig
#  → 자동 round-trip 검증 (35660 노드 / 568 defs / v106 일치)

# 6. 도움말
npx tsx src/cli.ts --help
```

---

## 10. 참고

- [PRD.md](./PRD.md) — 원본 요구사항
- Evan Wallace, [Kiwi schema-based binary format](https://github.com/evanw/kiwi)
- Albert Sikkema (2026-01), [Reverse-Engineering Figma Make Files](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html)
- npm, [`fig-kiwi`](https://www.npmjs.com/package/fig-kiwi) — 참고용 (런타임 미사용)
