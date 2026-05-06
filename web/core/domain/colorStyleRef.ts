/**
 * Helpers that resolve Figma library color/text-style references on a node
 * back to the asset's display name.
 *
 * Spec: docs/specs/web-render-fidelity-round15.spec.md
 *
 * .fig nodes carry both raw RGBA *and* an optional alias guid into a
 * VARIABLE / style-asset node elsewhere in the document. These helpers
 * walk that one alias hop and return the asset's `name`. Used by the
 * Inspector to label the fill/stroke color row (e.g. "Button/Primary/Default").
 */

import { findById } from './tree.js';

interface AliasGuid {
  sessionID?: unknown;
  localID?: unknown;
}

function readGuid(g: AliasGuid | null | undefined): string | null {
  if (!g || typeof g !== 'object') return null;
  if (typeof g.sessionID !== 'number' || typeof g.localID !== 'number') return null;
  return `${g.sessionID}:${g.localID}`;
}

/**
 * I-1 — paint.colorVar.value.alias.guid → VARIABLE.name.
 *
 * Returns null when:
 *   - paint or root is null
 *   - colorVar/alias/guid path is incomplete
 *   - resolved node is missing or not type=VARIABLE
 *   - VARIABLE node has no string `name`
 */
export function colorVarName(paint: unknown, root: unknown): string | null {
  if (!paint || typeof paint !== 'object' || !root) return null;
  const p = paint as { colorVar?: { value?: { alias?: { guid?: AliasGuid } } } };
  const id = readGuid(p.colorVar?.value?.alias?.guid);
  if (!id) return null;
  const target = findById(root, id);
  if (!target || (target as { type?: string }).type !== 'VARIABLE') return null;
  const name = (target as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

/**
 * I-2 — node.styleIdForText.guid → text-style asset.name.
 *
 * Style assets are stored as `type: 'TEXT'` with `styleType: 'TEXT'`
 * (Figma keeps style definitions in the same node-type as bodies but
 * tags them with `styleType`). We require both checks.
 */
export function textStyleName(node: unknown, root: unknown): string | null {
  if (!node || typeof node !== 'object' || !root) return null;
  const n = node as { styleIdForText?: { guid?: AliasGuid } };
  const id = readGuid(n.styleIdForText?.guid);
  if (!id) return null;
  const target = findById(root, id) as { type?: string; styleType?: string; name?: unknown } | null;
  if (!target || target.type !== 'TEXT' || target.styleType !== 'TEXT') return null;
  return typeof target.name === 'string' ? target.name : null;
}

/**
 * Round 16 — `effectiveTextStyle(node, root)` resolves the typography
 * Figma actually applies, by overlaying a referenced text-style asset
 * (when `node.styleIdForText` resolves) onto the node's raw fields.
 *
 * Per-field fallback: any field the asset doesn't define falls back to
 * the node's raw value. styleIdForText absent / unresolvable → all
 * fields come from node raw (= pre-round-16 behavior).
 *
 * The set of overlaid fields covers the typography that style assets in
 * `.fig` carry: fontName, fontSize, lineHeight, letterSpacing,
 * textCase, textDecoration, paragraphSpacing, paragraphIndent.
 * Caller may consult more raw fields directly when not in this set.
 */
export interface EffectiveTextStyle {
  fontName?: { family?: string; style?: string; postscript?: string };
  fontSize?: number;
  lineHeight?: { value?: number; units?: string };
  letterSpacing?: { value?: number; units?: string };
  textCase?: string;
  textDecoration?: string;
  paragraphSpacing?: number;
  paragraphIndent?: number;
}

const EFFECTIVE_FIELDS = [
  'fontName',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'textCase',
  'textDecoration',
  'paragraphSpacing',
  'paragraphIndent',
] as const;

function resolveStyleAsset(node: unknown, root: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object' || !root) return null;
  const n = node as { styleIdForText?: { guid?: AliasGuid } };
  const id = readGuid(n.styleIdForText?.guid);
  if (!id) return null;
  const target = findById(root, id) as Record<string, unknown> | null;
  if (!target || target.type !== 'TEXT' || target.styleType !== 'TEXT') return null;
  return target;
}

/**
 * Round 18-A — `resolveVariableChain` walks a VARIABLE node's
 * `variableDataValues.entries[0]` alias chain, hop by hop, with cycle /
 * dead-end / depth-cap detection. Returns the last-resolved node + the
 * GUID trail + an end-state classification.
 *
 * Spec: docs/specs/web-render-fidelity-round18-A.spec.md
 *
 * Single-mode only — entries[0]. Multi-mode chain (light/dark themes)
 * is intentionally out of scope.
 */
export type VariableChainEnd =
  | { kind: 'leaf' }
  | { kind: 'non-variable' }
  | { kind: 'cycle'; cycledAt: string }
  | { kind: 'dead-end' }
  | { kind: 'depth-cap'; cap: number };

export interface VariableChainResult {
  /** chain 의 마지막 도달 노드 (cycle/dead-end 시 마지막으로 정상 도달한 곳). */
  leaf: unknown | null;
  /** 거쳐간 GUID 들 — 입력 VARIABLE 부터 leaf 또는 break-point 까지. */
  chain: string[];
  end: VariableChainEnd;
}

const DEFAULT_CHAIN_MAX_DEPTH = 8;

function readAliasGuidFromEntry(entry: unknown): AliasGuid | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as { variableData?: { dataType?: string; value?: { alias?: { guid?: AliasGuid } } } };
  if (e.variableData?.dataType !== 'ALIAS') return null;
  return e.variableData.value?.alias?.guid ?? null;
}

function isAliasEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  return (entry as { variableData?: { dataType?: string } }).variableData?.dataType === 'ALIAS';
}

