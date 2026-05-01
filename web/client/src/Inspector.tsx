/**
 * Right-side panel showing the selected node's JSON + a quick text-edit form.
 *
 * PoC: only supports editing textData.characters via the form. Full JSON is
 * shown for AI/dev reference. Future: structured field-by-field editor.
 */
import { useMemo, useState, useEffect } from 'react';
import { patchNode } from './api';

interface InspectorProps {
  page: any;
  sessionId: string;
  selectedGuid: string | null;
  onChange: () => void;
}

function findByGuid(root: any, guid: string): any | null {
  if (!root || typeof root !== 'object') return null;
  const g = root.guid;
  if (g && `${g.sessionID}:${g.localID}` === guid) return root;
  const children = root.children;
  if (Array.isArray(children)) {
    for (const c of children) {
      const f = findByGuid(c, guid);
      if (f) return f;
    }
  }
  return null;
}

export function Inspector({ page, sessionId, selectedGuid, onChange }: InspectorProps) {
  const node = useMemo(
    () => (selectedGuid ? findByGuid(page, selectedGuid) : null),
    [page, selectedGuid],
  );
  const [textValue, setTextValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTextValue(node?.textData?.characters ?? '');
  }, [node]);

  if (!selectedGuid) {
    return (
      <div style={{ padding: 16, color: '#888', fontSize: 13 }}>
        Click a shape on the canvas to inspect / edit.
      </div>
    );
  }
  if (!node) {
    return (
      <div style={{ padding: 16, color: '#c66', fontSize: 13 }}>
        Selected node {selectedGuid} not found in current page.
      </div>
    );
  }

  async function applyTextEdit() {
    if (!node || node.type !== 'TEXT') return;
    setBusy(true);
    try {
      await patchNode(sessionId, selectedGuid!, 'textData.characters', textValue);
      onChange();
    } catch (err) {
      alert(`Edit failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: 16, borderBottom: '1px solid #333', flexShrink: 0 }}>
        <div style={{ fontSize: 11, color: '#888' }}>SELECTED · {selectedGuid}</div>
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>
          {node.type} {node.name ? `— ${node.name}` : ''}
        </div>
        {node.size && (
          <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
            {Math.round(node.size.x ?? 0)} × {Math.round(node.size.y ?? 0)}
          </div>
        )}
      </div>

      {node.type === 'TEXT' && (
        <div style={{ padding: 16, borderBottom: '1px solid #333', flexShrink: 0 }}>
          <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 6 }}>
            TEXT CONTENT
          </label>
          <textarea
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            disabled={busy}
            rows={3}
            style={{
              width: '100%',
              background: '#0a0a0a',
              color: '#eee',
              border: '1px solid #444',
              borderRadius: 4,
              padding: 8,
              fontFamily: 'inherit',
              fontSize: 13,
              resize: 'vertical',
            }}
          />
          <button
            onClick={applyTextEdit}
            disabled={busy || textValue === (node.textData?.characters ?? '')}
            style={{
              marginTop: 8,
              background: '#0a84ff',
              color: 'white',
              border: 'none',
              padding: '6px 14px',
              borderRadius: 4,
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            Apply
          </button>
        </div>
      )}

      <div style={{ padding: 16, overflow: 'auto', minHeight: 0, flex: 1 }}>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>JSON</div>
        <pre
          style={{
            margin: 0,
            fontSize: 11,
            color: '#aaa',
            fontFamily: 'Menlo, Consolas, monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {JSON.stringify(strip(node), null, 2)}
        </pre>
      </div>
    </div>
  );
}

/** Strip large/binary fields from JSON view (PoC convenience). */
function strip(node: any): any {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(strip);
  const out: any = {};
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (k === 'children') {
      out[k] = `<${(v as any[])?.length ?? 0} children>`;
    } else if (k === 'derivedSymbolData' || k === 'fillGeometry' || k === 'strokeGeometry') {
      out[k] = `<elided>`;
    } else if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof (v as any).__bytes === 'string'
    ) {
      out[k] = `<bytes:${((v as any).__bytes as string).length}b64>`;
    } else if (v && typeof v === 'object') {
      out[k] = strip(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
