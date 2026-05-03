# figma-reverse

The domain is **the conversion pipeline between Figma's `.fig` binary format and consumer-friendly representations** (structured JSON, Pencil `.pen`, browsable HTML). Audience: developers who maintain or extend the pipeline.

This glossary describes concepts unique to that conversion. General programming vocabulary (timeouts, errors, etc.) is out of scope.

## Language

### Input format

The `.fig` file is structured in distinct layers. Each layer has a name to keep Stage 1–4 discussions unambiguous.

**Container**:
The outer ZIP wrapper that constitutes a `.fig` file on disk. Contains `canvas.fig` + `meta.json` + `images/<sha1>` + optional `thumbnail.png`, all STORE-compressed (no deflation). Decomposed in **Stage 1**. `ContainerResult` is its in-memory shape.
_Avoid_: "ZIP", ".fig" (when you mean only the outer wrapper), "wrapper", "archive" (the next layer is called Archive)

**canvas.fig**:
The core binary file inside Container — confusingly named the same as the outer file but a different thing entirely. Starts with the magic bytes `fig-kiwi`. Holds the entire node tree, the kiwi schema, and the message — i.e., everything that isn't an asset.
_Avoid_: "inner .fig", "design data" (too generic)

**Archive**:
`canvas.fig` parsed into its three internal pieces: `prelude` (8 bytes = `"fig-kiwi"`), `version` (4-byte LE uint32), and `chunks: Uint8Array[]`. Conventionally `chunks[0]` = compressed schema, `chunks[1]` = compressed message. `FigArchive` in code.
_Avoid_: "fig-kiwi binary", "kiwi archive" (redundant)

**Schema**:
The kiwi type-definition table embedded in every `.fig`. Decoded from `Archive.chunks[0]` via `kiwi.decodeBinarySchema`. ~568 type definitions in current Figma exports (`MultiplayerMessage`, `NodeChange`, `Color`, `GUID`, …). Differs across files because Figma evolves the schema and ships the current copy with each export.
_Avoid_: "type system", "kiwi types"

**Message**:
The decoded design data — `Archive.chunks[1]` interpreted through Schema. Root type is typically `NODE_CHANGES`. Holds the flat array of `Kiwi Records` plus blob references and metadata.
_Avoid_: "data", "payload", "decoded fig"

### Pipeline data shapes

The same logical "thing in a Figma file" appears in **four distinct data shapes** as it moves through the pipeline. Naming them consistently is the cure for a recurring class of bugs (mismatched counts, ID confusion, INSTANCE-vs-master ambiguity).

**Kiwi Record**:
A single raw entry of a decoded fig-kiwi `Message` — parent referenced by GUID, children not yet linked.
_Avoid_: "kiwi node", "raw node", "decoded node"

**Tree Node**:
A `Kiwi Record` after parent/child links have been resolved (`buildTree`). Indexed by GUID; one per `Kiwi Record` (1:1).
_Avoid_: "node" (alone), "TreeNode" (when speaking; the type is `TreeNode` in code)

**Pen Node**:
A node in the Pencil-shaped output tree. Reduced to four `type` values (`frame` / `text` / `path` / `rectangle`); INSTANCEs are flattened by inlining their master subtree, so counts are larger than the input.
_Avoid_: "node" (alone), ".pen node"

**Node** (alone):
**Ambiguous.** Always qualify with the pipeline phase (`Kiwi Record` / `Tree Node` / `Pen Node`). If the speaker doesn't qualify, ask which one they mean.

### Component model

The reusable-template concept Figma calls "Component" appears under three different names depending on which side of the pipeline you're on. We standardize.

**Master**:
A reusable template node. Lives once per `.fig` file (one `Tree Node` with `type === 'SYMBOL'`). Holds the canonical visual data and child structure that Instances reference.
_Avoid_: "Component" (Figma UI term — clashes with React/general usage), "Symbol" (the code type — confusing against "symbol" in JS)

**Instance**:
A use-site of a Master. Carries its own `transform`, `size`, and Overrides; its `children` array is empty until Expansion (the master tree is inlined at conversion time, not in the source data).
_Avoid_: "Component Instance" (verbose), "Symbol Instance"

**Override**:
Instance-side data that modifies what the Master would otherwise produce. Three concrete kinds, each with its own field:
1. `symbolData.symbolOverrides[].{visible,size,...}` — patches a descendant matched by `guidPath`.
2. `componentPropAssignments[]` — boolean / variant property values.
3. `componentPropRefs[]` (on a Master child) — which property a child's field is bound to.

