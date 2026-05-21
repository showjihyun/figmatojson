# SPEC: Figma → pencil.dev copy/paste conversion

**Status**: reverse-engineering complete (Pencil v1.1.55, based on app.asar analysis)
**Last updated**: 2026-05-01
**Audit baseline**: `docs/sample.pen` (pencil.dev paste result)

This document captures the conversion rules applied when Figma's `.fig` binary data is copy/pasted into pencil.dev. It is the SPEC that guarantees this project's `pen-export` output matches the pencil.dev paste result.

---

## 1. Data flow overview

```
.fig (binary)
  │
  ├── kiwi-schema decode → message {nodeChanges[], blobs[]}
  │
  ├── INSTANCE expansion
  │     ├── clone master tree
  │     ├── apply symbolOverrides (propagated into nested INSTANCEs)
  │     ├── apply derivedSymbolData (stamp Figma's pre-resolved values)
  │     └── handle overriddenSymbolID (instance swap)
  │
  ├── per-node .pen conversion
  │     ├── visual properties: fill, stroke, cornerRadius, opacity, effects
  │     ├── layout: layout / gap / padding / justifyContent / alignItems
  │     ├── sizing policy: Fixed / FillContainer / FitContent
  │     ├── position: emitted or omitted depending on parent layout
  │     ├── text: fontFamily / fontWeight / fontSize / lineHeight / letterSpacing
  │     └── path geometry: decode vectorNetworkBlob per VECTOR node
  │
  └── .pen JSON serialization
```

---

## 2. INSTANCE expansion rules

### 2.1 Applying symbolOverrides

**Input shape** (`symbolData.symbolOverrides[]` on a Figma `.fig` INSTANCE node):
```ts
{ guidPath: { guids: [{sessionID, localID}, ...] },  // path inside the master tree
  textData?: { characters?: string, lines?: [...] },
  visible?: boolean,
  size?: {x, y},
  cornerRadius?: number,
  strokePaints?: [...],
  borderRightWeight?: number,
  /* etc. — overrides for arbitrary master fields */ }
```

**Rules**:

1. **guidPath length = 1**: targets a direct child of the master. **Deep-merge** the override fields into the matching child's `data` (nested objects like textData require partial-key merging — a shallow assign loses master's styleOverrideTable, fontMetaData, etc.).

2. **guidPath length ≥ 2**: targets a node reachable through a nested INSTANCE.
   When a direct child is an INSTANCE (its children are empty — pre-expansion), drop the first element of `guidPath.guids` and **inject** the nested override into that INSTANCE's `symbolData.symbolOverrides`. They will be applied together when that INSTANCE is expanded later.

   **Previous bug**: recursing nested overrides into the (empty) children of a child caused overrides to be lost. In particular, all 6 text overrides of Dropdown options (e.g. "Today", "Last 7 days", ...) disappeared in multi-stage INSTANCEs.

3. **Caveats for direct merges**:
   - A `textData` override only contains `{characters, lines}`, so it must be deep-merged with the master's textData (`{...master.textData, ...override.textData}`).
   - For the same reason `symbolData` must also be deep-merged.

### 2.2 overriddenSymbolID (instance swap)

If an INSTANCE has `data.overriddenSymbolID`, prefer it over the default `symbolData.symbolID` when picking the master. Corresponds to Figma's "Swap instance" feature.

```ts
const sid = instance.overriddenSymbolID ?? instance.symbolData.overriddenSymbolID
         ?? instance.symbolData.symbolID;
const master = symbolIndex.get(`${sid.sessionID}:${sid.localID}`);
```

### 2.3 Applying derivedSymbolData

Data Figma provides as a **per-instance, pre-resolved** snapshot.
Re-resolving from the original master leaves gaps → `derivedSymbolData` is authoritative.

```ts
derivedSymbolData[]: {
  guidPath: { guids: [...] },      // descendant path inside the master tree
  derivedTextData?: {               // for text nodes — fully-resolved font metadata
    layoutSize, baselines, glyphs, fontMetaData, derivedLines, ...
  },
  fillGeometry?: [{ commandsBlob }],  // for vector nodes — per-instance path
  size?: {x, y},                    // actual size at the instance
  transform?: {...},                // actual position at the instance
}
```

