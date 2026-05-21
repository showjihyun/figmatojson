# spec/web-instance-render-overrides

| Field | Value |
|---|---|
| Status | Approved |
| Implementation | `collectFillOverridesFromInstance` + `toClientChildForRender` in `web/core/domain/clientNode.ts` |
| Tests | `web/core/domain/clientNode.test.ts` |
| Sibling | `web-instance-override.spec.md` (mutation side — the path that *writes* new text overrides via chat/HTTP) |

## 1. Goal

An INSTANCE inside a .fig produced by Figma often contains `symbolData.symbolOverrides[]` — the result of a designer changing text, color, stroke, etc. per instance. This spec defines how the **read path** (kiwi → DocumentNode conversion) casts those overrides onto the master's expanded subtree (`_renderChildren`).

Background — the Lucide-family icons in the metarich UI design .fig fixture (1,500+ masters / 400+ instances such as `u:check-circle`, `u:check`, `u:sign-out-alt`) all reuse the same master vector shape but override the fill color per instance to apply white/gray/blue across various buttons. If only the master fill is read, every instance appears in the same color, causing a visual discrepancy with Figma.

The earlier spec `web-instance-override.spec.md §5` declared "overrides on fields other than text (font/color)" as non-goals on the *mutation* side. This spec lifts that punt on the *render* side — the tool that *writes* a color override is still out of scope, but *reading* color overrides already baked into the .fig and *reflecting them on screen* is required.

## 2. Override entry shape

Each entry in `symbolOverrides[]` has this shape:

```ts
{
  guidPath: { guids: [{ sessionID, localID }, ...] },
  textData?: { characters: string, lines: ... },
  fillPaints?: Array<Paint>,
  // future: strokes?, effects?, opacity?, ...
}
```

- `guidPath.guids` is the absolute path inside the master — the chain from the outer instance's master root direct child down to the target. Starting at **v2** of this spec, **multi-step paths are supported** (in the Dropdown calendar case of the metarich UI design .fig fixture, only single-step handling caused multiple instances of one master to collide on the same last guid and lose their overrides — the v1 non-goal item was lifted).
- A single entry may carry multiple fields (text + fill, etc.) at once — each field is processed independently.

## 3. Invariants

### 3.1 Collection

- I-C1 `collectFillOverridesFromInstance(overrides)` and `collectTextOverridesFromInstance(overrides)` both return a `Map<pathKey, value>`. **`pathKey`** = `guids.map(g => '${sessionID}:${localID}').join('/')` — taking *Figma's path-key scheme* as-is and using it directly as the key. **(v3, round-25)** Meaning of the Figma scheme: from the outer instance's master root down to the override target, the path contains *only INSTANCE-typed ancestors and the target node*; **non-INSTANCE container ancestors such as FRAME / GROUP / SECTION are skipped from the path**. Example: master 64:376 (alret SYMBOL) → buttons FRAME 60:348 → 60:341 (Button INSTANCE) — the path-key of 60:341 is `"60:341"` (FRAME 60:348 not included). master 64:376 → 60:340 (Button INSTANCE) → inner master 5:44's TEXT 5:45 — the path-key of 5:45 is `"60:340/5:45"`. ~~The full path from the outer instance's master root down to the override target~~ **(deprecated v3)** — the latent bug from round-22/24 (match failure for targets inside a FRAME) was resolved in round-25.
- I-C2 Entries lacking `fillPaints` (or `textData.characters`) are ignored. They must pass an `Array.isArray` (or `typeof === 'string'`) check.
- I-C3 If `guidPath.guids` is empty or any element is not an integer `{sessionID, localID}` pair, the entry is ignored (silently skip — a corrupt override must not break the entire instance render).
- I-C4 ~~`guidPath.guids.length > 1` is ignored in v1~~ **(deprecated v2)** — multi-step paths are now handled normally.
- I-C5 If multiple entries define the same field at the same pathKey, the last one wins (last `Map.set` call wins).

### 3.2 Propagation

