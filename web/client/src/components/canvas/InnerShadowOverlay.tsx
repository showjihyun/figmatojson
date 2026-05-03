/**
 * Konva-rendered INNER_SHADOW emulation.
 *
 * Spec: docs/specs/web-render-fidelity-round6.spec.md §3
 *
 * Konva.Shape doesn't natively support inner shadow, so we draw a
 * custom shape via sceneFunc that:
 *
 *   1. Clips to the node's rounded-rect bounds.
 *   2. Fills an outer-rect-minus-inner-rect region (even-odd rule)
 *      with shadow* params set. The fill is invisible (clipped away)
 *      but the shadow casts inward, into the visible interior.
 *
 * Result: the inner edge of the rect appears to have a soft drop
 * shadow falling INWARD — exactly Figma's INNER_SHADOW look.
 */
import { Shape } from 'react-konva';

interface CornerRadii {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

export interface InnerShadowProps {
  width: number;
  height: number;
  corners: CornerRadii;
  /** Shadow geometry & color (already validated as DROP-IN-style by the caller). */
  offsetX: number;
  offsetY: number;
  blur: number;
  /** rgba string. */
  color: string;
}

/**
 * Draw a clockwise rounded-rect path on `ctx`. Coordinates are
 * pre-clamped by the caller so we don't repeat the half-w/h logic.
 */
function pathRoundedRect(
  ctx: { moveTo: (x: number, y: number) => void; lineTo: (x: number, y: number) => void; quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => void; closePath: () => void },
  w: number,
  h: number,
  c: CornerRadii,
): void {
  ctx.moveTo(c.tl, 0);
  ctx.lineTo(w - c.tr, 0);
  ctx.quadraticCurveTo(w, 0, w, c.tr);
  ctx.lineTo(w, h - c.br);
  ctx.quadraticCurveTo(w, h, w - c.br, h);
  ctx.lineTo(c.bl, h);
  ctx.quadraticCurveTo(0, h, 0, h - c.bl);
  ctx.lineTo(0, c.tl);
  ctx.quadraticCurveTo(0, 0, c.tl, 0);
  ctx.closePath();
}

/** Counter-clockwise version — used to make a HOLE in an outer fill region. */
function pathRoundedRectReverse(
  ctx: { moveTo: (x: number, y: number) => void; lineTo: (x: number, y: number) => void; quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => void; closePath: () => void },
  w: number,
  h: number,
  c: CornerRadii,
): void {
  ctx.moveTo(c.tl, 0);
  ctx.quadraticCurveTo(0, 0, 0, c.tl);
  ctx.lineTo(0, h - c.bl);
  ctx.quadraticCurveTo(0, h, c.bl, h);
  ctx.lineTo(w - c.br, h);
  ctx.quadraticCurveTo(w, h, w, h - c.br);
  ctx.lineTo(w, c.tr);
  ctx.quadraticCurveTo(w, 0, w - c.tr, 0);
  ctx.closePath();
}

export function InnerShadowOverlay({
  width,
  height,
  corners,
  offsetX,
  offsetY,
  blur,
  color,
}: InnerShadowProps) {
  return (
    <Shape
      listening={false}
      sceneFunc={(ctx) => {
        // Clip to the node's rect so all our painting is contained
        // inside. ctx is Konva's SceneContext — supports save/restore.
        ctx.save();
        ctx.beginPath();
        pathRoundedRect(ctx, width, height, corners);
        ctx.clip();

        // Outer rect padded enough that the shadow blur radius doesn't
        // bleed in from the donut's outer edge. blur*3 + max offset is
        // a safe envelope.
        const PAD = Math.max(blur * 3 + Math.max(Math.abs(offsetX), Math.abs(offsetY)), 100);
        ctx.beginPath();
        // Outer (clockwise — fills the donut).
        ctx.rect(-PAD, -PAD, width + 2 * PAD, height + 2 * PAD);
        // Inner hole (counter-clockwise — even-odd fill rule cuts it
        // out of the outer rect, leaving only the donut filled).
        pathRoundedRectReverse(ctx, width, height, corners);

        // Shadow params on the underlying canvas context. Konva's
        // SceneContext proxies them through to the 2D canvas. We
        // disable Konva's own internal shadow handling by using the
        // raw canvas API on ctx._context — but ctx itself accepts
        // shadowOffsetX / shadowBlur etc. as well.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = ctx as any;
        c.shadowOffsetX = offsetX;
        c.shadowOffsetY = offsetY;
        c.shadowBlur = blur;
        c.shadowColor = color;

        c.fillStyle = 'rgb(0,0,0)';
        c.fill('evenodd');

        ctx.restore();
      }}
    />
  );
}
