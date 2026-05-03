/**
 * Figma-style variant property label, drawn above each variant child of a
 * Component Set / state group container.
 *
 * Spec: docs/specs/web-render-fidelity-round10.spec.md §4
 *
 * Pure visual overlay — no event handling. Inherits clip / rotation /
 * opacity from the variant container Group.
 */
import { Group, Rect, Text as KText } from 'react-konva';
import { variantLabelTextWidth } from '../../lib/variantLabel';

interface VariantLabelProps {
  x: number;
  y: number;
  text: string;
}

const HEIGHT = 18;
const PAD_X = 8;
const PAD_Y = 3;
const FONT_SIZE = 11;

export function VariantLabel({ x, y, text }: VariantLabelProps) {
  const textW = variantLabelTextWidth(text);
  const w = textW + PAD_X * 2;
  return (
    <Group x={x} y={y} listening={false}>
      <Rect
        x={0}
        y={0}
        width={w}
        height={HEIGHT}
        cornerRadius={4}
        fill="#E5E5E5"
        listening={false}
      />
      <KText
        x={PAD_X}
        y={PAD_Y}
        text={text}
        fontSize={FONT_SIZE}
        fontFamily="Inter, sans-serif"
        fill="#1f1f1f"
        listening={false}
      />
    </Group>
  );
}
