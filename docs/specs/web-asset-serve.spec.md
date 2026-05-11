# spec/web-asset-serve

| Item | Value |
|---|---|
| Status | Approved (Phase 7) |
| Implementation | `web/core/application/ServeAsset.ts` + `web/server/adapters/driven/FsAssetServer.ts` |
| Tests | `web/core/application/ServeAsset.test.ts` |

## 1. Purpose

Serve the raw bytes of an image fillPaint inside a session so the canvas can render it. The URL key is the lowercase hex of the 20-byte SHA-1 used by Figma.

## 2. Input / Output

```ts
input  = { sessionId: string, hashHex: string }
output = { bytes: Uint8Array, mime: string }
```

## 3. Invariants

- I-1 If `hashHex` is not exactly 40 lowercase hex characters → `ValidationError` (prevents path traversal)
- I-2 If `extracted/01_container/images/<hashHex>` in the session directory does not exist → `NotFoundError`
- I-3 `output.mime` is the result of magic-byte sniffing (PNG / JPEG / GIF / WebP) or `application/octet-stream`
- I-4 `output.bytes` is byte-identical to the disk file (read-only)

## 4. Error cases

- `hashHex` format violation → `ValidationError`
- Session not found OR file not found → `NotFoundError`

## 5. Out of scope

- Image transformation (resize, format conversion)
- Authorization / authentication
- CDN caching (the routing layer adds `Cache-Control: private, max-age=3600`)

## 6. Routing coupling

`GET /api/asset/:id/:hash`. Response: `Content-Type: <sniffed mime>` + `Cache-Control: private, max-age=3600`.
