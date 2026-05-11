# HARNESS — Test Harness Engineering

| Item | Value |
|---|---|
| Document version | v1.0 |
| Written | 2026-04-30 |
| Applies to | figma-reverse v2 (bidirectional round-trip — [SPEC-roundtrip.md](./SPEC-roundtrip.md)) |
| Sibling doc | [SDD.md](./SDD.md) (development methodology) |

---

## 1. Definition

> **Test Harness Engineering** = "the engineering activity of progressively moving what humans verify by hand into an automated harness."

Because bidirectional round-trip is this tool's core feature, **failing to automate verification carries a very high regression risk per change**. Every change is:

```
change → harness pass → merge
         ▲
         │ Automatically the harness:
         │  ① confirms preservation of 35,660 node GUIDs
         │  ② confirms tree-structure equivalence across 6 pages
         │  ③ confirms all 1,599 SVGs round-trip
         │  ④ confirms sha256 equality of 12 images
         │  ⑤ runs V-01~V-12 automatically
         └───────────────────────
```

**Iron Law**: "no change that bypasses the harness is merged for any reason."

---

## 2. Why a harness is required

| Concern | Frequency | Loss |
|---|---|---|
| repack mode drops a node (35,659 → 35,660) | Common on changes | Users receive a design with one missing node; hard to reproduce |
| HTML → message conversion loses some raw fields | Common on changes | Effects (e.g. blur) disappear after Figma import |
| Schema partly changes with a new Figma archive version | Rare | The tool itself stops working |
| GUID collision after user edits | Sometimes | The wrong node disappears or duplicates |
| Tiny byte-level differences in zstd decode results | Very rare | Decoded meaning is the same but sha differs |

With manual verification:
- You only get vague reports like "it looks weird in Figma"
- Cannot trace which stage broke it
- Cannot tell the change author "your change broke it" clearly

With a harness:
- Failures show **exactly which verification item failed in CI**
- The change author can see **which invariant their change breaks** before PR merge
- New contributors can trust that **passing the harness is safe**

---

## 3. Harness structure (5 layers)

### Layer 0 — Pure Unit Tests (instant, under 1s)

**Purpose**: verify function-level input → output mappings (no dependencies)

| Module | Test file | Items |
|---|---|---|
| `archive.ts` | `test/archive.test.ts` | fig-kiwi prelude validation, chunk split, corruption detection |
| `decompress.ts` | `test/decompress.test.ts` | deflate-raw / deflate-zlib / zstd auto-branch, fallback chain |
| `tree.ts` | `test/tree.test.ts` | parent-child tree build, position ordering, orphan handling |
| `assets.ts` | `test/assets.test.ts` | magic-based extension, hashToHex accuracy |
| `vector.ts` | `test/vector.test.ts` | commandsBlob decode (MOVE/LINE/CUBIC/QUAD/CLOSE) |
| `container.ts` | `test/container.test.ts` | ZIP / raw auto-branch |
| `editable-html.ts` ★v2 | `test/editable-html.test.ts` | Node → HTML element mapping |
| `html-to-message.ts` ★v2 | `test/html-to-message.test.ts` | HTML element → message patch |

**Bar**: 100% pass, runtime under 8 s, every branch covered.

### Layer 1 — Module Integration (within 10s)

**Purpose**: verify data flow between modules

| Integration scenario | Verification |
|---|---|
| `loadContainer` → `parseFigArchive` → `decodeFigCanvas` | 35,660 nodes decoded |
| `decodeFigCanvas` → `buildTree` → `getPages` | 6 pages (CANVAS) identified |
| `buildTree` → `extractVectors` (with blobs) | 1,599 SVGs produced |
| `decodeFigCanvas` → `buildByteLevelFigBuffer` → `decodeFigCanvas` (round-trip) | Node count · schema equal |
| `editable-html.ts` → `html-to-message.ts` (no edits) ★v2 | Message equal |

**Bar**: runs on the real sample (`docs/sample.fig`), under 10 s, PASS when there are no changes.

### Layer 2 — Round-trip Harness (★ core, within 30 s)

