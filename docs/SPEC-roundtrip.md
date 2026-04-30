# SPEC v2 — `.fig ⇄ editable HTML ⇄ .fig` 양방향 Round-trip

| 항목 | 값 |
|---|---|
| 문서 버전 | v2.0 (양방향 round-trip 비전) |
| 작성일 | 2026-04-30 |
| 선행 문서 | [SPEC.md](./SPEC.md) (v1, 단방향 extract) · [PRD.md](./PRD.md) |
| 자매 문서 | [HARNESS.md](./HARNESS.md) (검증 하네스) · [SDD.md](./SDD.md) (개발 방법론) |
| 상태 | Draft → 사용자 승인 후 Plan-Execute-Verify 루프 착수 |

---

## 1. 비전 (Vision)

> **디자인은 Figma에서 시작해서, 코드 편집기에서 일괄 편집되고, 다시 Figma로 돌아가 결과를 확인한다.**

```
┌──────────────┐                                     ┌──────────────┐
│   Figma      │   .fig export                       │   Figma      │
│   (원본)     │  ─────────────►  [본 도구]  ◄────── │   (편집됨)   │
│              │                  ▲                  │              │
└──────────────┘                  │ Figma            └──────────────┘
                                  │ Import
                                  │
                  ┌───────────────┴────────────────┐
                  │  editable.html (편집 가능 HTML)│
                  │  ─ 사용자가 직접 편집           │
                  │  ─ 텍스트 / 색상 / 좌표 / 사이즈│
                  │  ─ 모든 메타 보존 (data-*)     │
                  └────────────────────────────────┘
```

본 도구는 **Figma와 코드 사이의 양방향 변환기**가 되어, 기존 [SPEC.md](./SPEC.md)에서 다룬 단방향 추출(`extract`)·재패키징(`repack`)을 넘어 **사용자가 HTML을 편집하고 그 결과를 Figma로 되돌릴 수 있는 사이클**을 완성한다.

### 1.1 왜 HTML이 중간 형식인가

| 후보 | 장점 | 단점 | 채택 |
|---|---|---|---|
| **HTML** | 표준 웹 기술, 모든 IDE 지원, 브라우저에서 시각 확인, CSS로 스타일 표현 자연스러움 | DOM이 Figma 노드 트리와 100% 1:1 대응은 아님 | ✅ |
| JSON | 정확하지만 시각 확인 어려움 | 편집기에서 검색·치환만 가능 | ❌ |
| Figma 플러그인 (TS) | Figma 안에서 동작 | Figma에 종속, 오프라인 불가, 자동화 어려움 | ❌ (보조 도구로 가능) |
| React/JSX | 컴포넌트 추상화 가능 | 빌드 도구 필요, 단순 편집보다 복잡 | ❌ (v3 후보) |

HTML은 **시각화와 편집을 동시에 만족**하는 유일한 형식이다.

### 1.2 사용자 시나리오 (Why)

| # | 시나리오 | 가치 |
|---|---|---|
| S1 | "디자인 텍스트를 영어/일본어/중국어 4종으로 일괄 교체하고 .fig 4개 생성" | 다국어 디자인 자동화 — Figma에서 손으로 하면 수십 시간 |
| S2 | "라이트/다크 테마 색상 토큰을 한 번에 swap한 .fig 생성" | 테마 일괄 적용 — 토큰 시스템 운영 |
| S3 | "특정 컴포넌트(예: card)를 100개 복제해 데이터 바인딩한 .fig" | 데이터 driven 디자인 |
| S4 | "AI 응답으로 카피 라이팅을 생성해 .fig에 자동 반영" | LLM 통합 디자인 |
| S5 | "코드 리뷰처럼 Figma 디자인 변경을 PR/diff로 관리" | 디자인 거버넌스 |

이 모든 시나리오는 **편집 가능한 코드 형식 (HTML)** 이 있어야 가능하다.

---

## 2. 전체 파이프라인 (Architecture)

### 2.1 7단계 파이프라인 (기존 5단계 + 2단계 추가)

```
.fig 원본
   │
   ▼
[Stage 1] container        — extracted/01_container/  ┐
[Stage 2] archive          — extracted/02_archive/    │
[Stage 3] decompressed     — extracted/03_decompressed/│ 기존 (v1)
[Stage 4] decoded          — extracted/04_decoded/    │
[Stage 5] tree             — extracted/05_tree/       │
[Stage 6] report (HTML)    — extracted/06_report/     ┘
   │
   ▼  ★ 신규 v2
[Stage 7] editable HTML    — extracted/07_editable/figma.editable.html
                              + figma.editable.meta.json (sidecar)
   │
   ▼  사용자 편집 (텍스트·색상·좌표 등)
   │
   ▼  ★ 신규 v2
[Reverse] HTML → message   — src/html-to-fig.ts
   │
   ▼
[Reverse] Kiwi encode      — 기존 repack.ts 재사용
   │
   ▼
[Reverse] ZIP 패키징       — 기존 buildByteLevelFigBuffer 재사용
   │
   ▼
새 .fig
   │
   ▼
Figma Import
```

### 2.2 신규 모듈

