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

export async function setInstanceTextOverride(
  sessionId: string,
  instanceGuid: string,
  masterTextGuid: string,
  value: string,
): Promise<void> {
  const r = await fetch(`/api/instance-override/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceGuid, masterTextGuid, value }),
  });
  if (!r.ok) throw new Error(`override failed: ${r.status} ${await r.text()}`);
}

export async function resizeNode(
  sessionId: string,
  nodeGuid: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  const r = await fetch(`/api/resize/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeGuid, x, y, w, h }),
  });
  if (!r.ok) throw new Error(`resize failed: ${r.status} ${await r.text()}`);
}

export async function downloadSessionSnapshot(sessionId: string, origName: string): Promise<void> {
  const r = await fetch(`/api/session/${sessionId}/snapshot`);
  if (!r.ok) throw new Error(`snapshot failed: ${r.status} ${await r.text()}`);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = origName.replace(/\.fig$/, '') + '.figrev-session.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function loadSessionSnapshot(file: File): Promise<UploadResult> {
  const text = await file.text();
  const r = await fetch('/api/session/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: text,
  });
  if (!r.ok) throw new Error(`load failed: ${r.status} ${await r.text()}`);
  return r.json();
}
