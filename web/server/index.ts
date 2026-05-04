/**
 * Tier 2 PoC backend.
 *
 * 3 endpoints:
 *   POST /api/upload     — multipart .fig → 서버에 임시 추출 → sessionId 반환
 *   GET  /api/doc/:id    — 추출된 document.json 반환 (캔버스 렌더링용)
 *   PATCH /api/doc/:id   — 노드 일부 수정 (e.g. textData.characters) 적용
 *   POST /api/save/:id   — 현재 상태를 .fig 로 repack → 바이너리 다운로드
 *
 * 세션은 메모리 + 임시 디렉토리 (PoC라서 단순). 프로덕션은 별도 storage 필요.
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 상위 figma_reverse 디렉터리에서 src/ 모듈 재사용. tsx watch는 ESM으로 처리한다.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

import { FsSessionStore } from './adapters/driven/FsSessionStore.js';
import { KiwiCodec } from './adapters/driven/KiwiCodec.js';
import { FsAssetServer } from './adapters/driven/FsAssetServer.js';
import { InProcessTools } from './adapters/driven/InProcessTools.js';
import { AnthropicChat } from './adapters/driven/AnthropicChat.js';
import { AgentSdkChat } from './adapters/driven/AgentSdkChat.js';
import { FsEditJournal } from './adapters/driven/FsEditJournal.js';
import { applyTool } from './adapters/driven/applyTool.js';
import { registerRoutes } from './adapters/driving/http/index.js';
import { UploadFig } from '../core/application/UploadFig.js';
import { EditNode } from '../core/application/EditNode.js';
import { OverrideInstanceText } from '../core/application/OverrideInstanceText.js';
import { ResizeNode } from '../core/application/ResizeNode.js';
import { ExportFig } from '../core/application/ExportFig.js';
import { SaveSnapshot } from '../core/application/SaveSnapshot.js';
import { LoadSnapshot } from '../core/application/LoadSnapshot.js';
import { ServeAsset } from '../core/application/ServeAsset.js';
import { RunChatTurn } from '../core/application/RunChatTurn.js';
import { Undo } from '../core/application/Undo.js';
import { Redo } from '../core/application/Redo.js';

// ─── Composition root: adapters + use cases ──────────────────────────────
//
// Single instances live for the process lifetime. The session-store is
// stateful (in-memory id→Session map); every other adapter is stateless.
// Session-store sizing: SESSION_MAX_COUNT caps the in-memory map so an
// unbounded upload burst can't push the process past Node's heap limit
// (default 4 GB ≈ 130 sessions of metarich-size documentJson). 50 is
// generous for interactive use and tight enough for the long-lived
// e2e suite.
const sessionStore = new FsSessionStore({
  maxCount: Number(process.env.SESSION_MAX_COUNT ?? 50),
});
const repacker = new KiwiCodec(sessionStore);
const assetServer = new FsAssetServer(sessionStore);
const anthropicChat = new AnthropicChat();
const agentSdkChat = new AgentSdkChat();
const editJournal = new FsEditJournal(sessionStore);
const tools = new InProcessTools(sessionStore, (s, name, input) =>
  applyTool(s, name, input, editJournal),
);
const uploadFig = new UploadFig(sessionStore);
const editNodeUseCase = new EditNode(sessionStore, editJournal);
const overrideInstanceText = new OverrideInstanceText(sessionStore, editJournal);
const resizeNodeUseCase = new ResizeNode(sessionStore, editJournal);
const exportFigUseCase = new ExportFig(sessionStore, repacker);
const saveSnapshotUseCase = new SaveSnapshot(sessionStore);
const loadSnapshotUseCase = new LoadSnapshot(sessionStore);
const serveAssetUseCase = new ServeAsset(assetServer);
const runChatTurn = new RunChatTurn(sessionStore, tools, {
  subscription: agentSdkChat,
  apiKey: anthropicChat,
});
const undoUseCase = new Undo(sessionStore, editJournal);
const redoUseCase = new Redo(sessionStore, editJournal);

// `toHttpError` lives in adapters/driving/http/errors.ts now —
// each route file imports it locally.

const app = new Hono();
app.use('*', cors());

app.get('/', (c) => c.text('figma_reverse Tier 2 PoC backend up'));


// All HTTP routes are registered via the driving-http adapter — see
// server/adapters/driving/http/.
registerRoutes(app, {
  sessionStore,
  uploadFig,
  editNode: editNodeUseCase,
  overrideInstanceText,
  resizeNode: resizeNodeUseCase,
  exportFig: exportFigUseCase,
  saveSnapshot: saveSnapshotUseCase,
  loadSnapshot: loadSnapshotUseCase,
  serveAsset: serveAssetUseCase,
  runChatTurn,
  undo: undoUseCase,
  redo: redoUseCase,
});


// Cleanup: time-based eviction by session-id timestamp. Both knobs are
// env-driven so deployments / tests can tune them:
//   SESSION_GC_AGE_MS       — evict entries older than this. Default 1 h.
//   SESSION_GC_INTERVAL_MS  — how often to scan. Default 5 min.
// The e2e suite sets aggressive values to keep memory flat across its
// ~3.5 min runtime; production keeps the conservative defaults so a real
// user's editing session is never garbage-collected mid-edit.
const SESSION_GC_AGE_MS = Number(process.env.SESSION_GC_AGE_MS ?? 3600 * 1000);
const SESSION_GC_INTERVAL_MS = Number(
  process.env.SESSION_GC_INTERVAL_MS ?? 5 * 60 * 1000,
);
function gcSessions(): void {
  const now = Date.now();
  for (const id of Array.from(sessionStore.rawMap().keys())) {
    const ageMs = now - parseInt(id.slice(1, 1 + 13), 36);
    if (ageMs > SESSION_GC_AGE_MS) {
      void sessionStore.destroy(id);
    }
  }
}
setInterval(gcSessions, SESSION_GC_INTERVAL_MS);

const port = Number(process.env.PORT ?? 5274);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`figma_reverse web backend on http://localhost:${info.port}`);
  console.log(`(repo root: ${repoRoot})`);
});