- I-P1 The INSTANCE branch of `toClientNode` calls both `collectTextOverridesFromInstance` and `collectFillOverridesFromInstance`.
- I-P2 Both override maps are passed to `toClientChildForRender` as arguments. The signature additionally takes **`pathFromOuter: string[]`**. **(v3, round-25)** Meaning of `pathFromOuter`: the *INSTANCE-typed ancestor* chain from the outer instance's master root down to the *parent* of the current node (FRAME/GROUP/SECTION containers excluded). Determining `pathFromOuter` for child recursion: if `n.type === 'INSTANCE'`, use `[...pathFromOuter, n.guidStr]` (the INSTANCE is added to the ancestor chain); otherwise pass `pathFromOuter` through unchanged (FRAME/GROUP/etc. are not added to the chain). The entry value is `[]`.
- I-P3 On entry to `toClientChildForRender`, `currentPath = [...pathFromOuter, currentGuidStr]`, `currentKey = currentPath.join('/')`. Immediately after the data spread, if `fillOverrides.get(currentKey)` matches, replace `out.fillPaints`. For TEXT, if `textOverrides.get(currentKey)` matches, set `out._renderTextOverride`.
- I-P4 During child recursion, pass `pathFromOuter = currentPath`. All descendants of the master accumulate a path relative to the outer instance.
- I-P5 **Merging overrides for descendants inside a nested INSTANCE**: if a child is an INSTANCE and that INSTANCE has its own `symbolData.symbolOverrides`, the inner own override path keys are *prefixed with the current path* and merged as new entries into the outer overrides before the inner expansion proceeds. That is, an inner single-step `[innerTextGuid]` is converted to a key equivalent to `[...currentPath, innerTextGuid]` so it can match inside the inner tree. Even if the inner does *not* have its own overrides, the outer overrides reach the inner descendants by path matching (the metarich Dropdown case).

### 3.3 Master immutability

- I-M1 The `fillPaints` on the master node itself (the SYMBOL/COMPONENT visited by `toClientNode`) is not modified — per-instance overrides apply only to the per-instance copy under `_renderChildren`.
- I-M2 Another INSTANCE referencing the same master carries its own fillOverrides and mutates only its own `_renderChildren` — there is no cross-talk between instances.

### 3.4 Component-property visibility binding (v3, round-12)

Background — in the metarich UI design .fig fixture, four components (alert / input-box / datepicker rail / dropdown) all leak the `u:arrow-right` icon inside the INSTANCE to the screen (Figma renders it hidden). Investigation (round 11 audit) showed this visibility is controlled not by `symbolOverrides[].visible` but by **Component Properties binding**:

- On the outer INSTANCE: `componentPropAssignments: [{ defID, value?: { boolValue }, varValue?: { value: { boolValue } } }]`
- On a descendant node inside the master: `componentPropRefs: [{ defID, componentPropNodeField: "VISIBLE" }]`
- When `defID` matches and `boolValue === false` → the descendant node is `visible: false`.

`pen-export.ts:920-1048` already implements this logic (`buildPropAssignmentMap` + `isHiddenByPropAssignment`). Spec v3 ports the same logic into `web/core/domain/clientNode.ts`.

#### Collection

- I-C6 `collectPropAssignmentsFromInstance(instData)` reads `instData.componentPropAssignments[]` from the INSTANCE and returns `Map<defIdKey, boolean>`. The key format is `${sessionID}:${localID}`. The value is `value.boolValue` first, falling back to `varValue.value.boolValue` (the variant-default-via-variable case). If neither is a boolean, skip the entry.
- I-C7 If `componentPropAssignments` is not an array or is empty, return an empty Map (silently skip corrupt data).

#### Propagation

