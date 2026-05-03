/**
 * Split a Figma TEXT node's `characters` into per-style runs based on
 * `characterStyleIDs` + `styleOverrideTable`, so Canvas can render each
 * run as its own KText with the correct fill / weight.
 *
 * Spec: docs/specs/web-canvas-text-style-runs.spec.md §2 / §3.
 *
 * Data shape (Figma kiwi):
 *   - `characterStyleIDs[i]` is the styleID for character i. `0` means
 *     "use the node's base style" (no entry in styleOverrideTable for 0).
 *   - `styleOverrideTable` is an *array* of `{ styleID, ...overrideFields }`
 *     entries. Lookup is by iterating and matching `entry.styleID === id`.
 *     Only fields present on the entry override the base; absent fields
 *     fall through to the base.
 *
 * v1 supports per-range `fillPaints` only (the metarich state-text case
 * — 오류문구 red / 성공문구 green over a gray base). Other fields like
 * fontWeight / fontFamily are read off the override entry but the
 * Canvas TEXT branch doesn't yet honour per-run versions of those
 * (spec §5 비대상). They're surfaced here so a later round can wire
 * them up without changing this helper's interface.
 */
export interface StyleRun {
  /** Slice of `characters` this run covers. */
  text: string;
  /** First character index (inclusive). Useful for downstream measure. */
  startIndex: number;
  /** styleID this run resolved to; 0 means "base style". */
  styleID: number;
  /** Override fields for this run (empty when styleID === 0). */
  override: StyleOverrideFields;
}

/** Subset of styleOverrideTable entry fields we care about. */
export interface StyleOverrideFields {
  /** Per-run fillPaints; if undefined the base node fillPaints applies. */
  fillPaints?: unknown[];
  /** Reserved for later rounds — read but not used by Canvas yet. */
  fontWeight?: number;
  fontName?: { family?: string; style?: string };
  fontSize?: number;
}

interface StyleOverrideEntry extends StyleOverrideFields {
  styleID?: number;
}

/**
 * Compute the runs. Returns a single base-style run when no per-character
 * style data is present or all chars share styleID 0 — callers should
 * still render via the existing single-KText path in that case (caller
 * checks `runs.length === 1 && runs[0].styleID === 0`).
 *
 * Returns an empty array only when `characters` is empty.
 */
export function splitTextRuns(
  characters: string,
  characterStyleIDs: number[] | undefined,
  styleOverrideTable: StyleOverrideEntry[] | undefined,
): StyleRun[] {
  if (typeof characters !== 'string' || characters.length === 0) return [];

  // Corrupt or absent style data → single run with base style. Lengths
  // must match; Figma docs guarantee this but real files have surprised
  // us before, so fall back rather than throw.
  if (
    !Array.isArray(characterStyleIDs) ||
    characterStyleIDs.length !== characters.length
  ) {
    return [{ text: characters, startIndex: 0, styleID: 0, override: {} }];
  }

  // Index the override table once. Last entry wins on duplicate styleID
  // (matching Map.set semantics elsewhere in the codebase).
  const byId = new Map<number, StyleOverrideFields>();
  if (Array.isArray(styleOverrideTable)) {
    for (const entry of styleOverrideTable) {
      if (!entry || typeof entry.styleID !== 'number') continue;
      const fields: StyleOverrideFields = {};
      if (Array.isArray(entry.fillPaints)) fields.fillPaints = entry.fillPaints;
      if (typeof entry.fontWeight === 'number') fields.fontWeight = entry.fontWeight;
      if (entry.fontName && typeof entry.fontName === 'object') fields.fontName = entry.fontName;
      if (typeof entry.fontSize === 'number') fields.fontSize = entry.fontSize;
      byId.set(entry.styleID, fields);
    }
  }

  const runs: StyleRun[] = [];
  let runStart = 0;
  let runStyleID = characterStyleIDs[0]!;
  for (let i = 1; i <= characters.length; i++) {
    const id = characterStyleIDs[i];
    // Boundary when the styleID changes OR we hit the end of the string.
    if (i === characters.length || id !== runStyleID) {
      runs.push({
        text: characters.slice(runStart, i),
        startIndex: runStart,
        styleID: runStyleID,
        // styleID 0 has no entry in the table by Figma convention;
        // an unmapped non-zero id also gets an empty override (caller
        // falls back to base style — see spec §4).
        override: byId.get(runStyleID) ?? {},
      });
      runStart = i;
      runStyleID = id!;
    }
  }
  return runs;
}

/**
 * True when the runs require per-segment rendering (i.e. there's at
 * least one styled run, not all base). Cheap check the caller does
 * before walking the runs to lay out KText elements.
 */
export function hasStyledRuns(runs: StyleRun[]): boolean {
  if (runs.length <= 1) return false;
  for (const r of runs) if (r.styleID !== 0) return true;
  return false;
}
