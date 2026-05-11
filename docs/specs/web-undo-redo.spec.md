# spec/web-undo-redo

| Field | Value |
|---|---|
| Status | Approved |
| Implementation | `web/core/application/History.ts` |
| Tests | `web/core/application/History.test.ts`, `web/server/adapters/driven/applyTool.test.ts` (cumulative + interleave blocks), `web/e2e/undo-redo.spec.ts` |
| Dependencies | `EditJournal` port (`web/core/ports/EditJournal.ts`), `applyPatches` helper (exported from History.ts) |

## 1. Goal

Rewind / un-rewind the session's edit history in LIFO order. Every mutation use case (EditNode / ResizeNode / OverrideInstanceText / every chat tool of applyTool) `record`s a single `JournalEntry` on success. `History.execute({ direction: 'undo' })` pops the most recent `past` entry and applies each patch's `before`; `direction: 'redo'` applies the `after` of the most recent `future` entry.

Isolated per session (`sessionId`) — histories of different sessions are not visible to each other. Memory-based (`InMemoryEditJournal`); volatile across server restart (PoC scope; production is separate work).

## 2. Input / Output

```ts
HistoryInput  = { sessionId: string, direction: 'undo' | 'redo' }
HistoryOutput = {
  ok: boolean,
  direction: 'undo' | 'redo',
  appliedLabel: string | null,
  past: number,
  future: number,
}
```

- `direction` echoes the input verbatim — used by callers to branch on the response.
- `ok=false` means the call hit an empty stack — not an error (used to disable the button in the UI).
- `appliedLabel` is `JournalEntry.label` as-is (e.g., `"Edit"`, `"Resize"`, `"AI: duplicate"`). `null` on empty stack.
- `past` / `future` are the stack depths after the call. Returned in the response so the UI can refresh affordances without an extra GET.

## 3. Stack invariants

The `EditJournal` port indexes the two stacks by `direction` — `'undo'` is the past stack (what undo pops from), `'redo'` is the future stack (what redo pops from).

- I-1 `record(entry)` → `past.push(entry)` and clear `future` (the standard behavior of every undo stack — a new branch makes the redo future disappear).
- I-2 After a successful `popStep(sessionId, 'undo')` (= pop from past), the same entry moves to future via `pushStep(sessionId, 'redo', entry)`. Undo→Redo round-trips on the same entry.
- I-3 After a successful `popStep(sessionId, 'redo')` (= pop from future), the same entry moves to past via `pushStep(sessionId, 'undo', entry)`.
- I-4 When `MAX_ENTRIES` (100 in `InMemoryEditJournal`) is exceeded, `record` drops the oldest past entry. `pushStep` is not affected by the cap — it does not introduce a new entry; it merely moves an already-capped entry between the two stacks.
- I-5 `popStep(sessionId, direction)` on an empty stack returns `null` — no mutation occurs and neither message.json nor documentJson is changed.
- I-6 The journal persists even after a session is destroyed (PoC; production may require a cascade). However, `History.execute` against a destroyed session throws `NotFoundError` — before `popStep` is called.

## 4. Patch invariants

Each `PatchPair = {guid, field, before, after}` in `JournalEntry.patches` is one of two kinds:

### 4.1 Leaf patch (set_text / set_position / set_size / fill / cornerRadius / align / instance-override / EditNode / ResizeNode)

- I-L1 `guid` is the actual node GUID (`"sessionID:localID"`). `field` is a dot/bracket path (e.g., `"textData.characters"`, `"transform.m02"`).
- I-L2 `applyPatches` uses `findNode(guid)` to locate the node in `msg.nodeChanges` and applies in-place mutation via `setPath(node, tokens, value)`. Then it mirrors the same mutation by walking `documentJson` for the matching GUID node.
- I-L3 If the node is not found (`findNode` returns undefined), that patch is silently skipped — other patches keep applying (no atomicity guarantee; partial failure inside a single entry is allowed).
- I-L4 An entry with leaf patches only does not trigger a wholesale rebuild of `documentJson`.

### 4.2 Structural patch (duplicate / group / ungroup)

