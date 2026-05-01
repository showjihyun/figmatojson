import { useState } from 'react';
import { Canvas } from './Canvas';
import { Inspector } from './Inspector';
import { uploadFig, fetchDoc, downloadFig, patchNode, type UploadResult } from './api';

export function App() {
  const [session, setSession] = useState<UploadResult | null>(null);
  const [doc, setDoc] = useState<any>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const result = await uploadFig(f);
      setSession(result);
      const d = await fetchDoc(result.sessionId);
      setDoc(d);
      setPageIdx(0);
      setSelectedGuid(null);
    } catch (err) {
      alert(`Upload error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    if (!session) return;
    setBusy(true);
    try {
      await downloadFig(session.sessionId, session.origName);
    } catch (err) {
      alert(`Save error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onRefreshDoc() {
    if (!session) return;
    const d = await fetchDoc(session.sessionId);
    setDoc(d);
  }

  // Drag-to-move on canvas → patch transform.m02/m12 of the node.
  async function onMove(guid: string, x: number, y: number) {
    if (!session) return;
    try {
      await patchNode(session.sessionId, guid, 'transform.m02', x);
      await patchNode(session.sessionId, guid, 'transform.m12', y);
      onRefreshDoc();
    } catch (err) {
      console.error('drag patch failed', err);
    }
  }

  const pages = doc?.children?.filter((c: any) => c.type === 'CANVAS') ?? [];
  const currentPage = pages[pageIdx];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header
        style={{
          padding: '8px 16px',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          background: '#222',
        }}
      >
        <strong style={{ fontSize: 14 }}>figma_reverse · Tier 2 PoC</strong>
        <input
          type="file"
          accept=".fig"
          onChange={onUpload}
          disabled={busy}
          style={{ color: '#bbb' }}
        />
        {session && (
          <>
            <span style={{ fontSize: 12, color: '#999' }}>
              {session.origName} · {session.nodeCount} nodes · {pages.length} pages
            </span>
            <select
              value={pageIdx}
              onChange={(e) => {
                setPageIdx(Number(e.target.value));
                setSelectedGuid(null);
              }}
              style={{ background: '#333', color: '#eee', border: '1px solid #555', padding: '4px 8px' }}
            >
              {pages.map((p: any, i: number) => (
                <option key={i} value={i}>
                  {p.name ?? `page ${i}`}
                </option>
              ))}
            </select>
            <button
              onClick={onSave}
              disabled={busy}
              style={{
                background: '#0a84ff',
                color: 'white',
                border: 'none',
                padding: '6px 14px',
                borderRadius: 4,
                cursor: busy ? 'wait' : 'pointer',
                marginLeft: 'auto',
              }}
            >
              💾 Save .fig
            </button>
          </>
        )}
      </header>
      <main style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#0e0e0e' }}>
          {currentPage ? (
            <Canvas
              page={currentPage}
              selectedGuid={selectedGuid}
              onSelect={setSelectedGuid}
              onMove={onMove}
            />
          ) : (
            <div style={{ padding: 32, color: '#888' }}>
              Upload a .fig file to begin.
            </div>
          )}
        </div>
        <aside
          style={{
            width: 360,
            borderLeft: '1px solid #333',
            background: '#1a1a1a',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          {session && currentPage && (
            <Inspector
              page={currentPage}
              sessionId={session.sessionId}
              selectedGuid={selectedGuid}
              onChange={onRefreshDoc}
            />
          )}
        </aside>
      </main>
    </div>
  );
}
