# spec/round-trip-invariants

| Item | Value |
|---|---|
| Status | Approved (Iteration 10) |
| Owner | The harness that validates this spec's invariants in code — `test/harness/roundtrip.harness.test.ts` |
| Dependencies | All other specs (editable-html, sidecar-meta, html-to-message, text-segments, parent-index-position) |
| Parent SPEC | [SPEC-roundtrip §8](../SPEC-roundtrip.md) · [HARNESS.md L2](../HARNESS.md) |

## 1. Goal

This spec is a **catalog of the invariants that must hold across a bidirectional round-trip**. Each invariant is expressed in code through [HARNESS.md](../HARNESS.md)'s Layer 2 automated checks.

> "If even one of these invariants breaks, v2 round-trip is a failure." — Iron Law

## 2. Cycle under validation

```
source .fig
  ↓ (1) extract → tree, decoded, container, output/
  ↓ (2) editable-html → figma.editable.html
  ↓ (3) sidecar-meta → figma.editable.meta.js
  ↓ (4) [no edits] html-to-message → new message
  ↓ (5) repack (kiwi mode) → new .fig
  ↓ (6) extract → tree', decoded', container'
  ↓ (7) compare(tree, tree') → validate invariants
```

Each step has its own spec; this spec is the explicit set of invariants for **(7) compare**.

## 3. Core invariants

### I-1 GUID set equality (Identity Preservation)

```ts
const a = new Set([...tree.allNodes.keys()]);
const b = new Set([...tree2.allNodes.keys()]);
expect(symmetricDifference(a, b)).toEqual(new Set());
```

- All 35,660 GUIDs appear after the round-trip
- Loss rate 0%

### I-2 Parent-child relationship equality (Tree Shape)

```ts
function shape(t: BuildTreeResult): Map<string, string | null> {
  return new Map([...t.allNodes.values()].map(n => [
    n.guidStr,
    n.parentGuid ? guidKey(n.parentGuid) : null
  ]));
}
expect(shape(tree2)).toEqual(shape(tree));
```

- Each node's parent GUID is identical

### I-3 Sibling order equality (Sibling Order)

```ts
function siblingOrder(t: BuildTreeResult): Map<string, string[]> {
  const m = new Map();
  for (const n of t.allNodes.values()) {
    m.set(n.guidStr, n.children.map(c => c.guidStr));  // children are already position-sorted
  }
  return m;
}
expect(siblingOrder(tree2)).toEqual(siblingOrder(tree));
```

- Order of children under the same parent is identical

### I-4 Schema definitions preserved

```ts
expect(decoded2.schemaStats.definitionCount).toBe(decoded.schemaStats.definitionCount);
expect(definitionNames(decoded2.schema)).toEqual(definitionNames(decoded.schema));
```

- All 568 definitions preserved
- Definition-name sets are equal

### I-5 Archive version preserved

```ts
expect(decoded2.archiveVersion).toBe(decoded.archiveVersion);
```

- v106 → v106

### I-6 message rootType preserved

```ts
expect(decoded2.message.type).toBe(decoded.message.type);
expect(decoded2.message.type).toBe('NODE_CHANGES');
```

### I-7 Image hash preserved

```ts
const a = new Set([...container.images.keys()]);
const b = new Set([...container2.images.keys()]);
expect(b).toEqual(a);

// Per-image byte equality (sha256)
for (const hash of a) {
  const sha1 = sha256(container.images.get(hash));
  const sha2 = sha256(container2.images.get(hash));
  expect(sha1).toBe(sha2);
}
```

### I-8 Vector count preserved

```ts
const v1 = countVectorNodes(tree);
const v2 = countVectorNodes(tree2);
expect(v2).toBe(v1);  // 1599
```

### I-9 Per-node raw key set equality (Tier C excluded)

The set of raw field keys of each node is equal after the round-trip (although `parentIndex.position` is recomputed and may have different values, the key itself is preserved).

```ts
const TIER_C = new Set(['guid', 'parentIndex', 'phase']);

for (const guid of guids) {
  const original = rawKeys(tree.allNodes.get(guid)!.data);
  const restored = rawKeys(tree2.allNodes.get(guid)!.data);
  
  const o = original.filter(k => !TIER_C.has(k));
  const r = restored.filter(k => !TIER_C.has(k));
  expect(new Set(r)).toEqual(new Set(o));
}
```

(Simplification: validates preservation of every Tier A · B raw field.)

### I-10 Byte-level equality of visual core fields per node

Visual core fields (size, transform, fillPaints, cornerRadius) are byte-equal.

```ts
const VISUAL_FIELDS = ['size', 'transform', 'fillPaints', 'strokePaints',
                       'cornerRadius', 'cornerRadii', 'opacity', 'visible',
                       'effects', 'blendMode'];

for (const guid of guids) {
  for (const field of VISUAL_FIELDS) {
    const a = (tree.allNodes.get(guid)!.data as any)[field];
    const b = (tree2.allNodes.get(guid)!.data as any)[field];
    expect(b).toEqual(a);  // deep equal
  }
}
```

### I-11 TEXT segments preserved

