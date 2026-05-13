/**
 * Files-tab: hierarchical layer tree of the current page.
 *
 * Spec: docs/specs/web-left-sidebar.spec.md §4
 *
 * Renders `currentPage.children` recursively. Each LayerRow shows depth
 * indent + (chevron | spacer) + type icon + name. Click a row to drive
 * App's selection callback; chevron toggles expansion separately.
 *
 * Expand state is component-local Set<guidStr>, intentionally reset on
 * page switch (spec I-F2 / I-F4). Most subtrees stay collapsed → first
 * paint only renders depth-0 frames, no virtualization needed (I-F12).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Component as ComponentIcon,
  Shapes,
  Square,
  Type,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { countVariantChildren } from '@/lib/variants';
import { variantLabelText } from '@/lib/variantLabel';
import { buildAncestorIndex as buildAncestorIndexShared } from '@core/domain/tree';

interface DocNode {
  guid?: { sessionID?: number; localID?: number };
  type?: string;
  name?: string;
  children?: DocNode[];
  /** INSTANCE master subtree attached during decode (I-F6 / I-F6.1). */
  _renderChildren?: DocNode[];
  /** True for every node inside an INSTANCE's _renderChildren expansion. */
  _isInstanceChild?: boolean;
}

interface LayerTreeProps {
  page: DocNode | null;
  selectedGuids: Set<string>;
  onSelect: (guid: string | null, mode?: 'replace' | 'toggle') => void;
  /** Page index — used to reset expand state on page switch (I-F2). */
  pageKey: number | string;
}

function guidStrOf(n: DocNode): string {
  const g = n.guid;
  if (!g || g.sessionID == null || g.localID == null) return '';
  return `${g.sessionID}:${g.localID}`;
}