- I-P6 The INSTANCE branch of `toClientNode` (line 69-92) also calls `collectPropAssignmentsFromInstance(data)`. The resulting map is passed to `toClientChildForRender` as a new argument `propAssignments`.
- I-P7 The signature of `toClientChildForRender` adds `propAssignments: Map<string, boolean>`. It is forwarded through child recursion as-is.
- I-P8 Immediately after the data spread (just before the existing `visOv` application at line 311-319), inspect `data.componentPropRefs`: if any ref has `componentPropNodeField === "VISIBLE"` and its `defID` resolves to `false` in `propAssignments`, set `out.visible = false`. Explicit visibility override (`visOv`) takes precedence — prop binding only determines the default.
- I-P9 **Nested INSTANCE merge**: if an inner INSTANCE has its own `componentPropAssignments`, those assignments are valid only inside that INSTANCE's expansion — enter the inner expansion with a new map that *overlays* the inner entries onto the outer propAssignments. (Unlike text/fill overrides, prop assignments are not path-keyed but *defID-keyed*, so no prefix is needed — if outer and inner define the same defID, inner wins within that INSTANCE scope.)
- I-P10 **Master immutability preserved**: prop-binding application happens only to the per-instance copy under `_renderChildren`. The `componentPropRefs` data on the master tree itself is not changed — other INSTANCEs must be able to expand the same master with different assignments.
- I-P11 **(round 15) `componentPropAssignments` inside outer symbolOverrides**: an outer INSTANCE's `symbolOverrides[]` may carry per-entry `componentPropAssignments` (the "this month"/"prev month" option case in the metarich Dropdown). These assignments are valid only for **INSTANCE descendants pointed to by the entry's guidPath** — they do not apply to the outer itself. Handling: `collectPropAssignmentsAtPathFromInstance(symbolOverrides)` returns `Map<pathKey, Map<defID, boolean>>`. When `toClientChildForRender` finds an entry matching `currentKey`, *overlay-merge* those assignments into the propAssignments map and enter the descendant expansion. Same rule as the general inner-INSTANCE merge (I-P9).
- I-C8 **TEXT_DATA prop binding** (round 33). The `componentPropNodeField: "TEXT_DATA"` variant of prop binding is handled by parallel collector + lookup:
  - `collectTextPropAssignmentsFromInstance(instData)` reads `instData.componentPropAssignments[]` and returns `Map<defIdKey, characters>`. The value is `value.textValue.characters` first, falling back to `varValue.value.textValue.characters`. Skip entries without a string value.
  - `toClientChildForRender` carries `textPropAssignments: Map<string, string>` as an additional inward-propagated parameter, alongside `propAssignments`.
  - For every TEXT descendant: after the path-keyed `textOverrides` lookup (which wins when present), call `textFromPropRefs(data, textPropAssignments)`. If it returns a string, set `out._renderTextOverride` to it.
  - **Path-key over prop-binding precedence**: the designer's literal `symbolOverrides[].textData.characters` is a more specific intent than the master-defined property hookup. Both can coexist; only the path-keyed one wins on conflict.
  - **Nested INSTANCE merge**: same defID-keyed flat-overwrite rule as I-P9 — inner INSTANCE's own text prop assignments overlay the outer's within the inner expansion. No path prefix (defID-keyed, not path-keyed).
  - **Material 3 motivation**: Date Picker day cells, action button labels ("Cancel"/"OK"), dropdown labels — every M3 component instance specifies its text this way. Without I-C8, master defaults like "00" / "Label" leak through every cell.

#### Notes

- ~~The prop binding's `componentPropNodeField` may also be `TEXT` or `INSTANCE_SWAP` in addition to `VISIBLE` (Figma's four property types: boolean/text/instance-swap/variant). Spec v3 handles only `VISIBLE`. The rest are deferred to a separate round.~~ **TEXT_DATA supported since round 33 — see I-C8 above. INSTANCE_SWAP is still deferred.**
- If the outer INSTANCE has a prop assignment but the master contains no matching `componentPropRefs` → no-op (silently).
- If a prop ref's `defID` is absent from the outer assignments → the master's default visibility is preserved (`out.visible` unchanged). Figma's semantic is "property unbound = use master default".

## 4. Render-side behavior

