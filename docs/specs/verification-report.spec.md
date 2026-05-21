# spec/verification-report

| Field | Value |
|---|---|
| Status | Approved |
| Implementation | `src/verify.ts` (`runVerification`, 7 check functions, `renderReport`) |
| Output | `<outputDir>/verification_report.md` |
| Tests | `test/verify.test.ts` (within available scope) — per-check PASS/FAIL/WARN/SKIP classification |
| Siblings | `SPEC.md §Stage 9` (CLI pipeline source), `PRD.md §7` (verification-strategy source), `round-trip-invariants.spec.md` (whole-pipeline invariant verification), `audit-harness.spec.md` (web-side round-trip verification) |

## 1. Goal

The CLI's last stage — check whether the extraction result satisfies the *known invariants* and emit a human-readable `verification_report.md`. Where PRD §7's V-01..V-06 describes the *target invariants*, this spec holds the *input / pass criteria / interpretation* of the *7 checks currently implemented* as the single source.

**Important**: V-05 of the PRD-defined V-01..V-06 (determinism — same input processed twice → identical SHA-256) is **currently unimplemented**. Additionally, V-07 (schema sanity) / V-08 (export artifacts) have been added *outside the PRD*. This spec sources the *actual implementation* — the differences from the PRD are listed under §6 non-goals.

## 2. Entry point

```ts
function runVerification(inputs: VerifyInputs): {
  overall: 'PASS' | 'FAIL' | 'WARN';
  checks: CheckResult[];
  reportPath: string;
};

interface VerifyInputs {
  outputDir:   string;                           // where to write verification_report.md
  container:   ContainerResult;                  // Stage 1 output
  decoded:     DecodedFig;                       // Stage 2-4 output
  tree:        BuildTreeResult;                  // Stage 5 output
  imageRefs:   Map<string, Set<string>>;         // Stage 6 output
  artifacts:   ExportArtifacts;                  // Stage 8 output
}
```

- I-E1 The 7 checks run in *fixed order*: V-01 → V-02 → V-03 → V-04 → V-06 → V-07 → V-08. (V-05 not run — §I-V5.)
- I-E2 A failure in one check does not block the next — *all* checks run to completion, then a combined verdict is computed.
- I-E3 `overall` combine rule: any `FAIL` → `FAIL` / only `WARN` → `WARN` / all `PASS` (or `SKIP`) → `PASS`.
- I-E4 Output is a single markdown file — `outputDir/verification_report.md`. No separate JSON / structured artifact is produced (only markdown is carried, for PR diffs).

## 3. CheckResult shape

```ts
interface CheckResult {
  id:      string;                               // e.g., "V-01" — PRD naming
  name:    string;                               // human-readable name
  status:  'PASS' | 'FAIL' | 'WARN' | 'SKIP';
  detail:  string;                               // goes into the markdown table cell as-is
}
```

- I-R1 `id` follows the V-XX naming of PRD §7 as-is. Because V-05 is *skipped*, V-07/V-08 are checks not in the PRD.
- I-R2 4 statuses:
  - `PASS` — invariant satisfied.
  - `FAIL` — fundamental corruption (missing tree, undecoded schema, zero artifacts).
  - `WARN` — verification failed but *non-fatal* (asset orphans, message round-trip not guaranteed, etc. — known limitations).
  - `SKIP` — situations where the invariant is not applicable (e.g., raw fig-kiwi input without meta.json).
- I-R3 `detail` is *a single line of markdown* — `|` is escaped to `\|` for table-cell compatibility, and newlines are not allowed.

## 4. Check list

### 4.1 V-01 — Input file integrity

- I-V1 Check whether the first 8 bytes of `container.canvasFig` match the `"fig-kiwi"` ASCII (`66 69 67 2d 6b 69 77 69`).
- I-V2 On PASS, detail: `'canvas.fig magic = "fig-kiwi" (✓), ZIP wrapped: <bool>, canvas.fig size: <N> bytes'`.
- I-V3 On FAIL, detail: `'canvas.fig magic invalid: <hex bytes>'`. Main causes = non-Figma file or corruption.
- I-V4 *ZIP CRC verification is not included in this check* — adm-zip verifies implicitly during `loadContainer` (throws on CRC mismatch). Explicit ZIP CRC reporting is a separate enhancement.

### 4.2 V-02 — Decoding round-trip

- I-V5 Schema-side byte-equality check: `kiwi.encodeBinarySchema(decoded.schema)` vs `decoded.rawSchemaBytes` byte-by-byte. On PASS, `bytesMatch = true`.
- I-V6 Message side: only checks whether *encoding is possible* (not byte-equal). Compares the *length* of the original data bytes (`decoded.rawDataBytes`) against the re-encoded message bytes + compares deflate-compressed sizes — diagnostic only.
- I-V7 Status rules:
  - Schema match + message encode succeeds → PASS.
  - Schema match + message encode fails → WARN ("message round-trip not guaranteed").
  - Schema mismatch → WARN.
  - Throws → WARN (graceful degrade).
- I-V8 *Does not escalate to FAIL* — minor kiwi encoding differences (e.g., explicit emission of defaults) are regression noise without semantic impact. Real round-trip breakage is caught by a separate raw byte-diff check (e.g., `audit-roundtrip-canvas-diff.mjs`).

### 4.3 V-03 — Tree consistency

- I-V9 For every node in `tree.allNodes`:
  - `parentGuid` absent, or present in `allNodes` → normal.
  - `parentGuid` present but absent from `allNodes` → `dangling++`.
