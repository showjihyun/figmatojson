# spec/editable-html

| 항목 | 값 |
|---|---|
| 상태 | Approved (Iteration 10) |
| 책임 모듈 | `src/editable-html.ts` (신규) |
| 의존 | `src/tree.ts`, `src/normalize.ts`, `src/assets.ts`, `src/intermediate.ts` |
| 테스트 | `test/editable-html.test.ts` |
| 부모 SPEC | [SPEC-roundtrip §3.3, §3.5 Tier A](../SPEC-roundtrip.md) |
| 의존 spec | [text-segments.spec.md](./text-segments.spec.md) — TEXT 노드 처리 |

## 1. 목적

Figma 트리(`BuildTreeResult`) + 에셋(이미지/SVG) → **편집 가능 HTML** (`figma.editable.html`) 생성. **Tier A** (HTML 인라인) 필드만 처리. Tier B는 [sidecar-meta.spec.md](./sidecar-meta.spec.md) 별도.

## 2. 입력

```ts
interface EditableHtmlInputs {
  tree: BuildTreeResult;          // 빌드된 노드 트리 (35,660 노드)
  decoded: DecodedFig;            // schema, message (raw blobs 참조용)
  container: ContainerResult;     // meta.json, images Map
  outputDir: string;              // assets/ 출처 (기존 output/)
  htmlOutDir: string;             // 출력 디렉토리 (기본: extracted/07_editable/)
  options?: {
    singleFile?: boolean;         // default false (Decision D-2)
    cssExternal?: boolean;        // default true (디렉토리 모드)
    includeRawAttrs?: boolean;    // default false (raw 필드는 sidecar로)
  };
}
```

## 3. 출력

디렉토리 모드 (default):
```
<htmlOutDir>/
├── figma.editable.html        ← 본 spec 책임
├── figma.editable.css         ← 본 spec 책임
└── README.md                  ← 본 spec 책임 (편집 가이드)
```

(figma.editable.meta.js와 assets/는 다른 spec/모듈 책임)

각 파일 형식은 §4의 invariant 만족.

## 4. Invariants

### I-1 GUID 1:1 매핑

모든 `tree.allNodes`의 GUID는 출력 HTML 안에 정확히 1개의 element로 등장한다.

```
∀ guid ∈ tree.allNodes:
   |document.querySelectorAll(`[data-figma-id="${guid}"]`)| === 1
```

### I-2 Parent-child DOM 보존

각 노드의 부모-자식 관계가 HTML DOM의 부모-자식 관계와 일치한다. CANVAS의 직속 자식들은 페이지 안에 배치되며, 트리 깊이가 보존된다.

```
∀ child ∈ tree.allNodes, child.parentGuid !== null:
   parentEl(child) === htmlElementOf(child.parentGuid)
```

### I-3 형제 순서 = position 순서

같은 부모 아래 형제 element들의 DOM 순서가 `parentIndex.position` 문자열 순서와 일치한다 (fractional indexing).

```
∀ siblings ∈ same parent, sorted by position:
   indexInDom(s_i) < indexInDom(s_{i+1})
```

### I-4 Tier A 필드의 CSS 표현

