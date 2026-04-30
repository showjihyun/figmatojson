# PRD — `.fig` 파일 역공학 → 구조화 Export 파이프라인

| 항목 | 값 |
|---|---|
| 문서 버전 | **v0.2** (실측 분석 반영) |
| 작성일 | 2026-04-29 |
| 작성자 | Choi Ji + Claude (Planner/Executor/Verifier 협업) |
| 대상 파일 | `메타리치_화면_UI_Design.fig` (6,053,077 bytes) |
| 참조 디자인 | [메타리치 화면 UI Design (Figma Cloud)](https://www.figma.com/design/tsEhxJWbbZOLHzKPJ2Djxk/...) |
| 상태 | Draft → 사용자 승인 후 Plan-Execute-Verify 루프 착수 |

---

## 1. 배경 (Background)

### 1.1 문제 정의

Figma의 `.fig` 파일은 **공식 명세가 없는 내부 바이너리 포맷**이다. 공개 REST API는 별도 파일 키와 토큰을 요구하고, Dev Mode·Variables 등 일부 데이터는 유료 플랜에 종속된다. 따라서 **로컬 `.fig` 파일을 단독으로 구조화된 데이터로 변환할 수 있는 무손실 파이프라인**의 가치가 크다 — 백업/아카이빙, 디자인 토큰 자동 추출, RAG·LLM 입력, 타 도구 마이그레이션, 디자인 시스템 거버넌스 등.

### 1.2 실측 분석 결과 (2026-04-29 수행, 사전 Reconnaissance)

본 PRD는 **첨부된 실파일에 대한 바이너리 검사로 검증된 사실**을 토대로 한다.

#### 1.2.1 외부 컨테이너 레이어

```
$ file 메타리치_화면_UI_Design.fig
→ Zip archive data, at least v2.0 to extract, compression method=store

$ unzip -l 메타리치_화면_UI_Design.fig
  3,924,602  canvas.fig
     18,122  thumbnail.png
        340  meta.json
  (images/  13개 PNG, 총 ~2.1 MB)
```

이 형태는 **공개된 모든 기존 `.fig` 파서(Evan Wallace, Grida, fig-kiwi npm)가 가정하는 단일 바이너리 포맷이 아니다**. Albert Sikkema(2026-01)가 분석한 Figma Make `.make` 파일 컨테이너 구조와 동일하다. 즉 **Figma Cloud에서 다운로드한 최신 export 형식은 ZIP 래핑된 .fig일 가능성이 높다.** ← **이 부분이 본 프로젝트에서 신규 역공학이 필요한 첫 번째 지점**.

#### 1.2.2 `meta.json` (clear-text JSON, 340 B)

```json
{
  "client_meta": {
    "background_color": { "r": 0.0689, "g": 0.0465, "b": 0.0465, "a": 1 },
    "thumbnail_size":   { "width": 399, "height": 400 },
    "render_coordinates": { "x": 213, "y": -273, "width": 3090, "height": 3100 }
  },
  "file_name": "메타리치 화면 UI Design",
  "developer_related_links": [],
  "exported_at": "2026-04-20T02:33:06.552Z"
}
```

#### 1.2.3 내부 `canvas.fig` (3.92 MB, 실제 Kiwi 바이너리)

```
첫 32 bytes (hex):
6669 672d 6b69 7769  6a00 0000 a665 0000  b5bd 0998 6457 5930  7cce bdb7 969e 9e3d
└── fig-kiwi ──┘    └ length? ┘ └ ?    ─ 압축 데이터 ─ ...
```

- Magic header `fig-kiwi` 확인 → **Design 타입 표준 포맷** (FigJam: `fig-jam.`, Slides: `fig-deck`, Make: `fig-makee`와 구분)
- 8바이트 매직 이후 이중 청크 구조(스키마 청크 + 데이터 청크) 추정. **각 청크의 정확한 length prefix 형식·압축 알고리즘(deflate vs zstd)은 실측 단계에서 확정**.

#### 1.2.4 `images/` 디렉토리

13개 파일, 파일명은 SHA-1 해시(40 hex), 확장자 없음. 첫 8바이트 magic 검사 결과 **모두 PNG**(`89 50 4E 47 0D 0A 1A 0A`). 향후 JPEG/WebP/GIF 혼재 가능성 있으므로 magic 기반 확장자 추론 로직 필요.

### 1.3 본 프로젝트의 역공학 범위

**이미 알려진 것** (선행 연구 활용):
- Kiwi 바이너리 직렬화 알고리즘 (Evan Wallace 공개)
- Chunk 구조 + 이중 압축(deflate + zstd) 일반론 (easylogic, albertsikkema)
- 공개된 reference 파서가 처리할 수 있는 일부 RootType (`NodeChanges` 등)

**본 프로젝트에서 새로 검증·역공학해야 할 것**:
1. ⚠ **ZIP 컨테이너 외부 래핑** — 공개 파서들이 단일 바이너리만 처리하는 한계 보완
2. ⚠ **현재 시점(2026-04)의 Figma 스키마 타입 분포** — Figma는 스키마를 무예고 변경. 첨부 파일에서 추출한 schema chunk를 기준으로 삼아야 함
3. ⚠ **canvas.fig 헤더 직후 length prefix 형식** — 8바이트 매직 이후 4바이트 LE uint32가 첫 청크 길이인지 / 다른 형식인지 실측 검증
4. ⚠ **이미지 해시 ↔ 노드 reference 매핑** — `imageRef`(SHA-1 hash 등) 필드가 노드 트리의 어느 위치에서 등장하는지
5. ⚠ **VectorNetwork blob → SVG path 변환** — `commandsBlob` / `vectorNetworkBlob` 디코딩
6. ⚠ **컴포넌트/인스턴스/Variants 관계 모델** — REST API에는 있지만 .fig 내부 표현은 다를 수 있음

---

## 2. 목표와 비목표

### 2.1 목표 (Goals)

| # | 목표 | 측정 지표 (성공 기준) |
|---|---|---|
| G1 | **무손실에 가까운** 노드 트리 추출 | Figma 클라이언트가 표시하는 페이지·프레임·노드 개수와 ±1% 이내 일치 |
| G2 | 출력이 **사람이 읽을 수 있는 구조** | 단일 JSON으로 grep 가능, 페이지별 분리 파일 제공 |
| G3 | **에셋 무손실 추출** | 13개 이미지 모두 정상 파일로 추출 + 노드 ID 역참조 가능 |
| G4 | **Figma REST API 응답 스키마와 호환적인** 출력 | 가능한 필드는 동일 명명 사용 (`children`, `fills`, `absoluteBoundingBox` 등) |
| G5 | **재현 가능 + 검증 가능** 파이프라인 | 동일 입력 → 동일 출력. 검증 보고서 자동 생성 |
| G6 | **참조 Figma URL과 동일한 정보 표현** | meta.json의 file_name·background_color·render_coordinates가 클라우드 디자인과 일치 |

### 2.2 비목표 (Non-Goals, v1)

- ❌ `.fig` write-back (수정·재패키징) — 읽기 전용
- ❌ FigJam / Slides / Make 파일 지원 (v2)
- ❌ Figma 클라우드 URL에서 직접 fetch (사용자가 파일 제공)
- ❌ 디자인 → HTML/React 코드 자동 생성 (별도 프로젝트)
- ❌ 그라디언트·블러·복합 이펙트의 정밀 CSS 변환 (best-effort만)
- ❌ 실시간 WebSocket 프로토콜 디코딩

---

## 3. 사용자 및 사용 시나리오

**Primary**: Choi Ji — 한국 공공/엔터프라이즈 AI 시스템 개발자, KAHIS·HPAI·디자인 시스템 자동화 컨텍스트.

**대표 시나리오 3종**:

1. **아카이빙**: Figma 구독 만료·서비스 변경에 대비한 정기 백업 (cron으로 .fig 다운로드 → JSON+에셋 변환 → S3 업로드)
2. **디자인 토큰 자동 추출**: `document.json`에서 색상·타이포·간격 토큰을 정규식·AST로 추출해 `tokens.json` 생성, Storybook·Tailwind config로 동기화
3. **RAG 입력**: 디자인 노드 트리를 Korean re-ranker + bge-m3로 임베딩, 디자이너용 의미 검색 시스템 구축

---

## 4. 기능 요구사항

### 4.1 입력

- **F-IN-01** ZIP-wrapped `.fig` (현재 첨부 파일 형식) — **필수 v1**
- **F-IN-02** Raw `fig-kiwi` 바이너리 (Evan Wallace tool 호환 형식) — **필수 v1** (헤더 sniff로 자동 분기)
- **F-IN-03** 입력 파일 무결성 검사 (CRC, ZIP 구조 검증, magic header 검증)

### 4.2 처리 단계

- **F-PROC-01** 컨테이너 레이어 분리 (ZIP → canvas.fig + meta.json + assets)
- **F-PROC-02** Kiwi schema chunk 추출 + decompression(deflate/zstd auto-detect)
- **F-PROC-03** Schema decode → 타입 정의 테이블 생성 (`schema.json`으로 별도 export)
- **F-PROC-04** Data chunk decompression + Kiwi-decode (root type: `NodeChanges`)
- **F-PROC-05** Node tree 재구성 (parent-child 링크 복원, GUID 정규화)
- **F-PROC-06** 페이지 분리 (Canvas 노드 단위)
- **F-PROC-07** 이미지 해시 ↔ `imageRef` 매핑 + magic 기반 확장자 추론
- **F-PROC-08** VectorNetwork blob → SVG path 변환 (best-effort)
- **F-PROC-09** REST API 호환 정규화 (필드명 매핑)

### 4.3 출력 (`output/` 디렉토리)

```
output/
├── document.json          # 전체 노드 트리 (REST API 호환 구조)
├── pages/
│   ├── 0_<page-name>.json
│   └── ...
├── assets/
│   ├── images/
│   │   ├── <hash>.png       # 확장자 추론 적용
│   │   └── ...
│   ├── vectors/
│   │   └── <node-id>.svg
│   └── thumbnail.png
├── schema.json            # 추출된 Kiwi schema (역공학 산출물)
├── metadata.json          # meta.json + 추가 추출 메타
├── manifest.json          # 모든 산출물 인덱스 + SHA-256 체크섬
└── verification_report.md # 검증 결과 (4단계 Plan-Execute-Verify의 V 산출물)
```

### 4.4 비기능 요구사항

| ID | 항목 | 기준 |
|---|---|---|
| NF-01 | 처리 시간 | 6 MB 파일 기준 < 30초 (단일 스레드, M-class CPU) |
| NF-02 | 메모리 사용량 | 입력 파일 크기 × 5 이하 |
| NF-03 | 결정성 | 동일 입력 → 동일 출력 (타임스탬프 필드 제외) |
| NF-04 | 의존성 | Node.js v20+, npm 패키지만 사용 (네이티브 빌드 회피) |
| NF-05 | 안정성 | Figma 스키마 변경 시 graceful degradation — 알 수 없는 타입은 raw bytes로 보존하고 경고 로그 |

---

## 5. 기술 아키텍처

```
┌─────────────────┐
│  .fig (ZIP)     │
└────────┬────────┘
         │ unzip
         ▼
┌─────────────────────────────────────────────────────┐
│  canvas.fig (fig-kiwi)  +  meta.json  +  images/    │
└────────┬────────────────────────────────────────────┘
         │ parseHeader() → chunks[]
         ▼
┌─────────────────┐     ┌─────────────────┐
│ Schema Chunk    │     │ Data Chunk      │
│ (deflate)       │     │ (deflate or zstd)│
└────────┬────────┘     └────────┬────────┘
         │                       │
   pako.inflate              auto-detect
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│ Kiwi Schema     │────▶│ Kiwi Decoder    │
│ (~534 types)    │     │ (NodeChanges)   │
└─────────────────┘     └────────┬────────┘
                                 │
                                 ▼
                       ┌─────────────────┐
                       │  Raw Node Array  │
                       └────────┬────────┘
                                │ tree-builder
                                ▼
                       ┌─────────────────┐
                       │  Node Tree (DAG) │
                       └────────┬────────┘
                                │ normalize + map assets
                                ▼
                       ┌─────────────────┐
                       │  output/*.json   │
                       │  output/assets/  │
                       └─────────────────┘
```

### 5.1 핵심 의존성

| 패키지 | 용도 | 주의 |
|---|---|---|
| `adm-zip` | ZIP 컨테이너 unwrap | streaming 불필요 (파일 작음) |
| `pako` | deflate/zlib 압축 해제 | inflate**Raw** 사용 (header 없는 경우) |
| `fzstd` | Zstandard 압축 해제 | magic `28 B5 2F FD` 감지 시 |
| `kiwi-schema` | Kiwi 디코더 자동 생성 | schema.json → decoder.js |
| `fig-kiwi` (옵션) | 레퍼런스 비교용 | 결과 검증에만 |

### 5.2 모듈 구조

```
src/
├── container.ts        # ZIP 분해 / 단일 바이너리 자동 분기
├── header.ts           # magic + chunk length parsing
├── decompress.ts       # deflate/zstd auto-detect
├── kiwi.ts             # schema parser + decoder factory
├── tree.ts             # raw nodes → parent-child tree
├── normalize.ts        # REST API 호환 필드 매핑
├── assets.ts           # imageRef → hash 매핑, magic-based ext
├── vector.ts           # commandsBlob → SVG path
├── verify.ts           # 검증 로직 (G1~G6 측정)
└── cli.ts              # 진입점
```

---

## 6. Plan-Execute-Verify 루프 (Sub-Agent 기반 진행 방식)

본 프로젝트는 **3-페르소나 루프**로 진행한다. 각 단계의 산출물은 `plans/`, `logs/`, `output/`에 파일로 남겨, 다음 페르소나가 그 파일만 읽어도 컨텍스트를 복원할 수 있게 한다 — 이렇게 해야 Claude Code의 진짜 Sub-Agent로 마이그레이션할 때 그대로 재사용 가능하다.

### 6.1 페르소나 정의

| 페르소나 | 역할 | 산출물 |
|---|---|---|
| 🧭 **Planner** | 다음 작업 단위(Task)를 정의·분해, 가설을 명시 | `plans/<n>_<topic>.md` |
| 🔧 **Executor** | Plan에 따라 코드 작성·실행, 결과 기록 | `src/*`, `output/*`, `logs/<n>_run.log` |
| ✅ **Verifier** | Executor 산출물을 독립 검증, 가설 채택/기각 | `logs/<n>_verify.md` |

### 6.2 루프 사이클

```
┌──────────────────────────────────────────────────────────┐
│  Iteration N                                             │
│                                                          │
│  Planner ──▶ plans/N_*.md                                │
│      │                                                   │
│      ▼                                                   │
│  Executor ──▶ src/*, output/*, logs/N_run.log            │
│      │                                                   │
│      ▼                                                   │
│  Verifier ──▶ logs/N_verify.md (PASS / FAIL / PIVOT)     │
│      │                                                   │
│      ▼                                                   │
│  ┌──────────────┐    ┌──────────────┐    ┌────────────┐ │
│  │ PASS         │    │ FAIL         │    │ PIVOT      │ │
│  │ → 다음 단계   │    │ → 동일 단계   │    │ → 가설 수정 │ │
│  │              │    │   재실행      │    │   후 재계획 │ │
│  └──────────────┘    └──────────────┘    └────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### 6.3 Iteration 로드맵

| # | 주제 | 핵심 가설 / 검증 질문 | 성공 기준 |
|---|---|---|---|
| **0** | 환경 셋업 + 의존성 | Node.js v20+, npm 패키지 설치 가능 | `npm install` 무에러 |
| **1** | ZIP 컨테이너 분해 | 첨부 파일은 ZIP, 내부에 canvas.fig 존재 | `extracted/canvas.fig` 생성, magic = `fig-kiwi` ✅ (이미 검증됨) |
| **2** | canvas.fig chunk 분해 | 8B magic + (4B LE length + chunk bytes)×N 구조 | chunk 2개 추출, 각 chunk magic이 zlib(`78 9C`) 또는 zstd(`28 B5 2F FD`) |
| **3** | Schema chunk decode | Chunk1 = Kiwi 스키마 정의 (~534 type) | `schema.json` 생성, type 개수 출력 |
| **4** | Data chunk decode | Chunk2를 schema로 디코딩 시 NodeChanges 트리 획득 | `raw_nodes.json` 생성, root type 식별 |
| **5** | Node tree 재구성 | parent ID 기반 트리 빌드 가능 | DOCUMENT → CANVAS(페이지) → ... 계층 확인 |
| **6** | 이미지 ↔ imageRef 매핑 | 노드 트리의 `imageRef` 필드와 13개 해시 일치 | 모든 이미지가 최소 1개 노드에서 참조됨 |
| **7** | REST API 호환 정규화 | Figma REST 응답과 필드명·계층 호환 | sample 노드를 REST 형식으로 변환 검증 |
| **8** | 벡터 추출 | commandsBlob → SVG path | 최소 1개 vector 노드의 SVG 생성 |
| **9** | 최종 export + 검증 보고서 | G1~G6 모두 충족 | `verification_report.md` PASS |

각 Iteration은 **이전 단계 산출물에만 의존**하므로, 중간에 실패해도 그 지점부터 재시작 가능.

### 6.4 실패 시 정책

- **FAIL (단순 버그)** → Executor 동일 task 재실행, 최대 3회. 4회 시 자동 PIVOT.
- **PIVOT (가설 오류)** → Planner가 가설 수정. 새 가설은 직전 발견에서만 도출(과추론 금지).
- **BLOCK (정보 부족)** → 사용자에게 질문 (예: "이 노드 타입을 무시할지/raw bytes로 보존할지").

---

## 7. 검증 전략

### 7.1 자동 검증 (Verifier가 수행)

| ID | 검증 | 방법 |
|---|---|---|
| V-01 | 입력 파일 무결성 | ZIP CRC + canvas.fig magic 재확인 |
| V-02 | 디코딩 무손실성 | Kiwi-decode → Kiwi-encode → byte-level diff |
| V-03 | 트리 일관성 | 모든 child의 parent가 존재, 순환 없음 |
| V-04 | 에셋 일관성 | 모든 imageRef가 images/에 실재, 모든 image가 최소 1회 참조 |
| V-05 | 결정성 | 동일 입력 2회 처리 → SHA-256 동일 |
| V-06 | meta.json 일치 | meta.json 값과 추출된 document root 메타 일치 |

### 7.2 사용자 확인 검증 (사용자 협조 필요)

| ID | 검증 | 방법 |
|---|---|---|
| U-01 | 페이지 개수 | 사용자가 Figma 클라우드에서 본 페이지 수 vs `pages/` 파일 수 |
| U-02 | 프레임 이름 일치 | document.json grep으로 주요 프레임 이름 확인 |
| U-03 | 색상 정확도 | meta.json `background_color` (RGB ~0.069, 0.046, 0.046) ↔ Figma 클라우드 BG |
| U-04 | 이미지 시각 비교 | 추출된 PNG vs Figma 클라우드 렌더 |

---

## 8. 리스크 및 대응

| 리스크 | 가능성 | 영향 | 대응 |
|---|---|---|---|
| Figma 스키마가 reference 도구의 가정과 다름 | 중 | 고 | schema chunk를 매번 추출 → 동적 디코더 생성 |
| 압축 알고리즘이 zstd로 변경됨 | 중 | 중 | 두 알고리즘 모두 시도, magic으로 자동 분기 |
| commandsBlob 포맷 변경 | 중 | 저 | 실패 시 raw bytes 보존 + 경고 로그, v1에선 best-effort |
| 알 수 없는 RootType | 저 | 중 | NodeChanges 우선, 실패 시 모든 RootType brute-force |
| 대용량 파일(>500MB) 메모리 부족 | 저 | 중 | streaming은 v2, v1은 RAM 가정 |
| 첨부 파일이 유료 컴포넌트·라이센스 자산 포함 | - | - | 사용자 본인 자산이라 가정. 외부 공유 시 사용자 책임 |

---

## 9. 마일스톤

| 시점 | 산출물 |
|---|---|
| **M0** (현재) | PRD v0.2 + 실측 보고서 |
| **M1** | Iteration 1~2 완료, chunk 구조 확정 |
| **M2** | Iteration 3~4 완료, schema + raw nodes JSON |
| **M3** | Iteration 5~7 완료, 정규화된 document.json |
| **M4** | Iteration 8~9 완료, 전체 출력 + 검증 보고서 |

---

## 10. 사용자 결정 필요 사항 (M1 진입 전)

본 PRD를 승인하기 전에 다음 4개 결정을 부탁드립니다.

1. **출력 디테일 레벨** — (a) REST API 완전 호환 (필드명 100% 일치, 변환 비용 큼) / (b) 실용형(Kiwi 원본 유지 + 일부 별칭) / (c) raw + minimal (디버깅용 원본 우선)
2. **벡터 추출 우선순위** — v1에 포함할까, v2로 미룰까? (포함 시 +1 iteration)
3. **컨테이너 변형 지원 범위** — v1은 (a) ZIP-wrapped만 / (b) ZIP + raw fig-kiwi 둘 다 (권장)
4. **언어/런타임** — Node.js (TypeScript, 권장) / Python (kiwi 라이브러리 미성숙) / 둘 다 제공

답변 후 Iteration 0 (환경 셋업)부터 Plan-Execute-Verify 루프 착수.

---

## 부록 A. 참조

- Evan Wallace, [Figma .fig file parser online](https://madebyevan.com/figma/fig-file-parser/)
- evanw, [kiwi: schema-based binary format](https://github.com/evanw/kiwi)
- Albert Sikkema (2026-01), [Reverse-Engineering Figma Make Files](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html)
- easylogic (2024-10), [Figma Inside — .fig 파일 분석](https://medium.com/@easylogic/figma-inside-fig-%ED%8C%8C%EC%9D%BC-%EB%B6%84%EC%84%9D-7252bef141da)
- allan-simon, [figma-kiwi-protocol (WebSocket frame decoder)](https://github.com/allan-simon/figma-kiwi-protocol)
- Grida Tools, [.fig File Parser and Viewer](https://grida.co/tools/fig)
- npm, [`fig-kiwi`](https://www.npmjs.com/package/fig-kiwi)

## 부록 B. 실측 명령 로그 (재현용)

```bash
file 메타리치_화면_UI_Design.fig
# → Zip archive data, at least v2.0 to extract, compression method=store

unzip -l 메타리치_화면_UI_Design.fig
# → canvas.fig (3.92MB), thumbnail.png, meta.json, images/ (13 PNGs)

python3 -c "open('canvas.fig','rb').read(8)"
# → b'fig-kiwi'

python3 -c "print(open('images/<hash>','rb').read(8).hex())"
# → 89504e470d0a1a0a (PNG signature)
```
