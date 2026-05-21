# spec/vector-decode

| Field | Value |
|---|---|
| Status | Approved |
| Implementation | `src/vector.ts` (`extractVectors`, `decodeCommandsBlob`, `parseVectorNetworkBlob`, `vectorNetworkToPath`) |
| Tests | `test/vector*.test.ts` (where present) — per-invariant: cmd opcode mapping / offset fallback / VN region decode |
| Siblings | `SPEC.md §Stage 7` (pipeline location), `SPEC-figma-to-pencil.md` (path-output contract used by pen-export) |

## 1. Goal

Vector nodes in a `.fig` carry path geometry in two distinct binary formats — `commandsBlob` (per-fill/stroke geometry) and `vectorNetworkBlob` (the whole-node path graph). Both are referenced via the schema only by blob indices, and the wire format itself is not exposed in the schema. This spec enshrines the **opcode mapping, offset fallback, error handling, and SVG output contract** of the two decoders as the source of truth.

CLI Stage 7 (`extractVectors`) and pen-export's vectorPathMap both share this code, so a change in one decoder affects both outputs simultaneously.

## 2. Applicable node types

- I-N1 Types targeted by vector extraction: `VECTOR / STAR / LINE / ELLIPSE / REGULAR_POLYGON / BOOLEAN_OPERATION / ROUNDED_RECTANGLE`. Other types are out of scope (drawing is handled via a different path at reduce-to-Pen).
- I-N2 Even for the types above, if none of `fillGeometry` / `strokeGeometry` / `vectorData.vectorNetworkBlob` is present, return `error = 'no fill/stroke geometry'` and produce no svg. **No throw** — a prerequisite for the 95% success rate.
- I-N3 `BOOLEAN_OPERATION` extracts paths only — the boolean operations themselves (UNION/INTERSECT/SUBTRACT/EXCLUDE) are *out of scope* (the source of the current implementation's 5% gap). The resulting svg is a simple union of child paths and may not be accurate.

## 3. `commandsBlob` decoder

Per-geometry binary. Each fill/stroke geometry holds its own blob index, and the decoder converts the byte stream into SVG path commands.

### 3.1 Opcode mapping

- I-C1 1-byte opcode + payload format. Every float is **little-endian f32**. Integers are LE u32 (no such command — the opcode itself is u8).

| opcode | Command | Payload (bytes) | SVG mnemonic |
|---|---|---|---|
| `0x00` | NO-OP / subpath separator | 0 | (skip) |
| `0x01` | MOVE_TO | 8 (x, y) | `M` |
| `0x02` | LINE_TO | 8 (x, y) | `L` |
| `0x03` | QUAD_TO | 16 (cx, cy, x, y) | `Q` |
| `0x04` | CUBIC_TO | 24 (c1x, c1y, c2x, c2y, x, y) | `C` |
| `0x05` | CLOSE | 0 | `Z` |

- I-C2 **`0x03`/`0x04` are not swapped** — 0x03 = quadratic, 0x04 = cubic. This mapping is a fact pinned down by round-trip verification (a past implementation that swapped the two broke icon curves). Changing it triggers a vector regression.
- I-C3 On an unknown opcode, *stop* decoding (no throw): keep the path accumulated up to that point and mark `error = "unknown cmd 0x?? at offset N/M"`. The key insight is to treat this as trailing metadata — some blobs in fact carry auxiliary data (e.g., a winding flag) after the path.
- I-C4 Payload truncation (remaining bytes < payload size) follows the same — keep the accumulated path + mark the error + stop immediately.

### 3.2 Offset fallback

- I-C5 Some blobs are presumed to start with 1 byte of winding flag (or other unclassified header), with the opcode stream beginning after that. The decoder tries both `startOffset ∈ {0, 1}` and picks **the one with the larger `commandCount`**.
- I-C6 Ties are broken by smaller `startOffset` (= 0). That is, if the blob legitimately starts with a command, offset 0 always wins.
- I-C7 If both attempts yield 0 commands or an empty path, throw — the only throw case in `decodeCommandsBlob`. The caller (`tryExtract`) catches it, logs it in `result.errors[]`, and continues to the next geometry.

### 3.3 Float serialization

- I-C8 Decoded float32 values are serialized via `Number.toString()` (lossless). Do not use `toFixed(N)` — a past implementation truncated to 5 digits and accumulated last-digit drift during the absolute → relative conversion stage.
- I-C9 Round in the post-processing stage (`absoluteToRelative`, etc.) if needed. This decoder is always **lossless serialization**.

### 3.4 SVG output

- I-C10 `tryExtract` outputs `<svg viewBox="0 0 W H" width=W height=H>` + per-geometry `<path>`s. `W/H = data.size.{x,y}` (fallback 100 when absent).
- I-C11 fill geometry: `<path d="…" fill="…" fill-rule="…"/>`. fill-rule is `windingRule === 'ODD' ? 'evenodd' : 'nonzero'` (default nonzero).
- I-C12 stroke geometry: `<path d="…" fill="none" stroke="…" stroke-width="N"/>`.
- I-C13 fill / stroke color: the first visible SOLID in `data.fillPaints[0]` / `data.strokePaints[0]`. If none, `currentColor`. Gradient / image paints are *out of scope* (Stage 7 best-effort).
- I-C14 stroke-width: `data.strokeWeight` when positive, else 1.

## 4. `vectorNetworkBlob` decoder

The *graph* representation of a vector node — vertices + segments + regions. pen-export uses this as the path's real source (binary-compatibly reverse-engineered from pencil.dev v1.1.55 `parseVectorNetworkBlob`).

### 4.1 Wire format

- I-V1 Header (12B, LE u32): `vertexCount`, `segmentCount`, `regionCount`.
- I-V2 Vertex (12B × N): `styleID:u32, x:f32, y:f32`.
- I-V3 Segment (28B × M): `styleID:u32, start.{vertex:u32, dx:f32, dy:f32}, end.{vertex:u32, dx:f32, dy:f32}`. `dx/dy` is the **control-point delta relative to the vertex coordinate** (not absolute). The cubic Bézier control point is `vertex + (dx, dy)`.
- I-V4 Region (variable length):
  - packed `u32`: lowest bit = winding (`1 = NONZERO`, `0 = ODD`), upper bits = `styleID` (>> 1).
  - `loopCount:u32`, then per-loop `segmentCount:u32 + indices:u32 × N`.
- I-V5 Length validation: if at any point the remaining bytes are fewer than the next record, the parser returns `null` (no throw). If vertex / segment indices are outside `vertexCount` / `segmentCount` range, also `null`.
- I-V6 `bytes.length < 12` returns `null` immediately (header cannot be filled).

### 4.2 SVG path conversion

- I-V7 With one or more regions: for each region, for each loop, resolve segment indices into `vn.segments`, orient endpoints via `orientSegments`, then serialize via `buildPathFromSegments`. Multiple loop / region paths are joined by whitespace — fill-rule is determined by the region's windingRule (caller's responsibility).
- I-V7a **Region + orphan composition**: even when one or more regions exist, if there are *segments not included in any region/loop* (= "orphan stroke-only segments"), emit those segments as an additional sub-path after the region path. This handles the common case where a single Figma vector node *simultaneously* carries a fill-region (dot/shape) and stroke-only lines. Of the 22 segments in HPAI 700:319 ("data-01 / Icon"), exactly 6 fall into this branch — 4 regions draw the dot, and 6 orphan segments draw the lines. The previous implementation (up to round 11) emitted regions only, so the lines were entirely missing.
  - Orphan segments call `buildPathFromSegments` in original index order *without* going through `orientSegments`. Reason: orphans are typically a set of disconnected lines, in which case orientSegments's "flip based on previous endpoint match" produces false flips. `buildPathFromSegments` starts a new `M` subpath automatically when disconnected — so each line is drawn correctly without orienting.
  - fill-rule is meaningful only for the region path; orphans are stroke-only. Whether the caller applies fill-rule per region or to the whole path, orphan segments will not be filled (no closing Z, open chain).