| 모듈 | 책임 | 의존 |
|---|---|---|
| `src/editable-html.ts` | Stage 7: tree + assets → `figma.editable.html` 생성 | `tree.ts`, `normalize.ts`, `assets.ts` |
| `src/html-to-message.ts` | DOM 파싱 → KiwiMessage 객체 | `decoder.ts` (스키마 사용), `node:html-parser` |
| `src/diff-tree.ts` | 원본 트리 vs 편집된 트리 diff (디버깅) | `tree.ts` |
| `src/cli.ts` (확장) | 새 서브커맨드: `editable-html`, `html-to-fig` | 위 모듈 |

### 2.3 기존 모듈 재사용

| 기존 | 새 활용 |
|---|---|
| `src/decoder.ts` | 스키마·메시지 디코드 (HTML→.fig 시 schema 참조) |
| `src/repack.ts::buildByteLevelFigBuffer` | 새 .fig ZIP 패키징 |
| `src/intermediate.ts` | 추가로 Stage 7 dump |
| `src/verify.ts` | round-trip 검증 (V-09 신규) |

---

## 3. `figma.editable.html` 형식 명세 (★ 핵심)

### 3.1 설계 원칙

| 원칙 | 의미 |
|---|---|
| **시각 = 의미** | 브라우저에서 열면 Figma처럼 보이고, 그 시각이 곧 Figma 노드 의미 |
| **메타 보존** | 사용자가 편집한 영역 외 모든 raw 필드는 `data-*` / sidecar에 보존 |
| **편집 가능 영역 명시** | 어떤 필드가 라운드트립 가능한지 HTML에 표시 (`data-figma-editable`) |
| **GUID 안정성** | 사용자가 element를 재배치해도 GUID는 변경 안 됨 |
| **Plain HTML** | 빌드 도구 없이 모든 IDE·브라우저에서 열림 |

### 3.2 HTML 구조 골격

```html
<!DOCTYPE html>
<html lang="ko" data-figma-roundtrip="v2">
<head>
  <meta charset="UTF-8" />
  <title>{file_name}</title>
  <link rel="stylesheet" href="figma.editable.css" /><!-- 또는 inline -->
  <script src="figma.editable.meta.js"></script><!-- sidecar 메타 -->
</head>
<body
  data-figma-version="106"
  data-figma-schema-sha256="..."
  data-figma-source-fig-sha256="..."
  data-figma-exported-at="2026-04-20T02:33:06.552Z"
  style="background: rgb(18, 12, 12)">

  <!-- DOCUMENT 노드 (보이지 않음, 메타만) -->
  <main
    class="fig-document"
    data-figma-id="0:0"
    data-figma-type="DOCUMENT"
    data-figma-name="Document">

    <!-- CANVAS = 페이지 -->
    <section
      class="fig-page"
      data-figma-id="0:1"
      data-figma-type="CANVAS"
      data-figma-name="design setting"
      data-figma-position="~!"
      style="background: rgba(69, 69, 69, 1)">

      <!-- 노드들이 여기 ... -->

      <div
        class="fig-node fig-frame"
        data-figma-id="2:1"
        data-figma-type="FRAME"
        data-figma-name="hero"
        data-figma-editable="position size fills"
        style="
          left: 0px; top: 0px;
          width: 1440px; height: 720px;
          background: rgb(255, 255, 255);
        ">
        <!-- 자식 노드 ... -->
      </div>

    </section>
  </main>

  <!-- 편집 불가 raw 메타 (보존만, 브라우저에서 안 보임) -->
  <template id="figma-raw-bundle">
    <!-- 각 노드의 raw 필드를 압축 JSON으로 보관 (사용자 편집 X) -->
  </template>
</body>
</html>
```

### 3.3 노드 타입 → HTML element 매핑

| Figma 노드 타입 | HTML element | class | 비고 |
|---|---|---|---|
| `DOCUMENT` | `<main class="fig-document">` | `fig-document` | 시각 표시 안 함 |
| `CANVAS` (page) | `<section class="fig-page">` | `fig-page` | 페이지 컨테이너 |
| `FRAME` | `<div class="fig-frame">` | `fig-frame` | 일반 프레임 |
| `GROUP` | `<div class="fig-group">` | `fig-group` | |
| `RECTANGLE` | `<div class="fig-rect">` | `fig-rect` | |
| `ROUNDED_RECTANGLE` | `<div class="fig-rect fig-rounded">` | | |
| `ELLIPSE` | `<div class="fig-ellipse">` | `fig-ellipse` | `border-radius: 50%` |
| `TEXT` | `<p class="fig-text"><span>...</span></p>` ★ | `fig-text` | **rich text segment 편집 지원** — §3.3.1 |
| `VECTOR` | `<div class="fig-vector"><svg>...</svg></div>` | `fig-vector` | inline SVG |
| `STAR`, `LINE`, `REGULAR_POLYGON` | 위와 동일 (vector family) | | |
| `INSTANCE` | `<div class="fig-instance">` | `fig-instance` | 컴포넌트 인스턴스 |
| `SYMBOL` (component) | `<div class="fig-symbol">` | `fig-symbol` | 컴포넌트 정의 |
| `BOOLEAN_OPERATION` | `<div class="fig-boolean">` | `fig-boolean` | best-effort |
| `SECTION` | `<section class="fig-section">` | `fig-section` | |
| 알 수 없는 타입 | `<div class="fig-unknown">` | `fig-unknown` | data-figma-type 보존 |

#### 3.3.1 TEXT 노드 — rich text segment 표현 ★

