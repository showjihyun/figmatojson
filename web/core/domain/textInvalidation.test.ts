import { describe, expect, it } from 'vitest';
import {
  invalidateTextLayoutCache,
  pruneInstanceDerivedTextData,
} from './textInvalidation';

describe('invalidateTextLayoutCache', () => {
  it('clears every cached layout field on textData', () => {
    const node: Record<string, unknown> = {
      textData: {
        characters: 'old text',
        characterStyleIDs: [0, 0, 0, 0, 0, 0, 0, 0],
        styleOverrideTable: [{ guid: { sessionID: 0, localID: 1 } }], // preserved
        derivedLines: [{ directionality: 'LTR' }],
        glyphs: [{ commandsBlob: 5, fontSize: 14 }],
        baselines: [{ position: { x: 0, y: 12 } }],
        fontMetaData: [{ key: { family: 'Pretendard' } }],
        layoutSize: { x: 60, y: 18 },
        minContentHeight: 18,
        truncatedHeight: 0,
        truncationStartIndex: -1,
        logicalIndexToCharacterOffsetMap: [0, 1, 2, 3, 4, 5, 6, 7],
        decorations: [],
        blockquotes: [],
        hyperlinkBoxes: [],
        mentionBoxes: [],
        fallbackFonts: [],
      },
      derivedTextData: { layoutSize: { x: 60, y: 18 } },
    };

    invalidateTextLayoutCache(node, '테스트야');

    const td = node.textData as Record<string, unknown>;
    // Cleared
    expect(td.derivedLines).toBeUndefined();
    expect(td.glyphs).toBeUndefined();
    expect(td.baselines).toBeUndefined();
    expect(td.fontMetaData).toBeUndefined();
    expect(td.layoutSize).toBeUndefined();
    expect(td.minContentHeight).toBeUndefined();
    expect(td.truncatedHeight).toBeUndefined();
    expect(td.truncationStartIndex).toBeUndefined();
    expect(td.logicalIndexToCharacterOffsetMap).toBeUndefined();
    expect(td.decorations).toBeUndefined();
    expect(td.blockquotes).toBeUndefined();
    expect(td.hyperlinkBoxes).toBeUndefined();
    expect(td.mentionBoxes).toBeUndefined();
    expect(td.fallbackFonts).toBeUndefined();
    // Direct field on the node also cleared
    expect(node.derivedTextData).toBeUndefined();
    // Preserved (not cache)
    expect(td.characters).toBe('old text'); // caller has already set the new value before calling us
    expect(td.styleOverrideTable).toEqual([{ guid: { sessionID: 0, localID: 1 } }]);
  });

  it('truncates characterStyleIDs to match shorter new content', () => {
    const node = { textData: { characterStyleIDs: [0, 0, 1, 1, 1, 0, 0, 0] } };
    invalidateTextLayoutCache(node, '테스트야'); // 4 chars
    expect((node.textData as Record<string, unknown>).characterStyleIDs).toEqual([0, 0, 1, 1]);
  });

  it('pads characterStyleIDs with the tail style for longer new content', () => {
    const node = { textData: { characterStyleIDs: [0, 1] } };
    invalidateTextLayoutCache(node, '12345'); // 5 chars
    expect((node.textData as Record<string, unknown>).characterStyleIDs).toEqual([0, 1, 1, 1, 1]);
  });

  it('pads with 0 when the original characterStyleIDs was empty', () => {
    const node = { textData: { characterStyleIDs: [] } };
    invalidateTextLayoutCache(node, 'abc');
    expect((node.textData as Record<string, unknown>).characterStyleIDs).toEqual([0, 0, 0]);
  });

  it('leaves characterStyleIDs untouched when length already matches', () => {
    const csi = [0, 0, 1, 1];
    const node = { textData: { characterStyleIDs: csi } };
    invalidateTextLayoutCache(node, '테스트야');
    expect((node.textData as Record<string, unknown>).characterStyleIDs).toBe(csi); // same ref
  });

  it('is a no-op when the node has no textData', () => {
    const node: Record<string, unknown> = { type: 'FRAME' };
    expect(() => invalidateTextLayoutCache(node, 'whatever')).not.toThrow();
  });

  it('still clears node.derivedTextData even with no textData', () => {
    const node: Record<string, unknown> = { derivedTextData: { layoutSize: { x: 1, y: 1 } } };
    invalidateTextLayoutCache(node, 'x');
    expect(node.derivedTextData).toBeUndefined();
  });
});

