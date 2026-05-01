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
import { parseVectorNetworkBlob, vectorNetworkToPath } from '../../src/vector.js';
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
  _path?: string;      // pre-decoded SVG path (vector nodes)
  _componentTexts?: ComponentTextRef[];  // editable text refs inside an INSTANCE's master
  [k: string]: unknown;
}

interface ComponentTextRef {
  guid: string;        // master text node's guidStr (e.g. "11:506")
  name?: string;       // display name
  path: string;        // dotted ancestor names ("Button / Label / Text")
  characters: string;  // current text content
}

const VECTOR_TYPES = new Set([
  'VECTOR',
  'STAR',
  'LINE',
  'ELLIPSE',
  'REGULAR_POLYGON',
  'BOOLEAN_OPERATION',
  'ROUNDED_RECTANGLE',
]);

function toClientNode(
  n: TreeNode,
  blobs: Array<{ bytes: Uint8Array }>,
  symbolIndex: Map<string, TreeNode>,
): ClientNode {
  const data = (n.data ?? {}) as Record<string, unknown>;
  const out: ClientNode = {
    id: n.guidStr,
    guid: n.guid,
    type: n.type,
    name: n.name,
    children: n.children.map((c) => toClientNode(c, blobs, symbolIndex)),
  };

  // Pre-decode the vectorNetworkBlob into an SVG path string so the canvas
  // can render real shapes via Konva.Path. Without this, every vector
  // becomes a colored bbox rectangle (no shape fidelity).
  if (VECTOR_TYPES.has(n.type)) {
    const vd = data.vectorData as { vectorNetworkBlob?: number } | undefined;
    if (vd && typeof vd.vectorNetworkBlob === 'number') {
      const blob = blobs[vd.vectorNetworkBlob];
      if (blob?.bytes) {
        const vn = parseVectorNetworkBlob(blob.bytes);
        if (vn) out._path = vectorNetworkToPath(vn);
      }
    }
  }

  // INSTANCE: collect editable TEXT descendants from the master tree so the
  // Inspector can show a "Component Texts" panel — the user's primary entry
  // point for changing button labels, headings, etc., when the instance
  // itself is empty (children rendered via master expansion at render time
  // in pen-export, not exposed to the client doc).
  if (n.type === 'INSTANCE' && n.children.length === 0) {
    const sd = data.symbolData as { symbolID?: { sessionID?: number; localID?: number } } | undefined;
    const sid = sd?.symbolID;
    if (sid && typeof sid.sessionID === 'number' && typeof sid.localID === 'number') {
      const masterKey = `${sid.sessionID}:${sid.localID}`;
      const master = symbolIndex.get(masterKey);
      if (master) {
        const texts: ComponentTextRef[] = [];
        collectTexts(master, [], texts, symbolIndex, 0);
        if (texts.length > 0) out._componentTexts = texts;
      }
    }
  }

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

/** Walk a master tree and collect every TEXT descendant (with breadcrumb path).
 *  Recurses through nested INSTANCEs by following their master via symbolIndex
 *  (capped at depth 6 to avoid pathological nesting). */
function collectTexts(
  n: TreeNode,
  ancestors: string[],
  out: ComponentTextRef[],
  symbolIndex: Map<string, TreeNode>,
  depth: number,
): void {
  if (depth > 6) return;
  const data = n.data as Record<string, unknown>;
  if (n.type === 'TEXT') {
    const td = data.textData as { characters?: string } | undefined;
    out.push({
      guid: n.guidStr,
      name: n.name,
      path: ancestors.join(' / '),
      characters: td?.characters ?? '',
    });
    return;
  }
  // Descend into children
  for (const c of n.children) {
    collectTexts(c, [...ancestors, c.name ?? c.type], out, symbolIndex, depth + 1);
  }
  // Nested INSTANCE → resolve via master and descend
  if (n.type === 'INSTANCE' && n.children.length === 0) {
    const sd = data.symbolData as { symbolID?: { sessionID?: number; localID?: number } } | undefined;
    const sid = sd?.symbolID;
    if (sid && typeof sid.sessionID === 'number' && typeof sid.localID === 'number') {
      const master = symbolIndex.get(`${sid.sessionID}:${sid.localID}`);
      if (master) {
        for (const c of master.children) {
          collectTexts(c, [...ancestors, c.name ?? c.type], out, symbolIndex, depth + 1);
        }
      }
    }
  }
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
    const blobs = (decoded.message as { blobs?: Array<{ bytes: Uint8Array }> }).blobs ?? [];
    // SymbolIndex by guidStr — needed to resolve INSTANCE → master for component-text panels.
    const symbolIndex = new Map<string, TreeNode>();
    for (const node of tree.allNodes.values()) {
      if (node.type === 'SYMBOL' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
        symbolIndex.set(node.guidStr, node);
      }
      // Also accept FRAME masters that INSTANCEs may reference (rare but possible).
      symbolIndex.set(node.guidStr, node);
    }
    const documentJson = toClientNode(tree.document, blobs, symbolIndex);
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

/**
 * Path tokenizer — supports dotted keys + bracket indices:
 *   "textData.characters"        → ["textData", "characters"]
 *   "fillPaints[0].color.r"      → ["fillPaints", 0, "color", "r"]
 *   "stack.padding[2]"           → ["stack", "padding", 2]
 */
function tokenizePath(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[2] !== undefined) tokens.push(parseInt(m[2], 10));
    else if (m[1] !== undefined) tokens.push(m[1]);
  }
  return tokens;
}

