# spec/web-edit-node

| Item | Value |
|---|---|
| Status | Approved (Phase 7) |
| Implementation | `web/core/application/EditNode.ts` |
| Tests | `web/core/application/EditNode.test.ts` |
| Parent | [docs/SPEC-architecture.md](../SPEC-architecture.md) |

## 1. Purpose

PATCH an arbitrary field on a single node within a session. The edit is written immediately to `extracted/04_decoded/message.json` (the repack source-of-truth) and is also applied to the in-memory documentJson so that the next `GET /api/doc/:id` sees the change without the client having to re-fetch.

## 2. Input / Output

```ts
input  = { sessionId: string, nodeGuid: string, field: string, value: unknown }
output = { ok: true }
```

`field` is a dot/bracket path (`textData.characters`, `fillPaints[0].color.r`).

## 3. Invariants

- I-1 After PATCH, re-decoding `extracted/04_decoded/message.json` shows the new `value` at the `field` location
- I-2 If the same GUID node is located in the `session.documentJson` tree, the same `value` is present at the same `field` location
- I-3 If `field === 'textData.characters'` and `value` is a string, then for every INSTANCE in the tree, the `_componentTexts[]` entry whose `guid === nodeGuid` has its `characters` updated to the new value (the inspector's component-text panel refreshes without a reload)
- I-4 No other node or field in message.json is changed (single-node single-field change)
- I-5 If `field === 'textData.characters'` and `value` is a string, **Figma's precomputed layout cache must be invalidated** — otherwise Figma will prefer the stale cache on import and *load with the change unapplied*. Specifically:
  - Remove all of the edited node's own `textData.{glyphs, baselines, derivedLines, fontMetaData, layoutSize, minContentHeight, truncatedHeight, truncationStartIndex, logicalIndexToCharacterOffsetMap, decorations, blockquotes, hyperlinkBoxes, mentionBoxes, fallbackFonts}` (`web/core/domain/textInvalidation.ts:invalidateTextLayoutCache`)
  - Remove the same node's direct `derivedTextData` field
  - Sync the length of `textData.characterStyleIDs` to the new `characters.length` (truncate if shorter, pad with the last style index if longer — prevents run mismatches in kiwi encoding)
  - In every INSTANCE node, remove entries from `derivedSymbolData[]` where `guidPath.guids[last] === nodeGuid` (`pruneInstanceDerivedTextData`) — forces Figma to recompute the per-instance bake on import

## 4. Error cases

- Session not found → `NotFoundError(\`session \${id} not found\`)`
- Node not found → `NotFoundError(\`node \${guid} not found\`)`
- `field` is an empty string → `ValidationError('empty field path')`

## 5. Out of scope

- Transactions / rollback (single mutation)
- Multi-field batch (caller invokes N times)
- Type validation (the server keeps `value` as-is — caller's responsibility)

## 6. Routing coupling

`PATCH /api/doc/:id`. body = `{nodeGuid, field, value}`.
