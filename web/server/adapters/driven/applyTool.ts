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
import { rebuildDocumentFromMessage } from '../../../core/domain/messageJson.js';
import { between } from '../../../../src/fractional-index.js';

interface MessageJson {
  nodeChanges?: Array<Record<string, unknown>>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * Sentinel GUID for full-message-snapshot journal patches. Undo.applyPatches
 * recognizes this guid and replaces the whole nodeChanges array (and rebuilds
 * documentJson) instead of trying to setPath on a node.
 */
export const MSG_SENTINEL_GUID = '__msg__';

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
    case 'duplicate': {
      // Clone the source node + its entire descendant subtree with fresh
      // GUIDs, place the root clone at (origX + dx, origY + dy), and append
      // it as the next sibling of the original. dx/dy default to 20 px so
      // the clone is visible if the user didn't specify.
      const node = findNode(String(input.guid));
      if (!node) throw new Error(`node ${input.guid} not found`);
      const dx = Number(input.dx ?? 20);
      const dy = Number(input.dy ?? 20);

      const beforeNodeChanges = clone(msg.nodeChanges ?? []);

      // Find every descendant of the source via parentIndex.guid linkage.
      // The kiwi format is a flat list, so we BFS by parent pointer.
      const sourceKey = `${(node.guid as { sessionID: number; localID: number }).sessionID}:${(node.guid as { sessionID: number; localID: number }).localID}`;
      const subtree: Array<Record<string, unknown>> = [node];
      const queue = [sourceKey];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const direct = (msg.nodeChanges ?? []).filter((n) => {
          const pi = n.parentIndex as { guid?: { sessionID?: number; localID?: number } } | undefined;
          if (!pi?.guid) return false;
          return `${pi.guid.sessionID}:${pi.guid.localID}` === cur;
        });
        for (const c of direct) {
          subtree.push(c);
          const cg = c.guid as { sessionID: number; localID: number } | undefined;
          if (cg) queue.push(`${cg.sessionID}:${cg.localID}`);
        }
      }

      // Allocate fresh localIDs in sessionID 0 — we pick a slot above the
      // current max so we don't collide with anything the kiwi schema
      // already references.
      let nextLocalId = 1;
      for (const n of msg.nodeChanges ?? []) {
        const g = n.guid as { localID?: number } | undefined;
        if (g?.localID && g.localID >= nextLocalId) nextLocalId = g.localID + 1;
      }
      const guidMap = new Map<string, { sessionID: number; localID: number }>();
      for (const orig of subtree) {
        const og = orig.guid as { sessionID: number; localID: number };
        guidMap.set(`${og.sessionID}:${og.localID}`, { sessionID: 0, localID: nextLocalId++ });
      }

      // Build the cloned set: root gets a fresh parentIndex.position so it
      // sorts immediately after the original; descendants keep their
      // relative positions but their parentIndex.guid is rewritten to
      // point at the corresponding clone.
      const origRootPi = node.parentIndex as { guid?: unknown; position?: string } | undefined;
      const cloned: Array<Record<string, unknown>> = [];
      for (const orig of subtree) {
        const c = clone(orig);
        const og = orig.guid as { sessionID: number; localID: number };
        c.guid = guidMap.get(`${og.sessionID}:${og.localID}`)!;

        if (orig === node) {
          if (origRootPi) {
            // between(origPos, null) = a position lex-greater than origPos,
            // i.e. the next sibling slot. If a real next sibling exists,
            // this still slots strictly between original and that sibling
            // because between() pads with the alphabet's max char.
            const origPos = origRootPi.position ?? null;
            c.parentIndex = {
              guid: origRootPi.guid,
              position: between(origPos, null),
            };
          }
          // Offset transform on the root clone only.
          const t = c.transform as Record<string, number> | undefined;
          if (t) {
            t.m02 = (t.m02 ?? 0) + dx;
            t.m12 = (t.m12 ?? 0) + dy;
          }
        } else {
          // Descendant: rewrite parentIndex.guid to the cloned parent's
          // new GUID. Keep the original position string — relative order
          // among siblings within the cloned subtree stays the same.
          const pi = c.parentIndex as { guid?: { sessionID: number; localID: number }; position?: string } | undefined;
          if (pi?.guid) {
            const pgKey = `${pi.guid.sessionID}:${pi.guid.localID}`;
            const newPg = guidMap.get(pgKey);
            if (newPg) pi.guid = newPg;
          }
        }
        cloned.push(c);
      }

      msg.nodeChanges = [...(msg.nodeChanges ?? []), ...cloned];
      writeFileSync(messagePath, JSON.stringify(msg));

