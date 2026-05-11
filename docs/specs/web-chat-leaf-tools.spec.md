# spec/web-chat-leaf-tools

| Field | Value |
|---|---|
| Status | Approved |
| Implementation | `set_text` / `set_position` / `set_size` / `set_fill_color` / `set_corner_radius` / `align_nodes` cases in `web/server/adapters/driven/applyTool.ts` |
| Tests | `web/server/adapters/driven/applyTool.test.ts` |
| Dependencies | `EditJournal` port, `ToolDispatcher` catalog (`InProcessTools.ts`) |
| Siblings | `web-chat-duplicate.spec.md` (structural), `web-group-ungroup.spec.md` (structural), `web-edit-node.spec.md` / `web-resize-node.spec.md` / `web-instance-override.spec.md` (HTTP route side) |

## 1. Goal

Define, in one place, the leaf-mutation tools invoked from the AI chat (`Apply edits via the figma_editor tools.`). Each tool mutates a specific field of a single node (or, for align, the m02/m12 of N nodes) and emits a single `JournalEntry`.

Common leaf-tool pattern:
- Enter via `applyTool(s, name, input, journal)`.
- `findNode(guid)` locates the target node in `msg.nodeChanges`.
- In-place mutate the node → `writeFileSync(messagePath, JSON.stringify(msg))` → sync the client tree via `mirrorClient(guid, mutator)` → record into the journal via `recordChatEdit(label, patches)`.
- Output is void — `ToolDispatcher` wraps it as `{ok: true}`.

Unlike structural tools (`duplicate` / `group` / `ungroup`):
- Patches are emitted in leaf shape `{guid, field, before, after}` (no `MSG_SENTINEL_GUID`).
- No wholesale rebuild of `documentJson` is triggered (in-place updates via `mirrorClient`).

`web-edit-node` / `web-resize-node` / `web-instance-override` are **separate surfaces** that accept semantically identical mutations via HTTP routes — this spec covers the chat-tool branch only.

## 2. Common invariants

Applies to all tools below:

- I-C1 If `findNode` cannot find the node on entry, throw `Error("node <guid> not found")` (or a per-tool prefix). No write occurs before the throw — neither disk nor journal is dirtied.
- I-C2 On success, exactly one `JournalEntry` is recorded. label = `"AI: <tool>"` (align is `"AI: align <axis>"`).
- I-C3 The patch's `before` is the value just before the mutation; `after` is the value just after. Both are deep clones (objects/arrays via `clone(...)` = `JSON.parse(JSON.stringify(...))`) — preventing aliasing from later mutations.
- I-C4 The mutation changes the matching node in `msg.nodeChanges` in-place, then `writeFileSync` flushes to disk synchronously. The same change is mirrored into `s.documentJson` via `mirrorClient`.
- I-C5 The `record` call happens after the disk write — if the write throws, the journal is not dirtied either (the guarantee strengthens after atomic write is introduced — see `web-undo-redo.spec.md §6 I-E3`).
- I-C6 Within a single `applyTool` invocation, only one tool runs (switch). Batching multiple tools is expressed as N dispatcher-level invocations.

## 3. set_text

```ts
input  = { guid: string, value: string }
output = void
label  = 'AI: set_text'
patches = [{ guid, field: 'textData.characters', before, after }]
```

- I-T1 `node.textData.characters` is set to `String(value)`. If `textData` is absent, an empty object is created and then set.
- I-T2 `before` is the `textData.characters` value just before the mutation. If textData was absent altogether, it is `undefined`.
- I-T3 When the master text (`guid`) is cached on INSTANCEs' `_componentTexts[]`, walk the `documentJson` tree and also update `r.characters` of every entry with `r.guid === input.guid` to `after` (immediate reflection in the inspector's component-text panel).
- I-T4 INSTANCE per-instance overrides (`symbolData.symbolOverrides` / `_instanceOverrides`) are not changed — this tool touches the master only (overrides are the responsibility of `override_instance_text`).
- I-T5 (Known limitation) Undo of set_text does not refresh the `_componentTexts` cache (see `web-undo-redo.spec.md §9`).

## 4. set_position

```ts
input  = { guid: string, x: number, y: number }
output = void
label  = 'AI: set_position'
patches = [
  { guid, field: 'transform.m02', before, after },
  { guid, field: 'transform.m12', before, after },
]
```

- I-P1 `node.transform.m02 ← Number(x)`, `node.transform.m12 ← Number(y)`. If the transform object is absent, an empty object is created and then set.
- I-P2 Rotation channels (`m00/m01/m10/m11`) are not changed — this tool handles translation only.
- I-P3 Patches are always two (`m02`, `m12`) — even if only one of x/y changed, both are emitted (when the caller passes back the existing value, a patch with before === after is recorded).
- I-P4 The unit is the transform's native unit (px). Negative values from the caller are applied as-is.

## 5. set_size

```ts
input  = { guid: string, w: number, h: number }
output = void
label  = 'AI: set_size'
patches = [
  { guid, field: 'size.x', before, after },
  { guid, field: 'size.y', before, after },
]
```

- I-Z1 `node.size = { x: max(1, Number(w)), y: max(1, Number(h)) }`. Inputs ≤ 0 are clamped to 1.
- I-Z2 `before` is the pre-mutation `size.x` / `size.y`. If size was absent, both are `undefined`.
- I-Z3 `transform` is not changed — position is fixed.
- I-Z4 The entire size object is replaced with a new object (reassign, not in-place) — non-standard keys (`width`/`height`, etc.) that may have existed are dropped. No regression risk because current kiwi output has only `x`/`y`.

