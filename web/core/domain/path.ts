/**
 * Path tokenizer + setter for dotted/bracket paths into the Document tree.
 *
 *   tokenizePath("textData.characters")     // ["textData", "characters"]
 *   tokenizePath("fillPaints[0].color.r")   // ["fillPaints", 0, "color", "r"]
 *   tokenizePath("stack.padding[2]")        // ["stack", "padding", 2]
 *
 * Used by the PATCH endpoint, the Inspector's debounced patcher, and the
 * AI tool dispatcher — same syntax everywhere so the wire format is one
 * thing.
 *
 * No IO, no framework — moved here from server/index.ts as part of the
 * Phase 2 domain extraction (see docs/SPEC-architecture.md §16.6).
 */

export type PathToken = string | number;

export function tokenizePath(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[2] !== undefined) tokens.push(parseInt(m[2], 10));
    else if (m[1] !== undefined) tokens.push(m[1]);
  }
  return tokens;
}

/**
 * Walk `obj` along `tokens`, creating intermediate {}/[] as needed, and
 * write `value` at the leaf. Returns true on success (always, today —
 * the boolean return preserves the legacy signature so callers compose
 * unchanged).
 */
export function setPath(
  obj: Record<string, unknown> | unknown[],
  tokens: PathToken[],
  value: unknown,
): boolean {
  let cur: any = obj;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1]!;
    if (cur[t] == null) cur[t] = typeof next === 'number' ? [] : {};
    cur = cur[t];
  }
  cur[tokens[tokens.length - 1]!] = value;
  return true;
}

/**
 * Read the value at `tokens`. Returns `undefined` for any missing
 * intermediate — callers treat that as "field absent" (used by the
 * journal to capture the pre-mutation state of a newly-introduced field).
 */
export function getPath(obj: unknown, tokens: PathToken[]): unknown {
  let cur: any = obj;
  for (const t of tokens) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[t];
  }
  return cur;
}
