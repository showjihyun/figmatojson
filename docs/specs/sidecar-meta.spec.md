# spec/sidecar-meta

| Item | Value |
|---|---|
| Status | Approved (Iteration 10) |
| Responsible module | `src/sidecar-meta.ts` (new) |
| Dependencies | `src/decoder.ts`, `src/tree.ts`, `src/assets.ts::hashToHex` |
| Tests | `test/sidecar-meta.test.ts` |
| Parent SPEC | [SPEC-roundtrip §3.5 Tier B, §3.6](../SPEC-roundtrip.md) |

## 1. Purpose

Generate a sidecar file (`figma.editable.meta.js`) that represents the raw fields of every node as user-editable JSON. **Fields represented in HTML as Tier A are also carried in the sidecar** (HTML takes precedence, but the sidecar is the ground truth).

## 2. Inputs

```ts
interface SidecarMetaInputs {
  decoded: DecodedFig;            // schema, message, archive version, sha256
  tree: BuildTreeResult;          // node GUID index
  outputDir: string;              // output location for assets/blobs/
  options?: {
    blobInlineThresholdBytes?: number;  // default 1024 — small blobs are inlined as hex, large ones are file-referenced
    nodesPerFile?: number;        // default 0 (single file). >0 splits into nodes-by-page/<n>.js
  };
}
```

## 3. Output

Directory mode:
```
<htmlOutDir>/figma.editable.meta.js
or (when split):
<htmlOutDir>/figma.editable.meta.js     ← __meta + message only
<htmlOutDir>/data/nodes-page-00.js      ← page 0 nodes
<htmlOutDir>/data/nodes-page-01.js
...
```

`figma.editable.meta.js` content format:

```javascript
window.FIGMA_RAW = {
  __meta: {
    archiveVersion: 106,
    schemaSha256: "b82dafbd...",
    sourceFigSha256: "de8f66cc...",
    rootMessageType: "NODE_CHANGES",
    generator: "figma-reverse v2.0",
    generatedAt: "2026-04-30T..."
  },
  message: { type: "NODE_CHANGES", sessionID: 0, ackID: 0 },
  nodes: { /* GUID → raw object */ },
  blobs: [ /* commandsBlob, etc. */ ]
};
```

Large blobs are separated into `assets/blobs/<idx>.bin` and referenced as `{ ref: "assets/blobs/<idx>.bin", bytes: N }`.

## 4. Invariants

### I-1 All nodes preserved

```
∀ node ∈ tree.allNodes:
   FIGMA_RAW.nodes[node.guidStr] !== undefined
   ∧ the raw key set is equivalent to the corresponding node in the original message.nodeChanges (excluding Tier C)
```

### I-2 Uint8Array → hex string (lossless)

```
∀ field ∈ raw, type(field) === Uint8Array:
   typeof FIGMA_RAW.nodes[guid][field] === 'string'
   ∧ Buffer.from(value, 'hex').equals(original Uint8Array)
```

### I-3 BigInt → string preservation

```
∀ field ∈ raw, type(field) === BigInt:
   typeof FIGMA_RAW.nodes[guid][field] === 'string'
   ∧ BigInt(value) === original BigInt
```

### I-4 Tier C fields excluded

The following fields are not included in the sidecar (determined automatically by HTML or the tool):
- `guid` (or `{sessionID, localID}`) — duplicates the key, which is the GUID
- `parentIndex` — determined by DOM structure
- `phase` — the tool sets CREATED/REMOVED automatically

```
FIGMA_RAW.nodes[guid].guid === undefined
FIGMA_RAW.nodes[guid].parentIndex === undefined
FIGMA_RAW.nodes[guid].phase === undefined
```

### I-5 Tier A field sync (HTML wins)

Fields represented in HTML (e.g. size, transform, fillPaints) are also in the sidecar. On conversion, **HTML values win**; the sidecar is the fallback.

```
∀ guid:
  htmlValue !== undefined ⇒ result = htmlValue
  htmlValue === undefined ⇒ result = sidecarValue
```

(This invariant is the responsibility of [html-to-message.spec.md](./html-to-message.spec.md).)

### I-6 Blob index stability

The index `i` in `FIGMA_RAW.blobs[i]` matches the index in the original message.blobs. Node references like `commandsBlob: 203` remain valid as-is.

```
∀ i ∈ [0, blobs.length):
   blobs[i].hex or blobs[i].ref → equivalent to original message.blobs[i].bytes
```

### I-7 Inline vs ref threshold

```
∀ blob i:
   blob.bytes ≤ options.blobInlineThresholdBytes:
     blobs[i] === { hex: <hex string> }
   blob.bytes > threshold:
     blobs[i] === { ref: "assets/blobs/<padded i>.bin", bytes: N }
     ∧ <htmlOutDir>/assets/blobs/<padded i>.bin file exists (raw bytes)
```

### I-8 Determinism

Same input → same sidecar JSON (apart from the timestamp field).

### I-9 Format safety (HTML embed compatibility)

The `</script>` sequence is automatically escaped (`<\/script>`). The sidecar will not break even if the user places that sequence in the raw data.

## 5. Error Cases

- E-1: Node raw object serialization failure (cycle, etc.) → throw `Error("sidecar: cyclic reference at <guid>")`
- E-2: Gap in blob indices (e.g. 0,1,3) → fill missing indices with `null` to keep array index stability
- E-3: No write permission for `outputDir` → throw (propagate fs error)

## 6. Out of Scope

- O-1: HTML generation — [editable-html.spec.md](./editable-html.spec.md)
- O-2: HTML → message conversion — [html-to-message.spec.md](./html-to-message.spec.md)
- O-3: Semantic decoding of blobs (commandsBlob → SVG path, etc.) — responsibility of `vector.ts` (edits happen in SVG; the sidecar only preserves raw)
- O-4: Schema validation for user edits — owned by html-to-message
- O-5: Lazy-load code for per-node splitting (`data/nodes-page-N.js` split) — responsibility of the HTML/JS side

## 7. References

- Parent: [SPEC-roundtrip §3.6](../SPEC-roundtrip.md)
- Data format example: the `figma.editable.meta.js` structure block in [SPEC-roundtrip §3.6](../SPEC-roundtrip.md)
- Siblings: [editable-html.spec.md](./editable-html.spec.md), [html-to-message.spec.md](./html-to-message.spec.md)
