/**
 * Konva-based renderer for a single CANVAS (page) of the document.json tree.
 *
 * Scope (PoC): renders frames as colored rectangles, texts as Konva Text,
 * vectors / rectangles as Konva Rect. Selection emits the node guid.
 *
 * Rendering shortcuts (intentionally lossy for PoC):
 *   - fillPaints[0].color → fill color (no gradients/images)
 *   - text fills also use fillPaints[0]
 *   - transform.m02/m12 → x/y (rotation/skew skipped — most Figma docs are axis-aligned)
 *   - cornerRadius → simple radius
 *   - vectorData.vectorNetworkBlob → SVG path via existing decoder (NOT in PoC; show as bbox rect)
 */
import { useEffect, useRef, useState } from 'react';
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
  const isSelected = guid && selectedGuid === guid;

  const stroke = strokeOf(node);
  const selectionStroke = isSelected
    ? { color: '#0a84ff', width: 2 }
    : stroke ?? { color: 'transparent', width: 0 };

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

  // FRAME / RECTANGLE / etc — colored rect; descend into children for FRAME
  const cornerR = node.cornerRadius ?? 0;
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
        stroke={selectionStroke.color}
        strokeWidth={selectionStroke.width}
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

export function Canvas({ page, selectedGuid, onSelect }: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(0.25);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

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

  // Auto-fit page bbox to viewport on first render of a new page
  useEffect(() => {
    if (!page || size.width === 0) return;
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
  }, [page, size.width, size.height]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', overflow: 'hidden' }}
      onWheel={(e) => {
        // Wheel-to-zoom (basic)
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        setScale((s) => Math.max(0.02, Math.min(8, s * factor)));
      }}
    >
      <Stage width={size.width} height={size.height} x={offset.x} y={offset.y} scaleX={scale} scaleY={scale}>
        <Layer
          listening
          onClick={(e) => {
            // Click on empty space → deselect
            if (e.target === e.target.getStage()) onSelect(null);
          }}
        >
          {(page.children ?? []).map((c: any, i: number) => (
            <NodeShape key={i} node={c} selectedGuid={selectedGuid} onSelect={onSelect} />
          ))}
        </Layer>
      </Stage>
    </div>
  );
}
