# spec/html-dashboard

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `src/html-export.ts` (`generateHtmlDashboard` 진입점) + `src/html-export-templates.ts` (`renderHtml`, `renderStyles`, `renderApp`) |
| 테스트 | `test/html-export.test.ts` (있는 한도 내) — 본 spec 추가 후 multi-file/single-file 출력 schema 단위 테스트 권장 |
| 형제 | `SPEC.md §Stage 8` (CLI 의 `output/` 산출물 source), `editable-html.spec.md` (단일 파일 + .fig embed 의 자매 출력), `vector-decode.spec.md` (벡터 SVG 의 source) |

## 1. 목적

`figma-reverse extract` 가 만든 `extracted/<n>_*/` + `output/` 디렉토리를
*브라우저에서 그대로 들여다볼 수 있는* HTML 대시보드로 묶는다. README §Outputs
가 광고하는 "browsable UI" 의 contract — invariant·embedding 룰·페이지
lazy-load 정책이 그동안 코드에만 있었다.

핵심 제약 — **`file://` 프로토콜에서 동작해야 한다**. user 가 더블클릭으로
열거나 USB 로 옮긴 dashboard 가 web server 없이 작동해야 archival /
backup 시나리오에서 가치가 있다. 이 제약이 모든 데이터 주입 방식 (XHR
대신 `<script src>` global) 과 image/SVG embedding 방식을 결정.

## 2. 진입점

```ts
function generateHtmlDashboard(inputs: HtmlExportInputs): HtmlExportResult;

interface HtmlExportInputs {
  extractedDir:  string;     // figma-reverse extract 의 extracted/<name>/
  outputDir:     string;     // figma-reverse extract 의 output/<name>/
  htmlOutDir:    string;     // 결과물 위치 (single-file 일 때는 .html 파일 경로)
  singleFile?:   boolean;    // default false
}

interface HtmlExportResult {
  outDir:        string;     // single-file 모드면 단일 파일 경로
  pages:         Array<{ index, name, nodeCount, relPath }>;
  imagesCopied:  number;
  vectorsCopied: number;
  totalBytes:    number;
  singleFile:    boolean;
}
```

- I-E1 두 입력 디렉토리 (`extractedDir`, `outputDir`) 모두 존재해야 한다 —
  부재 시 친절한 에러 (`"Run \`figma-reverse extract\` first"`).
- I-E2 `singleFile` 분기에 따라 *완전히 다른 출력 구조* (§3 vs §4). 같은
  진입점 하나만 노출, 호출자가 mode 선택.
- I-E3 `htmlOutDir` 의 의미가 mode 별로 다름: multi-file 모드는 *디렉토리
  경로*, single-file 모드는 *파일 경로*. UI / CLI 가 호출 시 명시.

## 3. Multi-file 모드 (default)

### 3.1 출력 디렉토리 구조

```
<htmlOutDir>/
├── index.html              ← renderHtml() 결과
├── styles.css              ← renderStyles() 결과
├── app.js                  ← renderApp() 결과 (탭 라우팅 + 렌더러)
├── data/
│   ├── overview.js         ← window.OVERVIEW (overview.json + meta)
│   ├── tree.js             ← window.NODES_FLAT (extracted/05_tree/nodes-flat.json)
│   ├── schema.js           ← window.SCHEMA (extracted/04_decoded/schema.json)
│   ├── pages-index.js      ← window.PAGES_INDEX (페이지 매니페스트)
│   ├── pen-index.js        ← window.PEN_INDEX (.pen 페이지 매니페스트)
│   ├── pages/<safeName>.js ← window.PAGE (lazy-load via <script src>)
│   └── pen-pages/<safeName>.js ← window.PEN (lazy-load via <script src>)
└── assets/
    ├── images/<hash>.<ext>
    ├── vectors/<id>.svg
    └── thumbnail.png
```

- I-M1 정적 파일 3종 (`index.html`, `styles.css`, `app.js`) 은 templates
  helper 가 produce — content 는 byte-stable, regeneration 결정성 보장.
- I-M2 `data/<name>.js` 는 모두 *single global assignment* 형태:
  `window.<UPPER_NAME> = <json>;` — `<script src>` 로 inject 후 `window`
  global 로 참조. JSON.stringify 의 결정성은 source 측 (extract pipeline)
  의 보장.
- I-M3 페이지 파일은 *file 별 안전 이름* — `<file>.json` 의 basename 에서
  `[^a-zA-Z0-9_-]` 를 `_` 로 치환. 한국어 페이지 이름이 latin-only safe
  filename 으로 변환됨.