- I-S1 A patch with `guid === MSG_SENTINEL_GUID` (= `"__msg__"`) and `field === "nodeChanges"` is recognized as a sentinel.
- I-S2 The sentinel patch's `before` / `after` are each deep clones of the entire `nodeChanges` array (`clone(msg.nodeChanges)`). Unlike a leaf patch, this is a tree-wide snapshot rather than a single field path.
- I-S3 Sentinel handling: `msg.nodeChanges = pick === 'before' ? patch.before : patch.after`. Skips the `setPath` / `findNode` paths and `continue`s. (`pick` is `direction === 'undo' ? 'before' : 'after'`.)
- I-S4 If the entry contains any sentinel patch, `applyPatches` regenerates the client tree via `s.documentJson = rebuildDocumentFromMessage(JSON.stringify(msg))` after processing all patches.
- I-S5 No entry is emitted that mixes leaf + sentinel (no current mutation use case bundles both into one entry). If introduced in the future, application order would matter and a spec change must come first.

## 5. Round-trip property

- I-R1 After an arbitrary mutation sequence `M1, M2, ..., Mn`, applying `History.execute({ direction: 'undo' })×n` applies each mutation's `before` in LIFO order, and message.json becomes byte-for-byte identical to the baseline (as long as no leaf-skip (I-L3) occurred inside a single mutation entry). This is because `JSON.stringify` at the `after` clone moment is deterministic and per-node key insertion order is preserved.
- I-R2 After the same sequence, `undo×n → redo×n` returns message.json to the state immediately after the sequence.
- I-R3 The ungroup side of group/ungroup uses `between()` to create new position strings, so it is not self-idempotent (`web-group-ungroup.spec.md §5`). Undo guarantees the baseline not by idempotence but by **exact reapplication of the journal-recorded snapshot** — the two properties must not be confused.

## 6. Error cases

- I-E1 `getById(sessionId)` returns null → throws `NotFoundError(\`session \${id} not found\`)`. The journal is not touched.
- I-E2 Empty stack → `ok: false`, `appliedLabel: null`. Does not throw (I-5).
- I-E3 fs write failure during `applyPatches` → propagates the throw to the caller; the journal has already popped, so the sequence breaks. (Current PoC limitation — needs reinforcement after introducing atomic writes. See work item `#3 Atomic write`.)

## 7. Routing

- `POST /api/undo/:id` — no body. The handler calls `History.execute({ sessionId, direction: 'undo' })`. Response: `HistoryOutput`.
- `POST /api/redo/:id` — no body. The handler calls `History.execute({ sessionId, direction: 'redo' })`. Response: `HistoryOutput`.
- The client maps keyboard shortcuts (`Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z`) to these endpoints.

## 8. Non-goals

- **Branching history (tree-style undo)** — only two simple LIFO stacks. Multi-branch is explicitly declined.
- **Persistent journal** — memory only. All history is lost on server restart. Snapshot save/load (`web-snapshot.spec.md`) does not include the journal.
- **Cross-session undo** — mutations of another session cannot be undone (per-session stacks are independent).
- **Undo-of-undo collapse** — even if the same mutation is recorded twice in a row, the entries are not merged (e.g., set_text on the same node twice quickly → two entries). If UX requires debouncing, that is the caller's responsibility.
- **Selective undo** — no operation to undo a specific entry. Always stack top.

## 9. Resolved questions

- **`_componentTexts` refresh on undo of set_text master** — Undo's leaf-patch processing reverts only the master node's `textData.characters`. INSTANCEs' `_componentTexts` cache is not refreshed, so the inspector may show stale master text until reopened after undo. A known limitation — reinforce separately if UX becomes a problem.
- **Possibility of merging structural and leaf patches into one entry** — currently no mutation use case mixes the two. If, in the future, atomic handling of leaf + structural inside a single turn is needed, the patch application order must avoid colliding with documentJson rebuild (currently the leaf walk happens just before rebuild after sentinel processing, so leaf walk results could be lost — see I-S4).
- **`MAX_ENTRIES` policy** — 100 is an arbitrary PoC value. Adjust once user session length tracking is available. On cap exhaustion the oldest is silently dropped with no affordance change in the UI — verify whether that is acceptable separately.
- **Dual class `Undo` / `Redo` → single class `History` (2026-05-06)** — the two use cases differed only by the symmetric pair `popUndo / popRedo` + `pushFuture / pushPast`, sharing the `applyPatches` body. They were merged behind a `direction` parameter, and the EditJournal port was reduced to four methods `popStep / pushStep`. The resulting behavior is identical — only the wire response shape changed to a single `appliedLabel` field + `direction` echo.
