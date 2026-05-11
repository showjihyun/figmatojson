# spec/asset-walk

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `src/assets.ts` (`detectImageExt`, `hashToHex`, `collectImageRefs`, `walkValue`) |
| Tests | `test/assets.test.ts` (within available scope) — magic mapping + walk patterns + Uint8Array conversion units |
| Siblings | `SPEC.md §Stage 6` (CLI pipeline source), `PRD.md §1.2.4` (real-world magic verification), `verification-report.spec.md §V-04` (input for image consistency checks) |

## 1. Goal

CLI Stage 6 — *bidirectional* mapping between `images/<sha1>` (extensionless
binaries) in the `.fig` container and `imageRef` references in the node tree.
Two sub-tasks:

1. **Extension inference** (`detectImageExt`): classify PNG/JPEG/GIF/PDF/WebP/SVG
   using 8 magic bytes. Figma does not carry mime-type on the wire, so we must
   infer it on our side to save to disk with proper extensions.
2. **Tree walk** (`collectImageRefs`): pattern match *where* in node data an
   image hash can appear. Result is `Map<hash, Set<owner-guid>>` — an inventory
   of which images are used by which nodes.

This spec sources the *input shape / mapping / fallback / determinism* of both
rules.

## 2. `detectImageExt(buf)` — magic byte → extension

### 2.1 Mapping table

| Extension | Magic bytes (offset 0 from buf) | Notes |
|---|---|---|
| `png` | `89 50 4e 47 0d 0a 1a 0a` (8B) | Standard PNG signature |
| `jpg` | `ff d8 ff` (3B) | JPEG SOI marker (segment-specific bytes follow) |
| `gif` | `47 49 46 38` (4B "GIF8") | Matches both GIF87a and GIF89a |
| `pdf` | `25 50 44 46` (4B "%PDF") | PDF header |
| `webp` | RIFF wrapper at offset 0-11: `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` | offset 0-3 = "RIFF", 8-11 = "WEBP", 4-7 = size (variable) |
| `svg` | `<?xml` or `<svg` within first 16 bytes (case-insensitive) | text-based — prefix matching rather than magic |
| `bin` | (none of the above match) | fallback |

- I-X1 *Priority*: WebP → SVG → MAGICS. WebP must be checked first via its
  RIFF prefix, otherwise other mappings may incorrectly match.
- I-X2 SVG uses *string prefix matching* — `String.fromCharCode(...buf.slice(0, 16))`
  → `/^\s*<\?xml/.test(...)` or `/^\s*<svg/i.test(...)`. Differs from other
  entries in matching strategy.
- I-X3 *Binary detection only* — no text encoding (UTF-8 vs UTF-16) detection.
  An SVG starting with a UTF-16 BOM will fail to match → fallback `'bin'`. Not
  observed on the wire.
- I-X4 Fallback `'bin'` — unknown format. Stored on disk as `<hash>.bin` so the
  user can inspect afterwards.

### 2.2 Input validation

- I-X5 `buf.length < 4` → immediately return `'bin'` (shortest magic length
  among PNG/JPG/GIF/PDF is 4B).
- I-X6 `buf.length < 12` → skip WebP check. Only PNG/JPG/GIF/PDF/SVG are
  attempted.
- I-X7 SVG prefix slice length is `min(buf.length, 16)`. Safe for short
  buffers.

### 2.3 Determinism

- I-X8 Same buffer → same ext. No randomness.
- I-X9 Magic check is *short-circuit* — first match returns immediately. The
  order of the mapping table determines the outcome (PNG before JPG — zero
  collision risk).
- I-X10 Never throws. Returns a string for every input.

## 3. `hashToHex(hash)` — Uint8Array → hex string

Responsibility of `assets.spec`, but other modules (`normalize.ts`, AI tools)
also use it → this function is the *single source*.

- I-H1 Input `null` / `undefined` / unconvertible type → returns `null`.
- I-H2 `string` input → applies `.toLowerCase()` then returns (assumed already
  hex, only case is normalized).
- I-H3 `Uint8Array` input → `Buffer.from(hash.buffer, byteOffset, byteLength).toString('hex')`.
  *Zero-copy view* — no new byte allocation (V8 native fast path).
- I-H4 Result is *always lowercase hex* — no downstream normalization cost.
  Absorbs case variations from the wire.
- I-H5 Empty array → `""` (empty string). Not null.
- I-H6 Determinism: same buffer → same hex. Byte order preserved.

### 3.1 Non-Buffer environments

- I-H7 `Buffer` is Node-only. Calling from the browser raises `ReferenceError`.
  This helper is *server-side only* — same policy as
  `web/core/domain/messageJson.ts:reviveBinary`.

## 4. `collectImageRefs(root)` — tree walk

Recursively walks the entire node tree to collect image hash appearances.

### 4.1 Signature and return

```ts
function collectImageRefs(root: TreeNode | null): Map<string, Set<string>>;
```

- I-W1 Key = lowercase hex hash. Value = Set of `guidStr` for nodes carrying
  that hash.
