/**
 * Per-node render plan generator.
 *
 * `nodeRender(node, ctx)` returns a Konva-agnostic plan describing one
 * node's visual decisions. The plan is consumed by Canvas's NodeShape
 * component, which translates it into Konva elements + handlers.
 *
 * Slice 1A scope:
 *   - 'hidden' — Effective Visibility false / isolation hide.
 *   - 'vector' — VECTOR_TYPES with a precomputed _path string.
 *   - 'fallthrough' — anything else (NodeShape uses the legacy inline path).
 *
 * Slices 1B / 1C will extend the plan with 'text-simple' and 'paint-stack'.
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
   * is set when INSIDE strokeAlign emulation is in effect (round 13).
   */
  stroke: { color: string; width: number; fillAfterStrokeEnabled: boolean } | null;
  shadow: KonvaShadow | null;
  dashPattern: number[] | undefined;
  lineCap: 'butt' | 'round' | 'square' | undefined;
  lineJoin: 'miter' | 'round' | 'bevel' | undefined;
}

export type NodeRenderPlan =
  | NodeHiddenPlan
  | NodeVectorPlan
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
    shadow: shadowFromEffects(node.effects as never),
    dashPattern,
    lineCap: konvaLineCap(node.strokeCap as never),
    lineJoin: konvaLineJoin(node.strokeJoin as never),
  };
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

  return { kind: 'fallthrough', reason: 'not-yet-handled-by-slice-1a' };
}
