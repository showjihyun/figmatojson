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
import { Stage, Layer, Rect, Text as KText, Group } from 'react-konva';

interface CanvasProps {
  page: any;
  selectedGuid: string | null;
  onSelect: (guid: string | null) => void;
}

function guidStr(g: any): string | null {
  if (!g || typeof g !== 'object') return null;
  if (typeof g.sessionID !== 'number' || typeof g.localID !== 'number') return null;
  return `${g.sessionID}:${g.localID}`;
}

function colorOf(node: any): string {
  const fills = node.fillPaints;
  if (!Array.isArray(fills)) return 'transparent';
  const first = fills.find((p: any) => p?.type === 'SOLID' && p?.visible !== false);
  if (!first?.color) return 'transparent';
  const { r = 0, g = 0, b = 0, a = 1 } = first.color;
  const op = typeof first.opacity === 'number' ? first.opacity : 1;
  const fa = a * op;
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${fa.toFixed(3)})`;
}

function strokeOf(node: any): { color: string; width: number } | null {
  if (typeof node.strokeWeight !== 'number' || node.strokeWeight <= 0) return null;
  const strokes = node.strokePaints;
  if (!Array.isArray(strokes)) return null;
  const first = strokes.find((p: any) => p?.type === 'SOLID' && p?.visible !== false);
  if (!first?.color) return null;
  const { r = 0, g = 0, b = 0, a = 1 } = first.color;
  const op = typeof first.opacity === 'number' ? first.opacity : 1;
  return {
    color: `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${(a * op).toFixed(3)})`,
    width: node.strokeWeight,
  };
}

function NodeShape({
  node,
  selectedGuid,
  onSelect,
}: {
  node: any;
  selectedGuid: string | null;
  onSelect: (g: string | null) => void;
}) {
  if (node.visible === false) return null;
  const x = node.transform?.m02 ?? 0;
  const y = node.transform?.m12 ?? 0;
  const w = node.size?.x ?? 0;
  const h = node.size?.y ?? 0;
  const guid = guidStr(node.guid);
  const stroke = strokeOf(node);
  const cornerR = node.cornerRadius ?? 0;

  if (node.type === 'TEXT') {
    const chars = node.textData?.characters ?? '';
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
        onClick={(e) => {
          e.cancelBubble = true;
          onSelect(guid);
        }}
        onTap={(e) => {
          e.cancelBubble = true;
          onSelect(guid);
        }}
        listening
      />
    );
  }

  const fill = colorOf(node);
  const isContainer = Array.isArray(node.children) && node.children.length > 0;

  return (
    <Group x={x} y={y}>
      <Rect
        x={0}
        y={0}
        width={w}
        height={h}
        fill={fill}
        stroke={stroke?.color}
        strokeWidth={stroke?.width}
        cornerRadius={cornerR}
        onClick={(e) => {
          e.cancelBubble = true;
          onSelect(guid);
        }}
        onTap={(e) => {
          e.cancelBubble = true;
          onSelect(guid);
        }}
        listening
      />
      {isContainer &&
        node.children.map((c: any, i: number) => (
          <NodeShape key={i} node={c} selectedGuid={selectedGuid} onSelect={onSelect} />
        ))}
    </Group>
  );
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

/** Figma-style selection overlay: blue outline + 4 corner handles + size badge. */
function SelectionOverlay({
  bounds,
  scale,
}: {
  bounds: { x: number; y: number; w: number; h: number };
  scale: number;
}) {
  const HANDLE = 6 / scale;
  const STROKE = 1.5 / scale;
  const BADGE_FONT = 11 / scale;
  const BADGE_PAD_X = 6 / scale;
  const BADGE_PAD_Y = 3 / scale;
  const sizeLabel = `${Math.round(bounds.w)} × ${Math.round(bounds.h)}`;
  const labelW = sizeLabel.length * BADGE_FONT * 0.55 + BADGE_PAD_X * 2;
  const labelH = BADGE_FONT + BADGE_PAD_Y * 2;
  return (
    <Group listening={false}>
      <Rect
        x={bounds.x}
        y={bounds.y}
        width={bounds.w}
        height={bounds.h}
        stroke="#0a84ff"
        strokeWidth={STROKE}
        fill="transparent"
      />
      {[
        { cx: bounds.x, cy: bounds.y },
        { cx: bounds.x + bounds.w, cy: bounds.y },
        { cx: bounds.x, cy: bounds.y + bounds.h },
        { cx: bounds.x + bounds.w, cy: bounds.y + bounds.h },
      ].map((p, i) => (
        <Rect
          key={i}
          x={p.cx - HANDLE / 2}
          y={p.cy - HANDLE / 2}
          width={HANDLE}
          height={HANDLE}
          fill="white"
          stroke="#0a84ff"
          strokeWidth={STROKE}
        />
      ))}
      {/* size badge below the selection */}
      <Group x={bounds.x + bounds.w / 2 - labelW / 2} y={bounds.y + bounds.h + 6 / scale}>
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

export function Canvas({ page, selectedGuid, onSelect }: CanvasProps) {
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

  // Compute selection bounds (absolute coords)
  const selectionBounds = useMemo(
    () => (selectedGuid ? findAbsBounds(page, selectedGuid) : null),
    [page, selectedGuid],
  );

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
      onWheel={(e) => {
        e.preventDefault();
        // Figma-style: zoom toward cursor (anchored).
        const rect = containerRef.current?.getBoundingClientRect();
        const cx = rect ? e.clientX - rect.left : 0;
        const cy = rect ? e.clientY - rect.top : 0;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        setScale((s) => {
          const ns = Math.max(0.02, Math.min(8, s * factor));
          // Keep the cursor's stage point fixed during zoom.
          setOffset((o) => {
            const sx = (cx - o.x) / s;
            const sy = (cy - o.y) / s;
            return { x: cx - sx * ns, y: cy - sy * ns };
          });
          return ns;
        });
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
            <NodeShape key={i} node={c} selectedGuid={selectedGuid} onSelect={onSelect} />
          ))}
        </Layer>
        {selectionBounds && (
          <Layer listening={false}>
            <SelectionOverlay bounds={selectionBounds} scale={scale} />
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