Stamp `_derivedTextData`, `_derivedFillGeometry`, `_derivedSize`, `_derivedTransform` markers on the guidPath-matched node's `data`. The text/path branches of `convertNode` prefer these markers.

---

## 3. Color variable alias resolution

Figma paint object:
```ts
{ type: "SOLID",
  color: { r, g, b, a },                  // direct RGBA (may be a placeholder)
  opacity: 1,
  visible: true,
  colorVar?: {                              // Color Variable reference (preferred when present)
    value: { alias: { guid: { sessionID, localID } } },
    dataType: "ALIAS",
    resolvedDataType: "COLOR",
  } }
```

**Rule**: if `colorVar.dataType === "ALIAS"`, follow the alias chain to resolve the actual RGBA and use it instead of paint.color.

**Why**: Figma overrides sometimes stamp paint.color as a placeholder (`{r:1,g:1,b:1,a:1}`) while keeping the alias accurate (the Dropdown stroke `#c4cfddff` vs naive `#ffffffff` case). pencil.dev always follows the alias to obtain the correct color.

**Variable node shape** (`type: "VARIABLE"` inside NodeChanges):
```ts
{ guid, name: "Border/Default",
  variableResolvedType: "COLOR",
  variableDataValues: {
    entries: [{
      modeID,
      variableData: {
        dataType: "ALIAS" | "COLOR",
        value: {
          alias?: { guid: {...} },        // for ALIAS
          colorValue?: { r, g, b, a },    // for COLOR
        },
      },
    }],
  } }
```

The resolver recursively follows the ALIAS chain until it hits a COLOR. Cycles are guarded by a cache.

---

## 4. Sizing policy (TQ + uw + VZ functions)

The exact pencil.dev algorithm (reverse-engineered):

### 4.1 Size classification (per axis, `TQ`)

For each axis (x=Horizontal, y=Vertical), decide in priority order:

```
n = perpendicular axis (the one opposite to the queried axis)
i = parent.stackMode direction (HORIZONTAL/VERTICAL/null)
r = self.stackMode direction

return (
  // parent stack is perpendicular and self is STRETCH → FillContainer
  (i === n && self.stackChildAlignSelf === "STRETCH") ||
  (i === e && self.stackChildPrimaryGrow)
    ? FillContainer :

  // self stack is perpendicular and RESIZE_TO_FIT_WITH_IMPLICIT_SIZE → FitContent
  (r === n && self.stackCounterSizing === "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE")
    ? FitContent :

  // self stack is along and FIXED → Fixed
  (r === e && self.stackPrimarySizing === "FIXED") ||
  (i === e && self.stackChildPrimaryGrow)
    ? Fixed :

  // self stack is along (and not FIXED) → FitContent
  r === e ? FitContent : Fixed
);
```

### 4.2 Size serialization (`uw` + `VZ`)

```
fit_content(N) emit decision (when FitContent):

let hasContent = self.hasLayout()
              && self.children.some(c => c.affectsLayout()
                                       && c.sizingBehavior[axis] !== FillContainer);

if (hasContent) → "fit_content"  (no fallback — children fill the space)
else            → "fit_content(N)"  (fallback N — the size to show when children are empty)
```

Where:
- `affectsLayout()` = `node.enabled && node.position === 0`
  - `enabled` = visible (`visible !== false` AND not toggled false by `componentPropAssignments(VISIBLE)`)
  - `position === 0` = NORMAL (not ABSOLUTE / not FLOATING)
- `hasLayout()` = `stackMode in {HORIZONTAL, VERTICAL}`

**FillContainer follows the same pattern**:
```
if (self.isInLayout()) → "fill_container"  (no fallback needed inside a parent layout)
else                   → "fill_container(N)"  (fallback when the parent is not a layout)
```

### 4.3 Position emit vs omit

When the parent is auto-layout (`stackMode in {HORIZONTAL, VERTICAL}`), child positions are omitted (they are auto-computed). Exceptions where position is emitted:
- `stackPositioning === "ABSOLUTE"` (the child is floating)
- The child is `visible: false` or hidden via prop assignment (it leaves the flow)
- `_showPos: true` (overlap / shrunk reflow marker)

