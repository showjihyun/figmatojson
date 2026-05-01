/**
 * Chat tool dispatcher — the function the agent calls when Claude requests a
 * mutation (set_text, set_position, set_size, set_fill_color, set_corner_radius,
 * align_nodes, override_instance_text).
 *
 * Lifted out of `server/index.ts` so it can be unit-tested in isolation.
 * Two collaborators are injected:
 *
 *  - `journal`  — every successful mutation records a `JournalEntry` so the
 *                 user can Cmd/Z back the agent's edit. Same shape that the
 *                 user-driven use cases (EditNode, ResizeNode, ...) emit.
 *  - The session itself owns the working dir + in-memory `documentJson`; we
 *    write through to `extracted/04_decoded/message.json` and mirror the same
 *    change onto the client-side tree so a subsequent GET /api/doc/:id sees it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Session } from '../../../core/domain/entities/Session.js';
import type { ComponentTextRef } from '../../../core/domain/entities/Document.js';
import type {
  EditJournal,
  PatchPair,
} from '../../../core/ports/EditJournal.js';

interface MessageJson {
  nodeChanges?: Array<Record<string, unknown>>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export async function applyTool(
  s: Session,
  name: string,
  input: Record<string, unknown>,
  journal: EditJournal,
): Promise<void> {
  const messagePath = join(s.dir, 'extracted', '04_decoded', 'message.json');
  const raw = readFileSync(messagePath, 'utf8');
  const msg = JSON.parse(raw) as MessageJson;

  const findNode = (guid: string): Record<string, unknown> | undefined =>
    msg.nodeChanges?.find((n) => {
      const g = n.guid as { sessionID?: number; localID?: number } | undefined;
      return g && `${g.sessionID}:${g.localID}` === guid;
    });

  const mirrorClient = (
    guid: string,
    mutator: (n: Record<string, unknown>) => void,
  ): void => {
    function walk(n: Record<string, unknown>): boolean {
      const g = n.guid as { sessionID: number; localID: number } | undefined;
      if (g && `${g.sessionID}:${g.localID}` === guid) { mutator(n); return true; }
      const ch = n.children as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(ch)) for (const c of ch) if (walk(c)) return true;
      return false;
    }
    walk(s.documentJson as unknown as Record<string, unknown>);
  };

  const recordChatEdit = (label: string, patches: PatchPair[]): void => {
    journal.record(s.id, { label: `AI: ${label}`, patches });
  };

  switch (name) {
    case 'set_text': {
      const node = findNode(String(input.guid));
      if (!node) throw new Error(`node ${input.guid} not found`);
      const before = (node.textData as { characters?: unknown } | undefined)?.characters;
      const after = String(input.value);
      ((node.textData ??= {}) as Record<string, unknown>).characters = after;
      writeFileSync(messagePath, JSON.stringify(msg));
      mirrorClient(String(input.guid), (n) => {
        ((n.textData ??= {}) as Record<string, unknown>).characters = after;
      });
      // Refresh component-text snapshots: any INSTANCE that references this
      // master text needs its cached label updated too.
      function refresh(n: Record<string, unknown>): void {
        const refs = n._componentTexts as ComponentTextRef[] | undefined;
        if (Array.isArray(refs)) for (const r of refs) if (r.guid === input.guid) r.characters = after;
        const ch = n.children as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(ch)) for (const c of ch) refresh(c);
      }
      refresh(s.documentJson as unknown as Record<string, unknown>);
      recordChatEdit('set_text', [
        { guid: String(input.guid), field: 'textData.characters', before, after },
      ]);
      break;
    }
    case 'override_instance_text': {
      const inst = findNode(String(input.instanceGuid));
      if (!inst) throw new Error(`INSTANCE ${input.instanceGuid} not found`);
      const [ms, ml] = String(input.masterTextGuid).split(':').map((x) => parseInt(x, 10));
      inst.symbolData = (inst.symbolData ?? {}) as Record<string, unknown>;
      const sd = inst.symbolData as { symbolOverrides?: Array<Record<string, unknown>> };
      sd.symbolOverrides = sd.symbolOverrides ?? [];
      const beforeOverrides = clone(sd.symbolOverrides);
      let entry = sd.symbolOverrides.find((o) => {
        const g = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
        return Array.isArray(g) && g.length === 1 && g[0]?.sessionID === ms && g[0]?.localID === ml;
      });
      if (!entry) {
        entry = {
          guidPath: { guids: [{ sessionID: ms, localID: ml }] },
          textData: {
            characters: String(input.value),
            lines: [{
              lineType: 'PLAIN', styleId: 0, indentationLevel: 0,
              sourceDirectionality: 'AUTO', listStartOffset: 0, isFirstLineOfList: false,
            }],
          },
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
      recordChatEdit('override_instance_text', [
        {
          guid: String(input.instanceGuid),
          field: 'symbolData.symbolOverrides',
          before: beforeOverrides,
          after: clone(sd.symbolOverrides),
        },
      ]);
      break;
    }
    case 'set_position': {
      const node = findNode(String(input.guid));
      if (!node) throw new Error(`node ${input.guid} not found`);
      const beforeT = clone((node.transform as Record<string, number> | undefined) ?? {});
      const t = (node.transform ??= {}) as Record<string, number>;
      const newX = Number(input.x);
      const newY = Number(input.y);
      t.m02 = newX; t.m12 = newY;
      writeFileSync(messagePath, JSON.stringify(msg));
      mirrorClient(String(input.guid), (n) => {
        const t2 = (n.transform ??= {}) as Record<string, number>;
        t2.m02 = newX; t2.m12 = newY;
      });
      recordChatEdit('set_position', [
        { guid: String(input.guid), field: 'transform.m02', before: beforeT.m02, after: newX },
        { guid: String(input.guid), field: 'transform.m12', before: beforeT.m12, after: newY },
      ]);
      break;
    }
    case 'set_size': {
      const node = findNode(String(input.guid));
      if (!node) throw new Error(`node ${input.guid} not found`);
      const beforeSize = clone((node.size as { x?: number; y?: number } | undefined) ?? {});
      const newW = Math.max(1, Number(input.w));
      const newH = Math.max(1, Number(input.h));
      node.size = { x: newW, y: newH };
      writeFileSync(messagePath, JSON.stringify(msg));
      mirrorClient(String(input.guid), (n) => {
        n.size = { x: newW, y: newH };
      });
      recordChatEdit('set_size', [
        { guid: String(input.guid), field: 'size.x', before: beforeSize.x, after: newW },
        { guid: String(input.guid), field: 'size.y', before: beforeSize.y, after: newH },
      ]);
      break;
    }
    case 'set_fill_color': {
      const node = findNode(String(input.guid));
      if (!node) throw new Error(`node ${input.guid} not found`);
      const beforeFills = clone((node.fillPaints as unknown[] | undefined) ?? []);
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
      recordChatEdit('set_fill_color', [
        { guid: String(input.guid), field: 'fillPaints', before: beforeFills, after: clone(fps) },
      ]);
      break;
    }
    case 'set_corner_radius': {
      const node = findNode(String(input.guid));
      if (!node) throw new Error(`node ${input.guid} not found`);
      const before = node.cornerRadius;
      const r = Math.max(0, Number(input.value));
      node.cornerRadius = r;
      writeFileSync(messagePath, JSON.stringify(msg));
      mirrorClient(String(input.guid), (n) => {
        n.cornerRadius = r;
      });
      recordChatEdit('set_corner_radius', [
        { guid: String(input.guid), field: 'cornerRadius', before, after: r },
      ]);
      break;
    }
    case 'align_nodes': {
      const guids = (input.guids as string[]).map(String);
      const axis = String(input.axis);
      if (guids.length < 2) throw new Error('align_nodes needs >= 2 guids');
      type Bbox = { x: number; y: number; w: number; h: number };
      const targets: Array<{
        guid: string;
        node: Record<string, unknown>;
        bbox: Bbox;
        beforeM02?: number;
        beforeM12?: number;
      }> = [];
      for (const g of guids) {
        const n = findNode(g);
        if (!n) throw new Error(`node ${g} not found`);
        const t = (n.transform as Record<string, number> | undefined) ?? {};
        const sz = (n.size as { x?: number; y?: number } | undefined) ?? {};
        targets.push({
          guid: g,
          node: n,
          bbox: { x: t.m02 ?? 0, y: t.m12 ?? 0, w: sz.x ?? 0, h: sz.y ?? 0 },
          beforeM02: t.m02,
          beforeM12: t.m12,
        });
      }
      const groupX = Math.min(...targets.map((t) => t.bbox.x));
      const groupY = Math.min(...targets.map((t) => t.bbox.y));
      const groupRight = Math.max(...targets.map((t) => t.bbox.x + t.bbox.w));
      const groupBottom = Math.max(...targets.map((t) => t.bbox.y + t.bbox.h));
      const groupCx = (groupX + groupRight) / 2;
      const groupCy = (groupY + groupBottom) / 2;
      for (const t of targets) {
        const transform = (t.node.transform ??= {}) as Record<string, number>;
        switch (axis) {
          case 'left':   transform.m02 = groupX; break;
          case 'center': transform.m02 = groupCx - t.bbox.w / 2; break;
          case 'right':  transform.m02 = groupRight - t.bbox.w; break;
          case 'top':    transform.m12 = groupY; break;
          case 'middle': transform.m12 = groupCy - t.bbox.h / 2; break;
          case 'bottom': transform.m12 = groupBottom - t.bbox.h; break;
          default: throw new Error(`align_nodes: unknown axis ${axis}`);
        }
      }
      writeFileSync(messagePath, JSON.stringify(msg));
      const patches: PatchPair[] = [];
      const isHorizontal = axis === 'left' || axis === 'center' || axis === 'right';
      for (const t of targets) {
        const newM02 = (t.node.transform as Record<string, number>).m02;
        const newM12 = (t.node.transform as Record<string, number>).m12;
        mirrorClient(t.guid, (n) => {
          const tr = (n.transform ??= {}) as Record<string, number>;
          tr.m02 = newM02;
          tr.m12 = newM12;
        });
        // Only the actually-changed axis enters the journal — undo of a
        // horizontal align shouldn't move nodes vertically.
        if (isHorizontal) {
          patches.push({ guid: t.guid, field: 'transform.m02', before: t.beforeM02, after: newM02 });
        } else {
          patches.push({ guid: t.guid, field: 'transform.m12', before: t.beforeM12, after: newM12 });
        }
      }
      recordChatEdit(`align ${axis}`, patches);
      break;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