The VECTOR branch in `Canvas.tsx:244-265` (`Konva.Path`) and the general-node branch in `Canvas.tsx:281-316` (`Konva.Rect` + child recursion) are unchanged — they simply read `node.fillPaints`. All work in this spec is contained in the *data* transformation stage (clientNode.ts).

## 5. Error cases

- Session missing / master missing — same handling as in the existing INSTANCE branch (silently fall back to an empty instance).
- An override entry's `fillPaints` is null or wrong type — silently skipped by I-C2/C3.
- Conflicting text+color overrides at the same guidStr — both maps are populated and both apply (text via `_renderTextOverride`, color via `out.fillPaints` replacement) — no conflict.

### 3.5 TEXT styling override (round-26)

Background — the text overrides added in round-4 handled only `textData.characters` (the actual glyphs). However, measuring the distribution of INSTANCE symbolOverrides in the metarich audit corpus, **non-glyph styling fields on TEXT** — `fontSize` (1443), `fontName` (1436), `lineHeight` (1436), `letterSpacing` / `textTracking` (1423 each), `styleIdForText` (1418), `textAutoResize` (814), `fontVariations`, etc. — form the largest unhandled area of per-variant overrides. Round-26 applies these fields to descendant TEXT nodes at INSTANCE expansion time.

- I-S1 `collectTextStyleOverridesFromInstance(overrides) → Map<pathKey, TextStyleOverride>`. Extracts only the *whitelisted styling fields* from each entry (not the entire entry — text/fill etc. are handled by separate collectors). The pathKey scheme is exactly as in §3.1 I-C1 (round-25 v3).
- I-S2 **Whitelist** — list of TEXT styling fields applied:
  ```
  fontSize, fontName, fontVersion, lineHeight, letterSpacing, textTracking,
  styleIdForText, fontVariations, textAutoResize,
  fontVariantCommonLigatures, fontVariantContextualLigatures,
  textDecorationSkipInk, textAlignHorizontal, textAlignVertical
  ```
  Fields outside this list are ignored (either the responsibility of another collector or unsupported). Making the whitelist explicit (a) prevents accidentally overwriting unintended fields and (b) aligns with the fields Canvas actually reads (`web/client/src/lib/textStyle.ts` + `textStyleRuns.ts` convert the fields above into Konva.Text props).
- I-S3 If an entry has *none* of the fields above (only textData / fillPaints / size, etc.), it is not added to the map (silent skip — an empty record only adds meaningless lookups).
- I-S4 In `toClientChildForRender`, apply **only to TEXT nodes** (`n.type === 'TEXT'` guard). Even if a wrong-type match occurs, no application — Figma's refs also target TEXT nodes only.
- I-S5 Application happens **immediately after the data spread, in the same layer as fillPaints / visibility / derivedSize / derivedTransform application**. That is, if the master's fontSize is 18 and the override patches it to 14, then `out.fontSize = 14`. Partial overrides are preserved — if the override has only fontName, fontSize keeps the master value.
- I-S6 Nested INSTANCE prefix-merge — reuse the round-25 path-key plumbing as-is. If an inner INSTANCE has its own textStyleOverride, prefix its keys with the outer currentPath and merge as a new map.
- I-S7 Master immutability — application happens only to the per-instance copy under `_renderChildren`. The master TEXT data is not modified — other INSTANCEs of the same master transform only their own descendants with their own overrides.

Source case: in the metarich corpus, 1,443 INSTANCEs stamp `fontSize` differently from the master (e.g., TEXT 11:506 of the Dropdown is master Regular-14 but is patched to Medium under INSTANCE 11:529). Through round-25, the master's Regular-14 was rendered as-is, visually differing from Figma. From round-26, per-instance styled fonts are applied precisely.

### 3.6 Visual style override — stroke / cornerRadius / opacity (round-27)

Background — round-12 handled `fillPaints` overrides as a path-keyed application. Following the same pattern, other *visual* style fields are also overridden per INSTANCE. Metarich distribution: `strokePaints` (122 entries), `cornerRadius` family (5 fields × ~45 entries), `opacity` (11 entries). Round-27 applies these 7 fields using the same whitelist pattern as round-26 (TEXT styling).

