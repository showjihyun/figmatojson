/**
 * Assets-tab: searchable, file-wide list of SYMBOL/COMPONENT/COMPONENT_SET
 * masters, sorted by name.
 *
 * Spec: docs/specs/web-left-sidebar.spec.md §5
 *
 * Walks the entire `doc` once (memoized) to find every master across
 * every page. A click navigates to the master's page and selects it on
 * the canvas.
 */
import { useMemo, useState } from 'react';
import { Component as ComponentIcon, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface DocNode {
  guid?: { sessionID?: number; localID?: number };
  type?: string;
  name?: string;
  children?: DocNode[];
}

export interface AssetEntry {
  guid: string;
  name: string;
  type: string;
  pageIdx: number;
  pageName: string;
}

interface AssetListProps {
  doc: DocNode | null;
  pages: DocNode[];
  selectedGuids: Set<string>;
  onAssetClick: (asset: AssetEntry) => void;
}

const MASTER_TYPES = new Set(['SYMBOL', 'COMPONENT', 'COMPONENT_SET']);

function guidStrOf(n: DocNode): string {
  const g = n.guid;
  if (!g || g.sessionID == null || g.localID == null) return '';
  return `${g.sessionID}:${g.localID}`;
}

/**
 * Walk every CANVAS page's subtree once and collect masters. Exported so
 * unit tests can verify the walk independently of the React shell.
 */
export function collectAssets(doc: DocNode | null, pages: DocNode[]): AssetEntry[] {
  if (!doc || !Array.isArray(pages) || pages.length === 0) return [];
  const out: AssetEntry[] = [];
  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx]!;
    const pageName = page.name ?? `page ${pageIdx}`;
    // DFS — masters can be nested inside frames or other components.
    const stack: DocNode[] = Array.isArray(page.children) ? [...page.children] : [];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.type && MASTER_TYPES.has(n.type)) {
        const guid = guidStrOf(n);
        if (guid) {
          out.push({
            guid,
            name: n.name ?? '',
            type: n.type,
            pageIdx,
            pageName,
          });
        }
      }
      if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
    }
  }
  // Spec I-A4: name-asc, case-insensitive, stable.
  out.sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });
  return out;
}

export function AssetList({ doc, pages, selectedGuids, onAssetClick }: AssetListProps) {
  const [query, setQuery] = useState('');

  const all = useMemo(() => collectAssets(doc, pages), [doc, pages]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return all;
    return all.filter((a) => a.name.toLowerCase().includes(q));
  }, [all, query]);

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="text-xs text-muted-foreground">No document open</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="relative px-2 pt-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          placeholder="Search assets..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 pl-7 text-xs"
          aria-label="Search assets"
        />
      </div>

      {all.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <p className="text-xs text-muted-foreground">No assets in this file</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <p className="text-xs text-muted-foreground">No assets match</p>
        </div>
      ) : (
        <ul role="list" className="flex-1 overflow-auto py-1">
          {filtered.map((a) => {
            const isSelected = selectedGuids.has(a.guid);
            return (
              <li
                key={a.guid}
                role="listitem"
                data-guid={a.guid}
                onClick={() => onAssetClick(a)}
                className={cn(
                  'flex items-center gap-2 px-3 h-7 cursor-pointer select-none text-xs',
                  'hover:bg-accent/50',
                  isSelected && 'bg-accent',
                )}
              >
                <ComponentIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate flex-1">
                  {a.name.length > 0 ? a.name : (
                    <span className="italic text-muted-foreground">{'<unnamed>'}</span>
                  )}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {a.pageName}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
