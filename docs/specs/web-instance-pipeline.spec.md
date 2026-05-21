# spec/web-instance-pipeline

| Field | Value |
|---|---|
| Status | Approved (round 29) |
| Implementation | `web/core/domain/clientNode.ts` (`toClientNode`, `toClientChildForRender`, `applyInstanceReflow`) + `src/instanceOverrides.ts` (all path-keyed collectors + `mergeOverridesForNested`) + `src/masterIndex.ts` + `src/effectiveVisibility.ts` |
| Tests | `web/core/domain/clientNode.test.ts` |
| Siblings (per-feature) | `web-instance-render-overrides.spec.md`, `web-instance-autolayout-reflow.spec.md`, `web-instance-variant-swap.spec.md`, `web-canvas-instance-clip.spec.md` |
| Siblings (audit) | `audit-oracle.spec.md`, `audit-round11/GAPS.md` (per-round visual verification) |

## 1. Goal

Hold, in one place, the **cross-cutting contract** of the *read-side* INSTANCE transformation pipeline — kiwi `Tree Node` of type `INSTANCE` → `DocumentNode._renderChildren` (a per-instance copy of the master with overrides and auto-layout applied).

Background: across rounds 12-28 the INSTANCE pipeline grew through the combination of 7 path-keyed override kinds + variant swap + auto-layout reflow. Each per-feature spec carries its own "§3.1 I-C1 path-key definition" so the contract was *triply duplicated*, and the round-25 FRAME-skip discovery (WHATS-NOVEL §4.2) required simultaneous edits across all three specs, incurring drift cost. This spec lifts that cross-cutting contract into a single source.

Per-feature specs (override / reflow / swap / clip) retain their own *whitelist and semantics* as source. This spec covers only the *common notation, ordering, and invariants*.

## 2. Single entry point

```
toClientNode(treeNode, blobs, symbolIndex) : DocumentNode
  └ if treeNode.type === 'INSTANCE' && children.length === 0:
       1. resolve master via symbolIndex
       2. collect 10 path-keyed maps + 1 defID-keyed map (§4)
       3. expand master subtree → _renderChildren
            (recursion via toClientChildForRender, threading the maps)
       4. applyInstanceReflow(_renderChildren, masterData, finalSize, ...)
```

- I-E1 The **only entry point** to this pipeline = the INSTANCE branch of `toClientNode`. All callers (LoadSnapshot, FsSessionStore, messageJson) go through this function — if INSTANCE expansion logic lives in two places, divergence is immediate.
- I-E2 When the master is not in symbolIndex (deleted master / cross-file ref) — no `_renderChildren` is generated; fall back to an empty INSTANCE shell. Silent degrade — no thrown error (same policy as the assumption behind the 95% round-trip success rate).
- I-E3 When the INSTANCE *already* has children (test fixture / manual expansion), skip this branch — guarded by `n.children.length === 0`.
- I-E4 Master immutability: all transformations happen only on the *copy* inside `_renderChildren`. The master `TreeNode` itself must not be mutated. Even when N INSTANCEs reference the same master, there is no cross-talk (source: `web-instance-render-overrides.spec.md §3.3 I-M1/M2`).

## 3. Path-key contract — round-25 FRAME-skip

Common to **every** path-keyed collector and propagation. Fixed in round-25 — if this single contract breaks, 7+ override kinds silently miss simultaneously.

### 3.1 Notation

- I-K1 `pathKey = guids.map(g => '${g.sessionID}:${g.localID}').join('/')`.
- I-K2 An empty path's key is the empty string. Overrides applied directly to the master root (e.g., a stackSpacing root override) use the master's `guidStr` as a single-segment key.

### 3.2 Which ancestors enter the path (the Figma scheme)

- I-K3 **Included**: any `type === 'INSTANCE'` ancestor on the walk from the outer INSTANCE master root to the target, plus the target itself.
- I-K4 **Excluded (skipped)**: every *non-INSTANCE container* ancestor — `FRAME / GROUP / SECTION / COMPONENT_SET`, etc. These do not contribute to the path.
- I-K5 SYMBOL/COMPONENT (the master itself) also does not contribute — the master root is the "coordinate origin the path starts from", not a segment of the path.
- I-K6 Example (metarich alret SYMBOL 64:376):
  - master 64:376 → buttons FRAME 60:348 → Button INSTANCE 60:341 → `pathKey("60:341") = "60:341"` (FRAME 60:348 omitted).
  - master 64:376 → Button INSTANCE 60:340 → inner master 5:44's TEXT 5:45 → `pathKey("60:340", "5:45") = "60:340/5:45"` (60:340 is an INSTANCE so included; inner master 5:44 is a SYMBOL so excluded).