const VECTOR_TYPES = new Set([
  'RECTANGLE', 'ELLIPSE', 'LINE', 'STAR', 'VECTOR', 'BOOLEAN_OPERATION', 'ROUNDED_RECTANGLE', 'REGULAR_POLYGON',
]);
const COMPONENT_TYPES = new Set(['SYMBOL', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

function iconFor(type: string | undefined) {
  if (type === 'TEXT') return Type;
  if (type && VECTOR_TYPES.has(type)) return Shapes;
  if (type && COMPONENT_TYPES.has(type)) return ComponentIcon;
  return Square;
}

interface LayerRowProps {
  node: DocNode;
  depth: number;
  expanded: Set<string>;
  toggleExpand: (key: string) => void;
  selectedGuids: Set<string>;
  onSelect: LayerTreeProps['onSelect'];
  /**
   * Set on the row whose guid matches `revealGuid` so the LayerTree's
   * post-effect can scrollIntoView on the right node. Spec I-F11.6.
   */
  revealGuid: string | null;
  revealRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Set on every descendant of an INSTANCE's `_renderChildren` expansion.
   *
   * Encoded as a `/`-joined path of INSTANCE guids, outermost first
   * (e.g. `"0:9289"` for one level, `"0:9289/1:9212"` once we step into a
   * nested INSTANCE inside the outer master subtree). Two consequences
   * (spec I-F6.1 / I-F6.2 / I-F6.4):
   *   - This row's expand key is `${outerInstanceGuid}/${guid}` (composite)
   *     so two instances of the same master keep independent expand state,
   *     and nested copies of the same sub-master don't collide either.
   *   - Row-body click selects the *first* segment (outermost, page-
   *     reachable INSTANCE) — inner segments are themselves master-page
   *     guids that the Inspector can't find in the current page tree.
   * `undefined` for normal rows (the INSTANCE itself + everything outside
   * an instance expansion).
   */
  outerInstanceGuid?: string;
}

const LayerRow = memo(function LayerRow({
  node,
  depth,
  expanded,
  toggleExpand,
  selectedGuids,
  onSelect,
  revealGuid,
  revealRef,
  outerInstanceGuid,
}: LayerRowProps) {
  const guid = guidStrOf(node);
  // Spec I-F6: fall back to `_renderChildren` when `.children` is empty so
  // INSTANCE master subtrees are visible in the tree (same as Figma).
  const directChildren = Array.isArray(node.children) ? node.children : [];
  const fallbackChildren =
    directChildren.length === 0 && Array.isArray(node._renderChildren)
      ? node._renderChildren
      : [];
  const children = directChildren.length > 0 ? directChildren : fallbackChildren;
  const hasChildren = children.length > 0;
  // I-F6.1 — composite expand key for rows inside an instance expansion so
  // two instances of the same master don't share expand state.
  const expandKey = guid
    ? outerInstanceGuid
      ? `${outerInstanceGuid}/${guid}`
      : guid
    : '';
  const isExpanded = expandKey ? expanded.has(expandKey) : false;
  const isSelected = guid ? selectedGuids.has(guid) : false;
  // When we're entering the master expansion of THIS INSTANCE, descendant
  // rows extend the path by appending `guid`. If we're already inside an
  // outer expansion (outerInstanceGuid set), the chain is appended — that
  // keeps the OUTERMOST page-reachable INSTANCE at the front of the path
  // (needed for selection bubble — spec I-F6.4) while still disambiguating
  // expand state across nested copies of the same sub-master. Non-INSTANCE
  // rows inherit the current path unchanged.
  const enteringExpansion =
    directChildren.length === 0 && fallbackChildren.length > 0;
  const childOuterInstanceGuid = enteringExpansion
    ? outerInstanceGuid
      ? `${outerInstanceGuid}/${guid}`
      : guid
    : outerInstanceGuid;

  const Icon = iconFor(node.type);

  const onRowClick = (e: React.MouseEvent): void => {
    // I-F6.2 / I-F6.4 — `_isInstanceChild` rows bubble selection up to the
    // *outermost* (page-reachable) INSTANCE. outerInstanceGuid is a path
    // "g1/g2/..." of INSTANCE guids from outermost to innermost; only the
    // first segment is findable in the current page tree (inner segments
    // live in master pages). Selecting an inner segment would produce
    // "Selected node X not found in current page" in the Inspector.
    const outermost = outerInstanceGuid?.split('/', 1)[0];
    const selectGuid = outermost ?? guid;
    if (!selectGuid) return;
    onSelect(selectGuid, e.shiftKey ? 'toggle' : 'replace');
  };
  const onChevronClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (expandKey) toggleExpand(expandKey);
  };
  // I-F14 — Figma-like double-click drill-in. Expands the row (if not yet)
  // and moves selection one level deeper to the first direct child. Two
  // guards prevent the drill from selecting an unselectable node:
  //   1. INSTANCE rows whose only children come from `_renderChildren` (no
  //      `.children`) — the master expansion children can't be selected
  //      directly (I-F6.2), so we expand without moving selection.
  //   2. Rows ALREADY inside an instance expansion (outerInstanceGuid set)
  //      — their direct children are also `_isInstanceChild` (master
  //      subtree descendants), so dispatching `onSelect(firstChildGuid)`
  //      would set selectedGuid to a master child guid that the Inspector
  //      can't find in the current page tree ("Selected node X not found
  //      in current page"). Same single-click bubble rule (I-F6.2) applies
  //      to the drill — expand only.
  const onRowDoubleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (expandKey && hasChildren && !isExpanded) toggleExpand(expandKey);
    if (directChildren.length === 0) return;
    if (outerInstanceGuid) return;
    const firstChild = directChildren[0];
    if (!firstChild) return;
    const childGuid = guidStrOf(firstChild);
    if (childGuid) onSelect(childGuid, 'replace');
  };

  // Round 14 — strip variant `prop=` prefixes (e.g. "size=XL, State=default,
  // Type=primary" → "XL, default, primary"). variantLabelText is a no-op
  // for non-variant names; returns null only when name is missing/blank.
  const prettyName = variantLabelText(node.name);
  const displayName = prettyName && prettyName.length > 0
    ? prettyName
    : <span className="italic text-muted-foreground">{'<unnamed>'}</span>;

  // Spec I-F3.5: variant containers (COMPONENT_SET or legacy FRAME-with-
  // variant-named-SYMBOL-children) show a "(N)" variant-count badge.
  const variantCount = countVariantChildren(node);

  return (
    <>
      <div
        ref={guid === revealGuid ? revealRef : undefined}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={hasChildren ? isExpanded : undefined}
        data-guid={guid}
        data-instance-child={node._isInstanceChild ? 'true' : undefined}
        onClick={onRowClick}
        onDoubleClick={onRowDoubleClick}
        className={cn(
          'flex items-center gap-1 h-7 cursor-pointer select-none text-xs',
          'hover:bg-accent/50',
          isSelected && 'bg-accent',
          // I-F6.1 — muted+italic for instance master expansion rows so the
          // user can tell at a glance these are informational (clicking
          // bubbles to the outer INSTANCE, not the master child).
          node._isInstanceChild && 'italic text-muted-foreground',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            onClick={onChevronClick}
            className="flex h-4 w-4 items-center justify-center text-muted-foreground hover:text-foreground"
          >
            {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="inline-block h-4 w-4" aria-hidden />
        )}
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{displayName}</span>
        {variantCount > 0 && (
          <span
            className="shrink-0 text-[10px] text-muted-foreground"
            aria-label={`${variantCount} variants`}
          >
            ({variantCount})
          </span>
        )}
      </div>
      {isExpanded && hasChildren && children.map((c, i) => (
        <LayerRow
          // Key needs to disambiguate across instance expansions too — two
          // INSTANCEs of the same master would otherwise produce duplicate
          // React keys for their identical-guid descendants.
          key={`${childOuterInstanceGuid ?? ''}|${guidStrOf(c) || `${guid}-${i}`}`}
          node={c}
          depth={depth + 1}
          expanded={expanded}
          toggleExpand={toggleExpand}
          selectedGuids={selectedGuids}
          onSelect={onSelect}
          revealGuid={revealGuid}
          revealRef={revealRef}
          outerInstanceGuid={childOuterInstanceGuid}
        />
      ))}
    </>
  );
});

/**
 * Walk page.children once and build a "guidStr → [ancestor1, ancestor2, ...]"
 * map. Used by the auto-reveal effect (I-F11.5) to expand every parent of
 * a selected node without scanning the tree on each render.
 *
 * Thin wrapper around `@core/domain/tree.ts:buildAncestorIndex` so this
 * module's existing imports (test fixtures, internal callers) stay
 * unchanged while Canvas drill-in selection consumes the same helper from
 * the shared domain location. Spec:
 * docs/specs/web-canvas-drill-selection.spec.md §I-C4.
 */
export function buildAncestorIndex(page: DocNode | null): Map<string, string[]> {
  return buildAncestorIndexShared(page);
}

/**
 * Find the chain of composite expand keys that must be added to the
 * `expanded` Set for a row matching `targetGuid` to become visible —
 * including rows that live inside an INSTANCE's `_renderChildren` master
 * subtree expansion. Single-traversal of `page` from each top-level child;
 * short-circuits as soon as the target is reached.
 *
 * Spec: web-canvas-drill-selection v2 §5 (LayerTree mirrors a canvas
 * double-click drill into a master subtree). The keys returned match
 * `LayerRow.expandKey` exactly so adding them to `expanded` flips the
 * right rows open.
 *
 * Returns an empty array when:
 *   - `page` is null / has no children
 *   - The target guid isn't reachable from page.children via `.children`
 *     or `_renderChildren`
 *
 * Exported for unit testing.
 */
export function findExpandKeyChain(page: DocNode | null, targetGuid: string): string[] {
  if (!page || !Array.isArray(page.children) || !targetGuid) return [];
  let found: string[] | null = null;

  function walk(node: DocNode, ancestorKeys: string[], outerPath: string): void {
    if (found) return;
    const guid = guidStrOf(node);
    if (!guid) return;
    const expandKey = outerPath ? `${outerPath}/${guid}` : guid;
    if (guid === targetGuid) {
      // Found — caller adds these ancestor keys to `expanded`. The target
      // row itself does not need to be expanded (we just need it visible).
      found = ancestorKeys;
      return;
    }
    const direct = Array.isArray(node.children) ? node.children : [];
    const fallback =
      direct.length === 0 && Array.isArray(node._renderChildren)
        ? node._renderChildren
        : [];
    if (direct.length > 0) {
      const nextKeys = [...ancestorKeys, expandKey];
      for (const c of direct) walk(c, nextKeys, outerPath);
    } else if (fallback.length > 0) {
      // Entering this INSTANCE's master subtree expansion — descendants'
      // outerPath gains this node so their composite keys match the same
      // scheme LayerRow uses when rendering inside an expansion.
      const nextKeys = [...ancestorKeys, expandKey];
      const nextOuter = outerPath ? `${outerPath}/${guid}` : guid;
      for (const c of fallback) walk(c, nextKeys, nextOuter);
    }
  }

  for (const c of page.children) walk(c, [], '');
  return found ?? [];
}

/**
 * Walk page.children once and collect every guid that is a variant
 * container (countVariantChildren > 0). Auto-reveal uses this set to
 * self-expand the selected node when it's a SET (newer) OR a FRAME-with-
 * variant-children (legacy). Pure cache; no recursion at lookup time.
 */
export function buildVariantContainerSet(page: DocNode | null): Set<string> {
  const out = new Set<string>();
  if (!page || !Array.isArray(page.children)) return out;
  function walk(node: DocNode): void {
    const g = guidStrOf(node);
    if (g && countVariantChildren(node) > 0) out.add(g);
    if (Array.isArray(node.children)) for (const c of node.children) walk(c);
  }
  for (const c of page.children) walk(c);
  return out;
}

export function LayerTree({ page, selectedGuids, onSelect, pageKey }: LayerTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Spec I-F2 / I-F4: drop expand state on page switch. The pageKey prop
  // is the page index (or guid) — flipping it clears the set.
  useEffect(() => {
    setExpanded(new Set());
  }, [pageKey]);

  const toggleExpand = useCallback(
    (guid: string): void => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(guid)) next.delete(guid);
        else next.add(guid);
        return next;
      });
    },
    [],
  );

  // Ancestor index — rebuilt only when the page changes. Selection-driven
  // auto-reveal reads this without re-walking the tree per click.
  const ancestorIndex = useMemo(() => buildAncestorIndex(page), [page, pageKey]);
  // Variant-container set — selected nodes whose guid is in here get
  // self-expanded by the auto-reveal effect (spec I-F11.5b). Built once per
  // page so individual selection ticks just do an O(1) Set.has().
  const variantContainers = useMemo(() => buildVariantContainerSet(page), [page, pageKey]);

  // ── Auto-reveal (spec I-F11.5–I-F11.8 + drill-selection v2 §5) ──────
  // When selectedGuids changes, union every selected guid's ancestor chain
  // into `expanded`. Walks both `.children` AND `_renderChildren` so a
  // canvas double-click that drilled into a master subtree (e.g. selected
  // a Date Picker / Selection Row inside Docked input date picker) also
  // reveals + highlights the row here. Manual collapse persists between
  // selection changes (the effect dep is selectedGuids only, so unrelated
  // re-renders don't re-expand). Empty selection is a no-op.
  const revealRef = useRef<HTMLDivElement | null>(null);

  // Per-selected-guid expand-key chain. Memo so the auto-reveal effect
  // doesn't repeat the walk, and the revealGuid lookup below stays cheap.
  const chainsBySelected = useMemo(() => {
    const out = new Map<string, string[]>();
    if (selectedGuids.size === 0 || !page) return out;
    for (const g of selectedGuids) {
      // Fast path: shallow ancestors are enough for page-resident nodes.
      const shallow = ancestorIndex.get(g);
      if (shallow) {
        out.set(g, shallow);
        continue;
      }
      // Drill case: target is a master-page guid reachable only through
      // some INSTANCE's `_renderChildren`. Fall back to the deep walker.
      const deep = findExpandKeyChain(page, g);
      if (deep.length > 0) out.set(g, deep);
    }
    return out;
  }, [page, selectedGuids, ancestorIndex]);

  const revealGuid = useMemo(() => {
    if (selectedGuids.size === 0) return null;
    // Pick the first selected guid that exists in this page — multi-select
    // across pages is rare; first-match-on-this-page is the row we scroll
    // to. Deep walker covers master subtree drill targets too.
    for (const g of selectedGuids) {
      if (chainsBySelected.has(g)) return g;
    }
    return null;
  }, [selectedGuids, chainsBySelected]);

  useEffect(() => {
    if (selectedGuids.size === 0) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const g of selectedGuids) {
        const ancestors = chainsBySelected.get(g);
        if (!ancestors) continue;
        for (const a of ancestors) {
          if (!next.has(a)) {
            next.add(a);
            changed = true;
          }
        }
        // Spec I-F11.5b — variant containers self-expand on selection so
        // their variants are visible at once (newer COMPONENT_SET *or*
        // legacy FRAME-with-variant-children). Other types don't self-
        // expand (avoids exploding FRAME contents on click).
        if (variantContainers.has(g) && !next.has(g)) {
          next.add(g);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedGuids, chainsBySelected, variantContainers]);

  // After expand has committed (so the row is mounted), scroll it into view.
  // useLayoutEffect runs before paint, avoiding a frame where the user sees
  // the row briefly off-screen.
  useLayoutEffect(() => {
    if (!revealGuid) return;
    const el = revealRef.current;
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [revealGuid, expanded]);

  if (!page) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="text-xs text-muted-foreground">No document open</p>
      </div>
    );
  }

  const children = Array.isArray(page.children) ? page.children : [];
  if (children.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="text-xs text-muted-foreground">Empty page</p>
      </div>
    );
  }

  return (
    <div role="tree" aria-label="Layer tree" className="py-1">
      {children.map((c, i) => (
        <LayerRow
          key={guidStrOf(c) || `root-${i}`}
          node={c}
          depth={0}
          expanded={expanded}
          toggleExpand={toggleExpand}
          selectedGuids={selectedGuids}
          onSelect={onSelect}
          revealGuid={revealGuid}
          revealRef={revealRef}
        />
      ))}
    </div>
  );
}
