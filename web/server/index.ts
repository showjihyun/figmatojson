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
  /**
   * For INSTANCE nodes that have no native children, this carries the
   * MASTER's expanded subtree so the canvas can actually render the
   * component's contents (icons, labels, etc.). Each rendered child keeps
   * its master GUID so edits / clicks behave the same as editing the master,
   * but a `_isInstanceChild: true` marker tells the client this is a virtual
   * render-only branch (don't recurse into "children of children of an
   * instance" forever).
   */
  _renderChildren?: ClientNode[];
  _isInstanceChild?: boolean;
  /** When this INSTANCE child rendering applies a per-instance text override,
   *  this is the override text (replaces the master's textData.characters
   *  during render). Edits via the overlay still flow through the parent
   *  INSTANCE's symbolOverrides. */
  _renderTextOverride?: string;
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

  // INSTANCE: collect editable TEXT descendants + attach the master's
  // expanded subtree as `_renderChildren` so the canvas can show actual
  // button shapes / icons / labels (without these the instance is just an
  // empty colored rectangle).
  if (n.type === 'INSTANCE' && n.children.length === 0) {
    const sd = data.symbolData as {
      symbolID?: { sessionID?: number; localID?: number };
      symbolOverrides?: Array<Record<string, unknown>>;
    } | undefined;
    const sid = sd?.symbolID;
    if (sid && typeof sid.sessionID === 'number' && typeof sid.localID === 'number') {
      const masterKey = `${sid.sessionID}:${sid.localID}`;
      const master = symbolIndex.get(masterKey);
      if (master) {
        const texts: ComponentTextRef[] = [];
        collectTexts(master, [], texts, symbolIndex, 0);
        if (texts.length > 0) out._componentTexts = texts;

        // Build the override map BEFORE expanding so render-time text
        // substitutions can happen for each child node.
        const textOverrides = collectTextOverridesFromInstance(sd?.symbolOverrides);
        const expanded = master.children.map((c) =>
          toClientChildForRender(c, blobs, symbolIndex, textOverrides, 0),
        );
        if (expanded.length > 0) out._renderChildren = expanded;
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

/**
 * Pull text overrides out of an INSTANCE's symbolOverrides[]. Each override
 * targets a master text by its single-step guidPath. Returns a map of
 * "sess:local" → override-text, keyed by the master text node's guidStr.
 */
function collectTextOverridesFromInstance(
  overrides: Array<Record<string, unknown>> | undefined,
): Map<string, string> {
  const m = new Map<string, string>();
  if (!Array.isArray(overrides)) return m;
  for (const o of overrides) {
    const td = o.textData as { characters?: string } | undefined;
    if (typeof td?.characters !== 'string') continue;
    const guids = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
    if (!Array.isArray(guids) || guids.length === 0) continue;
    // Use the LAST guid in the path — that's the actual text node target.
    const last = guids[guids.length - 1]!;
    if (typeof last.sessionID !== 'number' || typeof last.localID !== 'number') continue;
    m.set(`${last.sessionID}:${last.localID}`, td.characters);
  }
  return m;
}

/**
 * Render-only version of toClientNode used inside INSTANCE expansion. Keeps
 * the master's GUIDs (so editing still targets the master node), tags every
 * descendant with `_isInstanceChild: true`, and applies any per-instance
 * text overrides at render time so the canvas reflects them immediately.
 *
 * Recursion is depth-limited (8) and stops at nested INSTANCEs (their own
 * `_renderChildren` will be filled in when toClientNode visits them
 * separately as part of the main tree walk).
 */
function toClientChildForRender(
  n: TreeNode,
  blobs: Array<{ bytes: Uint8Array }>,
  symbolIndex: Map<string, TreeNode>,
  textOverrides: Map<string, string>,
  depth: number,
): ClientNode {
  if (depth > 8) {
    return { id: n.guidStr, guid: n.guid, type: n.type, name: n.name, _isInstanceChild: true };
  }
  const data = (n.data ?? {}) as Record<string, unknown>;
  const out: ClientNode = {
    id: n.guidStr,
    guid: n.guid,
    type: n.type,
    name: n.name,
    _isInstanceChild: true,
    children: n.children.map((c) => toClientChildForRender(c, blobs, symbolIndex, textOverrides, depth + 1)),
  };
  // Attach SVG path for vector descendants
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
  // Apply per-instance text override at render time
  if (n.type === 'TEXT') {
    const ov = textOverrides.get(n.guidStr);
    if (typeof ov === 'string') out._renderTextOverride = ov;
  }
  // Nested INSTANCE inside the master tree — recurse into ITS master too,
  // applying the OUTER overrides (single-level for PoC; nested overrides
  // would need path-aware filtering).
  if (n.type === 'INSTANCE' && n.children.length === 0) {
    const sd = data.symbolData as { symbolID?: { sessionID?: number; localID?: number } } | undefined;
    const sid = sd?.symbolID;
    if (sid && typeof sid.sessionID === 'number' && typeof sid.localID === 'number') {
      const master = symbolIndex.get(`${sid.sessionID}:${sid.localID}`);
      if (master) {
        out._renderChildren = master.children.map((c) =>
          toClientChildForRender(c, blobs, symbolIndex, textOverrides, depth + 1),
        );
      }
    }
  }
  // Carry over the data fields the canvas / inspector needs
  for (const k of Object.keys(data)) {
    if (k === 'guid' || k === 'type' || k === 'name') continue;
    const v = data[k];
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

app.get('/api/asset/:id/:hash', (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const hash = c.req.param('hash');
  // Reject anything that isn't a 40-char lowercase hex string — defensive
  // against path traversal even though we then join under a fixed prefix.
  if (!/^[0-9a-f]{40}$/.test(hash)) return c.json({ error: 'invalid hash' }, 400);
  const assetPath = join(s.dir, 'extracted', '01_container', 'images', hash);
  if (!existsSync(assetPath)) return c.json({ error: 'asset not found' }, 404);
  const buf = readFileSync(assetPath);
  return c.body(buf as unknown as ArrayBuffer, 200, {
    'Content-Type': sniffImageMime(buf),
    'Content-Length': String(buf.byteLength),
    'Cache-Control': 'private, max-age=3600',
  });
});

// `tokenizePath` and `setPath` live in core/domain/path.ts now.

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

// ─── Per-instance text override (no master mutation) ────────────────────────
//
// Mutates instance.symbolData.symbolOverrides to add/update an entry whose
// guidPath leads to the master text. Only THIS instance's render changes;
// other instances of the same master are untouched.
app.post('/api/instance-override/:id', async (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const body = (await c.req.json()) as {
    instanceGuid: string;
    masterTextGuid: string;
    value: string;
  };
  const messagePath = join(s.dir, 'extracted', '04_decoded', 'message.json');
  if (!existsSync(messagePath)) return c.json({ error: 'message.json missing' }, 500);
  const raw = readFileSync(messagePath, 'utf8');
  const msg = JSON.parse(raw) as { nodeChanges?: Array<Record<string, unknown>> };
  const inst = msg.nodeChanges?.find((n) => {
    const g = n.guid as { sessionID?: number; localID?: number } | undefined;
    return g && `${g.sessionID}:${g.localID}` === body.instanceGuid;
  });
  if (!inst) return c.json({ error: `INSTANCE ${body.instanceGuid} not found` }, 404);

  const [ms, ml] = body.masterTextGuid.split(':').map((s2) => parseInt(s2, 10));
  if (!Number.isInteger(ms) || !Number.isInteger(ml)) {
    return c.json({ error: `invalid masterTextGuid ${body.masterTextGuid}` }, 400);
  }

  // Ensure symbolData.symbolOverrides exists
  inst.symbolData = (inst.symbolData ?? {}) as Record<string, unknown>;
  const sd = inst.symbolData as { symbolOverrides?: Array<Record<string, unknown>> };
  sd.symbolOverrides = sd.symbolOverrides ?? [];

  // Find an existing override targeting this master text (single-step path)
  let entry = sd.symbolOverrides.find((o) => {
    const guids = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
    return Array.isArray(guids) && guids.length === 1 && guids[0]?.sessionID === ms && guids[0]?.localID === ml;
  });
  if (!entry) {
    entry = {
      guidPath: { guids: [{ sessionID: ms, localID: ml }] },
      textData: { characters: body.value, lines: [{ lineType: 'PLAIN', styleId: 0, indentationLevel: 0, sourceDirectionality: 'AUTO', listStartOffset: 0, isFirstLineOfList: false }] },
    };
    sd.symbolOverrides.push(entry);
  } else {
    const td = (entry.textData ?? {}) as { characters?: string; lines?: unknown };
    td.characters = body.value;
    if (!td.lines) td.lines = [{ lineType: 'PLAIN', styleId: 0, indentationLevel: 0, sourceDirectionality: 'AUTO', listStartOffset: 0, isFirstLineOfList: false }];
    entry.textData = td;
  }
  writeFileSync(messagePath, JSON.stringify(msg));

  // Mirror in client doc — store an _instanceOverrides map keyed by master text guid.
  function walk(n: Record<string, unknown>): boolean {
    const guid = n.guid as { sessionID: number; localID: number } | undefined;
    if (guid && `${guid.sessionID}:${guid.localID}` === body.instanceGuid) {
      const overrides = (n._instanceOverrides ??= {}) as Record<string, string>;
      overrides[body.masterTextGuid] = body.value;
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

// ─── Resize endpoint ────────────────────────────────────────────────────────
//
// Atomic patch of size.{x,y} + transform.{m02,m12} so the canvas can apply a
// single drag-end as one logical change.
app.post('/api/resize/:id', async (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const body = (await c.req.json()) as {
    nodeGuid: string;
    x: number;
    y: number;
    w: number;
    h: number;
  };
  const messagePath = join(s.dir, 'extracted', '04_decoded', 'message.json');
  if (!existsSync(messagePath)) return c.json({ error: 'message.json missing' }, 500);
  const raw = readFileSync(messagePath, 'utf8');
  const msg = JSON.parse(raw) as { nodeChanges?: Array<Record<string, unknown>> };
  const node = msg.nodeChanges?.find((n) => {
    const g = n.guid as { sessionID?: number; localID?: number } | undefined;
    return g && `${g.sessionID}:${g.localID}` === body.nodeGuid;
  });
  if (!node) return c.json({ error: `node ${body.nodeGuid} not found` }, 404);
  const transform = ((node.transform as Record<string, number> | undefined) ?? {}) as Record<string, number>;
  transform.m02 = body.x;
  transform.m12 = body.y;
  // Preserve orthonormal (m00/m11=1, m01/m10=0) — minimal change.
  if (typeof transform.m00 !== 'number') transform.m00 = 1;
  if (typeof transform.m11 !== 'number') transform.m11 = 1;
  if (typeof transform.m01 !== 'number') transform.m01 = 0;
  if (typeof transform.m10 !== 'number') transform.m10 = 0;
  node.transform = transform;
  node.size = { x: Math.max(1, body.w), y: Math.max(1, body.h) };
  writeFileSync(messagePath, JSON.stringify(msg));

  function walk(n: Record<string, unknown>): boolean {
    const guid = n.guid as { sessionID: number; localID: number } | undefined;
    if (guid && `${guid.sessionID}:${guid.localID}` === body.nodeGuid) {
      const t = (n.transform ??= {}) as Record<string, number>;
      t.m02 = body.x; t.m12 = body.y;
      n.size = { x: Math.max(1, body.w), y: Math.max(1, body.h) };
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

// ─── Save / Load editing session as a JSON snapshot ─────────────────────────
//
// A "session" snapshot is the current message.json plus session metadata —
// the entire editing state up to but excluding final .fig export. User can
// download it, return later, and resume editing without re-uploading the
// original .fig.
app.get('/api/session/:id/snapshot', (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const messagePath = join(s.dir, 'extracted', '04_decoded', 'message.json');
  const schemaBinPath = join(s.dir, 'extracted', '03_decompressed', 'schema.kiwi.bin');
  const containerInfoPath = join(s.dir, 'extracted', '01_container');
  if (!existsSync(messagePath)) return c.json({ error: 'message.json missing' }, 500);
  // Read and base64 the binary parts so the snapshot is JSON-portable.
  const messageJson = readFileSync(messagePath, 'utf8');
  const schemaBin = existsSync(schemaBinPath) ? readFileSync(schemaBinPath).toString('base64') : null;
  const archiveInfoPath = join(s.dir, 'extracted', '02_archive', '_info.json');
  const archiveInfo = existsSync(archiveInfoPath) ? JSON.parse(readFileSync(archiveInfoPath, 'utf8')) : null;
  // Sidecar files (meta.json, thumbnail.png, images/*) — preserve as base64
  const sidecars: Array<{ name: string; b64: string }> = [];
  function collect(dirPath: string, prefix: string): void {
    if (!existsSync(dirPath)) return;
    for (const f of readdirSync(dirPath).sort()) {
      const p = join(dirPath, f);
      if (statSync(p).isDirectory()) collect(p, `${prefix}${f}/`);
      else sidecars.push({ name: `${prefix}${f}`, b64: readFileSync(p).toString('base64') });
    }
  }
  collect(containerInfoPath, '');
  return c.json({
    version: 1,
    origName: s.origName,
    archiveVersion: s.archiveVersion,
    archiveInfo,
    schemaBinB64: schemaBin,
    messageJson,
    sidecars,
  });
});

app.post('/api/session/load', async (c) => {
  const body = (await c.req.json()) as {
    version: number;
    origName: string;
    archiveVersion: number;
    schemaBinB64: string | null;
    messageJson: string;
    sidecars: Array<{ name: string; b64: string }>;
    archiveInfo?: Record<string, unknown>;
  };
  if (body.version !== 1) return c.json({ error: 'unsupported snapshot version' }, 400);
  const tmpDir = mkdtempSync(join(tmpdir(), 'figrev-web-'));
  try {
    // Recreate the extracted/ tree expected by repack --mode json.
    const extractedDir = join(tmpDir, 'extracted');
    const decompDir = join(extractedDir, '03_decompressed');
    const decodedDir = join(extractedDir, '04_decoded');
    const archiveDir = join(extractedDir, '02_archive');
    const containerDir = join(extractedDir, '01_container');
    for (const d of [decompDir, decodedDir, archiveDir, containerDir]) {
      ensureDirSync(d);
    }
    if (body.schemaBinB64) {
      writeFileSync(join(decompDir, 'schema.kiwi.bin'), Buffer.from(body.schemaBinB64, 'base64'));
    }
    writeFileSync(join(decodedDir, 'message.json'), body.messageJson);
    writeFileSync(
      join(archiveDir, '_info.json'),
      JSON.stringify({ version: body.archiveVersion ?? 106, ...(body.archiveInfo ?? {}) }),
    );
    for (const sc of body.sidecars) {
      const dest = join(containerDir, sc.name);
      ensureDirSync(dirname(dest));
      writeFileSync(dest, Buffer.from(sc.b64, 'base64'));
    }

    // Rebuild the in-memory documentJson from message.json by decoding through
    // the existing pipeline. Easiest: parse message.json + reuse buildTree.
    const messageObj = JSON.parse(body.messageJson, (_, v) => {
      if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).__bytes === 'string') {
        return Uint8Array.from(Buffer.from((v as { __bytes: string }).__bytes, 'base64'));
      }
      return v;
    });
    const tree = buildTree(messageObj as never);
    if (!tree.document) throw new Error('snapshot has no DOCUMENT root');
    const blobs = (messageObj as { blobs?: Array<{ bytes: Uint8Array }> }).blobs ?? [];
    const symbolIndex = new Map<string, TreeNode>();
    for (const node of tree.allNodes.values()) symbolIndex.set(node.guidStr, node);
    const documentJson = toClientNode(tree.document, blobs, symbolIndex);

    const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    sessions.set(id, {
      id,
      dir: tmpDir,
      origName: body.origName,
      archiveVersion: body.archiveVersion,
      documentJson,
    });
    return c.json({
      sessionId: id,
      origName: body.origName,
      pageCount: tree.document.children.filter((n) => n.type === 'CANVAS').length,
      nodeCount: tree.allNodes.size,
    });
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    return c.json({ error: (err as Error).message }, 500);
  }
});

function ensureDirSync(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// ─── Claude AI chat proxy ──────────────────────────────────────────────────
//
// Browser sends user messages + selectedGuid + an x-anthropic-key header.
// Server makes a tool-using call to Claude with our editing primitives.
// The model decides what to mutate; we apply each tool call by reusing the
// existing PATCH / instance-override / resize handlers.
app.post('/api/chat/:id', async (c) => {
  const s = sessions.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  const body = (await c.req.json()) as {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    selectedGuid?: string | null;
    model?: string;
    authMode?: 'subscription' | 'api-key';
  };
  const authMode = body.authMode === 'api-key' ? 'api-key' : 'subscription';

  // Whitelist allowed models
  const ALLOWED = new Set([
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ]);
  const model = body.model && ALLOWED.has(body.model) ? body.model : 'claude-opus-4-6';

  // Subscription mode: use the Claude Agent SDK which auto-discovers the
  // local Claude Code credentials (~/.claude/), so no API key is needed.
  // Recommended default — works out of the box for users running this PoC
  // alongside Claude Code on their machine.
  if (authMode === 'subscription') {
    return runSubscriptionChat(c, s, body.messages, body.selectedGuid ?? null, model);
  }

  // API-key mode (legacy): require the user-supplied key in the header.
  const apiKey = c.req.header('x-anthropic-key') ?? '';
  if (!apiKey.startsWith('sk-ant-')) {
    return c.json({ error: 'missing or invalid x-anthropic-key header' }, 401);
  }
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey });

  // Build a compact context of the current document — top-level pages + the
  // selected node's relevant fields. (Sending the whole doc is too large.)
  const summary = summarizeDocCore(s.documentJson, body.selectedGuid ?? null);

  const tools = [
    {
      name: 'set_text',
      description:
        'Set the textData.characters of a TEXT node. Affects every instance that references this master.',
      input_schema: {
        type: 'object',
        properties: {
          guid: { type: 'string', description: 'Target node GUID like "26:269".' },
          value: { type: 'string', description: 'New text content.' },
        },
        required: ['guid', 'value'],
      },
    },
    {
      name: 'override_instance_text',
      description:
        'Set a per-instance text override. Mutates only the given INSTANCE; the master stays intact.',
      input_schema: {
        type: 'object',
        properties: {
          instanceGuid: { type: 'string' },
          masterTextGuid: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['instanceGuid', 'masterTextGuid', 'value'],
      },
    },
    {
      name: 'set_position',
      description: 'Move a node by setting its transform.m02 (x) and transform.m12 (y).',
      input_schema: {
        type: 'object',
        properties: {
          guid: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
        },
        required: ['guid', 'x', 'y'],
      },
    },
    {
      name: 'set_size',
      description: 'Resize a node by setting size.x (width) and size.y (height).',
      input_schema: {
        type: 'object',
        properties: {
          guid: { type: 'string' },
          w: { type: 'number' },
          h: { type: 'number' },
        },
        required: ['guid', 'w', 'h'],
      },
    },
    {
      name: 'set_fill_color',
      description:
        'Set fillPaints[0].color RGBA channels (each 0..1). Use for changing a frame/text fill.',
      input_schema: {
        type: 'object',
        properties: {
          guid: { type: 'string' },
          r: { type: 'number' },
          g: { type: 'number' },
          b: { type: 'number' },
          a: { type: 'number' },
        },
        required: ['guid', 'r', 'g', 'b', 'a'],
      },
    },
  ];

  // Run the agent loop: up to 5 turns of tool calls.
  const conversation: Anthropic.MessageParam[] = body.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const actions: Array<{ tool: string; input: unknown }> = [];
  let assistantText = '';
  for (let turn = 0; turn < 5; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: `You are a design assistant editing a Figma file via tool calls.
Document summary:
${summary}
Use the tools to make the user's requested edits. Be concise.`,
      tools: tools as never,
      messages: conversation,
    });
    // Extract text + tool_use
    const toolUses: Anthropic.ToolUseBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'text') assistantText += block.text;
      else if (block.type === 'tool_use') toolUses.push(block);
    }
    if (toolUses.length === 0) break;
    // Apply each tool call locally and produce tool_result blocks
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      try {
        await applyTool(s, tu.name, tu.input as Record<string, unknown>);
        actions.push({ tool: tu.name, input: tu.input });
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'ok' });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `error: ${(err as Error).message}`,
          is_error: true,
        });
      }
    }
    conversation.push({ role: 'assistant', content: response.content });
    conversation.push({ role: 'user', content: toolResults });
    if (response.stop_reason === 'end_turn') break;
  }
  return c.json({ assistantText, actions });
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
