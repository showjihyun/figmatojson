# Round-trip Equality has three tiers; lossy modes are forbidden

Every `Repack` mode in this project must produce output at one of two equality strengths against the original `.fig`: **byte-identical** (Byte Repack only — inner `canvas.fig` matches byte-for-byte) or **semantically equivalent** (Kiwi Repack and JSON Repack — same node count, same Schema, same archive version, recompressed differently). A third tier, **lossy** (silently dropping or reshaping fields), is **not** an option we will ship. See `CONTEXT.md` → "Round-trip and Repack".

A reader looking at JSON Repack might reasonably ask why we don't trim fields — `derivedSymbolData`, `derivedTextData`, glyph caches, and similar Figma-internal computed fields would shrink `message.json` by an order of magnitude, and most of them are reproducible from primary data. We considered it. The reason we don't:

- The project's value is **lossless conversion**. As soon as one Repack mode silently drops a field, the contract erodes — users can't tell whether their next round-trip will or won't lose something.
- We've seen what "looks reproducible" actually means: `derivedTextData.glyphs` carry baseline offsets we can't recompute without bundling Figma's exact font metrics. "Mostly reproducible" is a trap.
- Compression already handles the size argument. Cleaning up `derivedSymbolData` saves a few percent post-deflate; not worth the trust cost.

## Consequences

- Future PRs that trim fields "to reduce file size" should be rejected with a pointer to this ADR.
- If we ever genuinely need a lossy mode (e.g. a public API tier), it must be a **distinct**, explicitly-named mode with a different command — not a flag on existing modes. The user must opt in to losing data.
- The JSON Repack lossless invariant relies on the `__bytes` / `__num` / `__bigint` tags in `roundTripReplacer` (`intermediate.ts`) ↔ `reviveBinary` (`repack.ts`). Both halves must move together. The `repack json mode` test in `test/e2e.test.ts` is the regression guard.