## 6. set_fill_color

```ts
input  = { guid: string, r: number, g: number, b: number, a: number }
output = void
label  = 'AI: set_fill_color'
patches = [{ guid, field: 'fillPaints', before, after }]
```

- I-F1 `node.fillPaints[0].color = { r, g, b, a }` (each coerced to `Number(...)`). If `fillPaints[0]` is absent, a new `{type:'SOLID', visible:true, opacity:1}` is created.
- I-F2 `fillPaints[1..]` is not changed — only the first paint's color is changed.
- I-F3 Patch `before` / `after` are deep clones of the entire fillPaints array. Even for a single color change, the whole array is captured because paints are multi-layer objects (type / visible / opacity / blendMode / color / gradientStops / image), which would be cumbersome to express via a single path.
- I-F4 r/g/b/a are assumed in the 0..1 range. No clamp for out-of-range values — caller's responsibility.

## 7. set_corner_radius

```ts
input  = { guid: string, value: number }
output = void
label  = 'AI: set_corner_radius'
patches = [{ guid, field: 'cornerRadius', before, after }]
```

- I-R1 `node.cornerRadius = max(0, Number(value))`. Negative inputs clamp to 0.
- I-R2 `rectangleCornerRadiiData` (per-corner) is not touched — uniform radius only.
- I-R3 No node-type validation — calling it on a node where cornerRadius is meaningless (e.g., TEXT) still applies it. Rendering ignores it.

## 8. align_nodes

```ts
input  = { guids: string[], axis: 'left'|'center'|'right'|'top'|'middle'|'bottom' }
output = void
label  = `AI: align ${axis}`
patches = (N entries of transform.m02 or transform.m12 depending on axis)
```

- I-A1 `guids.length < 2` → `Error("align_nodes needs >= 2 guids")`. 0 / 1 carries no alignment meaning.
- I-A2 All `guids` must exist — if any `findNode` fails, throw `Error("node <guid> not found")`. No partial mutation.
- I-A3 Group bbox = `(min(x), min(y))` to `(max(x+w), max(y+h))` — computed solely from members' `transform.m02/m12` and `size.x/y` (no rotation, AABB).
- I-A4 New m02/m12 per axis:
  - `left`   → `m02 = groupX`
  - `center` → `m02 = (groupX + groupRight) / 2 - w/2`
  - `right`  → `m02 = groupRight - w`
  - `top`    → `m12 = groupY`
  - `middle` → `m12 = (groupY + groupBottom) / 2 - h/2`
  - `bottom` → `m12 = groupBottom - h`
- I-A5 Only patches for the changed axis are emitted — horizontal axes (`left`/`center`/`right`) emit N m02 patches; vertical (`top`/`middle`/`bottom`) emit N m12 patches. The unchanged axis is absent from patches (prevents Undo from translating along the wrong axis).
- I-A6 Even if some members are already at the aligned position, patches are still emitted (before === after). Same reason as I-P3.
- I-A7 Unknown axis → `Error("align_nodes: unknown axis <axis>")`.
- I-A8 Members' `parentIndex` is not changed — align touches only transforms.

## 9. Error cases (common across all tools)

- Session not found → caller (`ToolDispatcher`) throws before reaching `findNode`.
- Node not found → I-C1.
- `writeFileSync` failure during mutation → propagates to the caller; journal is not dirtied (guarantee strengthens after atomic write).
- Axis validation for align → I-A7. Other tools do not validate input — if the caller passes the wrong type, `Number(...)` / `String(...)` coerce it.

## 10. Non-goals

- **Input schema validation** — no JSON-schema / zod validation. `ToolDispatcher` wraps at the catalog level, but at this dispatcher level only type coercion happens (e.g., `Number(input.x)`).
- **Batch within a single tool call** — one tool changes one node (except align). Multi-node changes are expressed as N dispatcher calls.
- **Stride / step alignment** — align_nodes only group-aligns. Even-distribution (distribute horizontally, etc.) is a candidate for a separate tool.
- **Rotated bbox** — align_nodes computes the AABB rather than OBB for rotated members (same limitation as `web-group-ungroup.spec.md §8`).
- **Syncing the `lines` array of textData** — set_text updates only `characters`; the styling segments in `lines` stay. Single-line / single-style assumption. Partial edits of multi-style text are a separate tool.

## 11. Routing

- Chat only — no direct HTTP exposure. `POST /api/chat/:id` → `RunChatTurn` → `ToolDispatcher.dispatch` → `applyTool`.
- Manual user-facing inspector leaf edits enter through separate surfaces (`PATCH /api/doc/:id` → `EditNode`, etc.) — this spec covers only the chat branch.

## 12. Resolved questions

- **set_text's immediate `_componentTexts` refresh vs the absence on Undo** — the forward path (I-T3) mirrors, but Undo's `applyPatches` only reverts the master and leaves the `_componentTexts` cache alone. Intentional difference — Undo handles only leaf level and should not know per-tool post-processing (component-text refresh). If UX becomes a problem, reopening the inspector after Undo refreshes it.
- **set_size's 1px clamp** — values ≤ 0 can cause NaN/Infinity on the render side, so the tool entry forces 1. Callers must confirm the clamped value persisted to disk and use it in the next call.
- **set_fill_color changing only fillPaints[0]** — multi-paint nodes changing the second-and-later fill are rare; punted in v1. If needed, add a `fillIndex` option (separate spec).