describe('pruneInstanceDerivedTextData', () => {
  it('removes entries whose path terminates in the edited guid', () => {
    const msg = {
      nodeChanges: [
        {
          type: 'INSTANCE',
          guid: { sessionID: 800, localID: 1 },
          derivedSymbolData: [
            {
              guidPath: { guids: [{ sessionID: 700, localID: 313 }] },
              derivedTextData: { layoutSize: { x: 60, y: 18 } },
            },
            {
              guidPath: { guids: [{ sessionID: 700, localID: 999 }] },
              size: { x: 100, y: 50 },
            },
          ],
        },
      ],
    };
    pruneInstanceDerivedTextData(msg, '700:313');
    const ds = msg.nodeChanges[0].derivedSymbolData as Array<Record<string, unknown>>;
    expect(ds).toHaveLength(1);
    expect((ds[0] as { guidPath: { guids: Array<{ localID: number }> } }).guidPath.guids[0].localID).toBe(999);
  });

  it('handles nested INSTANCE paths — terminal segment match drives removal', () => {
    const msg = {
      nodeChanges: [
        {
          type: 'INSTANCE',
          guid: { sessionID: 800, localID: 1 },
          derivedSymbolData: [
            {
              guidPath: {
                guids: [
                  { sessionID: 64, localID: 1 },
                  { sessionID: 700, localID: 313 },
                ],
              },
              derivedTextData: {},
            },
          ],
        },
      ],
    };
    pruneInstanceDerivedTextData(msg, '700:313');
    expect(msg.nodeChanges[0].derivedSymbolData).toHaveLength(0);
  });

  it('walks every INSTANCE in the message — multiple removals', () => {
    const entry = (lid: number) => ({
      guidPath: { guids: [{ sessionID: 700, localID: lid }] },
      derivedTextData: {},
    });
    const msg = {
      nodeChanges: [
        { type: 'INSTANCE', guid: { sessionID: 800, localID: 1 }, derivedSymbolData: [entry(313), entry(999)] },
        { type: 'FRAME', guid: { sessionID: 60, localID: 1 } }, // not an INSTANCE — untouched
        { type: 'INSTANCE', guid: { sessionID: 900, localID: 5 }, derivedSymbolData: [entry(313)] },
      ],
    };
    pruneInstanceDerivedTextData(msg, '700:313');
    expect((msg.nodeChanges[0] as { derivedSymbolData: unknown[] }).derivedSymbolData).toHaveLength(1);
    expect((msg.nodeChanges[2] as { derivedSymbolData: unknown[] }).derivedSymbolData).toHaveLength(0);
  });

  it('is a no-op when no INSTANCEs reference the edited guid', () => {
    const msg = {
      nodeChanges: [
        {
          type: 'INSTANCE',
          guid: { sessionID: 800, localID: 1 },
          derivedSymbolData: [
            { guidPath: { guids: [{ sessionID: 700, localID: 999 }] }, derivedTextData: {} },
          ],
        },
      ],
    };
    const before = JSON.stringify(msg);
    pruneInstanceDerivedTextData(msg, '700:313');
    expect(JSON.stringify(msg)).toBe(before);
  });

  it('handles INSTANCEs without derivedSymbolData gracefully', () => {
    const msg = {
      nodeChanges: [
        { type: 'INSTANCE', guid: { sessionID: 800, localID: 1 } },
      ],
    };
    expect(() => pruneInstanceDerivedTextData(msg, '700:313')).not.toThrow();
  });

  it('keeps entries with a non-matching terminal segment even when an earlier segment matches', () => {
    const msg = {
      nodeChanges: [
        {
          type: 'INSTANCE',
          guid: { sessionID: 800, localID: 1 },
          derivedSymbolData: [
            {
              // terminal guid is 999, NOT 313, even though 313 appears earlier.
              guidPath: {
                guids: [
                  { sessionID: 700, localID: 313 },
                  { sessionID: 700, localID: 999 },
                ],
              },
              derivedTextData: {},
            },
          ],
        },
      ],
    };
    pruneInstanceDerivedTextData(msg, '700:313');
    expect(msg.nodeChanges[0].derivedSymbolData).toHaveLength(1);
  });
});
