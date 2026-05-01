/** Minimal client for the Tier 2 PoC backend. */

export interface UploadResult {
  sessionId: string;
  origName: string;
  pageCount: number;
  nodeCount: number;
}

export async function uploadFig(file: File): Promise<UploadResult> {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/upload', { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`upload failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function fetchDoc(sessionId: string): Promise<any> {
  const r = await fetch(`/api/doc/${sessionId}`);
  if (!r.ok) throw new Error(`fetch doc failed: ${r.status}`);
  return r.json();
}

export async function patchNode(
  sessionId: string,
  nodeGuid: string,
  field: string,
  value: unknown,
): Promise<void> {
  const r = await fetch(`/api/doc/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeGuid, field, value }),
  });
  if (!r.ok) throw new Error(`patch failed: ${r.status} ${await r.text()}`);
}

export async function downloadFig(sessionId: string, origName: string): Promise<void> {
  const r = await fetch(`/api/save/${sessionId}`, { method: 'POST' });
  if (!r.ok) throw new Error(`save failed: ${r.status} ${await r.text()}`);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = origName.replace(/\.fig$/, '') + '-edited.fig';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
