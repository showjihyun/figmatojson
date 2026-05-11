# spec/audit-oracle

| Field | Value |
|---|---|
| Status | Approved (round 31) |
| Implementation | `figma-plugin/{manifest.json, code.js, ui.html}` + `web/core/application/AuditCompare.ts` + `web/server/adapters/driving/http/auditRoute.ts` |
| Tests | (TODO) `web/core/application/AuditCompare.test.ts` — one assertion per invariant in this spec |
| Siblings | `web-upload-fig.spec.md` (sessionId allocation), `round-trip-invariants.spec.md` (parser self-validation) |
| Baseline | bvp.fig current page: 704 matched / 18,304 compared / **99.47% match** (round 31, commit 690e856). Of the remaining 97 diffs, 30 are follow-up signals for round-26/27 nested-instance overrides; the rest are §7 known artifacts. |
| Baseline (REST, R12) | HPAI fixture (`dZQkxC9NZJ0z5WpYRtXCRq`): 17,283 matched / 18,301 figma nodes / **204 diffs** (round 32, R12-A/B/D). 5,695 → 204 (96.4% reduction). Of the remaining 204, `rotation` 87 + `cornerRadius` 86 are known noise (§7.2); real parser-signal candidates are ~18 (`transform/size` 5 + `strokes/fills.length` 13). |

## 1. Goal

An *external oracle* that verifies whether the result of `figma-reverse`'s parser decoding a `.fig` binary matches the tree *Figma itself* sees when opening the same file. Round-trip verification (parser → repack → re-parse) only confirms that our code agrees with itself — it does not tell whether we agree with Figma's interpretation. This spec defines the plugin-based comparison pipeline that closes that gap.

The plugin sandbox serializes `figma.currentPage` into a normalized JSON → ships it to the backend → matches node ids against our parser tree under the same `sessionId` → aggregates per-field diffs. The resulting `topFields` points to *the biggest parser bug to fix next*.

## 2. Component split

| Component | Responsibility | File |
|---|---|---|
| **Plugin sandbox** | Serialize the `figma.currentPage` tree | `figma-plugin/code.js` |
| **Plugin UI** | `.fig` upload + sessionId holding + sandbox call + diff display | `figma-plugin/ui.html` |
| **HTTP route** | `POST /api/audit/compare` — `{ sessionId, figmaTree }` → diff JSON | `web/server/adapters/driving/http/auditRoute.ts` |
| **Use case** | Tree indexing, field comparison, diff aggregation | `web/core/application/AuditCompare.ts` |

## 3. Plugin sandbox — `serializeNode` output contract

The shape of tree nodes the plugin sends to the backend. **This field list is the upper bound on what can be compared** — adding a new field requires changing the plugin and the use case in lockstep.

