// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import * as React from 'react';

// Module-level recorder for the GroupStub calls — Konva ops the wrapper
// performs through `ref.current` end up here.
const calls: { cache: number; filters: unknown[]; blurRadius: number[] } = {
  cache: 0,
  filters: [],
  blurRadius: [],
};

class GroupStub {
  cache(): void { calls.cache += 1; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filters(f: any): void { calls.filters.push(f); }
  blurRadius(r: number): void { calls.blurRadius.push(r); }
}

// `konva` resolves to its node entry which requires the optional `canvas`
// native package — not installed in this repo. Stub the parts the
// wrapper actually touches (just `Konva.Filters.Blur` as a sentinel).
const { BLUR_SENTINEL } = vi.hoisted(() => ({
  BLUR_SENTINEL: Symbol('Konva.Filters.Blur'),
}));
vi.mock('konva', () => ({
  default: { Filters: { Blur: BLUR_SENTINEL } },
}));

// react-konva's <Group ref={...}> would assign a Konva.Group instance.
// jsdom can't construct one, so the mocked Group forwards the caller's
// ref to a GroupStub via useImperativeHandle.
vi.mock('react-konva', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactMod: typeof import('react') = require('react');
  const Group = ReactMod.forwardRef<GroupStub, { children?: React.ReactNode }>(
    function MockGroup({ children }, ref) {
      ReactMod.useImperativeHandle(ref, () => new GroupStub(), []);
      return <div data-konva="group">{children}</div>;
    },
  );
  return { Group };
});

import { LayerBlurWrapper } from './LayerBlurWrapper';

describe('LayerBlurWrapper', () => {
  it('caches the group, installs Filters.Blur, and applies the radius', () => {
    calls.cache = 0;
    calls.filters = [];
    calls.blurRadius = [];

    render(<LayerBlurWrapper radius={4}><span /></LayerBlurWrapper>);

    expect(calls.cache).toBe(1);
    expect(calls.filters).toHaveLength(1);
    expect(Array.isArray(calls.filters[0])).toBe(true);
    expect((calls.filters[0] as unknown[])[0]).toBe(BLUR_SENTINEL);
    expect(calls.blurRadius).toEqual([4]);
  });

  it('re-caches when radius changes', () => {
    calls.cache = 0;
    calls.filters = [];
    calls.blurRadius = [];

    const { rerender } = render(
      <LayerBlurWrapper radius={2}><span /></LayerBlurWrapper>,
    );
    expect(calls.cache).toBe(1);
    expect(calls.blurRadius).toEqual([2]);

    rerender(<LayerBlurWrapper radius={9}><span /></LayerBlurWrapper>);
    expect(calls.cache).toBe(2);
    expect(calls.blurRadius).toEqual([2, 9]);
  });
});
