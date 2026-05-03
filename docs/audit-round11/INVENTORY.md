# Round 11 audit — design setting page component inventory

Source: `docs/메타리치 화면 UI Design.fig` → page 0 `design setting` →
container `Section 1` (id `4:20502`, size 2362×2127).

`V` = variant container (`COMPONENT_SET` or `isStateGroup === true`).

| # | folder slug | name | type | guid | x | y | w | h | V |
|---|---|---|---|---|---:|---:|---:|---:|:---:|
| 01 | button | Button | FRAME | 5:9 | 9 | 47 | 2297 | 248 | V |
| 02 | input-box | Input Box | FRAME | 9:42 | 9 | 350 | 407 | 488 | V |
| 03 | type | Type | FRAME | 11:150 | 432 | 350 | 377 | 274 | V |
| 04 | option-a | option (1) | FRAME | 11:515 | 432 | 656 | 140 | 182 | V |
| 05 | dropdown | Dropdown | SYMBOL | 11:532 | 586 | 656 | 241 | 130 | |
| 06 | sidemenu | sidemenu | SYMBOL | 23:1635 | 2042 | 386 | 250 | 417 | |
| 07 | radio | Radio | FRAME | 11:540 | 843 | 350 | 123 | 196 | V |
| 08 | multicheck | MultiCheck | FRAME | 11:576 | 843 | 575 | 123 | 240 | V |
| 09 | date | Date | FRAME | 11:606 | 998 | 350 | 1008 | 156 | V |
| 10 | datepicker | DatePicker | FRAME | 12:749 | 998 | 522 | 1008 | 316 | V |
| 11 | table-a | table (1) | FRAME | 16:728 | 28 | 1188 | 1590 | 321 | |
| 12 | table-b | table (2) | FRAME | 16:729 | 28 | 1544 | 1590 | 140 | |
| 13 | table-nodata | table_nodata | FRAME | 64:397 | 28 | 1727 | 1590 | 120 | |
| 14 | option-b | option (2) | FRAME | 26:243 | 2042 | 859 | 274 | 242 | V |
| 15 | breadscrum | breadscrum | SYMBOL | 29:450 | 592 | 805 | 217 | 44 | |
| 16 | toast-popup | toast popup | FRAME | 53:346 | 9 | 868 | 280 | 160 | V |
| 17 | alert | alret | SYMBOL | 64:376 | 330 | 868 | 330 | 170 | |
| 18 | pagenation | pagenation | FRAME | 131:362 | 747 | 863 | 438 | 108 | V |
| 19 | loader | loader | FRAME | 133:422 | 707 | 1017 | 112 | 78 | |
| 20 | label | labe | FRAME | 145:674 | 1491 | 883 | 185 | 320 | V |

Excluded: `div.container` (133:407) — height 0, not visually inspectable.

`x/y/w/h` are in Section 1 local coords. Section 1's absolute origin on
the design setting page is (533, 700) — add to convert to page-absolute.

## How to populate Figma screenshots

For each row, save your Figma screenshot as
`docs/audit-round11/<folder slug>/figma.png`. Crop tightly to the
component frame so the diff is meaningful. The matching `ours.png` is
already in place after running the screenshot script.

## Status

- [x] Inventory done
- [ ] Our-side screenshots captured (script: `scripts/audit-round11-screenshots.ts`)
- [ ] Figma screenshots dropped in by user
- [ ] GAPS.md authored