When the parent is not auto-layout (`stackMode === "NONE"` or absent), all children are
**emitted even at coordinate 0** (`x: 0, y: 0`).

---

## 5. Path geometry handling

### 5.1 Source priority

pencil.dev decodes paths directly from `vectorData.vectorNetworkBlob` (the accurate source).
`fillGeometry.commandsBlob` is Figma's pre-computed fill outline whose precision may differ.

**Rules**:
1. master VECTOR node: prefer `vectorData.vectorNetworkBlob`; fall back to `fillGeometry.commandsBlob`.
2. INSTANCE expansion (per-instance path): prefer master's `vectorData.vectorNetworkBlob`; fall back to `derivedSymbolData[].fillGeometry.commandsBlob` (legacy fallback).

### 5.2 vectorNetworkBlob format (reverse-engineered)

All ints are LE uint32; all floats are LE float32:

```
header (12 bytes):
  vertexCount  (uint32)
  segmentCount (uint32)
  regionCount  (uint32)

vertex (12 bytes × vertexCount):
  styleID (uint32)
  x (float32)
  y (float32)

segment (28 bytes × segmentCount):
  styleID (uint32)
  start.vertex (uint32)   // index into vertices
  start.dx (float32)      // tangent vector (control-point delta from the start vertex)
  start.dy (float32)
  end.vertex (uint32)
  end.dx (float32)
  end.dy (float32)

region (variable × regionCount):
  packed (uint32):           // (styleID << 1) | (windingRule_bit)
                             //   bit 0: 1=NONZERO, 0=ODD
  loopCount (uint32)
  loop (variable × loopCount):
    segmentCount (uint32)
    segmentIndex (uint32 × segmentCount)  // indices into segments
```

### 5.3 Path-build algorithm (`xQ`)

```
For each region (or, if zero, treat all segments as one bundle):
  For each loop:
    segs = loop.segments.map(idx => allSegments[idx])
    segs = orientSegments(segs)  // reverse so consecutive endpoints match
    buildPathFromSegments(vertices, segs)
```

**`orientSegments` (`EQ`)**:
- length < 2 → unchanged
- If the first segment's end matches neither the start nor end of the second, reverse the first segment
- For each subsequent segment, if the previous segment's end != the current's start, reverse the current

**`reverseSegment` (`AQ`)**: swap start ↔ end (vertex index, dx, dy all swapped).

**`buildPathFromSegments` (the core loop of `xQ`)**:
```
state: lastVertex, subpathStart
for each segment s:
  a = vertices[s.start.vertex]
  b = vertices[s.end.vertex]

  if lastVertex !== s.start.vertex:
    emit "M{a.x} {a.y}"
    subpathStart = s.start.vertex

  if s.start.dx == 0 && s.start.dy == 0 && s.end.dx == 0 && s.end.dy == 0:
    emit "L{b.x} {b.y}"        // both tangents zero → straight line
  else:
    emit "C{a.x+s.start.dx} {a.y+s.start.dy} {b.x+s.end.dx} {b.y+s.end.dy} {b.x} {b.y}"

  lastVertex = s.end.vertex
  if subpathStart !== undefined && s.end.vertex === subpathStart:
    emit "Z"                    // the subpath has closed back to its start
    lastVertex = undefined
    subpathStart = undefined
```

### 5.4 Absolute → relative conversion (`vpe = dpe(t).rel().round(5)`)

The exact algorithm in the `svgpath` library pencil.dev uses:

**Step 1 — `.rel()`**: convert every command other than the first M to lowercase + relative to the previous point.
- Only the first M stays absolute (uppercase M).
- All other M, L, C, Q become m, l, c, q (lowercase). All arguments subtract the previous point's coordinates to produce deltas.
- Z/z is unchanged.

**Step 2 — `.round(5)`**: **error-accumulation rounding** (not a simple toFixed).
- carry `(c, u)`: accumulated error (original − rounded value) at the previous segment endpoint.
- carry `(a, l)`: the carry at the current subpath start (restored on Z).
- Per segment:
  ```
  if isRel: args[len-2] += c; args[len-1] += u   // accumulate carry into endpoints only
  c = args[len-2] - toFixed(args[len-2], 5)       // new carry = accumulated − rounded
  u = args[len-1] - toFixed(args[len-1], 5)
  for each non-letter arg: args[i] = +args[i].toFixed(5)   // round all args to 5 places
  ```