```ts
for (const node of textNodes(tree)) {
  const a = node.data;
  const b = tree2.allNodes.get(node.guidStr)!.data;
  expect(b.characters).toBe(a.characters);
  expect(b.characterStyleIDs).toEqual(a.characterStyleIDs);
  expect(b.styleOverrideTable).toEqual(a.styleOverrideTable);
}
```

### I-12 Sidecar (Tier B) field preservation

The following Tier B fields are byte-equal:

```ts
const TIER_B_FIELDS = ['layoutGrids', 'interactions', 'componentPropertyDefinitions',
                       'componentPropertyReferences', 'variantProperties',
                       'pluginData', 'sharedPluginData', 'mainComponent',
                       'overrides', 'handoffStatusMap', 'connectorStart',
                       'connectorEnd', 'transitionInfo', 'transitionDuration'];

for (const guid of guids) {
  for (const field of TIER_B_FIELDS) {
    const a = (tree.allNodes.get(guid)!.data as any)[field];
    const b = (tree2.allNodes.get(guid)!.data as any)[field];
    expect(b).toEqual(a);
  }
}
```

### I-13 Determinism

Same input → same output (run the sequence 5 times).

```ts
const results = Array(5).fill(0).map(() =>
  sha256(roundTrip(SAMPLE).new_fig_bytes)
);
expect(new Set(results).size).toBe(1);
```

### I-14 Schema sha256 equality

```ts
const a = sha256(decoded.rawSchemaBytes);
const b = sha256(decoded2.rawSchemaBytes);
expect(b).toBe(a);
```

(Because we do not modify the schema.)

### I-15 Verification report PASS

The existing V-01 to V-08 + the new V-09 to V-15 all PASS.

```ts
const verify = runVerification({...});
expect(verify.overall).toBe('PASS');
```

## 4. Edit-scenario invariants (Layer 3)

I-1 through I-15 cover **round-trip with no edits**. Additional invariants for user-edit scenarios:

### EI-1 Text replacement (E1)

```
htmlEdit: prepend "PREFIX " to the innerText of every <p class="fig-text">
roundTrip → new .fig

invariant: ∀ TEXT node:
   new.characters.startsWith("PREFIX ")
   ∧ new.characters.length === old.characters.length + length of "PREFIX "
```

### EI-2 Color swap (E2)

```
htmlEdit: swap R↔B of every background-color rgb

invariant: ∀ SOLID fill:
   new.color.r === old.color.b
   ∧ new.color.b === old.color.r
   ∧ new.color.g === old.color.g
   ∧ new.color.a === old.color.a
```

### EI-3 Coordinate translation (E3)

```
htmlEdit: top-level frame's left += 100

invariant: top-level frame's transform.m02:
   new.m02 === old.m02 + 100
```

### EI-4 Size doubled (E4)

```
htmlEdit: a specific node's width, height doubled

invariant: that node's size:
   new.size.x === old.size.x * 2
   new.size.y === old.size.y * 2
```

### EI-5 effects added (sidecar edit, Tier B)

```
sidecarEdit: add a new DROP_SHADOW to the node's raw.effects

invariant: that node's effects:
   new.effects.length === old.effects.length + 1
   ∧ new.effects[-1] is DROP_SHADOW
```

### EI-6 Node deletion (E6)

```
htmlEdit: remove <div data-figma-id="X">

invariant:
  ∃ nc ∈ new message.nodeChanges:
    nc.guid.string === "X" ∧ nc.phase === 'REMOVED'
  ∧ All children of "X" also have phase REMOVED
```

### EI-7 Rich text segment change (E7, D-5)

```
htmlEdit: add <span data-style-id="1"> (new style)

invariant: on the TEXT node:
   new.styleOverrideTable contains the new ID
   ∧ new.characterStyleIDs[character range] === new ID
```

## 5. Metric thresholds (Layer 2 pass criteria)

| Metric | Threshold | Policy |
|---|---|---|
| GUID preservation rate | 1.0 | < 1.0 → reject |
| Tree shape equality | 100% | unequal → reject |
| Schema definition preservation rate | 1.0 | < 1.0 → reject |
| Visual field equality (I-10) | 100% | unequal → reject |
| Tier B field equality (I-12) | ≥ 0.99 | < 0.99 → warning |
| Determinism | 1.0 | varies → reject |

## 6. Run commands

```bash
# Layer 2 round-trip (no edits)
npm run harness:roundtrip

# Layer 3 edit simulation
npm run harness:edit-sim

# Both
npm run harness:all
```

Each command runs `test/harness/<name>.harness.test.ts`. On failure, the violated invariant is named explicitly.

## 7. Output format (on failure)

```
🔴 Round-trip harness FAILED

Invariant: I-1 GUID set is identical
  Original GUIDs: 35,660
  Restored GUIDs: 35,659 (1 missing)

Missing GUIDs:
  - 627:8805 (VECTOR, "icon-arrow")

Hint: Check whether html-to-message.ts handles the fig-vector element.
References:
  - spec/round-trip-invariants.md#i-1-guid-set-equality
  - spec/html-to-message.md#i-1-100-guid-preservation
```

## 8. References

- Parent: [HARNESS.md](../HARNESS.md), [SPEC-roundtrip.md §8](../SPEC-roundtrip.md).
- Methodology: every other spec.
