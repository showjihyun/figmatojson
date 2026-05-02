/**
 * Files-tab: Pages section. List of CANVAS pages with the current one
 * highlighted; click to switch.
 *
 * Spec: docs/specs/web-left-sidebar.spec.md §4.0
 *
 * Sits ABOVE the LayerTree in the Files tab. Replaces the page <Select>
 * that used to live in App.tsx's top toolbar — the sidebar is now the
 * only page-switching surface (matches Figma).
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, FileIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PageNode {
  guid?: { sessionID?: number; localID?: number };
  type?: string;
  name?: string;
}

interface PagesSectionProps {
  pages: PageNode[];
  pageIdx: number;
  setPageIdx: (idx: number) => void;
}

export function PagesSection({ pages, pageIdx, setPageIdx }: PagesSectionProps) {
  const [open, setOpen] = useState(true);

  if (pages.length === 0) {
    return (
      <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
        No document open
      </div>
    );
  }

  return (
    <div className="border-b border-border" data-testid="pages-section">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-1 px-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        aria-controls="pages-section-list"
      >
        {open
          ? <ChevronDown className="h-3 w-3" aria-hidden />
          : <ChevronRight className="h-3 w-3" aria-hidden />}
        <span className="uppercase tracking-wide">Pages</span>
      </button>

      {open && (
        <ul
          id="pages-section-list"
          role="list"
          className="pb-1"
          aria-label="Pages"
        >
          {pages.map((p, i) => {
            const isCurrent = i === pageIdx;
            return (
              <li
                key={i}
                role="listitem"
                onClick={() => setPageIdx(i)}
                aria-current={isCurrent ? 'page' : undefined}
                className={cn(
                  'relative flex h-7 cursor-pointer select-none items-center gap-2 pl-3 pr-2 text-xs',
                  'hover:bg-accent/50',
                  isCurrent && 'bg-accent',
                )}
              >
                {/* Left rail accent on the current page — Figma style. */}
                {isCurrent && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-0 h-full w-1 bg-primary"
                  />
                )}
                <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">
                  {p.name && p.name.length > 0
                    ? p.name
                    : <span className="italic text-muted-foreground">{'<unnamed>'}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