- I-V1 `collectVisualStyleOverridesFromInstance(overrides) → Map<pathKey, VisualStyleOverride>`. Extracts only the whitelisted *visual* styling fields. The pathKey scheme is exactly as in §3.1 I-C1 (round-25 v3).
- I-V2 **Whitelist** — list of visual styling fields applied:
  ```
  strokePaints, opacity, cornerRadius,
  rectangleTopLeftCornerRadius, rectangleTopRightCornerRadius,
  rectangleBottomLeftCornerRadius, rectangleBottomRightCornerRadius
  ```
  `strokePaints` is an array (same shape as fillPaints — Paint[]); the other 6 fields are numbers. The precedence between `cornerRadius` and the four per-corner fields follows the master's general rule (masters with Figma's "independent corners" toggle on use the four per-corner fields, otherwise `cornerRadius`; overrides stamp under the same policy as the master).
- I-V3 If an entry has *none* of the fields above, it is not added to the map (silent skip — identical to round-26 I-S3).
- I-V4 In `toClientChildForRender`, apply **to all node types** (no TEXT-type guard). Stroke / corner / opacity are meaningful across a wide range of node types like FRAME / RECTANGLE / VECTOR. The absence of a type guard — unlike round-26's TEXT-only — is correct here.
- I-V5 Application happens **immediately after the data spread, in the same layer as other path-keyed overrides**. fillPaints (round-12) / TEXT styling (round-26) / this visual style (round-27) all patch master values to override values at the same point. Partial overrides are preserved — if the override has only strokePaints, cornerRadius / opacity keep the master values.
- I-V6 Nested INSTANCE prefix-merge — reuse the round-25 path-key plumbing as-is (same as round-22/24/26).
- I-V7 Master immutability — application happens only to the per-instance copy under `_renderChildren` (§3.3 I-M1).

Source case: in the metarich corpus, some INSTANCEs stamp the stroke color per variant (e.g., the input-box stroke color in focus state). Through round-26, only the master stroke was rendered → visually differing from Figma. From round-27, per-instance stroke / corner / opacity are applied precisely.

### 3.7 Auto-layout subset override — stackSpacing / padding (round-28)

Background — round-22 derivedSize + round-24 derivedTransform already stamp the *post-layout result*, so in theory stack* *cause* overrides are redundant. However, (a) not every descendant may be covered by derivedSymbolData, and (b) `applyInstanceReflow` reads the master's stackSpacing directly at the master root — if the override is applied at that point, reflow produces a different result. Round-28 is an *empirical attempt* narrowly scoped to 8 simple-value fields — if visible wins are 0, honestly close at 0; if wins appear, follow-up rounds.

- I-AL1 `collectStackOverridesFromInstance(overrides) → Map<pathKey, StackOverride>`. 8-field whitelist:
  ```
  stackSpacing, stackCounterSpacing,
  stackHorizontalPadding, stackVerticalPadding,
  stackPaddingLeft, stackPaddingRight, stackPaddingTop, stackPaddingBottom
  ```
  The pathKey scheme is exactly as in §3.1 I-C1 (round-25 v3).
- I-AL2 If an entry has *none* of the fields above, do not add it to the map (silent skip — same as round-26/27).
- I-AL3 In the INSTANCE branch of `toClientNode`, if an override matches the master root path-key (`master.guidStr`), *merge with masterData* before calling `applyInstanceReflow` so that reflow uses the override values. That is:
  ```ts
  const overrideAtRoot = stackOverridesByPath.get(master.guidStr);
  const effectiveMasterData = overrideAtRoot
    ? { ...masterData, ...overrideAtRoot }
    : masterData;
  applyInstanceReflow(expanded, effectiveMasterData, ...);
  ```
- I-AL4 When a stack* override matches a descendant FRAME, spread-apply onto `out` (for correctness — data consistency, even if Canvas does not read it directly). Reflow runs only at outer/nested INSTANCE boundaries, so descendant-FRAME overrides are likely redundant with the results already baked by round-22+24.
- I-AL5 Nested INSTANCE prefix-merge — reuse the round-25 plumbing as-is.
- I-AL6 Master immutability — the masterData merge produces only a *temporary object* at the moment of the reflow call; the master TreeNode itself is not mutated.