### 3.3 Who uses the keys

- I-K7 *Collection side*: the `guidPath.guids` already stamped by Figma's wire format under this scheme is used directly as the key. Collectors do not normalize separately.
- I-K8 *Propagation side*: at child recursion in `toClientChildForRender`, `pathFromOuter` is accumulated the same way as §3.2 — push onto the chain when `n.type === 'INSTANCE'`, otherwise forward the chain unchanged. The entry value is the empty array.
- I-K9 Lookup the collector map with `currentKey = [...pathFromOuter, currentGuidStr].join('/')`. Because wire and walker use the same scheme, key matching is guaranteed.

## 4. Path-keyed collectors — canonical list

All defined in `src/instanceOverrides.ts`. Each collector's *whitelist and semantics* are sourced in a sibling spec — this spec contains only the name and the *application-order table*.

| # | Collector | Key shape | Application point | Source spec |
|---|---|---|---|---|
| 1 | `collectTextOverridesFromInstance` | `Map<pathKey, characters>` | Immediately after TEXT data spread | render-overrides §3.1-3.2 |
| 2 | `collectFillOverridesFromInstance` | `Map<pathKey, Paint[]>` | Immediately after data spread | render-overrides §2-3 |
| 3 | `collectVisibilityOverridesFromInstance` | `Map<pathKey, boolean>` | Immediately after data spread | render-overrides §3.2 (visOv) |
| 4 | `collectTextStyleOverridesFromInstance` | `Map<pathKey, TextStyleOverride>` | Immediately after TEXT data spread (round-26) | render-overrides §3.5 |
| 5 | `collectVisualStyleOverridesFromInstance` | `Map<pathKey, VisualStyleOverride>` | Immediately after data spread (round-27) | render-overrides §3.6 |
| 6 | `collectStackOverridesFromInstance` | `Map<pathKey, StackOverride>` | Just before reflow call (master root) / after data spread (descendant) | render-overrides §3.7 |
| 7 | `collectSwapTargetsAtPathFromInstance` | `Map<pathKey, masterGuid>` | Inner-INSTANCE master lookup | variant-swap §3.1-3.2 |
| 8 | `collectPropAssignmentsAtPathFromInstance` | `Map<pathKey, Map<defID, boolean>>` | Just before entering inner-INSTANCE expansion | render-overrides §3.4 (I-P11) |
| 9 | `collectDerivedSizesFromInstance` | `Map<pathKey, {x,y}>` | Immediately after data spread (round-22) | autolayout-reflow §3.9 |
| 10 | `collectDerivedTransformsFromInstance` | `Map<pathKey, Transform2D>` | Immediately after data spread (round-24) | autolayout-reflow §3.10 |

In addition, one collector that is *not* path-keyed but defID-keyed:

| # | Collector | Key shape | Source spec |
|---|---|---|---|
| 11 | `collectPropAssignmentsFromInstance` | `Map<defID, boolean>` | render-overrides §3.4 (I-C6) |

This #11 is the outer INSTANCE's own prop assignments — not a path but the INSTANCE scope itself, where every descendant shares the same defID lookup (prop binding mechanism, see §6).

## 5. Application order — when multiple overrides match the same node

A node among the INSTANCE descendants may be hit by several of the collectors above. The application is *in a single data-transformation layer* — all handled inside a single `toClientChildForRender` call — so *order must be defined to guarantee determinism*.

### 5.1 Patch of the node's own data (immediately after data spread)

In the body of `toClientChildForRender`, the pattern is `out = { ...spread, ...patches }`. Patch application order:

