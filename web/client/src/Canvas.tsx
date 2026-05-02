/**
 * Konva-based renderer for a single CANVAS (page) of the document.json tree.
 *
 * Renders frames / texts / rectangles. Selection drawn as a Figma-style
 * overlay: blue 1px outline + 4 white corner squares + a "W × H" badge below.
 *
 * Rendering shortcuts (intentionally lossy for PoC):
 *   - fillPaints[0].color → fill color (no gradients/images yet)
 *   - transform.m02/m12 → x/y (rotation/skew skipped)
 *   - vectorData / fillGeometry → bbox rect placeholder
 */
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Stage, Layer, Rect, Text as KText, Group, Path, Image as KImage, Line } from 'react-konva';
import type Konva from 'konva';
import { cornerDrag, groupBbox, projectMembers, type Corner } from './multiResize';
import { solidFillCss, solidStrokeCss } from '@core/domain/color';
import { imageHashHex } from '@core/domain/image';
import { guidStr } from '@core/domain/tree';
import type { DocumentNode } from '@core/domain/entities/Document';
import {
  SelectionContext,
  SelectionStore,
  useIsSelected,
} from './canvas-selection';
import {
  cullChildrenByViewport,
  viewportInStageCoords,
} from './canvas-cull';
import { type HoverInfo } from './components/canvas/HoverTooltip';
import { HoverOverlay } from './components/canvas/HoverOverlay';
import { countVariantChildren } from './lib/variants';
import {
  konvaFontStyle,
  konvaLetterSpacing,
  konvaLineHeight,
  konvaTextAlign,
  konvaVerticalAlign,
} from './lib/textStyle';
import { applyStrokeAlign } from './lib/strokeAlign';
import { shadowFromEffects } from './lib/shadow';
import { rotationDegrees } from './lib/transform';
import { konvaLineCap, konvaLineJoin } from './lib/strokeCapJoin';
import { firstStopRgba, gradientFromPaint, type KonvaGradient } from './lib/gradient';
import { pickTopPaint } from './lib/paint';

// ─── Drag-snapshot plumbing ──────────────────────────────────────────────
//
// On dragStart we walk the tree once to capture every selected node's
// initial parent-local position; on dragEnd each NodeShape reads the same
// map so multi-select drag fans out a delta atomically. Storing the map
// in a ref behind a stable context value means selection changes never
// invalidate NodeShape's memoization.

interface DragSnapshotApi {
  prepare(): void;
  get(guid: string): { x: number; y: number } | null;
}
const DragSnapshotContext = createContext<DragSnapshotApi | null>(null);

/**
 * Hover plumbing — NodeShape publishes mouse-enter/leave to the Canvas via
 * this context, and Canvas owns the single hovered guid + bbox snapshot.
 * Lives next to DragSnapshotContext so it gets the same memoization
 * properties (stable identity → no NodeShape re-renders just because hover
 * changed).
 *
 * Spec: docs/specs/web-canvas-hover-tooltip.spec.md §S1–S5
 */
interface HoverApi {
  enter(e: Konva.KonvaEventObject<MouseEvent>, node: any): void;
  leave(guid: string): void;
}
const HoverContext = createContext<HoverApi | null>(null);

interface CanvasProps {
  page: any;
  selectedGuids: Set<string>;
  onSelect: (guid: string | null, mode?: 'replace' | 'toggle') => void;
  /** Drag-group: emits new positions for every selected node atomically. */
  onMoveMany?: (updates: Array<{ guid: string; x: number; y: number }>) => void;
  onResize?: (guid: string, x: number, y: number, w: number, h: number) => void;
  /** Resize-group: emits new bounds for every selected node atomically. */
  onResizeMany?: (updates: Array<{ guid: string; x: number; y: number; w: number; h: number }>) => void;
  /** Required for IMAGE fill rendering — keys the asset URL space. */
  sessionId: string | null;
}

/**
 * Load an HTMLImageElement from a URL with cancel-safe lifecycle.
 * Returns null while loading or on error so callers can no-op.
 */
function useImageElement(src: string | null): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    const im = new window.Image();
    im.crossOrigin = 'anonymous';
    let cancelled = false;
    im.onload = () => {
      if (!cancelled) setImg(im);
    };
    im.onerror = () => {
      if (!cancelled) setImg(null);
    };
    im.src = src;
    return () => {
      cancelled = true;
      im.onload = null;
      im.onerror = null;
    };
  }, [src]);
  return img;
}

/**
 * Renders an asset-server-backed image inside a node's bbox, clipped to the
 * node's cornerRadius. Sits below stroke/children but above the placeholder
 * fill rect, so the rect's color shows during load.
 */
function ImageFill({
  src,
  width,
  height,
  cornerRadius,
}: {
  src: string | null;
  width: number;
  height: number;
  cornerRadius: number;
}) {
  const img = useImageElement(src);
  if (!img || width <= 0 || height <= 0) return null;
  if (cornerRadius > 0) {
    const r = Math.min(cornerRadius, width / 2, height / 2);
    return (
      <Group
        clipFunc={(ctx) => {
          ctx.beginPath();
          ctx.moveTo(r, 0);
          ctx.lineTo(width - r, 0);
          ctx.arcTo(width, 0, width, r, r);
          ctx.lineTo(width, height - r);
          ctx.arcTo(width, height, width - r, height, r);
          ctx.lineTo(r, height);
          ctx.arcTo(0, height, 0, height - r, r);
          ctx.lineTo(0, r);
          ctx.arcTo(0, 0, r, 0, r);
          ctx.closePath();
        }}
      >
        <KImage image={img} x={0} y={0} width={width} height={height} listening={false} />
      </Group>
    );
  }
  return <KImage image={img} x={0} y={0} width={width} height={height} listening={false} />;
}

