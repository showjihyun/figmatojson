# spec/rest-api-normalize

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `src/normalize.ts` (`normalizeTree`, `normalizeNode`, `computeBoundingBox`, `serializableRaw`) |
| Tests | `test/normalize.test.ts` (within available scope) — units for alias / bbox / Uint8Array conversion in this spec |
| Siblings | `SPEC.md §Stage 8` (output pipeline source), `PRD.md §10 decision b` ("pragmatic" policy decision) |

## 1. Goal

CLI Stage 8 output (`output/document.json` and `output/pages/*.json`) must
be *partially compatible with the Figma REST API response* (PRD G4). But
there are areas where the Kiwi wire format does *not* match REST exactly —
field naming (fillPaints vs fills), coordinate computation (transform matrix
vs absoluteBoundingBox), serialization safety (Uint8Array, BigInt). This
spec is the single source on *where to alias and where to preserve the
original*.

Policy: PRD §10 decision (b) **"pragmatic"** — *preserve* the Kiwi original
key as-is + *add* the REST alias. Both forms remain greppable. Option (a)
"full REST compatibility" has high conversion cost and some data
(`derivedSymbolData`) has no REST mapping.

## 2. Output node shape

```ts
interface NormalizedNode {
  id:                     string;     // "sessionID:localID" — REST naming
  guid:                   GUID;       // preserves the original {sessionID, localID}
  type:                   string;
  name?:                  string;
  visible?:               boolean;
  parentId?:              string;     // parent's id (REST naming)
  fills?:                 unknown;    // fillPaints alias
  strokes?:               unknown;    // strokePaints alias
  effects?:               unknown;    // as-is
  absoluteBoundingBox?:   { x, y, width, height };
  children?:              NormalizedNode[];
  raw:                    Record<string, unknown>;  // Kiwi original (serialization-safe)
}
```

- I-N1 `id` and `guid` are *emitted simultaneously*. REST consumers use
  `id`, kiwi-aware code uses `guid` — both are greppable from a single node
  (the heart of the pragmatic policy).
- I-N2 The `raw` field carries *every original Kiwi field* (after
  serialization-safe conversion). Original keys (`fillPaints`, etc.) live
  on inside raw even when aliases are added on top.
- I-N3 Aliases are *aliases* (references), not deep clones — `out.fills =
  out.raw.fillPaints` points to the same array. Mutating one mutates the
  other. Callers must treat it as read-only.

## 3. Field alias mapping

| Kiwi original | REST alias | Condition |
|---|---|---|
| `data.fillPaints` | `node.fills` | `'fillPaints' in data` |
| `data.strokePaints` | `node.strokes` | `'strokePaints' in data` |
| `data.effects` | `node.effects` | `'effects' in data` |
| `treeNode.guid` (`{sessionID, localID}`) | `node.id` (`"sessionID:localID"`) | always |
| `treeNode.parentGuid` | `node.parentId` (`"sessionID:localID"`) | when parent exists |
| `data.visible` (boolean) | `node.visible` | only when typeof boolean |

- I-A1 Aliases are *additive* — original keys are not removed.
  `node.raw.fillPaints` co-exists.
- I-A2 Missing fields stay missing in alias too — when `'fillPaints' in
  data` is false, `node.fills` is also omitted. Matches REST's omission
  policy.
- I-A3 `node.id` form = `${sessionID}:${localID}` (decimal). Distinct ID
  space from pencil.dev's `Pen ID` (5-base62 chars) (CONTEXT.md `GUID`
  entry).

## 4. `absoluteBoundingBox` — best-effort computation

Figma REST's `absoluteBoundingBox` is the bounding box in *root-relative*
canvas coordinates. We approximate by reading only the *translation
component* of the transform matrix.

- I-B1 If `data.size` is *not* of the form `{x: number, y: number}`, no
  bbox is emitted. Nodes that lack size (e.g. DOCUMENT root, which is
  neither rectangle nor vector) are skipped.
- I-B2 When `data.transform` is absent: `{ x: 0, y: 0, width: size.x, height: size.y }`
  (origin assumed).
- I-B3 When `data.transform` is present: use only `transform.m02` /
  `m12` (translation). Rotation (m01, m10) and scale (m00, m11) are
  **ignored** — best-effort.
- I-B4 *Not actually root-relative* — this function reads only its own
  `transform` and does not walk the parent chain. Figma REST's *true
  absoluteBoundingBox* is the accumulated parent transforms — our output
  is closer to *parent-relative bbox* (we keep the name for REST
  compatibility).
- I-B5 Bbox of rotated nodes is not supported in this spec. When rotation
  is present, the emitted width/height is *the unrotated size of the
  axis-aligned box*. An exact rotated bbox needs a separate helper (not
  yet implemented).