Figma TEXT 노드는 한 노드 안에 여러 스타일 segment 가질 수 있다 (e.g. "일반 **굵은** 글자"). Kiwi 표현:

```
characters: "일반 굵은 글자"
characterStyleIDs: [0,0,0,1,1,1,1,2,2,2]    // 각 character의 style index
styleOverrideTable: {
  0: { fontWeight: 400 },
  1: { fontWeight: 700 },
  2: { fontWeight: 400 }
}
```

HTML 표현 — `<span>` chunk per segment:

```html
<p class="fig-text"
  data-figma-id="2:5"
  data-figma-type="TEXT"
  data-figma-name="title"
  data-figma-editable="position size text-segments"
  style="position: absolute; left: 60px; top: 80px;
         width: 600px; height: 56px;
         font-family: 'Pretendard'; font-size: 16px;
         color: rgb(33, 33, 33);">
  <span data-style-id="0">일반 </span><span data-style-id="1" style="font-weight: 700">굵은</span><span data-style-id="2"> 글자</span>
</p>
```

**규칙**:
- `<p>` element의 style = 노드 기본 스타일 (style 0)
- 각 `<span>`의 `data-style-id` = `styleOverrideTable`의 키
- span 내 `style` 속성에 차이나는 속성만 (override)
- 사용자 편집 가능:
  - 텍스트 내용: span의 innerText 변경
  - segment 추가: 새 span 삽입 + data-style-id 할당
  - segment 병합: span 합침 (양쪽 style 동일하면 자동)
  - segment 스타일 변경: span의 style 수정
- 변환 시 (HTML → message):
  - 모든 span의 innerText 합 → `characters`
  - 각 span의 길이 누적 → `characterStyleIDs`
  - 각 unique style → `styleOverrideTable` 항목

**제약**:
- 인라인 미디어 (`<img>`, `<a>`) 미지원 — Figma TEXT는 plain text만
- `<br>`은 `\n` 문자로 처리

### 3.4 `data-figma-*` 속성 카탈로그

| 속성 | 의미 | 편집 정책 |
|---|---|---|
| `data-figma-id` | GUID 문자열 (`sessionID:localID`) | 🔒 보존 (절대 변경 X) |
| `data-figma-type` | 노드 타입 | 🔒 보존 |
| `data-figma-name` | 노드 이름 | 🟢 편집 가능 |
| `data-figma-position` | parentIndex.position (fractional indexing) | 🔒 보존 (DOM 순서로 자동 재계산 가능) |
| `data-figma-editable` | 편집 가능 필드 목록 (공백 구분, 예: `"position size fills text"`) | 🔒 보존 (가이드용) |
| `data-figma-blob-refs` | 참조된 commandsBlob/imageRef 인덱스 (JSON 배열) | 🔒 보존 |
| `data-figma-raw-ref` | sidecar의 raw 메타 키 (예: `"node-2-1"`) | 🔒 보존 |

### 3.5 편집 가능 영역 표 (★ 모든 raw 필드 편집 가능 — Decision D-1)

**v2 정책**: 사실상 **모든 Figma 필드가 편집 가능**하다. 단, 표현 방식이 두 가지로 나뉜다:

| Tier | 표현 | 편집 방식 |
|---|---|---|
| **Tier A — HTML 인라인** | CSS / data-* attribute / span text | 브라우저에서 직관적 (Devtools) 또는 텍스트 편집기로 |
| **Tier B — Sidecar JSON** | `figma.editable.meta.js`의 `FIGMA_RAW.nodes[guid]` | JSON 편집기 (jq, JSON path tool, 텍스트 에디터) |

원칙:
- **시각에 직접 영향 + Figma에서 흔히 손 대는 필드** → Tier A (HTML 표현)
- **고급/희귀/구조적 필드** → Tier B (sidecar)
- 두 표현 충돌 시: **Tier A (HTML) 우선** — 사용자가 편집한 시각이 truth
- 사용자가 Tier B만 편집한 경우: Tier A는 변경 없음, Tier B 변경 그대로 반영

#### Tier A — HTML 인라인 (시각 핵심)

