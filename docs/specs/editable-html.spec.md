# spec/editable-html

| Item | Value |
|---|---|
| Status | Approved (Iteration 10) |
| Owner module | `src/editable-html.ts` (new) |
| Dependencies | `src/tree.ts`, `src/normalize.ts`, `src/assets.ts`, `src/intermediate.ts` |
| Tests | `test/editable-html.test.ts` |
| Parent SPEC | [SPEC-roundtrip §3.3, §3.5 Tier A](../SPEC-roundtrip.md) |
| Dependency spec | [text-segments.spec.md](./text-segments.spec.md) — TEXT node handling |

## 1. Goal

From a Figma tree (`BuildTreeResult`) + assets (images/SVGs), generate the **editable HTML** (`figma.editable.html`). Handles only **Tier A** (HTML-inlined) fields. Tier B is separate; see [sidecar-meta.spec.md](./sidecar-meta.spec.md).

## 2. Input

```ts
interface EditableHtmlInputs {
  tree: BuildTreeResult;          // built node tree (35,660 nodes)
  decoded: DecodedFig;            // schema, message (for raw blob references)
  container: ContainerResult;     // meta.json, images Map
  outputDir: string;              // assets/ source (existing output/)
  htmlOutDir: string;             // output directory (default: extracted/07_editable/)
  options?: {
    singleFile?: boolean;         // default false (Decision D-2)
    cssExternal?: boolean;        // default true (directory mode)
    includeRawAttrs?: boolean;    // default false (raw fields go to sidecar)
  };
}
```

## 3. Output

Directory mode (default):
```
<htmlOutDir>/
├── figma.editable.html        ← this spec's responsibility
├── figma.editable.css         ← this spec's responsibility
└── README.md                  ← this spec's responsibility (editing guide)
```

(figma.editable.meta.js and assets/ belong to other specs/modules.)

Each file's format satisfies the invariants in §4.

## 4. Invariants

### I-1 GUID 1:1 mapping

Every GUID in `tree.allNodes` appears as exactly one element in the output HTML.

```
∀ guid ∈ tree.allNodes:
   |document.querySelectorAll(`[data-figma-id="${guid}"]`)| === 1
```

### I-2 Parent-child DOM preservation

Each node's parent-child relationship matches the DOM parent-child relationship. A CANVAS's direct children are placed within the page, and tree depth is preserved.

```
∀ child ∈ tree.allNodes, child.parentGuid !== null:
   parentEl(child) === htmlElementOf(child.parentGuid)
```

### I-3 Sibling order = position order

Among siblings under the same parent, DOM ordering matches the `parentIndex.position` string order (fractional indexing).

```
∀ siblings ∈ same parent, sorted by position:
   indexInDom(s_i) < indexInDom(s_{i+1})
```

### I-4 CSS representation of Tier A fields

Every field in the [SPEC-roundtrip §3.5 Tier A table](../SPEC-roundtrip.md#35-editable-area-table--all-raw-fields-editable--decision-d-1) is represented as the element's inline style or a data-* attribute.

Highlights:
- `size.x`, `size.y` → CSS `width`, `height` (px)
- `transform` (m02, m12) → CSS `left`, `top` (px); if m00, m01, m10, m11 are not identity, also add `transform: matrix(...)`
- `opacity` → CSS `opacity`
- `visible: false` → CSS `display: none`
- `cornerRadius` (or the 4 `cornerRadii`) → CSS `border-radius`
- `fillPaints[0].type=SOLID` → `background-color`
- `fillPaints[0].type=IMAGE` → `background-image: url(assets/images/<hash>.<ext>)`
- `fillPaints[0].type=GRADIENT_*` → `background: linear-gradient(...)` and similar (best-effort)
- `strokePaints[0].color` + `strokeWeight` → `border-color`, `border-width`, `border-style: solid`
- `effects[]` → CSS `box-shadow` (DROP_SHADOW), `filter: blur` (LAYER_BLUR), `backdrop-filter: blur` (BACKGROUND_BLUR)
- `blendMode` → CSS `mix-blend-mode`
- TEXT nodes follow [text-segments.spec.md](./text-segments.spec.md) and split into `<span>`s

### I-5 data-figma-* attribute preservation

The following attributes are always present on every element:
- `data-figma-id` (GUID string "S:L")
- `data-figma-type` (Figma node type)
- `data-figma-position` (parentIndex.position string; null for document / orphan)

Optional:
- `data-figma-name` (when the node name is present)
- `data-figma-editable` (whitespace-separated list of editable fields)
- `data-figma-blob-refs` (JSON array of blob indices referenced, when present)

### I-6 Determinism

Same input → same output. Byte-identical except timestamps.

```
sha256(generate(input)) === sha256(generate(input))
```

(Timestamp fields like `<meta name="generated-at">` in the document head are explicitly excluded.)

### I-7 Compatibility metadata

The HTML `<body>` or `<html>` contains the following information (for sidecar sync):
- `data-figma-roundtrip="v2"` (format version)
- `data-figma-archive-version` (e.g. "106")
- `data-figma-source-fig-sha256` (sha of the source .fig)
- `data-figma-schema-sha256` (sha of the schema binary)

### I-8 Page structure

Each CANVAS node is represented as `<section class="fig-page">`. CANVAS acts as the per-page visual container (background, size, etc.).

### I-9 Preservation of unknown node types

Types not listed in [text-segments.spec.md](./text-segments.spec.md) or [SPEC-roundtrip §3.3](../SPEC-roundtrip.md) (`VARIABLE_SET`, `BRUSH`, `CODE_LIBRARY`, etc.) are represented as `<div class="fig-unknown" data-figma-type="...">`, with raw preserved in the sidecar.

### I-10 Single-file mode (option)

When `options.singleFile === true`, CSS and the sidecar (other module) are merged into inline `<style>` / `<script>` blocks.

## 5. Error Cases

- E-1: `tree.document === null` → throw `Error("editable-html: no DOCUMENT root")`. Empty .fig is not supported.
- E-2: No write permission on `htmlOutDir` → throw (propagates the Node fs error as-is).
- E-3: Unknown paint type → ignore in CSS, log via console.warn (leave `<style>` empty; raw goes to sidecar).
- E-4: Very deep tree (recursion depth > 1000) → throw `Error("editable-html: tree too deep")` (current samples are ~10 deep).
- E-5: Duplicate GUID (should not happen in a tree, but defensively) → throw.

## 6. Out of Scope

- O-1: Sidecar JSON generation — [sidecar-meta.spec.md](./sidecar-meta.spec.md).
- O-2: HTML → message reverse conversion — [html-to-message.spec.md](./html-to-message.spec.md).
- O-3: Node addition (D-4) — v3.
- O-4: Automatic CSS Flexbox/Grid conversion — v3.
- O-5: 100% visual parity with Figma rendering — best-effort only.
- O-6: Lazy loading of very large pages (e.g. the WEB 29,029-node case) — v2 default is single-page inline; lazy loading is a follow-up improvement.
- O-7: Interaction / animation visualization (Figma prototype) — only Tier B sidecar preservation.
- O-8: TEXT segment conversion → [text-segments.spec.md](./text-segments.spec.md).

## 7. References

- Parent: [SPEC-roundtrip.md](../SPEC-roundtrip.md) §3 (HTML format).
- Methodology: [SDD.md](../SDD.md), [HARNESS.md](../HARNESS.md).
- Existing: `src/normalize.ts` (partial Tier A representation), `src/assets.ts`.
- Siblings: [sidecar-meta.spec.md](./sidecar-meta.spec.md), [text-segments.spec.md](./text-segments.spec.md).
