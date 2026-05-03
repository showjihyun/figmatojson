import { describe, expect, it } from 'vitest';
import { splitTextRuns, hasStyledRuns } from './textStyleRuns';

describe('splitTextRuns', () => {
  it('returns an empty array for empty characters', () => {
    expect(splitTextRuns('', [], [])).toEqual([]);
    expect(splitTextRuns('', undefined, undefined)).toEqual([]);
  });

  it('falls back to a single base-style run when characterStyleIDs is missing', () => {
    const runs = splitTextRuns('hello', undefined, undefined);
    expect(runs).toEqual([
      { text: 'hello', startIndex: 0, styleID: 0, override: {} },
    ]);
  });

  it('falls back to a single base-style run when characterStyleIDs length mismatches characters length', () => {
    // Real-world corruption guard — Figma docs say lengths must match,
    // but we must not crash if they don't.
    const runs = splitTextRuns('hello', [0, 0], undefined);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe('hello');
    expect(runs[0].styleID).toBe(0);
  });

  it('returns a single styleID-0 run when all characters share the base style', () => {
    const runs = splitTextRuns('hello', [0, 0, 0, 0, 0], []);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ text: 'hello', startIndex: 0, styleID: 0, override: {} });
  });

  it('splits the metarich state-text fixture into 4 runs (gray / red / gray / green)', () => {
    // From extracted/메타리치 화면 UI Design/04_decoded/message.json (TEXT 11:457)
    const characters = '설명문구, 오류문구, 성공문구';
    const characterStyleIDs = [0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 0, 0, 2, 2, 2, 2];
    const styleOverrideTable = [
      { styleID: 2, fillPaints: [{ type: 'SOLID', color: { r: 0.007, g: 0.58, b: 0.42, a: 1 } }] },
      { styleID: 3, fillPaints: [{ type: 'SOLID', color: { r: 0.86, g: 0.07, b: 0.07, a: 1 } }] },
    ];

    const runs = splitTextRuns(characters, characterStyleIDs, styleOverrideTable);
    expect(runs).toHaveLength(4);

    expect(runs[0].text).toBe('설명문구, ');
    expect(runs[0].startIndex).toBe(0);
    expect(runs[0].styleID).toBe(0);
    expect(runs[0].override.fillPaints).toBeUndefined();

    expect(runs[1].text).toBe('오류문구');
    expect(runs[1].startIndex).toBe(6);
    expect(runs[1].styleID).toBe(3);
    expect(runs[1].override.fillPaints).toBeDefined();
    expect((runs[1].override.fillPaints as Array<{ color: { r: number } }>)[0].color.r).toBeCloseTo(0.86);

    expect(runs[2].text).toBe(', ');
    expect(runs[2].startIndex).toBe(10);
    expect(runs[2].styleID).toBe(0);
    expect(runs[2].override.fillPaints).toBeUndefined();

    expect(runs[3].text).toBe('성공문구');
    expect(runs[3].startIndex).toBe(12);
    expect(runs[3].styleID).toBe(2);
    expect((runs[3].override.fillPaints as Array<{ color: { g: number } }>)[0].color.g).toBeCloseTo(0.58);
  });

  it('handles styleOverrideTable with duplicate styleIDs — last wins', () => {
    const runs = splitTextRuns('ab', [1, 1], [
      { styleID: 1, fillPaints: [{ color: { r: 1, g: 0, b: 0 } }] },
      { styleID: 1, fillPaints: [{ color: { r: 0, g: 1, b: 0 } }] },
    ]);
    expect(runs).toHaveLength(1);
    expect((runs[0].override.fillPaints as Array<{ color: { g: number } }>)[0].color.g).toBe(1);
  });

  it('returns an empty override (not undefined) when characterStyleIDs references a styleID with no entry', () => {
    // styleID 99 isn't in the table — caller should still see the run
    // with an empty override, then fall back to base style. Don't crash.
    const runs = splitTextRuns('ab', [99, 99], [
      { styleID: 2, fillPaints: [{ color: { r: 0, g: 1, b: 0 } }] },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].styleID).toBe(99);
    expect(runs[0].override).toEqual({});
  });

  it('skips malformed styleOverrideTable entries (no styleID field)', () => {
    const runs = splitTextRuns('ab', [1, 1], [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { fillPaints: [{ color: { r: 1, g: 0, b: 0 } }] } as any,
      { styleID: 1, fillPaints: [{ color: { r: 0, g: 1, b: 0 } }] },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].styleID).toBe(1);
    expect((runs[0].override.fillPaints as Array<{ color: { g: number } }>)[0].color.g).toBe(1);
  });

  it('records fontWeight / fontName / fontSize on the override (read-through; renderer may ignore)', () => {
    // v1 spec only renders per-run fillPaints, but the helper records the
    // other fields so a later round can wire them up without a signature change.
    const runs = splitTextRuns('ab', [1, 1], [
      { styleID: 1, fontWeight: 700, fontName: { family: 'Inter', style: 'Bold' }, fontSize: 18 },
    ]);
    expect(runs[0].override.fontWeight).toBe(700);
    expect(runs[0].override.fontName?.family).toBe('Inter');
    expect(runs[0].override.fontSize).toBe(18);
  });

  it('handles a single-character switch at the end correctly', () => {
    // Off-by-one regression guard — the boundary at i === characters.length
    // must close the final run, even if it's only one character.
    const runs = splitTextRuns('abcd', [0, 0, 0, 1], [
      { styleID: 1, fillPaints: [{ color: { r: 1, g: 0, b: 0 } }] },
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[0].text).toBe('abc');
    expect(runs[1].text).toBe('d');
    expect(runs[1].styleID).toBe(1);
  });
});

describe('hasStyledRuns', () => {
  it('false for empty runs', () => {
    expect(hasStyledRuns([])).toBe(false);
  });

  it('false for a single base-style run', () => {
    expect(hasStyledRuns([{ text: 'x', startIndex: 0, styleID: 0, override: {} }])).toBe(false);
  });

  it('true when at least one run has a non-zero styleID', () => {
    expect(
      hasStyledRuns([
        { text: 'a', startIndex: 0, styleID: 0, override: {} },
        { text: 'b', startIndex: 1, styleID: 3, override: {} },
      ]),
    ).toBe(true);
  });

  it('false when all runs are styleID 0 (defensive — splitTextRuns collapses these into one already)', () => {
    expect(
      hasStyledRuns([
        { text: 'a', startIndex: 0, styleID: 0, override: {} },
        { text: 'b', startIndex: 1, styleID: 0, override: {} },
      ]),
    ).toBe(false);
  });
});
