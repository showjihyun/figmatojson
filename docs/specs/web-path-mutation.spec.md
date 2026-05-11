# spec/web-path-mutation

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/core/domain/path.ts` (`tokenizePath`, `setPath`, `getPath`) |
| Tests | `web/core/domain/path.test.ts` (currently absent — unit tests recommended after this spec lands) |
| Siblings | `web-edit-node.spec.md` (PATCH endpoint consumer), `web-chat-leaf-tools.spec.md` (AI tool dispatcher consumer), `web-undo-redo.spec.md` (EditJournal pre-state capture) |

## 1. Goal

Make *deeply-nested fields* inside the Document tree addressable via a single
wire-format string. The same syntax has to be used by three different
consumers without breaking mutual compatibility:

- **PATCH endpoint** (`POST /api/doc/:id/edit`): mutates a single leaf in the
  tree using the path string sent by the client.
- **Inspector** (debounced input patcher): when a user types into a hex input
  box, paths like `fillPaints[0].color.r` are sent through PATCH.
- **AI tool dispatcher** (`InProcessTools` / `applyTool`): a path appears in
  the arguments of a tool call emitted by the LLM.

This spec is the single source for *syntax, tokenization rules, walk policy,
and mutation semantics*. Any change affects all three consumers.

## 2. Path syntax

```
path := segment ( "." segment | "[" index "]" )*
segment := /[^.\[\]]+/      // any string not containing dot or bracket
index := /[0-9]+/           // integers only, no sign
```

- I-S1 `segment` permits any character other than dot/bracket (Korean,
  whitespace, special characters included). UI input is restricted to
  identifiers, but the wire itself is flexible.
- I-S2 `index` is an *integer* — floats / negatives / hex are not allowed.
  Enforced by the `\d+` regex.
- I-S3 segment/index *order is arbitrary* — combinations such as
  `a.b[0].c[1].d` are free.
- I-S4 Empty path (empty string) → empty token array → `setPath` / `getPath`
  refer to the root (mutation is effectively a no-op since there is no leaf;
  getPath returns root). Syntactically legal.

## 3. `tokenizePath(path)` — string → Token[]

```ts
type PathToken = string | number;
function tokenizePath(path: string): PathToken[];
```

- I-T1 Single sweep over the regex `/([^.\[\]]+)|\[(\d+)\]/g` — matches either
  a segment or a bracketed index.
- I-T2 A segment match yields a `string` token; a bracketed-index match yields
  a `number` token via `parseInt(.., 10)`. The type discriminates segment vs
  index by `typeof` for the caller.
- I-T3 *Unmatched fragments are ignored.* `"a..b"` (consecutive dot), `"a.[0]"`
  (bracket immediately after dot), `"["` (incomplete bracket) all emit only
  the partially-matched tokens and never throw.
- I-T4 Determinism: same input → same token array. The result length may be 0
  (everything unmatched). It is the caller's responsibility to decide whether
  an empty array means *root* or *invalid*.
- I-T5 No IO / no framework dependencies. Pure function.

## 4. `setPath(obj, tokens, value)` — leaf write

```ts
function setPath(
  obj: Record<string, unknown> | unknown[],
  tokens: PathToken[],
  value: unknown,
): boolean;
```

- I-W1 `tokens.length === 0` → no-op, returns `true`. (Path refers to root, so
  no leaf exists — passes through without intended change.)
- I-W2 Walk rule: for index `i ∈ [0, tokens.length - 1)`:
  1. If `cur[tokens[i]]` is `null` or `undefined`, *auto-create the
     intermediate*: `[]` if the next token is a `number`, `{}` if `string`.
  2. Descend with `cur = cur[tokens[i]]`.
  3. **No type validation** — if `cur` is an array but the next token is a
     string, or scalar but the next token is an array index, we defer to JS
     native behavior (which typically adds the property silently or yields
     NaN). This function is not the place to validate the path's wire format.
- I-W3 Leaf write: `cur[tokens[last]] = value`. The value type is not
  validated.
- I-W4 Mutation is *in-place* — the input `obj` is changed. If callers need
  immutability, they should deep-copy beforehand.
- I-W5 Return value is always `true`. The boolean signature exists for legacy
  compatibility and preserves the option of returning `false` once validation
  is added.
- I-W6 New-field case: `setPath({}, ['a', 'b', 'c'], 1)` → `{ a: { b: { c: 1 } } }`.
  PATCH on a *field that appears for the first time* silently succeeds.

## 5. `getPath(obj, tokens)` — leaf read

```ts
function getPath(obj: unknown, tokens: PathToken[]): unknown;
```

- I-R1 Walk: for each token `cur = cur[tok]`; if `cur` is `null/undefined` or
  non-object, immediately return `undefined`.
- I-R2 Missing intermediate → `undefined`. The caller interprets that as
  *"field absent"*.
- I-R3 EditJournal's pre-mutation snapshot uses `getPath(obj, tokens)` — in
  the new-field case, recording `undefined` as the pre-state is correct (it
  means the field must be *removed* on undo).
- I-R4 Unlike setPath, no intermediates are auto-created — reads must not have
  the side effects of writes.

## 6. Wire-format compatibility — shared contract across 3 consumers

| Consumer | Input form | Responsibility |
|---|---|---|
| **PATCH `/api/doc/:id/edit`** | request body `{ id, path, value }` | server calls `tokenizePath(path)` → `setPath(node, tokens, value)` |
| **Inspector debounced patcher** | `<input>`'s onChange → path argument to service function | client builds path string, sends PATCH |
| **AI tool dispatcher** | LLM-emitted tool call `args.path` | dispatcher runs `tokenizePath` without sanitization and then applies |

- I-C1 All three consumers use the *same path string* on the wire. The path
  built by the client and the path received by the server must be 1:1
  identical.
- I-C2 Client-side path builders follow this spec's syntax — dot-joined
  segments, bracketed array indices. Alternate notations (slash separator /
  JSON Pointer / dot-only) are incompatible.
- I-C3 If the LLM emits malformed syntax the dispatcher *does not throw* —
  `tokenizePath` emits only partial results and `setPath` silently assigns
  into an empty / wrong leaf. LLM self-recovery uses *post-result inspection*
  (re-reading via GET to verify the path took effect).

## 7. Mutation safety

- I-M1 These helpers are *not a security boundary*. The path that the PATCH
  endpoint receives is client input the server trusts — once exposed as a
  public API, prototype pollution (`__proto__`, `constructor.prototype`)
  validation is required. Currently assumed internal-only.
- I-M2 Mutation pointing under an INSTANCE's `_renderChildren` is lost on the
  next reload — `_renderChildren` is a *derived* field recomputed from master
  + overrides. To persist, mutation tools must change either the master or
  the overrides themselves (see `web-instance-pipeline.spec.md §1`).
- I-M3 Field *type drift* is possible: `setPath` writing a `number` where the
  original was a `string` puts it in as-is. Callers must use this with full
  awareness of wire-format semantics — there is no type schema bound to the
  wire itself.

## 8. Out of scope

- ❌ **JSON Pointer (RFC 6901) compatibility** — no `~0`/`~1` escape rules.
  This spec's syntax is the dot/bracket-based *legacy* form.
- ❌ **Negative indices or `[-1]`-style last-element shortcuts.** Indices are
  `\d+` only.
- ❌ **Wildcard / glob paths** (`fillPaints[*].color`). Single-leaf mutation
  only.
- ❌ **Multi-mutation atomicity.** One leaf per `setPath` call. To change
  multiple leaves atomically the caller must lock beforehand and commit after
  a batch (the current single-threaded JS implementation has no races, but it
  also has no rollback on partial failure).
- ❌ **Path schema validation** — invalid paths are silent — callers use this
  with full knowledge. Attaching a schema to the wire belongs in a separate
  layer.
- ❌ **Prototype pollution defense** — see §I-M1.

## 9. Resolved questions

- **Why distinguish segment and index as separate token types?** When
  `setPath` auto-creates intermediates, the *next token type* decides whether
  to make `[]` vs `{}` (I-W2). Unifying as strings would mistake a `"0"`
  index for an object key.
- **Why doesn't `tokenizePath` throw on partial input?** A path *while
  typing* — like the Inspector hex input — may briefly be invalid; it is
  ergonomic for the debounced patcher to send PATCHes during that window and
  silently absorb them.
- **Why does `getPath` have a different signature from setPath?** `getPath`
  accepts arbitrary `unknown` — DocumentNode descendants are typed as
  `unknown`, and we walk without checking types at every level. `setPath` has
  the stronger contract that *the root is always an object/array* — callers
  begin mutation from the root.
- **Why keep the boolean return?** It is a slot for emitting a `false` reject
  signal once validation lands (path schema enforcement, protected-key
  blocklist). Currently always `true`. Legacy compatibility.
