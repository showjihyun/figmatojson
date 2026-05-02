/**
 * Floating tooltip displayed next to the currently-hovered canvas node.
 *
 * Spec: docs/specs/web-canvas-hover-tooltip.spec.md
 *
 * Pure presentational — Canvas owns the hover state and the geometry math.
 * This component just decides "above or below" based on available headroom
 * and renders the two-line content.
 *
 * Lives outside Konva (regular DOM) — `pointer-events: none` so it never
 * intercepts canvas clicks.
 */
import { cn } from '@/lib/utils';

export interface HoverInfo {
  name?: string;
  type?: string;
  w?: number;
  h?: number;
  /** Optional: name of the master component for an INSTANCE. */
  masterName?: string;
  /**
   * COMPONENT_SET only — number of direct COMPONENT children. Drives the
   * "N variants" segment on the second line. See spec §2 I-T5.
   */
  variantCount?: number;
}

export interface HoverBbox {
  /** All four edges in browser-viewport pixels (i.e., `position: fixed`). */
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface HoverTooltipProps {
  info: HoverInfo;
  bbox: HoverBbox;
}

const TOOLTIP_GAP = 4;
const APPROX_TOOLTIP_HEIGHT = 36; // 2 lines + padding — used only for above/below decision.

export function HoverTooltip({ info, bbox }: HoverTooltipProps) {
  // Above the node by default; flip below if headroom < tooltip height.
  // Spec I-P2.
  const placeAbove = bbox.top >= APPROX_TOOLTIP_HEIGHT + TOOLTIP_GAP;

  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.max(0, bbox.left),
    top: placeAbove ? bbox.top - TOOLTIP_GAP : bbox.bottom + TOOLTIP_GAP,
    transform: placeAbove ? 'translateY(-100%)' : undefined,
    pointerEvents: 'none', // I-R3
    zIndex: 50,
  };

  const hasName = typeof info.name === 'string' && info.name.length > 0;
  const hasSize = typeof info.w === 'number' && typeof info.h === 'number';

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="hover-tooltip"
      style={style}
      className={cn(
        'rounded border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md',
        'max-w-xs whitespace-nowrap',
      )}
    >
      <div className="font-medium">
        {hasName ? info.name : <span className="italic text-muted-foreground">unnamed</span>}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {info.type ?? 'NODE'}
        {typeof info.variantCount === 'number' && info.variantCount > 0 && (
          ` · ${info.variantCount} variant${info.variantCount === 1 ? '' : 's'}`
        )}
        {hasSize && ` · ${info.w} × ${info.h}`}
        {info.masterName && ` · → ${info.masterName}`}
      </div>
    </div>
  );
}
