/**
 * Use case: compare a Figma plugin's view of the current page tree against
 * our parser's view of the same .fig file (loaded as `sessionId`).
 *
 * The plugin sandbox emits a normalized JSON tree (see figma-plugin/code.js
 * `serializeNode`); this use case indexes both trees by node id, walks
 * comparable fields, and aggregates diffs by field name.
 *
 * Output is intended for the plugin UI to render — a list of fields where
 * Figma and our parser disagree, with counts. Each entry on top means
 * "this field is the highest-leverage parser bug to fix next".
 *
 * Phase 2 MVP scope: only the small set of fields the plugin sandbox emits
 * (size, transform, fills, stroke*, cornerRadius, stack* for autolayout,
 * TEXT.characters/fontSize/fontName). Expand as we close out high-frequency
 * mismatches.
 */
import type { SessionStore } from '../ports/SessionStore.js';
import type { DocumentNode } from '../domain/entities/Document.js';
import { NotFoundError } from './errors.js';

export interface FigmaNode {
  id: string;
  type: string;
  name?: string;
  visible?: boolean;
  size?: { x?: number; y?: number };
  transform?: { m02?: number; m12?: number };
  rotation?: number;
  opacity?: number;
  fills?: unknown[];
  strokes?: unknown[];
  strokeWeight?: number;
  cornerRadius?: number;
  characters?: string;
  fontSize?: number;
  fontName?: { family?: string; style?: string };
  stackMode?: string;
  stackSpacing?: number;
  stackPaddingLeft?: number;
  stackPaddingRight?: number;
  stackPaddingTop?: number;
  stackPaddingBottom?: number;
  stackPrimaryAlignItems?: string;
  stackCounterAlignItems?: string;
  children?: FigmaNode[];
}

export interface AuditCompareInput {
  sessionId: string;
  figmaTree: FigmaNode;
}

export interface DiffEntry {
  id: string;
  field: string;
  origValue: unknown;
  rtValue: unknown;
}

export interface AuditCompareOutput {
  summary: {
    figmaNodeCount: number;
    ourNodeCount: number;
    matchedNodes: number;
    onlyInFigma: number;
    onlyInOurs: number;
    totalDiffs: number;
  };
  topFields: Array<{ field: string; count: number }>;
  sample: DiffEntry[];
}

/**
 * Node types we skip on BOTH sides during indexing. Figma's plugin API and
 * REST API expose variables through `figma.variables.*` / `/v1/files/:key/variables`
 * — they don't appear in `figma.currentPage.children` or `document.children`.
 * Our parser walks them from the kiwi document anyway, so they show up as
 * `onlyInOurs` noise unless we strip them at the boundary.
 *
 * `VARIABLE_SET` for Figma's variable container (group of variables in a
 * collection). `SYMBOL` is our internal kiwi name for what Figma's APIs
 * call `COMPONENT` — not skipped, but normalized via `TYPE_ALIASES` below.
 */
const SKIP_TYPES = new Set(['VARIABLE', 'VARIABLE_SET']);

/**
 * Type-name aliases. Figma's plugin/REST API uses a slightly different
 * vocabulary than our internal kiwi types — semantically the same node,
 * different label. Normalize both sides to the Figma name before comparing.
 *   SYMBOL            (kiwi)  ↔  COMPONENT (Figma)
 *   ROUNDED_RECTANGLE (kiwi)  ↔  RECTANGLE (Figma — corner-radius is a property,
 *                                  not a separate type)
 */
const TYPE_ALIASES: Record<string, string> = {
  SYMBOL: 'COMPONENT',
  ROUNDED_RECTANGLE: 'RECTANGLE',
};

function normalizeType(t: unknown): unknown {
  if (typeof t !== 'string') return t;
  return TYPE_ALIASES[t] ?? t;
}

/**
 * Per-field default values. When the Figma REST API serializes a node it
 * omits fields equal to their type-default — Figma's plugin sandbox emits
 * them only when non-default (see `figma-plugin/code.js`). Our parser
 * always materializes the kiwi-decoded value. Treat `figma=undefined,
 * ours=<default>` as equal so the trial signal doesn't drown in this
 * representational difference.
 */
const FIELD_DEFAULTS: Record<string, unknown> = {
  opacity: 1,
  rotation: 0,
  cornerRadius: 0,
  strokeWeight: 0,
  visible: true,
  'fills.length': 0,
  'strokes.length': 0,
  // DOCUMENT / CANVAS root nodes have no absoluteBoundingBox in REST and no
  // x/y in the plugin API; our kiwi tree fills `transform` with identity for
  // every node. Treat undefined-vs-zero as equal so root-only diffs go away.
  'transform.m02': 0,
  'transform.m12': 0,
};

/**
 * Walk `n` and append (id → node) pairs to `out`, skipping nodes whose
 * type is in `SKIP_TYPES` (and their entire subtree, since variables
 * don't have meaningful descendants for our comparison).
 */
