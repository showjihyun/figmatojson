// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

// react-konva components don't render in jsdom (they need a real Stage
// context with a 2D canvas). Mock them to plain DOM elements that carry
// every prop on data-* so assertions stay simple.
vi.mock('react-konva', () => ({
  Group: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <div
      data-konva="group"
      data-listening={String(rest.listening)}
      data-x={rest.x as number}
      data-y={rest.y as number}
      data-rotation={rest.rotation as number | undefined}
    >
      {children}
    </div>
  ),
  Rect: (props: Record<string, unknown>) => (
    <div
      data-konva="rect"
      data-x={props.x as number}
      data-y={props.y as number}
      data-w={props.width as number}
      data-h={props.height as number}
      data-stroke={props.stroke as string | undefined}
      data-stroke-width={props.strokeWidth as number}
      data-fill={props.fill as string | undefined}
      data-corner-radius={props.cornerRadius as number}
    />
  ),
  Text: (props: Record<string, unknown>) => (
    <div
      data-konva="text"
      data-text={props.text as string}
      data-font-size={props.fontSize as number}
      data-fill={props.fill as string | undefined}
    />
  ),
}));

import { HoverOverlay } from './HoverOverlay';

const BBOX = { x: 100, y: 200, width: 240, height: 56 };

describe('<HoverOverlay>', () => {
  it('renders a stroke-only Rect (local coords) inside an outer Group at the bbox', () => {
    const { container } = render(<HoverOverlay bbox={BBOX} name="Header" scale={1} />);
    const groups = container.querySelectorAll('[data-konva="group"]');
    // Outer Group sits at the bbox origin (rotation pivot — round 7 §2).
    const outer = groups[0]!;
    expect(Number(outer.getAttribute('data-x'))).toBe(100);
    expect(Number(outer.getAttribute('data-y'))).toBe(200);
    // Border rect inside the rotated outer Group draws in local
    // coords (0..w × 0..h).
    const rects = container.querySelectorAll('[data-konva="rect"]');
    expect(rects.length).toBe(2); // border + pill bg
    const border = rects[0]!;
    expect(Number(border.getAttribute('data-x'))).toBe(0);
    expect(Number(border.getAttribute('data-y'))).toBe(0);
    expect(Number(border.getAttribute('data-w'))).toBe(240);
    expect(Number(border.getAttribute('data-h'))).toBe(56);
    expect(border.getAttribute('data-stroke')).toBe('#0a84ff');
    expect(Number(border.getAttribute('data-stroke-width'))).toBe(1);
    const fill = border.getAttribute('data-fill');
    expect(fill === '' || fill === null).toBe(true);

    // Pill background is filled with the accent color.
    const pillBg = rects[1]!;
    expect(pillBg.getAttribute('data-fill')).toBe('#0a84ff');

    // Pill text is the node name in white.
    const text = container.querySelector('[data-konva="text"]')!;
    expect(text.getAttribute('data-text')).toBe('Header');
    expect(text.getAttribute('data-fill')).toBe('#ffffff');
  });

  it('applies rotation to the outer Group when provided (round 7 §2)', () => {
    const { container } = render(<HoverOverlay bbox={BBOX} rotation={45} name="x" scale={1} />);
    const outer = container.querySelector('[data-konva="group"]')!;
    expect(Number(outer.getAttribute('data-rotation'))).toBe(45);
  });

  it('outer rotation defaults to 0 when prop is omitted', () => {
    const { container } = render(<HoverOverlay bbox={BBOX} name="x" scale={1} />);
    const outer = container.querySelector('[data-konva="group"]')!;
    expect(Number(outer.getAttribute('data-rotation'))).toBe(0);
  });

  it('uses "<unnamed>" when name is empty', () => {
    const { container } = render(<HoverOverlay bbox={BBOX} name="" scale={1} />);
    const text = container.querySelector('[data-konva="text"]')!;
    expect(text.getAttribute('data-text')).toBe('<unnamed>');
  });

  it('scales stroke width and font size with 1/scale (pixel-locked at any zoom)', () => {
    const { container } = render(<HoverOverlay bbox={BBOX} name="x" scale={2} />);
    const rects = container.querySelectorAll('[data-konva="rect"]');
    // Border stroke at scale 2 → 0.5 design-units = 1 screen-px.
    expect(Number(rects[0]!.getAttribute('data-stroke-width'))).toBe(0.5);
    const text = container.querySelector('[data-konva="text"]')!;
    // Font size at scale 2 → 5.5 design-units = 11 screen-px.
    expect(Number(text.getAttribute('data-font-size'))).toBe(5.5);
  });

  it('places the pill ABOVE the bbox when there is room (negative local y)', () => {
    const { container } = render(<HoverOverlay bbox={BBOX} name="abc" scale={1} />);
    // Two Group elements: outer rotation wrapper, then inner pill
    // positioner. After round 7, the inner pill uses LOCAL coords
    // (relative to the outer Group), so "above" = negative y.
    const groups = container.querySelectorAll('[data-konva="group"]');
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const pillGroup = groups[1]!;
    expect(Number(pillGroup.getAttribute('data-y'))).toBeLessThan(0);
  });

  it('drops the pill INSIDE when the bbox is at the canvas top edge (local y = 0)', () => {
    const top = { x: 0, y: 0, width: 100, height: 50 };
    const { container } = render(<HoverOverlay bbox={top} name="x" scale={1} />);
    const groups = container.querySelectorAll('[data-konva="group"]');
    const pillGroup = groups[1]!;
    expect(Number(pillGroup.getAttribute('data-y'))).toBe(0);
  });

  it('overlay group is non-listening so it does not block NodeShape mouse events', () => {
    const { container } = render(<HoverOverlay bbox={BBOX} name="x" scale={1} />);
    const root = container.querySelector('[data-konva="group"]')!;
    expect(root.getAttribute('data-listening')).toBe('false');
  });
});
