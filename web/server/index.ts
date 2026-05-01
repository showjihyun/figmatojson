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
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
import {
  dumpStage1Container,
  dumpStage3Decompressed,
  dumpStage4Decoded,
  dumpStage5Tree,
} from '../../src/intermediate.js';
import { repack } from '../../src/repack.js';
import type { TreeNode } from '../../src/types.js';

interface Session {
  id: string;
  dir: string;          // tmp working dir with extracted/ structure
  origName: string;
  archiveVersion: number;
  documentJson: ClientNode;
}

/**
 * React-friendly view of a TreeNode — spreads `data` fields onto the node so
 * `node.textData.characters`, `node.fillPaints`, etc. work directly without
 * indirection through `.raw`. Drops binary fields (Uint8Array → null) and
 * cyclical references; keeps everything the canvas / inspector cares about.
 */
interface ClientNode {
  id: string;          // guidStr
  guid: { sessionID: number; localID: number };
  type: string;
  name?: string;
  children?: ClientNode[];
  [k: string]: unknown;
}

function toClientNode(n: TreeNode): ClientNode {
  const data = (n.data ?? {}) as Record<string, unknown>;
  const out: ClientNode = {
    id: n.guidStr,
    guid: n.guid,
    type: n.type,
    name: n.name,
    children: n.children.map(toClientNode),
  };
  for (const k of Object.keys(data)) {
    if (k === 'guid' || k === 'type' || k === 'name') continue;
    const v = data[k];
    // Drop Uint8Array / large binary fields — Konva-side rendering doesn't need them
    if (v instanceof Uint8Array) continue;
    if (k === 'derivedSymbolData' || k === 'derivedTextData') continue;
    if (k === 'fillGeometry' || k === 'strokeGeometry') continue;
    if (k === 'vectorData') continue;
    out[k] = v;
  }
  return out;
}
const sessions = new Map<string, Session>();

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
  const tmpDir = mkdtempSync(join(tmpdir(), 'figrev-web-'));
  try {
    // loadContainer expects a file path; write the upload to disk first.
    const inPath = join(tmpDir, 'in.fig');
    writeFileSync(inPath, bytes);
    const container = loadContainer(inPath);
    const decoded = decodeFigCanvas(container.canvasFig);
    const tree = buildTree(decoded.message);
    if (!tree.document) throw new Error('no DOCUMENT root in tree');

    // dump intermediates so repack(--mode json) can later rebuild
    const intOpts = {
      enabled: true,
      dir: join(tmpDir, 'extracted'),
      includeFullMessage: true,
      minify: true,
    };
    dumpStage1Container(intOpts, container);
    dumpStage3Decompressed(intOpts, decoded);
    dumpStage4Decoded(intOpts, decoded);
    dumpStage5Tree(intOpts, tree);

    const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const documentJson = toClientNode(tree.document);
    sessions.set(id, {
      id,
      dir: tmpDir,
      origName: file.name,
      archiveVersion: decoded.archiveVersion,
      documentJson,
    });
    return c.json({
      sessionId: id,
      origName: file.name,
      pageCount: tree.document.children.filter((n) => n.type === 'CANVAS').length,
      nodeCount: tree.allNodes.size,
    });
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get('/api/doc/:id', (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  return c.json(s.documentJson);
});

app.patch('/api/doc/:id', async (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const body = (await c.req.json()) as {
    nodeGuid: string;
    field: string;          // e.g. "textData.characters" or "fillPaints[0].color.r"
    value: unknown;
  };
  // Apply edit to message.json on disk so repack picks it up.
  // We use a path-based mutation on the JSON text (simple but effective for PoC).
  const messagePath = join(s.dir, 'extracted', '04_decoded', 'message.json');
  if (!existsSync(messagePath)) return c.json({ error: 'message.json missing' }, 500);
  const raw = readFileSync(messagePath, 'utf8');
  const msg = JSON.parse(raw) as { nodeChanges?: Array<Record<string, unknown>> };
  const node = msg.nodeChanges?.find(
    (n) => `${(n.guid as { sessionID: number; localID: number })?.sessionID}:${(n.guid as { sessionID: number; localID: number })?.localID}` === body.nodeGuid,
  );
  if (!node) return c.json({ error: `node ${body.nodeGuid} not found` }, 404);
  // Path navigation: "textData.characters" → node.textData.characters
  const segments = body.field.split('.');
  let cur: Record<string, unknown> | undefined = node;
  for (let i = 0; i < segments.length - 1; i++) {
    cur = cur?.[segments[i]!] as Record<string, unknown> | undefined;
    if (cur === undefined) return c.json({ error: `path ${segments.slice(0, i + 1).join('.')} undefined` }, 400);
  }
  const lastKey = segments[segments.length - 1]!;
  cur[lastKey] = body.value;
  writeFileSync(messagePath, JSON.stringify(msg));

  // Update the in-memory documentJson too (so subsequent /doc fetches reflect the edit)
  // Walk our tree-backed normalized doc and patch the matching node.
  function walk(n: Record<string, unknown>): boolean {
    const guid = n.guid as { sessionID: number; localID: number } | undefined;
    if (guid && `${guid.sessionID}:${guid.localID}` === body.nodeGuid) {
      let p: Record<string, unknown> = n;
      for (let i = 0; i < segments.length - 1; i++) {
        p = (p[segments[i]!] ??= {}) as Record<string, unknown>;
      }
      p[lastKey] = body.value;
      return true;
    }
    const children = n.children as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(children)) {
      for (const c of children) if (walk(c)) return true;
    }
    return false;
  }
  walk(s.documentJson as unknown as Record<string, unknown>);

  return c.json({ ok: true });
});

app.post('/api/save/:id', async (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const outFig = join(s.dir, 'out.fig');
  const result = await repack(join(s.dir, 'extracted'), outFig, { mode: 'json' });
  const bytes = readFileSync(outFig);
  // Content-Disposition filename: HTTP headers are ByteString (≤ 0xFF). For
  // non-ASCII filenames (Korean / Chinese / etc.), use RFC 5987 filename*
  // encoding plus an ASCII fallback.
  const baseAscii = s.origName.replace(/\.fig$/, '').replace(/[^\x20-\x7e]/g, '_');
  const baseUtf8 = encodeURIComponent(s.origName.replace(/\.fig$/, ''));
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition':
        `attachment; filename="${baseAscii}-edited.fig"; filename*=UTF-8''${baseUtf8}-edited.fig`,
      'X-Repack-Bytes': String(result.outBytes ?? bytes.byteLength),
    },
  });
});

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
