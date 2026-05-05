# BVP — full audit inventory

Source: `docs/bvp.fig`
Total pages: 2

Selection rules:
- containers (`FRAME / SECTION / SYMBOL / INSTANCE / COMPONENT_SET`)
- size floors per depth (major × minor): d1 ≥ 50×50, d2 ≥ 80×60, d3 ≥ 150×80
- depth ≤ 3 from the page root
- dedupe: same name+size repeated ≥ 10 times under one parent → keep first only
- parent-clip filter: drop entries whose visible area inside the nearest container ancestor is < 10%

## example page (`example-page`) — 27 captures, page bbox (0,0) 6179×1431

| depth | type | name | id | x | y | w | h | slug |
|---:|---|---|---|---:|---:|---:|---:|---|
| 1 | FRAME | 01-01-00 오픈 첫 페이지 | 0:1158 | 5 | 0 | 1920 | 946 | `01-01-00-0_1158` |
| 2 | FRAME | Mask group | 0:1159 | 307 | 48 | 961 | 898 | `mask-group-0_1159` |
| 2 | INSTANCE | right | 0:1163 | 1268 | 0 | 657 | 946 | `right-0_1163` |
| 2 | INSTANCE | left | 0:1174 | 5 | 0 | 302 | 946 | `left-0_1174` |
| 1 | FRAME | [modal]map style | 0:1175 | 1536 | 1011 | 310 | 169 | `modalmap-style-0_1175` |
| 2 | FRAME | Frame 2254 | 0:1178 | 1548 | 1055 | 286 | 113 | `frame-2254-0_1178` |
| 3 | FRAME | Frame 2225 | 0:1179 | 1548 | 1055 | 286 | 81 | `frame-2225-0_1179` |
| 1 | FRAME | [modal]profile open  | 0:1198 | 5 | 1015 | 285 | 165 | `modalprofile-open-0_1198` |
| 2 | FRAME | Frame 2269 | 0:1199 | 5 | 1015 | 285 | 68 | `frame-2269-0_1199` |
| 2 | FRAME | Frame 2271 | 0:1205 | 5 | 1091 | 285 | 81 | `frame-2271-0_1205` |
| 1 | FRAME | [modal]flow edit | 0:1214 | 322 | 1015 | 140 | 81 | `modalflow-edit-0_1214` |
| 1 | FRAME | [modal]Area list | 0:1221 | 511 | 1015 | 340 | 416 | `modalarea-list-0_1221` |
| 2 | INSTANCE | [modal]저장된area | 0:1222 | 511 | 1015 | 340 | 416 | `modalarea-0_1222` |
| 1 | FRAME | [modal]save Area | 0:1223 | 882 | 1015 | 310 | 168 | `modalsave-area-0_1223` |
| 2 | FRAME | Frame 2254 | 0:1226 | 894 | 1059 | 286 | 64 | `frame-2254-0_1226` |
| 1 | FRAME | [modal]Place search history | 0:1234 | 1212 | 1015 | 275 | 82 | `modalplace-search-history-0_1234` |
| 1 | FRAME | [modal]Place search list | 0:1249 | 1212 | 1143 | 266 | 222 | `modalplace-search-list-0_1249` |
| 1 | FRAME | [modal]Service Guide | 0:1272 | 0 | 1260 | 361 | 116 | `modalservice-guide-0_1272` |
| 1 | FRAME | 01-01-01 Flow 선택 | 1:2877 | 2132 | 0 | 1920 | 946 | `01-01-01-flow-1_2877` |
| 2 | FRAME | Mask group | 1:2878 | 2434 | 48 | 961 | 898 | `mask-group-1_2878` |
| 2 | INSTANCE | left | 1:2892 | 2132 | 0 | 302 | 946 | `left-1_2892` |
| 2 | INSTANCE | Frame 2397 | 1:2895 | 3395 | 0 | 657 | 946 | `frame-2397-1_2895` |
| 1 | FRAME | 02-01-00 히스토리페이지 | 1:3158 | 4259 | 0 | 1920 | 946 | `02-01-00-1_3158` |
| 2 | FRAME | Mask group | 1:3159 | 4561 | 48 | 961 | 898 | `mask-group-1_3159` |
| 2 | INSTANCE | left | 1:3173 | 4259 | 0 | 302 | 946 | `left-1_3173` |
| 2 | FRAME | Frame 2448 | 1:3174 | 5329 | 0 | 850 | 1915 | `frame-2448-1_3174` |
| 3 | FRAME | Frame 2512 | 1:3175 | 5361 | 48 | 786 | 1792.0035400390625 | `frame-2512-1_3175` |

## design system (`design-system`) — 33 captures, page bbox (0,0) 4776×4107

