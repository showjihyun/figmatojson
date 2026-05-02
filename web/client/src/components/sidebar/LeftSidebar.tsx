/**
 * Left sidebar with three tabs (Files / Assets / Chat).
 *
 * Spec: docs/specs/web-left-sidebar.spec.md
 *
 * Files = LayerTree of currentPage. Assets = file-wide master list. Chat
 * = the existing ChatPanel verbatim. Active tab is persisted to
 * localStorage (spec I-T3) so a refresh keeps the user where they were.
 *
 * Radix Tabs keep all panels mounted in the DOM (just toggling visibility),
 * so chat input, scroll positions, and tree expansion survive tab swaps
 * without remounting (spec I-T5).
 */
import { useCallback } from 'react';
import { FileText, Library, MessageSquare } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ChatPanel } from '../../ChatPanel';
import { LayerTree } from './LayerTree';
import { AssetList, type AssetEntry } from './AssetList';
import { PagesSection } from './PagesSection';

type TabValue = 'files' | 'assets' | 'chat';
const STORAGE_KEY = 'leftSidebar.tab';
const VALID: ReadonlySet<string> = new Set(['files', 'assets', 'chat']);

function loadInitialTab(): TabValue {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID.has(stored)) return stored as TabValue;
  } catch {
    // localStorage may throw under Safari private mode / SSR — fall through
  }
  return 'files';
}

interface DocNode {
  guid?: { sessionID?: number; localID?: number };
  type?: string;
  name?: string;
  children?: DocNode[];
}

export interface LeftSidebarProps {
  // Document state
  doc: DocNode | null;
  pages: DocNode[];
  pageIdx: number;
  setPageIdx: (idx: number) => void;
  currentPage: DocNode | null;
  // Selection
  selectedGuids: Set<string>;
  onSelect: (guid: string | null, mode?: 'replace' | 'toggle') => void;
  // Chat (forwarded verbatim to ChatPanel)
  sessionId: string | null;
  selectedGuidForChat: string | null;
  onDocChange: () => void;
}

export function LeftSidebar({
  doc,
  pages,
  pageIdx,
  setPageIdx,
  currentPage,
  selectedGuids,
  onSelect,
  sessionId,
  selectedGuidForChat,
  onDocChange,
}: LeftSidebarProps) {
  // Uncontrolled Tabs: Radix manages the active value internally via
  // defaultValue. We only listen to onValueChange to persist the latest
  // choice in localStorage. Going uncontrolled also avoids React-19 + Radix
  // jsdom timing quirks where a controlled value updates one tick late and
  // the test sees a stale "inactive" state.
  const initialTab = loadInitialTab();

  const onTabChange = useCallback((v: string) => {
    if (!VALID.has(v)) return;
    try { localStorage.setItem(STORAGE_KEY, v); } catch { /* ignore */ }
  }, []);

  const onAssetClick = useCallback(
    (a: AssetEntry) => {
      if (a.pageIdx !== pageIdx) setPageIdx(a.pageIdx);
      onSelect(a.guid, 'replace');
    },
    [pageIdx, setPageIdx, onSelect],
  );

  return (
    <Tabs
      defaultValue={initialTab}
      onValueChange={onTabChange}
      className="flex h-full min-h-0 flex-col"
    >
      <TabsList className="m-2 grid grid-cols-3">
        <TabsTrigger value="files" className="gap-1.5">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          Files
        </TabsTrigger>
        <TabsTrigger value="assets" className="gap-1.5">
          <Library className="h-3.5 w-3.5" aria-hidden />
          Assets
        </TabsTrigger>
        <TabsTrigger value="chat" className="gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" aria-hidden />
          Chat
        </TabsTrigger>
      </TabsList>

      {/*
        Files tab: stacked Pages section + Layers tree. Pages on top so the
        user always sees what page they're on; Layers below scrolls
        independently of the page list.
      */}
      <TabsContent value="files" className="mt-0 min-h-0 flex-1 overflow-hidden flex flex-col">
        <PagesSection pages={pages} pageIdx={pageIdx} setPageIdx={setPageIdx} />
        <div className="flex h-8 items-center px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Layers
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <LayerTree
            page={currentPage}
            pageKey={pageIdx}
            selectedGuids={selectedGuids}
            onSelect={onSelect}
          />
        </div>
      </TabsContent>

      <TabsContent value="assets" className="mt-0 min-h-0 flex-1">
        <AssetList
          doc={doc}
          pages={pages}
          selectedGuids={selectedGuids}
          onAssetClick={onAssetClick}
        />
      </TabsContent>

      {/* Chat tab keeps the existing component shape — same props it used to
          receive directly from App. Tab unmount-resistance preserves message
          history / draft text / model picker state across tab swaps. */}
      <TabsContent value="chat" className="mt-0 min-h-0 flex-1">
        <ChatPanel
          sessionId={sessionId}
          selectedGuid={selectedGuidForChat}
          onChange={onDocChange}
        />
      </TabsContent>
    </Tabs>
  );
}
