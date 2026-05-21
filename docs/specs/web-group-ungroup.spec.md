# spec/web-group-ungroup

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `'group'` / `'ungroup'` cases in `web/server/adapters/driven/applyTool.ts` |
| Tests | `web/server/adapters/driven/applyTool.test.ts` |
| Dependencies | `__msg__` sentinel patch + `rebuildDocumentFromMessage` (already validated through `duplicate`) |

## 1. Goal

Allow the AI chat (`Apply edits via the figma_editor tools.`) tools to create and dissolve GROUP nodes. User-initiated group/ungroup actions delegate to the same use case to unify the code path.

Unlike existing leaf-only chat tools, this operation modifies tree structure — it is built on top of the `__msg__` sentinel + full `nodeChanges` snapshot patch pattern introduced by `duplicate`.

## 2. Input / Output

```ts
group   = { name: 'group',   input: { guids: string[], parentGuid?: string, name?: string } }
ungroup = { name: 'ungroup', input: { guid: string } }
```

- `group`: wraps 2 or more sibling nodes into a new GROUP.
- `ungroup`: lifts the contents of exactly one GROUP into the parent and removes the GROUP itself.
- Like other chat tools, the return is void — `applyTool` wraps the result outside the try/catch and ToolDispatcher returns `{ok}`.

## 3. Group invariants

- I-G1 All `guids` must share the same parent. Different parents → `Error("group: guids must share a parent")`.
- I-G2 The new GROUP `guid` = max localID in `nodeChanges` + 1 (sessionID 0). Same rule as `duplicate`.
- I-G3 The new GROUP `parentIndex.guid` = the members' common parent. `parentIndex.position` = the position of the lex-first member, unchanged — that member moves into the GROUP so its slot in the parent becomes free, and the GROUP naturally takes that position (no collision).
- I-G4 New GROUP `transform.m02 = min(member.transform.m02)`, `transform.m12 = min(member.transform.m12)` — the top-left of the member bbox.
- I-G5 New GROUP `size` = bbox of members (`{x: maxX - minX, y: maxY - minY}`).
- I-G6 For each member node:
  - `parentIndex.guid` ← new GROUP's guid
  - `parentIndex.position` ← retained as-is (relative ordering among members is preserved — lex order is the same inside the new parent)
  - `transform.m02 -= GROUP.transform.m02` (convert to parent-local coordinates)
  - `transform.m12 -= GROUP.transform.m12`
- I-G7 Member `size`, rotation channels (`transform.m00/m01/m10/m11`), fillPaints, children, etc. are unchanged.
- I-G8 Member children are unchanged — children's `parentIndex.guid` still points to the member (indirect descendants are unaffected by the group operation).
- I-G9 `journal.record` writes one entry `{guid: '__msg__', field: 'nodeChanges', before, after}`. label = `AI: group`.

## 4. Ungroup invariants

- I-U1 Target node must satisfy `type === 'GROUP'`. Otherwise → `Error("ungroup: target is not a GROUP")`.
- I-U2 For each of the GROUP's N direct children (in lex order inside the GROUP):
  - `parentIndex.guid` ← GROUP's `parentIndex.guid` (the grandparent)
  - `parentIndex.position` ← cumulative `between(prev, nextSiblingPos)` — `prev` is `GROUP.position` for the first child, and the previously-assigned position for subsequent children. This inserts N children ladder-style into the (GROUP.pos, nextSiblingPos) interval. Relative lex ordering among children is preserved.
  - `transform.m02 += GROUP.transform.m02` (convert back to grandparent-local coordinates)
  - `transform.m12 += GROUP.transform.m12`
- I-U3 The GROUP node itself is removed from `nodeChanges`.
- I-U4 Indirect descendants (children of children, etc.) are unchanged (they keep their member-local coordinates).
- I-U5 If the GROUP is empty (0 children) → just remove the GROUP. No new child is appended to the grandparent.
- I-U6 `journal.record` label = `AI: ungroup`.

## 5. Round-trip property

After `group([a, b]) → ungroup(g)`, `nodeChanges` must be such that a, b's transform/size/parentIndex match their state just before the group call (modulo floating-point noise).
- However `parentIndex.position` may differ — ungroup's N-way subdivision produces fresh position strings. Sibling lex ordering is preserved.
- In other words: not "wire-level identical" but "semantically identical" — visuals/structure are identical.

## 6. Error cases

- Missing session → handled by existing `applyTool` — `findNode` throws.
- `group`'s `guids.length < 2` → `Error("group needs >= 2 guids")`.
- `group` members with different parents → I-G1.
- `ungroup` target that is not a GROUP → I-U1.
- Both group and ungroup: disk / journal are guaranteed unchanged (throw outside try, validate before write).

## 7. Undo model

Same pattern as `duplicate` — the `MSG_SENTINEL_GUID` branch in `Undo.applyPatches` handles it as-is. No additional code.

`group`'s inverse is `before === pre-group nodeChanges`, `after === post-group nodeChanges`. Undo → restore before → regenerate documentJson via `rebuildDocumentFromMessage`. Same mechanism.

## 8. Out of scope

- **Multi-parent group**: combining nodes that live under different parents into one group. Lifting members to a common ancestor would require inferring parent container semantics (`FRAME` vs `INSTANCE`, etc.), which is hard. v1 supports same-parent only.
- **Rotated members**: if a member has non-zero m00/m01/m10/m11, the bbox computation is not exact (we need the OBB of the rotated rectangle, not the AABB). v1: rotated members can be grouped, but the GROUP's size is computed as an AABB rather than an OBB, which may visually drift slightly. Rotated-node grouping is a candidate for a separate spec.
- **GROUP inside GROUP**: nesting is permitted (no restriction). However ungroup operates on only one level — recursive ungroup is achieved by repeated calls.
- **Vector boolean group** (`BOOLEAN_OPERATION` type): separate tool. v1 creates only `type: 'GROUP'`.

## 9. Routing coupling

Chat-only — no direct HTTP exposure. If a user-driven group/ungroup UI is added later:
- `POST /api/group/:sid` — body `{guids, name?}`
- `POST /api/ungroup/:sid` — body `{guid}`
Both call the same use case (`applyTool`).

## 10. Resolved questions

- **Auto-generated `name`**: if the user does not supply `name`, simply use `"Group"`. A counter (`"Group 1/2/..."`) comes later. The Figma UI itself starts with the constant "Group" and users rename immediately, so reproduction fidelity is unaffected.
- **GROUP `fillPaints`**: leave as empty array `[]`. In the kiwi schema fillPaints is always serialized as an array and an empty array is normal — omitting it causes some codepaths to fall through via `Array.isArray()` checks.
- **`guidPath` updates**: not modified. `symbolData.symbolOverrides[].guidPath` references node guids directly without traversing parentage (the kiwi schema's `GUIDPath` = `{guids: GUID[]}` is a one-level absolute path). Therefore parentIndex changes from group/ungroup do not affect override target identification. Regressions, if any, are caught by e2e.
