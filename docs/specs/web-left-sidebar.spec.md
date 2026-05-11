# spec/web-left-sidebar

| Field | Value |
|---|---|
| Status | Approved |
| Implementation | `web/client/src/components/sidebar/LeftSidebar.tsx`, `LayerTree.tsx`, `AssetList.tsx` |
| Tests | `web/client/src/components/sidebar/*.test.tsx`, `web/e2e/left-sidebar.spec.ts` |
| Dependencies | shadcn `Tabs`, `Input`, `Button`. lucide-react icons. Existing `ChatPanel`. App's `selectedGuids` / `setPageIdx` / `handleSelect` props. |

## 1. Goal

Provide the same UX as Figma's left panel — by default, two tabs **Files (layer tree)** + **Assets (searchable component list)**. The existing `ChatPanel` is moved into a **Chat tab** as an optional third surface.

Background:
- The current left 320px = `ChatPanel` only. No UI for design exploration (App.tsx:362).
- The metarich sample is 35,660 nodes / 6 pages — without a Figma-like tree/search, the only way to reach a node is clicking on the canvas.

## 2. Layout

```
+--------------------------------------------------+
| Header (changes none)                            |
+----------+---------------------------+-----------+
| Sidebar  | Canvas                    | Inspector |
| 320px    | flex-1                    | 360px     |
| ┌──────┐ |                           |           |
| │Files │ │                           |           |
| │Assets│ │                           |           |
| │Chat  │ │                           |           |
| └──────┘ │                           |           |
| <body>   │                           |           |
+----------+---------------------------+-----------+
```

- Keep the left `<aside>` width (`w-80` = 320px) / `border-r` / `flex flex-col`. Only the inside is replaced with `<LeftSidebar>`.
- The tab header is pinned to the top of the sidebar (~36px). The body is `flex-1 min-h-0 overflow-auto`.

## 3. Tabs

Uses shadcn `<Tabs>` (`web/client/src/components/ui/tabs.tsx`).

- I-T1 Exactly three tabs: `files` / `assets` / `chat`.
- I-T2 Default tab = `files`.
- I-T3 The active tab is saved in `localStorage["leftSidebar.tab"]`. Restored on reload. Invalid values fall back to `files`.
- I-T4 When there is no session (`session === null`), every tab is still clickable, but the Files/Assets tabs show a "No document open" placeholder (same tone as the canvas placeholder).
- I-T5 The body is not unmounted across tab switches (Radix `<Tabs>` default — chat input / layer expansion / scroll position are preserved).

## 4. Files tab — Pages section + Layer Tree

The Files tab vertically stacks two sections. Each section has its own collapsible header, with a 1px separator between them.

```
┌──────────────────────┐
│ ▾ Pages              │
│   • Cover            │
│   • Design Setting ✓ │  ← current page
│   • ...              │
├──────────────────────┤
│ ▾ Layers             │
│   ▸ sidemenu         │  ← children of currentPage
│   ▸ section 1        │
│   ...                │
└──────────────────────┘
```

### 4.0 Pages section

