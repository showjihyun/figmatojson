/**
 * Pure tree-mapping helpers: kiwi-decoded TreeNode → client-friendly
 * DocumentNode tree.
 *
 * No IO, no framework, no React. Lives in domain/ because it's a deterministic
 * data transformation; both the FsSessionStore (when creating a session from
 * fresh .fig bytes) and the snapshot-load path call into here.
 *
 * Lifted from server/index.ts as part of Phase 3 — see docs/ARCHITECTURE.md.
 */

import { parseVectorNetworkBlob, vectorNetworkToPath } from '../../../src/vector.js';
import type { TreeNode } from '../../../src/types.js';
import type {
  ComponentTextRef,
  DocumentNode,
} from './entities/Document';

/** Node types that have a vectorNetworkBlob and therefore an SVG path. */
export const VECTOR_TYPES: ReadonlySet<string> = new Set([
  'VECTOR',
  'STAR',
  'LINE',
  'ELLIPSE',
  'REGULAR_POLYGON',
  'BOOLEAN_OPERATION',
  'ROUNDED_RECTANGLE',
]);

/**
 * Map a TreeNode (kiwi-decoded) to the client-friendly DocumentNode shape.
 * Spreads `data` fields onto the node so `node.textData.characters`,
 * `node.fillPaints`, etc. work directly without indirection through
 * `.raw`. Drops binary fields and cyclical references; keeps everything
 * the canvas / inspector cares about.
 */
export function toClientNode(
  n: TreeNode,
  blobs: Array<{ bytes: Uint8Array }>,
  symbolIndex: Map<string, TreeNode>,
): DocumentNode {
  const data = (n.data ?? {}) as Record<string, unknown>;
  const out: DocumentNode = {
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
export function collectTextOverridesFromInstance(
  overrides: Array<Record<string, unknown>> | undefined,
): Map<string, string> {
  const m = new Map<string, string>();
  if (!Array.isArray(overrides)) return m;
  for (const o of overrides) {
    const td = o.textData as { characters?: string } | undefined;
    if (typeof td?.characters !== 'string') continue;
    const guids = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
    if (!Array.isArray(guids) || guids.length === 0) continue;
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
export function toClientChildForRender(
  n: TreeNode,
  blobs: Array<{ bytes: Uint8Array }>,
  symbolIndex: Map<string, TreeNode>,
  textOverrides: Map<string, string>,
  depth: number,
): DocumentNode {
  if (depth > 8) {
    return { id: n.guidStr, guid: n.guid, type: n.type, name: n.name, _isInstanceChild: true };
  }
  const data = (n.data ?? {}) as Record<string, unknown>;
  const out: DocumentNode = {
    id: n.guidStr,
    guid: n.guid,
    type: n.type,
    name: n.name,
    _isInstanceChild: true,
    children: n.children.map((c) => toClientChildForRender(c, blobs, symbolIndex, textOverrides, depth + 1)),
  };
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
  if (n.type === 'TEXT') {
    const ov = textOverrides.get(n.guidStr);
    if (typeof ov === 'string') out._renderTextOverride = ov;
  }
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

/**
 * Walk a master tree and collect every TEXT descendant (with breadcrumb path).
 * Recurses through nested INSTANCEs by following their master via symbolIndex
 * (capped at depth 6 to avoid pathological nesting).
 */
export function collectTexts(
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
  for (const c of n.children) {
    collectTexts(c, [...ancestors, c.name ?? c.type], out, symbolIndex, depth + 1);
  }
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

/**
 * Build the SymbolIndex used by the mappers above — lookup by guidStr,
 * resolves both COMPONENT/SYMBOL masters and FRAME masters that
 * INSTANCEs may reference.
 */
export function buildSymbolIndex(allNodes: Iterable<TreeNode>): Map<string, TreeNode> {
  const m = new Map<string, TreeNode>();
  for (const node of allNodes) {
    if (node.type === 'SYMBOL' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      m.set(node.guidStr, node);
    }
    m.set(node.guidStr, node);
  }
  return m;
}