**Purpose**: verify invariants of the bidirectional conversion

```
original .fig
  ↓ extract
extracted/ (5+1 stage outputs)
  ↓ editable-html
figma.editable.html
  ↓ html-to-message (no edits)
new message
  ↓ kiwi.encodeMessage + compress + ZIP
new .fig
  ↓ extract (again)
extracted'/

Compare extracted vs extracted':
  - 01_container/canvas.fig equality ✅ (sha256 match in byte mode)
  - 04_decoded message.type equal (NODE_CHANGES)
  - 05_tree/nodes-flat.json: GUID set equal, node count equal
  - 04_decoded/schema.json: 568 definitions equal
  - assets/images/* equal
  - assets/vectors/* count equal
```

**Invariants** (expressed in code):

```typescript
// test/harness/roundtrip.harness.test.ts
describe('round-trip harness', () => {
  it('GUID set is identical after extract→html→fig→extract', () => {
    const a = guidsOf(extract(SAMPLE));
    const b = guidsOf(extract(htmlToFig(editableHtml(extract(SAMPLE)))));
    expect(symmetricDiff(a, b)).toEqual([]);
  });

  it('node tree shape preserved (parentGuid relationships)', () => {
    const a = treeShape(extract(SAMPLE));
    const b = treeShape(extract(htmlToFig(editableHtml(extract(SAMPLE)))));
    expect(b).toEqual(a);
  });

  it('image hashes preserved', () => {
    const a = imageHashes(extract(SAMPLE));
    const b = imageHashes(extract(htmlToFig(editableHtml(extract(SAMPLE)))));
    expect(b.sort()).toEqual(a.sort());
  });

  it('schema definitions preserved (568 types)', () => {
    expect(schemaDefCount(extract(htmlToFig(...)))).toBe(568);
  });
});
```

**Bar**: every invariant passes. Any single failure rejects the change.

### Layer 3 — Edit Simulation Harness (★ intentional transformations, within 30 s)

**Purpose**: automate "what if the user edited X" scenarios

| Edit scenario | Auto-transform rule | Verification |
|---|---|---|
| **E1. Bulk text replace** | Prefix every TEXT node's `innerText` with "TRANSLATED " | Every TEXT node's characters has the prefix after re-extract |
| **E2. Color swap** | Swap R · B channels of every SOLID fill | Every fill's r · b are swapped after re-extract |
| **E3. Translate position** | Shift every top-level frame's left by +100px | bbox.x is +100 |
| **E4. Double size** | Double the width/height of a specific node | size.x/y is doubled |
| **E5. Bulk opacity 0.5** | Set opacity = 0.5 on all nodes | raw.opacity = 0.5 |
| **E6. Delete node** | Remove one random leaf node from the DOM | phase=REMOVED appears in the message |
| **E7. Add node** ★late v2 | Add a new RECTANGLE | New GUID + auto parentIndex.position |

**Structure** (example):

```typescript
// test/harness/edit-sim.harness.test.ts
async function simulate(
  scenario: 'E1' | 'E2' | ...,
  applyEdit: (html: string) => string,
  invariant: (newExtract: ExtractResult) => void,
) {
  const original = extract(SAMPLE);
  const html = editableHtml(original);
  const editedHtml = applyEdit(html);
  const newFig = htmlToFig(editedHtml);
  const newExtract = extract(newFig);
  invariant(newExtract);
}

it('E1: bulk text replace', async () => {
  await simulate('E1',
    (html) => html.replace(/<p class="fig-text"([^>]*)>([^<]+)<\/p>/g, '<p$1>TRANSLATED $2</p>'),
    (e) => {
      const texts = textNodes(e);
      expect(texts.every((t) => t.characters.startsWith('TRANSLATED'))).toBe(true);
    });
});
```

### Layer 4 — Figma Compatibility (manual, minutes)

**Purpose**: confirm that Figma actually accepts the `.fig` we generate

Hard to automate (Figma is a GUI app and the import API is not published). **Manual checklist**:

