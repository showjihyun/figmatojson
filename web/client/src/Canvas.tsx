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
import { useEffect, useRef, useState, useMemo } from 'react';
import { Stage, Layer, Rect, Text as KText, Group, Path, Image as KImage } from 'react-konva';
import type Konva from 'konva';
import { cornerDrag, groupBbox, projectMembers, type Corner } from './multiResize';
import { solidFillCss, solidStrokeCss } from '@core/domain/color';
import { imageHashHex } from '@core/domain/image';
import { guidStr } from '@core/domain/tree';

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
  selectedGuids: Set<string>;
  onSelect: (g: string | null, mode?: 'replace' | 'toggle') => void;
  onDragGroup?: (guid: string, dx: number, dy: number) => void;
  dragSnapshot?: Map<string, { x: number; y: number }>;
  sessionId: string | null;
}

function NodeShape({
  node,
  selectedGuids,
  onSelect,
  onDragGroup,
  dragSnapshot,
  sessionId,
}: NodeShapeProps) {
  if (node.visible === false) return null;
  const x = node.transform?.m02 ?? 0;
  const y = node.transform?.m12 ?? 0;
  const w = node.size?.x ?? 0;
  const h = node.size?.y ?? 0;
  const guid = guidStr(node.guid);
  const stroke = strokeOf(node);
  const cornerR = node.cornerRadius ?? 0;
  const isSelected = !!guid && selectedGuids.has(guid);

  // Drag-end → compute delta from initial position, emit to onDragGroup
  // which handles fanout to every selected node.
  const onDragEnd = (e: Konva.KonvaEventObject<DragEvent>): void => {
    if (!guid || !onDragGroup) return;
    const initial = dragSnapshot?.get(guid);
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
    return (
      <KText
        x={x}
        y={y}
        text={chars}
        fontSize={fontSize}
        fontFamily={fontFamily}
        fill={fillColor}
        width={w || undefined}
        height={h || undefined}
        draggable={isSelected}
        onClick={onShapeClick}
        onTap={onShapeClick}
        onDragEnd={onDragEnd}
        listening
      />
    );
  }

  if (VECTOR_TYPES.has(node.type) && typeof node._path === 'string' && node._path.length > 0) {
    const pathFill = colorOfWithDefault(node, 'transparent');
    return (
      <Group
        x={x}
        y={y}
        draggable={isSelected}
        onClick={onShapeClick}
        onTap={onShapeClick}
        onDragEnd={onDragEnd}
      >
        <Path
          data={node._path}
          fill={pathFill}
          stroke={stroke?.color}
          strokeWidth={stroke?.width}
          listening
        />
      </Group>
    );
  }

  const fill = colorOf(node);
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

  return (
    <Group
      x={x}
      y={y}
      draggable={isSelected}
      onClick={onShapeClick}
      onTap={onShapeClick}
      onDragEnd={onDragEnd}
    >
      <Rect
        x={0}
        y={0}
        width={w}
        height={h}
        fill={fill}
        stroke={stroke?.color}
        strokeWidth={stroke?.width}
        cornerRadius={cornerR}
        listening
      />
      {imgSrc && (
        <ImageFill src={imgSrc} width={w} height={h} cornerRadius={cornerR} />
      )}
      {hasChildren &&
        renderableChildren.map((c: any, i: number) => (
          <NodeShape
            key={i}
            node={c}
            selectedGuids={selectedGuids}
            onSelect={onSelect}
            onDragGroup={onDragGroup}
            dragSnapshot={dragSnapshot}
            sessionId={sessionId}
          />
        ))}
    </Group>
  );
}

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

  // Drag-group: capture initial parent-local positions on drag start, fan
  // the delta out across every selected node on drag end.
  const dragSnapshot = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    function visit(n: any): void {
      if (!n || typeof n !== 'object') return;
      const g = n.guid ? `${n.guid.sessionID}:${n.guid.localID}` : null;
      if (g && selectedGuids.has(g)) {
        m.set(g, { x: n.transform?.m02 ?? 0, y: n.transform?.m12 ?? 0 });
      }
      if (Array.isArray(n.children)) for (const c of n.children) visit(c);
    }
    visit(page);
    return m;
  }, [page, selectedGuids]);

  const onDragGroup = (anchorGuid: string, dx: number, dy: number): void => {
    if (!onMoveMany) return;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
    const updates: Array<{ guid: string; x: number; y: number }> = [];
    for (const g of selectedGuids) {
      const start = dragSnapshot.get(g);
      if (!start) continue;
      updates.push({ guid: g, x: start.x + dx, y: start.y + dy });
    }
    void anchorGuid;
    if (updates.length > 0) onMoveMany(updates);
  };

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
          {(page.children ?? []).map((c: any, i: number) => (
            <NodeShape
              key={i}
              node={c}
              selectedGuids={selectedGuids}
              onSelect={onSelect}
              onDragGroup={onDragGroup}
              dragSnapshot={dragSnapshot}
              sessionId={sessionId}
            />
          ))}
        </Layer>
        {selectionBoundsList.length > 0 && (
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
