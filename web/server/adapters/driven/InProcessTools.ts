/**
 * In-process ToolDispatcher.
 *
 * Wraps the existing `applyTool` function (still living in server/index.ts
 * during the migration) and exposes it as a port. The catalogue describes
 * the 5 mutations Claude can request from the chat panel — same shape we
 * already pass to the Anthropic SDK / Agent SDK; consolidating them here
 * means the chat use case (Phase 4) only needs to know about the port.
 */

import type {
  ToolCall,
  ToolDispatcher,
  ToolOutcome,
} from '../../../core/ports/ToolDispatcher.js';
import type { Session } from '../../../core/domain/entities/Session.js';
import type { SessionStore } from '../../../core/ports/SessionStore.js';

/** Signature of the legacy `applyTool` function in server/index.ts. */
export type ApplyToolFn = (
  s: Session,
  name: string,
  input: Record<string, unknown>,
) => Promise<void>;

const CATALOGUE = [
  {
    name: 'set_text',
    description:
      'Set the textData.characters of a TEXT node. Affects every instance that references this master.',
    inputSchema: {
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
      "Set per-instance text override for a single text node within an INSTANCE. The master text and other instances are NOT affected.",
    inputSchema: {
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
    description: "Move a node by setting transform.m02 (x) and transform.m12 (y).",
    inputSchema: {
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
    description: "Resize a node by setting size.x (w) and size.y (h).",
    inputSchema: {
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
      "Set the first SOLID fillPaints[0].color RGBA channels (each 0..1).",
    inputSchema: {
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
  {
    name: 'set_corner_radius',
    description: "Set cornerRadius (px). Use 0 for sharp corners.",
    inputSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string' },
        value: { type: 'number', description: 'Corner radius in pixels, >= 0.' },
      },
      required: ['guid', 'value'],
    },
  },
  {
    name: 'align_nodes',
    description:
      "Align 2+ nodes inside their collective bounding box. axis is one of " +
      "left/center/right (horizontal) or top/middle/bottom (vertical), " +
      "matching Figma's Align toolbar.",
    inputSchema: {
      type: 'object',
      properties: {
        guids: { type: 'array', items: { type: 'string' }, minItems: 2 },
        axis: {
          type: 'string',
          enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'],
        },
      },
      required: ['guids', 'axis'],
    },
  },
  {
    name: 'duplicate',
    description:
      "Clone a node and its entire subtree. The clone gets fresh GUIDs and is " +
      "placed (dx, dy) px offset from the original (defaults: 20, 20). Returns " +
      "after the new sibling is inserted next to the source.",
    inputSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Source node GUID like "26:269".' },
        dx: { type: 'number', description: 'Horizontal offset px. Defaults to 20.' },
        dy: { type: 'number', description: 'Vertical offset px. Defaults to 20.' },
      },
      required: ['guid'],
    },
  },
] as const;

export class InProcessTools implements ToolDispatcher {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly applyToolFn: ApplyToolFn,
  ) {}

  async apply(sessionId: string, call: ToolCall): Promise<ToolOutcome> {
    const session = this.sessionStore.getById(sessionId);
    if (!session) return { call, ok: false, error: `session ${sessionId} not found` };
    try {
      await this.applyToolFn(session, call.name, call.input);
      return { call, ok: true };
    } catch (err) {
      return { call, ok: false, error: (err as Error).message };
    }
  }

  catalogue(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return CATALOGUE.map((t) => ({ ...t }));
  }
}
