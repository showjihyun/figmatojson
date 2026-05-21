# spec/web-canvas-text-style-runs

| Item | Value |
|---|---|
| Status | Draft (round 13) |
| Implementation | `web/core/domain/clientNode.ts` (TEXT node data passthrough), `web/client/src/Canvas.tsx` (TEXT branch multi-segment rendering) |
| Tests | `web/core/domain/clientNode.test.ts` (style runs propagation), Pass 3 visual gate (input-box-9_42 state-text row) |
| Siblings | `web-canvas-text-frame-fidelity.spec.md` (round 13 group C) |

## 1. Goal

A single Figma TEXT node can apply different styles (fill / fontWeight /
fontFamily, etc.) to *substring ranges* of its own `characters` —
`styleOverrideTable` + `characterStyleIDs` mechanism. The state-text row of
the meta-rich input-box-9_42 is exactly this case: a single TEXT contains
a description label (gray) `, ` (gray), an error label (red) `, ` (gray),
and a success label (green); different fills apply to different character
index ranges. Our Canvas reads only the node's single `fillPaints`, so
everything renders gray — defect #5 of the round-11 audit Pass 2
universal-primitive list.

## 2. Figma data shape

`data.textData` on a TEXT node (measured on the meta-rich input-box-9_42
state-text node `11:457` / `427:5498`):

```ts
{
  characters: "<description>, <error>, <success>",  // 16 chars in the actual Korean source
  characterStyleIDs: [0,0,0,0,0,0, 3,3,3,3, 0,0, 2,2,2,2],  // same length as chars
  styleOverrideTable: [
    { styleID: 2, fillPaints: [{ type: 'SOLID', color: {r:0.007,g:0.58,b:0.42,a:1}, ... }] },  // green
    { styleID: 3, fillPaints: [{ type: 'SOLID', color: {r:0.86,g:0.07,b:0.07,a:1}, ... }] },  // red
  ],
  lines: ...
}
```

**Important data-shape nuances:**

- `styleOverrideTable` is an **array of `{styleID, ...overrides}` entries**, *not* a map. Lookup iterates the array matching `entry.styleID === id`. First match wins (Figma defining the same styleID twice is corrupt).
- `characterStyleIDs[i] === 0` means *base* style — there is *no* entry for styleID 0 in `styleOverrideTable` (base implicitly *is* styleID 0).
- `characterStyleIDs[i] === n (n > 0)` means the fields of the entry with `styleID === n` in `styleOverrideTable` are a *partial override* — they overwrite only the listed fields (fillPaints/fontWeight/etc.) over the node's base.

The above data → 4 runs:
1. indices 0-5 (description label + `, `): styleID 0 → base (dark gray)
2. indices 6-9 (error label): styleID 3 → red
3. indices 10-11 (`, `): styleID 0 → base (dark gray)
4. indices 12-15 (success label): styleID 2 → green

## 3. Invariants

### 3.1 Data passthrough (clientNode)

- I-C1 `clientNode.ts`'s `toClientNode` / `toClientChildForRender` must pass through a TEXT node's `textData.styleOverrideTable` and `textData.characterStyleIDs` as-is (verify the current spread logic does pass both — only `derivedTextData` is explicitly stripped, lines 98 / 307. The style-runs data is nested inside `textData` so it is likely passed through).
- I-C2 When INSTANCE text override (`_renderTextOverride`) is applied, the master's styleRun mapping is *preserved* — per Figma behavior only the text changes; style indices still follow the master (needs validation; if behavior differs, branch separately).

### 3.2 Rendering (Canvas)

- I-R1 If `characterStyleIDs` is all `0` or `styleOverrideTable` is empty → fall back to the existing single-KText render. No regression.
- I-R2 If `characterStyleIDs` has 2+ unique values → split the text into *runs of consecutive same-styleID characters*. Each run renders as its own KText with x equal to the cumulative width of prior runs.
- I-R3 Effective style per run = `nodeBaseStyle (fillPaints, fontSize, fontFamily, ...) ⊕ styleOverrideEntry (only the listed fields)`, where styleOverrideEntry = `styleOverrideTable.find(e => e.styleID === characterStyleIDs[i])`. If override contains fillPaints, use that color (state-text's red/green). styleID 0 or no matching entry → base only.
- I-R4 Run-split measurement: same fontFamily/fontSize/letterSpacing, use KText's `getTextWidth`. Validate that it works with multilingual (Korean / English mixed) text.
- I-R5 textAlign / lineHeight / wrap policy stay at the node level — the split applies only to inline-style ranges like fill/fontWeight; layout props apply once across the entire node.
- I-R6 Multi-line text (newlines): if a run crosses a line break, restart the run at each newline. (Konva does not auto-wrap, so we may have to split lines manually. Meta-rich cases are single-line, so v1 handles single-line only; multi-line is out of scope.)

## 4. Error cases

- `characterStyleIDs.length !== characters.length` (corrupt data) → fall back to single-node render (same as I-R1).
- `styleOverrideTable[id]` missing while `characterStyleIDs` references that id → fall back to base style.
- `_renderTextOverride` clashes with `characterStyleIDs` (override text length differs) → needs validation. In v1, if an override is present, fall back to single KText (drop style runs) — the visual shock outweighs the data loss.

## 5. Out of scope

- Multi-line run splitting — no case in meta-rich, so out of scope in v1. Open a separate round when one appears.
- *Font itself* overrides such as `fontFamily` / `fontWeight` in styleOverrideTable — v1 handles only fillPaints (meta-rich state-text changes only fill). Other fields follow the base.
- Ensuring text selection / cursor behaves as one node across multiple segments — this spec covers *visual* fidelity only; interactive editing is separate.
- The case where `_renderTextOverride` is applied and the character range must change accordingly — not supported in v1 (fall back to single KText).
