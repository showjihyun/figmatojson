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
        const fillOverrides = collectFillOverridesFromInstance(sd?.symbolOverrides);
        const expanded = master.children.map((c) =>
          toClientChildForRender(c, blobs, symbolIndex, textOverrides, fillOverrides, 0),
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
 * Convert a guidPath { guids: [...] } into a slash-joined pathKey, e.g.
 *   [{sess:11, local:524}, {sess:11, local:506}] → "11:524/11:506"
 *
 * Returns null if any guid is malformed. Single-step paths come out as a
 * plain "sess:local" string (no slash) so they remain compatible with
 * single-step lookups in this same Map.
 *
 * Spec: docs/specs/web-instance-render-overrides.spec.md §3.1 I-C1.
 */
function pathKeyFromGuids(
  guids: Array<{ sessionID?: number; localID?: number }> | undefined,
): string | null {
  if (!Array.isArray(guids) || guids.length === 0) return null;
  const parts: string[] = [];
  for (const g of guids) {
    if (typeof g?.sessionID !== 'number' || typeof g?.localID !== 'number') return null;
    parts.push(`${g.sessionID}:${g.localID}`);
  }
  return parts.join('/');
}

/**
 * Pull text overrides out of an INSTANCE's symbolOverrides[]. Returns a
 * Map<pathKey, string> where pathKey is the slash-joined full guidPath
 * (e.g. "11:524/11:506"). Multi-step paths are required for files like
 * `메타리치 화면 UI Design.fig` where one master is instantiated multiple
 * times under a parent and each instance overrides the same descendant
 * TEXT to a different value — single-step keys would collide on the
 * shared last guid.
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
    const key = pathKeyFromGuids(guids);
    if (key === null) continue;
    m.set(key, td.characters);
  }
  return m;
}

/**
 * Pull fillPaints overrides out of an INSTANCE's symbolOverrides[]. Same
 * pathKey scheme as text overrides — see `collectTextOverridesFromInstance`
 * for the rationale on multi-step keys.
 *
 * Spec: docs/specs/web-instance-render-overrides.spec.md §3.1
 */
export function collectFillOverridesFromInstance(
  overrides: Array<Record<string, unknown>> | undefined,
): Map<string, unknown[]> {
  const m = new Map<string, unknown[]>();
  if (!Array.isArray(overrides)) return m;
  for (const o of overrides) {
    const fps = o.fillPaints;
    if (!Array.isArray(fps)) continue;
    const guids = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
    const key = pathKeyFromGuids(guids);
    if (key === null) continue;
    m.set(key, fps);
  }
  return m;
}

/**
 * Merge a nested INSTANCE's own override map into the outer overrides,
 * prefixing each inner key with the outer path so it matches against the
 * deeper visit path. The outer overrides remain in place (their full paths
 * may target descendants of THIS inner instance via I-P5). Returns a new
 * Map; inputs are not mutated.
 *
 * Spec: docs/specs/web-instance-render-overrides.spec.md §3.2 I-P5.
 */
function mergeOverridesForNested<V>(
  outer: Map<string, V>,
  inner: Map<string, V>,
  pathFromOuter: string[],
): Map<string, V> {
  if (inner.size === 0) return outer;
  const out = new Map(outer);
  const prefix = pathFromOuter.join('/');
  for (const [innerKey, innerVal] of inner) {
    const merged = prefix.length > 0 ? `${prefix}/${innerKey}` : innerKey;
    out.set(merged, innerVal);
  }
  return out;
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
  fillOverrides: Map<string, unknown[]>,
  depth: number,
  pathFromOuter: string[] = [],
): DocumentNode {
  if (depth > 8) {
    return { id: n.guidStr, guid: n.guid, type: n.type, name: n.name, _isInstanceChild: true };
  }
  // Path tracking: append THIS node's guidStr so descendants see their
  // full chain from the outer instance master root. Override Maps are
  // keyed by the same join scheme. Spec §3.2 I-P3 / I-P4.
  const currentPath = n.guidStr ? [...pathFromOuter, n.guidStr] : pathFromOuter;
  const currentKey = currentPath.join('/');
  const data = (n.data ?? {}) as Record<string, unknown>;
  const out: DocumentNode = {
    id: n.guidStr,
    guid: n.guid,
    type: n.type,
    name: n.name,
    _isInstanceChild: true,
    children: n.children.map((c) =>
      toClientChildForRender(c, blobs, symbolIndex, textOverrides, fillOverrides, depth + 1, currentPath),
    ),
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
    const ov = textOverrides.get(currentKey);
    if (typeof ov === 'string') out._renderTextOverride = ov;
  }
  // Nested INSTANCE: merge outer overrides (already path-keyed against the
  // outer master's tree, may contain entries that target descendants of
  // THIS inner instance via multi-step paths) with the inner instance's
  // OWN overrides (single-step keys, prefixed with currentPath so they
  // match in the same path-join scheme). Spec §3.2 I-P5.
  if (n.type === 'INSTANCE' && n.children.length === 0) {
    const sd = data.symbolData as {
      symbolID?: { sessionID?: number; localID?: number };
      symbolOverrides?: Array<Record<string, unknown>>;
    } | undefined;
    const sid = sd?.symbolID;
    if (sid && typeof sid.sessionID === 'number' && typeof sid.localID === 'number') {
      const master = symbolIndex.get(`${sid.sessionID}:${sid.localID}`);
      if (master) {
        const innerText = collectTextOverridesFromInstance(sd?.symbolOverrides);
        const innerFill = collectFillOverridesFromInstance(sd?.symbolOverrides);
        const mergedText = mergeOverridesForNested(textOverrides, innerText, currentPath);
        const mergedFill = mergeOverridesForNested(fillOverrides, innerFill, currentPath);
        out._renderChildren = master.children.map((c) =>
          toClientChildForRender(c, blobs, symbolIndex, mergedText, mergedFill, depth + 1, currentPath),
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
  // Apply fillPaints override AFTER the data spread so it wins. Spec §3.2 I-P3.
  const fillOv = fillOverrides.get(currentKey);
  if (fillOv) out.fillPaints = fillOv;
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
