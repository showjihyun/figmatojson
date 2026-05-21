# spec/web-export-fig

| Item | Value |
|---|---|
| Status | Approved (Phase 7) |
| Implementation | `web/core/application/ExportFig.ts` + `web/server/adapters/driven/KiwiCodec.ts` |
| Tests | `web/core/application/ExportFig.test.ts` |

## 1. Purpose

Repack the session's current edit state into `.fig` bytes that Figma can import. JSON-mode repack — re-encode message.json with kiwi and bundle the sidecar (`01_container/*`) into the ZIP as-is.

## 2. Input / Output

```ts
input  = { sessionId: string }
output = {
  bytes: Uint8Array,
  origName: string,                                  // for download Content-Disposition
  filesReport: Array<{name: string, bytes: number}>, // round-trip diagnostics
}
```

## 3. Invariants

- I-1 ExportFig is *implicitly save + export* — `sessionStore.flush(sessionId)` is invoked explicitly immediately before `repack`. The user does not need to press a separate Save button. All `EditNode` / `ResizeNode` / `OverrideInstanceText` / chat tool PATCH operations already write to message.json immediately, so the flush is *currently a no-op* — but is invoked as part of the *contract*. If in-memory-only mutations are added in the future, ExportFig will still capture them without loss.
- I-2 `output.bytes` is a valid ZIP — the first 4 bytes are `PK\x03\x04`
- I-3 The ZIP internally contains `canvas.fig` + `meta.json` + `images/*`
- I-4 Decoding `output.bytes` again with `decodeFigCanvas` yields the same `nodeChanges` count (verified by an e2e regression test)
- I-5 The `Save Session` button is **not an Export prerequisite** — it just downloads a JSON snapshot (for the user's *resume editing later* use). Pressing Export .fig is enough to capture all edits into the .fig.

## 4. Error cases

- Session not found → `NotFoundError`
- Internal repack error (e.g. schema corruption) → `Error` propagated as-is

## 5. Out of scope

- Byte-level repack (lossless copy when nothing was edited). This use case always runs in JSON mode.
- Compression option choice (fixed to deflate-raw)

## 6. Routing coupling

`POST /api/save/:id`. The response is a direct download with `application/octet-stream` + RFC 5987 `filename*=UTF-8''<encoded>-edited.fig`. Content-Disposition encoding is the routing layer's responsibility (the domain only exposes origName).