- I-W2 `root === null` → returns empty Map (no throw).
- I-W3 Walks *the node itself plus all descendants* — siblings are entered via
  the parent walk.

### 4.2 Match patterns

`walkValue(value, ownerGuid, refs)` checks the following patterns in order on
*every nested value* in node data:

- I-W4 `value.image.hash` (nested object): if `image` is an object with a
  `hash` field → `addRef(refs, hashToHex(image.hash), ownerGuid)`. The most
  common pattern (rectangle / FRAME imageFill).
- I-W5 `value.hash` (direct field): the value itself carries `hash: Uint8Array | string`
  → ref added. Appears in Image message objects, etc.
- I-W6 `value.imageRef` (REST API compatible naming): `imageRef: string` →
  lowercased and added as ref. Compatible with the alias in our normalize
  output.
- I-W7 All 3 patterns are checked *before* descending into children — multiple
  patterns matching the same object will all add refs.

### 4.3 Walk rules

- I-W8 `value === null || undefined` → return (skip).
- I-W9 `typeof value !== 'object'` → return (primitive, cannot source a hash).
- I-W10 `Uint8Array` → return (binary leaf, walk terminates). Image bytes are
  carried by a separate blob array.
- I-W11 `Array` → `for...i` loop recursively walks each element. Even if an
  element is a string, W3's `imageRef` match applies only at the *object
  level* — string elements within arrays are not treated as hashes.
- I-W12 Plain object → `for...in` + `hasOwnProperty` walks only own
  properties. The prototype chain is not traversed.

### 4.4 Cycle safety

- I-W13 Kiwi-decoded data is a *tree structure* (parent → child unidirectional
  refs) so cycles cannot occur. This function has no `WeakSet` cycle guard —
  safe.
- I-W14 If a cycle is introduced (e.g. via manual mutation) → infinite
  recursion + stack overflow. This function relies on the contract that *the
  input is a tree*.

## 5. Consumers

| Consumer | Use |
|---|---|
| `verify.ts:checkAssetConsistency` (V-04) | Bidirectional comparison between the `images/` directory and the ref Map. Detects orphans / unused entries. |
| `export.ts` | Appends ext when saving image files to disk + counts `imagesReferenced` / `imagesUnused`. |
| `pen-export.ts` | Maps hash → on-disk path during INSTANCE image fill conversion. |
| `audit-rest-as-plugin.mjs` | (Indirect) — REST API image fills also match via the same hash. |

- I-U1 The result Map is *read-only* — consumers do not mutate it. The same
  Map is shared across consumers.
- I-U2 The *order* of the owner Set is the walk order (tree DFS). Deterministic.

## 6. Out of scope

- ❌ **Vector image (`.svg` text)** — magic detection only — this spec's SVG
  mapping applies only when the *binary blob on the wire* is SVG XML. Typical
  `.fig` files have mostly raster images — SVG blobs are rare.
- ❌ **Additional formats like HEIC / AVIF / TIFF** — unsupported. They fall
  back to `'bin'`; users add a magic and update the spec.
- ❌ **EXIF / metadata extraction** — inner image-byte metadata is outside this
  spec.
- ❌ **Recomputing the hash of image content** — the wire hash is trusted as
  ground truth. Re-verifying SHA-1 is a candidate for a separate round.
- ❌ **Vector path image (`fillGeometry` vectors)** — handled by
  `vector-decode.spec.md`. This walk handles only raster image hashes.
- ❌ **Mutation tooling — adding new images** — read-only conversion only.
  Image upload and ref updates belong in a separate spec.
- ❌ **Image deduplication** — this spec covers hash mapping only; dedup
  itself is already performed by Figma (same image bytes → same SHA-1 → same
  filename). We merely *read* that result.

## 7. Resolved questions

- **Why is WebP a separate branch?** RIFF/WEBP magic spans *two separated
  chunks* (offsets 0-3 + 8-11) so simple prefix matching does not catch it.
  The MAGICS table's `magic: number[]` format handles only *contiguous bytes*,
  so WebP requires a hand-coded check.
- **Why does SVG use string prefix matching instead of magic?** XML / SVG has
  no binary magic; it is text. `<?xml` or `<svg` appears as a prefix —
  distinguishable from other formats. `\s*` also tolerates leading whitespace.
- **Why is `hashToHex`'s `Buffer.from(buffer, byteOffset, byteLength)` the
  fast path?** `Buffer.from(uint8Array)` (single arg) is a *copy*; the 3-arg
  form is a *view*. V8's native binding builds the hex string directly atop
  the view — 5-10× faster than Array.from + map + join (measured over the 12
  image hash conversions in the meta-rich fixture).
- **Why does `collectImageRefs` carry owners as a `Set`?** A single hash can
  be used by multiple nodes (component master + several instances + a
  general-purpose rectangle reuse). Collecting into a Set keeps V-04's unused
  check accurate.
- **Rationale for `for...in` vs `Object.keys()`?** `for...in` is friendlier to
  V8's hidden class cache (~5% faster on the meta-rich 35K node walk). Both
  produce identical results — the choice here optimizes perf.