      // documentJson: re-derive the whole client tree from the new message.
      // Wholesale rebuild costs a tree walk but is the only way to keep the
      // hierarchical mirror in sync with a structural change.
      s.documentJson = rebuildDocumentFromMessage(JSON.stringify(msg));

      // Journal: full-array before/after on the sentinel guid. Undo replays
      // by replacing nodeChanges and rebuilding documentJson.
      recordChatEdit('duplicate', [
        {
          guid: MSG_SENTINEL_GUID,
          field: 'nodeChanges',
          before: beforeNodeChanges,
          after: clone(msg.nodeChanges),
        },
      ]);
      break;
    }
    case 'group': {
      // Wrap 2+ sibling nodes in a new GROUP at their bbox. Members move
      // into GROUP-local coords; their parentIndex.guid points at GROUP.
      // Spec: docs/specs/web-group-ungroup.spec.md §3.
      const guids = (input.guids as string[]).map(String);
      const requestedName = typeof input.name === 'string' ? input.name : 'Group';
      if (guids.length < 2) throw new Error('group needs >= 2 guids');

      // Validate all members share a parent. Compare by guid string for safety.
      const members: Array<Record<string, unknown>> = [];
      for (const g of guids) {
        const m = findNode(g);
        if (!m) throw new Error(`group: node ${g} not found`);
        members.push(m);
      }
      const parentKey = (n: Record<string, unknown>): string => {
        const pi = n.parentIndex as { guid?: { sessionID?: number; localID?: number } } | undefined;
        if (!pi?.guid) return '';
        return `${pi.guid.sessionID}:${pi.guid.localID}`;
      };
      const sharedParent = parentKey(members[0]);
      if (!sharedParent) throw new Error('group: members have no parent (cannot group root nodes)');
      for (const m of members) {
        if (parentKey(m) !== sharedParent) {
          throw new Error('group: guids must share a parent');
        }
      }

      const beforeNodeChanges = clone(msg.nodeChanges ?? []);

      // Compute member bbox (in parent-local coords).
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const m of members) {
        const t = (m.transform as Record<string, number> | undefined) ?? {};
        const sz = (m.size as { x?: number; y?: number } | undefined) ?? {};
        const x = t.m02 ?? 0;
        const y = t.m12 ?? 0;
        const w = sz.x ?? 0;
        const h = sz.y ?? 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + w > maxX) maxX = x + w;
        if (y + h > maxY) maxY = y + h;
      }
      if (!isFinite(minX)) {
        // No member had a transform/size — fall back to origin-anchored zero-size.
        minX = 0; minY = 0; maxX = 0; maxY = 0;
      }

      // Allocate a fresh GUID — same scheme duplicate uses.
      let nextLocalId = 1;
      for (const n of msg.nodeChanges ?? []) {
        const g = n.guid as { localID?: number } | undefined;
        if (g?.localID && g.localID >= nextLocalId) nextLocalId = g.localID + 1;
      }
      const groupGuid = { sessionID: 0, localID: nextLocalId };

      // Take the lex-smallest member's position as GROUP's position. The
      // member moves out of the parent so the slot is free; lex order in
      // the parent stays consistent.
      const memberPositions = members
        .map((m) => (m.parentIndex as { position?: string } | undefined)?.position ?? '')
        .filter((p) => p.length > 0);
      const groupPos = memberPositions.length > 0
        ? memberPositions.reduce((a, b) => (a < b ? a : b))
        : between(null, null);

      const parentSessionID = Number(sharedParent.split(':')[0]);
      const parentLocalID = Number(sharedParent.split(':')[1]);

      const groupNode: Record<string, unknown> = {
        guid: groupGuid,
        type: 'GROUP',
        name: requestedName,
        parentIndex: {
          guid: { sessionID: parentSessionID, localID: parentLocalID },
          position: groupPos,
        },
        transform: { m00: 1, m01: 0, m02: minX, m10: 0, m11: 1, m12: minY },
        size: { x: maxX - minX, y: maxY - minY },
        // Spec §10: GROUP.fillPaints = [] (empty array, not omitted).
        fillPaints: [],
      };

      // Mutate each member: re-parent + shift to GROUP-local coords.
      for (const m of members) {
        const pi = (m.parentIndex ??= { guid: groupGuid, position: '' }) as {
          guid: { sessionID: number; localID: number };
          position?: string;
        };
        pi.guid = groupGuid;
        // Position kept — relative lex order preserved within GROUP.
        const t = (m.transform ??= {}) as Record<string, number>;
        t.m02 = (t.m02 ?? 0) - minX;
        t.m12 = (t.m12 ?? 0) - minY;
      }

      msg.nodeChanges = [...(msg.nodeChanges ?? []), groupNode];
      writeFileSync(messagePath, JSON.stringify(msg));
      s.documentJson = rebuildDocumentFromMessage(JSON.stringify(msg));

      recordChatEdit('group', [
        {
          guid: MSG_SENTINEL_GUID,
          field: 'nodeChanges',
          before: beforeNodeChanges,
          after: clone(msg.nodeChanges),
        },
      ]);
      break;
    }

    case 'ungroup': {
      // Inverse of group — promote a GROUP's children to its parent and
      // delete the GROUP. Children's transforms are translated back to
      // grandparent-local coords. Spec §4.
      const node = findNode(String(input.guid));
      if (!node) throw new Error(`ungroup: node ${input.guid} not found`);
      if (node.type !== 'GROUP') {
        throw new Error('ungroup: target is not a GROUP');
      }

      const beforeNodeChanges = clone(msg.nodeChanges ?? []);

      const groupKey = `${(node.guid as { sessionID: number; localID: number }).sessionID}:${(node.guid as { sessionID: number; localID: number }).localID}`;
      const groupPi = node.parentIndex as { guid?: { sessionID: number; localID: number }; position?: string } | undefined;
      if (!groupPi?.guid) {
        throw new Error('ungroup: target has no parent (cannot dissolve root)');
      }
      const grandparentGuid = groupPi.guid;
      const groupPos = groupPi.position ?? '';
      const groupT = (node.transform as Record<string, number> | undefined) ?? {};
      const groupOffsetX = groupT.m02 ?? 0;
      const groupOffsetY = groupT.m12 ?? 0;

      // Direct children of the GROUP, sorted by their current position so
      // we re-emit them into the grandparent in the same lex order.
      const directChildren = (msg.nodeChanges ?? []).filter((n) => {
        const pi = n.parentIndex as { guid?: { sessionID?: number; localID?: number } } | undefined;
        if (!pi?.guid) return false;
        return `${pi.guid.sessionID}:${pi.guid.localID}` === groupKey;
      });
      directChildren.sort((a, b) => {
        const pa = (a.parentIndex as { position?: string } | undefined)?.position ?? '';
        const pb = (b.parentIndex as { position?: string } | undefined)?.position ?? '';
        if (pa < pb) return -1;
        if (pa > pb) return 1;
        return 0;
      });

      // Find the next sibling of GROUP in the grandparent so children can
      // ladder into the (groupPos, nextSiblingPos) range.
      const grandparentSiblings = (msg.nodeChanges ?? []).filter((n) => {
        const pi = n.parentIndex as { guid?: { sessionID?: number; localID?: number } } | undefined;
        if (!pi?.guid) return false;
        return pi.guid.sessionID === grandparentGuid.sessionID
          && pi.guid.localID === grandparentGuid.localID;
      });
      let nextSiblingPos: string | null = null;
      for (const sib of grandparentSiblings) {
        const sibPos = (sib.parentIndex as { position?: string } | undefined)?.position ?? '';
        if (sibPos > groupPos && (nextSiblingPos === null || sibPos < nextSiblingPos)) {
          nextSiblingPos = sibPos;
        }
      }

      // Promote each direct child: re-parent + translate to grandparent
      // coords + ladder a new position string in the GROUP-occupied slot.
      let prevPos: string = groupPos;
      for (const c of directChildren) {
        const pi = c.parentIndex as { guid: { sessionID: number; localID: number }; position?: string };
        pi.guid = grandparentGuid;
        const newPos = between(prevPos, nextSiblingPos);
        pi.position = newPos;
        prevPos = newPos;
        const t = (c.transform ??= {}) as Record<string, number>;
        t.m02 = (t.m02 ?? 0) + groupOffsetX;
        t.m12 = (t.m12 ?? 0) + groupOffsetY;
      }

      // Drop the GROUP itself from nodeChanges.
      msg.nodeChanges = (msg.nodeChanges ?? []).filter((n) => {
        const g = n.guid as { sessionID: number; localID: number } | undefined;
        if (!g) return true;
        return `${g.sessionID}:${g.localID}` !== groupKey;
      });
      writeFileSync(messagePath, JSON.stringify(msg));
      s.documentJson = rebuildDocumentFromMessage(JSON.stringify(msg));

      recordChatEdit('ungroup', [
        {
          guid: MSG_SENTINEL_GUID,
          field: 'nodeChanges',
          before: beforeNodeChanges,
          after: clone(msg.nodeChanges),
        },
      ]);
      break;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
