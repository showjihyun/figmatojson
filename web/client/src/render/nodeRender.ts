/**
 * Per-node render plan generator.
 *
 * `nodeRender(node, ctx)` returns a Konva-agnostic plan describing one
 * node's visual decisions. The plan is consumed by Canvas's NodeShape
 * component, which translates it into Konva elements + handlers.
 *
 * Migrated kinds so far:
 *   - 'hidden'      — Effective Visibility false / isolation hide. (1A)
 *   - 'vector'      — VECTOR_TYPES with a precomputed _path string. (1A)
 *   - 'text-simple' — TEXT nodes that don't need per-character style runs.
 *                     Includes auto-resize + center/right overflow math. (1B)
 *   - 'fallthrough' — anything else (NodeShape uses the legacy inline path);
 *                     in particular text-styled (multi-run) for now. (1B)
 *
 * Slice 1C will extend the plan with 'paint-stack' (FRAME / RECTANGLE / GROUP /
 * INSTANCE — paint stack + stroke + shadow + clip). Slice 1D will migrate
 * 'text-styled' (multi-run) so the inline TEXT block can be deleted.
 *
 * The function is pure — no React, no Konva, no DOM. Callers that need
 * browser-only operations (text width measurement) inject them via
 * `RenderContext.measureText`.
 */

import { rotationDegrees } from '../lib/transform.js';
import { konvaBlendMode } from '../lib/blendMode.js';
import { konvaLineCap, konvaLineJoin } from '../lib/strokeCapJoin.js';
import { applyStrokeAlignToVectorPath } from '../lib/strokeAlign.js';
import { shadowFromEffects, type KonvaShadow } from '../lib/shadow.js';
import {
  konvaFontStyle,
  konvaLetterSpacing,
  konvaLineHeight,
  konvaTextAlign,
  konvaVerticalAlign,
} from '../lib/textStyle.js';
import { applyTextCase, konvaTextDecoration } from '../lib/textTransform.js';
import { hasStyledRuns, splitTextRuns } from '../lib/textStyleRuns.js';
import { solidFillCss, strokeFromPaints } from '@core/domain/color';

/** Vector types that carry a precomputed `_path` SVG string after toClientNode. */
const VECTOR_TYPES: ReadonlySet<string> = new Set([
  'VECTOR',
  'STAR',
  'LINE',
  'ELLIPSE',
  'REGULAR_POLYGON',
  'BOOLEAN_OPERATION',
  'ROUNDED_RECTANGLE',
]);

export interface RenderContext {
  /**
   * Round-23 isolation state, or null when the canvas isn't isolating
   * anything. `hide` lists ids whose subtree must be skipped entirely;
   * `ancestors` lists ids that lie on the path to the isolated target
   * (their fills/clips are suppressed but their children still render).
   */
  isolation: { hide: Set<string>; ancestors: Set<string> } | null;

  /**
   * Measure rendered text width in CSS pixels. Browser callers pass a
   * thin wrapper around canvas 2d `measureText`; tests pass a deterministic
   * stub. Slice 1A doesn't read this — declared now so 1B can consume it
   * without changing the signature.
   */
  measureText: (
    text: string,
    fontSize: number,
    fontFamily: string,
    fontStyle: string | undefined,
    letterSpacing: number | undefined,
  ) => number;
}

export interface NodeOuterFrame {
  bbox: { x: number; y: number; w: number; h: number };
  rotation: number | undefined;
  opacity: number | undefined;
  blendMode: GlobalCompositeOperation | undefined;
}

export interface NodeHiddenPlan {
  kind: 'hidden';
  reason: 'visible-false' | 'isolation-hide';
}

export interface NodeFallthroughPlan {
  kind: 'fallthrough';
  /** For tests / logs — describes why nodeRender punted. */
  reason: string;
}

export interface NodeVectorPlan {
  kind: 'vector';
  outer: NodeOuterFrame;
  path: string;
  pathOffset: { x: number; y: number };
  pathScale: { x: number; y: number };
  /** `'transparent'` when there's no SOLID fill paint. */
  fill: string;
  /**
   * Resolved stroke. `null` when no usable stroke. `fillAfterStrokeEnabled`
   * is set on OUTSIDE strokeAlign emulation; `clipToPath` instructs the
   * renderer to wrap the Path in a `<Group clipFunc>` for INSIDE
   * emulation. (round 13 §2)
   */
  stroke: { color: string; width: number; fillAfterStrokeEnabled: boolean } | null;
  /** When true, Canvas wraps the Path in a Group whose clipFunc fills `path`
   *  (with the same offset+scale) so the doubled stroke's outer half is
   *  clipped — emulating Figma's `strokeAlign: INSIDE`. */
  clipToPath: boolean;
  shadow: KonvaShadow | null;
  dashPattern: number[] | undefined;
  lineCap: 'butt' | 'round' | 'square' | undefined;
  lineJoin: 'miter' | 'round' | 'bevel' | undefined;
}