function indexById(
  n: { id?: string; type?: string; children?: Array<{ id?: string; type?: string; children?: unknown }> } | null | undefined,
  out: Map<string, unknown>,
): void {
  if (!n || typeof n !== 'object') return;
  if (typeof n.type === 'string' && SKIP_TYPES.has(n.type)) return;
  if (typeof n.id === 'string') out.set(n.id, n);
  if (Array.isArray(n.children)) {
    for (const c of n.children) indexById(c as never, out);
  }
}

/** Compare a single comparable field. Returns true if the values differ. */
function fieldDiffers(field: string, orig: unknown, rt: unknown): boolean {
  // Type aliasing: normalize both sides before comparing the `type` field.
  if (field === 'type') {
    orig = normalizeType(orig);
    rt = normalizeType(rt);
  }
  // Substitute default for `undefined` on either side when the field has a
  // known default (REST API / plugin emit-on-non-default convention vs. our
  // parser always materializes). After substitution we fall through to
  // the usual equality + numeric tolerance checks below.
  if (Object.prototype.hasOwnProperty.call(FIELD_DEFAULTS, field)) {
    const def = FIELD_DEFAULTS[field];
    if (orig === undefined) orig = def;
    if (rt === undefined) rt = def;
  }
  if (orig === rt) return false;
  // Both null/undefined → equal.
  if (orig == null && rt == null) return false;
  // NaN === NaN false in JS — treat both-NaN as equal.
  if (typeof orig === 'number' && typeof rt === 'number' && Number.isNaN(orig) && Number.isNaN(rt)) return false;
  // Floating-point tolerance — Figma plugin returns floats, our parser
  // sometimes round-trips through Float32 (Math.fround). 0.5px below screen
  // resolution is invisible.
  if (typeof orig === 'number' && typeof rt === 'number' && Math.abs(orig - rt) < 0.5) return false;
  return true;
}

/**
 * Comparable fields. Plugin/REST and our kiwi parser sometimes use
 * different key names for semantically the same datum (kiwi exposes
 * `fillPaints`/`textData.characters`/etc.; the public Figma APIs use
 * `fills`/`characters`). `pickFigma` reads from the plugin/REST shape
 * (see `figma-plugin/code.js` `serializeNode`) and `pickOurs` reads
 * from our `DocumentNode` kiwi shape.
 *
 * `gate` (optional): predicate that runs first; when it returns false the
 * comparison is skipped entirely. Used for fields whose value is only
 * meaningful in a specific node configuration (e.g. `stack*` fields are
 * dead data when autolayout is disabled — REST/plugin emit only when
 * layoutMode is set, our parser always emits).
 */