// `guidStr`, `solidFillCss` (was `colorOf`), `solidStrokeCss` (was `strokeOf`)
// live in `@core/domain/color.ts` and `@core/domain/tree.ts` now.
// Local aliases preserve the old call sites' names without further churn.
const colorOf = solidFillCss;
const strokeOf = solidStrokeCss;

const VECTOR_TYPES = new Set([
  'VECTOR',
  'STAR',
  'LINE',
  'ELLIPSE',
  'REGULAR_POLYGON',
  'BOOLEAN_OPERATION',
  'ROUNDED_RECTANGLE',
]);

interface NodeShapeProps {
  node: any;
  onSelect: (g: string | null, mode?: 'replace' | 'toggle') => void;
  onDragGroup?: (guid: string, dx: number, dy: number) => void;
  sessionId: string | null;
}

function NodeShapeImpl({
  node,
  onSelect,
  onDragGroup,
  sessionId,
}: NodeShapeProps) {
  const guid = guidStr(node.guid);
  const isSelected = useIsSelected(guid);
  const dragApi = useContext(DragSnapshotContext);
  const hoverApi = useContext(HoverContext);

  if (node.visible === false) return null;
  const x = node.transform?.m02 ?? 0;
  const y = node.transform?.m12 ?? 0;
  const w = node.size?.x ?? 0;
  const h = node.size?.y ?? 0;
  const stroke = strokeOf(node);
  const cornerR = node.cornerRadius ?? 0;

  // Universal Figma props (round 3):
  //   - rotation: pure-rotation matrices → degrees; skew falls through to
  //     translation-only (spec I-R3).
  //   - opacity: pass through 0..1; undefined when 1 / missing.
  // Both apply on the OUTER element (Group / KText) so children inherit.
  const rotation = rotationDegrees(node.transform);
  const opacity = typeof node.opacity === 'number' && node.opacity !== 1
    ? node.opacity
    : undefined;

  // Hover: skip for instance master expansions so hover bubbles up to the
  // outer INSTANCE (spec I-S5). e.cancelBubble in onMouseEnter ensures the
  // deepest LISTENING node wins when nested groups are stacked. Also skip
  // when this node has no guid — there's nothing to track.
  const hoverEnabled = !node._isInstanceChild && guid != null;
  const onMouseEnter = hoverEnabled
    ? (e: Konva.KonvaEventObject<MouseEvent>): void => {
        e.cancelBubble = true;
        hoverApi?.enter(e, node);
      }
    : undefined;
  const onMouseLeave = hoverEnabled
    ? (): void => { hoverApi?.leave(guid as string); }
    : undefined;

  const onDragStart = (): void => {
    // Build the snapshot lazily: cheap when nobody drags, correct because
    // it sees the latest selection + page state at the moment dragging begins.
    dragApi?.prepare();
    // Hide hover during drag (spec I-S3) — Konva suppresses mouseEnter while
    // dragging so we won't re-show until drag ends.
    if (hoverEnabled) hoverApi?.leave(guid as string);
  };

  // Drag-end → compute delta from initial position, emit to onDragGroup
  // which handles fanout to every selected node.
  const onDragEnd = (e: Konva.KonvaEventObject<DragEvent>): void => {
    if (!guid || !onDragGroup) return;
    const initial = dragApi?.get(guid);
    if (!initial) {
      // Fallback: no snapshot — just emit the absolute new position.
      onDragGroup(guid, e.target.x() - x, e.target.y() - y);
      return;
    }
    const dx = e.target.x() - initial.x;
    const dy = e.target.y() - initial.y;
    onDragGroup(guid, dx, dy);
  };

  const onShapeClick = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void => {
    e.cancelBubble = true;
    // shiftKey only exists on MouseEvent / KeyboardEvent — touch users get
    // single-select fallback, which is fine.
    const native = e.evt as { shiftKey?: boolean } | undefined;
    const shift = !!native?.shiftKey;
    onSelect(guid, shift ? 'toggle' : 'replace');
  };

  if (node.type === 'TEXT') {
    // Render-time text override (per-instance) wins over master textData.
    const chars = (node._renderTextOverride as string | undefined) ?? node.textData?.characters ?? '';
    const fontSize = node.fontSize ?? 12;
    const fontFamily = node.fontName?.family ?? 'Inter';
    const fillColor = (() => {
      const fills = node.fillPaints;
      if (!Array.isArray(fills)) return '#ddd';
      const first = fills.find((p: any) => p?.type === 'SOLID' && p?.visible !== false);
      if (!first?.color) return '#ddd';
      const { r = 0, g = 0, b = 0, a = 1 } = first.color;
      return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
    })();
    // Spec web-render-fidelity-high.spec.md §3.1–3.5 — pull the additional
    // typography fields off the kiwi node and pass them through. Helpers
    // return undefined for absent / default values so JSX spread props
    // fall back to Konva's defaults without explicit branching here.
    const letterSpacing = konvaLetterSpacing(node.letterSpacing, fontSize);
    const lineHeight = konvaLineHeight(node.lineHeight, fontSize);
    const verticalAlign = konvaVerticalAlign(node.textAlignVertical);
    const align = konvaTextAlign(node.textAlignHorizontal);
    const fontStyle = konvaFontStyle(node.fontName?.style);
    const shadow = shadowFromEffects(node.effects);
    return (
      <KText
        x={x}
        y={y}
        rotation={rotation}
        opacity={opacity}
        text={chars}
        fontSize={fontSize}
        fontFamily={fontFamily}
        fontStyle={fontStyle}
        letterSpacing={letterSpacing}
        lineHeight={lineHeight}
        verticalAlign={verticalAlign}
        align={align}
        fill={fillColor}
        width={w || undefined}
        height={h || undefined}
        shadowEnabled={shadow != null}
        shadowOffsetX={shadow?.shadowOffsetX}
        shadowOffsetY={shadow?.shadowOffsetY}
        shadowBlur={shadow?.shadowBlur}
        shadowColor={shadow?.shadowColor}
        shadowOpacity={shadow?.shadowOpacity}
        draggable={isSelected}
        onClick={onShapeClick}
        onTap={onShapeClick}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        listening
      />
    );
  }

  if (VECTOR_TYPES.has(node.type) && typeof node._path === 'string' && node._path.length > 0) {
    const pathFill = colorOfWithDefault(node, 'transparent');
    const vectorShadow = shadowFromEffects(node.effects);
    const lineCap = konvaLineCap(node.strokeCap);
    const lineJoin = konvaLineJoin(node.strokeJoin);
    const vectorDash = Array.isArray(node.dashPattern) && node.dashPattern.length > 0
      ? (node.dashPattern as number[])
      : undefined;
    return (
      <Group
        x={x}
        y={y}
        rotation={rotation}
        opacity={opacity}
        draggable={isSelected}
        onClick={onShapeClick}
        onTap={onShapeClick}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <Path
          data={node._path}
          fill={pathFill}
          stroke={stroke?.color}
          strokeWidth={stroke?.width}
          dash={vectorDash}
          lineCap={lineCap}
          lineJoin={lineJoin}
          shadowEnabled={vectorShadow != null}
          shadowOffsetX={vectorShadow?.shadowOffsetX}
          shadowOffsetY={vectorShadow?.shadowOffsetY}
          shadowBlur={vectorShadow?.shadowBlur}
          shadowColor={vectorShadow?.shadowColor}
          shadowOpacity={vectorShadow?.shadowOpacity}
          listening
        />
      </Group>
    );
  }

  // Resolve the rect's fill — last visible non-IMAGE paint wins (Figma
  // stacks paints bottom-up, so [N-1] is the user-visible top). For
  // SOLID we get a CSS color string; for LINEAR/RADIAL gradient we get
  // Konva fill props; angular/diamond falls back to first-stop color.
  // Spec web-render-fidelity-round4.spec.md §3.
  const topPaint = pickTopPaint(node.fillPaints as Array<{ type?: string; visible?: boolean }> | undefined);
  let fillColor: string = 'transparent';
  let gradient: KonvaGradient | null = null;
  if (topPaint) {
    const t = (topPaint as { type?: string }).type;
    if (t === 'SOLID') {
      fillColor = colorOf(node);
    } else if (t === 'GRADIENT_LINEAR' || t === 'GRADIENT_RADIAL') {
      gradient = gradientFromPaint(topPaint as Parameters<typeof gradientFromPaint>[0], w, h);
      if (!gradient) fillColor = firstStopRgba(topPaint as Parameters<typeof firstStopRgba>[0]) ?? 'transparent';
    } else if (t === 'GRADIENT_ANGULAR' || t === 'GRADIENT_DIAMOND') {
      // Konva doesn't render these — fall back to the first stop color.
      fillColor = firstStopRgba(topPaint as Parameters<typeof firstStopRgba>[0]) ?? 'transparent';
    }
  }
  // Per-stroke dash array (Figma stores [dash, gap, ...]); pass through
  // to Konva's `dash` prop on stroke-bearing elements only.
  const dash = Array.isArray(node.dashPattern) && node.dashPattern.length > 0
    ? (node.dashPattern as number[])
    : undefined;

  // Children to render: native children (FRAME etc.) OR an INSTANCE's
  // expanded master tree (`_renderChildren`). The latter lets buttons /
  // icons / labels actually appear inside an instance — without it,
  // INSTANCE shows as a bare colored rect.
  const renderableChildren =
    Array.isArray(node.children) && node.children.length > 0
      ? node.children
      : (node._renderChildren as any[] | undefined) ?? [];
  const hasChildren = renderableChildren.length > 0;

  const imgHash = imageHashHex(node);
  const imgSrc = imgHash && sessionId ? `/api/asset/${sessionId}/${imgHash}` : null;

  // Per-side stroke (spec web-render-fidelity-high.spec.md §3.6) — when
  // border{Top,Right,Bottom,Left}Weight values differ AND strokePaints is
  // non-empty, draw individual Konva.Line segments instead of letting the
  // background Rect carry a uniform stroke. Common Figma pattern: a row
  // with only a 1px bottom border (table cell, calendar grid).
  const bt = node.borderTopWeight as number | undefined;
  const br = node.borderRightWeight as number | undefined;
  const bb = node.borderBottomWeight as number | undefined;
  const bl = node.borderLeftWeight as number | undefined;
  const hasPerSideValues = bt != null || br != null || bb != null || bl != null;
  const sidesUniform = hasPerSideValues && bt === br && br === bb && bb === bl;
  const wantPerSide = hasPerSideValues && !sidesUniform && !!stroke;

  // strokeAlign INSIDE / OUTSIDE — adjust the background Rect's geometry
  // so the stroke sits inside (or outside) the original bbox edges
  // (spec web-render-fidelity-round2.spec.md §2). Per-side stroke uses
  // Konva.Line segments and isn't affected.
  const rectDims = !wantPerSide && stroke
    ? applyStrokeAlign(
        { x: 0, y: 0, w, h, cornerRadius: cornerR },
        stroke.width,
        node.strokeAlign as 'INSIDE' | 'OUTSIDE' | 'CENTER' | undefined,
      )
    : { x: 0, y: 0, w, h, cornerRadius: cornerR };

  // Drop shadow (spec round2 §4) — first visible DROP_SHADOW from
  // effects[]. Multiple shadows / inner shadow / blur fall through to v2.
  const shadow = shadowFromEffects(node.effects);

  // Frame clip (spec round2 §3) — when frameMaskDisabled === false,
  // clip children to the frame's rounded-rect bounds. Konva clipFunc
  // receives a 2D context; we draw the path the renderer should clip to.
  const wantClip = node.frameMaskDisabled === false;
  // Konva passes a SceneContext (its proxy around the native canvas
  // context). The path-building methods we use exist on both but the
  // Konva-internal type isn't easily reachable, so we type the param as
  // the structural subset we actually call.
  type PathCtx = Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'rect' | 'closePath'>;
  const clipFunc = wantClip
    ? ((ctx: PathCtx): void => {
        if (cornerR > 0) {
          const r = Math.min(cornerR, w / 2, h / 2);
          ctx.moveTo(r, 0);
          ctx.lineTo(w - r, 0);
          ctx.quadraticCurveTo(w, 0, w, r);
          ctx.lineTo(w, h - r);
          ctx.quadraticCurveTo(w, h, w - r, h);
          ctx.lineTo(r, h);
          ctx.quadraticCurveTo(0, h, 0, h - r);
          ctx.lineTo(0, r);
          ctx.quadraticCurveTo(0, 0, r, 0);
          ctx.closePath();
        } else {
          ctx.rect(0, 0, w, h);
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    : undefined;

  const lineCap = konvaLineCap(node.strokeCap);
  const lineJoin = konvaLineJoin(node.strokeJoin);

  return (
    <Group
      x={x}
      y={y}
      rotation={rotation}
      opacity={opacity}
      draggable={isSelected}
      onClick={onShapeClick}
      onTap={onShapeClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      clipFunc={clipFunc}
    >
      <Rect
        x={rectDims.x}
        y={rectDims.y}
        width={rectDims.w}
        height={rectDims.h}
        fill={gradient ? undefined : fillColor}
        fillLinearGradientStartPoint={gradient?.kind === 'linear' ? gradient.fillLinearGradientStartPoint : undefined}
        fillLinearGradientEndPoint={gradient?.kind === 'linear' ? gradient.fillLinearGradientEndPoint : undefined}
        fillLinearGradientColorStops={gradient?.kind === 'linear' ? gradient.fillLinearGradientColorStops : undefined}
        fillRadialGradientStartPoint={gradient?.kind === 'radial' ? gradient.fillRadialGradientStartPoint : undefined}
        fillRadialGradientEndPoint={gradient?.kind === 'radial' ? gradient.fillRadialGradientEndPoint : undefined}
        fillRadialGradientStartRadius={gradient?.kind === 'radial' ? gradient.fillRadialGradientStartRadius : undefined}
        fillRadialGradientEndRadius={gradient?.kind === 'radial' ? gradient.fillRadialGradientEndRadius : undefined}
        fillRadialGradientColorStops={gradient?.kind === 'radial' ? gradient.fillRadialGradientColorStops : undefined}
        stroke={wantPerSide ? undefined : stroke?.color}
        strokeWidth={wantPerSide ? undefined : stroke?.width}
        dash={wantPerSide ? undefined : dash}
        lineJoin={lineJoin}
        cornerRadius={rectDims.cornerRadius}
        shadowEnabled={shadow != null}
        shadowOffsetX={shadow?.shadowOffsetX}
        shadowOffsetY={shadow?.shadowOffsetY}
        shadowBlur={shadow?.shadowBlur}
        shadowColor={shadow?.shadowColor}
        shadowOpacity={shadow?.shadowOpacity}
        listening
      />
      {wantPerSide && bt && bt > 0 && (
        <Line points={[0, 0, w, 0]} stroke={stroke!.color} strokeWidth={bt} lineCap={lineCap} dash={dash} listening={false} />
      )}
      {wantPerSide && br && br > 0 && (
        <Line points={[w, 0, w, h]} stroke={stroke!.color} strokeWidth={br} lineCap={lineCap} dash={dash} listening={false} />
      )}
      {wantPerSide && bb && bb > 0 && (
        <Line points={[0, h, w, h]} stroke={stroke!.color} strokeWidth={bb} lineCap={lineCap} dash={dash} listening={false} />
      )}
      {wantPerSide && bl && bl > 0 && (
        <Line points={[0, 0, 0, h]} stroke={stroke!.color} strokeWidth={bl} lineCap={lineCap} dash={dash} listening={false} />
      )}
      {imgSrc && (
        <ImageFill src={imgSrc} width={w} height={h} cornerRadius={cornerR} />
      )}
      {hasChildren &&
        renderableChildren.map((c: any, i: number) => (
          <NodeShape
            key={i}
            node={c}
            onSelect={onSelect}
            onDragGroup={onDragGroup}
            sessionId={sessionId}
          />
        ))}
    </Group>
  );
}

// Memoized so that re-renders triggered by pan/zoom/selection at the Canvas
// level skip every NodeShape whose data + handlers haven't changed. Selection
// state for THIS node comes from `useIsSelected` (subscription), not props,
// so a click that flips one guid only re-renders the affected nodes.
const NodeShape = memo(NodeShapeImpl);

function colorOfWithDefault(node: any, fallback: string): string {
  const c = colorOf(node);
  return c === 'transparent' ? fallback : c;
}

/** Compute the absolute bounds of the selected node by walking the tree.
 *  Returns null if not found. Accumulates parent transforms. */
function findAbsBounds(
  root: any,
  guid: string,
  parentX = 0,
  parentY = 0,
): { x: number; y: number; w: number; h: number } | null {
  if (!root || typeof root !== 'object') return null;
  const tx = root.transform?.m02 ?? 0;
  const ty = root.transform?.m12 ?? 0;
  const ax = parentX + tx;
  const ay = parentY + ty;
  if (root.guid && `${root.guid.sessionID}:${root.guid.localID}` === guid) {
    return { x: ax, y: ay, w: root.size?.x ?? 0, h: root.size?.y ?? 0 };
  }
  if (Array.isArray(root.children)) {
    for (const c of root.children) {
      const f = findAbsBounds(c, guid, ax, ay);
      if (f) return f;
    }
  }
  return null;
}

/** Figma-style selection overlay with draggable corner handles for resize. */
function SelectionOverlay({
  bounds,
  scale,
  onResize,
  guid,
}: {
  bounds: { x: number; y: number; w: number; h: number };
  scale: number;
  onResize?: (guid: string, x: number, y: number, w: number, h: number) => void;
  guid: string | null;
}) {
  const HANDLE = 8 / scale;
  const STROKE = 1.5 / scale;
  const BADGE_FONT = 11 / scale;
  const BADGE_PAD_X = 6 / scale;
  const BADGE_PAD_Y = 3 / scale;
  // Local resize preview: while dragging, render bounds from this state for fluid feedback.
  const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const live = drag ?? bounds;
  const sizeLabel = `${Math.round(live.w)} × ${Math.round(live.h)}`;
  const labelW = sizeLabel.length * BADGE_FONT * 0.55 + BADGE_PAD_X * 2;
  const labelH = BADGE_FONT + BADGE_PAD_Y * 2;

  const corners: Array<{
    cx: number; cy: number;
    /** axis flags: which edge each axis pulls from */
    ax: 'x' | 'r'; ay: 'y' | 'b';
  }> = [
    { cx: live.x, cy: live.y, ax: 'x', ay: 'y' },                        // top-left
    { cx: live.x + live.w, cy: live.y, ax: 'r', ay: 'y' },               // top-right
    { cx: live.x, cy: live.y + live.h, ax: 'x', ay: 'b' },               // bottom-left
    { cx: live.x + live.w, cy: live.y + live.h, ax: 'r', ay: 'b' },      // bottom-right
  ];

  return (
    <Group>
      <Rect
        x={live.x}
        y={live.y}
        width={live.w}
        height={live.h}
        stroke="#0a84ff"
        strokeWidth={STROKE}
        fill="transparent"
        listening={false}
      />
      {corners.map((c, i) => (
        <Rect
          key={i}
          x={c.cx - HANDLE / 2}
          y={c.cy - HANDLE / 2}
          width={HANDLE}
          height={HANDLE}
          fill="white"
          stroke="#0a84ff"
          strokeWidth={STROKE}
          draggable={!!onResize}
          onDragMove={(e) => {
            // Compute new bounds from the dragged corner position.
            const nx = e.target.x() + HANDLE / 2;
            const ny = e.target.y() + HANDLE / 2;
            let x = bounds.x, y = bounds.y, w = bounds.w, h = bounds.h;
            if (c.ax === 'x') { w = bounds.x + bounds.w - nx; x = nx; }
            else { w = nx - bounds.x; }
            if (c.ay === 'y') { h = bounds.y + bounds.h - ny; y = ny; }
            else { h = ny - bounds.y; }
            // Clamp minimums
            if (w < 1) { w = 1; if (c.ax === 'x') x = bounds.x + bounds.w - 1; }
            if (h < 1) { h = 1; if (c.ay === 'y') y = bounds.y + bounds.h - 1; }
            setDrag({ x, y, w, h });
          }}
          onDragEnd={() => {
            if (drag && guid && onResize) onResize(guid, drag.x, drag.y, drag.w, drag.h);
            setDrag(null);
          }}
        />
      ))}
      <Group
        x={live.x + live.w / 2 - labelW / 2}
        y={live.y + live.h + 6 / scale}
        listening={false}
      >
        <Rect width={labelW} height={labelH} fill="#0a84ff" cornerRadius={3 / scale} />
        <KText
          text={sizeLabel}
          x={BADGE_PAD_X}
          y={BADGE_PAD_Y}
          fontSize={BADGE_FONT}
          fontFamily="Inter, system-ui, sans-serif"
          fill="white"
        />
      </Group>
    </Group>
  );
}

export function Canvas({ page, selectedGuids, onSelect, onMoveMany, onResize, onResizeMany, sessionId }: CanvasProps) {
  // Single-selection convenience for resize bounds + multi-bbox iteration.
  const selectedGuid = selectedGuids.size === 1 ? [...selectedGuids][0]! : null;
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(0.25);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [pageId, setPageId] = useState<string | null>(null);
  // Pan state — Figma-like: hold Space to enable hand tool, then drag.
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false,
    lastX: 0,
    lastY: 0,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Track Space key for pan tool. Filter out modifiers + form fields.
  useEffect(() => {
    const isFormField = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !e.repeat && !isFormField(e.target)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') {
        setSpaceHeld(false);
        panRef.current.active = false;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Wheel handler — Figma semantics:
  //   - Ctrl/⌘ + wheel  → zoom toward cursor (preventDefault to override
  //                        the browser's page-zoom shortcut)
  //   - Bare wheel      → pan vertically; shift+wheel pans horizontally
  // React's onWheel synthetic event is passive in some setups so
  // preventDefault is unreliable — we attach a non-passive native listener
  // directly on the container element.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        setScale((s) => {
          const ns = Math.max(0.02, Math.min(8, s * factor));
          setOffset((o) => {
            const stageX = (cx - o.x) / s;
            const stageY = (cy - o.y) / s;
            return { x: cx - stageX * ns, y: cy - stageY * ns };
          });
          return ns;
        });
      } else {
        // Pan with the wheel — also preventDefault so the page doesn't scroll.
        e.preventDefault();
        if (e.shiftKey) {
          // shift+wheel maps deltaY to horizontal pan
          setOffset((o) => ({ x: o.x - e.deltaY, y: o.y - e.deltaX }));
        } else {
          setOffset((o) => ({ x: o.x - e.deltaX, y: o.y - e.deltaY }));
        }
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // Auto-fit page bbox to viewport on first render of a new page (id-based, so
  // edits to the same page don't re-trigger the fit and reset zoom).
  useEffect(() => {
    if (!page || size.width === 0) return;
    if (page.id === pageId) return;
    const children = page.children ?? [];
    if (children.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of children) {
      const cx = c.transform?.m02 ?? 0;
      const cy = c.transform?.m12 ?? 0;
      const cw = c.size?.x ?? 0;
      const ch = c.size?.y ?? 0;
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cx + cw > maxX) maxX = cx + cw;
      if (cy + ch > maxY) maxY = cy + ch;
    }
    if (!isFinite(minX)) return;
    const w = maxX - minX;
    const h = maxY - minY;
    const sx = (size.width - 80) / w;
    const sy = (size.height - 80) / h;
    const s = Math.min(sx, sy, 1);
    setScale(s);
    setOffset({
      x: -minX * s + (size.width - w * s) / 2,
      y: -minY * s + (size.height - h * s) / 2,
    });
    setPageId(page.id);
  }, [page, size.width, size.height, pageId]);

  // External-store mirror of `selectedGuids`. Created once; .set()'d on every
  // change. NodeShapes subscribe via `useIsSelected` so only the changed
  // guids re-render — the other 35K nodes skip reconciliation entirely.
  const selectionStoreRef = useRef<SelectionStore | null>(null);
  if (selectionStoreRef.current === null) {
    selectionStoreRef.current = new SelectionStore();
  }
  const selectionStore = selectionStoreRef.current;
  // useLayoutEffect (not useEffect) so subscribers see the new selection
  // before the browser paints — avoids a one-frame lag where the previous
  // selection's `draggable={isSelected}` is still in effect.
  useLayoutEffect(() => {
    selectionStore.set(selectedGuids);
  }, [selectionStore, selectedGuids]);

  // Drag snapshot: a stable API object whose `prepare()` walks the tree once
  // when a drag begins. Keeping the API in useMemo([]) means NodeShape's
  // useContext consumer never re-renders from this context updating.
  const pageRef = useRef(page);
  pageRef.current = page;
  const selectedGuidsRef = useRef(selectedGuids);
  selectedGuidsRef.current = selectedGuids;
  const dragSnapshotMapRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const dragSnapshotApi = useMemo<DragSnapshotApi>(() => ({
    prepare(): void {
      const m = new Map<string, { x: number; y: number }>();
      const sel = selectedGuidsRef.current;
      function visit(n: any): void {
        if (!n || typeof n !== 'object') return;
        const g = n.guid ? `${n.guid.sessionID}:${n.guid.localID}` : null;
        if (g && sel.has(g)) {
          m.set(g, { x: n.transform?.m02 ?? 0, y: n.transform?.m12 ?? 0 });
        }
        if (Array.isArray(n.children)) for (const c of n.children) visit(c);
      }
      visit(pageRef.current);
      dragSnapshotMapRef.current = m;
    },
    get(guid): { x: number; y: number } | null {
      return dragSnapshotMapRef.current.get(guid) ?? null;
    },
  }), []);

  // Page-level viewport culling: skip top-level children whose bbox sits
  // entirely outside the visible Stage rect. A typical 35K-node doc spends
  // most of its volume inside off-screen frames; skipping those at the
  // page level avoids reconciling all of their descendants.
  const visibleChildren = useMemo(() => {
    const all = (page?.children ?? []) as DocumentNode[];
    if (size.width === 0 || size.height === 0) return all;
    const viewport = viewportInStageCoords(size, offset, scale);
    return cullChildrenByViewport(all, viewport);
  }, [page, size, offset, scale]);

  // Compute selection bounds for every selected node (absolute coords).
  const selectionBoundsList = useMemo(() => {
    const out: Array<{ guid: string; bounds: { x: number; y: number; w: number; h: number } }> = [];
    for (const g of selectedGuids) {
      const b = findAbsBounds(page, g);
      if (b) out.push({ guid: g, bounds: b });
    }
    return out;
  }, [page, selectedGuids]);
  // Single-selection bounds (used for resize handles)
  const singleBounds = selectedGuid ? selectionBoundsList[0]?.bounds ?? null : null;

  // ── Hover state (spec docs/specs/web-canvas-hover-tooltip.spec.md) ──
  // designBbox is in stage-local UNTRANSFORMED coords (i.e., design space) —
  // stable under pan/zoom. We map it to viewport pixels on each render
  // using the current offset/scale so the tooltip stays glued to the node.
  const [hover, setHover] = useState<{
    guid: string;
    info: HoverInfo;
    designBbox: { x: number; y: number; width: number; height: number };
  } | null>(null);

  const hoverApi = useMemo<HoverApi>(() => ({
    enter(e, node) {
      const stage = e.target.getStage();
      if (!stage) return;
      // {relativeTo: stage} → bbox in stage's local (design) coords;
      // independent of stage's own scale/translate.
      const rect = e.target.getClientRect({ relativeTo: stage });
      const g = guidStr(node.guid);
      if (!g) return;
      // Variant container detection — covers both newer COMPONENT_SET and
      // legacy FRAME-with-variant-named-SYMBOL-children shapes (spec
      // I-T5.1). 0 ⇒ no variants segment in the tooltip.
      const vc = countVariantChildren(node);
      const variantCount: number | undefined = vc > 0 ? vc : undefined;
      setHover({
        guid: g,
        info: {
          name: node.name,
          type: node.type,
          w: node.size?.x != null ? Math.round(node.size.x) : undefined,
          h: node.size?.y != null ? Math.round(node.size.y) : undefined,
          variantCount,
        },
        designBbox: rect,
      });
    },
    leave(guid) {
      // Only clear if the leaving node is the one we currently show — a
      // mouse zip across two adjacent shapes fires `leave(A)` then
      // `enter(B)`, but the order can flip. This guard prevents B's
      // tooltip from being killed by A's late `leave`.
      setHover((cur) => (cur?.guid === guid ? null : cur));
    },
  }), []);

  // (v2) hover overlay is now Konva-rendered inside the Stage's Layer,
  // so we no longer convert design-space bbox to browser-viewport
  // pixels here — Konva applies the Stage transform automatically.

  // Stable callback so memoized NodeShapes don't re-render on every Canvas
  // state tick (size / scale / offset / spaceHeld). Reads selection from the
  // ref so the closure doesn't need to refresh.
  const onDragGroup = useCallback((anchorGuid: string, dx: number, dy: number): void => {
    if (!onMoveMany) return;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
    const updates: Array<{ guid: string; x: number; y: number }> = [];
    for (const g of selectedGuidsRef.current) {
      const start = dragSnapshotMapRef.current.get(g);
      if (!start) continue;
      updates.push({ guid: g, x: start.x + dx, y: start.y + dy });
    }
    void anchorGuid;
    if (updates.length > 0) onMoveMany(updates);
  }, [onMoveMany]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
        cursor: spaceHeld ? (panRef.current.active ? 'grabbing' : 'grab') : 'default',
      }}
      onMouseDown={(e) => {
        if (spaceHeld) {
          e.preventDefault();
          panRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
        }
      }}
      onMouseMove={(e) => {
        if (panRef.current.active) {
          const dx = e.clientX - panRef.current.lastX;
          const dy = e.clientY - panRef.current.lastY;
          panRef.current.lastX = e.clientX;
          panRef.current.lastY = e.clientY;
          setOffset((o) => ({ x: o.x + dx, y: o.y + dy }));
        }
      }}
      onMouseUp={() => {
        panRef.current.active = false;
      }}
      onMouseLeave={() => {
        panRef.current.active = false;
        setHover(null); // I-S4
      }}
    >
      <Stage
        width={size.width}
        height={size.height}
        x={offset.x}
        y={offset.y}
        scaleX={scale}
        scaleY={scale}
        listening={!spaceHeld}    // disable shape clicks while pan tool is active
      >
        <Layer
          listening={!spaceHeld}
          onClick={(e) => {
            if (e.target === e.target.getStage()) onSelect(null);
          }}
        >
          <SelectionContext.Provider value={selectionStore}>
            <DragSnapshotContext.Provider value={dragSnapshotApi}>
              <HoverContext.Provider value={hoverApi}>
                {visibleChildren.map((c) => (
                  // Key by guid so React reuses the same NodeShape instance
                  // when culling shifts the array — avoids unmount/remount of
                  // memoized subtrees on pan.
                  <NodeShape
                    key={(c.guid as { sessionID: number; localID: number }).sessionID + ':' + (c.guid as { sessionID: number; localID: number }).localID}
                    node={c}
                    onSelect={onSelect}
                    onDragGroup={onDragGroup}
                    sessionId={sessionId}
                  />
                ))}
              </HoverContext.Provider>
            </DragSnapshotContext.Provider>
          </SelectionContext.Provider>
        </Layer>
        {(selectionBoundsList.length > 0 || hover) && (
          <Layer listening={!spaceHeld}>
            {/* Resize handles only when EXACTLY one node is selected — multi-
                resize would need per-node directional logic; for the PoC we
                just let users drag the group and resize one at a time. */}
            {singleBounds && selectedGuid && (
              <SelectionOverlay
                bounds={singleBounds}
                scale={scale}
                onResize={onResize}
                guid={selectedGuid}
              />
            )}
            {/* Multi-select: group bbox + corner handles that scale all
                selected nodes uniformly relative to the group bbox. */}
            {selectionBoundsList.length > 1 && (
              <MultiSelectionOverlay
                members={selectionBoundsList}
                scale={scale}
                onResizeMany={onResizeMany}
              />
            )}
            {/* Hover overlay — Figma-style 1px stroke + name pill at top-
                left of the hovered node. Suppressed when that node is
                already selected (the selection overlay covers it). Spec
                docs/specs/web-canvas-hover-tooltip.spec.md (v2). */}
            {hover && !selectedGuids.has(hover.guid) && (
              <HoverOverlay
                bbox={{
                  x: hover.designBbox.x,
                  y: hover.designBbox.y,
                  width: hover.designBbox.width,
                  height: hover.designBbox.height,
                }}
                name={hover.info.name ?? ''}
                scale={scale}
              />
            )}
          </Layer>
        )}
      </Stage>
      <ZoomBadge scale={scale} />
      {spaceHeld && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            background: 'rgba(10,132,255,0.9)',
            color: 'white',
            fontSize: 11,
            padding: '4px 10px',
            borderRadius: 4,
            pointerEvents: 'none',
            fontFamily: 'Inter, system-ui, sans-serif',
            fontWeight: 600,
          }}
        >
          ✋ Pan (Space)
        </div>
      )}
    </div>
  );
}