| Figma 필드 | HTML 표현 | 변환 룰 (양방향) |
|---|---|---|
| `name` | `data-figma-name` | 직접 매핑 |
| `visible` | CSS `display: none` / `visibility: hidden` 또는 `data-figma-visible="false"` | display·visibility 검사 |
| `locked` | `data-figma-locked` (시각 영향 없음, 보존용) | 직접 |
| `opacity` | CSS `opacity` | 0-1 |
| `size.x`, `size.y` | CSS `width`, `height` | px |
| `transform` | CSS `left`, `top`, `transform: matrix(...)` | m00~m12 모두 표현 |
| `cornerRadius` | CSS `border-radius` | 단일 |
| `cornerRadii` (per-corner) | CSS `border-top-left-radius`, ... | 4개 분리 |
| `fillPaints[0].color` (SOLID) | CSS `background-color` (rgba) | 0-255 ↔ 0-1 |
| `fillPaints` (다중 + GRADIENT) | CSS `background: linear-gradient(...)` 다중 layer | best-effort (Figma → CSS gradient 매핑) |
| `fillPaints[].type=IMAGE` | CSS `background-image: url(assets/images/<hash>.<ext>)` + `background-size`, `background-repeat` | scaleMode 매핑 (FILL→cover, FIT→contain) |
| `strokePaints[0].color` | CSS `border-color` | |
| `strokeWeight` | CSS `border-width` | |
| `strokeAlign` | data attr `data-figma-stroke-align` (CSS 직접 대응 없음) | INSIDE/OUTSIDE/CENTER |
| `dashPattern` | CSS `border-style: dashed` 또는 SVG | 단순 케이스만 |
| `effects[]` (DROP_SHADOW) | CSS `box-shadow` (다중 layer) | offset, blur, color, spread |
| `effects[]` (INNER_SHADOW) | CSS `box-shadow inset` | 동일 |
| `effects[]` (LAYER_BLUR) | CSS `filter: blur(Npx)` | radius |
| `effects[]` (BACKGROUND_BLUR) | CSS `backdrop-filter: blur(Npx)` | radius |
| `blendMode` | CSS `mix-blend-mode` | 매핑 표 (NORMAL→normal, MULTIPLY→multiply 등) |
| TEXT `characters` | span chunk innerText 합 | §3.3.1 |
| TEXT `characterStyleIDs` + `styleOverrideTable` | span 분할 + data-style-id | §3.3.1 |
| TEXT `fontName.family` | CSS `font-family` | |
| TEXT `fontName.style` (Bold, Italic 등) | CSS `font-weight`, `font-style` | "Bold"→700, "Italic"→italic |
| TEXT `fontSize` | CSS `font-size` | px |
| TEXT `lineHeight` | CSS `line-height` | px 또는 %, unit별 |
| TEXT `letterSpacing` | CSS `letter-spacing` | px 또는 % |
| TEXT `textAlignHorizontal` | CSS `text-align` | |
| TEXT `textAlignVertical` | CSS `align-items` (flex 컨테이너로) 또는 data attr | |
| TEXT `textDecoration` | CSS `text-decoration` | UNDERLINE/STRIKETHROUGH |
| TEXT `textCase` | CSS `text-transform` | UPPER/LOWER/TITLE |
| `fillGeometry`, `strokeGeometry` (VECTOR) | inline `<svg><path d="..."/></svg>` (commandsBlob 디코드 결과) | path d 편집 가능 → 다시 commandsBlob 인코드 |
| `image.hash` | `<img src="assets/images/<hash>.<ext>">` 또는 background-image | 직접 |
| `exportSettings` | data attr `data-figma-export-settings` (JSON) | 보존 |
| `constraints` | data attr `data-figma-constraints` (JSON) | 보존 + 편집 가능 |
| `layoutAlign`, `layoutGrow` | data attr | 보존 |

#### Tier B — Sidecar JSON (구조·고급 필드)

`figma.editable.meta.js`의 `FIGMA_RAW.nodes[<guid>]`에 보관. 사용자가 직접 편집 가능. 예시 필드:

| Figma 필드 | 비고 |
|---|---|
| `layoutGrids` | 구조적, HTML로 표현 어려움 |
| `prototypeStartNodeID`, `prototypeDevice` | 프로토타입 메타 |
| `interactions[]` | 클릭·hover 액션 |
| `componentPropertyDefinitions` | 컴포넌트 prop |
| `componentPropertyReferences` | 인스턴스의 prop 바인딩 |
| `variantProperties` | Variant 정의 |
| `pluginData`, `sharedPluginData` | 외부 플러그인 데이터 |
| `vectorNetworkBlob` (인덱스) | 디코드 어려운 vector 메타 |
| `mainComponent` (instance ↔ component 링크) | GUID 참조 |
| `overrides` (instance의 override) | 노드별 |
| `handoffStatusMap` | dev mode 메타 |
| `connectorStart`, `connectorEnd` (CONNECTOR) | FigJam 연결선 |
| `transitionInfo`, `transitionDuration` | 프로토타입 전환 |
| 기타 알 수 없는 raw 필드 | 미래 호환 보존 |

#### Tier C — 편집 불가 (보존만)

다음은 사용자가 편집해도 의미 없거나 충돌 야기 → 보존만:

| 필드 | 이유 |
|---|---|
| `guid` (sessionID/localID) | 노드 식별자 — 변경 시 부모-자식 링크 깨짐 |
| `parentIndex.guid` | 부모 GUID — DOM 구조로 결정 |
| `parentIndex.position` | fractional indexing — DOM 형제 순서로 자동 재계산 |
| `phase` | CREATED/REMOVED — 도구가 자동 설정 |

### 3.6 Sidecar 파일 (Decision D-2: 디렉토리가 default)

**v2 default = 디렉토리 출력**. 단일 파일은 보조 옵션 (`--single-file`).

```
extracted/07_editable/
├── figma.editable.html         사람이 보고 편집할 메인 파일
├── figma.editable.meta.js      window.FIGMA_RAW = {...} ★ Tier B 편집 가능
├── figma.editable.css          스타일 (HTML에서 link)
├── README.md                   사용자 편집 가이드 (자동 생성)
└── assets/                     이미지·SVG·blob (output/assets/와 동일 구조)
    ├── images/
    ├── vectors/
    └── blobs/                  ★ raw kiwi blobs (commandsBlob, vectorNetworkBlob 등 hex/base64)
```

`figma.editable.meta.js` 구조:

```javascript
// 사용자 편집 가능 (단, 형식 깨지면 변환 실패)
window.FIGMA_RAW = {
  // 메타 (편집 시 round-trip 깨짐 — 보존만)
  __meta: {
    archiveVersion: 106,
    schemaSha256: "b82dafbd...",
    sourceFigSha256: "de8f66cc...",
    rootMessageType: "NODE_CHANGES",
    generator: "figma-reverse v2.0",
    generatedAt: "2026-04-30T..."
  },

  // 메시지 최상위 필드 (편집 가능, 단 type은 보존 권장)
  message: {
    type: "NODE_CHANGES",
    sessionID: 0,
    ackID: 0
  },

  // ★ 모든 노드의 raw 필드 (편집 가능)
  nodes: {
    "0:0": {
      // DOCUMENT — Tier C 필드 외엔 편집 가능
      // (HTML에 표현된 필드는 sidecar에도 있되, HTML 우선)
      type: "DOCUMENT", name: "Document", phase: "CREATED",
      // ... 모든 raw 필드
    },
    "2:1": {
      type: "FRAME", name: "hero",
      // Tier B 필드 (HTML에 안 나오는 것)
      effects: [{ type: "DROP_SHADOW", radius: 4, color: {...}, offset: {...} }],
      layoutGrids: [...],
      blendMode: "PASS_THROUGH",
      pluginData: {},
      // Tier A 필드도 있음 (HTML과 동기화 / HTML 우선)
      size: { x: 1440, y: 720 },
      transform: { m00:1, m01:0, m02:213, m10:0, m11:1, m12:127 },
      fillPaints: [...],
      // ...
    },
    // ... 35,660개 노드 (디렉토리에 분할 가능 — `nodes-by-page/<n>.js`로 lazy load)
  },

  // blobs (commandsBlob, vectorNetworkBlob 등)
  // - 작은 blob은 inline (hex string)
  // - 큰 blob은 파일 참조: { ref: "assets/blobs/<idx>.bin" }
  blobs: [
    { hex: "01000000..." },
    { ref: "assets/blobs/0203.bin" },
    // ...
  ]
};
```

#### 사용자 편집 가이드 (자동 생성 README.md)

`extracted/07_editable/README.md`에 다음 정보 자동 출력:
- 어떤 파일을 어떻게 편집해야 하는지
- Tier A vs B 차이
- 편집 후 `figma-reverse html-to-fig` 명령
- 잘못된 편집 시 디버깅 팁
- 편집 가능 필드 카탈로그 (§3.5 표 요약)

### 3.7 단일 파일 옵션 (`--single-file`)

선택적 옵션. 디렉토리의 모든 sidecar·CSS·이미지·SVG를 inline:

```
extracted/07_editable/figma.editable.html  (단일 파일, 예상 ~30 MB)
```

용도:
- 공유·전송 (한 파일만)
- 사용자 편집은 어려움 (브라우저에서 Devtools로만)
- **권장: 디렉토리 모드로 편집 → 완료 후 단일 파일로 export**

---

## 4. HTML → `.fig` 변환 룰

### 4.1 변환 절차

```
1. HTML parse (htmlparser2 또는 jsdom-like)
2. data-figma-source-fig-sha256 → 원본 .fig 식별 (sidecar 메타 정합성 검증)
3. window.FIGMA_RAW.message 객체를 시작점으로 복사
4. DOM walk:
   - 각 element의 data-figma-id로 RAW.nodes 조회 → 그 노드 raw 객체 시작
   - 사용자가 편집한 CSS/innerText/속성 → raw에 patch 적용
   - 새 element (data-figma-id 없음) → 새 GUID 생성, parentIndex 자동 계산, raw 빈 객체로 시작
   - 삭제된 element (RAW에 있는데 DOM에 없음) → nodeChanges에서 phase=REMOVED
5. 갱신된 nodeChanges → kiwi.compileSchema(schema).encodeMessage()
6. deflate-raw 압축 → fig-kiwi archive 작성 → ZIP 패키징
7. 새 .fig 파일 출력
```

### 4.2 CSS → Figma 필드 역변환 룰

| CSS | Figma 필드 | 룰 |
|---|---|---|
| `width: 200px` | `size.x = 200` | px 단위 그대로 |
| `height: 100px` | `size.y = 100` | px 단위 그대로 |
| `left: 50px; top: 30px;` | `transform.m02 = 50; m12 = 30;` | absolute positioning 가정 |
| `background-color: rgb(255, 0, 0)` | `fillPaints[0] = {type:SOLID, color:{r:1, g:0, b:0, a:1}}` | 0-255 → 0-1 |
| `background-color: rgba(0,0,0,0.5)` | `color: {r:0, g:0, b:0, a:0.5}` | |
| `background-color: transparent` | `fillPaints = []` | |
| `opacity: 0.7` | `opacity = 0.7` | |
| `display: none` | `visible = false` | |
| `border-radius: 8px` | `cornerRadius = 8` | |
| `border: 2px solid #000` | `strokePaints[0] = {type:SOLID, color:#000}; strokeWeight = 2` | |
| `font-size: 14px` | `fontSize = 14` | TEXT 노드 |
| `font-family: Inter, sans-serif` | `fontName = {family:"Inter", style:"Regular", postscript:"Inter-Regular"}` | best-effort, fallback chain 첫째 사용 |
| `color: #333` | TEXT 노드 `fillPaints[0].color` | |
| `text-align: center` | `textAlignHorizontal = "CENTER"` | |
| `innerText` | `characters` | 텍스트 노드의 본문 |

