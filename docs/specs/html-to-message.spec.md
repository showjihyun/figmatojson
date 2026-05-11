# spec/html-to-message

| Item | Value |
|---|---|
| Status | Approved (Iteration 10) |
| Owner module | `src/html-to-message.ts` (new) |
| Dependencies | `src/decoder.ts` (schema), `src/assets.ts::hashToHex`, htmlparser2 (parsing) |
| Tests | `test/html-to-message.test.ts` |
| Parent SPEC | [SPEC-roundtrip §4](../SPEC-roundtrip.md) |
| Dependency specs | [text-segments.spec.md](./text-segments.spec.md), [parent-index-position.spec.md](./parent-index-position.spec.md) |

## 1. Goal

From the editable HTML (`figma.editable.html`) + sidecar (`figma.editable.meta.js`), produce an updated KiwiMessage object. Pass that object to `kiwi.compileSchema(schema).encodeMessage(msg)` to generate a new .fig.

## 2. Input

```ts
interface HtmlToMessageInputs {
  htmlPath: string;               // path to figma.editable.html
  sidecarPath?: string;           // figma.editable.meta.js (default: same directory as htmlPath)
  schema: kiwi.Schema;            // schema of the source .fig (taken from extraction)
  options?: {
    strict?: boolean;             // default true. fail fast on format error vs warning only
    onUnknownElement?: 'ignore' | 'preserve' | 'error';  // default 'preserve' — preserve raw from sidecar
  };
}
```

## 3. Output

```ts
interface HtmlToMessageResult {
  message: KiwiMessage;           // updated nodeChanges included
  stats: {
    nodesTotal: number;           // total nodes (original + changed)
    nodesEditedTierA: number;     // nodes edited via HTML
    nodesEditedTierB: number;     // nodes edited via sidecar
    nodesRemoved: number;         // missing from DOM (REMOVED phase)
    nodesAddedAttempted: number;  // newly added in DOM (must be 0 — D-4 not supported in v2)
    warnings: string[];           // potentially-lossy items (e.g. unknown paint type)
  };
}
```

## 4. Invariants

### I-1 100% GUID preservation

Every GUID in the original sidecar appears in the result message (including REMOVED).

```
∀ guid ∈ sidecar.nodes:
   ∃ nc ∈ message.nodeChanges, string of nc.guid === guid
```

### I-2 Reject node additions (D-4)

If an element in DOM lacks `data-figma-id`:
- `options.onUnknownElement === 'error'` → throw
- `'preserve'` (default) → warning only, not added to the result message
- `'ignore'` → silent skip

```
options.strict === true ∧ element without data-figma-id exists
   ⇒ throw or include in warnings explicitly
```

(This invariant changes once v3 supports node addition.)

### I-3 Tier A > Tier B priority

If a field represented in HTML differs from the sidecar value, the HTML value wins.

```
∀ guid, ∀ field ∈ Tier A:
   tierAValue(html, guid, field) !== undefined
   ⇒ result.nodes[guid][field] === tierAValue
```

### I-4 Byte-level equality for untouched nodes

Nodes the user did not edit keep raw fields byte-identical to the original.

```
∀ guid, ∀ field:
   editedInHtml(guid, field) === false
   ∧ editedInSidecar(guid, field) === false
   ⇒ result.nodes[guid][field] === original.nodes[guid][field]
```

### I-5 Tier C auto-population

The tool automatically populates:
- `guid`: restored from HTML element's `data-figma-id` (`"S:L"` → `{sessionID:S, localID:L}`)
- `parentIndex.guid`: HTML parent element's `data-figma-id`
- `parentIndex.position`: recomputed from DOM sibling order — see [parent-index-position.spec.md](./parent-index-position.spec.md)
- `phase`:
  - Present in DOM and in sidecar → keep original phase (usually `CREATED`)
  - Present in DOM but missing from sidecar → `CREATED` (v3 node addition)
  - Missing from DOM but present in sidecar → `REMOVED`

### I-6 CSS reverse-conversion rules

All mappings in [SPEC-roundtrip §4.2](../SPEC-roundtrip.md) are bidirectional.