Source case: among metarich INSTANCEs, cases that stamp the master FRAME's stackSpacing / padding per variant (distribution ~1,000 entries). If a fired-reflow INSTANCE (instance < master shrunk) has spacing/padding overrides differing from the master, child positions change. If reflow does not fire, the override is redundant.

## 6. Non-goals (v1)

- ~~**stroke / opacity / cornerRadius overrides** — same pattern requires additional `collectStrokeOverridesFromInstance` etc. fillPaints is the most common case so it ships first. Extended in a later round.~~ **(supported since round-27 §3.6 — stroke + corner family + opacity, 7-field whitelist)**
- **effects / blendMode overrides** — not covered through round-27. blend/shadow/blur are a small slice of the metarich distribution (effects ~0, blendMode ~0). Candidates for a later round.
- ~~**Non-glyph styling-field overrides on TEXT** (`fontSize`, `fontName`, `lineHeight`, `letterSpacing`, etc.) — round-4 handled only glyphs.~~ **(supported since round-26 §3.5 — 14-field whitelist)**
- **colorVar / variable alias resolution** — an override's `colorVar.value.alias.guid` references a Figma variable. Our code reads only the literal `color` value and does not resolve variables (no visual loss because the .fig always stores the literal alongside).
- ~~**Multi-level nested INSTANCE overrides** — guidPath.length > 1. Ignored in v1 (I-C4).~~ **(supported since v2 — see I-P5)**
- ~~**Component property visibility binding** — `componentPropAssignments` ↔ `componentPropRefs[VISIBLE]`. Ignored in v1/v2.~~ **(supported since v3 round-12 — see §3.4)**
- ~~**Variant swap** — an entry inside `symbolOverrides[]` carrying `symbolID` means swapping that INSTANCE's master with another master (Figma's "swap component"). The 6th option of the metarich Dropdown swaps to the `state=selected` variant and that variant's TEXT is overridden to a "manual select" string. The path-keyed overrides in this spec alone cannot handle this case — variant swap is covered in a separate spec (one round later).~~ **(supported since round 16 — see `web-instance-variant-swap.spec.md`)**
- **Component property TEXT / INSTANCE_SWAP binding** — cases where `componentPropNodeField` is anything other than `VISIBLE`. Not implemented in v3. Next round.
- **Mutation tools (chat/HTTP)** — tools that *write* new color overrides are a separate spec (`set_fill_color` in `web-chat-leaf-tools.spec.md` also only changes the master; writing instance overrides is unimplemented).
- **Render-side dynamic cache invalidation** — fillOverrides application happens once at toClientNode build time. To mutate a color override at runtime, the documentJson must be rebuilt (the current behavior of structural ops — `web-undo-redo.spec.md §4.2`).

## 7. Routing impact

No routing changes — the `GET /api/doc/:id` response automatically includes the new `_renderChildren` with override-applied `fillPaints`.

## 8. Resolved questions

- **Express fillOverrides as a *replacement* of the master descendant's `fillPaints`, or as a *marker*?** — Replacement (Option A). `_renderChildren` is already a per-instance copy, so mutation is safe. Zero render-code changes. Text overrides use a marker pattern (`_renderTextOverride`) because `textData.characters` is deeply nested and a marker was lighter — fillPaints is a top-level array so direct replacement is natural.
- **Are `fillPaints[1..]` also overridden?** — The override entry's full `fillPaints` array replaces the master's. Even if the master was multi-paint, a single-paint override leaves only the single (Figma's behavior). If callers need array-length preservation, a separate policy is required.
- **Deep clone?** — The override fillPaints is referenced directly (`out.fillPaints = override`). If the same master entry is reused across multiple instances this is technically aliasing, but render code is read-only so it causes no actual problem. Switch to deep clone if a regression is found.
