/**
 * Use case: apply a single field PATCH to a node.
 *
 * Mirrors the legacy /api/doc/:id PATCH handler shape: read the session's
 * message.json, locate the target node by guidStr, write the field via
 * the path tokenizer, persist, then mirror the change on the in-memory
 * documentJson + refresh component-text snapshots.
 */

import type { SessionStore } from '../ports/SessionStore.js';
import type { Session } from '../domain/entities/Session.js';
import type { ComponentTextRef } from '../domain/entities/Document.js';
import type { EditJournal } from '../ports/EditJournal.js';
import { NotFoundError, ValidationError } from './errors.js';
import { tokenizePath, setPath, getPath } from '../domain/path.js';
import { invalidateTextLayoutCache, pruneInstanceDerivedTextData } from '../domain/textInvalidation.js';

interface FsLike {
  readMessage(id: string): string;
  writeMessage(id: string, json: string): void;
}

export interface EditNodeInput {
  sessionId: string;
  nodeGuid: string;
  field: string;
  value: unknown;
}

export class EditNode {
  constructor(
    private readonly sessionStore: SessionStore & FsLike,
    /**
     * Optional — when set, every successful edit pushes a journal entry
     * so Undo/Redo can replay the inverse. The fakes in unit tests
     * usually omit it (the journal isn't what's under test there).
     */
    private readonly journal?: EditJournal,
  ) {}

  async execute({ sessionId, nodeGuid, field, value }: EditNodeInput): Promise<{ ok: true }> {
    const session: Session | null = this.sessionStore.getById(sessionId);
    if (!session) throw new NotFoundError(`session ${sessionId} not found`);

    const raw = this.sessionStore.readMessage(sessionId);
    const msg = JSON.parse(raw) as { nodeChanges?: Array<Record<string, unknown>> };
    const node = msg.nodeChanges?.find((n) => {
      const g = n.guid as { sessionID?: number; localID?: number } | undefined;
      return g && `${g.sessionID}:${g.localID}` === nodeGuid;
    });
    if (!node) throw new NotFoundError(`node ${nodeGuid} not found`);

    const tokens = tokenizePath(field);
    if (tokens.length === 0) throw new ValidationError('empty field path');
    // Capture pre-mutation value for the journal — undo writes this back.
    const before = getPath(node, tokens);
    setPath(node, tokens, value);

    // When the user changes textData.characters on a master TEXT, Figma's
    // pre-computed layout cache (glyphs, baselines, derivedLines, ...) on
    // both this node and every INSTANCE referencing it goes stale. Without
    // invalidation Figma reads the cache on import and silently shows the
    // OLD text. See web/core/domain/textInvalidation.ts.
    if (field === 'textData.characters' && typeof value === 'string') {
      invalidateTextLayoutCache(node, value);
      pruneInstanceDerivedTextData(msg, nodeGuid);
    }

    this.sessionStore.writeMessage(sessionId, JSON.stringify(msg));

    // Mirror onto the in-memory documentJson so subsequent /doc fetches
    // reflect the edit without reparsing message.json.
    const doc = session.documentJson as unknown as Record<string, unknown>;
    function walk(n: Record<string, unknown>): boolean {
      const g = n.guid as { sessionID: number; localID: number } | undefined;
      if (g && `${g.sessionID}:${g.localID}` === nodeGuid) {
        setPath(n, tokens, value);
        return true;
      }
      const children = n.children as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(children)) for (const c of children) if (walk(c)) return true;
      return false;
    }
    walk(doc);

    // For master text edits, refresh every INSTANCE's _componentTexts cache
    // that references this master text guid.
    if (field === 'textData.characters' && typeof value === 'string') {
      const newChars = value;
      function refresh(n: Record<string, unknown>): void {
        const refs = n._componentTexts as ComponentTextRef[] | undefined;
        if (Array.isArray(refs)) for (const r of refs) if (r.guid === nodeGuid) r.characters = newChars;
        const ch = n.children as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(ch)) for (const c of ch) refresh(c);
      }
      refresh(doc);
    }

    this.journal?.record(sessionId, {
      label: 'Edit',
      patches: [{ guid: nodeGuid, field, before, after: value }],
    });

    return { ok: true };
  }
}