export function resolveVariableChain(
  node: unknown,
  root: unknown,
  options?: { maxDepth?: number },
): VariableChainResult | null {
  if (!node || typeof node !== 'object') return null;
  const maxDepth = options?.maxDepth ?? DEFAULT_CHAIN_MAX_DEPTH;
  const start = node as { type?: string; id?: string; variableDataValues?: { entries?: unknown[] } };
  if (start.type !== 'VARIABLE') return null;

  const chain: string[] = [];
  let cur: typeof start | (Record<string, unknown> & { type?: string; id?: string }) = start;

  for (let i = 0; i < maxDepth; i++) {
    const id = (cur as { id?: string }).id;
    if (typeof id === 'string') chain.push(id);

    const entries = (cur as typeof start).variableDataValues?.entries;
    const first = Array.isArray(entries) ? entries[0] : undefined;

    // No entries / first entry is not an ALIAS → cur is the leaf.
    if (!first || !isAliasEntry(first)) {
      return { leaf: cur, chain, end: { kind: 'leaf' } };
    }

    const guid = readAliasGuidFromEntry(first);
    const aliasId = readGuid(guid ?? null);
    if (!aliasId) return { leaf: cur, chain, end: { kind: 'dead-end' } };

    if (chain.includes(aliasId)) {
      return { leaf: cur, chain, end: { kind: 'cycle', cycledAt: aliasId } };
    }

    const next = findById(root, aliasId) as Record<string, unknown> | null;
    if (!next) return { leaf: cur, chain, end: { kind: 'dead-end' } };
    if ((next as { type?: string }).type !== 'VARIABLE') {
      chain.push(aliasId);
      return { leaf: next, chain, end: { kind: 'non-variable' } };
    }

    cur = next as never;
  }

  return { leaf: cur, chain, end: { kind: 'depth-cap', cap: maxDepth } };
}

export function effectiveTextStyle(node: unknown, root: unknown): EffectiveTextStyle {
  if (!node || typeof node !== 'object') return {};
  const raw = node as Record<string, unknown>;
  const asset = resolveStyleAsset(node, root);
  const out: EffectiveTextStyle = {};
  for (const k of EFFECTIVE_FIELDS) {
    const fromAsset = asset ? asset[k] : undefined;
    const v = fromAsset !== undefined ? fromAsset : raw[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
