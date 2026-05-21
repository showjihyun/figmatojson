# spec/web-snapshot

| Item | Value |
|---|---|
| Status | Approved (Phase 7) |
| Implementation | `web/core/application/SaveSnapshot.ts` + `LoadSnapshot.ts` |
| Tests | e2e (`web/e2e/upload-edit-save.spec.ts: session snapshot save → load round-trips edits`) |

## 1. Purpose

Save and restore the in-progress edit state as a single JSON file without exporting a .fig. Lets the user stop work and resume editing from the same point later (the user does not need to re-upload the original .fig).

## 2. Snapshot format (v1)

```ts
interface SnapshotV1 {
  version: 1
  origName: string
  archiveVersion: number
  archiveInfo: object | null
  schemaBinB64: string | null    // base64 of extracted/03_decompressed/schema.kiwi.bin
  messageJson: string            // raw JSON of extracted/04_decoded/message.json
  sidecars: Array<{name: string, b64: string}>  // 01_container/*
}
```

JSON-portable — base64 binary sidecars preserve the original files inside the ZIP as-is (images, etc.).

## 3. SaveSnapshot Invariants

- I-1 Output `version === 1`
- I-2 `messageJson` is the current content of `extracted/04_decoded/message.json` as-is (with edits applied)
- I-3 When `schemaBinB64` is present, `Buffer.from(s, 'base64')` exactly restores the original schema.kiwi.bin bytes on decode
- I-4 `sidecars[].name` is a path relative to `01_container/` (e.g. `images/abc123...`, `meta.json`)

## 4. LoadSnapshot Invariants

- I-5 `version !== 1` → `ValidationError`
- I-6 A new working dir is created via mkdtemp and `extracted/` is byte-identical to what SaveSnapshot produced
- I-7 A new sessionId is issued and looked up via `SessionStore.getById`
- I-8 After LoadSnapshot, `ExportFig.execute` returns normally (edits at save time are reflected in the export, verified by e2e)

## 5. Error cases

- SaveSnapshot: session not found → `NotFoundError`. Missing message.json → `Error` (snapshot is meaningless)
- LoadSnapshot: `version !== 1` → `ValidationError`. fs errors → `Error` propagated; the temp directory is cleaned up

## 6. Out of scope

- Compression (v1: plain base64 — a single MetaRich .fig produces ~50MB JSON. Compression is a v2 candidate)
- Multi-user sharing (no signing/encryption)
- Partial snapshots (v1: always full)

## 7. Routing coupling

- `GET /api/session/:id/snapshot` → SaveSnapshot.execute
- `POST /api/session/load` (body = SnapshotV1) → LoadSnapshot.execute
