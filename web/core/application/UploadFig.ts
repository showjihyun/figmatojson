/**
 * Use case: upload a .fig and create a working session.
 *
 * Driving adapter (HTTP) parses the multipart body and hands raw bytes +
 * filename here; we don't accept a Hono Context — that's a layering
 * violation.
 */

import type { SessionStore } from '../ports/SessionStore.js';

export interface UploadFigInput {
  bytes: Uint8Array;
  origName: string;
}

export interface UploadFigOutput {
  sessionId: string;
  origName: string;
  pageCount: number;
  nodeCount: number;
}

function countNodes(n: any): number {
  if (!n || typeof n !== 'object') return 0;
  let count = 1;
  if (Array.isArray(n.children)) for (const c of n.children) count += countNodes(c);
  return count;
}

export class UploadFig {
  constructor(private readonly sessionStore: SessionStore) {}

  async execute({ bytes, origName }: UploadFigInput): Promise<UploadFigOutput> {
    const session = await this.sessionStore.create(bytes, origName);
    const doc = session.documentJson;
    const pageCount = Array.isArray(doc.children)
      ? doc.children.filter((n: any) => n.type === 'CANVAS').length
      : 0;
    return {
      sessionId: session.id,
      origName: session.origName,
      pageCount,
      nodeCount: countNodes(doc),
    };
  }
}
