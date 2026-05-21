# spec/audit-harness

| Field | Value |
|---|---|
| Status | Approved (Phase 1 — round 30 transition) |
| Implementation | `web/scripts/audit-roundtrip.mjs`, `audit-roundtrip-canvas-diff.mjs`, `audit-rest-as-plugin.mjs` |
| Output | `docs/audit-roundtrip/<fixture-name>/report.json` + `canvas-diff.json` |
| Siblings | `audit-oracle.spec.md` (plugin oracle), `round-trip-invariants.spec.md` (parser self-roundtrip), `SPEC-repack.md` (3-mode contract), `docs/HARNESS.md` (CLI-side harness) |

## 1. Goal

**Phase 1 baseline**: automatically measure which parts of a .fig our web pipeline (`POST /api/upload` → `POST /api/save`) preserves and which parts it loses across a *no-op load→save* cycle. The result is the *lower bound* of "Figma can re-open it correctly" — data that fails here will not survive a reload into Figma.

Three scripts watch the same round-trip at *different fidelities*:

| Script | Fidelity | Target |
|---|---|---|
| `audit-roundtrip.mjs` | ZIP entry byte-compare | Container layer (canvas.fig / images / meta.json) |
| `audit-roundtrip-canvas-diff.mjs` | Kiwi message field walk | Semantic changes in canvas.fig |
| `audit-rest-as-plugin.mjs` | `audit-oracle` protocol | Differences between Figma REST and our parser |
| `audit-raw-coverage.mjs` (round 17) | Raw vs documentJson field walk | Measure wire-format fields that do not reach the client or are lost on serialization |
| `audit-properties-coverage.mjs` (round 17) | componentPropDefs / Assignments / VARIABLE coherence | Measure broken / orphan property metadata |

This spec holds the *shared calling convention, I/O, and classification rules* of the three scripts as the source of truth.

## 2. Shared environment

- I-E1 Every script requires the web backend running on `:5274` (`cd web && npm run dev:server`). Port override via the `AUDIT_BACKEND` environment variable.
- I-E2 Output root = `docs/audit-roundtrip/<basename(fixture, '.fig')>/`. Each script writes its own file (`report.json`, `canvas-diff.json`, etc.) into the same fixture directory.
- I-E3 Default fixtures = `['docs/bvp.fig', 'docs/<metarich-ui-design>.fig']` (the second path is the metarich UI design fixture; its on-disk filename is in Korean). CLI args can override with N absolute or repo-relative paths.
- I-E4 NaN equality rule: when both values are numbers and both `NaN`, treat as equal (same as `audit-oracle.spec.md §I-A14` — kiwi schema emits the NaN bit-pattern as the default for unset floats).
- I-E5 Byte comparison uses a single helper `bytesEqual(a, b)` — every script carries the same implementation. On difference, the first divergence offset is also recorded (for triage).
- I-E6 Each script has a per-fixture try/catch — failure on one file does not stop the rest. The process exit code is 1 only on an unhandled exception in `main` itself.

## 3. `audit-roundtrip.mjs` — Container-layer byte-compare

### 3.1 Flow

- I-R1 Send fixture bytes as `multipart/form-data` to `POST /api/upload` → response `{ sessionId, pageCount, nodeCount, ...UploadFigOutput }`.
- I-R2 Call `POST /api/save/:id` (no-op edit) under the same sessionId → receive the `application/octet-stream` response as `Uint8Array`.
- I-R3 Unzip both original and round-trip via `unzipFig` — verify ZIP magic (`0x50 0x4b`), then build an entry map. A non-ZIP raw fig-kiwi is wrapped into a single-entry map (key `<raw>canvas.fig`) — keeping the whole flow ZIP-assumed.
- I-R4 Per-entry byte compare → emit `entries[]` and `summary` (§3.2).

### 3.2 Classification

Each entry is classified into one of four statuses:

- I-R5 `identical`: byte-equal. `origBytes`, `rtBytes` are recorded as identical values.
- I-R6 `differs`: present on both sides but bytes differ. Additional fields `deltaBytes` (rt - orig), `firstDiffOffset` (the offset where the two byte arrays first diverge, capped at the shorter length).
- I-R7 `missing-in-roundtrip`: present only in orig. (Definitively a loss on our side.)
- I-R8 `extra-in-roundtrip`: present only in rt. (Added on our side — almost never legitimate; suspect a regression when seen.)

### 3.3 `summary` output

```ts
interface RoundtripSummary {
  totalOrigBytes:    number;  // sum(origBytes)
  identicalBytes:    number;  // sum(origBytes) where status='identical'
  identicalRatio:    number;  // identicalBytes / totalOrigBytes (0..1)
  identicalCount:    number;
  differingCount:    number;
  missingCount:      number;
  extraCount:        number;
  totalEntries:      number;
}
```