- I-M4 페이지 lazy-load: `app.js` 가 사용자가 페이지 탭을 누를 때 `<script
  src="data/pages/<safeName>.js">` 를 동적으로 inject → `window.PAGE` 가
  override 됨. 이전에 inject 된 `PAGE` 는 garbage-collected.
- I-M5 lazy-load 의 grain: 페이지 단위. tree / schema / overview 는 항상
  full load — 사이즈 분포에서 페이지 데이터가 압도적이라 분리 가치는 페이지
  에서만 발생.
- I-M6 assets 는 *복사*. 원본 `output/assets/` 의 파일을 `htmlOutDir/assets/`
  로 그대로 옮긴다 — re-encoding 없음, byte-identical.

### 3.2 인덱스 파일 contract

```ts
// data/pages-index.js
window.PAGES_INDEX = [
  { index: number, name: string, nodeCount: number, relPath: string }
];

// data/pen-index.js
window.PEN_INDEX = [
  { idx: number, name: string, fileName: string, nodeCount: number, relPath: string, bytes: number }
];
```

- I-M7 `relPath` 는 `htmlOutDir` 기준 상대 경로 (`data/pages/<safe>.js`).
  `app.js` 가 그대로 `<script src>` 에 사용.
- I-M8 `name` source: `data.name ?? file` (페이지 JSON 의 `.name` 필드, 부재
  시 파일명). pen 측은 `data.__figma?.pageName` (page-export 가 stamp 한
  metadata).
- I-M9 `nodeCount`: `countNodes(data)` 또는 `countPenNodes(data.children ?? [])`
  — 호출자 (UI) 가 표시용.

### 3.3 사이드 데이터 source 매핑

| `data/*.js` | 출처 | nullable |
|---|---|---|
| `overview.js` | `collectOverview(extractedDir, outputDir)` (각 stage 의 `_info.json` + `verification_report.md` 통합) | 항상 emit |
| `tree.js` | `extracted/05_tree/nodes-flat.json` | 부재 시 `[]` emit |
| `schema.js` | `extracted/04_decoded/schema.json` | 부재 시 `null` emit |
| `pages/*.js` | `output/pages/<n>_<name>.json` | 페이지 디렉토리 없으면 빈 인덱스 |
| `pen-pages/*.js` | `extracted/08_pen/<n>.pen.json` | 펜 디렉토리 없으면 빈 인덱스 |

- I-M10 source 부재가 *throw 가 아니라 fallback* 인 이유: dashboard 가 *부분
  pipeline 출력* 도 시각화 가능해야 함. 사용자가 `--no-vector` 로 추출
  했을 때 dashboard 가 멈추지 않는다.

## 4. Single-file 모드

`htmlOutDir` 가 `.html` 파일 경로. 모든 데이터 + 에셋 + JS/CSS 가 *한 파일*
안에 inline.

- I-S1 페이지 데이터는 *renderer 가 사용하는 필드만* 보존 (`stripPageForRenderer`)
  — schema 보호 없는 raw page json 보다 size 가 크게 작아짐. multi-file
  모드는 raw 그대로, single-file 만 strip.
- I-S2 image embedding: `data:<mime>;base64,<...>` URI. mime 은 파일 확장자
  (`f.slice(dot+1)`) 로 결정 — `mimeFromExt` 가 png/jpg/webp/gif/svg/pdf 매핑.
- I-S3 SVG embedding: raw string 그대로 (data URI 안 씀) — Konva 가 path
  파싱 시 직접 사용 가능.
- I-S4 thumbnail: `data:image/png;base64,...` 단일 string.
- I-S5 single-file mode 의 출력은 *기본 100MB 미만* 가정. 메타리치 기준
  ~30MB. 이 범위 밖은 multi-file 권장 (브라우저의 string parse 비용 증가).
- I-S6 file://compatibility: 모든 `<script>` 가 inline (no `src`), 모든
  이미지가 data URI — origin 격리 환경에서도 동작.

## 5. JS 모듈 형식

`writeJsModule(path, name, value)` 가 모든 `data/*.js` 파일을 emit.

- I-J1 형식: `window.${name} = ${JSON.stringify(value)};\n`. minify 안 함
  (브라우저 dev tool 디버깅 가능).
- I-J2 `name` 은 `[A-Z_][A-Z0-9_]*` SCREAMING_SNAKE — 충돌 회피.
- I-J3 JSON 직렬화 결정성: `JSON.stringify(value)` (indent 없음). value 의
  property 순서가 보존되어야 git diff noise 가 발생하지 않음.
