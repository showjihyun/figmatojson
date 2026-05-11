# spec/web-message-json-reviver

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/core/domain/messageJson.ts` (`rebuildDocumentFromMessage`) |
| Tests | (TODO) `web/core/domain/messageJson.test.ts` — units for this spec's reviver rules |
| Siblings | `json-repack-codec.spec.md` (CLI-side encode/decode tag system), `web-instance-pipeline.spec.md` (`toClientNode` consumer), `web-chat-duplicate.spec.md` / `web-group-ungroup.spec.md` (structural tools — consumers of this reviver) |

## 1. Goal

The web pipeline's *structural mutation tools* (`duplicate`, `group`,
`ungroup`) reshuffle parent-child relationships *globally* — `parentIndex.guid +
position` changes across many nodes, so `documentJson` cannot be kept in sync
via *partial mutation*. This spec's helper defines the *full-recompute*
pipeline for that case:

```
messageJsonRaw (string)
  ↓ JSON.parse + reviver (restore Uint8Array)
  ↓ buildTree (rebuild parent-child links)
  ↓ buildSymbolIndex (master GUID index)
  ↓ toClientNode (INSTANCE expansion + override application)
  ↓ Document
```

Leaf chat tools (`set_text`, `set_position`, etc.) are served by *partial
mutation* — this helper is not used. The split is sourced in
`web-chat-leaf-tools.spec.md` and `web-chat-duplicate.spec.md`.

## 2. Entry point

```ts
function rebuildDocumentFromMessage(messageJsonRaw: string): Document;
```

- I-E1 Input: `messageJsonRaw` = the string output of `JSON.stringify`.
  Structural tools mutate and then `JSON.stringify` the new message tree to
  carry it; this helper performs the reverse.
- I-E2 Output: the `DocumentNode` tree (root = `DOCUMENT` type). The caller
  directly assigns it to `session.documentJson` — no extra validation.
- I-E3 *Server-side only*. `Buffer.from(..., 'base64')` works only under Node
  — calling from the browser raises ReferenceError.

## 3. Reviver — restore the `__bytes` tag

JSON.parse's reviver unwinds a special encoding to recover `Uint8Array`.

- I-R1 Match rule: `v` is a truthy object (non-array) AND `v.__bytes` is a
  string. Must also pass `Array.isArray` check (arrays pass through).
- I-R2 On match, convert via `Uint8Array.from(Buffer.from(v.__bytes, 'base64'))`.
  Not a view over `Buffer.from(..., 'base64')`'s backing buffer but a *copy* —
  `Uint8Array.from` allocates a new buffer.
- I-R3 Every value that does not match (regular object/array/scalar) passes
  through unchanged.
- I-R4 *Sole tag = `__bytes`*. Other tags from the CLI codec (`__bigint`,
  `__num`) *do not appear in the web pipeline's message tree* — so they are
  not implemented in this reviver. Add them if they appear (see
  json-repack-codec.spec.md §3.4).

## 4. Processing steps

### 4.1 JSON.parse + reviver

- I-P1 `JSON.parse(messageJsonRaw, (_, v) => reviver(v))` — the second
  argument of the standard reviver signature.
- I-P2 Throw policy: malformed JSON raises `JSON.parse`'s native error — this
  helper does not catch. The caller (HTTP route) maps it to 400 / 500 in
  its error handler.
- I-P3 The reviver itself does not throw. Invalid base64 strings produce a
  partial decode via `Buffer.from(invalid, 'base64')` — silent.

### 4.2 buildTree

- I-P4 Calls `buildTree(messageObj)` — same function as on the CLI side
  (`src/tree.ts`). Kiwi Records → linked Tree Nodes (CONTEXT.md `Tree Node`
  entry).
- I-P5 If the resulting `tree.document` is `null`, throw
  `Error('messageJson has no DOCUMENT root')`. All other tree-shape defects
  are silent — delegated to buildTree's own robustness.

### 4.3 Symbol index and toClientNode

- I-P6 `blobs = (messageObj as ...).blobs ?? []` — fallback to empty array
  when absent. The tree conversion proceeds even without vector / image
  blobs (vector nodes fall back to no-`_path`, same policy as
  `vector-decode.spec.md §I-E1`).
- I-P7 `buildSymbolIndex(tree.allNodes.values())` builds the master index.
  Same shape as the INSTANCE expansion entry point in
  `web-instance-pipeline.spec.md §1`.
- I-P8 Call `toClientNode(tree.document, blobs, symbolIndex)` — this function
  owns INSTANCE expansion + override application + reflow application
  (pipeline.spec §2 source).

## 5. Relationship to the CLI codec

- I-C1 *Encode-side compatibility*: this reviver's format is identical to
  the `{__bytes: <base64>}` tag emitted by the CLI's
  `intermediate.ts:roundTripReplacer`. A file the CLI dumped to
  `04_decoded/message.json` can be read back by the web reviver unchanged
  (we do not actually use this, but the contract is compatible).
- I-C2 *Tags out of scope*: the CLI's `__bigint` / `__num` tags are not
  implemented here. The web pipeline's message tree *currently* has no
  bigint / non-finite numbers — when they appear, update this spec.
- I-C3 *Directional difference*: the CLI codec is *encode + decode* in both
  directions (`json-repack-codec.spec.md`'s `encodeMessage` / `decodeMessage`).
  This helper is *decode only* — the web side emits its message tree
  through plain `JSON.stringify` (no special replacer) and only the reviver
  special-cases.

## 6. Call sites

Exact times this helper is invoked:

| Use case | Call trigger | Source spec |
|---|---|---|
| `Duplicate` | recompute `session.documentJson` after duplicate | web-chat-duplicate.spec.md |
| `Group` | re-parent-child after new GROUP added | web-group-ungroup.spec.md |
| `Ungroup` | re-parent children after GROUP dissolved | web-group-ungroup.spec.md |
| `Undo` / `Redo` | after structural diff replay | web-undo-redo.spec.md §4.2 |
| `LoadSnapshot` | reconstruct a session from the snapshot's messageJson | web-snapshot.spec.md |
| `UploadFig` | (indirect) — same pipeline used after kiwi → message tree processing | web-upload-fig.spec.md |

- I-U1 Every use case above is *server-side* — consistent with this helper
  being server-only (§I-E3).
- I-U2 Callers are not responsible for verifying *deep equality* of the
  resulting `Document` — they rely on the determinism of buildTree +
  toClientNode (same input → same output).

## 7. Error policy

- I-X1 Malformed JSON → propagate `JSON.parse`'s native error as-is.
- I-X2 `tree.document` null → explicit `Error('messageJson has no DOCUMENT root')`.
  The caller catches and maps to 410 / 422 or other appropriate HTTP status.
- I-X3 Invalid base64 string → silent partial decode. Even with wire-format
  damage, the tree itself survives (only vector blobs are broken).
- I-X4 Unexpected errors during build / toClientNode → propagate. Caller
  maps to 500.

## 8. Out of scope

- ❌ **Integration with the CLI codec** — merging the two helpers into one
  file is out of scope. Environment difference (Node Buffer vs
  browser-safe atob) + tag-range difference (`__bytes` only vs 3 tags)
  justifies the separation.
- ❌ **Streaming parse** — the entire messageJson is loaded at once. The
  meta-rich 6.05 MB / message tree is ~150 MB after JSON.stringify, but
  server memory assumption is within NF-02 (input file size × 5).
- ❌ **Diff-only update** — this helper is a *full recompute*. Incremental
  updates applying only the structural-mutation partial diff are not
  supported (full recompute is the simple path to deterministic correctness).
- ❌ **Tag auto-extension** — `__bigint` / `__num` not implemented. When
  they appear, update this spec explicitly.

## 9. Resolved questions

- **Why `Uint8Array.from(Buffer.from(...))` instead of `new Uint8Array(buffer)`
  directly?** `Buffer` is a subclass of `Uint8Array`, but *typeof* and some
  consumers treat the two differently. Going through `Uint8Array.from`
  produces a *plain* Uint8Array copy so downstream type narrowing /
  instanceof checks remain safe.
- **Why can't we sync documentJson via *partial* mutation after structural
  changes?** `parentIndex.guid + position` affects *the sibling ordering of
  other nodes*. Putting one node into a group can re-assign neighboring
  siblings' fractional-indices, and those changes cannot be expressed as a
  single mutation. Full recompute wins on both *simplicity* and
  *determinism*.
- **Are leaf tools *always* fine with partial mutation?** `set_text` /
  `set_fill_color` change just one field on one node — no tree-structure
  change → partial mutation suffices. But if `set_position` touched an
  INSTANCE master, it would ripple to every use site — that case is handled
  separately in `web-chat-leaf-tools.spec.md`.