| Item | Procedure | Pass criterion |
|---|---|---|
| F1. Import a byte-level repack of the original | Figma Desktop → Import → choose repacked.fig | Opens visually identical to the original |
| F2. Import a kiwi re-encoded result | Same | Node count · content identical |
| F3. Import an unedited editable.html → .fig | Same | Semantically equivalent to the original |
| F4. Import scenario E1 (text replace) → .fig | Same | Every text has the "TRANSLATED " prefix |
| F5. Import "add node" → .fig | Same | The new node is visible |

**Documentation**: write `.gstack/qa-reports/figma-import-{date}.md` with screenshots + PASS/FAIL.

CI automation is a v3 candidate (Figma plugin / headless environment).

---

## 4. Metrics

Quantify the harness results. Low metrics → reject the change.

### 4.1 GUID preservation rate (Identity Preservation)

```
identityRate = |source GUIDs ∩ result GUIDs| / |source GUIDs|
```

| Threshold | Policy |
|---|---|
| `1.0` | mergeable |
| `[0.99, 1.0)` | warning; must explicitly list the missing GUIDs (allowed only when deletion is intentional) |
| `< 0.99` | reject |

### 4.2 Tree-shape equality

```
shapeEqual = parent-child relation sets are equal
```

For each GUID, compare the set of `(self, parentGuid)` pairs. 100% equality is expected.

### 4.3 Visual fidelity (Pixel Diff, optional)

Compare `thumbnail.png` or per-page rendered images (browser render vs original). Best-effort in v2.

```
pixelDiffRate = (different pixels) / (total pixels)
```

| Threshold | Policy |
|---|---|
| `< 0.01` (99% identical) | PASS |
| `[0.01, 0.05)` | WARN |
| `>= 0.05` | INVESTIGATE |

### 4.4 Metadata preservation rate

Compare the raw-field key set of each node.

```
metaRate = avg(|source raw keys ∩ result raw keys| / |source raw keys|, over all nodes)
```

| Threshold | Policy |
|---|---|
| `>= 0.99` | mergeable |
| `[0.95, 0.99)` | warning |
| `< 0.95` | reject |

### 4.5 Schema preservation

```
schemaDefCount(result) === schemaDefCount(source)  // 568
schemaDefSet(result)   === schemaDefSet(source)    // set of definition names
```

100% match required.

---

## 5. Test datasets (fixtures)

### 5.1 Existing (v1)

- `docs/sample.fig` (5.77 MB, 35,660 nodes, 6 pages)

### 5.2 Recommended additions (v2)

Adding situational fixtures improves harness confidence:

| Fixture | Purpose | Priority |
|---|---|---|
| `fixtures/minimal.fig` | DOCUMENT + 1 CANVAS + 1 RECTANGLE only | 🟢 high (quick debugging) |
| `fixtures/text-heavy.fig` | 100+ TEXT nodes (localization scenarios) | 🟢 high |
| `fixtures/vector-heavy.fig` | VECTOR + varied commandsBlob | 🟡 medium |
| `fixtures/components.fig` | SYMBOL + INSTANCE | 🟡 medium |
| `fixtures/effects.fig` | drop-shadow / blur / gradient | 🟢 high (loss-prone areas during edits) |

Each fixture must be **free-to-use or self-authored** (licensing).

### 5.3 Synthetic fixtures with no external dependency

A minimal `.fig` that can be synthesized inside a test:

```typescript
// test/fixtures/synth.ts
export function synthMinimalFig(): Uint8Array {
  // synthesize a .fig in code
  // - reuse the schema from a sample
  // - DOCUMENT + 1 CANVAS + 1 RECTANGLE only
  // - deterministic GUIDs (reproducible)
}
```

This enables real `.fig` synthesis + decode even in Layer 0 unit tests.

---

## 6. CI integration

### 6.1 GitHub Actions workflow (proposed)

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - name: Type check
        run: npm run typecheck
      - name: Layer 0 unit
        run: npm test
      - name: Layer 2 round-trip
        run: npm run harness:roundtrip
      - name: Layer 3 edit simulation
        run: npm run harness:edit-sim
      - name: Coverage
        run: npm run coverage
        if: always()