- I-J4 returned bytes (string length 의 utf-8 byte count) 가 호출자에게
  반환 — `totalBytes` 계산용.

## 6. 정적 템플릿 (`html-export-templates.ts`)

- I-T1 `renderHtml()`: `<!DOCTYPE html>` + `<head>` (styles.css link, viewport
  meta, title) + `<body>` (root container) + 데이터 script 의 *고정 순서*
  inject (overview → tree → schema → pages-index → pen-index → app.js).
- I-T2 `renderStyles()`: 모든 CSS 가 한 string. 외부 CSS 의존 없음 (Tailwind
  / styled-components 미사용 — file:// 배포 호환).
- I-T3 `renderApp()`: 한 string 의 vanilla JS — 탭 라우팅 (`Overview`,
  `Pages`, `Pen`, `Tree`, `Schema`, `Verify`), 페이지 lazy loader, 검색.
  단일 page application but no framework.
- I-T4 single-file 모드는 `renderSingleFileHtml(...)` 가 templates 와 inline
  데이터를 한 string 으로 결합.

## 7. Error policy

- I-E2 입력 디렉토리 부재 → 친절한 에러 (CLI 가 다음에 실행할 명령 안내).
- I-E3 source JSON 부재 (e.g. `nodes-flat.json` 미존재) → 빈 fallback emit
  (§I-M10). throw 안 함.
- I-E4 image / vector 부재 → 해당 카테고리 0개 emit, dashboard 가 *해당
  탭만 비어있게* 표시. 다른 탭은 정상 동작.
- I-E5 single-file mode 의 `mimeFromExt` 가 unknown 확장자를 만나면 image
  skip — broken `<img src>` 보다 안전.

## 8. 비대상

- ❌ **interactive editing** — dashboard 는 *read-only viewer*. node 변경
  / repack 트리거 / .fig export 는 별개 기능 (`editable-html.spec.md`).
- ❌ **CDN / web server 의존** — 인터넷 없이 동작해야 함 (file:// 보장).
  외부 폰트, 외부 CSS, 외부 JS 의존 없음.
- ❌ **server-side rendering** — 모든 렌더링 client-side. SEO / accessibility
  레벨은 dashboard scope 밖.
- ❌ **WCAG 완전 준수** — 색상 대비 / aria-label / 키보드 navigation 은
  best-effort. 본 spec 의 검증 대상 아님.
- ❌ **i18n** — UI 텍스트는 한국어 + 영어 mix (소스 그대로). dashboard 는
  내부 도구.
- ❌ **저장된 view state** — 탭 / 검색어 / 펼침 상태가 reload 시 초기화.
  localStorage 활용 미지원.
- ❌ **incremental rebuild** — `extractedDir` 의 일부만 변경되었을 때 partial
  rebuild 안 함. 전체 재생성.

## 9. Resolved questions

- **왜 `<script src>` 글로벌 injection 인가, JSON file + fetch 가 더 깨끗한데?**
  `file://` 프로토콜에서 `fetch('data/...')` 는 CORS / scheme 제한으로 fail.
  `<script src>` 는 동일 origin policy 의 예외 (legacy compat) 라 작동.
  외부 web server 없이 USB / 로컬 파일 시스템 배포가 dashboard 의 가치
  핵심.
- **single-file 모드의 사이즈 한계?** ~100MB. 브라우저가 single string 으로
  parse 해야 해 메모리 압박 + 파싱 시간 비례 증가. 이 범위 밖은 multi-file.
- **page lazy-load 가 sub-page 수준으로 갈 수 있나 (e.g. 큰 페이지의 일부)?**
  현재는 페이지 단위만. 메타리치 6 페이지 / 65K nodes 분포에서 페이지 단위
  lazy-load 가 충분 — 이 grain 이 너무 거치면 사용자 inspecting 시 wait
  체감이 발생할 때 재고려.
- **assets 의 dedup 은 어디서?** dashboard 가 아니라 *upstream* (CLI Stage
  6, `assets.ts`) 에서 sha1 해시 기반으로 이미 dedup. dashboard 는 단순
  복사 — `imagesCopied` count 가 dedup 후 unique image 수.
- **`stripPageForRenderer` 가 single-file 모드에만 적용되는 이유?**
  multi-file 의 page json 은 `data/pages/<n>.js` 로 분리되어 lazy-load —
  inspect 시 raw 정보가 더 풍부. single-file 은 모두 메모리 상주라 trim
  이 비용 대비 가치 큼.