Effective output is `Master × Overrides`, not just `Master`.

**Expansion**:
The act of replacing an Instance with its Master's subtree at the `Pen Node` phase — applying Overrides, scaling/reflowing children, and prefixing descendant GUIDs to prevent collisions. After Expansion, Master/Instance no longer exist as distinct concepts in the output; only the resolved tree remains.

Concretely, Expansion is two stacked passes: **Resolve** — `(Master subtree + Instance + Overrides) → resolved Tree Node subtree` (Effective Visibility composed, fillPaints overrides applied, text overrides applied, prop assignments propagated). **Reduce-to-Pen** — collapse the resolved subtree into Pen Node's four types, apply auto-layout reflow, mint Pen IDs. Resolve is shared between CLI and web (lives in `src/expansion.ts`); Reduce-to-Pen is CLI-only (lives in `src/pen-export.ts`).
_Avoid_: "inlining", "merging" (used for narrower meanings)

**Expansion Context**:
The per-`.fig` setup needed before any Resolve call: built once from `allNodes` (`createExpansionContext`), holds the **Master Index** and any other lookups the resolver needs. One Expansion Context produces N resolved subtrees (one per Instance) without rebuilding the index.
_Avoid_: "expansion state", "resolver context"

**Master Index**:
A `Map<GUID, Master>` over `allNodes`, holding only nodes whose `type ∈ {SYMBOL, COMPONENT, COMPONENT_SET}`. Built once per Expansion Context. The lookup an Instance uses to find its Master before Resolve walks the Master's subtree.
_Avoid_: "symbol index", "symbol map" (legacy names; "Master" is the project term — see above).

### Identity

A single logical node carries up to three different identifiers as it moves through the pipeline. Conflating them was the root cause of every ID-related bug shipped this far.

**GUID**:
The Figma-native identifier of a `Tree Node` or `Kiwi Record`. Format `${sessionID}:${localID}` (string). Globally unique within one `.fig` file.
_Avoid_: "id" (alone), "node id"

**Expansion Path**:
A composite identifier used only inside `pen-export.ts` while a Master's subtree is being inlined into an Instance. Form: `outerInstanceGuid/.../masterGuid` — recursive when Instances nest. Disambiguates Master descendants when one Master is expanded into multiple Instances. Never appears in output; `prefixGuids()` builds it, `vectorPathMap` lookup strips it back to the trailing GUID.
_Avoid_: "prefixed guid", "expanded id"

**Pen ID**:
The identifier emitted on every `Pen Node` in `.pen` and `.pen.json` output. Five base62 chars (`[0-9A-Za-z]{5}`). Generated by `SHA-256(pageSeed + ':' + counter) → first 5 bytes mod 62`. Globally unique across **all** `.pen` files produced by a single `generatePenExport` call (one shared `globalUsedIds` Set). `pageSeed = pageGUID + sourceFigSha256` so each Page produces a distinct ID distribution.
_Avoid_: "id", "short id", "hash id"

**idMap**:
The mapping `Pen ID → original GUID or Expansion Path`, recorded in `.pen.json` only at `__figma.idMap`. Pencil's native `.pen` doesn't carry this — it's our extension for round-trip / debugging. Strip it before sending to pencil.dev (we already do).

**ID** (alone):
**Ambiguous.** Always qualify with `GUID` / `Expansion Path` / `Pen ID`.

### Page model