### 4.3 노드 추가/삭제

- **추가** (사용자가 새 `<div>` 작성 시):
  - 새 GUID: 임시 sessionID(예: 999) + 자동 증가 localID
  - parentIndex.position: 형제 사이의 fractional indexing 문자열 자동 계산
  - phase: `CREATED`
- **삭제** (DOM에서 element 제거):
  - 원본 RAW에 있었으나 DOM에 없으면 phase = `REMOVED`로 nodeChanges에 추가
- **순서 변경** (DOM에서 형제 순서 바뀜):
  - parentIndex.position 재계산

### 4.4 손실 정책 (D-1 결정 반영 — 사실상 무손실)

**v2 정책: 모든 raw 필드가 편집 가능 (Tier A or B)이므로 사실상 손실 없음.** 손실은 사용자가 구조를 깨뜨릴 때만 발생.

| 사용자 행동 | Figma 결과 | 손실 |
|---|---|---|
| 텍스트만 변경 (Tier A) | 100% 보존 | 없음 |
| 색상·사이즈·좌표·효과·blend 등 시각 필드 변경 (Tier A) | 100% 보존 | 없음 |
| Tier B 필드 (layoutGrids, interactions 등) sidecar JSON 편집 | 100% 보존 | 없음 (단 형식 정확해야) |
| TEXT segment 분할/병합/스타일 변경 | 100% 보존 | 없음 (§3.3.1 룰 따라 변환) |
| element 삭제 | 100% 보존 (REMOVED phase) | 자식까지 cascade 삭제 |
| 노드 추가 | **미지원 (v3)** ← Decision D-4 | — |
| `<svg>` path d 직접 편집 | commandsBlob 재인코딩 시도. 실패 시 user에게 경고 + raw blob 보존 (시각만 변경됨) | path 디코드 못 한 영역 |
| HTML data-figma-id 손상 | 변환 시 새 노드로 처리 → 원본 노드 사라짐 | 사용자 책임 |
| sidecar JSON 형식 깨짐 | 변환 실패 (즉시 에러) | 0 (변환 안 됨) |
| 편집 안 한 노드 | byte-level 동등 보장 | 없음 |

---

## 5. 구현 로드맵

기존 PRD §6.3의 Plan-Execute-Verify 루프를 이어 받아 **Iteration 10~16**로 진행.

**모든 iteration의 Definition of Done** (Decision D-6):
1. 단위 + 통합 테스트 PASS
2. 라운드트립 하네스 (L2) PASS
3. 편집 시뮬 하네스 (L3) PASS
4. **★ Figma 데스크톱에서 실제 import 시도 + 화면 캡처** (L4 수동, `.gstack/qa-reports/figma-import-iter{N}.md`)
5. spec → test → impl 모두 일치 (SDD)

| # | 주제 | 핵심 가설 / 검증 질문 | 성공 기준 | 예상 (CC) |
|---|---|---|---|---|
| **10** | 편집 가능 HTML spec 확정 | 본 SPEC 구조가 실제 sample 파일에 적용 가능한가? | docs/specs/{editable-html, html-to-message, node-mapping}.spec.md 작성 | ~1h |
| **11** | Stage 7 generator (Tier A only) | tree + assets → editable.html 생성, Tier A 필드만 HTML로 | 6 페이지 모두 생성, 브라우저에서 Figma처럼 보임 + **Iter11 Figma import 통과** | ~4h |
| **12** | Sidecar 생성 (Tier B) | 모든 raw 필드 sidecar JSON으로 보존 | figma.editable.meta.js 생성, 모든 노드 raw 키 보존 (V-09) + **Iter12 Figma import 통과** | ~2h |
| **13** | HTML → message 파서 (편집 없는 round-trip) | 편집 안 한 HTML → 새 .fig → 원본과 GUID·tree 동등 | GUID 집합 동등 100%, schema 568 보존 (V-10) + **Iter13 Figma import** | ~4h |
| **14** | 편집 시뮬 (Tier A) | "텍스트 교체"·"색상 swap"·"좌표 이동"·"effects 추가" | 4개 시나리오 → .fig → 자동 검증 + **Iter14 Figma import** | ~3h |
| **15** | rich text segment + 노드 삭제 | TEXT span 분할 ↔ characterStyleIDs/styleOverrideTable round-trip | rich text 시나리오 통과 + 노드 삭제 시나리오 + **Iter15 Figma import** | ~4h |
| **16** | Tier B (sidecar) 편집 round-trip | 사용자가 sidecar JSON 편집 (e.g. effects, layoutGrids) → .fig 반영 | sidecar 편집 시나리오 → Figma에서 효과 변경됨 + **Iter16 Figma import** | ~3h |
| **17** | **최종 모음 검증** ★ | 모든 iteration의 산출물 한 번에 통합 테스트 | L2 + L3 + L4 풀 시나리오 (10+ 시나리오) 통과, 최종 보고서 | ~2h |

**총 예상 CC: ~23시간** (D-1 모든 필드 + D-5 rich text 추가로 ~14h → ~23h 늘어남)

각 iteration은 [HARNESS.md](./HARNESS.md)의 자동 검증 + Figma 수동 import를 통과해야 다음 단계로.