/** Walk into `obj` along path tokens, creating intermediate {}/ [] as needed. */
function setPath(obj: any, tokens: Array<string | number>, value: unknown): boolean {
  let cur = obj;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1]!;
    if (cur[t] == null) cur[t] = typeof next === 'number' ? [] : {};
    cur = cur[t];
  }
  cur[tokens[tokens.length - 1]!] = value;
  return true;
}

app.patch('/api/doc/:id', async (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const body = (await c.req.json()) as {
    nodeGuid: string;
    field: string;          // e.g. "textData.characters" or "fillPaints[0].color.r"
    value: unknown;
  };
  const messagePath = join(s.dir, 'extracted', '04_decoded', 'message.json');
  if (!existsSync(messagePath)) return c.json({ error: 'message.json missing' }, 500);
  const raw = readFileSync(messagePath, 'utf8');
  const msg = JSON.parse(raw) as { nodeChanges?: Array<Record<string, unknown>> };
  const node = msg.nodeChanges?.find(
    (n) => `${(n.guid as { sessionID: number; localID: number })?.sessionID}:${(n.guid as { sessionID: number; localID: number })?.localID}` === body.nodeGuid,
  );
  if (!node) return c.json({ error: `node ${body.nodeGuid} not found` }, 404);

  const tokens = tokenizePath(body.field);
  if (tokens.length === 0) return c.json({ error: 'empty field path' }, 400);
  setPath(node, tokens, body.value);
  writeFileSync(messagePath, JSON.stringify(msg));

  // Mirror the patch on the in-memory client doc so subsequent /doc fetches reflect the edit.
  function walk(n: Record<string, unknown>): boolean {
    const guid = n.guid as { sessionID: number; localID: number } | undefined;
    if (guid && `${guid.sessionID}:${guid.localID}` === body.nodeGuid) {
      setPath(n, tokens, body.value);
      return true;
    }
    const children = n.children as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(children)) {
      for (const c of children) if (walk(c)) return true;
    }
    return false;
  }
  walk(s.documentJson as unknown as Record<string, unknown>);

  // If the patched field is textData.characters on a master text node, update
  // every INSTANCE's `_componentTexts[]` snapshot whose entry references that
  // master GUID. This keeps the inspector's component-text list fresh after
  // an edit (otherwise it shows the pre-edit value until a re-upload).
  if (body.field === 'textData.characters' && typeof body.value === 'string') {
    const newChars = body.value;
    function refreshInstances(n: Record<string, unknown>): void {
      const refs = n._componentTexts as ComponentTextRef[] | undefined;
      if (Array.isArray(refs)) {
        for (const r of refs) {
          if (r.guid === body.nodeGuid) r.characters = newChars;
        }
      }
      const ch = n.children as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(ch)) for (const c of ch) refreshInstances(c);
    }
    refreshInstances(s.documentJson as unknown as Record<string, unknown>);
  }

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
