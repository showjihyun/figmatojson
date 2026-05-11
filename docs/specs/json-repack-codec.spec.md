# spec/json-repack-codec

| Item | Value |
|---|---|
| Status | Draft — awaiting trigger (no active bug, excluded from round-13 scope) |
| Trigger | Run this as the *first step* of any PR that needs to add a new round-trip tag. Until then, ADR-2 + the `repack json mode` gate in `test/e2e.test.ts` is sufficient. |
| Implementation | `src/jsonRepackCodec.ts` (new) |
| Tests | `src/jsonRepackCodec.test.ts` (new — encode/decode round-trip unit tests), the `repack json mode` block in `test/e2e.test.ts` (existing — regression guard) |
| Siblings | `docs/adr/0002-roundtrip-equality-tiers.md` (lossy mode forbidden) |

## 1. Goal

The contract stated in ADR-0002 — "the encode (`roundTripReplacer` in `src/intermediate.ts`) and decode (`reviveBinary` in `src/repack.ts`) halves of JSON Repack must move *together*" — is currently a *documentation convention*, not a *structural guarantee*. The two functions are split across two files, so:

- Adding a new round-trip tag (e.g. `__date` for ISO timestamps) requires synchronizing both files. Modifying only one side compiles without error. The failure mode is *silent data loss* — the outcome ADR-0002 explicitly forbids.
- The codec's *overall behavior* is already wide (both encode and decode own a full `JSON.stringify`/`JSON.parse`) — `intermediate.ts:347` and `repack.ts:277`. **What is missing is a single module owner.**

This spec consolidates both functions into one file, structuring the contract. Behavior change: 0. Location change only.

## 2. Interface

```ts
// src/jsonRepackCodec.ts
export function encodeMessage(data: unknown, opts?: { minify?: boolean }): string;
export function decodeMessage(text: string): unknown;

// Expose raw forms for unit testing / debugging
export const TAGS = { bytes: '__bytes', num: '__num', bigint: '__bigint' } as const;
```

A caller only needs to know about `encodeMessage` / `decodeMessage` and the `TAGS` constant. JSON itself (replacer / reviver, `JSON.stringify` / `JSON.parse`) is codec-internal.

## 3. Invariants

- I-1 `encodeMessage(decodeMessage(x))` and `decodeMessage(encodeMessage(x))` are lossless — every round-trippable type (Uint8Array, bigint, NaN/±Infinity) is preserved.
- I-2 The string values of `TAGS` (`"__bytes"`, `"__num"`, `"__bigint"`) are a frozen const not changeable from outside. Changing a label is **breaking** — previous message.json files no longer decode.
- I-3 Adding a new tag = one entry added to `TAGS` + one case added to `encodeMessage`'s replacer + one case added to `decodeMessage`'s reviver. All three within a single file. Missing any of the three is caught immediately by unit tests (`jsonRepackCodec.test.ts`).
- I-4 Indentation policy: indent = 0 when `opts.minify === true`, else 2 spaces (preserves current behavior). I-1's round-trip preservation is independent of minify.
- I-5 Reviver passthrough behavior for ordinary object/array/scalar — objects *without* `__bytes` and other magic keys pass through unchanged. Preserves the fallback behavior of the existing `reviveBinary`.

## 4. Caller changes

### 4.1 `src/intermediate.ts`

- The current `roundTripReplacer` function (line 353+) and `writeJsonRoundTrip` (line 341-351) — both delegate to the codec.
- After:
  ```ts
  import { encodeMessage } from './jsonRepackCodec.js';
  function writeJsonRoundTrip(path, data, minify) {
    const text = encodeMessage(data, { minify });
    writeFileSync(path, new TextEncoder().encode(text));
    return { path, bytes: text.length };
  }
  ```
- The `roundTripReplacer` function itself is deleted — absorbed into the codec.

### 4.2 `src/repack.ts`

- The current `reviveBinary` (line 312+) and `JSON.parse(text, (_k, v) => reviveBinary(v))` (line 277) — both delegate to the codec.
- After:
  ```ts
  import { decodeMessage } from './jsonRepackCodec.js';
  const message = decodeMessage(messageJsonText) as Record<string, unknown>;
  ```
- The `reviveBinary` function itself is deleted — absorbed into the codec.

## 5. Tests

### 5.1 New location

`src/jsonRepackCodec.test.ts` (vitest, new file):

- Round-trip Uint8Array (binary blob)
- Round-trip bigint (kiwi version field, etc.)
- Round-trip NaN / Infinity / -Infinity
- Ordinary object/array/scalar passthrough (signature regression)
- minify on/off result comparison + both decode identically
- Unknown tag (`__foo`) treated as an ordinary object

### 5.2 Regression guards

- The `repack json mode` test in `test/e2e.test.ts` — must pass unchanged. External behavior is identical.

## 6. Migration order

1. Create `src/jsonRepackCodec.ts` — implement encode/decode/TAGS + write unit tests.
2. Switch callers in `src/intermediate.ts`, delete `roundTripReplacer`. Confirm `npm test` passes.
3. Switch callers in `src/repack.ts`, delete `reviveBinary`. Confirm `npm test` passes.

All three steps fit in one PR (~30 lines moved + unit tests added). Risk is minimal — the `repack json mode` e2e test catches any regression immediately.

## 7. Relationship to ADR-0002

This spec **does not invalidate** ADR-0002's invariant — it enforces it. ADR-0002 declares the *convention* "both halves must move together", and this spec converts that convention into a *structural* property within a single module so that **both halves cannot help but move together**. ADR-0002 remains valid; this codec module is its enforcement mechanism.

## 8. Out of scope

- **Wire format change (JSON → MessagePack, etc.)** — this spec is JSON-only. A different wire format requires a separate spec.
- **Type-safe API for encode/decode** — both input and output are `unknown`. Type-safe IO is the caller's responsibility. (Same as current.)
- **Streaming encode/decode** — the whole message is processed at once. If memory pressure appears on large files, that is separate.
- **Introducing the lossy mode ADR-0002 forbids** — permanently out of scope.
