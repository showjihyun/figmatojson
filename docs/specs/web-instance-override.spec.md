# spec/web-instance-override

| Item | Value |
|---|---|
| Status | Approved (Phase 7) |
| Implementation | `web/core/application/OverrideInstanceText.ts` |
| Tests | `web/core/application/OverrideInstanceText.test.ts` |

## 1. Purpose

Make the text inside a specific INSTANCE node display differently for that instance only. The master (original component) text and other instances are unaffected — equivalent to Figma's "change text for this instance only" UX.

## 2. Input / Output

```ts
input = {
  sessionId: string,
  instanceGuid: string,      // GUID of the INSTANCE node
  masterTextGuid: string,    // GUID of the TEXT node inside that INSTANCE's master
  value: string,             // new text
}
output = { ok: true }
```

## 3. Invariants

- I-1 The INSTANCE's `symbolData.symbolOverrides[]` contains the following entry (push if absent, update in-place if present):
  ```
  { guidPath: { guids: [{sessionID, localID}] },     // masterTextGuid 1-step path
    textData: { characters: value, lines: [PLAIN line]}}
  ```
- I-2 The master text node's (`masterTextGuid`) `textData.characters` is not modified
- I-3 The textData of other INSTANCEs referencing the same master is not modified (per-instance override)
- I-4 `_instanceOverrides[masterTextGuid] = value` is added to the INSTANCE node in the in-memory documentJson, so the Inspector's ComponentTextRow immediately shows the override

## 4. Error cases

- Session not found → `NotFoundError`
- INSTANCE not found → `NotFoundError(\`INSTANCE \${id} not found\`)`
- `masterTextGuid` not in `<num>:<num>` format → `ValidationError`

## 5. Out of scope

- Multi-level nested INSTANCEs (PoC: single-step guidPath only)
- Field overrides other than text (font / color)
- Removing overrides (the caller can re-call with the master value; an empty-string override is also valid)

## 6. Routing coupling

`POST /api/instance-override/:id`. body = `{instanceGuid, masterTextGuid, value}`.
