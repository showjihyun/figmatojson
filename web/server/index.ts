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
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 기존 figma_reverse 모듈 재사용 — 상위 src/ 에서 import.
// tsx watch 가 ESM 으로 처리.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

import { loadContainer } from '../../src/container.js';
import { decodeFigCanvas } from '../../src/decoder.js';
import { buildTree } from '../../src/tree.js';
import { tokenizePath, setPath } from '../core/domain/path.js';
import { findById } from '../core/domain/tree.js';
import { sniffImageMime as sniffImageMimeCore } from '../core/domain/image.js';
import { summarizeDoc as summarizeDocCore } from '../core/domain/summary.js';
import { FsSessionStore } from './adapters/driven/FsSessionStore.js';
import { KiwiCodec } from './adapters/driven/KiwiCodec.js';
import { FsAssetServer } from './adapters/driven/FsAssetServer.js';
import { InProcessTools } from './adapters/driven/InProcessTools.js';
import { AnthropicChat } from './adapters/driven/AnthropicChat.js';
import { AgentSdkChat } from './adapters/driven/AgentSdkChat.js';
import { UploadFig } from '../core/application/UploadFig.js';
import { EditNode } from '../core/application/EditNode.js';
import { OverrideInstanceText } from '../core/application/OverrideInstanceText.js';
import { ResizeNode } from '../core/application/ResizeNode.js';
import { ExportFig } from '../core/application/ExportFig.js';
import { SaveSnapshot } from '../core/application/SaveSnapshot.js';
import { LoadSnapshot } from '../core/application/LoadSnapshot.js';
import { ServeAsset } from '../core/application/ServeAsset.js';
import { RunChatTurn } from '../core/application/RunChatTurn.js';
import { NotFoundError, ValidationError, AuthRequiredError } from '../core/application/errors.js';
import { toClientNode, buildSymbolIndex } from '../core/domain/clientNode.js';
import type { Session as CoreSession } from '../core/domain/entities/Session.js';
import type { DocumentNode as CoreDocumentNode } from '../core/domain/entities/Document.js';
import {
  dumpStage1Container,
  dumpStage3Decompressed,
  dumpStage4Decoded,
  dumpStage5Tree,
} from '../../src/intermediate.js';
import { repack } from '../../src/repack.js';
import { parseVectorNetworkBlob, vectorNetworkToPath } from '../../src/vector.js';
import type { TreeNode } from '../../src/types.js';
import type Anthropic from '@anthropic-ai/sdk';

// Local aliases — the canonical types live in core/domain/entities/.
// Kept here so the rest of this file (which still references `Session`
// and `ClientNode` by name) doesn't need a sweep until phase 5.
type Session = CoreSession;
type ClientNode = CoreDocumentNode;

// `ClientNode` and `ComponentTextRef` live in core/domain/entities/Document.ts.
// Local alias for `ComponentTextRef` to keep callers below identical:
import type { ComponentTextRef } from '../core/domain/entities/Document.js';

// `VECTOR_TYPES`, `toClientNode`, `toClientChildForRender`, `collectTexts`,
// `collectTextOverridesFromInstance` all live in core/domain/clientNode.ts now.

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
const editNodeUseCase = new EditNode(sessionStore);
const overrideInstanceText = new OverrideInstanceText(sessionStore);
const resizeNodeUseCase = new ResizeNode(sessionStore);
const exportFigUseCase = new ExportFig(sessionStore, repacker);
const saveSnapshotUseCase = new SaveSnapshot(sessionStore);
const loadSnapshotUseCase = new LoadSnapshot(sessionStore);
const serveAssetUseCase = new ServeAsset(assetServer);
const runChatTurn = new RunChatTurn(sessionStore, tools, {
  subscription: agentSdkChat,
  apiKey: anthropicChat,
});

/** Translate use-case errors into the right Hono response. */
function toHttpError(c: Context, err: unknown): Response {
  if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
  if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
  if (err instanceof AuthRequiredError) return c.json({ error: err.message }, 401);
  return c.json({ error: (err as Error).message }, 500);
}

// Legacy alias — exposes the adapter's underlying map so any straggler
// route handlers (chat path) that still call `sessions.get`/`sessions.set`
// keep working until phase 5.
const sessions = sessionStore.rawMap();

