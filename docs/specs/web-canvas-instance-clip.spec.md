# spec/web-canvas-instance-clip

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/client/src/Canvas.tsx` (extend `wantClip` condition) |
| Tests | `web/e2e/upload-edit-save.spec.ts` (visual gate) + existing unit suite |
| Siblings | `web-instance-render-overrides.spec.md` (the override pipeline itself) |

## 1. Purpose

When an INSTANCE's `_renderChildren` (per-instance copies of the master tree)
extend beyond the INSTANCE's effective bbox, our Canvas draws them anyway.
Figma, by default, clips an INSTANCE to its own bbox. The mismatch between
these two behaviors produces mojibake like `Defa<localized-text-A>` /
`Defa<localized-text-B>` on round-11 audit's design-setting page — the child
TEXT "Default" (32, 5) of the MultiCheck master (SYMBOL 11:577, 77×24) leaks
32px to the right inside a table-cell INSTANCE that has been size-overridden
to 24×24, painting on top of the next column. This spec aligns our Canvas
with Figma's default clip behavior.

## 2. Invariants

- I-1 If an INSTANCE node (`node.type === 'INSTANCE'`) has at least one
  `_renderChildren`, then `wantClip = true`. clipFunc draws the INSTANCE's
  effective bbox `(0, 0, w, h)` (including corner rounding when `cornerR` is
  present, in the same format as the existing FRAME clip).
- I-2 When an INSTANCE explicitly carries `frameMaskDisabled === true`, the
  clip is disabled. This honors the case where the designer turned off Figma's
  "clip content" toggle. (false / undefined both apply the clip — Figma's
  default is to clip.)
- I-3 Clip behavior for native FRAMEs (non-INSTANCE) is unchanged — the
  existing `node.frameMaskDisabled === false` condition stands. Compatible
  with round 2 §3.
- I-4 An INSTANCE with empty `_renderChildren` (master unresolved / expansion
  fallback) gets no clip applied — keeps the existing fallback at zero
  additional cost.
- I-5 The master tree's own `frameMaskDisabled` is ignored during INSTANCE
  expansion. Clip is based only on the instance's effective size (a size
  override smaller than master.size is the core case this spec addresses).

## 3. Render-side behavior

Extends only the `wantClip` branch at `Canvas.tsx:517`. clipFunc body,
anyCorner handling, and Group `clipFunc` plumbing all reuse existing code.

```diff
- const wantClip = node.frameMaskDisabled === false;
+ const wantClipForInstance =
+   node.type === 'INSTANCE' &&
+   node.frameMaskDisabled !== true &&
+   Array.isArray(node._renderChildren) && node._renderChildren.length > 0;
+ const wantClip = node.frameMaskDisabled === false || wantClipForInstance;
```

## 4. Error cases

- `w` or `h` is 0 / undefined — existing code falls back to a 0-sized rect
  (visually a no-op in Konva). I-1 is equally safe.
- Deeply nested INSTANCEs — outer + inner INSTANCEs each clip to their own
  bbox. Konva automatically composes nested clipFuncs (intersect).

## 5. Out of scope

- Clipping the SYMBOL/COMPONENT master itself (not an INSTANCE) — not
  addressed here. The master must be visible as-is in the designer viewer
  (drawing-page contexts).
- *Position correction* of `_renderChildren` (transforming orphan TEXT so it
  ends up within the instance bbox) — this spec simply hides it. Simulating
  Figma's auto-layout resize is a separate round.
- The *root cause* of the `Defa<localized-text-B>` mojibake (the variant
  label TEXT remaining as-is inside a 24×24 checkbox instance) is the
  designer's intentional design data — on our side we only tidy up visually
  via the clip.