- I-V8 Zero regions = stroke-only / line: send all segments through a single call to one path. Empty string when segment count is also 0.
- I-V9 Segment chain orientation (`orientSegments`):
  1. If the first segment's `end.vertex` does not match any endpoint of the next segment, flip the first segment (`reverseSegment` swaps both start/end vertex/dx/dy).
  2. For i ≥ 1, if `prev.end.vertex !== curr.start.vertex`, flip curr.
  3. **No in-place mutation**: deep-copy input segments and mutate only the copy. The originals are shared references in `vn.segments` and may be used by other regions/loops in different directions.
- I-V10 Segment → path commands:
  - When both tangents are 0 (`start.dx == 0 && start.dy == 0 && end.dx == 0 && end.dy == 0`), emit `L b.x b.y` (straight line).
  - Otherwise a cubic: `C (a.x+sd.dx) (a.y+sd.dy) (b.x+ed.dx) (b.y+ed.dy) b.x b.y`.
  - When starting a subpath (previous endpoint != current start), prepend `M a.x a.y`.
  - When the subpath returns to startVertex, append `Z` + reset lastVertex.
- I-V11 Float serialization is the same as §3.3 (`Number.toString()`, lossless).

## 5. Error policy

- I-E1 `extractVectors` / `tryExtract` **never throw** (except when the input tree is null). Decoding failures propagate as a `result.error` string. This is the basis for the CLI advertising a 95% success rate.
- I-E2 Only `decodeCommandsBlob` throws on empty results (§I-C7). It is the caller's hook to move on to the next geometry.
- I-E3 `parseVectorNetworkBlob` does not throw — malformed wire returns `null`. Guarantees the caller (pen-export) a fallback path down to the `commandsBlob` decoder.
- I-E4 Missing blob index (`blobs[idx]?.bytes` falsy) is pushed into the errors array as `blob[idx] missing` and processing continues to the next geometry. No node-level hard failure.

## 6. Non-goals

- ❌ Accurate path composition for boolean operation results (UNION/SUBTRACT, etc.). `BOOLEAN_OPERATION` only concatenates child paths — the main contributor to the 5% under-interpretation.
- ❌ SVG output for gradient / image paints — solid color only (§I-C13).
- ❌ Stroke style details such as stroke align (CENTER/INSIDE/OUTSIDE), stroke cap/join — this spec covers path geometry only. Stroke styling is in pen-export's spec.
- ❌ Detailed meaning of `fillGeometry[].styleID` (presumed reference to a style table). Currently used only for path extraction.
- ❌ Use of `region.styleID` in vectorNetworkBlob — pen-export handles it via a separate path. This decoder emits paths only.
- ❌ Vector data on TextNodes — type is not in VECTOR_TYPES, so out of scope. Text glyph paths are handled separately.

## 7. Resolved questions

- **Why are both commandsBlob and vectorNetworkBlob present?** Figma appears to carry both a pre-flattened path for paint/rendering (commandsBlob) and a graph for editing (vectorNetworkBlob). Pencil uses the latter as the real source — we likewise use vectorNetworkBlob in pen-export when possible and fall back to commandsBlob.
- **Why enshrine the 0x03/0x04 non-swap in the spec?** The opcode mapping is a wire-format contract, and external reverse-engineering references sometimes write the two meanings swapped. This spec, together with round-trip verification, is authoritative.
- **What is NO-OP `0x00`?** Unclear — appears to be a subpath separator or a default for unset fields. The safe handling is *skip*.
