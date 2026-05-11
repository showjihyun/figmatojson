# SPEC-repack — `.fig` repack 3-mode integrated contract

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `src/repack.ts` (`repack()` dispatcher + `repackByteLevel` / `repackKiwi` / `repackFromJson` + reusable `buildByteLevelFigBuffer` helper) |
| Tests | `test/e2e.test.ts` (`repack byte/kiwi/json mode` gates) |
| Siblings | `docs/adr/0002-roundtrip-equality-tiers.md` (no lossy mode), `docs/specs/json-repack-codec.spec.md` (JSON tag codec), `docs/specs/round-trip-invariants.spec.md` (parser self-roundtrip), `docs/SPEC.md §10` (CLI Stage listing), `docs/specs/audit-harness.spec.md` (web-side round-trip verification) |

## 1. Purpose

The CLI's reverse pipeline (`extracted/<name>/` → `<out>.fig`) supports 3 modes — **byte / kiwi / json**. Each mode's *input location / output equality / trade-offs* have been scattered across SPEC.md, ADR-0002, and json-repack-codec.spec.md. This spec consolidates the *integrated contract* of the 3 modes as a single source.

Core invariant — **lossy mode is forever forbidden** (ADR-0002). Every mode in this spec must guarantee either byte-identical or semantically-equivalent output.

## 2. Mode selection criteria

| Mode | Input directory | Output equality | Use case |
|---|---|---|---|
| `byte` | `extracted/01_container/` | byte-identical (canvas.fig) | backup / archival baseline |
| `kiwi` | `extracted/03_decompressed/` | semantically equivalent | re-encode verification, unify deflate |
| `json` | `extracted/04_decoded/message.json` (editable) | semantically equivalent (after edits) | the only path to repack after the user *modifies* the tree |

- I-M1 entry point = the single function `repack(extractedDir, outPath, { mode })`. Dispatch to one of the 3 functions via an internal switch. Unknown modes throw.
- I-M2 No automatic mode selection / fallback — the caller must specify exactly one mode. Guessing is the same class of trust risk as lossy mode.
- I-M3 Output is *always a ZIP-wrapped `.fig`*. A raw fig-kiwi output mode is out of scope (only the input auto-branches; the output is unified).

## 3. Equality tier — contract per mode

### 3.1 `byte` mode

- I-B1 Input: `canvas.fig` (required) under `extracted/01_container/` + `meta.json` / `thumbnail.png` (if present) + *all* of `images/` (if present).
- I-B2 All file reads run in parallel (`Promise.all`) — the `buildByteLevelFigBuffer` helper is reused by other modules (round-trip HTML, etc.).
- I-B3 ZIP entry names in the output preserve the input directory paths (`canvas.fig`, `meta.json`, `thumbnail.png`, `images/<sha1>`). Files inside `images/` are added in `readdirSync().sort()` order — determinism guaranteed.
- I-B4 ZIP compression mode = STORE (compression method 0). The `forceStoreCompression` helper forces every entry's `header.method` to 0 — identical to the wire format Figma carries.
- I-B5 Equality: **the inner `canvas.fig` is byte-identical**. The outer ZIP itself is not byte-identical — adm-zip's central directory metadata (timestamps / extra fields) may differ. Only the inner `canvas.fig` is verified.
- I-B6 Verification: `finalizeResult` records `comparison.canvasFigBytesIdentical: bytesEqual(rt.canvasFig, orig.canvasFig)` — only `byte` mode emits this field; other modes leave it undefined.
- I-B7 User *edits* are not reflected — the input is raw bytes with no edit entry point. For edit + repack use `json` mode.

### 3.2 `kiwi` mode