**Page**:
A direct child of the Tree root with `type === 'CANVAS'`. The unit a Figma user sees in the left sidebar's page tabs. One `.pen` file is produced per Page.
_Avoid_: "Canvas" (the code `type` value, but reads weird against Pencil's "canvas" viewport), "Document" (the Tree root above the Page), "tab", "screen"

**Frame** (alone):
**Ambiguous.** Figma's `FRAME` type and Pencil's `frame` type are different concepts despite the shared name. Always qualify: `Tree Node FRAME` (Figma rectangular container) or `Pen Node frame` (Pencil's catch-all frame type post-Expansion).

### Auto-layout

Figma's auto-layout fields and their Pencil counterparts already have sufficient names on both sides. We do not introduce new domain terms; refer to the source vocabularies and treat the conversion rules as code-resident:

- Figma side — `stackMode` / `stackPrimarySizing` / `stackCounterSizing` / `stackChildAlignSelf` / `stackChildPrimaryGrow` / `stackSpacing` / `stack*Padding` / `stackPrimaryAlignItems` / `stackCounterAlignItems`.
- Pencil side — `layout` / `gap` / `padding` / `width: "fill_container"` / `fill_container(N)` / `fit_content(N)` / `justifyContent` / `alignItems`.
- Translation rules between them live in `src/pen-export.ts` (`layoutFromNode`, `omitDimensions`, `computeFillContainer`, `reflowMasterChildren`). Read the code, not a duplicated table.

When auto-layout debugging comes up, name the mechanism explicitly (e.g. "primary axis sizing on a Master with `stackMode: HORIZONTAL`"), not a new abstraction.

### Visibility model

A node's final on/off state in `.pen` output is the result of three independent mechanisms in the source data. Confusing them costs hours.

**Direct Visibility**:
The raw `data.visible: false | true` flag on a single `Tree Node`. Lives on Master nodes, regular nodes, and Instances themselves. Default is `true`.
_Avoid_: "node visibility" (alone — too generic), "the visible flag"

**Property Visibility Toggle**:
The mechanism by which an Instance's boolean property hides a specific descendant of its Master. The Instance carries `componentPropAssignments[] = { defID, value: { boolValue } }`; a Master descendant carries `componentPropRefs[] = { defID, componentPropNodeField: "VISIBLE" }`. Matching `defID` + `boolValue: false` ⇒ that descendant is toggled hidden in this Instance.
_Avoid_: "boolean prop", "prop toggle" (too generic)

**Symbol Visibility Override**:
The mechanism by which an Instance directly overrides a descendant's visibility via `symbolData.symbolOverrides[] = { guidPath, visible }`. Unlike Property Visibility Toggle, this can also set `visible: true` to **show** a descendant whose Master had it hidden — used heavily for dropdown option toggles.
_Avoid_: "symbol override" (alone — could mean any kind of override; Symbol Overrides also patch size, fill, etc.)

**Effective Visibility**:
The composed result of the three mechanisms above. `false` if **any** of `Direct`, `PropertyToggle`, `SymbolOverride` resolves to hidden — short-circuits to hidden. Symbol Override's `visible: true` can override Direct's `false` (this is the one place Symbol Override "wins" over the others).

**Hidden**:
A `Tree Node` whose Effective Visibility is `false`. In `Pen Node` output: receives `enabled: false`, drops out of auto-layout flow, retains an explicit `x` / `y` position.
_Avoid_: "invisible" (Pencil terminology says "enabled: false"), "disabled" (the field is named `enabled`, but conceptually it's about visibility)

**Visible**:
A `Tree Node` whose Effective Visibility is `true`. In `Pen Node` output: omits the `enabled` field (default).

**`visible: false`** (alone):
**Ambiguous.** Always qualify which mechanism — Direct, Property Toggle, or Symbol Override.

### Round-trip and Repack

The project's core value claim is that conversions don't lose information. Be precise about which conversion and which equality.

**Repack**:
The act of regenerating a `.fig` file from `extracted/<name>/`. Three modes — never use the bare word without one.
_Avoid_: "rebuild", "re-export"

**Byte Repack**:
ZIP STORE re-bundling of `extracted/01_container/` raw files. Resulting `canvas.fig` is byte-identical to the original. Cannot incorporate edits.

**Kiwi Repack**:
`extracted/03_decompressed/` binaries kiwi-decoded then re-encoded; result re-compressed with deflate-raw (fzstd is decode-only). Semantically equivalent to original; bytes differ.

**JSON Repack**:
`extracted/04_decoded/message.json` (an edited JSON tree) re-encoded through kiwi. The only Repack mode that incorporates user edits. Requires `extract --include-raw-message`. Lossless via the special-encoding tags `__bytes` / `__num` / `__bigint`.

**Round-trip**:
A two-way conversion `X → … → X` that returns "the same thing". Always pair with a Repack mode (e.g. "byte round-trip", "json round-trip"). Without a mode, the term is meaningless.

**Round-trip Equality**:
The strength of "the same thing". Three tiers, weakest to strongest:
- **byte-identical** — output bytes match input bytes (only Byte Repack; only the inner `canvas.fig`, not the outer `Container`).
- **semantically equivalent** — same node count, same Schema, same archive version (Kiwi Repack, JSON Repack).
- **lossy** — fields silently dropped or reshaped (no current Repack mode allows this; would be a regression).

**Embed** (not Round-trip):
The single-file `editable-html` mode includes the original `.fig` bytes as base64. This is preservation, not Round-trip — the embedded `.fig` is the original, untransformed.

**Provenance** (not Round-trip):
`.pen.json`'s `__figma.idMap` lets you walk a `Pen ID` back to the originating `GUID` / `Expansion Path`. This is a debugging trail — there is **no** `.pen.json → .fig` Repack mode. Editing `.pen.json` does not round-trip.

## Relationships

- A `.fig` file contains one **Document** (Tree root) → one or more **Pages** → arbitrary nested **Tree Nodes**.
- One `.pen` / `.pen.json` file pair corresponds to exactly one **Page**.
- One **Master** is referenced by zero or more **Instances** (same `.fig` file, possibly across multiple Pages).
- An **Instance** carries zero or more **Overrides** that modify the result of **Expansion**.
- **Expansion** turns one **Instance** + one **Master** into a Pen Node subtree; a single Master referenced by N Instances produces N independent expanded subtrees in the output.
- A `Tree Node` is either an **Instance**, a **Master**, or neither (any other `type`). A `Pen Node` is always neither (Expansion erases the distinction).

## Example dialogue

> **Engineer A:** "The .pen for the WEB page has 56 K nodes but the .fig only has 35 K. Why the inflation?"
> **Engineer B:** "Different pipeline phases. The .fig has 35 K **Tree Nodes**. After **Expansion** at the **Pen Node** phase, every **Instance** is replaced by an inlined copy of its **Master**'s subtree, so a Master used by N Instances contributes (1 + N×subtree_size) **Pen Nodes**."
>
> **Engineer A:** "OK. And the IDs are different?"
> **Engineer B:** "Yes — Tree Nodes carry the Figma **GUID** (`343:3534`). Pen Nodes carry a **Pen ID** (`A3CKa`). The mapping is in `__figma.idMap` of the `.pen.json` — that's the **Provenance** trail, not a Round-trip."
>
> **Engineer A:** "A user reports their .pen has the wrong text in one component instance. They edited `.pen.json`. Can we just re-Repack to .fig?"
> **Engineer B:** "No — there's no `.pen.json → .fig` Repack mode. JSON Repack reads `04_decoded/message.json`, not `.pen.json`. They'd have to find the originating `GUID` via the idMap and edit `message.json` instead."
>
> **Engineer A:** "I see a node with `enabled: false` in the .pen and an explicit `x: 129`, but in the source the master's `data.visible` is `true`. Why is it Hidden?"
> **Engineer B:** "Either **Property Visibility Toggle** flipped it (check the Instance's `componentPropAssignments` against the master child's `componentPropRefs[VISIBLE]`) or **Symbol Visibility Override** did (check `symbolOverrides[].visible: false` matched by guidPath). **Effective Visibility** is the OR-of-hidden of all three mechanisms."

## Flagged ambiguities

- "node" was used to mean any of `Kiwi Record`, `Tree Node`, `Pen Node`, or "a JSON object in a pages/*.json file" — resolved: always qualify by phase. Counts and IDs differ per phase.
- "Component" was used to mean both **Master** and **Instance** (mirroring Figma UI) — resolved: pick exactly one. They have different shapes and different IDs.
- "Symbol" was used to mean **Master** (matching the code type) but reads as JS-`Symbol`/general "symbol". Resolved: prefer **Master** in prose; `SYMBOL` only when referring to the literal `node.type` string.
- "id" was used to mean any of `GUID`, `Expansion Path`, or `Pen ID` — resolved: always qualify. Length, character set, and uniqueness scope differ.
- "Frame" was used to mean both Figma's `FRAME` `Tree Node` type and Pencil's `frame` `Pen Node` type — resolved: always qualify by phase.
- "container" was used to mean both the `.fig` ZIP wrapper and "any node that has children" — resolved: **Container** is the ZIP wrapper only; for a node-with-children, use `Tree Node FRAME` / `Pen Node frame` / `Master` / `Page` as appropriate.
- "archive" was used loosely for both the ZIP wrapper and the fig-kiwi structure inside `canvas.fig` — resolved: ZIP is `Container`, fig-kiwi is `Archive`.
- "visible" / "hidden" was used to mean any of three independent mechanisms — resolved: `Direct Visibility`, `Property Visibility Toggle`, `Symbol Visibility Override` are distinct; their composition is `Effective Visibility`. Pencil's `enabled: false` corresponds to `Effective Visibility = false`.
- "round-trip" was used to mean four different conversions (byte equality, kiwi equality, json equality, html embed) — resolved: pair with a `Repack` mode (Byte/Kiwi/JSON); embed and provenance are separate concepts that aren't round-trip.