const app = new Hono();
app.use('*', cors());

app.get('/', (c) => c.text('figma_reverse Tier 2 PoC backend up'));

app.post('/api/upload', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) {
    return c.json({ error: 'no file uploaded' }, 400);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const out = await uploadFig.execute({ bytes, origName: file.name });
    return c.json(out);
  } catch (err) {
    return toHttpError(c, err);
  }
});

app.get('/api/doc/:id', (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  return c.json(s.documentJson);
});

/**
 * Stream an extracted image asset for the canvas to render IMAGE fillPaints.
 *
 * Files in `extracted/01_container/images/` are named after their 20-byte
 * SHA-1 image hash (the same hash that appears in fillPaints[0].image.hash
 * inside the document). The hash param is the lowercase hex of those bytes.
 *
 * MIME type is sniffed from the magic-byte header — Figma containers can hold
 * PNG / JPEG / GIF / WebP fills.
 */
// `sniffImageMime` lives in core/domain/image.ts now — Buffer is an
// ArrayLike<number>, so the core impl works over the same shape.
const sniffImageMime = (buf: Buffer): string => sniffImageMimeCore(buf);

app.get('/api/asset/:id/:hash', async (c) => {
  try {
    const asset = await serveAssetUseCase.execute({
      sessionId: c.req.param('id'),
      hashHex: c.req.param('hash'),
    });
    return c.body(asset.bytes as unknown as ArrayBuffer, 200, {
      'Content-Type': asset.mime,
      'Content-Length': String(asset.bytes.byteLength),
      'Cache-Control': 'private, max-age=3600',
    });
  } catch (err) {
    return toHttpError(c, err);
  }
});

// `tokenizePath` and `setPath` live in core/domain/path.ts now.

app.patch('/api/doc/:id', async (c) => {
  try {
    const body = (await c.req.json()) as {
      nodeGuid: string;
      field: string;
      value: unknown;
    };
    const out = await editNodeUseCase.execute({
      sessionId: c.req.param('id'),
      nodeGuid: body.nodeGuid,
      field: body.field,
      value: body.value,
    });
    return c.json(out);
  } catch (err) {
    return toHttpError(c, err);
  }
});

app.post('/api/save/:id', async (c) => {
  try {
    const out = await exportFigUseCase.execute({ sessionId: c.req.param('id') });
    // Content-Disposition filename: HTTP headers are ByteString (≤ 0xFF). For
    // non-ASCII filenames (Korean / Chinese / etc.), use RFC 5987 filename*
    // encoding plus an ASCII fallback.
    const baseAscii = out.origName.replace(/\.fig$/, '').replace(/[^\x20-\x7e]/g, '_');
    const baseUtf8 = encodeURIComponent(out.origName.replace(/\.fig$/, ''));
    return new Response(out.bytes as unknown as ArrayBuffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition':
          `attachment; filename="${baseAscii}-edited.fig"; filename*=UTF-8''${baseUtf8}-edited.fig`,
        'X-Repack-Bytes': String(out.bytes.byteLength),
      },
    });
  } catch (err) {
    return toHttpError(c, err);
  }
});

// ─── Per-instance text override (no master mutation) ────────────────────────
//
// Mutates instance.symbolData.symbolOverrides to add/update an entry whose
// guidPath leads to the master text. Only THIS instance's render changes;
// other instances of the same master are untouched.
app.post('/api/instance-override/:id', async (c) => {
  try {
    const body = (await c.req.json()) as {
      instanceGuid: string;
      masterTextGuid: string;
      value: string;
    };
    const out = await overrideInstanceText.execute({
      sessionId: c.req.param('id'),
      instanceGuid: body.instanceGuid,
      masterTextGuid: body.masterTextGuid,
      value: body.value,
    });
    return c.json(out);
  } catch (err) {
    return toHttpError(c, err);
  }
});

// ─── Resize endpoint ────────────────────────────────────────────────────────
//
// Atomic patch of size.{x,y} + transform.{m02,m12} so the canvas can apply a
// single drag-end as one logical change.
app.post('/api/resize/:id', async (c) => {
  try {
    const body = (await c.req.json()) as {
      nodeGuid: string;
      x: number;
      y: number;
      w: number;
      h: number;
    };
    const out = await resizeNodeUseCase.execute({
      sessionId: c.req.param('id'),
      guid: body.nodeGuid,
      x: body.x,
      y: body.y,
      w: body.w,
      h: body.h,
    });
    return c.json(out);
  } catch (err) {
    return toHttpError(c, err);
  }
});

