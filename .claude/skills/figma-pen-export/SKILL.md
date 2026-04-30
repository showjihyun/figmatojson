---
name: figma-pen-export
description: Generate Pencil-compatible .pen files (and round-trip .pen.json) from Figma data, debug pencil.dev import failures, and reason about visibility / ID / coordinate gotchas in pen-export.ts. Use when working with .pen output, pencil.dev imports, INSTANCE/SYMBOL expansion behavior, hidden-node handling, or when nodes appear duplicated, missing, or off-screen in the Pencil viewer.
---

# Pencil .pen export

Produces two files per Figma page in `extracted/<name>/08_pen/`:

| File | Purpose |
|---|---|
| `<n>_<page>.pen` | Pencil v2.11 native — pencil.dev imports this directly |
| `<n>_<page>.pen.json` | Pencil + `__figma` extension (idMap, viewportOffset, sourceFigSha256) for round-trip / debugging |

## Hard rules pencil.dev enforces (verified painfully)

1. **IDs must match `[0-9A-Za-z]{5,6}`** — colons (`11:580`) and slashes (`11:1/22:2`) are rejected.
2. **IDs must be globally unique within an export run** — Pencil dedups by ID, so cross-file collisions cause merging/confusion.
3. **First node ID likely doubles as a file fingerprint** — if every file starts with `00000`, pencil.dev recognizes them as the same document.
4. **Default viewport sits near (0, 0)** — content at e.g. `x=-32000` shows as a blank canvas.

The current implementation in `src/pen-export.ts` honors all four. Don't break them.

## How IDs are minted (don't change without thinking)

```
pageSeed = `${page.guidStr}|${sourceFigSha256}`
id_i     = base62-mod62(SHA-256(pageSeed + ':' + counter)[0..4])
```

- 5 chars (62⁵ ≈ 916 M).
- Page-seeded → distinct ID distribution per page (rule 3).
- A single `globalUsedIds: Set<string>` is shared across **all** pages in one `generatePenExport` call (rule 2). On collision, counter increments and re-hashes.
- `reassignPenIds(nodes, pageSeed, globalUsed)` runs **serially in page order** — order determinism, otherwise collision retries shift IDs across runs.

`__figma.idMap` records `<freshId> → <originalFigmaGuidPathString>` for round-trip / debugging.

## Visibility resolution (3 mechanisms, all in convertNode)

A node ends up with `enabled: false` in the pen output if any of:

1. **Direct** — `data.visible === false` on the node itself (master child or any standalone node).
2. **componentPropAssignments**: INSTANCE has `componentPropAssignments[i] = {defID, value:{boolValue:false}}`, and a master-tree descendant has `componentPropRefs[j] = {defID:same, componentPropNodeField:"VISIBLE"}`. `isHiddenByPropAssignment(data, assignmentMap)` is the gate.
3. **symbolOverrides**: INSTANCE's `symbolData.symbolOverrides[i] = {guidPath:[guids], visible:false}`. `applySymbolOverrides` walks the master tree and patches node data before `reflowMasterChildren` / `scaleNode`. Note `visible:true` overrides override master's `visible:false` — used to toggle dropdown options visible per-instance.

Hidden nodes always get explicit position (auto-layout flow doesn't include them) — see `shouldOmitPosition`'s `effectiveVisible` short-circuit.

## INSTANCE → master expansion order (pen-export.ts:639–890)

When `convertNode` hits an INSTANCE with empty children but a `symbolData.symbolID` matching `symbolIndex`:

1. `applySymbolOverrides(master.children, sd.symbolOverrides)` — patch visible/size/etc on matching descendants by guidPath.
2. Either `scaledChildren = master.children.map(scaleNode(c, sx, sy))` (master has no stackMode) OR `reflowMasterChildren(...)` (auto-layout master gets counter-axis recompute).
3. **`prefixGuids(c, n.guidStr)`** — prefix all descendant `guidStr` with the instance's guid so internally they're unique. (vectorPathMap lookup must use the last `/`-segment because the geometry map keys are master GUIDs.)
4. Build merged TreeNode: master's `data` + instance's `transform` / `size` / `visible` / `componentPropRefs` / `stackChildAlignSelf` / `stackChildPrimaryGrow` / `stackPositioning`. **Forgetting any of these breaks** fill_container detection, hidden-by-instance, or auto-layout flow.
5. Recurse with `mergedAssignments` (parent + this instance's componentPropAssignments).

## Coordinate normalization

Right before serialization, `normalizeTopLevelToOrigin(pageChildren)` translates top-level x/y so the bbox starts at (0, 0). Original offset stored in `__figma.viewportOffset = {dx, dy}`. Inner relative coords are untouched.

## See also

- Round-trip path `.pen.json` ⇄ `.fig` (no current implementation; would need pen → kiwi mapper) — for now only `extracted/04_decoded/message.json` round-trips.
- `figma-cli` skill for command invocation.
- `figma-internals` skill for the decoder/tree/intermediate APIs you need before pen export.
- Test references: `test/pen-export.test.ts` (visibility, unique IDs, page-distinct IDs, viewport normalization, global uniqueness).
