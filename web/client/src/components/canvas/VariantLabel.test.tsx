// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

// react-konva can't render in jsdom (no Stage). Stub each primitive to a
// data-attr-bearing div so we can assert layout numbers directly.
vi.mock('react-konva', () => ({
  Group: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <div data-konva="group" data-x={rest.x as number} data-y={rest.y as number}>
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
      data-fill={props.fill as string}
      data-corner-radius={props.cornerRadius as number}
    />
  ),
  Text: (props: Record<string, unknown>) => (
    <div
      data-konva="text"
      data-text={props.text as string}
      data-font-size={props.fontSize as number}
      data-fill={props.fill as string}
      data-x={props.x as number}
      data-y={props.y as number}
    />
  ),
}));

import { VariantLabel } from './VariantLabel';

describe('VariantLabel', () => {
  it('renders a rounded gray pill with the label text', () => {
    render(<VariantLabel x={20} y={-22} text="기본" />);

    const group = document.querySelector('[data-konva="group"]') as HTMLElement;
    expect(group.dataset.x).toBe('20');
    expect(group.dataset.y).toBe('-22');

    const rect = document.querySelector('[data-konva="rect"]') as HTMLElement;
    expect(rect.dataset.fill).toBe('#E5E5E5');
    expect(rect.dataset.cornerRadius).toBe('4');
    expect(rect.dataset.h).toBe('18');
    // CJK: "기본" = 2 chars * 1.5 * 6.2 ≈ 18.6, + 2*8 padding = 34.6
    const w = Number(rect.dataset.w);
    expect(w).toBeGreaterThan(30);
    expect(w).toBeLessThan(40);

    const text = document.querySelector('[data-konva="text"]') as HTMLElement;
    expect(text.dataset.text).toBe('기본');
    expect(text.dataset.fontSize).toBe('11');
    expect(text.dataset.fill).toBe('#1f1f1f');
  });

  it('sizes the pill wider for longer text', () => {
    const { rerender } = render(<VariantLabel x={0} y={0} text="L" />);
    const wShort = Number((document.querySelector('[data-konva="rect"]') as HTMLElement).dataset.w);

    rerender(<VariantLabel x={0} y={0} text="L, hover, primary" />);
    const wLong = Number((document.querySelector('[data-konva="rect"]') as HTMLElement).dataset.w);

    expect(wLong).toBeGreaterThan(wShort);
  });
});