- I-R9 The entries in `report.json` are in entry-name `sort()` order. Guarantees determinism.
- I-R10 `identicalRatio` is computed against the *sum of entry bytes* — not entry counts (canvas.fig is usually the largest single entry, providing a meaningful weighting).

### 3.4 Output schema (`report.json`)

```ts
{
  fixture:    string;        // CLI input verbatim (rel/abs preserved)
  origBytes:  number;        // total bytes of the original .fig
  rtBytes:    number;        // total bytes of the round-trip .fig
  upload:     UploadFigOutput;
  summary:    RoundtripSummary;
  entries:    Array<RoundtripEntry>;
}
```

## 4. `audit-roundtrip-canvas-diff.mjs` — Kiwi message field walk

When `audit-roundtrip.mjs` only reports *canvas.fig differs*, this script tells you *which field differs and how*.

### 4.1 Flow

- I-C1 Identical upload→save to §3.1 — but does not read `report.json`; performs the round-trip itself (script independence).
- I-C2 Extracts the `canvas.fig` entry from both .fig files (`extractCanvasFig`). Non-ZIP raw passes through.
- I-C3 Decodes both canvas.fig sides via `decodeFigCanvas` (dist/decoder.js) — yielding archive version + schema definition count + message tree.
- I-C4 `walkDiff(orig.message, rt.message)` runs a generator-based recursive walk.

### 4.2 Diff classification

The `kind` of records emitted by `walkDiff`:

- I-C5 `type-mismatch`: `typeOf(orig) !== typeOf(rt)`. Type set = `{ object, array, bytes, number, string, boolean, nullish }`.
- I-C6 `added`: a key present in the rt object but not in orig.
- I-C7 `removed`: a key present in orig but not in rt.
- I-C8 `array-len`: arrays at the same path have different lengths. Emit only the length diff and continue per-element walkDiff recursion up to `min(orig.length, rt.length)` (still collecting element-level diffs in the head).
- I-C9 `changed`: scalar or bytes differ. NaN==NaN is treated as equal (§I-E4).

### 4.3 Aggregation

- I-C10 `aggregateDiffs(diffs)` computes `byKind` (kind→count) and `byField` (key = path with array indices normalized to `[]` → count + per-kind breakdown). `topFields` = top-30 of byField, descending.
- I-C11 `fieldKey(path)` = `path.replace(/\[\d+\]/g, '[]')` — `nodeChanges[42].size.x` and `nodeChanges[1280].size.x` aggregate to the same field.

### 4.4 Output schema (`canvas-diff.json`)

```ts
{
  fixture:           string;
  canvasOrigBytes:   number;
  canvasRtBytes:     number;
  schemaDefsOrig:    number;     // schema definition count (for semantic-equivalence checks)
  schemaDefsRt:      number;
  aggregate: {
    total:           number;
    byKind:          Record<DiffKind, number>;
    topFields:       Array<[fieldPath, { count, kinds: Record<DiffKind, number> }]>;
  };
  sample:            DiffRecord[];   // up to 200 entries (truncation)
}
```

- I-C12 `sample` is the first 200 entries in discovery order. Truncation does not preserve frequency distribution — sampling is for triage, the frequency signal is carried by `aggregate`.

## 5. `audit-rest-as-plugin.mjs` — REST simulation of the plugin oracle

Reproduces the plugin-sandbox output defined by `audit-oracle.spec.md` **without the Figma Desktop plugin** — adapts the REST API (`/v1/files/:key`) response. Allows verifying the oracle protocol without a human in the loop.

### 5.1 Environment + corpora

- I-X1 From `.env.local`: `FIGMA_TOKEN` (required) + per-corpus keys (`FIGMA_FILE_KEY` for metarich / `FIGMA_FILE_KEY_BVP` for bvp).
- I-X2 Corpus map = `{ bvp: { figPath, keyEnv }, metarich: { figPath, keyEnv } }`. CLI accepts N corpus names (default `['bvp']`).
- I-X3 Missing `.env.local` / missing token / missing key are *fixture-level* errors (caught + continue) — main does not exit.

### 5.2 Flow

- I-X4 REST `GET https://api.figma.com/v1/files/<KEY>` (header `X-Figma-Token`) → `restJson.document` is the root.
- I-X5 `adaptNode(restJson.document)` emits the plugin-sandbox output shape of `audit-oracle.spec.md §3` (§5.3).
- I-X6 Upload the local `.fig` of the same fixture to our backend via `POST /api/upload` → `sessionId`.
- I-X7 `POST /api/audit/compare { sessionId, figmaTree: adaptedTree }` → `AuditCompareOutput` response.
- I-X8 Prints `summary` + top-15 `topFields` + top-5 sample diffs to the console. **Does not write JSON files** — the diff distribution is meant for immediate human reading.