Highlights:
- `width: Npx` → `size.x = N`
- `height: Npx` → `size.y = N`
- `left: Xpx; top: Ypx` → `transform.m02 = X; m12 = Y`
- `transform: matrix(a,b,c,d,e,f)` → `m00=a, m10=b, m01=c, m11=d, m02=e, m12=f`
- `background-color: rgba(R,G,B,A)` → `fillPaints = [{type:'SOLID', color:{r:R/255, g:G/255, b:B/255, a:A}, visible:true, opacity:1, blendMode:'NORMAL'}]`
- `background-color: transparent` → `fillPaints = []`
- `opacity: O` → `opacity = O`
- `display: none` → `visible = false`
- `border-radius: Rpx` → `cornerRadius = R` (or split into 4 cornerRadii)
- `border: Wpx solid color` → `strokePaints[0] = {type:'SOLID', color}; strokeWeight = W`
- `box-shadow: X Y B [S] color [inset]` → `effects[]` (DROP_SHADOW or INNER_SHADOW)
- `filter: blur(Npx)` → `effects[] += {type:'LAYER_BLUR', radius:N}`
- `backdrop-filter: blur(Npx)` → `effects[] += {type:'BACKGROUND_BLUR', radius:N}`
- `mix-blend-mode: X` → `blendMode = X.toUpperCase()`
- `font-size: Npx` → TEXT `fontSize = N`
- `font-family: F1, F2, ...` → TEXT `fontName.family = F1` (first family)
- `color: rgba(...)` → TEXT `fillPaints[0].color`
- `text-align: X` → `textAlignHorizontal = X.toUpperCase()`
- TEXT node segments → rules in [text-segments.spec.md](./text-segments.spec.md)

### I-7 SVG path → commandsBlob re-encoding (best-effort)

When the `d` attribute on `<svg><path d="..."/></svg>` changes, parse the path commands → regenerate the commandsBlob byte stream.

On success: blob updated, message preserved.
On failure (unsupported SVG path command): warning + keep the original commandsBlob.

```
SVG path 'M0 0 L10 10' → bytes [0x01, 0x00*8, 0x02, 0x00*4, 0x41200000*2 ...]
```

See Appendix A in this spec for the detailed mapping.

### I-8 Top-level message preservation

`message.type`, `message.sessionID`, `message.ackID`, and other top-level fields are restored from the sidecar's `__meta` + `message`.

### I-9 Determinism

Same HTML + sidecar → same message (byte-level).

## 5. Error Cases

| ID | Condition | Behavior |
|---|---|---|
| E-1 | HTML parse failed (malformed) | throw `Error("html-to-message: parse error at line N")` |
| E-2 | Sidecar load failed (no `window.FIGMA_RAW`) | throw |
| E-3 | Sidecar `__meta.archiveVersion` does not match schema-compatible archiveVersion | throw `"version mismatch"` |
| E-4 | Malformed data-figma-id (e.g. "abc") | throw under strict, otherwise skip + warning |
| E-5 | Parent-child cycle (somehow broken HTML) | throw |
| E-6 | Sibling position recomputation failed | throw, see [parent-index-position.spec.md](./parent-index-position.spec.md) |
| E-7 | Malformed TEXT segment (`<span data-style-id="...">` broken) | throw under strict, otherwise plain-text fallback + warning |
| E-8 | CSS value parse failure (e.g. `width: NaN`) | warning, keep original value |

## 6. Out of Scope

- O-1: HTML generation — [editable-html.spec.md](./editable-html.spec.md).
- O-2: Node addition (D-4) — v3.
- O-3: kiwi encode + compression + ZIP packaging — reuse `repack.ts` (separate step).
- O-4: Schema modification — schema is taken as input and used as-is.
- O-5: User-introduced types outside the schema — ignored, or error under strict.
- O-6: Blob semantics changes (raw byte edits to blobs other than commandsBlob) — applied only when bytes were edited in the sidecar; semantic validation is not performed.

## 7. Appendix A — SVG path → commandsBlob mapping

| SVG command | commandsBlob byte | float32 args |
|---|---|---|
| `M x y` | 0x01 | x, y |
| `L x y` | 0x02 | x, y |
| `C c1x c1y c2x c2y x y` | 0x03 | 6 floats |
| `Q cx cy x y` | 0x04 | 4 floats |
| `Z` | 0x05 | (none) |

Not supported (warning):
- `H`, `V` (horizontal/vertical only) — convertible to `L`; converted without exception.
- `S`, `T` (smooth) — infer the previous control point, convert to `C`/`Q`.
- `A` (arc) — best-effort: arc → cubic Bezier approximation.

## 8. References

- Parent: [SPEC-roundtrip §4](../SPEC-roundtrip.md).
- Siblings: [editable-html.spec.md](./editable-html.spec.md), [sidecar-meta.spec.md](./sidecar-meta.spec.md).
- Dependencies: [text-segments.spec.md](./text-segments.spec.md), [parent-index-position.spec.md](./parent-index-position.spec.md).
