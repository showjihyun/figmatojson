# spec/web-chat-duplicate

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `'duplicate'` case in `web/server/adapters/driven/applyTool.ts` |
| Tests | `web/server/adapters/driven/applyTool.test.ts` (`describe('duplicate')` block + cumulative / mixed undo stress) |
| Dependencies | `__msg__` sentinel patch + `rebuildDocumentFromMessage`, `between()` (fractional-index) |
| Siblings | `web-group-ungroup.spec.md` (same sentinel pattern), `web-chat-leaf-tools.spec.md` (leaf pattern), `web-undo-redo.spec.md` |

## 1. Goal

The AI chat tool `duplicate` clones a single node and its entire subtree, then inserts the copy as the next sibling under the same parent. Like group/ungroup, this modifies tree structure, so it uses the `__msg__` sentinel + full `nodeChanges` snapshot patch pattern.

Uses:
- Everyday requests like "duplicate this card once more."
- The only duplication path while the Inspector lacks user-driven Cmd+D (chat-only).

## 2. Input / Output

```ts
input  = { guid: string, dx?: number, dy?: number }
output = void
label  = 'AI: duplicate'
patches = [{ guid: '__msg__', field: 'nodeChanges', before, after }]
```

- `guid` is the root node to duplicate. All of its descendants (any node reachable via parentIndex.guid) are duplicated together.
- `dx` / `dy` are the root clone's transform offset (default 20px each). Descendant clones' transforms are unchanged — only the root is offset.

## 3. Invariants

### 3.1 Subtree discovery (BFS by parentIndex.guid)

- I-S1 The root + descendants set is collected via BFS over `msg.nodeChanges`'s flat list — repeatedly add nodes whose `parentIndex.guid` references a currently-known node.
- I-S2 0 descendants is fine (single-node duplication). subtree.length === 1.
- I-S3 The master/component referenced by an INSTANCE node's symbolData is not a descendant — its `parentIndex.guid` does not point to a subtree member, so it lies outside the BFS. The duplicated INSTANCE references the same master as the original (only the instance gets a new GUID; the master is shared).

### 3.2 GUID allocation

- I-G1 `nextLocalId = max(localID in msg.nodeChanges) + 1`. Issue `{sessionID: 0, localID: nextLocalId++}` to every node in the subtree. Same rule as group/ungroup.
- I-G2 `guidMap: Map<oldKey, newGuid>` records every mapping — used to rewrite descendant clones' `parentIndex.guid`.
- I-G3 sessionID is fixed at 0 (current user session). Multi-user collaboration is out of scope.

### 3.3 Root clone

- I-R1 Root clone's `parentIndex.guid` = the original's `parentIndex.guid` (insert as sibling under the same parent).
- I-R2 Root clone's `parentIndex.position` = `between(original.position, null)` — a new position string lex-greater than the original. Even if a next sibling exists, the alphabet padding in `between` guarantees original < clone < nextSibling.
- I-R3 Root clone's `transform.m02 = original.m02 + dx`, `transform.m12 = original.m12 + dy`. Rotation channels (m00/m01/m10/m11) unchanged.
- I-R4 If the root has no `parentIndex` (DOCUMENT or other root nodes) → the clone has no `parentIndex` either (current code path). A meaningless invocation; the caller takes responsibility.

### 3.4 Descendant clone

- I-D1 Descendant clone's `parentIndex.guid` = the new parent GUID looked up in `guidMap` — not the original parent (which is another node in the subtree) but its clone.
- I-D2 Descendant clone's `parentIndex.position` = original as-is — sibling lex order inside the cloned parent matches the original.
- I-D3 Descendant clone's `transform`, `size`, `fillPaints`, `textData`, `symbolData`, etc. are deep-cloned from the original verbatim. dx/dy applies only to the root.
- I-D4 An INSTANCE descendant clone's `symbolData.symbolOverrides` is a verbatim copy — `guidPath` references master text GUIDs by absolute path, so parent changes do not affect it (same rationale as `web-group-ungroup.spec.md §10 `guidPath` updates`).

### 3.5 Journal / message / documentJson

- I-J1 Capture `beforeNodeChanges = clone(msg.nodeChanges)` on entry.
- I-J2 After mutation, `msg.nodeChanges = [...original array, ...cloned]` (cloned is in BFS order — root first, then descendants).
- I-J3 `writeFileSync(messagePath, JSON.stringify(msg))` synchronously persists to disk.
- I-J4 `s.documentJson = rebuildDocumentFromMessage(JSON.stringify(msg))` regenerates the client tree. Same as group/ungroup — wholesale rebuild rather than the leaf-tool `mirrorClient`.
- I-J5 `recordChatEdit('duplicate', [{guid: '__msg__', field: 'nodeChanges', before: beforeNodeChanges, after: clone(msg.nodeChanges)}])`. label = `"AI: duplicate"`.

## 4. Round-trip with Undo

- I-U1 Undo's `MSG_SENTINEL_GUID` branch swaps `msg.nodeChanges = before` and rebuilds `documentJson` — every cloned node disappears (`web-undo-redo.spec.md §4.2`).
- I-U2 N consecutive `duplicate` calls followed by N Undos → `nodeChanges` is byte-for-byte identical to the baseline (tested by `applyTool.test.ts` cumulative undo block).
- I-U3 Mixed sequences of duplicate and leaf tools followed by Undo restore the baseline (tested in the same file's mixed leaf+structural interleave block).

## 5. Error cases

- I-E1 Root node missing → `Error("node <guid> not found")`. No disk write occurs before the throw.
- I-E2 `findNode` only validates the root — a descendant cannot disappear mid-BFS (no races within one invocation).
- I-E3 If `dx` / `dy` is NaN / non-numeric, `Number(...)` coercion may write NaN into the transform — caller's responsibility (current limitation).
- I-E4 `nodeChanges` so large that `JSON.stringify` hits memory limits is out of scope (current PoC validated up to 35K nodes).

## 6. Out of scope

- **Deep duplicate of an INSTANCE master** — only the INSTANCE is duplicated; the master/component it references is not. Duplicating the master too requires a separate tool (master-detach, etc.).
- **Link-preserving duplicate** — no automatic variable/style synchronization between cloned INSTANCEs.
- **Smart positioning** — dx/dy is a plain offset. Auto-search for empty canvas space belongs in a separate tool (something like `mcp__pencil__find_empty_space_on_canvas`; not in this codebase).
- **Multi-source duplicate** — one root per call. To duplicate multiple nodes at once, the dispatcher issues N calls.

## 7. Routing coupling

Chat-only. When user-driven Cmd+D is added to the Inspector:
- Expose `POST /api/duplicate/:sid` body `{guid, dx?, dy?}`.
- It calls the same use case (the duplicate branch of `applyTool`).

## 8. Resolved questions

- **Whether the 20px default offset is appropriate** — Figma's native Cmd+D also duplicates with ~20px offset — same UX adopted. If the caller passes 0, the clone overlaps the original exactly (current intended behavior).
- **Preserving vs regenerating descendant `parentIndex.position`** — preserved as-is (I-D2). Only the lex order inside the new parent matters, so there is no collision. No need to ladder via `between` as in ungroup.
- **Binary asset references such as `fillPaints` `imageRef`** — handled by `clone(...)` = `JSON.parse(JSON.stringify(...))` — Uint8Array round-trips through the `__bytes` reviver tag (see `messageJson.ts:25`). Plain hash references are copied as strings as-is.