---

## 6. 비목표 (Non-Goals, v2)

명확히 v2에 포함하지 않는 것:

- ❌ **노드 추가** (Decision D-4) — v2는 편집·삭제만. 새 노드 추가는 v3에서. 사용자가 새 div를 HTML에 삽입해도 변환 시 무시 (혹은 명시적 에러).
- ❌ **React/JSX → .fig** — 본 SPEC은 추출된 .fig를 시작점으로. React from scratch는 v3.
- ❌ **CSS Flexbox → Figma auto-layout 양방향 변환** — v2에선 absolute positioning만. flex 매핑은 v3.
- ❌ **CSS Grid → Figma layoutGrids** — Tier B sidecar로 보존만. CSS grid 자동 변환은 미지원.
- ❌ **CSS animation → Figma prototype connection** — 정적 스냅샷. interactions는 sidecar 보존.
- ❌ **CSS pseudo-element (`:hover`, `::before`)** — Figma에 직접 대응 없음.
- ❌ **Figma 컴포넌트 변형 (Variants)** 자동 인식 — 보존만, 편집 시 새 인스턴스로 처리.
- ❌ **Figma 클라우드 직접 업로드** — 사용자가 수동 import.
- ❌ **여러 .fig 합치기 / 분할** — 1:1 round-trip만.
- ❌ **HTML5 form 요소** (`<input>`, `<select>`) — 의미가 Figma에 없음.
- ❌ **편집 미리보기 별도 viewer** (Decision D-3) — HTML 자체가 미리보기. devtools나 브라우저 새로고침으로 확인.

---

## 7. 위험 (Risks)

| 위험 | 가능성 | 영향 | 대응 |
|---|---|---|---|
| Figma가 우리가 생성한 .fig를 reject | 중 | 고 | byte-level repack 결과는 이미 byte-identical 검증됨. kiwi 재인코드 결과는 v1에서 round-trip OK. 실제 import 테스트 일찍 진행 |
| 사용자 편집 후 GUID 충돌 | 저 | 중 | sessionID=999 (예약) + 자동 증가로 충돌 회피. 충돌 감지 시 새 GUID 자동 발급 |
| parentIndex.position 재계산 정확도 | 중 | 중 | Figma의 fractional indexing은 lexicographic. 형제 사이 새 문자열 생성하는 알고리즘 (e.g. between "a" and "c" → "b") 구현 |
| HTML 편집 도중 메타 깨짐 (사용자가 data-* 삭제 등) | 중 | 중 | sidecar에 fallback 보유. data-figma-id 누락 시 → 새 노드로 처리 |
| 한 페이지에 노드가 너무 많아 HTML이 거대 (예: WEB 페이지 29,029 노드) | 고 | 고 | 페이지별 분리 + 페이지 단위 편집 권장. 단일 HTML 페이지에 전체 .fig 표현은 v2에선 lazy-load로 |
| TEXT 노드의 풍부한 텍스트(rich text segments) 편집 | 중 | 중 | v2: 단순 plain text만 round-trip. rich text는 보존만 (segment 정보 sidecar에) |
| Figma API/포맷 변경 (archive version 증가) | 저 | 중 | 본 도구의 schema는 추출된 .fig에서 가져오므로 자동 적응 |

---

## 8. 검증 (Verification)

상세 검증 전략은 [HARNESS.md](./HARNESS.md) 참조. 요약:

| 레이어 | 검증 항목 | 자동화 |
|---|---|---|
| L0 단위 | 각 모듈 (editable-html, html-to-message, diff-tree) | vitest |
| L1 통합 | extract → editable → message 한 번 흐름 | vitest |
| L2 라운드트립 | extract → editable → fig → re-extract → tree 동등 | vitest + custom harness |
| L3 편집 시뮬 | 자동 변형 (텍스트 치환, 색상 swap) → fig → diff | custom harness |
| L4 Figma 호환 | 실제 .fig를 Figma에 import 시도 | 수동 (CI 자동화 어려움) |

신규 검증 항목:
- **V-09**: 편집 가능 HTML 생성 시 모든 노드 GUID가 HTML에 1:1 등장 + 모든 raw 필드가 Tier A 또는 B에 보존
- **V-10**: HTML → message 변환 시 GUID 보존율 100%
- **V-11**: 편집 안 한 HTML → 새 .fig → 원본과 의미적 동등 (V-03 통과)
- **V-12**: rich text segment round-trip — 입력 TEXT 노드의 characterStyleIDs가 HTML span 분할 후 다시 동일 array로 복원
- **V-13**: sidecar (Tier B) 편집 round-trip — sidecar JSON에서 effects 변경 시 .fig에 반영
- **V-14**: Figma import 성공 (수동, **매 iteration**) — `.gstack/qa-reports/figma-import-iter{N}.md`
- **V-15**: 최종 모음 검증 (Iteration 17) — 10+ 시나리오 풀 통과

---

## 9. 산출물 디렉토리 (최종)

각 `.fig` 파일은 자기 디렉토리(`extracted/<figName>/`)에 6단계 산출물 + `07_editable`(통합 편집·시각·.fig 다운로드 출력)을 가진다.

> **v2.1 통합**: `06_report/`는 폐지되어 `07_editable/`로 흡수. `editable-html --single-file` 시 단일 HTML에 편집 메타 + .fig base64 임베드 + 다운로드 버튼 + 디스크 .fig 자동 출력 모두 포함.