/** Lightweight bbox shown for each member of a multi-selection (no handles). */
function MultiBox({
  bounds,
  scale,
}: {
  bounds: { x: number; y: number; w: number; h: number };
  scale: number;
}) {
  return (
    <Rect
      x={bounds.x}
      y={bounds.y}
      width={bounds.w}
      height={bounds.h}
      stroke="#0a84ff"
      strokeWidth={1.5 / scale}
      fill="transparent"
      listening={false}
    />
  );
}

/**
 * Multi-select overlay: a single group bbox enclosing every selected node,
 * with 4 corner handles. Dragging a corner uniformly scales each member
 * relative to the group bbox (Figma's "scale" handle behavior).
 *
 * The drag preview is computed locally and rendered in-component so all
 * member outlines move together with the group bbox; the resize-many
 * callback fires once on drag end with the final per-node bounds.
 */
function MultiSelectionOverlay({
  members,
  scale,
  onResizeMany,
}: {
  members: Array<{ guid: string; bounds: { x: number; y: number; w: number; h: number } }>;
  scale: number;
  onResizeMany?: (updates: Array<{ guid: string; x: number; y: number; w: number; h: number }>) => void;
}) {
  const HANDLE = 8 / scale;
  const STROKE = 1.5 / scale;
  const orig = useMemo(() => groupBbox(members.map((m) => m.bounds)), [members]);

  // Drag preview: scaled group bbox while the user is dragging a corner.
  const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const live = drag ?? orig;
  const liveMembers = projectMembers(orig, live, members);

  const corners: Array<{ cx: number; cy: number; corner: Corner }> = [
    { cx: live.x, cy: live.y, corner: 'tl' },
    { cx: live.x + live.w, cy: live.y, corner: 'tr' },
    { cx: live.x, cy: live.y + live.h, corner: 'bl' },
    { cx: live.x + live.w, cy: live.y + live.h, corner: 'br' },
  ];

  return (
    <Group>
      {/* Member outlines, projected through the live group bbox so they
          track the drag preview. */}
      {liveMembers.map((m) => (
        <Rect
          key={m.guid}
          x={m.bounds.x}
          y={m.bounds.y}
          width={m.bounds.w}
          height={m.bounds.h}
          stroke="#0a84ff"
          strokeWidth={STROKE}
          fill="transparent"
          listening={false}
        />
      ))}
      {/* Group bbox */}
      <Rect
        x={live.x}
        y={live.y}
        width={live.w}
        height={live.h}
        stroke="#0a84ff"
        strokeWidth={STROKE}
        dash={[6 / scale, 4 / scale]}
        fill="transparent"
        listening={false}
      />
      {corners.map((c) => (
        <Rect
          key={c.corner}
          x={c.cx - HANDLE / 2}
          y={c.cy - HANDLE / 2}
          width={HANDLE}
          height={HANDLE}
          fill="white"
          stroke="#0a84ff"
          strokeWidth={STROKE}
          draggable={!!onResizeMany}
          onDragMove={(e) => {
            const nx = e.target.x() + HANDLE / 2;
            const ny = e.target.y() + HANDLE / 2;
            setDrag(cornerDrag(orig, c.corner, nx, ny));
          }}
          onDragEnd={() => {
            if (drag && onResizeMany) {
              const updates = projectMembers(orig, drag, members).map((m) => ({
                guid: m.guid,
                x: m.bounds.x,
                y: m.bounds.y,
                w: m.bounds.w,
                h: m.bounds.h,
              }));
              onResizeMany(updates);
            }
            setDrag(null);
          }}
        />
      ))}
    </Group>
  );
}

function ZoomBadge({ scale }: { scale: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 12,
        right: 12,
        background: 'rgba(0,0,0,0.6)',
        color: '#bbb',
        fontSize: 11,
        padding: '4px 8px',
        borderRadius: 4,
        pointerEvents: 'none',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      {Math.round(scale * 100)}%
    </div>
  );
}