```

### 6.2 Output format on failure

```
🔴 Round-trip harness FAILED

Invariant: GUID set is identical
  Expected: 35,660 GUIDs
  Got:      35,659 GUIDs (1 missing)

Missing GUIDs:
  - 627:8805 (VECTOR, "icon-arrow")

This means a node was lost during the round-trip.
Likely cause: html-to-message.ts skipped fig-vector elements without commandsBlob fallback.

Steps to reproduce:
  npm run harness:roundtrip

Last known PASS: commit abc123 (2026-04-29)
Bisect candidates: commits def456..ghi789 changed src/html-to-message.ts
```

Output like this tells change authors immediately where to look.

### 6.3 Performance tracking

Record each harness run's duration:

```
hardness/perf-history.jsonl
{"ts":"2026-04-30T...", "layer":"L2", "duration_ms":18200, "pass":true}
{"ts":"2026-05-01T...", "layer":"L2", "duration_ms":24500, "pass":true} ← regression!
```

A slowdown ≥10% triggers a warning comment on the PR.

---

## 7. Regression-prevention policy (Iron Law)

| Situation | Action |
|---|---|
| Even one harness FAILs | merge forbidden |
| Author intentionally changes an invariant (e.g. node tree shape) | Update the invariant + explicit reviewer approval + CHANGELOG entry |
| New feature added without a new harness | merge forbidden (SDD policy) |
| Skip the harness because it's slow | Absolutely forbidden (shrink the fixture for speed instead) |

**Exception handling**: for truly urgent security patches, use the `--bypass-harness` flag with direct user confirmation (CI fires a separate alert).

---

## 8. Operations (daily workflow)

### 8.1 Developer flow

```
1. Write the change
2. Local: npm test (L0+L1, ~10s)
3. Local: npm run harness:roundtrip (L2, ~20s)
4. Pass → open PR
5. CI: L0~L3 run automatically
6. All pass → review → merge
7. Periodically (once a month): run L4 (Figma manual import); refresh the report
```

### 8.2 New-feature flow (combined with SDD — see [SDD.md](./SDD.md))

```
1. Write the spec (docs/specs/<feature>.md)
2. Capture invariants in the spec
3. Express invariants as code (test/harness/<feature>.harness.test.ts)
4. Run the test → fails (as expected, unimplemented)
5. Implement
6. Re-run the test → passes
7. PR
```

---

## 9. Reuse of existing vitest

vitest was already introduced in [SPEC.md](./SPEC.md) v1 (`test/` with 8 files, 62 tests). This harness is **built on top of vitest**:

- L0 unit → existing `test/*.test.ts` (extended)
- L1 integration → existing `test/e2e.test.ts` (extended)
- L2 round-trip → new `test/harness/roundtrip.harness.test.ts`
- L3 edit sim → new `test/harness/edit-sim.harness.test.ts`
- L4 Figma → manual (`.gstack/qa-reports/figma-import-*.md`)

Add the harness directory pattern in `vitest.config.ts`:

```typescript
test: {
  include: ['test/**/*.test.ts', 'test/harness/**/*.harness.test.ts'],
  testTimeout: 60_000,
  ...
}
```

`package.json` scripts:

```json
{
  "test": "vitest run test",
  "test:unit": "vitest run test --exclude 'test/harness/**'",
  "harness:roundtrip": "vitest run test/harness/roundtrip.harness.test.ts",
  "harness:edit-sim": "vitest run test/harness/edit-sim.harness.test.ts",
  "harness:all": "vitest run test/harness"
}
```

---

## 10. Appendix — quick reference

```
Harness command summary
─────────────────────────────────────
npm run test:unit         L0 unit (8s)
npm test                  L0 + L1 (10s)
npm run harness:roundtrip L2 (20s)
npm run harness:edit-sim  L3 (30s)
npm run harness:all       L2 + L3 (50s)

Manual (once a month)
write .gstack/qa-reports/figma-import-{date}.md
```

---

Generated by figma-reverse · v2 harness specification
