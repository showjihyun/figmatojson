/**
 * SessionService — handles export (.fig download), snapshot save / load.
 *
 * Browsers' "download a Blob" dance (createObjectURL + <a>.click() +
 * revokeObjectURL) lives here so consumers stay declarative:
 *   await sessionService.downloadExportedFig(sid, 'design.fig');
 */

import type { UploadResult } from './DocumentService';

export interface SessionService {
  downloadExportedFig(sessionId: string, origName: string): Promise<void>;
  downloadSnapshot(sessionId: string, origName: string): Promise<void>;
  loadSnapshot(file: File): Promise<UploadResult>;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

class HttpSessionService implements SessionService {
  async downloadExportedFig(sessionId: string, origName: string): Promise<void> {
    const r = await fetch(`/api/save/${sessionId}`, { method: 'POST' });
    if (!r.ok) throw new Error(`save failed: ${r.status} ${await r.text()}`);
    const blob = await r.blob();
    triggerDownload(blob, `${origName.replace(/\.fig$/, '')}-edited.fig`);
  }

  async downloadSnapshot(sessionId: string, origName: string): Promise<void> {
    const r = await fetch(`/api/session/${sessionId}/snapshot`);
    if (!r.ok) throw new Error(`snapshot failed: ${r.status} ${await r.text()}`);
    const blob = await r.blob();
    triggerDownload(blob, `${origName.replace(/\.fig$/, '')}.figrev-session.json`);
  }

  async loadSnapshot(file: File): Promise<UploadResult> {
    const text = await file.text();
    const r = await fetch('/api/session/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    if (!r.ok) throw new Error(`load failed: ${r.status} ${await r.text()}`);
    return r.json();
  }
}

export const sessionService: SessionService = new HttpSessionService();
