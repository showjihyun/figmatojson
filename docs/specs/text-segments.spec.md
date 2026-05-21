# spec/text-segments

| Item | Value |
|---|---|
| Status | Approved (Iteration 10) |
| Responsible module | `src/text-segments.ts` (new) |
| Dependencies | `src/types.ts` (KiwiNode), CSS parsing (lightweight) |
| Tests | `test/text-segments.test.ts` |
| Parent SPEC | [SPEC-roundtrip §3.3.1, Decision D-5](../SPEC-roundtrip.md) |
| Dependent specs | [editable-html.spec.md](./editable-html.spec.md), [html-to-message.spec.md](./html-to-message.spec.md) |

## 1. Purpose

Bidirectional conversion between a Figma TEXT node's **rich text segments** (multiple styled regions within a single node) and HTML `<span>` chunks.

Figma TEXT node structure:
- `characters: string` — full text
- `characterStyleIDs: number[]` — style index per character (length === characters.length)
- `styleOverrideTable: Record<number, Style>` — style index → style object

HTML representation:
```html
<p class="fig-text" data-figma-id="..." style="font-size: 16px; color: #000">
  <span data-style-id="0">Plain </span>
  <span data-style-id="1" style="font-weight: 700">Bold</span>
  <span data-style-id="2"> text</span>
</p>
```

## 2. Inputs (bidirectional)

### 2.1 Figma → HTML (forward)

```ts
interface SegmentToHtmlInput {
  characters: string;
  characterStyleIDs: number[];
  styleOverrideTable: Record<number, FigmaStyle>;
  baseStyle: FigmaStyle;          // node's base style (implicit style index 0)
}
```

### 2.2 HTML → Figma (reverse)

```ts
interface SegmentFromHtmlInput {
  pElement: ParsedElement;        // parsed result for <p class="fig-text">
  baseStyle: FigmaStyle;          // extracted from <p>'s inline style
}
```

## 3. Outputs

### 3.1 Forward

```ts
interface SegmentToHtmlResult {
  htmlChunk: string;              // <span> sequence (innerHTML, no <p> wrapping)
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

### I-1 Lossless round-trip (★ core)

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

### I-2 Spans are character-aligned

Each `<span>`'s innerText length is exact in character units.

```
∀ span_i ∈ <p>.children:
   character start of span_i == sum(span_0..i-1.length)
   character end of span_i == start + span_i.length
   ∀ char in span_i: characterStyleIDs[char] === span_i.dataStyleId
```

### I-3 Minimal style override representation

The same style object appears only once in styleOverrideTable.

```
∀ s1, s2 ∈ styleOverrideTable:
   s1 deep equal s2 ⇒ s1 and s2 are the same key
```

(automatic dedup during reverse)

### I-4 Base style reconstruction

The `<p>` element's inline style is the node's base style. Properties not specified on a span inherit from `<p>`.

```
spanStyleResolved = { ...baseStyle, ...spanStyle }
```

### I-5 Empty segment handling

Empty `<span></span>` is ignored (length 0). Empty `characters: ""` input returns a single empty `<span data-style-id="0"></span>`.

### I-6 Line breaks

Figma's `\n` (line break) → HTML `<br>` (or `\n` inside the span + `white-space: pre-wrap`).

On reverse:
- `<br>` → `\n`
- `\n` inside a span is kept as-is (relies on CSS white-space pre-wrap)

### I-7 CSS unit accuracy

The following CSS → Figma mappings are lossless:

| CSS | Figma | Notes |
|---|---|---|
| `font-size: 14px` | `fontSize: 14` | px only (em/rem are converted relative to baseStyle) |
| `font-family: 'Inter'` | `fontName.family: 'Inter'` | quotes trimmed |
| `font-weight: 700` | `fontName.style: 'Bold'` (or matching weight name) | see mapping table |
| `font-style: italic` | `fontName.style: 'Italic'` | |
| `line-height: 1.5` | `lineHeight: { unit: 'PERCENT', value: 150 }` | unitless/%/px treated separately |
| `letter-spacing: 0.5px` | `letterSpacing: { unit: 'PIXELS', value: 0.5 }` | |
| `color: rgba(...)` | TEXT segment fill | |
| `text-decoration: underline` | `textDecoration: 'UNDERLINE'` | |
| `text-transform: uppercase` | `textCase: 'UPPER'` | |

### I-8 Span dedup rule

If consecutive spans share an identical style, they can be merged on reverse without breaking round-trip equivalence (characterStyleIDs become a run of the same ID).

## 5. Error Cases

- E-1: Forward — `characterStyleIDs.length !== characters.length` → throw `"text-segments: id length mismatch"`
- E-2: Forward — ID not in `styleOverrideTable` → warning, use baseStyle
- E-3: Reverse — element other than `<span>` encountered → throw if strict, otherwise extract as plain text
- E-4: Reverse — `data-style-id` is not a number → auto-allocate (max + 1)
- E-5: Reverse — media like `<img>` inside a span → ignore + warning
- E-6: Very long text (>1MB) → allowed but with a performance warning

## 6. Out of Scope

- O-1: Nodes other than TEXT — this spec is TEXT only
- O-2: Inline link (`<a>`) representation — Figma TEXT carries hyperlinks as separate metadata (sidecar)
- O-3: Lists (ol, ul) — Figma represents these with the `bulletType` meta; v2 flattens to plain text
- O-4: Automatic conversion of external rich text imports (paste from Word) — users must follow plain HTML
- O-5: Bidirectional polyfill — best-effort if the user corrupts the HTML

## 7. Mapping table (font-weight ↔ Figma style name)

| CSS font-weight | Figma fontName.style (representative) |
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

With `+ italic`: `fontName.style = "Bold Italic"`, etc. (font-dependent).

The `postscript` field is best-effort: family + style → composed as `"Inter-Bold"`.

## 8. References

- Parent: [SPEC-roundtrip §3.3.1](../SPEC-roundtrip.md), Decision D-5
- Siblings: [editable-html.spec.md](./editable-html.spec.md), [html-to-message.spec.md](./html-to-message.spec.md)