// ─── Save / Load editing session as a JSON snapshot ─────────────────────────
//
// A "session" snapshot is the current message.json plus session metadata —
// the entire editing state up to but excluding final .fig export. User can
// download it, return later, and resume editing without re-uploading the
// original .fig.
app.get('/api/session/:id/snapshot', async (c) => {
  try {
    const out = await saveSnapshotUseCase.execute({ sessionId: c.req.param('id') });
    return c.json(out);
  } catch (err) {
    return toHttpError(c, err);
  }
});

app.post('/api/session/load', async (c) => {
  try {
    const body = (await c.req.json()) as {
      version: number;
      origName: string;
      archiveVersion: number;
      schemaBinB64: string | null;
      messageJson: string;
      sidecars: Array<{ name: string; b64: string }>;
      archiveInfo?: Record<string, unknown>;
    };
    const out = await loadSnapshotUseCase.execute({
      version: body.version as 1,
      origName: body.origName,
      archiveVersion: body.archiveVersion,
      schemaBinB64: body.schemaBinB64,
      messageJson: body.messageJson,
      sidecars: body.sidecars,
      archiveInfo: body.archiveInfo ?? null,
    });
    return c.json(out);
  } catch (err) {
    return toHttpError(c, err);
  }
});

// ─── Claude AI chat proxy ──────────────────────────────────────────────────
//
// Browser sends user messages + selectedGuid + an x-anthropic-key header.
// Server makes a tool-using call to Claude with our editing primitives.
// The model decides what to mutate; we apply each tool call by reusing the
// existing PATCH / instance-override / resize handlers.
const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);

app.post('/api/chat/:id', async (c) => {
  try {
    const body = (await c.req.json()) as {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      selectedGuid?: string | null;
      model?: string;
      authMode?: 'subscription' | 'api-key';
    };
    const authMode: 'subscription' | 'api-key' =
      body.authMode === 'api-key' ? 'api-key' : 'subscription';
    const model =
      body.model && ALLOWED_MODELS.has(body.model) ? body.model : 'claude-opus-4-6';

    let apiKey: string | undefined;
    if (authMode === 'api-key') {
      const headerKey = c.req.header('x-anthropic-key') ?? '';
      if (!headerKey.startsWith('sk-ant-')) {
        return c.json({ error: 'missing or invalid x-anthropic-key header' }, 401);
      }
      apiKey = headerKey;
    }

    const out = await runChatTurn.execute({
      sessionId: c.req.param('id'),
      messages: body.messages,
      selectedGuid: body.selectedGuid ?? null,
      model,
      authMode,
      apiKey,
    });
    return c.json({ assistantText: out.assistantText, actions: out.actions });
  } catch (err) {
    return toHttpError(c, err);
  }
});

// `summarizeDoc` and `findById` live in core/domain/summary.ts and
// core/domain/tree.ts now — call sites import them directly.

/**
 * Subscription-mode chat — uses @anthropic-ai/claude-agent-sdk's `query()`,
 * which auto-discovers the user's Claude Code credentials. Our edit tools are
 * exposed as a small in-process MCP server; Claude calls them and we mutate
 * the session in the handlers.
 */
