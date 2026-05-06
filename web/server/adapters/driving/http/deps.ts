/**
 * Bundle of use cases and stores the route handlers consume.
 *
 * Composition root in server/index.ts builds one `Deps` object and passes
 * it to `registerRoutes(app, deps)`. Each route file imports just what
 * it needs from the shape.
 */

import type { SessionStore } from '../../../../core/ports/SessionStore.js';
import type { UploadFig } from '../../../../core/application/UploadFig.js';
import type { EditNode } from '../../../../core/application/EditNode.js';
import type { OverrideInstanceText } from '../../../../core/application/OverrideInstanceText.js';
import type { ResizeNode } from '../../../../core/application/ResizeNode.js';
import type { ExportFig } from '../../../../core/application/ExportFig.js';
import type { SaveSnapshot } from '../../../../core/application/SaveSnapshot.js';
import type { LoadSnapshot } from '../../../../core/application/LoadSnapshot.js';
import type { ServeAsset } from '../../../../core/application/ServeAsset.js';
import type { RunChatTurn } from '../../../../core/application/RunChatTurn.js';
import type { History } from '../../../../core/application/History.js';
import type { AuditCompare } from '../../../../core/application/AuditCompare.js';

export interface Deps {
  sessionStore: SessionStore;
  uploadFig: UploadFig;
  editNode: EditNode;
  overrideInstanceText: OverrideInstanceText;
  resizeNode: ResizeNode;
  exportFig: ExportFig;
  saveSnapshot: SaveSnapshot;
  loadSnapshot: LoadSnapshot;
  serveAsset: ServeAsset;
  runChatTurn: RunChatTurn;
  history: History;
  auditCompare: AuditCompare;
}
