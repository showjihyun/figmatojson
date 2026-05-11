# spec/web-resize-node

| Item | Value |
|---|---|
| Status | Approved (Phase 7) |
| Implementation | `web/core/application/ResizeNode.ts` |
| Tests | `web/core/application/ResizeNode.test.ts` |

## 1. Purpose

Atomically update `transform.m02/m12` (position) + `size.x/y` (size) in a single call. When the canvas resize handle invokes this once at the end of a drag, message.json on disk is written to a single consistent state — there is no "half-broken" state that could occur if the change were split into two PATCH calls.

## 2. Input / Output

```ts
input  = { sessionId: string, guid: string, x: number, y: number, w: number, h: number }
output = { ok: true }
```

## 3. Invariants

- I-1 A single write applies `transform.m02 = x`, `transform.m12 = y`, and `size = {x: max(1,w), y: max(1,h)}` to message.json
- I-2 The same node in the in-memory documentJson is mirrored to the same 4 values
- I-3 If `w` or `h` is ≤ 0, clamp to 1 (so Konva does not draw negative-size shapes)
- I-4 Other transform channels (m00/m01/m10/m11) are not modified (rotation / skew is preserved)

## 4. Error cases

- Session not found → `NotFoundError`
- Node not found → `NotFoundError`

## 5. Out of scope

- Simultaneous resize of multiple nodes (App.tsx's `onResizeMany` calls this use case N times)
- aspect-ratio lock
- Rotation (PoC: axis-aligned rectangles only)

## 6. Routing coupling

`POST /api/resize/:id`. body = `{nodeGuid, x, y, w, h}`.
