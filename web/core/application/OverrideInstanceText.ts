/**
 * Use case: write a per-instance text override on an INSTANCE node.
 *
 * Master text and other instances stay intact — the override goes into
 * `symbolOverrides[]` keyed by guidPath = [masterTextGuid].
 */

import type { SessionStore } from '../ports/SessionStore.js';
import type { EditJournal } from '../ports/EditJournal.js';
import { NotFoundError, ValidationError } from './errors.js';

interface FsLike {
  readMessage(id: string): string;
  writeMessage(id: string, json: string): void;
}

export interface OverrideInstanceTextInput {
  sessionId: string;
  instanceGuid: string;
  masterTextGuid: string;
  value: string;
}

export class OverrideInstanceText {
  constructor(
    private readonly sessionStore: SessionStore & FsLike,
    private readonly journal?: EditJournal,
  ) {}

  async execute({
    sessionId,
    instanceGuid,
    masterTextGuid,
    value,
  }: OverrideInstanceTextInput): Promise<{ ok: true }> {
    const session = this.sessionStore.getById(sessionId);
    if (!session) throw new NotFoundError(`session ${sessionId} not found`);

    const raw = this.sessionStore.readMessage(sessionId);
    const msg = JSON.parse(raw) as { nodeChanges?: Array<Record<string, unknown>> };
    const inst = msg.nodeChanges?.find((n) => {
      const g = n.guid as { sessionID?: number; localID?: number } | undefined;
      return g && `${g.sessionID}:${g.localID}` === instanceGuid;
    });
    if (!inst) throw new NotFoundError(`INSTANCE ${instanceGuid} not found`);

    const [msStr, mlStr] = masterTextGuid.split(':');
    const ms = parseInt(msStr ?? '', 10);
    const ml = parseInt(mlStr ?? '', 10);
    if (Number.isNaN(ms) || Number.isNaN(ml)) {
      throw new ValidationError(`invalid masterTextGuid: ${masterTextGuid}`);
    }

    inst.symbolData = (inst.symbolData ?? {}) as Record<string, unknown>;
    const sd = inst.symbolData as { symbolOverrides?: Array<Record<string, unknown>> };
    sd.symbolOverrides = sd.symbolOverrides ?? [];
    // Capture a deep-cloned snapshot before mutating — Undo writes this back
    // verbatim. JSON round-trip is sufficient since symbolOverrides entries
    // are pure data (no functions / Dates / typed arrays here).
    const beforeOverrides = JSON.parse(JSON.stringify(sd.symbolOverrides));
    let entry = sd.symbolOverrides.find((o) => {
      const g = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
      return Array.isArray(g) && g.length === 1 && g[0]?.sessionID === ms && g[0]?.localID === ml;
    });
    if (!entry) {
      entry = {
        guidPath: { guids: [{ sessionID: ms, localID: ml }] },
        textData: {
          characters: value,
          lines: [
            {
              lineType: 'PLAIN',
              styleId: 0,
              indentationLevel: 0,
              sourceDirectionality: 'AUTO',
              listStartOffset: 0,
              isFirstLineOfList: false,
            },
          ],
        },
      };
      sd.symbolOverrides.push(entry);
    } else {
      ((entry.textData ??= {}) as Record<string, unknown>).characters = value;
    }
    this.sessionStore.writeMessage(sessionId, JSON.stringify(msg));

    // Mirror on documentJson so the inspector sees the override immediately.
    const doc = session.documentJson as unknown as Record<string, unknown>;
    function walk(n: Record<string, unknown>): boolean {
      const g = n.guid as { sessionID: number; localID: number } | undefined;
      if (g && `${g.sessionID}:${g.localID}` === instanceGuid) {
        const m = (n._instanceOverrides ??= {}) as Record<string, string>;
        m[masterTextGuid] = value;
        return true;
      }
      const ch = n.children as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(ch)) for (const c of ch) if (walk(c)) return true;
      return false;
    }
    walk(doc);

    this.journal?.record(sessionId, {
      label: 'Override instance text',
      patches: [
        {
          guid: instanceGuid,
          field: 'symbolData.symbolOverrides',
          before: beforeOverrides,
          after: JSON.parse(JSON.stringify(sd.symbolOverrides)),
        },
      ],
    });

    return { ok: true };
  }
}