```
extracted/
└── <figName>/                ★ .fig 파일명 (확장자 제외)
    ├── 01_container/         [v1] ZIP 분해
    ├── 02_archive/           [v1] fig-kiwi 청크
    ├── 03_decompressed/      [v1] 압축 해제
    ├── 04_decoded/           [v1] Kiwi 디코드
    ├── 05_tree/              [v1] 트리 빌드
    └── 07_editable/          [v2] ★ 편집·시각·.fig 다운로드 통합 출력
        ├── figma.editable.html       (편집 가능 + .fig 임베드 + 다운로드 버튼)
        ├── figma.editable.css        (--single-file 시 inline)
        ├── figma.editable.meta.js    (Tier B sidecar — Iter 12)
        ├── README.md                 (편집 가이드)
        ├── <figName>.fig             (★ byte-level repack — Figma import용)
        └── assets/                   (디렉토리 모드만 — images/, vectors/)
```

output/
└── <figName>/                [v1] REST 호환 정규화 export — .fig별 분리
    ├── document.json
    ├── pages/
    ├── assets/
    ├── schema.json
    ├── metadata.json
    ├── manifest.json
    └── verification_report.md
```

> **명명 규칙**: `<figName>` = 입력 `.fig`의 basename에서 `.fig` 확장자 제거. 파일시스템 안전 문자만 (제어문자·예약문자는 `_`로 치환). 한글·공백 OK.

신규 CLI 서브커맨드:

```bash
# 편집 가능 HTML 생성
figma-reverse editable-html ./extracted [--single-file] [--out <path>]

# HTML 편집 후 → 새 .fig
figma-reverse html-to-fig ./extracted/07_editable/figma.editable.html ./out.fig

# 풀 사이클 (한 번에)
figma-reverse roundtrip <input.fig> ./output --edit
# → editable.html 생성 → 사용자 편집 대기 → enter → 새 .fig 생성 → Figma import 안내
```

---

## 10. 결정 기록 (Decisions, 2026-04-30)

본 SPEC v2의 진입 전 사용자 승인된 결정. 변경 시 본 섹션 업데이트.

| ID | 결정 | 영향 섹션 |
|---|---|---|
| **D-1** | 편집 가능 필드 = **모든 raw 필드** (Tier A: HTML 인라인 + Tier B: sidecar JSON) | §3.5, §3.6, §4.4 |
| **D-2** | HTML 출력 = **디렉토리 default** (`--single-file`은 보조 옵션) | §3.6, §3.7 |
| **D-3** | 편집 미리보기 = **HTML 자체로 충분** (별도 viewer 미작성) | §6 |
| **D-4** | 노드 추가 = **v3로 미룸** (v2는 편집·삭제만) | §4.3, §6 |
| **D-5** | rich text = **segment별 편집 가능** (`<span>` 분할 표현) | §3.3.1, §4.2 |
| **D-6** | Figma import 테스트 = **매 iteration + 최종 모음 검증** | §5, §8 |

**추가 후속 결정** (구현 중 결정 시 본 섹션에 기록):

| ID | 결정 | 결정 시점 |
|---|---|---|
| (예약) | parentIndex.position 재계산 알고리즘 — between(a, c) → b 방식 | Iteration 13 |
| (예약) | sidecar JSON 형식 (`.js` window 주입 vs `.json` fetch) | Iteration 12 |

승인 완료 → Iteration 10 (spec 확정) 진입 가능.

---

## 11. 부록 A. 1개 페이지 HTML 예시 (sketch)

`design setting` 페이지 (1180 노드)를 가정한 단순화 예시:

```html
<section class="fig-page"
  data-figma-id="0:1"
  data-figma-type="CANVAS"
  data-figma-name="design setting"
  style="background: rgba(69, 69, 69, 1); width: 3090px; height: 3100px;">

  <div class="fig-frame"
    data-figma-id="2:1"
    data-figma-type="FRAME"
    data-figma-name="hero"
    data-figma-editable="position size fills name"
    style="position: absolute; left: 213px; top: 127px;
           width: 1440px; height: 720px;
           background: rgb(255, 255, 255);">

    <p class="fig-text"
      data-figma-id="2:5"
      data-figma-type="TEXT"
      data-figma-name="title"
      data-figma-editable="position size text fontSize color"
      style="position: absolute; left: 60px; top: 80px;
             width: 600px; height: 56px;
             font-family: 'Pretendard', sans-serif; font-size: 48px;
             color: rgb(33, 33, 33);">메타리치 화면 UI Design</p>

    <div class="fig-rect fig-rounded"
      data-figma-id="2:9"
      data-figma-type="RECTANGLE"
      data-figma-name="cta button"
      data-figma-editable="position size fills cornerRadius"
      style="position: absolute; left: 60px; top: 200px;
             width: 200px; height: 56px;
             background: rgb(13, 153, 255);
             border-radius: 8px;">
    </div>
  </div>
</section>
```

사용자는 위 HTML의 어떤 부분이든 편집 가능 — 텍스트 변경, 색상 변경, 위치 옮기기 등. 이걸 다시 `.fig`로 변환하면 Figma에서 그대로 보임.

---

Generated by figma-reverse · v2 specification