- M/m: endpoint = args[0,1]. Additionally update subpath-start carry as `a = c, l = u`.
- Z/z: restore carry from subpath start as `c = a, u = l`.

**Why error-accumulation**: rounding each segment independently drifts the accumulated coordinates away from the original. The carry-accumulation approach keeps the accumulated positions accurate.

### 5.5 Path serialization encoding rules (compatible with svgpath `.toString()`)

```
- If the same cmd is consecutive, drop the letter from the second one onward (except M/m — the next cmd is implicit L)
- First argument: glued right after the letter (no space)
- Subsequent arguments:
    - Negative (starts with `-`): the sign itself acts as a separator → no space
    - Positive: single space
- 0 < x < 1: leading zero may optionally be dropped (`0.5` → `.5`).
  ※ Our output keeps the leading zero — matches the pencil.dev reference.
```

**Example**:
- `M11 14 C10.8 14 10.6 14.1 10.5 14.2 C10.3 14.3 10.2 14.5 10.1 14.7`
  → `M11 14c-0.2 0-0.4 0.1-0.5 0.2-0.2 0.1-0.3 0.3-0.4 0.5`

### 5.6 Known residual error (Skia float32 ↔ float64)

Pencil builds paths via Skia/CanvasKit `PathBuilder.cubicTo()` → `toSVGString()`. Internally, Skia stores all coordinates as **float32**. Our pipeline promotes float32 → float64 and computes in float64. In some cases a 1-ULP difference (at the 5th decimal place) can occur.

This difference is **visually indistinguishable** (~1e-5 px). Even forcing float32 truncation via Math.fround does not perfectly eliminate cases where Skia's internal floating-point accumulation diverges.

---

## 6. Text handling

### 6.1 fontWeight mapping (fontName.style → string)

```
"Thin"        → "100"
"ExtraLight" / "Extra Light" → "200"
"Light"       → "300"
"Regular"     → "normal"
"Medium"      → "500"
"SemiBold" / "Semi Bold" → "600"
"Bold"        → "700"
"ExtraBold" / "Extra Bold" → "800"
"Black"       → "900"
"ExtraBlack" / "Extra Black" → "950"
"Italic"      → fontStyle: "italic" (separate)
```

### 6.2 textAlignVertical

```
"TOP"    → "top"
"CENTER" → "middle"  (NOT "center")
"BOTTOM" → "bottom"
```

### 6.3 letterSpacing

```ts
{ value, units: "RAW" | "PIXELS" | "PERCENT" }
```
- RAW: value verbatim (multiplier)
- PIXELS: value verbatim (px)
- **PERCENT: `value / 100 × fontSize`** (convert to absolute px)

### 6.4 lineHeight

```
RAW:     value verbatim
PIXELS:  value / fontSize (convert to multiplier)
PERCENT: 0 (omitted) for 100%; warn otherwise (in practice, very rare to be other than 100%)
```

### 6.5 textAutoResize → textGrowth

```
"NONE" / "TRUNCATE"   → "fixed-width-height"
"WIDTH_AND_HEIGHT"    → "auto"  (default — omit)
"HEIGHT"              → "fixed-width"  (fixed width; height = text length)
```

### 6.6 textAlignHorizontal

```
"LEFT"      → "left"
"CENTER"    → "center"  (default — omit)
"RIGHT"     → "right"
"JUSTIFIED" → "justify"
```

---

## 7. Stroke / Border

### 7.1 strokeAlign mapping

```
"INSIDE"  → "inside"
"OUTSIDE" → "outside"
otherwise / "CENTER" → "center"
```

### 7.2 Asymmetric stroke

When `borderStrokeWeightsIndependent === true`, emit as an object of `border{Top,Right,Bottom,Left}Weight`:
```ts
thickness: { top?: number, right?: number, bottom?: number, left?: number }
```
Undefined sides are omitted from the thickness object (= interpreted as thickness 0).

### 7.3 paint.opacity composition

For both stroke and fill the final alpha is **`color.a × paint.opacity`**.
Looking at only one yields a darker color than intended.

### 7.4 Image fill