- I-PG1 Input = `pages` (App's `doc.children.filter(type === 'CANVAS')`). One row per page.
- I-PG2 Row content = page name (or `<unnamed>`). Extra metadata is non-goal in v1.
- I-PG3 The current page (the row that `pageIdx` points to) is highlighted with `bg-accent` + a 4px primary-color bar on the left. All other rows use `hover:bg-accent/50` on hover.
- I-PG4 Clicking a page row → `setPageIdx(idx)` + `onSelect(null)` (clear selection). This is already encoded in the signature of the `setPageIdx` prop the LeftSidebar receives (App.tsx's setPageIdx wrapper clears selectedGuids).
- I-PG5 The Pages section itself is collapsible — the chevron in the header folds/unfolds it. Default unfolded. The collapsed state is component-local; localStorage is non-goal.
- I-PG6 Zero pages (no session) → single-line "No document open" placeholder.
- I-PG7 The page Select in the top bar is **removed** with the introduction of this spec — the Pages section is the only page-switching surface (same as Figma). Only the nodeCount/page-count summary text remains in the top bar.

### 4.1 Data source (Layer Tree)
- I-F1 Input = `currentPage` (App's `pages[pageIdx]`). The tree is a recursive render of `currentPage.children`.
- I-F2 On page switch (`pageIdx` change), the tree automatically re-renders from the new page's children. The previous page's expand state is **discarded** (not kept per page — same as Figma).

### 4.2 Row content
Each row (`LayerRow`):
- Indentation = `depth * 12px` (left padding).
- chevron (`ChevronRight` / `ChevronDown` from lucide) — shown when there are children, click to expand/collapse. When there are no children, the slot is occupied to preserve alignment.
- Type icon — per node type:
  - `FRAME` / `GROUP` / `CANVAS` → `Square`
  - `TEXT` → `Type`
  - `RECTANGLE` / `ELLIPSE` / `LINE` / `STAR` / `VECTOR` / `BOOLEAN_OPERATION` → `Shapes`
  - `INSTANCE` → `Component` (lucide `Component`, or fallback `Square`)
  - `SYMBOL` / `COMPONENT` / `COMPONENT_SET` → `Component`
  - Other → `Square`
- Name (`node.name`). An empty name renders as `<unnamed>` (muted-foreground color).
- I-F3 Visibility toggle / lock are non-goals in v1 (no UI). Only the type icon + name.
- I-F3.5 **Variant badge** — when a node is a variant container (newer `COMPONENT_SET`, or a legacy FRAME/SYMBOL with ≥2 SYMBOL/COMPONENT children whose names are `key=value` patterns), a small muted text badge in the form `(N)` is shown next to the name. The detector is `countVariantChildren` (`web/client/src/lib/variants.ts`). When 0, the badge is omitted. Works on legacy containers too — e.g., the "Button" container in the metarich UI design .fig fixture.

### 4.3 Expand / Collapse
- I-F4 Expand state is component-local `Set<guidStr>`. Cleared on page switch (I-F2).
- I-F5 chevron click is separated from row click — chevron only toggles expand; the row body click triggers selection.
- I-F6 INSTANCE master expansions are exposed in the tree. When a row has `children.length === 0` but `_renderChildren?.length > 0` (an INSTANCE whose master subtree was attached during decode), the renderer walks `_renderChildren` instead so the user can see what's inside the component — same as Figma's left-panel behavior, which shows instance children expandable.
- I-F6.1 Rows produced from an instance master expansion (every node carrying `_isInstanceChild: true`) are rendered with muted/italic styling to mark them as informational (the master's identity, not the instance's own subtree). Their `expanded` key is composite — `<outerInstanceGuid>/<rowGuid>` — so two instances of the same master keep independent expand state.
- I-F6.2 Click on an `_isInstanceChild` row → `onSelect(outerInstanceGuid, ...)`, not the row's own guid. The master subtree's guids live in a different page tree (the component's source page), so direct selection would produce "Selected node X not found in current page" in the Inspector. Bubble-to-outer matches the Canvas click rule (Canvas.tsx `onShapeClick` already early-returns on `_isInstanceChild`).
- I-F6.3 Chevron click on `_isInstanceChild` rows works normally — only the row-body click bubbles. Users can drill into the visual structure without changing selection.
- I-F14 **Double-click drill-in** (Figma-like). Double-click on a row body:
  - Expands the row if it has any children (idempotent — already-expanded stays expanded).
  - If the row has *direct* children (`node.children.length > 0`), selection moves to the first direct child via `onSelect(firstChildGuid, 'replace')`. This is the "go one level deeper" behavior.
  - If the row only has master expansion children (`_renderChildren`, no `.children`), selection stays on the outer node — master expansion descendants can't be selected directly (I-F6.2), so drilling has nowhere to land.
  - Leaf rows (no children at all) are a no-op for drill-in; the preceding single-click already selected them.
  - Double-click does NOT fire on the chevron button (the button's own `onClick` stops propagation).
- I-F7 All nodes are collapsed by default. Only depth 0 (direct children of the page) are visible initially.

### 4.4 Selection sync
- I-F8 Row click → `onSelect(guidStr, 'replace')`. Calls App's `handleSelect` (the same one Canvas uses).
- I-F9 Shift+click → `onSelect(guidStr, 'toggle')`.
- I-F10 Rows where `selectedGuids.has(guidStr)` use `bg-accent` (selected background). Hover uses `hover:bg-accent/50`.
- I-F11 When selection changes on the canvas → `selectedGuids` prop changes → tree re-renders → the matching row is highlighted.
- I-F11.5 **Auto-reveal** (Figma "left layer" behavior): when `selectedGuids` changes (previous → current set differs), the tree *adds* the ancestor chain (`guidStr[]`) of every selected guid into the expand set. The existing expand state is preserved — collapses are not undone; only missing ancestors are filled.
- I-F11.5b **Variant container self-expand**: when a selected node is a variant container (`countVariantChildren(node) > 0`), its own guid is also added to the expand set — so variants become visible immediately. Matches Figma's behavior of keeping SETs expanded by default. Plain FRAMEs (not variant containers) do not self-expand (to avoid tree explosion).
- I-F11.6 Bring the first selected row's DOM element into the viewport via `scrollIntoView({ block: 'nearest', behavior: 'auto' })`. Once, immediately after the expand commit (the next microtask after the effect). `behavior: 'auto'` is deterministic in jsdom / e2e environments.
- I-F11.7 If the user collapsed something manually via the chevron, that collapse is preserved until the next `selectedGuids` change — i.e., ancestor auto-expand is triggered only by *deps changes* of selectedGuids (the effect's dep is limited to selectedGuids). The tree itself re-rendering with the same selection does not re-run auto-expand, so the user's manual collapse survives.
- I-F11.8 If the selection is empty (`selectedGuids.size === 0`), auto-reveal is a no-op — no expand-set change / no scroll.

### 4.5 Performance
- I-F12 With collapse-by-default, the initial render is depth 0 only — starting from the metarich sample's first-page direct-child count (~tens). No virtualization needed.
- I-F13 Cases with 1000+ children under an expanded node will be measured and may introduce `react-window` in v2. v1 has no guard — if the user expands and stalls, that triggers the measurement.

## 5. Assets tab

### 5.1 Data source
- I-A1 Input = the whole `doc` (all pages). Walked once via `useMemo`.
- I-A2 Output = flat `Asset[]` array; each item is `{guid: string, name: string, type: string, pageIdx: number, pageName: string}`.
- I-A3 Included types: `SYMBOL`, `COMPONENT`, `COMPONENT_SET`. All others ignored.
- I-A4 Sort: name ascending (case-insensitive). Type order within the same name is preserved (stable sort).

### 5.2 Search
- I-S1 A shadcn `<Input />` search bar. placeholder = `"Search assets..."`.
- I-S2 Match = case-insensitive substring (`name.toLowerCase().includes(q.toLowerCase())`). Regex / wildcards / multilingual tokenization are non-goals.
- I-S3 Empty query → show all. No match → "No assets match" placeholder.
- I-S4 No debounce — the metarich sample's `Asset[]` length is ~1500 and substring filtering finishes within the frame budget.

### 5.3 Row content
- Type icon (`Component` from lucide) + name.
- Secondary info: page name (muted, text-xs, right-aligned). Hints which page defines it.
- I-AS1 Thumbnail previews are non-goal in v1. Type icon only.

### 5.4 Click behavior
- I-AC1 Row click → `setPageIdx(asset.pageIdx)` + `onSelect(asset.guid, 'replace')`. If already on the same page, the page change is a no-op.
- I-AC2 The search query is retained after clicking (so the user can try other assets too).
- I-AC3 Auto-pan-to on canvas is non-goal in v1.

## 6. Chat tab

- I-C1 Hosts the existing `ChatPanel` component as-is. The props (`sessionId`, `selectedGuid`, `onChange`) are received by `LeftSidebar` and forwarded. Internal behavior / API / model selection / auth mode are unchanged.
- I-C2 Because the tab body is not unmounted when inactive (I-T5), chat message state / draft text / model selection / auth tokens are preserved.
- I-C3 The Chat tab is always visible — even with no session (`ChatPanel` itself handles that case).

## 7. Props contract

```ts
interface LeftSidebarProps {
  // Document state
  doc: any | null;                  // root DOCUMENT node (used by AssetList walk)
  pages: Array<{ name: string; children?: any[] }>;
  pageIdx: number;
  setPageIdx: (idx: number) => void;
  currentPage: any | null;          // pages[pageIdx]
  // Selection
  selectedGuids: Set<string>;
  onSelect: (guid: string | null, mode?: 'replace' | 'toggle') => void;
  // Chat (forwarded verbatim to ChatPanel)
  sessionId: string | null;
  selectedGuidForChat: string | null;
  onDocChange: () => void;
}
```

## 8. Error / Edge cases

- I-E1 `doc === null` (no session) → "No document open" placeholder in every tab. The last tab in localStorage is still restored, but with an empty body the user sees no difference.
- I-E2 `currentPage === undefined` (`pageIdx` exceeds `pages.length`) → only the Files tab shows a placeholder. Assets / Chat unaffected.
- I-E3 `node.name === ''` or `null` → display `<unnamed>` (muted).
- I-E4 Infinite tree cycles (a child pointing to an ancestor through a corrupted `parentIndex`) — throws on React maxDepth. v1 has no guard (not seen in real .fig data).

## 9. Non-goals (v1)

- Moving the page selector into the sidebar — keep the current top-bar location (App.tsx:297). v2.
- Layer visibility / lock toggle UI.
- Layer right-click context menu (rename / delete / duplicate).
- Tree virtualization (react-window).
- Asset thumbnail previews.
- Canvas zoom-to-fit on asset click (v1 does selection + page switch only).
- Sidebar collapse / resize.
- Multilingual search (Hangul jamo splitting, fuzzy match) — substring only.
- Multi-selected auto-reveal scroll target — only the *first* selected row uses scrollIntoView (fitting all of them into a single viewport is v2).

## 10. Resolved questions

- **Tab position (top vs side)** — top tabs (horizontal) — Inspector uses the same pattern (`Inspector.tsx:121`). Consistency first.
- **Chat as third tab vs slide-over** — third tab. A drawer would need extra components + state + keyboard shortcuts. v1 prefers simplicity.
- **Asset scope (current page vs all pages)** — all pages. Same as Figma + the metarich usage pattern (masters scattered across pages).
- **Per-page tree expand state retention** — not retained. Figma also resets the tree on page switch. Reduces memory/complexity.
- **Selection prop drilling vs external store** — prop drilling. Same as the existing App→Canvas pattern. Extending SelectionStore to the sidebar is v2 (the current SelectionStore is Canvas-internal).