export interface NodeTextSimplePlan {
  kind: 'text-simple';
  outer: NodeOuterFrame;
  /**
   * X used for the KText element (may shift left from `outer.bbox.x` when
   * align=center/right and the natural text overflows the master width
   * — see web-canvas-text-frame-fidelity.spec.md §2.1 I-1).
   */
  drawX: number;
  drawY: number;
  /**
   * Width passed to KText. `undefined` when the layout shouldn't constrain
   * width (left/justify with non-fixed auto-resize); set to `outer.bbox.w`
   * (or the natural text width on overflow) otherwise. Konva omits the prop
   * when undefined.
   */
  drawWidth: number | undefined;
  /** Height — passes through `outer.bbox.h || undefined`. */
  drawHeight: number | undefined;
  text: string;
  fontSize: number;
  fontFamily: string;
  fontStyle: string | undefined;
  textDecoration: string | undefined;
  letterSpacing: number | undefined;
  lineHeight: number | undefined;
  verticalAlign: 'top' | 'middle' | 'bottom' | undefined;
  align: 'left' | 'center' | 'right' | 'justify' | undefined;
  fill: string;
  shadow: KonvaShadow | null;
}

export type NodeRenderPlan =
  | NodeHiddenPlan
  | NodeVectorPlan
  | NodeTextSimplePlan
  | NodeFallthroughPlan;

/** Resolve outer transform/composite props common to every visible kind. */
function readOuter(node: Record<string, unknown>): NodeOuterFrame {
  const transform = node.transform as { m02?: number; m12?: number } | undefined;
  const size = node.size as { x?: number; y?: number } | undefined;
  return {
    bbox: {
      x: transform?.m02 ?? 0,
      y: transform?.m12 ?? 0,
      w: size?.x ?? 0,
      h: size?.y ?? 0,
    },
    rotation: rotationDegrees(node.transform as never),
    opacity:
      typeof node.opacity === 'number' && node.opacity !== 1
        ? (node.opacity as number)
        : undefined,
    blendMode: konvaBlendMode(node.blendMode as string | undefined),
  };
}

function planVector(node: Record<string, unknown>): NodeVectorPlan {
  const pathFillRaw = solidFillCss(node as { fillPaints?: unknown });
  const fill = pathFillRaw === 'transparent' ? 'transparent' : pathFillRaw;
  const baseStroke = strokeFromPaints(node as { strokeWeight?: unknown; strokePaints?: unknown });
  // INSIDE strokeAlign emulation needs to know whether we have a visible
  // fill. With no fill the doubled stroke would just look thicker
  // (round 13 §3.3 — `pathFill === 'transparent'` ⇒ skip emulation).
  const align = applyStrokeAlignToVectorPath(
    baseStroke?.width,
    node.strokeAlign as 'INSIDE' | 'OUTSIDE' | 'CENTER' | undefined,
    fill !== 'transparent',
  );
  const stroke = baseStroke
    ? {
        color: baseStroke.color,
        width: align.strokeWidth,
        fillAfterStrokeEnabled: align.fillAfterStrokeEnabled,
      }
    : null;

  const offset = node._pathOffset as { x?: number; y?: number } | undefined;
  const scale = node._pathScale as { x?: number; y?: number } | undefined;
  const dashPattern =
    Array.isArray(node.dashPattern) && (node.dashPattern as number[]).length > 0
      ? (node.dashPattern as number[])
      : undefined;

  return {
    kind: 'vector',
    outer: readOuter(node),
    path: node._path as string,
    pathOffset: { x: offset?.x ?? 0, y: offset?.y ?? 0 },
    pathScale: { x: scale?.x ?? 1, y: scale?.y ?? 1 },
    fill,
    stroke,
    clipToPath: align.clipToPath,
    shadow: shadowFromEffects(node.effects as never),
    dashPattern,
    lineCap: konvaLineCap(node.strokeCap as never),
    lineJoin: konvaLineJoin(node.strokeJoin as never),
  };
}

/**
 * Resolve the base SOLID fill color for a TEXT node. Falls back to '#ddd'
 * when no usable SOLID paint exists — the same default Canvas's inline
 * branch has used since round 1, kept identical so 1B doesn't shift any
 * pixel that wasn't already shifted in 1A.
 */
function textBaseFillColor(node: Record<string, unknown>): string {
  const fills = node.fillPaints;
  if (!Array.isArray(fills)) return '#ddd';
  const first = (fills as Array<Record<string, unknown>>).find(
    (p) => (p as { type?: string }).type === 'SOLID' && (p as { visible?: boolean }).visible !== false,
  );
  if (!first || !first.color) return '#ddd';
  const c = first.color as { r?: number; g?: number; b?: number; a?: number };
  const r = Math.round((c.r ?? 0) * 255);
  const g = Math.round((c.g ?? 0) * 255);
  const b = Math.round((c.b ?? 0) * 255);
  const a = c.a ?? 1;
  return `rgba(${r},${g},${b},${a})`;
}

