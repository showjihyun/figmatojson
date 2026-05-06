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
