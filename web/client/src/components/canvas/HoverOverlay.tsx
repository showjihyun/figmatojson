/**
 * Konva-rendered hover indicator: a 1px blue stroke around the hovered
 * node's bbox + a name pill at top-left. Drawn into the same selection-
 * overlay Layer so it gets the Stage's pan/zoom transform automatically.
 *
 * Spec: docs/specs/web-canvas-hover-tooltip.spec.md (v2)
 *
 * Renders nothing when the hovered node is also currently selected —
 * the selection overlay already covers that bbox; doubling up looks
 * messy. Listening is disabled so this overlay never intercepts mouse
 * events meant for NodeShape.
 */
import { Group, Rect, Text as KText } from 'react-konva';

const ACCENT = '#0a84ff';        // Figma's hover/selection blue
const LABEL_FG = '#ffffff';

interface DesignBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface HoverOverlayProps {
  /** stage-local design coords (NOT viewport pixels). */
  bbox: DesignBbox;
  name: string;
  /** Stage scale — keeps stroke / pill at constant pixel size on screen. */
  scale: number;
}

export function HoverOverlay({ bbox, name, scale }: HoverOverlayProps) {
  // All overlay decoration is divided by scale so it stays 1px / 11px
  // regardless of zoom — same pattern as SelectionOverlay.
  const STROKE = 1 / scale;
  const PILL_FONT = 11 / scale;
  const PILL_PAD_X = 6 / scale;
  const PILL_PAD_Y = 2 / scale;
  const PILL_GAP = 2 / scale;

  const display = name && name.length > 0 ? name : '<unnamed>';
  // Char-width heuristic — same one SelectionOverlay uses for the W×H badge.
  // Slight overshoot is fine; the pill just gets a touch wider than ideal.
  const labelW = display.length * PILL_FONT * 0.6 + PILL_PAD_X * 2;
  const labelH = PILL_FONT + PILL_PAD_Y * 2;

  // Place the pill above the bbox by default; if that pushes it above
  // y=0 of the design space (i.e. the node is at the canvas top), drop
  // it INSIDE the bbox just below the top edge.
  const placeAbove = bbox.y - labelH - PILL_GAP >= 0;
  const pillY = placeAbove ? bbox.y - labelH - PILL_GAP : bbox.y;

  return (
    <Group listening={false}>
      {/* Border around the bbox. */}
      <Rect
        x={bbox.x}
        y={bbox.y}
        width={bbox.width}
        height={bbox.height}
        stroke={ACCENT}
        strokeWidth={STROKE}
        listening={false}
      />
      {/* Name pill. */}
      <Group x={bbox.x} y={pillY} listening={false}>
        <Rect
          x={0}
          y={0}
          width={labelW}
          height={labelH}
          fill={ACCENT}
          cornerRadius={2 / scale}
          listening={false}
        />
        <KText
          x={PILL_PAD_X}
          y={PILL_PAD_Y}
          text={display}
          fontSize={PILL_FONT}
          fontFamily="Inter, system-ui, sans-serif"
          fill={LABEL_FG}
          listening={false}
        />
      </Group>
    </Group>
  );
}
