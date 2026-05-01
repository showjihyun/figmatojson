/**
 * DocumentService — wraps every server endpoint that mutates or queries the
 * current session's Document tree.
 *
 * Components should NOT call `fetch()` directly; they go through this
 * service so the wire shape stays in one place. Tests can substitute a
 * fake DocumentService that records calls without hitting the network.
 */

export interface UploadResult {
  sessionId: string;
  origName: string;
  pageCount: number;
  nodeCount: number;
}

export interface HistoryResult {
  ok: boolean;
  /** Label of the entry that was applied (or null if nothing on the stack). */
  undoneLabel?: string | null;
  redoneLabel?: string | null;
  past: number;
  future: number;
}

export interface DocumentService {
  upload(file: File): Promise<UploadResult>;
  fetch(sessionId: string): Promise<unknown>;
  patch(sessionId: string, nodeGuid: string, field: string, value: unknown): Promise<void>;
  resize(
    sessionId: string,
    nodeGuid: string,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Promise<void>;
  setInstanceTextOverride(
    sessionId: string,
    instanceGuid: string,
    masterTextGuid: string,
    value: string,
  ): Promise<void>;
  undo(sessionId: string): Promise<HistoryResult>;
  redo(sessionId: string): Promise<HistoryResult>;
}

class HttpDocumentService implements DocumentService {
  async upload(file: File): Promise<UploadResult> {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`upload failed: ${r.status} ${await r.text()}`);
    return r.json();
  }

  async fetch(sessionId: string): Promise<unknown> {
    const r = await fetch(`/api/doc/${sessionId}`);
    if (!r.ok) throw new Error(`fetch doc failed: ${r.status}`);
    return r.json();
  }

  async patch(sessionId: string, nodeGuid: string, field: string, value: unknown): Promise<void> {
    const r = await fetch(`/api/doc/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeGuid, field, value }),
    });
    if (!r.ok) throw new Error(`patch failed: ${r.status} ${await r.text()}`);
  }

  async resize(
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

  async setInstanceTextOverride(
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

  async undo(sessionId: string): Promise<HistoryResult> {
    const r = await fetch(`/api/undo/${sessionId}`, { method: 'POST' });
    if (!r.ok) throw new Error(`undo failed: ${r.status} ${await r.text()}`);
    return r.json();
  }

  async redo(sessionId: string): Promise<HistoryResult> {
    const r = await fetch(`/api/redo/${sessionId}`, { method: 'POST' });
    if (!r.ok) throw new Error(`redo failed: ${r.status} ${await r.text()}`);
    return r.json();
  }
}

/** Singleton instance. Import this wherever you used to import api.ts. */
export const documentService: DocumentService = new HttpDocumentService();
