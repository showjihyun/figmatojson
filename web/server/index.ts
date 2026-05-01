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
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
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
import { InMemoryEditJournal } from './adapters/driven/InMemoryEditJournal.js';
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
import type { Session } from '../core/domain/entities/Session.js';
import type { ComponentTextRef } from '../core/domain/entities/Document.js';

// ─── Composition root: adapters + use cases ──────────────────────────────
//
// Single instances live for the process lifetime. The session-store is
// stateful (in-memory id→Session map); every other adapter is stateless.
// `applyToolFn` is wired below — it threads the legacy `applyTool` function
// through the InProcessTools dispatcher until phase 5 replaces it.
const sessionStore = new FsSessionStore();
const repacker = new KiwiCodec(sessionStore);
const assetServer = new FsAssetServer(sessionStore);
const anthropicChat = new AnthropicChat();
const agentSdkChat = new AgentSdkChat();
const editJournal = new InMemoryEditJournal();
// Forward declaration — applyTool is defined later in this file. The closure
// captures a holder object so the assignment below is visible at call time
// without TS narrowing it to `never` after init.
type ApplyToolFn = (s: Session, name: string, input: Record<string, unknown>) => Promise<void>;
const applyToolHolder: { fn: ApplyToolFn | null } = { fn: null };
const tools = new InProcessTools(sessionStore, async (s, name, input) => {
  if (!applyToolHolder.fn) throw new Error('applyTool not wired yet');
  await applyToolHolder.fn(s, name, input);
});
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


