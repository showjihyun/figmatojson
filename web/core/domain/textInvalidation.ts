/**
 * Invalidate Figma's pre-computed text layout cache when `textData.characters`
 * changes on a master TEXT node.
 *
 * Why this exists — the kiwi schema stores TEXT both as content
 * (`textData.characters`) and as a *baked layout* (`textData.glyphs[]`,
 * `baselines[]`, `derivedLines[]`, `fontMetaData[]`, `layoutSize`,
 * `truncatedHeight`, ...) plus a top-level `derivedTextData` field on the
 * NodeChange. INSTANCEs of a SYMBOL containing this TEXT carry their own
 * per-instance bake under `derivedSymbolData[].derivedTextData`.
 *
 * If we change `characters` to "테스트야" but leave the cached glyphs/baselines
 * sized for the old "old text", Figma re-imports the file and prefers the
 * cache (it's the *Figma copy/paste 진리* — see pen-export.ts:1329 source
 * comment). Result: edited content silently doesn't apply.
 *
 * The fix: clear *every* place Figma would read from cache, plus sync
 * `characterStyleIDs` length to the new character count so the encode
 * doesn't produce a half-mapped run. Figma re-derives layout on next open.
 */

interface MutableMessage {
  nodeChanges?: Array<Record<string, unknown>>;
}

/**
 * Clear Figma's text-layout cache on a single node whose `textData.characters`
 * just changed. Mutates `node` in place.
 *
 * Safe to call regardless of whether the node has any cached fields — every
 * delete is a no-op when the field is absent.
 */
export function invalidateTextLayoutCache(
  node: Record<string, unknown>,
  newCharacters: string,
): void {
  const td = node.textData as Record<string, unknown> | undefined;
  if (td) {
    // characterStyleIDs[i] picks a style index from styleOverrideTable for
    // character i. The encoded length MUST equal the character count or the
    // round-trip kiwi.encodeMessage produces a malformed message that some
    // consumers (Figma included) will reject or render with wrong runs.
    syncCharacterStyleIDs(td, newCharacters.length);

    // TextData's *cached layout* fields. Each was computed by Figma's text
    // shaper for the OLD characters string and is now stale.
    deleteCacheFields(td, [
      'derivedLines',
      'glyphs',
      'baselines',
      'fontMetaData',
      'layoutSize',
      'minContentHeight',
      'truncatedHeight',
      'truncationStartIndex',
      'logicalIndexToCharacterOffsetMap',
      'decorations',
      'blockquotes',
      'hyperlinkBoxes',
      'mentionBoxes',
      'fallbackFonts',
    ]);
  }

  // NodeChange's direct `derivedTextData` field — the master's own fully
  // resolved layout snapshot. Clearing it forces Figma to re-derive on import.
  delete node.derivedTextData;
}

/**
 * Walk every INSTANCE node in `message` and remove `derivedSymbolData[]`
 * entries whose `guidPath` terminates in `editedGuid` (`"sessionID:localID"`).
 * Mutates `message` in place. Each removed entry was a per-instance bake
 * tied to the now-stale master text content.
 *
 * Nested INSTANCE case: if an entry's path is `[outer:1, inner:7, target]`,
 * the terminal segment match still applies — we only check `guids[last]`,
 * not the prefix. Figma re-derives layout on import for any pruned entry.
 */
export function pruneInstanceDerivedTextData(
  message: MutableMessage,
  editedGuid: string,
): void {
  const nodes = message.nodeChanges;
  if (!Array.isArray(nodes)) return;

  for (const node of nodes) {
    if (node.type !== 'INSTANCE') continue;
    const ds = node.derivedSymbolData as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(ds) || ds.length === 0) continue;

    const filtered = ds.filter((entry) => {
      const path = entry.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined;
      const guids = path?.guids;
      if (!Array.isArray(guids) || guids.length === 0) return true;
      const last = guids[guids.length - 1];
      const lastStr =
        last && typeof last.sessionID === 'number' && typeof last.localID === 'number'
          ? `${last.sessionID}:${last.localID}`
          : null;
      return lastStr !== editedGuid;
    });

    if (filtered.length !== ds.length) {
      node.derivedSymbolData = filtered;
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function syncCharacterStyleIDs(td: Record<string, unknown>, newLen: number): void {
  const csi = td.characterStyleIDs;
  if (!Array.isArray(csi)) return;
  if (csi.length === newLen) return;
  if (newLen < csi.length) {
    td.characterStyleIDs = csi.slice(0, newLen);
    return;
  }
  // Pad with the last style index so newly-added characters inherit the
  // tail run's style. Falls back to 0 (master's default style) when the
  // array was empty.
  const tail = (csi[csi.length - 1] as number | undefined) ?? 0;
  td.characterStyleIDs = [...csi, ...new Array(newLen - csi.length).fill(tail)];
}

function deleteCacheFields(td: Record<string, unknown>, keys: readonly string[]): void {
  for (const k of keys) delete td[k];
}
