# spec/web-upload-fig

| Item | Value |
|---|---|
| Status | Approved (Phase 7) |
| Implementation | `web/core/application/UploadFig.ts` |
| Tests | `web/core/application/UploadFig.test.ts` |
| Parent | [docs/SPEC-architecture.md](../SPEC-architecture.md), [SDD.md](../SDD.md) |

## 1. Purpose

Accept raw `.fig` bytes and create a working session. Decode + extraction is delegated to `SessionStore.create`, and a summary of the result (page / node counts) is returned so the client can display it in the header.

## 2. Input / Output

```ts
input  = { bytes: Uint8Array, origName: string }
output = { sessionId: string, origName: string, pageCount: number, nodeCount: number }
```

## 3. Invariants

- I-1 `output.sessionId` is the newly created session's ID and is retrievable via `SessionStore.getById(id)`
- I-2 `output.pageCount` = the number of children of the produced documentJson whose `type === 'CANVAS'`
- I-3 `output.nodeCount` = the total node count of the documentJson tree (children recursed)
- I-4 If decoding fails, the `Error` is propagated to the caller and the temp directory is cleaned up (the responsibility of SessionStore.create)

## 4. Error cases

- Invalid .fig bytes → `Error` (kiwi decode failure)
- Empty input (length 0) → `Error`
- `tree.document` missing → `Error: 'no DOCUMENT root in tree'`

## 5. Out of scope

- Authentication (this PoC has no per-session auth)
- User / organization separation
- File validation (extension, size limits)

## 6. Routing coupling

The `POST /api/upload` route (`web/server/adapters/driving/http/uploadRoute.ts`) parses the multipart body and then invokes this use case. The response returns `output` as JSON as-is.