```ts
{ type: "IMAGE",
  imageScaleMode: "FILL" | "FIT" | "STRETCH" | "CROP" | "TILE",
  image: { hash: Uint8Array, name },
  ... }
```

Mapping (note the field name — `imageScaleMode`, NOT `scaleMode`):
```
"FILL"           → "fill"   (default)
"FIT"            → "fit"
"STRETCH" / "CROP" → "stretch"
"TILE"           → "tile"
```

---

## 8. Shadow / Effects

```ts
effects[]: { type: "DROP_SHADOW" | "INNER_SHADOW",
              color: { r, g, b, a },
              offset: { x, y },
              radius, spread, ... }
```

Mapping:
- color: 6-digit hex (opaque shadow) or 8-digit hex (semi-transparent — `colorToHexShortAlpha`)
- offset: kept as `{x, y}`
- **blur: `radius × 0.875`** (Pencil's conversion factor — measured: `radius 4 → blur 3.5, 8 → 7`)
- spread: kept as-is

---

## 9. Coordinate system / normalization

### 9.1 Top-level coordinate preservation

A pencil.dev paste preserves Figma's original coordinates as-is (negative Y, non-zero origin OK).
The Pencil editor auto-scrolls to the center of the bounding box, so no normalization is needed.

**Exception**: only when a Figma page sits at an extreme offset (e.g. -32000) do we align to (0,0). Threshold: keep as-is if `min coord >= -2000`; normalize if more negative.

### 9.2 Position emit policy

- Parent auto-layout: omit (see §4.3 above)
- Parent not auto-layout: always emit (even `x: 0, y: 0`)
- TEXT nodes: always omit unless `textAutoResize === "NONE"` (the text itself determines position)

---

## 10. ID reissue

Every node id in `.pen` is a 5-6 character base62 ([0-9A-Za-z]). Unrelated to the Figma GUID (`sessionID:localID`).

**Algorithm** (for round-trip determinism):
- pageSeed = `${page.guidStr}|${sourceFigSha256}`
- In node visit order, take the first 5 base62 chars of SHA-256(pageSeed + index) → on collision, extend to 6
- Different seed per page → no inter-page ID collisions
- Same input → same ID (deterministic)

The `.pen.json` carries `{newId → originalGuidStr}` mapping in `__figma.idMap` (for round-trip debugging).

---

## 11. Verification / Audit

```bash
# Comparison tool
node _tmp_pen_css_audit.cjs
```

**Current state** (00_design setting.pen baseline):

| Category | Fields × nodes | Diff |
|---|---|---|
| frame | 17 × 123 = 2,091 comparisons | **0** ✅ |
| rectangle | 9 × 22 = 198 | **0** ✅ |
| text | 15 × 44 = 660 | **0** ✅ |
| path | 9 × 2 = 18 | **1** (geometry — Skia float32 ULP) |
| Unmatched signatures | — | **0** ✅ |

Regression test: **100/100 pass**.

---

## 12. Sources / References

- **Figma `.fig` format**: reverse engineering by Evan Wallace (https://github.com/evanw/figma-fig-format-decoder)
- **Pencil v1.1.55 app.asar**: `~/AppData/Local/Programs/Pencil/resources/app.asar`
  - `parseVectorNetworkBlob`, `xQ`, `EQ`, `AQ` (path build)
  - `TQ`, `uw`, `VZ` (size policy)
  - `vpe`, `dpe.rel()`, `dpe.round()` (path encoding via the `svgpath` library)
  - `applyOverrides`, `replaceInstanceProps` (instance expansion)
  - text/font weight mapping, letterSpacing/lineHeight units, textAlignVertical
- **`svgpath` library**: https://github.com/fontello/svgpath (used by pencil)
- **`derivedSymbolData`**: the pre-resolved snapshot used by Figma's clipboard serialization

---

## 13. Changelog

| Date | Change |
|---|---|
| 2026-05-01 | First draft — SPEC across INSTANCE/Override/ColorVar/Path/Size/Text/Effects |
| 2026-05-01 | Implemented vectorNetworkBlob decoder + svgpath error-accumulation rounding |
| 2026-05-01 | Accurate implementation of `affectsLayout` + propAssignments rule for fit_content(N) |