| depth | type | name | id | x | y | w | h | slug |
|---:|---|---|---|---:|---:|---:|---:|---|
| 1 | SECTION | Color Reference | 1:1297 | 0 | 0 | 1852 | 1204 | `color-reference-1_1297` |
| 2 | FRAME | Blue | 1:1298 | 123 | 169 | 364 | 824 | `blue-1_1298` |
| 3 | FRAME | Swatches | 1:1300 | 155 | 257 | 300 | 704 | `swatches-1_1300` |
| 2 | FRAME | Violet | 1:1351 | 537 | 169 | 364 | 824 | `violet-1_1351` |
| 3 | FRAME | Swatches | 1:1353 | 569 | 257 | 300 | 704 | `swatches-1_1353` |
| 2 | FRAME | Green | 1:1404 | 951 | 169 | 364 | 824 | `green-1_1404` |
| 3 | FRAME | Swatches | 1:1406 | 983 | 257 | 300 | 704 | `swatches-1_1406` |
| 2 | FRAME | Grey | 1:1457 | 1365 | 169 | 364 | 968 | `grey-1_1457` |
| 3 | FRAME | Swatches | 1:1459 | 1397 | 257 | 300 | 848 | `swatches-1_1459` |
| 1 | FRAME | Typography System | 1:1520 | 1927 | 55 | 978 | 2067 | `typography-system-1_1520` |
| 2 | FRAME | Frame 8 | 1:1521 | 1959 | 87 | 914 | 256 | `frame-8-1_1521` |
| 2 | FRAME | Frame 2 | 1:1525 | 1959 | 383 | 914 | 1167 | `frame-2-1_1525` |
| 3 | FRAME | Frame 2424 | 1:1526 | 1959 | 383 | 92 | 839 | `frame-2424-1_1526` |
| 2 | FRAME | Frame 4 | 1:1550 | 1959 | 1590 | 914 | 164 | `frame-4-1_1550` |
| 2 | FRAME | Frame 5 | 1:1557 | 1959 | 1794 | 914 | 160 | `frame-5-1_1557` |
| 2 | FRAME | Frame 9 | 1:1564 | 1959 | 1994 | 914 | 96 | `frame-9-1_1564` |
| 1 | FRAME | Frame 2391 | 1:1569 | 2856 | 2599 | 1920 | 1508 | `frame-2391-1_1569` |
| 1 | FRAME | Frame 2425 | 1:1623 | 443 | 2641 | 1870 | 1214 | `frame-2425-1_1623` |
| 2 | FRAME | Frame 2427 | 1:1624 | 478 | 2651 | 813 | 328 | `frame-2427-1_1624` |
| 2 | FRAME | Frame 2433 | 1:1655 | 488 | 3052 | 793 | 149 | `frame-2433-1_1655` |
| 1 | FRAME | btn | 1:1673 | 624 | 3299 | 1516 | 484 | `btn-1_1673` |
| 2 | SYMBOL | BUTTON=B_default | 1:1683 | 1769 | 3319 | 138 | 64 | `buttonb_default-1_1683` |
| 2 | SYMBOL | BUTTON=Btxt_default | 1:1695 | 1769 | 3547 | 122 | 64 | `buttonbtxt_default-1_1695` |
| 2 | SYMBOL | BUTTON=Bn_default | 1:1710 | 1946 | 3319 | 108 | 64 | `buttonbn_default-1_1710` |
| 2 | SYMBOL | BUTTON=Bn_txt_default | 1:1726 | 1946 | 3547 | 92 | 64 | `buttonbn_txt_default-1_1726` |
| 2 | SYMBOL | BUTTON=B_disable | 1:1739 | 1769 | 3395 | 141 | 64 | `buttonb_disable-1_1739` |
| 2 | SYMBOL | BUTTON=Btxt_disable | 1:1751 | 1769 | 3623 | 125 | 64 | `buttonbtxt_disable-1_1751` |
| 2 | SYMBOL | BUTTON=Bn_disable | 1:1766 | 1946 | 3395 | 111 | 64 | `buttonbn_disable-1_1766` |
| 2 | SYMBOL | BUTTON=Btxt_disable | 1:1782 | 1946 | 3623 | 95 | 64 | `buttonbtxt_disable-1_1782` |
| 2 | SYMBOL | BUTTON=B_hover | 1:1795 | 1769 | 3471 | 138 | 64 | `buttonb_hover-1_1795` |
| 2 | SYMBOL | BUTTON=Btxt_hover | 1:1807 | 1769 | 3699 | 122 | 64 | `buttonbtxt_hover-1_1807` |
| 2 | SYMBOL | BUTTON=Bn_hover | 1:1822 | 1946 | 3471 | 108 | 64 | `buttonbn_hover-1_1822` |
| 2 | SYMBOL | BUTTON=Bn_txt_hover | 1:1838 | 1946 | 3699 | 92 | 64 | `buttonbn_txt_hover-1_1838` |