const COMPARABLE_FIELDS: Array<{
  field: string;
  pickFigma: (n: Record<string, unknown>) => unknown;
  pickOurs: (n: Record<string, unknown>) => unknown;
  gate?: (figma: Record<string, unknown>, ours: Record<string, unknown>) => boolean;
}> = (() => {
  // Most fields share the same key on both sides — declare once.
  const same = (field: string, pick: (n: Record<string, unknown>) => unknown) =>
    ({ field, pickFigma: pick, pickOurs: pick });
  const arrLen = (k: string) => (n: Record<string, unknown>) =>
    Array.isArray(n[k]) ? (n[k] as unknown[]).length : undefined;
  return [
    same('type', (n) => n.type),
    same('name', (n) => n.name),
    same('visible', (n) => n.visible),
    same('size.x', (n) => (n.size as { x?: number } | undefined)?.x),
    same('size.y', (n) => (n.size as { y?: number } | undefined)?.y),
    same('transform.m02', (n) => (n.transform as { m02?: number } | undefined)?.m02),
    same('transform.m12', (n) => (n.transform as { m12?: number } | undefined)?.m12),
    same('rotation', (n) => n.rotation),
    same('opacity', (n) => n.opacity),
    same('cornerRadius', (n) => n.cornerRadius),
    same('strokeWeight', (n) => n.strokeWeight),
    // fills/strokes — plugin uses `fills`/`strokes`, kiwi uses `fillPaints`/`strokePaints`.
    { field: 'fills.length', pickFigma: arrLen('fills'), pickOurs: arrLen('fillPaints') },
    { field: 'strokes.length', pickFigma: arrLen('strokes'), pickOurs: arrLen('strokePaints') },
    // TEXT-only fields. Plugin/REST omit font properties on non-TEXT nodes;
    // our parser leaves the kiwi `fontName` slot populated even on FRAMEs
    // when a stylesheet references it. Gate-skip non-TEXT nodes so the
    // audit signal isn't drowned in this representational difference.
    ...((): typeof COMPARABLE_FIELDS => {
      const gate = (fn: Record<string, unknown>) => fn.type === 'TEXT';
      return [
        {
          field: 'characters',
          pickFigma: (n) => n.characters,
          pickOurs: (n) => (n.textData as { characters?: string } | undefined)?.characters,
          gate,
        },
        { field: 'fontSize', pickFigma: (n) => n.fontSize, pickOurs: (n) => n.fontSize, gate },
        {
          field: 'fontName.family',
          pickFigma: (n) => (n.fontName as { family?: string } | undefined)?.family,
          pickOurs: (n) => (n.fontName as { family?: string } | undefined)?.family,
          gate,
        },
        {
          field: 'fontName.style',
          pickFigma: (n) => (n.fontName as { style?: string } | undefined)?.style,
          pickOurs: (n) => (n.fontName as { style?: string } | undefined)?.style,
          gate,
        },
      ];
    })(),
    same('stackMode', (n) => n.stackMode),
    // Stack* fields below are only meaningful when autolayout is on. The
    // gate runs first; when the Figma side has no `stackMode`, REST/plugin
    // emit nothing, but our parser still carries leftover kiwi values.
    // Without the gate those latent values would dominate the diff signal.
    // Per-side padding falls back to the legacy axis-paired field
    // (`stackHorizontalPadding` for L/R; `stackVerticalPadding` for T/B)
    // when not explicitly set per-side — mirrors Inspector.tsx's fallback.
    ...((): typeof COMPARABLE_FIELDS => {
      const gate = (fn: Record<string, unknown>) =>
        typeof fn.stackMode === 'string' && fn.stackMode !== 'NONE';
      const make = (
        field: string,
        pickFigma: (n: Record<string, unknown>) => unknown,
        pickOurs: (n: Record<string, unknown>) => unknown,
      ): typeof COMPARABLE_FIELDS[number] => ({ field, pickFigma, pickOurs, gate });
      return [
        make('stackSpacing', (n) => n.stackSpacing, (n) => n.stackSpacing),
        make('stackPaddingLeft', (n) => n.stackPaddingLeft, (n) => n.stackPaddingLeft ?? n.stackHorizontalPadding),
        make('stackPaddingRight', (n) => n.stackPaddingRight, (n) => n.stackPaddingRight ?? n.stackHorizontalPadding),
        make('stackPaddingTop', (n) => n.stackPaddingTop, (n) => n.stackPaddingTop ?? n.stackVerticalPadding),
        make('stackPaddingBottom', (n) => n.stackPaddingBottom, (n) => n.stackPaddingBottom ?? n.stackVerticalPadding),
        make('stackPrimaryAlignItems', (n) => n.stackPrimaryAlignItems, (n) => n.stackPrimaryAlignItems),
        make('stackCounterAlignItems', (n) => n.stackCounterAlignItems, (n) => n.stackCounterAlignItems),
      ];
    })(),
  ];
})();

export class AuditCompare {
  constructor(private readonly sessionStore: SessionStore) {}

  async execute({ sessionId, figmaTree }: AuditCompareInput): Promise<AuditCompareOutput> {
    const session = this.sessionStore.getById(sessionId);
    if (!session) throw new NotFoundError(`session ${sessionId} not found`);

    const figmaIdx = new Map<string, FigmaNode>();
    indexById(figmaTree as never, figmaIdx as never);

    const ourIdx = new Map<string, DocumentNode>();
    indexById(session.documentJson as never, ourIdx as never);

    const fieldCounts = new Map<string, number>();
    const sample: DiffEntry[] = [];
    let matched = 0;
    let onlyInFigma = 0;
    let onlyInOurs = 0;
    let totalDiffs = 0;

    for (const [id, fn] of figmaIdx) {
      const ours = ourIdx.get(id);
      if (!ours) {
        onlyInFigma++;
        continue;
      }
      matched++;
      for (const cf of COMPARABLE_FIELDS) {
        if (cf.gate && !cf.gate(fn as unknown as Record<string, unknown>, ours as unknown as Record<string, unknown>)) {
          continue;
        }
        const a = cf.pickFigma(fn as unknown as Record<string, unknown>);
        const b = cf.pickOurs(ours as unknown as Record<string, unknown>);
        if (fieldDiffers(cf.field, a, b)) {
          totalDiffs++;
          fieldCounts.set(cf.field, (fieldCounts.get(cf.field) ?? 0) + 1);
          if (sample.length < 200) {
            sample.push({ id, field: cf.field, origValue: a, rtValue: b });
          }
        }
      }
    }
    for (const id of ourIdx.keys()) {
      if (!figmaIdx.has(id)) onlyInOurs++;
    }

    const topFields = [...fieldCounts.entries()]
      .map(([field, count]) => ({ field, count }))
      .sort((x, y) => y.count - x.count);

    return {
      summary: {
        figmaNodeCount: figmaIdx.size,
        ourNodeCount: ourIdx.size,
        matchedNodes: matched,
        onlyInFigma,
        onlyInOurs,
        totalDiffs,
      },
      topFields,
      sample,
    };
  }
}
