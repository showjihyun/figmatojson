// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { HoverTooltip, type HoverBbox, type HoverInfo } from './HoverTooltip';

const FAR_FROM_TOP: HoverBbox = { left: 100, top: 200, right: 260, bottom: 248 };
const NEAR_TOP: HoverBbox = { left: 10, top: 6, right: 110, bottom: 30 };

describe('<HoverTooltip>', () => {
  it('renders the node name + type + dimensions on two lines', () => {
    const info: HoverInfo = { name: 'sidemenu', type: 'FRAME', w: 240, h: 720 };
    render(<HoverTooltip info={info} bbox={FAR_FROM_TOP} />);
    const tip = screen.getByTestId('hover-tooltip');
    expect(tip.textContent).toContain('sidemenu');
    expect(tip.textContent).toContain('FRAME');
    expect(tip.textContent).toContain('240 × 720');
  });

  it('omits dimensions when w/h are absent', () => {
    const info: HoverInfo = { name: 'page-canvas', type: 'CANVAS' };
    render(<HoverTooltip info={info} bbox={FAR_FROM_TOP} />);
    expect(screen.getByTestId('hover-tooltip').textContent).toBe('page-canvasCANVAS');
  });

  it('shows "→ <master>" tail when masterName is provided', () => {
    const info: HoverInfo = { name: 'check', type: 'INSTANCE', w: 16, h: 16, masterName: 'u:check' };
    render(<HoverTooltip info={info} bbox={FAR_FROM_TOP} />);
    expect(screen.getByTestId('hover-tooltip').textContent).toContain('→ u:check');
  });

  it('shows "N variants" segment for COMPONENT_SET (spec I-T5)', () => {
    const info: HoverInfo = {
      name: 'Input Box',
      type: 'COMPONENT_SET',
      w: 240,
      h: 48,
      variantCount: 6,
    };
    render(<HoverTooltip info={info} bbox={FAR_FROM_TOP} />);
    const text = screen.getByTestId('hover-tooltip').textContent ?? '';
    expect(text).toContain('Input Box');
    expect(text).toContain('COMPONENT_SET');
    expect(text).toContain('6 variants');
    expect(text).toContain('240 × 48');
  });

  it('singular "1 variant" wording when count === 1', () => {
    render(
      <HoverTooltip
        info={{ name: 'one', type: 'COMPONENT_SET', variantCount: 1 }}
        bbox={FAR_FROM_TOP}
      />,
    );
    expect(screen.getByTestId('hover-tooltip').textContent).toContain('1 variant');
    expect(screen.getByTestId('hover-tooltip').textContent).not.toContain('1 variants');
  });

  it('omits the variants segment when variantCount is 0 or absent', () => {
    render(
      <HoverTooltip
        info={{ name: 'empty', type: 'COMPONENT_SET', variantCount: 0 }}
        bbox={FAR_FROM_TOP}
      />,
    );
    expect(screen.getByTestId('hover-tooltip').textContent).not.toContain('variant');
  });

  it('shows "unnamed" placeholder when name is empty', () => {
    const info: HoverInfo = { name: '', type: 'TEXT', w: 50, h: 16 };
    render(<HoverTooltip info={info} bbox={FAR_FROM_TOP} />);
    expect(screen.getByText('unnamed')).toBeTruthy();
  });

  it('positions ABOVE the node when there is enough headroom (spec I-P1)', () => {
    render(<HoverTooltip info={{ name: 'x', type: 'FRAME' }} bbox={FAR_FROM_TOP} />);
    const tip = screen.getByTestId('hover-tooltip') as HTMLElement;
    // Place above: top = bbox.top - GAP, transform: translateY(-100%)
    expect(tip.style.top).toBe('196px'); // 200 - 4
    expect(tip.style.transform).toBe('translateY(-100%)');
  });

  it('flips BELOW when the node is too close to the viewport top (spec I-P2)', () => {
    render(<HoverTooltip info={{ name: 'x', type: 'FRAME' }} bbox={NEAR_TOP} />);
    const tip = screen.getByTestId('hover-tooltip') as HTMLElement;
    // Place below: top = bbox.bottom + GAP, no negative translate.
    expect(tip.style.top).toBe('34px'); // 30 + 4
    expect(tip.style.transform).toBe('');
  });

  it('clamps left to >= 0 so the tooltip never spills off the left edge', () => {
    const off: HoverBbox = { left: -50, top: 200, right: 50, bottom: 248 };
    render(<HoverTooltip info={{ name: 'x', type: 'FRAME' }} bbox={off} />);
    const tip = screen.getByTestId('hover-tooltip') as HTMLElement;
    expect(tip.style.left).toBe('0px');
  });

  it('uses position:fixed and pointer-events:none (spec I-R1, I-R3)', () => {
    render(<HoverTooltip info={{ name: 'x', type: 'FRAME' }} bbox={FAR_FROM_TOP} />);
    const tip = screen.getByTestId('hover-tooltip') as HTMLElement;
    expect(tip.style.position).toBe('fixed');
    expect(tip.style.pointerEvents).toBe('none');
  });
});
