/**
 * effectiveVisibility.ts — Property Visibility Toggle composition,
 * shared between CLI and web pipelines.
 *
 * Spec: docs/specs/expansion-context.spec.md §3.3
 */
import { describe, expect, it } from 'vitest';
import { isHiddenByPropBinding } from '../src/effectiveVisibility.js';

describe('isHiddenByPropBinding', () => {
  it('returns false when propAssignments map is empty', () => {
    expect(isHiddenByPropBinding({}, new Map())).toBe(false);
    expect(
      isHiddenByPropBinding(
        { componentPropRefs: [{ defID: { sessionID: 0, localID: 1 }, componentPropNodeField: 'VISIBLE' }] },
        new Map(),
      ),
    ).toBe(false);
  });

  it('returns false when the node has no componentPropRefs', () => {
    const m = new Map<string, boolean>([['0:1', false]]);
    expect(isHiddenByPropBinding({}, m)).toBe(false);
    expect(isHiddenByPropBinding({ componentPropRefs: null }, m)).toBe(false);
    expect(isHiddenByPropBinding({ componentPropRefs: [] }, m)).toBe(false);
  });

  it('returns true when a VISIBLE ref resolves to false', () => {
    const m = new Map<string, boolean>([['7:34', false]]);
    expect(
      isHiddenByPropBinding(
        {
          componentPropRefs: [
            { defID: { sessionID: 7, localID: 34 }, componentPropNodeField: 'VISIBLE' },
          ],
        },
        m,
      ),
    ).toBe(true);
  });

  it('returns false when the resolved value is true (explicit visible)', () => {
    const m = new Map<string, boolean>([['7:34', true]]);
    expect(
      isHiddenByPropBinding(
        {
          componentPropRefs: [
            { defID: { sessionID: 7, localID: 34 }, componentPropNodeField: 'VISIBLE' },
          ],
        },
        m,
      ),
    ).toBe(false);
  });

  it('ignores refs whose componentPropNodeField is not VISIBLE (TEXT, INSTANCE_SWAP, ...)', () => {
    const m = new Map<string, boolean>([['7:34', false]]);
    expect(
      isHiddenByPropBinding(
        {
          componentPropRefs: [
            { defID: { sessionID: 7, localID: 34 }, componentPropNodeField: 'TEXT' },
            { defID: { sessionID: 7, localID: 34 }, componentPropNodeField: 'INSTANCE_SWAP' },
          ],
        },
        m,
      ),
    ).toBe(false);
  });

  it('returns true if ANY VISIBLE ref hides (multiple refs, OR semantics)', () => {
    const m = new Map<string, boolean>([['1:1', true], ['1:2', false]]);
    expect(
      isHiddenByPropBinding(
        {
          componentPropRefs: [
            { defID: { sessionID: 1, localID: 1 }, componentPropNodeField: 'VISIBLE' },
            { defID: { sessionID: 1, localID: 2 }, componentPropNodeField: 'VISIBLE' },
          ],
        },
        m,
      ),
    ).toBe(true);
  });

  it('skips entries with corrupt defID (missing sessionID/localID)', () => {
    const m = new Map<string, boolean>([['7:34', false]]);
    expect(
      isHiddenByPropBinding(
        {
          componentPropRefs: [
            { defID: {}, componentPropNodeField: 'VISIBLE' },
            { defID: { sessionID: 7 }, componentPropNodeField: 'VISIBLE' },
          ],
        },
        m,
      ),
    ).toBe(false);
  });
});
