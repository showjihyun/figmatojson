import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileUp, FolderOpen, Redo2, Save, Undo2 } from 'lucide-react';
import { Inspector } from './Inspector';
import { LeftSidebar } from './components/sidebar/LeftSidebar';

// Lazy-load the Konva-backed canvas. Pulls the ~334 kB konva chunk only
// after the user opens a document — the upload-empty landing screen never
// pays for it.
const Canvas = lazy(() =>
  import('./Canvas').then((m) => ({ default: m.Canvas })),
);
import { Button } from '@/components/ui/button';
import {
  documentService,
  sessionService,
  type UploadResult,
} from '@/services';

export function App() {
  const [session, setSession] = useState<UploadResult | null>(null);
  // Keep the original uploaded File so we can transparently re-upload
  // when the backend evicts the session (TTL 1 h, or process restart).
  // Without this, a save attempt after eviction errors out with
  // "session not found" and the user has to manually re-pick the file.
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
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

  // Stable identity so the memoized Canvas/NodeShape tree doesn't see a new
  // `onSelect` prop on every App render — that would defeat React.memo and
  // re-render every NodeShape on selection clicks.
  const handleSelect = useCallback(
    (guid: string | null, mode: 'replace' | 'toggle' = 'replace') => {
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
    },
    [],
  );
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
      setUploadedFile(f);
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
      try {
        await sessionService.downloadExportedFig(session.sessionId, session.origName);
      } catch (err) {
        // Session evicted (backend GC after 1 h of inactivity, or restart).
        // Transparently re-upload the original File and retry once. Any
        // unsaved edits are lost — there's no edit log to replay against
        // the new session — but the user can immediately save again,
        // which is strictly better than a hard error.
        const msg = (err as Error).message;
        const isExpired = /\b404\b/.test(msg) || /not found/i.test(msg);
        if (!isExpired || !uploadedFile) throw err;
        const fresh = await documentService.upload(uploadedFile);
        setSession(fresh);
        const d = await documentService.fetch(fresh.sessionId);
        setDoc(d);
        await sessionService.downloadExportedFig(fresh.sessionId, fresh.origName);
      }
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
      try {
        await sessionService.downloadSnapshot(session.sessionId, session.origName);
      } catch (err) {
        const msg = (err as Error).message;
        const isExpired = /\b404\b/.test(msg) || /not found/i.test(msg);
        if (!isExpired || !uploadedFile) throw err;
        const fresh = await documentService.upload(uploadedFile);
        setSession(fresh);
        const d = await documentService.fetch(fresh.sessionId);
        setDoc(d);
        await sessionService.downloadSnapshot(fresh.sessionId, fresh.origName);
      }
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
      // Snapshot load doesn't carry a backing .fig File — clear the auto-
      // recovery handle so save fall-through doesn't try to re-upload a
      // stale File from a previous fig-pick.
      setUploadedFile(null);
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

  const onRefreshDoc = useCallback(async () => {
    if (!session) return;
    const d = await documentService.fetch(session.sessionId);
    setDoc(d);
  }, [session]);

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

  const onMoveMany = useCallback(async (updates: Array<{ guid: string; x: number; y: number }>) => {
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
  }, [session, onRefreshDoc]);

  const onResize = useCallback(async (guid: string, x: number, y: number, w: number, h: number) => {
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
  }, [session, onRefreshDoc]);

  const onResizeMany = useCallback(async (
    updates: Array<{ guid: string; x: number; y: number; w: number; h: number }>,
  ) => {
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
  }, [session, onRefreshDoc]);

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
            {/* Page picker now lives in the sidebar's Pages section
                (web-left-sidebar.spec.md §4.0). The toolbar keeps just
                the file-op buttons. */}
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
                title="(Optional) Save current edits as a JSON snapshot to resume later in the editor. Not required before Export — Export auto-saves."
              >
                <Save />
                Save Session
              </Button>
              <Button
                variant="default"
                size="lg"
                onClick={onSaveFig}
                disabled={busy}
                title="Auto-save all pending edits and download a Figma-importable .fig"
              >
                <Download />
                Export .fig
              </Button>
            </div>
          </>
        )}
      </header>

      <main className="flex min-h-0 flex-1">
        <aside className="flex w-60 min-h-0 flex-col border-r border-border">
          <LeftSidebar
            doc={doc}
            pages={pages}
            pageIdx={pageIdx}
            setPageIdx={(idx) => {
              setPageIdx(idx);
              setSelectedGuids(new Set());
            }}
            currentPage={currentPage}
            selectedGuids={selectedGuids}
            onSelect={handleSelect}
            sessionId={session?.sessionId ?? null}
            selectedGuidForChat={selectedGuid}
            onDocChange={onRefreshDoc}
          />
        </aside>
        {/* Round-23 audit-tooling: ?audit=1 swaps the dark editor chrome for a
            white canvas bg so screenshots compare like-for-like against Figma's
            REST API renders (which use a transparent → white background).
            Without this, nodes with NO_FILL containers (right_top breadcrumb
            strip etc.) show #0e0e0e in our capture vs white in figma.png and
            register as 9 spurious "background mismatch" gaps in the audit.
            See docs/audit-round11/GAPS.md "Round 22 follow-up". */}
        <div className={`relative flex-1 overflow-hidden ${
          typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('audit') === '1'
            ? 'bg-white'
            : 'bg-[#0e0e0e]'
        }`}>
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
                root={doc}
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
        <aside className="flex w-60 min-h-0 flex-col border-l border-border bg-card">
          {session && currentPage ? (
            <Inspector
              page={currentPage}
              root={doc}
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
