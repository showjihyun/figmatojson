# Round 11 — Figma vs figma_reverse fidelity gaps

This file lists gaps found by visually diffing each component on the
`design setting` page against Figma's actual render.

Workflow:
1. Open Figma at the corresponding node, screenshot the component frame
   tightly cropped, and save as `<slug>/figma.png` next to the existing
   `ours.png` in this folder.
2. Diff each pair side-by-side. Note every gap as a row in the
   appropriate component's table below.
3. Bucket → Backlog (bottom of file).

## Gap-row format

Each row in a component table:

| severity | bucket | what's wrong | likely fix point |

- `severity` ∈ {high | med | low}
- `bucket` ∈ {style-detail | universal-primitive | behavior | out-of-scope}

---

## button (5:9)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## input-box (9:42)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## type (11:150)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## option-a (11:515)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## dropdown (11:532)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## sidemenu (23:1635)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## radio (11:540)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## multicheck (11:576)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## date (11:606)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## datepicker (12:749)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## table-a (16:728)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## table-b (16:729)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## table-nodata (64:397)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## option-b (26:243)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## breadscrum (29:450)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## toast-popup (53:346)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## alert (64:376)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## pagenation (131:362)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## loader (133:422)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

## label (145:674)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|

---

## Backlog (filled after diffing all components)

Sort gaps by frequency × severity. Group same-cause gaps; a single
universal-primitive fix often resolves rows across many components.

### High priority

| # | title | components affected | bucket |
|---|---|---|---|

### Medium priority

| # | title | components affected | bucket |
|---|---|---|---|

### Low / nice-to-have

| # | title | components affected | bucket |
|---|---|---|---|