async function runSubscriptionChat(
  c: Context,
  s: Session,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  selectedGuid: string | null,
  model: string,
): Promise<Response> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { query, tool, createSdkMcpServer } = sdk;
  const z = (await import('zod')).z;

  const summary = summarizeDocCore(s.documentJson, selectedGuid);
  const actions: Array<{ tool: string; input: unknown }> = [];

  const wrap = <T extends Record<string, unknown>>(name: string, fn: (i: T) => Promise<void>) =>
    async (input: T) => {
      await fn(input);
      actions.push({ tool: name, input });
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    };

  const editServer = createSdkMcpServer({
    name: 'figma_editor',
    tools: [
      tool('set_text', 'Set textData.characters of a TEXT node (master-level — affects all instances).',
        { guid: z.string(), value: z.string() },
        wrap('set_text', async ({ guid, value }) => applyTool(s, 'set_text', { guid, value })),
      ),
      tool('override_instance_text', 'Set per-instance text override; master is untouched.',
        { instanceGuid: z.string(), masterTextGuid: z.string(), value: z.string() },
        wrap('override_instance_text', async ({ instanceGuid, masterTextGuid, value }) =>
          applyTool(s, 'override_instance_text', { instanceGuid, masterTextGuid, value })),
      ),
      tool('set_position', 'Move a node by setting transform.m02/m12.',
        { guid: z.string(), x: z.number(), y: z.number() },
        wrap('set_position', async ({ guid, x, y }) => applyTool(s, 'set_position', { guid, x, y })),
      ),
      tool('set_size', 'Resize a node by setting size.x and size.y.',
        { guid: z.string(), w: z.number(), h: z.number() },
        wrap('set_size', async ({ guid, w, h }) => applyTool(s, 'set_size', { guid, w, h })),
      ),
      tool('set_fill_color', 'Set fillPaints[0].color RGBA (each 0..1).',
        { guid: z.string(), r: z.number(), g: z.number(), b: z.number(), a: z.number() },
        wrap('set_fill_color', async ({ guid, r, g, b, a }) =>
          applyTool(s, 'set_fill_color', { guid, r, g, b, a })),
      ),
    ],
  });

  // Compose the prompt. Agent SDK takes a single string prompt (or async
  // iterable). We linearize the chat: prior turns become a transcript,
  // current user msg is appended, system prompt is prepended.
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  const prompt = `${transcript}\n\nApply edits via the figma_editor tools. Be concise.`;

  let assistantText = '';
  // Hard cap so a hung/uncredentialed Agent SDK call doesn't make the UI
  // stall indefinitely. Anything beyond this we surface as an error with
  // actionable next steps.
  const TIMEOUT_MS = 90_000;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  try {
    const q = query({
      prompt,
      options: {
        model,
        abortController,
        mcpServers: { figma_editor: editServer },
        // Restrict tools to only ours — no Bash/Read/Write etc.
        allowedTools: [
          'mcp__figma_editor__set_text',
          'mcp__figma_editor__override_instance_text',
          'mcp__figma_editor__set_position',
          'mcp__figma_editor__set_size',
          'mcp__figma_editor__set_fill_color',
        ],
        systemPrompt: `You are a design assistant editing a Figma file via tool calls.
Document summary:
${summary}`,
        maxTurns: 5,
        permissionMode: 'bypassPermissions',
      } as never,
    });
    for await (const msg of q) {
      if ((msg as Record<string, unknown>).type === 'assistant') {
        const m = msg as { message?: { content?: Array<{ type: string; text?: string }> } };
        for (const block of m.message?.content ?? []) {
          if (block.type === 'text' && block.text) assistantText += block.text;
        }
      }
    }
  } catch (err) {
    clearTimeout(timer);
    const aborted = abortController.signal.aborted;
    return c.json(
      {
        error: aborted
          ? `subscription chat timed out after ${TIMEOUT_MS / 1000}s. ` +
            `Likely cause: Claude Code is not logged in on this machine. ` +
            `Run 'claude login' in a terminal, or switch to API Key mode.`
          : `subscription chat failed: ${(err as Error).message}. ` +
            `Make sure Claude Code is installed and you've run 'claude login'. ` +
            `Or switch to API Key mode.`,
      },
      500,
    );
  } finally {
    clearTimeout(timer);
  }
  return c.json({ assistantText: assistantText || '(no text)', actions });
}

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

// Cleanup: simple LRU — drop sessions older than 1h on each upload (sufficient for PoC).
function gcSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    const ageMs = now - parseInt(id.slice(1, 1 + 13), 36);
    if (ageMs > 3600 * 1000) {
      rmSync(s.dir, { recursive: true, force: true });
      sessions.delete(id);
    }
  }
}
setInterval(gcSessions, 5 * 60 * 1000);

const port = Number(process.env.PORT ?? 5274);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`figma_reverse web backend on http://localhost:${info.port}`);
  console.log(`(repo root: ${repoRoot})`);
});
