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

interface DocNode {
  guid?: { sessionID?: number; localID?: number };
  type?: string;
  name?: string;
  children?: DocNode[];
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
  toggleExpand: (guid: string) => void;
  selectedGuids: Set<string>;
  onSelect: LayerTreeProps['onSelect'];
  /**
   * Set on the row whose guid matches `revealGuid` so the LayerTree's
   * post-effect can scrollIntoView on the right node. Spec I-F11.6.
   */
  revealGuid: string | null;
  revealRef: React.RefObject<HTMLDivElement | null>;
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
}: LayerRowProps) {
  const guid = guidStrOf(node);
  const children = Array.isArray(node.children) ? node.children : [];
  // Spec I-F6: instance master expansions (`_renderChildren`) are NOT
  // exposed in the tree — only direct children. So we look at `children`
  // alone, mirroring Figma's left-panel behavior.
  const hasChildren = children.length > 0;
  const isExpanded = guid ? expanded.has(guid) : false;
  const isSelected = guid ? selectedGuids.has(guid) : false;

  const Icon = iconFor(node.type);

  const onRowClick = (e: React.MouseEvent): void => {
    if (!guid) return;
    onSelect(guid, e.shiftKey ? 'toggle' : 'replace');
  };
  const onChevronClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (guid) toggleExpand(guid);
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
        onClick={onRowClick}
        className={cn(
          'flex items-center gap-1 h-7 cursor-pointer select-none text-xs',
          'hover:bg-accent/50',
          isSelected && 'bg-accent',
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
          key={guidStrOf(c) || `${guid}-${i}`}
          node={c}
          depth={depth + 1}
          expanded={expanded}
          toggleExpand={toggleExpand}
          selectedGuids={selectedGuids}
          onSelect={onSelect}
          revealGuid={revealGuid}
          revealRef={revealRef}
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
 * Exported for unit testing.
 */
export function buildAncestorIndex(page: DocNode | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!page || !Array.isArray(page.children)) return out;
  function walk(node: DocNode, ancestors: string[]): void {
    const g = guidStrOf(node);
    if (g) out.set(g, ancestors);
    if (Array.isArray(node.children) && node.children.length > 0) {
      const nextAncestors = g ? [...ancestors, g] : ancestors;
      for (const c of node.children) walk(c, nextAncestors);
    }
  }
  for (const c of page.children) walk(c, []);
  return out;
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

  // ── Auto-reveal (spec I-F11.5–I-F11.8) ────────────────────────────────
  // When selectedGuids changes, union every selected guid's ancestor chain
  // into `expanded`. Manual collapse persists between selection changes
  // (the effect dep is selectedGuids only, so unrelated re-renders don't
  // re-expand). Empty selection is a no-op.
  const revealRef = useRef<HTMLDivElement | null>(null);
  const revealGuid = useMemo(() => {
    if (selectedGuids.size === 0) return null;
    // Pick the first selected guid that exists in this page — multi-select
    // across pages is rare; first-match-on-this-page is the row we scroll to.
    for (const g of selectedGuids) {
      if (ancestorIndex.has(g)) return g;
    }
    return null;
  }, [selectedGuids, ancestorIndex]);

  useEffect(() => {
    if (selectedGuids.size === 0) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const g of selectedGuids) {
        const ancestors = ancestorIndex.get(g);
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
  }, [selectedGuids, ancestorIndex, variantContainers]);

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