- I-A1 `out.fillPaints = fillOverrides.get(currentKey) ?? out.fillPaints` (collector #2).
- I-A2 Spread the visual-style whitelist (collector #5) — `strokePaints`, `opacity`, `cornerRadius`, the 4 per-corner fields.
- I-A3 For TEXT nodes, spread the text-style whitelist (collector #4) — fontSize / fontName / lineHeight, etc., 14 fields.
- I-A4 For TEXT nodes, `out._renderTextOverride = textOverrides.get(currentKey)` (collector #1) — the glyphs themselves.
- I-A5 Apply derived size: `out.size = derivedSizes.get(currentKey) ?? out.size` (collector #9, round-22).
- I-A6 Apply derived transform: `out.transform = derivedTransforms.get(currentKey) ?? out.transform` (collector #10, round-24).
- I-A7 Explicit visibility override: `visibilityOverrides.get(currentKey) === false` → `out.visible = false` (collector #3).
- I-A8 Prop-binding visibility (merge of collector #11 + #8): for nodes where the explicit visibility was *not applied*, evaluate `data.componentPropRefs` + `propAssignments` → `false` → `out.visible = false`. **Explicit override wins over prop-binding** (source: `render-overrides §3.4 I-P8`).
- I-A9 Stack overrides on descendant FRAMEs (collector #6, round-28) are also spread — although visually likely redundant with round-22+24.

### 5.2 Just before entering an inner INSTANCE (master-lookup stage)

When a child is an `INSTANCE`, decide the following *in order* before expanding it:

- I-A10 **Decide swap target** (collector #7): on a `swapTargetsByPath.get(currentKey)` match, that GUID is the master-lookup key. Otherwise, use `data.symbolData.symbolID`. Swap must be decided *before* every other path-keyed override — subsequent collectors assume the swap target's GUID is the path segment.
- I-A11 **Compose propAssignments**: *overlay-merge* the entry of collector #8 that matches the current currentKey onto the outer defID-keyed map (`render-overrides §3.4 I-P11`).
- I-A12 Collect the inner INSTANCE's own `symbolOverrides` → *prefix-merge* with the outer overrides (see §5.4).

### 5.3 Reflow — after node patches and child recursion finish

- I-A13 When the master satisfies the trigger conditions of `applyInstanceReflow` (master `stackMode = HORIZONTAL/VERTICAL` + INSTANCE size ≠ master size, etc. — source: `web-instance-autolayout-reflow.spec.md §2`), reflow fires *on top of the expanded _renderChildren*.
- I-A14 At the reflow call site, `effectiveMasterData = a temporary object that spreads the stack override matching the master-root path (collector #6) onto master.data` (`render-overrides §3.7 I-AL3`). Reflow computes spacing/padding using the override values.
- I-A15 Reflow's coordinate changes are *additional patches* to children's `transform.m02/m12` — these patches happen *later* than round-24 derivedTransform (I-A6), but in cases where derivedTransform already stamped, the reflow result is equal or redundant.

### 5.4 Nested INSTANCE prefix-merge

When a child INSTANCE carries its own `symbolOverrides`, enter the inner expansion with new maps where the inner path-keyed map keys are prefixed by the outer currentPath (source: `render-overrides §3.2 I-P5`).

- I-A16 The prefix-merge applies to the path-keyed maps of collectors #1-10. The defID-keyed (collector #11) has no meaningful prefix, so it uses *overlay-merge* only.
- I-A17 Prefix-merge helper = `mergeOverridesForNested` (single source — do not roll your own per collector).

## 6. Effective visibility — the 3-mechanism OR

The final visibility of a `Pen Node` / `DocumentNode` is the **OR-of-hidden** of the three mechanisms below (any one says hidden → hidden). Matches the source in `CONTEXT.md §Visibility model`.

| Mechanism | Application layer | Source spec |
|---|---|---|
| Direct (`data.visible: false`) | Data-spread stage (carried naturally) | CONTEXT |
| Property-Toggle (componentPropRefs + propAssignments, collectors #11/#8) | I-A8 | render-overrides §3.4 |
| Symbol Visibility Override (collector #3) | I-A7 | render-overrides §3.2 |

- I-V1 Direct false → hidden.
- I-V2 Property-Toggle: a `componentPropNodeField === "VISIBLE"` ref exists and the matching defID's `boolValue === false` → hidden.
- I-V3 Symbol Override `visible: false` → hidden. **`visible: true` can override Direct false back to *visible*** — the only mechanism able to unhide hidden→visible (matches the `Symbol Visibility Override` item in CONTEXT.md).
- I-V4 Hidden outcome: `out.visible = false`. Canvas does not draw the node, and it is excluded from the auto-layout `visible-only` walk in reflow (round-19 MIN-pack / round-15 overlap-group).

## 7. Reflow vs transformation — who decides coordinates

Four mechanisms affect a single child node's `transform.m02/m12` and `size.x/y`. Application *priority* (later overwrites earlier):

1. Master's raw coordinates (data spread).
2. Round-22 derived size (collector #9, I-A5).
3. Round-24 derived transform (collector #10, I-A6).
4. `applyInstanceReflow` (I-A13) — last. Computes fallback coordinates for descendants that lack derived*.

- I-R1 If derivedSymbolData covers *every* descendant, reflow is a visual no-op. The 1,570 INSTANCEs in metarich carry `entry.transform` — in those cases reflow almost always produces a redundant result.
- I-R2 If derivedSymbolData covers *partially*, reflow fills the gap — the round-25 regression case of the alret modal is an example (before round-25, path-key mismatch caused derived* to miss, so reflow computed the wrong result).
- I-R3 The values from the two mechanisms may *differ* (when Figma's baking is stale before the designer's edits trigger recalculation). Reflow wins (I-A13 is last), but since round-22+24 stabilized, Figma's baking is treated as the *authority* — a future option to disable reflow is a candidate (§9 non-goals).

## 8. Render-side responsibilities

`web/client/src/Canvas.tsx` and `Inspector.tsx` *only read* the `DocumentNode` tree produced by this pipeline. No further transformation.

- I-D1 Canvas uses `node._renderChildren` as children when present — the patched expansion, not the master tree. INSTANCE auto-clip (`web-canvas-instance-clip.spec.md`) also applies on top of these children.
- I-D2 Canvas prefers `node._renderTextOverride` when present — wins over `textData.characters`.
- I-D3 Canvas skips nodes with `node.visible === false` and removes them from the auto-layout flow (Konva's listening:false + null return).
- I-D4 The data-transformation responsibility is *entirely* in this pipeline — no additional override / merge / reflow in Canvas. UI-side spec changes must not leak data-layer work to the client (architecture invariant — `docs/SPEC-architecture.md`).

## 9. Non-goals (cross-cutting)

This spec covers only the integration contract — the following are inherited from sibling specs' *non-goals* verbatim.

- **The path where a mutation tool (chat/HTTP) *writes* an INSTANCE override** — this pipeline is *read-only*. Mutations are in separate specs (`web-chat-leaf-tools.spec.md`, `web-instance-override.spec.md`).
- **componentPropNodeField TEXT / INSTANCE_SWAP** — same as render-overrides §3.4 non-goals. Distribution 0 in the metarich corpus (round-26 pre-flight measurement).
- **effects / blendMode override** — not covered through round-27.
- **colorVar / variable alias resolution** — literal values only.
- **An option to disable the integration of derivedSymbolData and reflow** — since round-22+24 settled, an option to *disable reflow and trust derived\* only* is a candidate. Not implemented.
- **Automated multi-page audit** — same as audit-oracle.spec.md non-goals.
- **Accurate boolean-operation compositing** — same as `vector-decode.spec.md §6`.

## 10. Resolved questions

- **Why function composition rather than a single use-case?** `toClientNode` is not a use-case in the `application/` layer; it is a pure transformation in `domain/` — no IO/session. Its entry points are the three: `UploadFig` / `LoadSnapshot` / `messageJson reviver`. A single function contract is the SDD-aligned choice, and this spec defines that contract.
- **Why not delete the path-key contract from sibling specs after lifting it here** — the round-25 change history is documented inside the sibling §3.1 (deprecated-v3 marker). History-preservation vs DRY trade-off — when a new round is added, only §3 of this spec is updated; the sibling §3.1 is gradually replaced with "see web-instance-pipeline §3".
- **Is collector #6 (stack)'s difference between master-root and descendant handling clear in the sibling spec?** Sourced in render-overrides §3.7 I-AL3 (root) / I-AL4 (descendant). This spec's §5.1 I-A9 + §5.3 I-A14 show only the application order.
- **Why is prop-binding both path-keyed (#8) and defID-keyed (#11)?** Because that is the Figma wire format. The outer INSTANCE's own prop assignments broadcast to the whole INSTANCE-scope (defID); a descendant INSTANCE's swap-context prop assignments are confined to within that path (path-keyed). The two collectors collect separately and merge at application time (I-A11).
