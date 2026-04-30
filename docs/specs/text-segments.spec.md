# spec/text-segments

| 항목 | 값 |
|---|---|
| 상태 | Approved (Iteration 10) |
| 책임 모듈 | `src/text-segments.ts` (신규) |
| 의존 | `src/types.ts` (KiwiNode), CSS 파싱 (간이) |
| 테스트 | `test/text-segments.test.ts` |
| 부모 SPEC | [SPEC-roundtrip §3.3.1, Decision D-5](../SPEC-roundtrip.md) |
| 의존 spec | [editable-html.spec.md](./editable-html.spec.md), [html-to-message.spec.md](./html-to-message.spec.md) |

## 1. 목적

Figma TEXT 노드의 **rich text segment** (한 노드 내 여러 스타일 영역) ↔ HTML `<span>` chunk 양방향 변환.

Figma TEXT 노드 구조:
- `characters: string` — 전체 텍스트
- `characterStyleIDs: number[]` — 각 character의 style index (length === characters.length)
- `styleOverrideTable: Record<number, Style>` — style index → 스타일 객체

HTML 표현:
```html
<p class="fig-text" data-figma-id="..." style="font-size: 16px; color: #000">
  <span data-style-id="0">일반 </span>
  <span data-style-id="1" style="font-weight: 700">굵은</span>
  <span data-style-id="2"> 글자</span>
</p>
```

## 2. 입력 (양방향)

### 2.1 Figma → HTML (forward)

```ts
interface SegmentToHtmlInput {
  characters: string;
  characterStyleIDs: number[];
  styleOverrideTable: Record<number, FigmaStyle>;
  baseStyle: FigmaStyle;          // 노드 기본 스타일 (style index 0의 implicit)
}
```

### 2.2 HTML → Figma (reverse)

```ts
interface SegmentFromHtmlInput {
  pElement: ParsedElement;        // <p class="fig-text"> 파싱 결과
  baseStyle: FigmaStyle;          // <p>의 inline style에서 추출
}
```

## 3. 출력

### 3.1 Forward

```ts
interface SegmentToHtmlResult {
  htmlChunk: string;              // <span> 시퀀스 (innerHTML, no <p> wrapping)
}
```

### 3.2 Reverse

```ts
interface SegmentFromHtmlResult {
  characters: string;
  characterStyleIDs: number[];
  styleOverrideTable: Record<number, FigmaStyle>;
}
```

## 4. Invariants

### I-1 Round-trip 무손실 (★ 핵심)

```
∀ (chars, ids, overrides):
   forward(chars, ids, overrides, baseStyle)
   → htmlChunk
   → reverse(parse(htmlChunk), baseStyle)
   → (chars', ids', overrides')

   characters === characters'
   ∧ characterStyleIDs === characterStyleIDs' (deep equal)
   ∧ styleOverrideTable === styleOverrideTable' (deep equal)
```

### I-2 Span은 character-aligned

각 `<span>`의 innerText 길이가 character 단위로 정확.

```
∀ span_i ∈ <p>.children:
   span_i의 character 시작 == sum(span_0..i-1.length)
   span_i의 character 끝 == 시작 + span_i.length
   ∀ char in span_i: characterStyleIDs[char] === span_i.dataStyleId
```

### I-3 Style override 최소 표현

같은 style 객체는 styleOverrideTable에서 한 번만 등장.

```
∀ s1, s2 ∈ styleOverrideTable:
   s1 deep equal s2 ⇒ s1과 s2는 같은 키
```

(reverse 시 자동 dedup)

### I-4 Base style 재구성

`<p>` element의 inline style이 노드 기본 스타일. span에 명시 안 한 속성은 `<p>`에서 상속.

```
spanStyleResolved = { ...baseStyle, ...spanStyle }
```

### I-5 빈 segment 처리

빈 `<span></span>`은 무시 (length 0). 빈 `characters: ""` 입력은 빈 `<span data-style-id="0"></span>` 1개 반환.

### I-6 줄바꿈

Figma의 `\n` (line break) → HTML `<br>` (또는 span 내부 `\n` + `white-space: pre-wrap`).

reverse 시:
- `<br>` → `\n`
- span 내부의 `\n`은 그대로 (CSS white-space pre-wrap에 의존)

### I-7 CSS 단위 정확성

다음 CSS → Figma 매핑은 무손실:

| CSS | Figma | 비고 |
|---|---|---|
| `font-size: 14px` | `fontSize: 14` | px만 (em/rem은 baseStyle 기준 환산) |
| `font-family: 'Inter'` | `fontName.family: 'Inter'` | 따옴표 trim |
| `font-weight: 700` | `fontName.style: 'Bold'` (또는 매칭되는 weight name) | 매핑 표 참조 |
| `font-style: italic` | `fontName.style: 'Italic'` | |
| `line-height: 1.5` | `lineHeight: { unit: 'PERCENT', value: 150 }` | unitless·%·px 별도 |
| `letter-spacing: 0.5px` | `letterSpacing: { unit: 'PIXELS', value: 0.5 }` | |
| `color: rgba(...)` | TEXT segment fill | |
| `text-decoration: underline` | `textDecoration: 'UNDERLINE'` | |
| `text-transform: uppercase` | `textCase: 'UPPER'` | |

### I-8 Span dedup 룰

연속한 span이 동일 style이면 reverse 시 합쳐도 round-trip 동등 (characterStyleIDs는 같은 ID 연속).

## 5. Error Cases

- E-1: Forward — `characterStyleIDs.length !== characters.length` → throw `"text-segments: id length mismatch"`
- E-2: Forward — `styleOverrideTable`에 ID 없음 → warning, baseStyle 사용
- E-3: Reverse — `<span>` 외 다른 element 발견 → strict면 throw, 아니면 plain text 추출
- E-4: Reverse — `data-style-id`가 number 아님 → 자동 발급 (max + 1)
- E-5: Reverse — span 내부에 `<img>` 등 미디어 → ignore + warning
- E-6: 매우 긴 텍스트 (>1MB) → 가능, 단 성능 경고

## 6. Out of Scope

- O-1: TEXT 외 노드 — 본 spec은 TEXT 한정
- O-2: 인라인 링크 (`<a>`) 표현 — Figma TEXT는 hyperlinks 별도 메타 (sidecar)
- O-3: list (ol, ul) — Figma는 `bulletType` 메타로 표현, 본 v2에서는 plain text로 평면화
- O-4: rich text 외부 import (paste from Word) 자동 변환 — 사용자가 plain HTML 따라야 함
- O-5: 양방향 polyfill — 사용자가 HTML 손상 시엔 best-effort

## 7. 매핑 표 (font-weight ↔ Figma style name)

| CSS font-weight | Figma fontName.style (대표) |
|---|---|
| 100 | Thin |
| 200 | Extra Light |
| 300 | Light |
| 400 | Regular |
| 500 | Medium |
| 600 | Semi Bold |
| 700 | Bold |
| 800 | Extra Bold |
| 900 | Black |

`+ italic` 일 때: `fontName.style = "Bold Italic"` 등 (font에 따라).

`postscript` 필드는 best-effort: family + style → `"Inter-Bold"` 형태로 합성.

## 8. 참조

- 부모: [SPEC-roundtrip §3.3.1](../SPEC-roundtrip.md), Decision D-5
- 형제: [editable-html.spec.md](./editable-html.spec.md), [html-to-message.spec.md](./html-to-message.spec.md)