- I-V10 DFS cycle detection: when a node already in the `stack` set is encountered again, `cycles++`. A visited set prevents duplicate walks.
- I-V11 `tree.document` absent → DOCUMENT root not produced; fatal.
- I-V12 Status rules:
  - dangling=0, cycles=0, document=true → PASS.
  - dangling=0, cycles=0, document=false → WARN.
  - dangling>0 or cycles>0 → FAIL.
- I-V13 detail carries the counts `nodes / document / dangling / cycles / orphans`. `orphans` is `tree.orphans.length` (non-root nodes that have no parent either).

### 4.4 V-04 — Asset consistency

Bidirectional check between `container.images` (image hashes on disk → bytes) and `imageRefs` (hashes walked from the tree → owner-node set).

- I-V14 Both `imagesLower` / `refsLower` are normalized to lowercase — absorbs wire variation where kiwi carries case-mixed hashes.
- I-V15 `missing` = hash present in refs but missing on disk. Orphan reference.
- I-V16 `unused` = hash present on disk but missing in refs. Unused image.
- I-V17 Status rules:
  - Both 0 → PASS.
  - Either > 0 → WARN. *Does not escalate to FAIL* — may be the designer's intent (e.g., a temporarily hidden image).
- I-V18 SKIP: `container.images.size === 0 && refs.size === 0` (raw fig-kiwi + design with no images).

### 4.5 V-06 — meta.json alignment

- I-V19 SKIP when `container.metaJson` is absent (raw fig-kiwi input).
- I-V20 Always PASS — this is a *summary emit* rather than verification. The detail contains:
  - `file_name`
  - `client_meta.background_color` (4-decimal rgba)
  - `client_meta.render_coordinates` (`<width>x<height> @ (<x>, <y>)`)
  - `exported_at`
  - `pages in tree` (count of CANVAS-typed children)
- I-V21 True invariant verification belongs to *user-confirm* (PRD §7.2 U-01..U-04) — no automation. This check provides only the *inputs for visual comparison*.

### 4.6 V-07 — Kiwi schema sanity

(Check added outside the PRD.)

- I-V22 `decoded.schemaStats.definitionCount` check:
  - `> 100` → PASS (Figma wire normally carries ~568 types).
  - `> 0` → WARN (suspicious, but decoding itself works).
  - `0` → FAIL (likely a schema parse failure).
- I-V23 detail carries definition count + root type + archive version + 4 compression-algorithm items (schema/data).

### 4.7 V-08 — Export artifacts

(Check added outside the PRD.)

- I-V24 `artifacts.files.length > 0` → PASS, `0` → FAIL.
- I-V25 detail: file count + total bytes (`formatBytes`) + node count + page count.

## 5. Report rendering

`renderReport(overall, checks, artifacts)` emits a markdown string.

- I-W1 Header: `# Verification Report` + overall badge (`🟢 PASS` / `🟡 WARN` / `🔴 FAIL`) + generation timestamp (ISO 8601).
- I-W2 Check-result table: header `| ID | Check | Status | Detail |`, one row per check. `|` in detail is escaped to `\|`.
- I-W3 Extraction-statistics section:
  - `artifacts.stats.totalNodes`, `pages`, `topLevelFrames`, `imagesReferenced`, `imagesUnused`, `vectorsConverted`, `vectorsFailed`.
- I-W4 *Unknown node types* section (forward-compat) — emitted only when the `unknownTypes` map is non-empty. Carried when new Figma types appear.
- I-W5 *Artifact list* section: one line per file as `- `<rel-path>` — <size> (sha256: <16 chars>…)`. Relative-path conversion strips the `outputDir` prefix + converts Windows backslashes to forward slashes.
- I-W6 Footer: `--- Generated by figma-reverse v0.1.0`.
- I-W7 Status badge mapping: `PASS=🟢`, `FAIL=🔴`, `WARN=🟡`, `SKIP=⚪`.

## 6. Non-goals (differences from the PRD)

- ❌ **V-05 determinism (same input processed twice → identical SHA-256)** — *currently unimplemented*. Missing from the 7 checks of `runVerification`. Implementation is a candidate for a separate round — moving `audit-roundtrip.mjs`'s `outSha256` comparison to the CLI side is a natural path.
- ❌ **V-CRC** (explicit verification of ZIP central directory CRC) — adm-zip verifies implicitly, but no result is reported. Add by extending `checkInputIntegrity`.
- ❌ **User-confirm verification** (PRD §7.2 U-01..U-04) — visual comparison against the Figma cloud, etc., is not automated (`audit-oracle.spec.md` / `audit-harness.spec.md` partially automate it).
- ❌ **Structured JSON output** — markdown only. JSON integration with CI pipelines is a separate enhancement.
- ❌ **Regression baseline comparison** — no automatic diff against the previous verification report. Humans read the git diff.
- ❌ **Performance budget** — verification of processing time / memory usage (PRD NF-01/NF-02) is out of scope.

## 7. Resolved questions

- **Why is V-02 a WARN when schema matches but message encode fails?** Some unknown-type entries in metarich lack a path through kiwi's encode, and that does not affect decoding/rendering — when schema compatibility is preserved, *forward-compat semantics are preserved*. True round-trip breakage is caught by the byte-diff of audit-harness.
- **Why does V-04 only emit WARN, never FAIL?** Images temporarily hidden by the designer can legitimately remain on disk. Orphan references may be data Figma carries as a temporary cache. A region for human judgment.
- **Why is `unknownTypes` carried?** Figma updates the schema frequently — when a new type appears in our normalize / verify code path, we *carry without crashing* and *report to humans*, a forward-compat policy. Once spotted, handle in the next round.
- **Is the single-line constraint on `detail` actually enforced?** A markdown-table-cell limitation — `\n` breaks the table. Multi-line information is split into separate sections. All 7 checks in this spec are designed to fit one line.