function planTextSimple(node: Record<string, unknown>, ctx: RenderContext): NodeTextSimplePlan {
  const outer = readOuter(node);
  const { x, y, w, h } = outer.bbox;

  const renderOverride = node._renderTextOverride;
  const textData = node.textData as { characters?: string } | undefined;
  const rawChars =
    typeof renderOverride === 'string' ? renderOverride : textData?.characters ?? '';
  // textCase applies AFTER the per-instance override (round 5 §6 Resolved
  // questions): override sets the literal string, render-time case shapes it.
  const text = applyTextCase(rawChars, node.textCase as string | undefined);

  const fontSize = typeof node.fontSize === 'number' ? (node.fontSize as number) : 12;
  const fontName = node.fontName as { family?: string; style?: string } | undefined;
  const fontFamily = fontName?.family ?? 'Inter';
  const fontStyle = konvaFontStyle(fontName?.style);
  const textDecoration = konvaTextDecoration(node.textDecoration as string | undefined);
  const letterSpacing = konvaLetterSpacing(
    node.letterSpacing as never,
    fontSize,
  );
  const lineHeight = konvaLineHeight(node.lineHeight as never, fontSize);
  const verticalAlign = konvaVerticalAlign(node.textAlignVertical as string | undefined);
  const align = konvaTextAlign(node.textAlignHorizontal as string | undefined);
  const fill = textBaseFillColor(node);
  const shadow = shadowFromEffects(node.effects as never);

  // Auto-resize math (web-canvas-text-frame-fidelity.spec.md §2.1):
  //  - NONE / TRUNCATE → fixed-width: pass `w` through.
  //  - center / right with natural-text overflow → grow KText box to `natural`,
  //    shift `drawX` so the visual position stays anchored where Figma intended.
  //  - everything else → omit width (KText renders at natural width).
  const isFixedWidthMode = node.textAutoResize === 'NONE' || node.textAutoResize === 'TRUNCATE';
  let drawX = x;
  let drawWidth: number | undefined;
  if (isFixedWidthMode) {
    drawWidth = w || undefined;
  } else if (align === 'center' || align === 'right') {
    const baseW = w || 0;
    const natural = ctx.measureText(text, fontSize, fontFamily, fontStyle, letterSpacing);
    if (natural > baseW && baseW > 0) {
      const overflow = natural - baseW;
      drawX = align === 'center' ? x - overflow / 2 : x - overflow;
      drawWidth = natural;
    } else {
      drawWidth = baseW || undefined;
    }
  }

  return {
    kind: 'text-simple',
    outer,
    drawX,
    drawY: y,
    drawWidth,
    drawHeight: h || undefined,
    text,
    fontSize,
    fontFamily,
    fontStyle,
    textDecoration,
    letterSpacing,
    lineHeight,
    verticalAlign,
    align,
    fill,
    shadow,
  };
}

/**
 * True when this TEXT node carries per-character style data AND there's at
 * least one styled (non-base) run. The multi-run branch in Canvas relies on
 * exactly this condition, so the predicate must match bit-for-bit.
 */
function needsStyledTextRuns(node: Record<string, unknown>): boolean {
  const renderOverride = node._renderTextOverride;
  if (typeof renderOverride === 'string') return false;
  const textData = node.textData as
    | { characters?: string; characterStyleIDs?: number[]; styleOverrideTable?: unknown[] }
    | undefined;
  if (!textData) return false;
  if (!Array.isArray(textData.characterStyleIDs)) return false;
  if (!Array.isArray(textData.styleOverrideTable)) return false;
  const chars = applyTextCase(textData.characters ?? '', node.textCase as string | undefined);
  const runs = splitTextRuns(
    chars,
    textData.characterStyleIDs,
    textData.styleOverrideTable as never,
  );
  return hasStyledRuns(runs);
}

export function nodeRender(
  node: Record<string, unknown>,
  ctx: RenderContext,
): NodeRenderPlan {
  const myId = (node.id as string | undefined) ?? '';
  if (ctx.isolation?.hide.has(myId)) {
    return { kind: 'hidden', reason: 'isolation-hide' };
  }
  if (node.visible === false) {
    return { kind: 'hidden', reason: 'visible-false' };
  }

  const type = node.type as string | undefined;

  if (
    typeof type === 'string' &&
    VECTOR_TYPES.has(type) &&
    typeof node._path === 'string' &&
    (node._path as string).length > 0
  ) {
    return planVector(node);
  }

  if (type === 'TEXT') {
    if (needsStyledTextRuns(node)) {
      return { kind: 'fallthrough', reason: 'text-styled' };
    }
    return planTextSimple(node, ctx);
  }

  return { kind: 'fallthrough', reason: 'paint-stack-pending-1c' };
}
