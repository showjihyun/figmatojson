import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Download, FileUp, FolderOpen, Redo2, Save, Undo2 } from 'lucide-react';
import { Inspector } from './Inspector';
import { ChatPanel } from './ChatPanel';

// Lazy-load the Konva-backed canvas. Pulls the ~334 kB konva chunk only
// after the user opens a document — the upload-empty landing screen never
// pays for it.
const Canvas = lazy(() =>
  import('./Canvas').then((m) => ({ default: m.Canvas })),
);
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  documentService,
  sessionService,
  type UploadResult,
} from '@/services';

export function App() {
  const [session, setSession] = useState<UploadResult | null>(null);
  const [doc, setDoc] = useState<any>(null);
  const [pageIdx, setPageIdx] = useState(0);
  // Multi-select: Set of node GUIDs. When size === 1, behaves like single
  // selection; size > 1 enables drag grouping and shows the multi-select
  // inspector panel.
  const [selectedGuids, setSelectedGuids] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const figFileInputRef = useRef<HTMLInputElement>(null);
  const sessionFileInputRef = useRef<HTMLInputElement>(null);
  // Serialization queue for move/resize batches. The server mutates a single
  // message.json file, so two concurrent batches can interleave their
  // per-axis PATCHes (A.m02 → B.m02 → B.m12 → A.m12) and leave nodes with
  // mixed coordinates. Chaining batches through one promise eliminates that
  // race entirely. Inspector edits go through a different code path (debounced
  // usePatch in Inspector.tsx), so they don't share this queue.
  const moveQueue = useRef<Promise<void>>(Promise.resolve());

  function handleSelect(guid: string | null, mode: 'replace' | 'toggle' = 'replace') {
    setSelectedGuids((prev) => {
      if (guid === null) return new Set();
      if (mode === 'toggle') {
        const next = new Set(prev);
        if (next.has(guid)) next.delete(guid);
        else next.add(guid);
        return next;
      }
      return new Set([guid]);
    });
  }
  // Convenience accessor for the inspector / single-selection consumers.
  const selectedGuid = selectedGuids.size === 1 ? [...selectedGuids][0]! : null;

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const target = e.target;
    setBusy(true);
    try {
      const result = await documentService.upload(f);
      setSession(result);
      const d = await documentService.fetch(result.sessionId);
      setDoc(d);
      setPageIdx(0);
      setSelectedGuids(new Set());
    } catch (err) {
      alert(`Upload error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      // Always reset the input value so the user can re-pick the same file
      // after an error (browsers de-dupe identical selections otherwise).
      target.value = '';
    }
  }

  async function onSaveFig() {
    if (!session) return;
    setBusy(true);
    try {
      await sessionService.downloadExportedFig(session.sessionId, session.origName);
    } catch (err) {
      alert(`Save error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onSaveSession() {
    if (!session) return;
    setBusy(true);
    try {
      await sessionService.downloadSnapshot(session.sessionId, session.origName);
    } catch (err) {
      alert(`Snapshot error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onLoadSession(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const target = e.target;
    setBusy(true);
    try {
      const result = await sessionService.loadSnapshot(f);
      setSession(result);
      const d = await documentService.fetch(result.sessionId);
      setDoc(d);
      setPageIdx(0);
      setSelectedGuids(new Set());
    } catch (err) {
      alert(`Load error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      target.value = '';
    }
  }

  async function onRefreshDoc() {
    if (!session) return;
    const d = await documentService.fetch(session.sessionId);
    setDoc(d);
  }

  async function onUndo() {
    if (!session) return;
    try {
      const r = await documentService.undo(session.sessionId);
      if (r.ok) await onRefreshDoc();
    } catch (err) {
      console.error('undo failed', err);
    }
  }

  async function onRedo() {
    if (!session) return;
    try {
      const r = await documentService.redo(session.sessionId);
      if (r.ok) await onRefreshDoc();
    } catch (err) {
      console.error('redo failed', err);
    }
  }

  useEffect(() => {
    (window as unknown as { __select?: (g: string | null) => void }).__select = (g) =>
      handleSelect(g);
    return () => {
      delete (window as unknown as { __select?: unknown }).__select;
    };
  }, []);

  // Cmd/Ctrl+Z = Undo, Cmd/Ctrl+Shift+Z (and Cmd/Ctrl+Y) = Redo. Skipped
  // when focus is in a text input — typing inside an Inspector field should
  // get the browser's native input-undo, not whole-document undo.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey)) return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        void onUndo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        void onRedo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // session is read inside the closures via the latest closure-captured
    // value when the handler fires, so the effect doesn't need to re-bind
    // every render — but the linter wants `session` listed; safe either way.
  }, [session]);

  async function onMoveMany(updates: Array<{ guid: string; x: number; y: number }>) {
    if (!session) return;
    const sid = session.sessionId;
    moveQueue.current = moveQueue.current.then(async () => {
      try {
        for (const u of updates) {
          await documentService.patch(sid, u.guid, 'transform.m02', u.x);
          await documentService.patch(sid, u.guid, 'transform.m12', u.y);
        }
        onRefreshDoc();
      } catch (err) {
        console.error('group move patch failed', err);
      }
    });
    await moveQueue.current;
  }

  async function onResize(guid: string, x: number, y: number, w: number, h: number) {
    if (!session) return;
    const sid = session.sessionId;
    moveQueue.current = moveQueue.current.then(async () => {
      try {
        await documentService.resize(sid, guid, x, y, w, h);
        onRefreshDoc();
      } catch (err) {
        console.error('resize patch failed', err);
      }
    });
    await moveQueue.current;
  }

  async function onResizeMany(
    updates: Array<{ guid: string; x: number; y: number; w: number; h: number }>,
  ) {
    if (!session) return;
    const sid = session.sessionId;
    moveQueue.current = moveQueue.current.then(async () => {
      try {
        for (const u of updates) {
          await documentService.resize(sid, u.guid, u.x, u.y, u.w, u.h);
        }
        onRefreshDoc();
      } catch (err) {
        console.error('group resize patch failed', err);
      }
    });
    await moveQueue.current;
  }

  const pages = doc?.children?.filter((c: any) => c.type === 'CANVAS') ?? [];
  const currentPage = pages[pageIdx];

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-14 items-center gap-3 border-b border-border bg-card px-4">
        <div className="text-sm font-semibold tracking-tight whitespace-nowrap">
          figma_reverse · Tier 2 PoC
        </div>

        {/* Hidden native file inputs — buttons trigger them via ref. */}
        <input
          ref={figFileInputRef}
          type="file"
          accept=".fig"
          onChange={onUpload}
          disabled={busy}
          className="hidden"
        />
        <input
          ref={sessionFileInputRef}
          type="file"
          accept=".json"
          onChange={onLoadSession}
          disabled={busy}
          className="hidden"
        />

        <Button
          variant="outline"
          size="default"
          onClick={() => figFileInputRef.current?.click()}
          disabled={busy}
          title="Upload a .fig file"
        >
          <FileUp />
          Upload .fig
        </Button>
        <Button
          variant="outline"
          size="default"
          onClick={() => sessionFileInputRef.current?.click()}
          disabled={busy}
          title="Load a previously-saved session snapshot"
        >
          <FolderOpen />
          Load Session
        </Button>

        {session && (
          <>
            <span className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{session.origName}</span>
              {' · '}
              {session.nodeCount.toLocaleString()} nodes
              {' · '}
              {pages.length} pages
            </span>
            <Select
              value={String(pageIdx)}
              onValueChange={(v) => {
                setPageIdx(Number(v));
                setSelectedGuids(new Set());
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pages.map((p: any, i: number) => (
                  <SelectItem key={i} value={String(i)}>
                    {p.name ?? `page ${i}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={onUndo}
                disabled={busy}
                title="Undo (Ctrl/Cmd+Z)"
                aria-label="Undo"
              >
                <Undo2 />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={onRedo}
                disabled={busy}
                title="Redo (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)"
                aria-label="Redo"
              >
                <Redo2 />
              </Button>
              <Button
                variant="secondary"
                size="default"
                onClick={onSaveSession}
                disabled={busy}
                title="Save the current edit state as a JSON snapshot you can resume later"
              >
                <Save />
                Save Session
              </Button>
              <Button
                variant="default"
                size="lg"
                onClick={onSaveFig}
                disabled={busy}
                title="Export to .fig (downloads a Figma-importable file)"
              >
                <Download />
                Export .fig
              </Button>
            </div>
          </>
        )}
      </header>

      <main className="flex min-h-0 flex-1">
        <aside className="flex w-80 min-h-0 flex-col border-r border-border">
          <ChatPanel
            sessionId={session?.sessionId ?? null}
            selectedGuid={selectedGuid}
            onChange={onRefreshDoc}
          />
        </aside>
        <div className="relative flex-1 overflow-hidden bg-[#0e0e0e]">
          {currentPage ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading canvas…
                </div>
              }
            >
              <Canvas
                page={currentPage}
                selectedGuids={selectedGuids}
                onSelect={handleSelect}
                onMoveMany={onMoveMany}
                onResize={onResize}
                onResizeMany={onResizeMany}
                sessionId={session?.sessionId ?? null}
              />
            </Suspense>
          ) : (
            <div className="flex h-full items-center justify-center px-8">
              <div className="max-w-sm text-center">
                <h2 className="text-lg font-semibold">No document open</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Upload a <code className="rounded bg-muted px-1.5 py-0.5 text-xs">.fig</code> file
                  or load a saved session to begin.
                </p>
              </div>
            </div>
          )}
        </div>
        <aside className="flex w-[360px] min-h-0 flex-col border-l border-border bg-card">
          {session && currentPage ? (
            <Inspector
              page={currentPage}
              sessionId={session.sessionId}
              selectedGuid={selectedGuid}
              selectedCount={selectedGuids.size}
              onChange={onRefreshDoc}
            />
          ) : (
            <div className="p-4 text-sm leading-relaxed text-muted-foreground">
              <div className="text-[11px] font-semibold uppercase tracking-wider">
                Inspector
              </div>
              <p className="mt-2">
                Open a document to inspect and edit its layers.
              </p>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
