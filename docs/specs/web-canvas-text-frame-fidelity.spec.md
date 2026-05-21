# spec/web-canvas-text-frame-fidelity

| Item | Value |
|---|---|
| Status | Draft (round 13) |
| Implementation | `web/client/src/Canvas.tsx` (TEXT branch, ~line 344-407) |
| Tests | `web/core/domain/clientNode.test.ts` (where unit-testable), Pass 3 visual gate (button-5_9, alret-64_376) |
| Siblings | `web-canvas-instance-clip.spec.md` (round 12 INSTANCE clip) |

## 1. Goal

The round-11 audit on the design-setting fixtures `button-5_9` and
`alret-64_376` exposes two classes of text-rendering defects. Round 12 PR2
(INSTANCE auto-clip) was an intended result — without that clip, text used
to leak visibly; with the clip, text now *clips off* ("Button" → "Butto",
"Delete" → "Del"). This spec addresses *why it clips* and aligns with Figma's
actual behavior.

The two defects:

- **C1 — variant text-width clipping**: across virtually every variant of
  button-5_9, "Button" is clipped to "Butto". Figma renders the whole word
  inside the same frame width. Hypothesis: font-metric difference (real
  font vs Konva fallback) makes our glyph widths broader, so the last
  glyph does not fit inside the frame's clip rect.
- **C2 — disabled-variant opacity stacking**: in button-5_9's disabled
  outline / solid variants, the text and icons are barely visible. Figma
  renders them faded but still legible. Hypothesis: opacity is applied to
  *both* the frame layer *and* the child text layer, so the effect is
  multiplicative (0.4 × 0.4 = 0.16).

## 2. Invariants

### 2.1 Text width handling (C1)

- I-1 KText's `width` prop does *not* simply forward the frame's `w` — in
  Figma's real data a TEXT node carries its own `size.x`/`size.y`, and we
  use those first. Do not treat the parent frame's width as KText's width
  (the frame may have padding).
- I-2 Glyph overflow policy: **do not clip** (default Figma behavior).
  KText's `wrap` stays at its default ('word'); `ellipsis` stays at its
  default (false). When width is short, glyphs are drawn beyond the frame
  but are not clipped — round 12's INSTANCE auto-clip only clips a *frame*
  to its bbox, never KText itself, so horizontal overflow is normal.
- I-3 Fallback when a font-metric mismatch becomes visible: if the real
  font (Inter / Pretendard, etc.) has not loaded, the glyph widths
  measured by Konva's system fallback may exceed the real ones. The
  design intent (visible character count) breaks. Options:
  - I-3a (preferred): guarantee font loading — wait for
    `document.fonts.ready` before first paint.
  - I-3b: micro-tighten via a negative `letterSpacing` on KText — breaks
    compatibility. Not adopted.
- I-4 Whether the "Button" → "Butto" root cause is *font metric* or
  *frame width itself* must be measured in the audit harness
  (`KText.getTextWidth()` vs `frame.w`). Based on the measurement,
  decide whether I-1 or I-3 is the fix invariant.

### 2.2 Disabled opacity stacking (C2)

- I-5 A node's `opacity` applies to itself only. Children (including
  master-expansion descendants) follow *only their own opacity*. Parent-
  child opacity composition is left to Konva's natural compositing (which
  multiplies automatically).
- I-6 Data source for disabled variants: audit whether the master tree's
  `opacity` is applied to certain nodes during the outer INSTANCE's
  expansion. Check whether 0.4 sits on a single node yet our side applies
  it to two places (frame + text).
- I-7 The fix lies in one of two candidates:
  - I-7a: if `Canvas.tsx`'s NodeShape *forwards* opacity to children as
    props, remove the forwarding (let Konva auto-compose).
  - I-7b: if master expansion *copies* the master's opacity onto child
    nodes (e.g. `out.opacity = data.opacity * parent.opacity` inside
    `toClientChildForRender`), remove that duplication.

## 3. Investigation order

This spec **needs measurement before fixing**. Order:

1. Pick one button-5_9 variant and measure `KText.getTextWidth()` vs
   `frame.w` → decide between C1's I-1 and I-3.
2. Dump button-5_9's disabled variant data → which nodes carry the
   opacity field, and how NodeShape forwards it (grep) → decide between
   C2's I-7a and I-7b.
3. Apply the small fix that the decided invariant prescribes → re-check
   the visual gate.

## 4. Out of scope

- General multilingual font fallback (e.g. Chinese hints in Korean/English
  mixed text) — open a separate round when the meta-rich design system
  surfaces it.
- Using KText's ellipsis — apply only when Figma explicitly marks
  ellipsis; on regular frames overflow exposure is the default.
- Font-load progress UI — keep the existing fallback chain
  (Inter → system) so the first paint with a fallback font causes no
  visual shock; forcing a re-render after `fonts.ready` may be included
  in this spec (I-3a).
- **INSTANCE size override + auto-layout reflow** — cases where an
  INSTANCE shrinks the master to less than half its size, like the alert
  dialog's "Cancel" / "Delete" buttons. Figma reflows the auto-layout to
  recenter child TEXT inside the INSTANCE → glyphs fit at their natural
  width. We render at master coordinates and the round-12 INSTANCE
  auto-clip cuts them. This spec cannot fix that (disabling round-12
  INSTANCE clip brings back the truncated-default-label case; the real fix is
  auto-layout reflow). Belongs in a separate round ("INSTANCE auto-layout
  reflow" spec).