applyToolHolder.fn = applyTool;
async function applyTool(s: Session, name: string, input: Record<string, unknown>): Promise<void> {
  // Dispatch to the local handlers — same code paths that the inspector uses.
  // We bypass HTTP here for efficiency.
  const fakeReq = (b: unknown): Request => new Request('http://x/', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
  void fakeReq;
  const messagePath = join(s.dir, 'extracted', '04_decoded', 'message.json');
  const raw = readFileSync(messagePath, 'utf8');
  const msg = JSON.parse(raw) as { nodeChanges?: Array<Record<string, unknown>> };
  const findNode = (guid: string): Record<string, unknown> | undefined => msg.nodeChanges?.find((n) => {
    const g = n.guid as { sessionID?: number; localID?: number } | undefined;
    return g && `${g.sessionID}:${g.localID}` === guid;
  });
  const mirrorClient = (guid: string, mutator: (n: Record<string, unknown>) => void): void => {
    function walk(n: Record<string, unknown>): boolean {
      const g = n.guid as { sessionID: number; localID: number } | undefined;
      if (g && `${g.sessionID}:${g.localID}` === guid) { mutator(n); return true; }
      const ch = n.children as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(ch)) for (const c of ch) if (walk(c)) return true;
      return false;
    }
    walk(s.documentJson as unknown as Record<string, unknown>);
  };

  switch (name) {
    case 'set_text': {
      const node = findNode(String(input.guid));
      if (!node) throw new Error(`node ${input.guid} not found`);
      ((node.textData ??= {}) as Record<string, unknown>).characters = String(input.value);
      writeFileSync(messagePath, JSON.stringify(msg));
      mirrorClient(String(input.guid), (n) => { ((n.textData ??= {}) as Record<string, unknown>).characters = String(input.value); });
      // Refresh component-text snapshots
      function refresh(n: Record<string, unknown>): void {
        const refs = n._componentTexts as ComponentTextRef[] | undefined;
        if (Array.isArray(refs)) for (const r of refs) if (r.guid === input.guid) r.characters = String(input.value);
        const ch = n.children as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(ch)) for (const c of ch) refresh(c);
      }
      refresh(s.documentJson as unknown as Record<string, unknown>);
      break;
    }
    case 'override_instance_text': {
      const inst = findNode(String(input.instanceGuid));
      if (!inst) throw new Error(`INSTANCE ${input.instanceGuid} not found`);
      const [ms, ml] = String(input.masterTextGuid).split(':').map((x) => parseInt(x, 10));
      inst.symbolData = (inst.symbolData ?? {}) as Record<string, unknown>;
      const sd = inst.symbolData as { symbolOverrides?: Array<Record<string, unknown>> };
      sd.symbolOverrides = sd.symbolOverrides ?? [];
      let entry = sd.symbolOverrides.find((o) => {
        const g = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
        return Array.isArray(g) && g.length === 1 && g[0]?.sessionID === ms && g[0]?.localID === ml;
      });
      if (!entry) {
        entry = {
          guidPath: { guids: [{ sessionID: ms, localID: ml }] },
          textData: { characters: String(input.value), lines: [{ lineType: 'PLAIN', styleId: 0, indentationLevel: 0, sourceDirectionality: 'AUTO', listStartOffset: 0, isFirstLineOfList: false }] },
        };
        sd.symbolOverrides.push(entry);
      } else {
        ((entry.textData ??= {}) as Record<string, unknown>).characters = String(input.value);
      }
      writeFileSync(messagePath, JSON.stringify(msg));
      mirrorClient(String(input.instanceGuid), (n) => {
        const m = (n._instanceOverrides ??= {}) as Record<string, string>;
        m[String(input.masterTextGuid)] = String(input.value);
      });
      break;
    }
    case 'set_position': {
      const node = findNode(String(input.guid));
      if (!node) throw new Error(`node ${input.guid} not found`);
      const t = (node.transform ??= {}) as Record<string, number>;
      t.m02 = Number(input.x); t.m12 = Number(input.y);
      writeFileSync(messagePath, JSON.stringify(msg));
      mirrorClient(String(input.guid), (n) => {
        const t2 = (n.transform ??= {}) as Record<string, number>;
        t2.m02 = Number(input.x); t2.m12 = Number(input.y);
      });
      break;
    }
    case 'set_size': {
      const node = findNode(String(input.guid));
      if (!node) throw new Error(`node ${input.guid} not found`);
      node.size = { x: Math.max(1, Number(input.w)), y: Math.max(1, Number(input.h)) };
      writeFileSync(messagePath, JSON.stringify(msg));
      mirrorClient(String(input.guid), (n) => {
        n.size = { x: Math.max(1, Number(input.w)), y: Math.max(1, Number(input.h)) };
      });
      break;
    }
    case 'set_fill_color': {
      const node = findNode(String(input.guid));
      if (!node) throw new Error(`node ${input.guid} not found`);
      const fps = (node.fillPaints as Array<Record<string, unknown>> | undefined) ?? [];
      const first = fps[0] ?? { type: 'SOLID', visible: true, opacity: 1 };
      first.color = { r: Number(input.r), g: Number(input.g), b: Number(input.b), a: Number(input.a) };
      fps[0] = first;
      node.fillPaints = fps;
      writeFileSync(messagePath, JSON.stringify(msg));
      mirrorClient(String(input.guid), (n) => {
        const fps2 = (n.fillPaints as Array<Record<string, unknown>> | undefined) ?? [];
        const f0 = fps2[0] ?? { type: 'SOLID', visible: true, opacity: 1 };
        f0.color = { r: Number(input.r), g: Number(input.g), b: Number(input.b), a: Number(input.a) };
        fps2[0] = f0;
        n.fillPaints = fps2;
      });
      break;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// Cleanup: simple LRU — drop sessions older than 1h. Uses the FsSessionStore's
// raw map for iteration; destruction goes through the adapter so the working
// directory is cleaned up too.
function gcSessions(): void {
  const now = Date.now();
  for (const id of Array.from(sessionStore.rawMap().keys())) {
    const ageMs = now - parseInt(id.slice(1, 1 + 13), 36);
    if (ageMs > 3600 * 1000) {
      void sessionStore.destroy(id);
    }
  }
}
setInterval(gcSessions, 5 * 60 * 1000);

const port = Number(process.env.PORT ?? 5274);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`figma_reverse web backend on http://localhost:${info.port}`);
  console.log(`(repo root: ${repoRoot})`);
});