- I-S1 All nodes: `id` (string), `type` (string), `name` (string), `visible` (boolean).
- I-S2 Size-capable nodes: `size: { x, y }` (Figma plugin's `width`/`height`). Emit only when both width/height fields are present.
- I-S3 Position-capable nodes: `transform: { m02, m12 }` (Figma plugin's `x`/`y`, parent-relative absolute coordinates). `m02`/`m12` matches our parser's transform matrix naming — only the translation components are compared.
- I-S4 Emit *only when non-default*: `rotation` (≠ 0), `opacity` (≠ 1), `cornerRadius` (≠ 0). Saves plugin-side wire bytes + provides the bidirectional omission contract with `FIELD_DEFAULTS` (see §5.4).
- I-S5 *Always* emit (when present): `strokes`, `strokeWeight`. The distinction between empty-array and field-absent is meaningful as an audit signal, so default omission is not applied.
- I-S6 Paint serialization: entries in `fills` / `strokes` go through `serializeFill`. Currently only `SOLID` is body-serialized (`{ type, color: {r,g,b}, opacity, visible }`). Non-SOLID paints emit only `{ type }` and have no body comparison — *only paint length* is compared in spec v1 (see §5.2).
- I-S7 TEXT only: `characters`, `fontSize`, `fontName: { family, style }`. Non-TEXT does not emit (enforced by the §5.3 gate).
- I-S8 Auto-layout-capable nodes (`layoutMode != null && != 'NONE'`): `stackMode` (= layoutMode), `stackSpacing` (= itemSpacing), `stackPaddingLeft/Right/Top/Bottom`, `stackPrimaryAlignItems`, `stackCounterAlignItems`. If `layoutMode` is `NONE` or absent, do not emit.
- I-S9 Container nodes: recursive `children: SerializedNode[]`.
- I-S10 Excluded fields: prototyping (`reactions`), runtime-only (`absoluteRenderBounds`), and anything the Figma plugin API exposes that our parser cannot know. Adding a field requires modifying the plugin sandbox + the use case + §3 and §5 of this spec together.

## 4. Plugin → backend protocol

- I-P1 The plugin UI first accepts a `.fig` from a user file picker and uploads it to the backend's `POST /api/upload` → obtains a `sessionId` (contract of web-upload-fig.spec.md).
- I-P2 The plugin UI postMessages `{type: 'serialize-current-page'}` to the sandbox → the sandbox serializes `figma.currentPage` per §3 → responds with `{type: 'serialize-result', tree}`. On failure, `{type: 'serialize-error', error: string}`.
- I-P3 The plugin UI ships `{sessionId, figmaTree}` to the backend's `POST /api/audit/compare`. The response is the §6 `AuditCompareOutput`.
- I-P4 The manifest's `networkAccess.devAllowedDomains` allows only `http://localhost:5274` (dev backend port). `allowedDomains` is `["none"]` — no production deployment; the audit always presumes a local dev environment.
- I-P5 sessionId life-cycle: volatile across backend restarts → on `404 session not found`, the correct response is *re-upload + retry* in the plugin UI; server-side auto-recovery is not attempted.

## 5. AuditCompare — matching and comparison rules

### 5.1 Indexing

- I-A1 Both trees are indexed as `id → node` maps. Nodes without ids are skipped.
- I-A2 `SKIP_TYPES = { VARIABLE, VARIABLE_SET }` — Figma's plugin/REST APIs do not expose variables as tree children, but our parser walks them in the kiwi tree. Skipping them (and their entire subtree) on both sides removes `onlyInOurs` noise.
- I-A3 Matching is 1:1 by `id`. If a node is in the plugin tree but not in ours, `onlyInFigma++`; the reverse increments `onlyInOurs`. When ids match, proceed to per-field comparison per §5.2–5.4.
- I-A3a (round 31) **Composite ID matching** — INSTANCE descendants are exposed by the plugin side as `I<instance.guid>;<master.overrideKey>`. Our parser stores the same data in `INSTANCE._renderChildren` along with the master's `overrideKey`, so during kiwi indexing we walk `_renderChildren` for each INSTANCE and additionally register the key `I<instanceId>;<sessionID>:<localID>`. A synthetic node without an `overrideKey` is not registered (it cannot be matched, although it is still visible under its plain `id` key). Recursion follows both `children` and `_renderChildren`.
- I-A3b (round 31) **Group transform flattening** — the Figma plugin treats GROUP as transform-transparent and emits a child's `node.x/y` relative to the *GROUP's parent*. Our kiwi stores transforms relative to the parent (group-relative). During kiwi-side indexing, we accumulate the `transform.m02/m12` of GROUP-like ancestors onto descendants to compute effective coordinates. The plugin tree is already flattened on arrival, so no extra processing is needed.
- I-A3c (round 31) **`isGroupLike` heuristic** — kiwi stores Figma's `GROUP` as type=`FRAME` + `resizeToFit=true` + empty `fillPaints`. Just before comparing a matched node, normalize our side's view as `{ ...n, type: 'GROUP', strokeWeight: undefined }` — that way the §5.3 type comparison passes with the alias and kiwi's default `strokeWeight=1` does not produce false positives in areas the plugin does not emit either.

### 5.2 Comparable fields

`COMPARABLE_FIELDS` is the single source of truth. Each entry is `{ field, pickFigma, pickOurs, gate? }`.

- I-A4 Same key on both sides: `type`, `name`, `visible`, `size.x`, `size.y`, `transform.m02`, `transform.m12`, `opacity`, `cornerRadius`.
- I-A4a (round 31) `rotation` — the plugin emits a degrees scalar; kiwi stores sin/cos inside the transform matrix. `pickOurs` derives it via `atan2(m01, m00)` and converts to degrees (`* 180/π`). The sign convention matches the plugin's clockwise-from-baseline directly (no negation). When the matrix is identity (m01≈0 && m00>0), return `undefined` and rely on the default 0 substitution.
- I-A4b (round 31) `strokeWeight` — compare only when the gate `figma.strokes.length > 0` is true. The plugin/REST omits strokeWeight on stroke-less nodes, but kiwi carries the default 1. Without the gate, 500+ false positives.
- I-A4c (round 32, R12-A) **Rotated-node transform/size gate** — the four entries `transform.m02`, `transform.m12`, `size.x`, `size.y` are compared only when both sides have `rotation === 0` (or undefined → default 0). On rotated nodes the representations have different meanings:
    - kiwi `transform.m02`/`m12` = parent-relative coordinate of the *pre-rotation* anchor.
    - REST `absoluteBoundingBox.x`/`y` = top-left of the *post-rotation* axis-aligned bbox.
    - kiwi `size.x`/`y` = pre-rotation width/height. REST `absoluteBoundingBox.width`/`height` = post-rotation axis-aligned bbox width/height.
  In the plugin trial, `node.x`/`y`/`width`/`height` are all pre-rotation values, so the semantics align → that baseline (bvp metarich 99.47%) is unaffected. This gate cleans up false positives on the REST adapter side *only*. The gate can be removed once both sides are normalized to a post-rotation axis-aligned bbox in round 33+.
  `isRotated(n)`:
    - figma side: `typeof n.rotation === 'number' && n.rotation !== 0`.
    - ours side: `transform.m01 !== 0 || (transform.m00 ?? 1) < 0`. m00<0 alone also indicates a 180° rotation that a simple m01 check would miss — the 700:160 case (m00=-1, m11=-1) is exactly this branch.
- I-A5 Different keys: `fills.length` (plugin `fills` ↔ kiwi `fillPaints`), `strokes.length` (plugin `strokes` ↔ kiwi `strokePaints`). v1 compares *length only* — paint bodies (color, gradient stops, image) are non-goals per §7.
- I-A6 TEXT only (gate = `type === 'TEXT'`): `characters` (plugin `characters` ↔ kiwi `textData.characters`), `fontSize`, `fontName.family`, `fontName.style`.
- I-A7 Auto-layout only (gate = `stackMode != null && stackMode !== 'NONE'`, Figma side as authority — our parser always carries latent values, so compare only when the plugin side is on): `stackSpacing`, `stackPaddingLeft/Right/Top/Bottom`, `stackPrimaryAlignItems`, `stackCounterAlignItems`.
- I-A8 Padding fallback: our parser's `pickOurs` falls back to the legacy axis-paired fields (`stackHorizontalPadding` / `stackVerticalPadding`) when per-side values (`stackPaddingLeft`) are missing. Same policy as the fallback in `Inspector.tsx`.

### 5.3 Type aliases

- I-A9 Compare the `type` field after normalizing both sides via `TYPE_ALIASES`:
  - `SYMBOL` (kiwi) → `COMPONENT` (Figma plugin/REST naming)
  - `ROUNDED_RECTANGLE` (kiwi) → `RECTANGLE` (Figma — corner-radius is a property, not a separate type)
  - `CANVAS` (kiwi) → `PAGE` (plugin's `figma.currentPage.type`)
  - Other type names pass through.
- I-A9a (round 31) `FRAME` (kiwi) → `GROUP` (plugin/REST) — not a direct type alias but `type: 'GROUP'` is forced after the `isGroupLike` check (§5.1 I-A3c). A plain alias would break the general FRAME case, so this is kept separate.

### 5.4 Field defaults / value aliases

- I-A9b (round 32, R12-D) **`VALUE_ALIASES` — schema-level renames of the same enum binary value**. `SPACE_EVENLY` (kiwi schema, value=3) on `stackPrimaryAlignItems` and `SPACE_BETWEEN` (Figma's current name, emitted by REST/plugin) are the same binary value renamed across schema versions. Just before comparison, normalize both sides via the alias map — `pickFigma` / `pickOurs` themselves are unchanged; execution happens through entry-level aliasing in `fieldDiffers`. If the same pattern is found in other enums, add them here. Currently registered:
    - `stackPrimaryAlignItems`: `SPACE_EVENLY` ↔ `SPACE_BETWEEN`
- I-A10 `FIELD_DEFAULTS` map enforces the equivalence `figma=undefined ↔ ours=<default>`. Currently registered defaults:
  - `opacity: 1`, `rotation: 0`, `cornerRadius: 0`, `strokeWeight: 0`, `visible: true`, `fills.length: 0`, `strokes.length: 0`, `transform.m02: 0`, `transform.m12: 0`.
  - (round 31) `stackSpacing: 0`, `stackPaddingLeft/Right/Top/Bottom: 0`, `stackPrimaryAlignItems: 'MIN'`, `stackCounterAlignItems: 'MIN'`. Bridges the gap between the plugin's "always emit resolved value" and our "kiwi-stored only" emission. These defaults affect comparison only after the §5.2 stack-gate fires.
- I-A11 Order of default application: if one side is `undefined`, substitute the default → then apply the §5.5 equality rule.

### 5.5 Equality and tolerance

- I-A12 Equal under `===`.
- I-A13 Both `null` or `undefined` are equal (a null pair that survives default substitution).
- I-A14 Both numbers and both `NaN` are equal — kiwi emits the NaN bit-pattern as the default for unset stack* spacing, and the plugin sandbox carries the same value as-is.
- I-A15 Both numbers and `Math.abs(orig - rt) < 0.5` are equal. Rationale: the plugin uses native floats; our parser, on some paths, round-trips through Float32 (`Math.fround`) → sub-0.5px differences are invisible on screen.
- I-A15a (round 32, R12-B) **Rotation modular tolerance**: for `field === 'rotation'`, apply *360° wrap-around* tolerance instead of the plain 0.5-absolute tolerance. Normalize to [-180, 180] via `((a - b) mod 360 + 540) mod 360 - 180` and treat equal when `Math.abs(diff) < 0.5`. Absorbs cases where different sign pairs represent the same rotation (180 ↔ -180, 270 ↔ -90, etc.) and the sign flutter of atan2 derivation near ±90° (`audit-oracle.spec.md §7.2`). In the HPAI baseline we expect most of the remaining 193 rotation diffs to clear under this modular wrap.
- I-A16 Otherwise, differ.

## 6. AuditCompare — output contract

```ts
interface AuditCompareOutput {
  summary: {
    figmaNodeCount:  number;  // entries on the Figma side after §5.1 indexing
    ourNodeCount:    number;  // entries on our side
    matchedNodes:    number;  // ids present on both sides
    onlyInFigma:     number;
    onlyInOurs:      number;
    totalDiffs:      number;  // sum of differing fields across matched nodes
  };
  topFields: Array<{ field: string; count: number }>; // count desc
  sample:    DiffEntry[]; // up to 200 entries: { id, field, origValue, rtValue }
}
```

- I-O1 `topFields` is the descending-count sort by `field`. Tie-break is insertion order (Map iteration).
- I-O2 `sample` is up to 200 entries *in discovery order* — a truncation policy for round 33+ is future work for this spec.
- I-O3 Response body is JSON; errors are `NotFoundError` thrown by the use case → HTTP 404 (`session ${sessionId} not found`). Other unhandled exceptions are mapped to 500 by `errors.toHttpError`.

## 7. Non-goals + known noise (round 31)

### 7.1 Non-goals (outside the code area)

- ❌ Paint body comparison (color rgba, gradient stops, image hash). v1 is length only (§I-A5). Round 32+ work extends `serializeFill` + sorts `pickOurs`.
- ❌ Effect comparison (`effects[]` — DROP_SHADOW / INNER_SHADOW / LAYER_BLUR).
- ❌ Vector geometry (`vectorNetwork`, `commandsBlob`). See the separate vector-decode spec.
- ❌ Prototyping / interaction / reactions.
- ❌ Variant `componentPropDefs` / `componentPropAssignments` comparison — the Figma plugin API's exposure shape does not align 1:1 with our kiwi fields.
- ❌ Multi-page audit. v1 always covers only the single `figma.currentPage`. The expected user pattern is to switch pages in Figma Desktop and run audit again.
- ❌ Production deployment. The manifest's `networkAccess.allowedDomains: ["none"]` enforces this — this plugin is a dev-only audit oracle.

### 7.2 Known noise (not actual parser bugs — exclude when evaluating audit signal)

- ✅ **Schema enum rename**: `stackPrimaryAlignItems` `SPACE_EVENLY` (kiwi value=3) ↔ Figma's current name `SPACE_BETWEEN`. Handled by round 32 (R12-D) `VALUE_ALIASES`. Remaining: 0.
- 🟢 **Plugin mixed-font omission**: when a TEXT node's `fontName` is mixed (multiple fonts within a single text), the plugin sandbox omits it. Our parser emits the master node's single fontName → false positive. A future plugin-side gate `fontName !== figma.mixed` can improve this, but the audit-signal impact is small.
- ✅ **Rotation matrix edge**: near `±90°` rotation where matrix m00 is near zero, atan2 derivation drifts slightly. Absorbed by the round 32 (R12-B) modular wrap tolerance (§I-A15a). Remaining: ~0.
- 🟢 **VECTOR icon `cornerRadius`** (REST only): REST estimates curvature from path geometry and emits cornerRadius. The plugin does not. Our parser does not store VECTOR cornerRadius separately. Visible only via REST.
- ✅ **GROUP↔FRAME naming**: handled by §5.1 I-A3c / I-A9a. Remaining: 0.
- ✅ **Rotated-node transform/size representational difference** (round 32 R12-A, REST only): the §I-A4c gate skips comparison of transform.m02/m12/size.x/y on rotated nodes. Cleans up ~5K signals in the HPAI baseline. No impact on plugin trials.

## 8. Resolved questions

- **Does the plugin need to upload the .fig itself?** Yes. The plugin sandbox has no file-system access, so it cannot directly know which file the backend is looking at. The user manually re-supplies the same file to the plugin UI via the picker → obtains `sessionId` → matches against the sandbox tree.
- **Why `figma.currentPage` only?** Walking `figma.root.children` in the plugin sandbox lazy-loads every page's SceneNodes, and with many pages Figma Desktop becomes sluggish. Looking at one page at a time fits the *cost model of an audit oracle*. If a multi-page audit is needed, the user switches pages and re-runs.
- **Is it OK to enshrine `NaN === NaN` equality in the spec?** Yes. It is a wire-format fact that the kiwi schema emits the NaN bit-pattern as the default for unset floats, and we verified this holds equally for Figma and our parser (a spot check in the setup-only stage of round 29). If we treated NaN as differing, 80%+ of the audit signal would be filled with stack* defaults.
