/**
 * Build a compact textual summary of a Document tree for the LLM context.
 *
 * Three sections, all bounded:
 *   - Top of tree: type+name+id, depth-limited (default 3) and child-limited
 *     (default 8 per level, with "... N more" fold)
 *   - If a node is selected, its compact JSON detail (bounded to ~1200 chars)
 *
 * Pure: takes the doc and the optional selected GUID, returns a string.
 * No fetch, no readFile, no SDK calls — extracted from server/index.ts so
 * RunChatTurn's prompt builder can call it without dragging anything in.
 */

import { findById } from './tree';

export function summarizeDoc(doc: unknown, selectedGuid: string | null): string {
  const lines: string[] = [];
  function walk(n: any, depth: number, max: number): void {
    if (!n || depth > max) return;
    const tag = `${n.type}${n.name ? ` "${n.name}"` : ''} (${n.id ?? '?'})`;
    lines.push('  '.repeat(depth) + tag + (n.id === selectedGuid ? '  ← SELECTED' : ''));
    if (Array.isArray(n.children) && depth < max) {
      for (const c of n.children.slice(0, 8)) walk(c, depth + 1, max);
      if (n.children.length > 8) {
        lines.push('  '.repeat(depth + 1) + `... ${n.children.length - 8} more`);
      }
    }
  }
  walk(doc, 0, 3);
  if (selectedGuid) {
    const sel = findById(doc, selectedGuid) as any;
    if (sel) {
      lines.push('');
      lines.push(`Selected node detail:`);
      const compact = {
        id: sel.id,
        type: sel.type,
        name: sel.name,
        size: sel.size,
        transform: sel.transform,
        textData: sel.textData,
        fillPaints: sel.fillPaints,
        _componentTexts: sel._componentTexts,
      };
      lines.push(JSON.stringify(compact, null, 2).slice(0, 1200));
    }
  }
  return lines.join('\n');
}
