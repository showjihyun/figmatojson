/**
 * Domain entity: a decoded .fig document, framework-free.
 *
 * Mirrors the on-the-wire shape that flows from the kiwi decoder through to
 * the canvas / inspector. Defined here (instead of being re-exported from
 * `web/server` or `client/src/api.ts`) so that BOTH driving adapters
 * (HTTP, React) and driven adapters (filesystem, codec) can talk about
 * the same structure without importing from each other.
 *
 * Phase 1: only the shape is defined here. Phase 2 will migrate the
 * existing ClientNode definition in server/index.ts to alias this type,
 * and move client-side helpers that operate on it into core/domain/.
 */

export interface Guid {
  sessionID: number;
  localID: number;
}

export interface ComponentTextRef {
  guid: string;
  name?: string;
  path: string;
  characters: string;
}

/**
 * A node in the document tree. Identical in shape to the legacy
 * `ClientNode` — kept here as the canonical core type going forward.
 *
 * The `[k: string]: unknown` index signature is intentional: the kiwi schema
 * decodes hundreds of optional fields per node type and we don't want the
 * core to enumerate every one. Adapters that mutate specific fields
 * (e.g. `transform.m02`) reference them by string path through `path.ts`.
 */
export interface DocumentNode {
  id: string;
  guid: Guid;
  type: string;
  name?: string;
  children?: DocumentNode[];

  /** Pre-decoded SVG path for VECTOR-family nodes. */
  _path?: string;

  /** Editable text refs for INSTANCE nodes (component master text). */
  _componentTexts?: ComponentTextRef[];

  /** Per-instance text overrides keyed by master text GUID. */
  _instanceOverrides?: Record<string, string>;

  /**
   * Master subtree expanded into the INSTANCE for canvas rendering.
   * Each rendered child keeps its master GUID; `_isInstanceChild: true`
   * marks the virtual render-only branch.
   */
  _renderChildren?: DocumentNode[];
  _isInstanceChild?: boolean;

  /** Render-time per-instance text override applied at draw time. */
  _renderTextOverride?: string;

  [k: string]: unknown;
}

/** A `Document` is the root tree (typically with type === 'DOCUMENT'). */
export type Document = DocumentNode;