## 5. `serializableRaw` — Kiwi → JSON-safe form

Kiwi-decoded raw objects carry `Uint8Array` / `BigInt` and other values
JSON cannot serialize — `JSON.stringify` either fails or loses data as
`null`. This function *deterministically* converts to a serialization-safe
form.

### 5.1 Conversion rules

- I-S1 `null` / `undefined` → as-is.
- I-S2 `bigint` → `(value).toString()` (decimal string). Sign preserved
  (`-1n` → `"-1"`).
- I-S3 `Uint8Array` → `hashToHex(value)` (lowercase hex string, no `0x`
  prefix). Empty array → `""`.
- I-S4 `Array` → new array, each element recursively converted.
- I-S5 `Object` (plain) → new object, each property recursively converted.
  `for...in` + `hasOwnProperty` rule — does not walk the prototype chain.
- I-S6 Other primitives (`string`, `number`, `boolean`) → as-is.
- I-S7 `function` / `Symbol` / other exotic types → out of scope for this
  spec (Kiwi does not carry them).

### 5.2 Determinism

- I-S8 Same input → same output. Kiwi-decoded data is a tree (no cycles),
  so no `WeakMap` cache is necessary — straightforward recursion.
- I-S9 Input is assumed *read-only*. This function does not mutate the
  input.
- I-S10 `for (const k in obj)` property order follows V8's insertion-order
  + numeric-key-first rule. Equal order across CLI `extract` and `repack`
  round-trips is part of *determinism verification*.

### 5.3 `hashToHex` — shared with `assets.spec.md`

- I-S11 `Uint8Array` → hex-string conversion's source is
  `assets.ts:hashToHex`. Uses `Buffer.from(buf.buffer, byteOffset, byteLength).toString('hex')`
  (zero-copy view). String input (already hex) is lowercased and returned.

## 6. Tree recursion

- I-T1 `normalizeTree(root)` is the entry point. `root === null` returns
  `null`.
- I-T2 When `treeNode.children.length > 0`, emit `children:
  tn.children.map(normalizeNode)`. Empty children are not emitted (REST
  omission consistency).
- I-T3 Child order is the array order of `tn.children` — the result of
  fractional-index sorting on `parentIndex.position` (`parent-index-position.spec.md`).

## 7. Out of scope

- ❌ **Partial mapping for REST stylable fields** — `style`, `styles`,
  `componentSetId`, etc. are not aliased here (the same data in Kiwi has a
  different shape, making 1:1 mapping complex). Grep inside raw.
- ❌ **Rotated bbox** — see §I-B5.
- ❌ **Accumulated parent transform** — see §I-B4. Consumers that need
  true root-relative coordinates use `pen-export`'s `convertNode` (which
  walks the parent chain).
- ❌ **REST API top-level response wrap** (`document.children[0]`
  reservation, etc.). This function only does *node-level* conversion —
  root-level wrap in `output/document.json` is `export.ts`'s
  responsibility.
- ❌ **ColorVar / variable alias resolution** — Kiwi's
  `colorVar.value.alias.guid` is not resolved to a literal color (differs
  from pen-export's policy in `SPEC-figma-to-pencil §3`). Raw preservation
  takes priority over REST compatibility.
- ❌ **Mutation API** — this function is read-only conversion. Node
  editing tools live in `web-edit-node.spec.md`.

## 8. Resolved questions

- **Why is `fills` the alias and `fillPaints` the raw? Shouldn't it be
  the other way?** Kiwi's schema stamps the name `fillPaints` — that is
  the *real wire name*. REST uses `fills` as a *short alias*, and we
  emit *both*, so consumers retain grep flexibility.
- **Is the `absoluteBoundingBox` name misleading?** Slightly. It is not
  *truly absolute* (root-relative) but we reuse the name for REST API
  compatibility. For accurate absolute coordinates, use pen-export or a
  client-side transform walker.
- **Why isn't `raw` *directly spread* onto `out` instead of carried as a
  separate property?** Two-stage separation: pulling `out.fillPaints` out
  of `out.raw.fillPaints` is a *compatibility change* — coexisting raw +
  alias on a single object is required for SDD's "verify from the spec".
  Separation also makes mutation conflicts (`out.fills` vs
  `out.raw.fillPaints`) explicit.
- **Cost of `raw` deep-clone?** ~1.5s on the 35K-node meta-rich fixture.
  This spec's decision = always deep-clone (safety first). Once it is
  verified that all `raw` consumers are read-only, we may optimize to
  shallow alias — until then, keep the deep clone.
