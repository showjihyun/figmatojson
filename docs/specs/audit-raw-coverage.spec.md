# spec/audit-raw-coverage

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/scripts/audit-raw-coverage.mjs` (raw field coverage), `web/scripts/audit-properties-coverage.mjs` (component / variable properties) |
| Output | `docs/audit-raw-coverage/<fixture>/coverage.json`, `properties.json` |
| Siblings | `audit-harness.spec.md` (the 3 Phase-1 baseline scripts), `audit-oracle.spec.md` (plugin oracle comparison) |

## 1. Goal

The existing 3 audit-harness scripts (`audit-roundtrip.mjs` byte comparison,
`audit-roundtrip-canvas-diff.mjs` field-walk diff, `audit-rest-as-plugin.mjs`
plugin oracle) all observe either *round-trip* or *external oracle*
comparisons. What they do not measure is **which wire-format fields inside
the raw kiwi message our parser/exporter never uses, or which field values
are lost in the JSON serialization step.**

The two scripts in this spec fill that gap:

1. **`audit-raw-coverage.mjs`** — enumerates every raw field of every node
   and verifies it reaches the JSON serialization / client `documentJson`.
   The output highlights *wire-format fields that silently disappear*.
2. **`audit-properties-coverage.mjs`** — validates consistency of
   `componentPropDefs` / `componentPropAssignments` / VARIABLE's
   `variableDataValues`. The output highlights *broken / orphan cases of
   design-system metadata*.

Both scripts are *measurement tools* — any issues they surface are fixed in
follow-up rounds. This round only produces baselines.

## 1.1 Baseline (round 17.2 — 2026-05-06)

| Fixture | raw nodes | client nodes | presentBoth | lostUnexp | extraUnexp | serializationFailures |
|---|---|---|---|---|---|---|
| bvp | 3,155 | 4,968 | 1,406 | **0** | 52 | **0** |
| meta-rich | 35,660 | 64,902 | 1,855 | **0** | 88 | **0** |

| Fixture | propDefs | propDefs orphan | propAssignments | propAssignments broken | VARIABLEs | broken chains |
|---|---|---|---|---|---|---|
| bvp | 308 | 275 | 21 | **0** | 138 | 50 (capped) |
| meta-rich | 96 | 59 | 2,056 | **0** | 82 | 6 |

Key findings:
- **lost-unexpected = 0** — every raw wire-format field is carried into the
  client doc by `toClientNode`. Zero raw fields are silently dropped by the
  parser.
- **JSON serialization failures = 0** — zero BigInt / function / cycle /
  undefined cases. documentJson serialization is 100% safe.
- **broken propAssignments = 0** — every INSTANCE
  `componentPropAssignment` matches a master `componentPropDef`. *Struct
  level* design-system metadata consistency is OK.
- **extra-unexpected** ~50–88 — master-inherited fields on INSTANCE nodes
  (publishID, isSymbolPublishable, variantPropSpecs[]…). These are not
  truly synthesized; INSTANCE itself carries them on the wire, and our
  EXPECTED_LOSS_KEYS / SYNTH classification likely failed to capture the
  pattern. A later round decides whether to extend the expected list.
- **propDefs orphan** 275 / 59 — defined but never used in any
  INSTANCE/SYMBOL assignment. **Figma designer intent** — when only
  surfaced as an "available property" in the UI, that is normal, not a
  parser bug.
- **VARIABLE broken chains** bvp 50+ / meta-rich 6 — alias chain terminates
  in a dead-end or cycle. Re-measure after a separate round lands a
  deep-resolve policy + audit fix.

## 2. Common environment (same as audit-harness.spec.md §2)

- I-E1 The web backend must be running on `:5274`
  (`cd web && npm run dev:server`). Both scripts upload a fixture via
  POST `/api/upload` and receive `sessionId` + `documentJson`.
- I-E2 Output root = `docs/audit-raw-coverage/<basename(fixture, '.fig')>/`.
- I-E3 Default fixtures = `['docs/bvp.fig', 'docs/meta-rich-ui-design.fig']` (the meta-rich screen UI design fixture).
  N override paths (absolute or repo-relative) can be passed as CLI args.
- I-E4 NaN equality rule (same as audit-oracle.spec.md §I-A14).
- I-E5 Per-fixture try/catch — one file failing does not block the rest.
  The exit code is 1 only for the main exception.
- I-E6 Output is excluded from `git` tracking (extend the
  `docs/audit-roundtrip/` pattern in `.gitignore` to also cover
  `docs/audit-raw-coverage/`). Results are *measurement artifacts*, not
  production output.

## 3. `audit-raw-coverage.mjs` — Wire-format coverage

### 3.1 Flow

- I-R1 Send fixture bytes via `POST /api/upload` → response
  `{ sessionId, … }`.
- I-R2 Same sessionId, `GET /api/doc/:id` → `documentJson` (entire tree).
  Separately, to compare against server-side raw
  `decodeFigCanvas(...).message`, decode the fixture bytes through
  *client-side* `decodeFigCanvas` directly (web backend not involved, via
  `dist/decoder.js`).
- I-R3 Truth source = `decodeFigCanvas`'s `message.nodeChanges` (raw kiwi
  nodes array); comparison subject = the client view in `documentJson`.

### 3.2 Field walk

- I-R4 `walkRawFields(node)` generator — yields every own enumerable key of
  a node object along with its path. Nested objects/arrays recurse.
  `Uint8Array` is marked as a `<bytes>` leaf (no recursion).
- I-R5 Path normalization: `fieldKey(path)` = `path.replace(/\[\d+\]/g, '[]')`.
  Both `nodeChanges[42].size.x` and `nodeChanges[1280].size.x` aggregate to
  the same field key.
- I-R6 Counts accumulate per (node type, field). Result:
  `byTypeAndField[<type>][<fieldKey>] = count`.

### 3.3 Coverage classification

Each (type, field) pair is classified into one of 4 statuses:

- I-R7 `present-in-both` — exists in both raw and documentJson (field
  currently carried correctly).
- I-R8 `lost-in-client` — present in raw, absent in documentJson. *A field
  our toClientNode drops*. Known drop rules (`derivedSymbolData`,
  `fillGeometry`, `strokeGeometry`, `vectorData`, `Uint8Array`,
  `guid`/`type`/`name`) are labeled *expected loss*; the rest are
  classified *unexpected loss*.
- I-R9 `extra-in-client` — present in documentJson, absent in raw (= fields
  synthesized by toClientNode: `_path`, `_pathOffset`, `_pathScale`,
  `_renderChildren`, `_componentTexts`, `_isInstanceChild`, …). Labeled
  *expected synthesis*; the rest are *unexpected synthesis*.
- I-R10 `serialization-failure` — raw value throws or returns `undefined`
  under `JSON.stringify`. Cases: circular reference, `BigInt`, `function`,
  undefined-only object. On first encounter, record one sample + path +
  reason.

### 3.4 Output schema (`coverage.json`)

```ts
{
  fixture:       string;
  origBytes:     number;
  rawNodes:      number;        // message.nodeChanges.length
  clientNodes:   number;        // traversal count over documentJson (children + _renderChildren)
  expectedLossRules:   string[]; // names of known drop rules in I-R8
  expectedSynthRules:  string[]; // synthesis prefixes (_xxx) in I-R9
  summary: {
    totalFields:               number; // distinct (type, field) pairs in raw
    presentBoth:               number;
    lostExpected:              number;
    lostUnexpected:            number;
    extraExpected:             number;
    extraUnexpected:           number;
    serializationFailures:     number;
  };
  byType: Record<string, {
    nodeCount: number;
    presentBoth:        Array<[fieldKey, count]>;     // sorted desc by count
    lostExpected:       Array<[fieldKey, count, rule]>;
    lostUnexpected:     Array<[fieldKey, count]>;
    extraExpected:      Array<[fieldKey, count]>;
    extraUnexpected:    Array<[fieldKey, count]>;
  }>;
  serializationFailures: Array<{ path, reason, sampleType }>;  // up to 50
}
```

- I-R11 Lists like `presentBoth` / `lostExpected` are sorted count desc and
  carry only the top 30. The *full distribution* can be inferred from
  byType's nodeCount.
- I-R12 `serializationFailures` carries the first 50 in discovery order —
  sampling only; distribution signal is in summary.

### 3.5 Reporting (console)

- I-R13 stdout prints a one-line per-fixture summary plus top-3 unexpected
  loss / unexpected synthesis.
- I-R14 `coverage.json` is excluded from git (I-E6); we emit to both
  console and disk. Fix work reads from disk.

## 4. `audit-properties-coverage.mjs` — Component & variable properties

### 4.1 Target data

- I-P1 Component property defs: the `componentPropDefs[]` array on nodes
  with type SYMBOL / COMPONENT_SET / FRAME (with `isStateGroup === true`)
  / any node where `componentPropDefs.length > 0`. Entry shape (measured
  on meta-rich 5:9 "Button"):
  `{ id: { sessionID, localID }, name, type ('BOOL'|'INSTANCE_SWAP'|'TEXT'|'VARIANT'), initialValue, sortPosition, varValue?, … }`.
  **Note**: `id` is a GUID object, not the `propRef.id` shape assumed in
  the first audit draft (round 17.0). Round 17.1 corrected this — extract
  guidStr, then match `def.id` with `assignment.defID` GUIDs.
- I-P2 Component property assignments: a node's (typically INSTANCE)
  `componentPropAssignments[]` or `componentPropertyAssignments[]` (schema
  variant). Entry shape (measured):
  `{ defID: { sessionID, localID }, value: {}, varValue?: { value, dataType, resolvedDataType } }`.
  Match rule: `assignment.defID === def.id` (GUID equality).
- I-P3 Variable data values: the VARIABLE node's `variableDataValues.entries[]`.
  Entry shape: `{ modeID, variableData: { value, dataType, resolvedDataType } }`.

### 4.2 Invariant checks

- I-P4 **propAssignment.propRef.id** must match one of the
  `componentPropDefs[].propRef.id` on an ancestor (the nearest component
  master). No match → classified as `broken-assignment`.
- I-P5 **componentPropDef** that is defined but never used by any
  INSTANCE/SYMBOL assignment → `orphan-def` (the user defined it but did
  not use it — may be normal, but it is a signal).
- I-P6 **VARIABLE.variableDataValues** where the alias guid refers to
  another VARIABLE (round 15's deep chain) — check that the chain
  resolves to the end; if it loops or dead-ends, classify as
  `broken-variable-chain`.
- I-P7 **VARIABLE_SET** node's `localVariables[]` (or schema variant)
  references VARIABLEs that cannot be found in the tree →
  `dangling-variable-ref`.

### 4.3 Output schema (`properties.json`)

```ts
{
  fixture: string;
  summary: {
    componentPropDefsTotal:     number;
    componentPropDefsOrphan:    number;
    propAssignmentsTotal:       number;
    propAssignmentsBroken:      number;
    variablesTotal:             number;
    variableChainsBroken:       number;
    danglingVariableRefs:       number;
  };
  brokenAssignments:    Array<{ instanceId, propRefId, ancestorId? }>;  // top 50
  orphanDefs:           Array<{ masterId, propRefId, type }>;            // top 50
  brokenVariableChains: Array<{ variableId, chainHeads, dataType }>;      // top 50
  danglingVariableRefs: Array<{ setId, refs }>;                          // top 50
}
```

### 4.4 Reporting

- I-P8 stdout prints per-fixture summary + top-3 broken assignment /
  orphan def. File is also emitted.

## 5. Out of scope

- ❌ *Fixing* the missing / broken cases discovered. This round is
  measurement only — fixes live in later rounds (round 18+).
- ❌ Field-by-field equality (already covered by
  `audit-roundtrip-canvas-diff.mjs`).
- ❌ Wire-format schema validation against kiwi schema definitions. Schema
  validation itself is separate.
- ❌ Coverage over effect / paint bodies (gradient stops, image hash).
  Handled in round 15.

## 6. Operations

- I-O1 Optional `web/package.json` script entries:
  `"audit:raw": "node scripts/audit-raw-coverage.mjs"`,
  `"audit:props": "node scripts/audit-properties-coverage.mjs"`. The MVP
  for this round runs `node ...mjs` directly.
- I-O2 Baseline cadence: run once after each round merge — regression
  signal when a new round introduces new unexpected loss. Comparisons are
  done by a human via git stash / disk.

## 7. References

- `audit-harness.spec.md` — Phase 1 baseline (the 3 existing scripts);
  this round adds 2 on top.
- `audit-oracle.spec.md §5.4 VALUE_ALIASES` — schema rename example
  (R12-D). If raw coverage surfaces a similar pattern, update this spec.
- `web/scripts/audit-roundtrip-canvas-diff.mjs` — reuses the `walkDiff` /
  `fieldKey` / `aggregateDiffs` patterns.