[SPEC-roundtrip §3.5 Tier A 표](../SPEC-roundtrip.md#35-편집-가능-영역-표--모든-raw-필드-편집-가능--decision-d-1)의 모든 필드가 element의 inline style 또는 data-* 속성으로 표현된다.

핵심:
- `size.x`, `size.y` → CSS `width`, `height` (px)
- `transform` (m02, m12) → CSS `left`, `top` (px); m00, m01, m10, m11이 identity가 아니면 `transform: matrix(...)` 추가
- `opacity` → CSS `opacity`
- `visible: false` → CSS `display: none`
- `cornerRadius` (또는 `cornerRadii` 4개) → CSS `border-radius`
- `fillPaints[0].type=SOLID` → `background-color`
- `fillPaints[0].type=IMAGE` → `background-image: url(assets/images/<hash>.<ext>)`
- `fillPaints[0].type=GRADIENT_*` → `background: linear-gradient(...)` 등 (best-effort)
- `strokePaints[0].color` + `strokeWeight` → `border-color`, `border-width`, `border-style: solid`
- `effects[]` → CSS `box-shadow` (DROP_SHADOW), `filter: blur` (LAYER_BLUR), `backdrop-filter: blur` (BACKGROUND_BLUR)
- `blendMode` → CSS `mix-blend-mode`
- TEXT 노드는 [text-segments.spec.md](./text-segments.spec.md) 따라 `<span>` 분할

### I-5 data-figma-* 속성 보존

다음 attribute는 모든 element에 항상 존재:
- `data-figma-id` (GUID 문자열 "S:L")
- `data-figma-type` (Figma 노드 타입)
- `data-figma-position` (parentIndex.position 문자열, document·orphan은 null)

선택적:
- `data-figma-name` (노드 이름이 있을 때)
- `data-figma-editable` (편집 가능 필드 공백 구분 리스트)
- `data-figma-blob-refs` (참조하는 blob 인덱스 JSON 배열, 있을 때)

### I-6 결정성

같은 입력 → 같은 출력. 타임스탬프 외 모든 byte 동등.

```
sha256(generate(input)) === sha256(generate(input))
```

(문서 head의 `<meta name="generated-at">` 같은 타임스탬프 필드는 명시 제외)

### I-7 호환 메타

HTML `<body>` 또는 `<html>`에 다음 정보 포함 (sidecar 동기화용):
- `data-figma-roundtrip="v2"` (포맷 버전)
- `data-figma-archive-version` (예: "106")
- `data-figma-source-fig-sha256` (원본 .fig sha)
- `data-figma-schema-sha256` (schema 바이너리 sha)

### I-8 페이지 구조

각 CANVAS 노드는 `<section class="fig-page">`로 표현된다. CANVAS는 페이지 단위 시각 컨테이너로 동작한다 (background, 사이즈 등).

### I-9 알 수 없는 노드 타입 보존

[text-segments.spec.md](./text-segments.spec.md), [SPEC-roundtrip §3.3](../SPEC-roundtrip.md)에 명시되지 않은 타입(`VARIABLE_SET`, `BRUSH`, `CODE_LIBRARY` 등)은 `<div class="fig-unknown" data-figma-type="...">`로 표현하되 raw는 sidecar로 보존.

### I-10 단일 파일 모드 (옵션)

`options.singleFile === true` 시 CSS와 sidecar(다른 모듈)가 inline `<style>`/`<script>` 블록으로 합쳐짐.

## 5. Error Cases

- E-1: `tree.document === null` → throw `Error("editable-html: no DOCUMENT root")`. 빈 .fig는 미지원.
- E-2: `htmlOutDir` 작성 권한 없음 → throw (Node fs 에러 그대로 전파)
- E-3: 알 수 없는 paint type → CSS 무시, console.warn (`<style>` 비우고 raw는 sidecar에)
- E-4: 매우 깊은 트리 (재귀 깊이 > 1000) → throw `Error("editable-html: tree too deep")` (현재 sample은 ~10 정도)
- E-5: 같은 GUID 중복 (트리에서 안 일어나야 하나 방어) → throw

## 6. Out of Scope

- O-1: Sidecar JSON 생성 — [sidecar-meta.spec.md](./sidecar-meta.spec.md)
- O-2: HTML → message 역변환 — [html-to-message.spec.md](./html-to-message.spec.md)
- O-3: 노드 추가 (D-4) — v3
- O-4: CSS Flexbox/Grid 자동 변환 — v3
- O-5: 시각 100% Figma 렌더와 동등 — best-effort
- O-6: 매우 큰 페이지 (예: WEB 29,029 노드) lazy load — v2 default는 단일 페이지 inline; lazy load는 후속 개선
- O-7: 인터랙션 / 애니메이션 시각화 (Figma prototype) — Tier B sidecar 보존만
- O-8: TEXT segment 변환 → [text-segments.spec.md](./text-segments.spec.md)

## 7. 참조

- 부모: [SPEC-roundtrip.md](../SPEC-roundtrip.md) §3 (HTML 형식)
- 메서드론: [SDD.md](../SDD.md), [HARNESS.md](../HARNESS.md)
- 기존: `src/normalize.ts` (Tier A 표현 일부), `src/assets.ts`
- 형제: [sidecar-meta.spec.md](./sidecar-meta.spec.md), [text-segments.spec.md](./text-segments.spec.md)
