# JSON → .fig conversion feasibility review

Date: 2026-04-30

## TL;DR

**Feasible**: but difficulty varies widely depending on which JSON is used as input.

| Input JSON | Feasibility | Difficulty | Notes |
|-----------|-----------|--------|------|
| `extracted/04_decoded/message.json` | **Already feasible (kiwi mode)** | Trivial | `repack --mode kiwi` currently performs the same operation at the binary level. Going via JSON does not guarantee byte equality but is semantically equivalent. |
| `output/document.json` / `pages/*.json` | Feasible but lossy | Medium | Our export drops some raw-message metadata (blobs, derivedSymbolData, etc.) — re-encoding will lose information. |
| `extracted/08_pen/*.pen.json` | Partially feasible | Hard | Pencil's 4-type model does not preserve Figma's original metadata (components, variables, styles, interactions, etc.). Reproduces only the visual result. |

---

## 1. Pipeline structure (reverse direction)

```
.pen.json   ─[(C) very hard]──────→  document.json / pages.json
                                      │
                                      │ [(B) semantic mapping required]
                                      ↓
                            extracted/04_decoded/message.json
                                      │
                                      │ [(A) kiwi encode — already implemented]
                                      ↓
                              extracted/03_decompressed/data.kiwi.bin
                                      │
                                      │ [deflate-raw + fig-kiwi archive]
                                      ↓
                              extracted/01_container/canvas.fig
                                      │
                                      │ [ZIP STORE packaging — already implemented]
                                      ↓
                                       .fig
```

`repack --mode kiwi` already performs the binary→binary roundtrip at step (A).
Doing exactly the same work via JSON only requires **the JSON variant of (A)**.

## 2. Path available immediately: `repack --mode json`

**Input**: `extracted/04_decoded/message.json` (only generated when extracting with `--include-raw-message`, ~150 MB)
**Processing**:
1. Restore the kiwi schema from `schema.json` or `03_decompressed/schema.kiwi.bin`
2. Parse `message.json` and restore `Uint8Array` fields (e.g., `blobs[].bytes`)
3. `kiwi.encodeMessage(schema, parsed)` → `data.kiwi.bin`
4. The remaining steps are identical to kiwi mode

**Constraints**:
- `Uint8Array` is serialized by `JSON.stringify` as `{"0":1,"1":2,...}` objects. Explicit conversion needed on restore.
- Alternatively, when extracting, split binary blobs into a separate directory (`04_decoded/blobs/`) so `message.json` carries only references — cleaner when blobs are large.

**Effort**: implementation ~80 LoC; 1–2 hours including tests.

## 3. Harder path: edit `output/document.json` → .fig

`output/` is a polished, human-readable view of the result. Currently dropped:

1. **blobs**: vector geometry, font metrics, image hashes, and other binary blobs are split into a separate directory (assets/).
2. **derivedSymbolData / derivedTextData**: layout / glyph results Figma caches internally. Round-trip fails unless these are kept in raw.
3. **componentPropRefs / componentPropAssignments**: partially preserved, but may be simplified on output.
4. **Internal sequence numbers**: some of the kiwi message ordering / position metadata.

**Resolution**:
- Guide editors to modify `extracted/04_decoded/message.json` directly rather than `output/`.
- Or, on raw → output conversion, also emit a lossless `output/__raw_meta.json` sidecar to restore on round-trip.

## 4. Hardest path: `.pen.json` → `.fig`

Pencil's 4-type model (frame / text / path / rectangle) intentionally discards Figma's rich metadata:
- Component (SYMBOL / INSTANCE) relationships → flattened into frames
- Component prop assignments / refs → only the applied result is kept
- Variables (VARIABLE_SET / VARIABLE) → only resolved values are kept
- Interactions (prototyping links) → removed
- Styles (shared paint / text style) → inlined

So `.pen.json` alone cannot reconstruct the original `.fig`.

**Current round-trip preservation strategies**:
- `editable-html --single-file`: embeds the original `.fig` bytes into HTML as base64
- `08_pen` + sidecar (`figma.editable.meta.js`): pen editing combined with original metadata

To get back to `.fig` after editing `.pen.json`:
1. **Visual reproduction only**: pen.json → a new simple `.fig` (map every node to FRAME / TEXT / RECTANGLE / VECTOR; no components).
2. **Preserve original + apply diff**: extract only changed nodes from pen.json → patch onto the original message.json → kiwi encode. Requires node matching logic (pen guid ↔ figma guid).

## 5. Recommended roadmap

1. **Immediate**: implement `repack --mode json` (`message.json` input) — already 90% in place.
2. **Short term**: by default, have `extract` produce `04_decoded/message.json` while splitting blobs into `04_decoded/blobs/` (resolves the size concern).
3. **Medium term**: edit `output/document.json` → `.fig` path. Introduce a raw-meta sidecar.
4. **Long term (optional)**: `.pen.json` diff → `message.json` patch → `.fig`. Requires a node-matching + override composition engine.

## 6. Implementation cautions

- **Schema versioning**: do NOT apply a schema extracted from one `.fig` to a message from another (each file carries its own schema).
- **kiwi message type**: typically `MultiplayerMessage` or `NodeChanges`. The root type must be preserved.
- **Uint8Array binary blobs**: JSON stringify needs a lossless representation. Recommended: base64 encode (size +33% slight overhead) or a separate binary directory.
- **archive version**: preserve the version from `extracted/02_archive/_info.json` (currently v106).

## 7. Conclusion

**JSON → `.fig` is implementable with the same consistency as the binary → binary path (kiwi mode); the question is "which JSON"**:
- raw kiwi-decoded JSON: nearly free (a JSON variant of kiwi mode)
- polished document JSON: requires sidecar metadata to compensate for losses
- pen simple JSON: component / variable relationships are lost, so combining with original metadata is mandatory