### 5.3 REST → plugin shape adaptation

Reproduces the serialization contract of `audit-oracle.spec.md §3 (I-S1..10)` from a REST response. Key transformation points:

- I-X9 Coordinate system: convert REST's `absoluteBoundingBox` back to *parent-relative coordinates*. Accumulate `parentAbs = { x, y }` during child walk, `transform.m02 = bbox.x - parentAbs.x`, `m12 = bbox.y - parentAbs.y`. This makes our parser's parent-relative `transform` directly comparable.
- I-X10 fontName: REST carries `style.fontFamily` (display) + `style.fontPostScriptName` (the actual PS name). The plugin side emits `fontName.style` as the `-<style>` tail of the PS name. The adapter splits via `ps.lastIndexOf('-')` — also handles cases where display `family` differs from PS `family` (e.g., `Pretendard` vs `PretendardVariable`).
- I-X11 fills/strokes/strokeWeight: always emit (even when arrays are empty) — same policy as the plugin sandbox. Prevents `fills.length` / `strokes.length` comparisons from being blurred by adapter omission.
- I-X12 Default omission: emit only when `opacity !== 1`, `rotation !== 0`, `cornerRadius !== 0` (same as the plugin sandbox — `audit-oracle §I-S4`).
- I-X12a **Rotation unit + sign normalization**: REST carries `node.rotation` in *radians, math convention (CCW positive)*. The plugin sandbox emits *degrees, plugin convention (CW positive)* (`audit-oracle §I-A4a`). The adapter aligns the two with `out.rotation = -node.rotation * 180 / Math.PI`, and omits when the converted value is 0 (or close enough that the 0.5 tolerance of §I-A15 absorbs it). Missing this conversion produces 2K+ audit false-positives on every rotated node, so it is enshrined as a separate invariant (rationale: HPAI corpus baseline measurement, 2026-05-06 hpai run, 2060 rotation diffs → expected 0).

### 5.4 Caveats vs. a real plugin trial

- I-X13 REST shows the *current* file state on Figma's cloud — desktop plugin shows the state *loaded* by the desktop app. Starting both from the same `.fig` is practically identical.
- I-X14 REST does not expose some plugin-only fields — but every field in the oracle's COMPARABLE_FIELDS (§audit-oracle §5.2) exists in REST.

## 6. Non-goals

- ❌ **Output file schema backward compatibility**. The shape of `report.json` / `canvas-diff.json` can change in round 30+ — these are *inputs to the next round*, not production artifacts. Update this spec when the shape changes.
- ❌ **CI integration**. This harness runs manually on local dev — it requires the backend running and the fixtures live raw in `docs/` (not git LFS). CI integration is a separate round.
- ❌ **Automated regression alerts**. We do not automatically compare report.json against a baseline. Humans read the git diff.
- ❌ **Round-trip verification for canvas-diff.mjs**. Semantically equivalent orig=rt should yield `total = 0`, but the current baseline is *non-zero* and this harness merely *measures* the value. Driving it to 0 is a follow-up round.
- ❌ **Per-page multi-page audit**. REST-as-plugin walks from the root document — `audit-oracle §I-X4` covers only `figma.currentPage`. REST gets every page at once, so this script compares from the root (different from the sandbox). Consequence: REST always has more nodes than the plugin side — `summary.onlyInFigma` is a noisier signal than in a plugin trial.

## 7. Resolved questions

- **Why does `audit-roundtrip.mjs` emit entries sorted by name?** report.json is an *artifact committed to git* — deterministic order is required to reduce diff noise. Natural ZIP-entry order varies by OS / adm-zip version.
- **Why does `canvas-diff.mjs` truncate samples to 200?** Decoding 35K nodes of metarich → walkDiff can emit tens of thousands of records. Putting a 10MB+ JSON in git is low value-vs-cost. The frequency distribution signal's true source is `aggregate`.
- **Does the REST adapter have to *perfectly* match the plugin sandbox?** No. The oracle's comparison rules (`audit-oracle §5`) absorb most representational differences with default omission / type alias / NaN equality / 0.5px tolerance. The adapter is responsible only for *semantic equivalence* — the wire shape can differ slightly while oracle output stays the same.
- **Why do all 3 scripts carry their own unzipFig / bytesEqual / loadEnv (DRY violation)?** Each script must be *independently runnable* — for tracing backend-down, individual-fixture audit, etc. Lifting them into a shared helper is reconsidered in round 30+ once the script count exceeds 5.