- I-K1 Input: `schema.kiwi.bin` + `data.kiwi.bin` under `extracted/03_decompressed/` (both required). Sidecars (`meta.json`, `images/`, etc.) are reused as-is from `01_container/`.
- I-K2 Processing: `kiwi.decodeBinarySchema` → `compileSchema` → `decodeMessage` → *as-is* `encodeMessage` + `encodeBinarySchema`. Semantic identity is guaranteed; byte identity is *not* (it depends on the determinism of kiwi's field ordering / variable-length encoding).
- I-K3 Compression: both chunks are unified to `pako.deflateRaw`. The original's zstd chunk is *converted* to deflate too — since `fzstd` is decode-only, this unification is forced.
- I-K4 Archive header reconstruction: `buildFigKiwiArchive(version, [compressedSchema, compressedData])` — `8B "fig-kiwi"` + `4B LE uint32 version` + each chunk's `4B LE uint32 size + bytes`. The version is read from `02_archive/_info.json`; on absence / parse failure, fall back to `106` (the observed default).
- I-K5 Equality: **semantically equivalent** — same node count + same number of schema definitions + same archive version + same root message type (all 4 `finalizeResult.comparison` fields must match). Any one check failing is a violation of the mode contract.
- I-K6 User edits are not reflected — the input is binary with no edit entry point (the biggest difference from json mode).
- I-K7 Typical output size is +10~20% over the original (deflate vs zstd is the main contributor). The `audit-roundtrip` baseline (6.05 MB sample → ~6.5 MB) is the normal distribution.

### 3.3 `json` mode

- I-J1 Input: `extracted/04_decoded/message.json` (required) + `extracted/03_decompressed/schema.kiwi.bin` (required; schema is not edited). Sidecars same as kiwi mode.
- I-J2 Prerequisite: the `--include-raw-message` flag during `extract` — without it, `04_decoded/message.json` is not generated. If the input is missing, emit a friendly error and throw.
- I-J3 JSON parse: `JSON.parse(text, reviver)` whose reviver restores the special tags (§3.4). Plain objects/arrays/scalars pass through.
- I-J4 Encode: `kiwi.compileSchema(schema).encodeMessage(parsedMessage)` — the user-edited tree must be schema-compatible. On incompatibility kiwi throws; this function propagates as-is.
- I-J5 Equality: **semantically equivalent after edits applied** — the edited nodes change as the user intends, while the *untouched parts* preserve their semantics. Since the node count can change with user edits (insert/delete), `nodeCountMatch` is *not* a verification target, and only `comparison`'s schema / archiveVersion are meaningful.
- I-J6 The foundation of the lossless guarantee = the §3.4 special-encoding tag system. If even a single tag falls through as raw JSON, that data is lost (e.g. blob bytes → null, bigint → TypeError, NaN → null).

### 3.4 JSON tag system (lossless guarantee)

The `json` mode's lossless invariant depends on the bidirectional sync of the following 3 tags. The encode side is `intermediate.ts:roundTripReplacer`, the decode side is `repack.ts:reviveBinary` — the two functions must move *together* (a re-statement of ADR-0002).

- I-T1 `Uint8Array` ↔ `{ __bytes: <base64> }`. Decode returns a `Uint8Array` view over the backing buffer of `Buffer.from(..., 'base64')` (zero-copy).
- I-T2 `bigint` ↔ `{ __bigint: <decimal-string> }`. Restore via `BigInt(str)`.
- I-T3 Non-finite numbers ↔ `{ __num: "NaN" | "Infinity" | "-Infinity" }`. Other finite numbers stay as raw JSON.
- I-T4 Generic object/array/scalar passes through the reviver — objects *without* any magic key (`__bytes` / `__bigint` / `__num`) are returned unchanged.
- I-T5 Adding a new tag = add one entry inside a single file (after the `jsonRepackCodec.ts` refactor of `json-repack-codec.spec.md`) + one replacer case + one reviver case + a unit test. Missing any one case → lossy → ADR-0002 violation.

## 4. Common flow — `finalizeResult`

After writing output, all 3 modes call the same `finalizeResult` — re-read the produced file *with our own parser* to verify round-trip.

- I-F1 `loadContainer(outPath)` + `decodeFigCanvas(canvasFig)` — on failure, set `verify.extracted = false` + an error message. Skip other verifications.
- I-F2 On success, record on `verify`: `isZipWrapped`, `archiveVersion`, `schemaDefCount`, `nodeChangesCount`, `blobsCount`, `rootMessageType`.
- I-F3 When the `originalFig` option is provided, additionally compute the 4 `comparison` fields (§3.2 I-K5): `nodeCountMatch`, `schemaDefCountMatch`, `archiveVersionMatch` — and for `byte` mode, also `canvasFigBytesIdentical`.
- I-F4 Output SHA-256 = `outSha256`. Usable as a round-trip identifier.

## 5. RepackResult schema

```ts
type RepackMode = 'byte' | 'kiwi' | 'json';

interface RepackOptions {
  mode:        RepackMode;
  originalFig?: string;  // enables round-trip comparison
}

interface RepackResult {
  mode:        RepackMode;
  outPath:     string;
  outBytes:    number;
  outSha256:   string;             // SHA-256 of outPath
  files:       Array<{ name: string; bytes: number }>;  // ZIP entry inventory
  verify: {
    extracted:        boolean;
    isZipWrapped?:    boolean;
    archiveVersion?:  number;
    schemaDefCount?:  number;
    nodeChangesCount?: number;
    blobsCount?:      number;
    rootMessageType?: string;
    error?:           string;
  };
  comparison?: {                   // present when originalFig is provided
    originalNodeCount:        number;
    nodeCountMatch:           boolean;
    originalSchemaDefCount:   number;
    schemaDefCountMatch:      boolean;
    originalArchiveVersion:   number;
    archiveVersionMatch:      boolean;
    canvasFigBytesIdentical?: boolean;  // defined only in byte mode
  };
}
```

- I-S1 The `comparison` field is defined *only when `originalFig` is provided and the file exists*. Otherwise it is undefined — round-trip verification itself is optional.
- I-S2 When `verify.extracted = false`, all other `verify` fields are undefined and only `error` is defined. This prevents callers from being confused by a partial state.

## 6. Error policy

- I-E1 A missing input directory / file emits a *friendly error* — including "which file is needed for which mode + which command generates it" in the message. Example: `"extracted/04_decoded/message.json not found. Run \`figma-reverse extract <fig> --include-raw-message\`"`.
- I-E2 kiwi decode/encode failures propagate as-is — schema violations from user edits are by far the most likely cause, and the `kiwi` library's error messages already carry enough diagnostic info.
- I-E3 `verify` stage failures do *not* throw — only record `verify.extracted = false` + `error`. Round-trip verification is *informational*; the output file itself has already been written.
- I-E4 Unknown modes throw immediately from the dispatcher — argument validation belongs in this function, not later.

## 7. Out of scope

- ❌ **lossy mode** (`derivedSymbolData` / `derivedTextData` / glyph cache trim) — ADR-0002 explicitly forbids it. PRs that propose it are rejected with an ADR pointer.
- ❌ **outer-ZIP byte identity in `byte` mode** — adm-zip's carry-along metadata (CDFH timestamp / version-needed-to-extract etc.) is not a byte-identity target. Only the inner `canvas.fig` is guaranteed (§I-B5).
- ❌ **zstd preservation in `kiwi` mode** — `fzstd` is decode-only, so output is unified to deflate. Originals where Figma carried zstd chunks emerge as deflate on our output. Reading is fine (auto-detected at decode time) — only the write side is unified to deflate.
- ❌ **schema editing in `json` mode** — the schema is not a user-edit target. To change schema-related content, use `kiwi` mode (but even then the schema *content* cannot be changed; only re-encoded).
- ❌ **Edit-collision detection** — races where the schema changes while the user edits `04_decoded/message.json` are not handled. User responsibility.
- ❌ **streaming repack** — every mode keeps the file in memory. Fixtures >500 MB are unsupported (same assumption as other CLI stages).
- ❌ **partial fixture repack** — no auto mode selection when *only some* of `01_container/` / `03_decompressed/` / `04_decoded/` are present. Per-mode inputs are strict (§3 I-B1 / I-K1 / I-J1).

## 8. Resolved questions

- **Which of the 3 modes is default?** None — CLI always requires `--mode <byte|kiwi|json>` explicitly. The moment a default is introduced, there's a chance of *forgetting which mode round-tripped*, and the equality tier becomes blurred.
- **Is `byte` mode really byte-identical, or do ZIP timestamps etc. vary?** Only the inner `canvas.fig` is byte-identical (§I-B5). The outer ZIP itself carries adm-zip metadata variance. The byte-mode gate in test/e2e verifies only the inner.
- **Why is `kiwi` mode output larger than the original?** zstd → deflate conversion + kiwi's variable-length encoding emits some default values explicitly. Semantic equivalence is preserved but byte identity is not. The reason ADR-0002 does not consider this lossy = *every field is preserved*; it is only an explicit representation of defaults.
- **Does the NaN tag of `json` mode really appear on the wire?** Yes. The kiwi schema emits the default for unset float fields as the NaN bit pattern (in the sample corpus, the unset state of stack*Spacing is common). If the json reviver doesn't restore NaN, that unset state becomes 0, which is lossy.
- **Do the web round-trip in `audit-harness.spec.md` and the CLI repack in this spec follow the same contract?** Partially. Web's `POST /api/save` is equivalent to `kiwi` mode (it never goes through the `extracted` directory: in-memory document → encode → zip). `byte` mode and `json` mode have no web-side counterpart — CLI-only. The equality tier is under the same ADR-0002 framework.
