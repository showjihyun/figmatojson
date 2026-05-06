/**
 * Phase 1 — design token extraction from a decoded `.fig`.
 *
 * Spec: docs/specs/tokens.spec.md (Phase 1).
 *
 * Walks `decoded.message.nodeChanges`, picks every node carrying a
 * `styleType` field (FILL / TEXT / EFFECT — Figma's three first-class
 * style categories), and projects each into a stable token entry keyed
 * by the style's `name` (e.g. "Caption/14 Regular", "Blue-100").
 *
 * v1 scope intentionally narrow (Phase 0c agreement):
 *   - colors: SOLID FILL styles only — gradient / image fills emit nothing.
 *   - typography: family / style / fontSize / lineHeight / letterSpacing.
 *   - effects: DROP_SHADOW / INNER_SHADOW / LAYER_BLUR / BACKGROUND_BLUR
 *     (first visible effect on the style node).
 *   - spacing: deferred — Figma has no first-class spacing-style type.
 *   - variables (multi-mode): deferred — v2 picks up modes; v1 returns
 *     the resolved-default value if a style references a variable.
 */
import type { DecodedFig } from './decoder.js';

export interface Tokens {
  schemaVersion: '1';
  source: { figName: string };
  colors: Record<string, ColorToken>;
  typography: Record<string, TypographyToken>;
  effects: Record<string, EffectToken>;
}

export interface ColorToken {
  /** CSS-compatible hex; `#RRGGBB` when alpha is 1, `#RRGGBBAA` otherwise. */
  value: string;
  description?: string;
}

export interface TypographyToken {
  fontFamily: string;
  fontStyle: string;     // "Regular" | "Bold" | "Light" | etc.
  fontSize: number;      // px (Figma's authored value)
  lineHeight: { unit: 'PX' | 'PERCENT' | 'AUTO'; value: number };
  letterSpacing: { unit: 'PX' | 'PERCENT'; value: number };
  description?: string;
}

export interface EffectToken {
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  color?: string;        // hex; only for shadow types
  offset?: { x: number; y: number };
  radius?: number;       // shadow blur radius
  spread?: number;       // shadow spread
  blur?: number;         // for LAYER_BLUR / BACKGROUND_BLUR
  description?: string;
}

interface KiwiNode {
  styleType?: string;
  name?: string;
  description?: string;
  fillPaints?: Array<{
    type?: string;
    color?: { r?: number; g?: number; b?: number; a?: number };
    opacity?: number;
    visible?: boolean;
  }>;
  effects?: Array<{
    type?: string;
    color?: { r?: number; g?: number; b?: number; a?: number };
    offset?: { x?: number; y?: number };
    radius?: number;
    spread?: number;
    visible?: boolean;
  }>;
  fontSize?: number;
  fontName?: { family?: string; style?: string };
  lineHeight?: { value?: number; units?: string };
  letterSpacing?: { value?: number; units?: string };
}

export function extractTokens(decoded: DecodedFig, figName: string): Tokens {
  const nodes = ((decoded.message as { nodeChanges?: KiwiNode[] }).nodeChanges ?? []) as KiwiNode[];
  const colors: Record<string, ColorToken> = {};
  const typography: Record<string, TypographyToken> = {};
  const effects: Record<string, EffectToken> = {};
  for (const n of nodes) {
    if (!n.name || !n.styleType) continue;
    if (n.styleType === 'FILL') {
      const t = extractColor(n);
      if (t) colors[n.name] = t;
    } else if (n.styleType === 'TEXT') {
      const t = extractTypography(n);
      if (t) typography[n.name] = t;
    } else if (n.styleType === 'EFFECT') {
      const t = extractEffect(n);
      if (t) effects[n.name] = t;
    }
  }
  return { schemaVersion: '1', source: { figName }, colors, typography, effects };
}

function extractColor(n: KiwiNode): ColorToken | null {
  const p = n.fillPaints?.find((paint) => paint.visible !== false);
  if (!p || p.type !== 'SOLID' || !p.color) return null;
  const a = (p.opacity ?? 1) * (p.color.a ?? 1);
  const t: ColorToken = { value: rgbaToHex(p.color.r ?? 0, p.color.g ?? 0, p.color.b ?? 0, a) };
  if (n.description) t.description = n.description;
  return t;
}

function extractTypography(n: KiwiNode): TypographyToken | null {
  if (typeof n.fontSize !== 'number') return null;
  const fn = n.fontName ?? {};
  const t: TypographyToken = {
    fontFamily: fn.family ?? '',
    fontStyle: fn.style ?? 'Regular',
    fontSize: n.fontSize,
    lineHeight: normalizeLineHeight(n.lineHeight),
    letterSpacing: normalizeLetterSpacing(n.letterSpacing),
  };
  if (n.description) t.description = n.description;
  return t;
}

function normalizeLineHeight(lh: KiwiNode['lineHeight']): TypographyToken['lineHeight'] {
  const units = lh?.units;
  const value = lh?.value ?? 0;
  if (units === 'PIXELS') return { unit: 'PX', value };
  if (units === 'PERCENT') return { unit: 'PERCENT', value };
  // RAW (unitless multiplier) → AUTO; default to 1 when undefined.
  return { unit: 'AUTO', value: value || 1 };
}

function normalizeLetterSpacing(ls: KiwiNode['letterSpacing']): TypographyToken['letterSpacing'] {
  const units = ls?.units;
  const value = ls?.value ?? 0;
  if (units === 'PERCENT') return { unit: 'PERCENT', value };
  return { unit: 'PX', value };
}

function extractEffect(n: KiwiNode): EffectToken | null {
  const e = n.effects?.find((ef) => ef.visible !== false);
  if (!e || !e.type) return null;
  const t = e.type as EffectToken['type'];
  const out: EffectToken = { type: t };
  if (e.color) {
    out.color = rgbaToHex(e.color.r ?? 0, e.color.g ?? 0, e.color.b ?? 0, e.color.a ?? 1);
  }
  if (e.offset) out.offset = { x: e.offset.x ?? 0, y: e.offset.y ?? 0 };
  if (typeof e.radius === 'number') {
    if (t === 'DROP_SHADOW' || t === 'INNER_SHADOW') out.radius = e.radius;
    else out.blur = e.radius;
  }
  if (typeof e.spread === 'number') out.spread = e.spread;
  if (n.description) out.description = n.description;
  return out;
}

function rgbaToHex(r: number, g: number, b: number, a: number): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const base = `#${h(r)}${h(g)}${h(b)}`;
  if (a >= 0.9999) return base;
  return `${base}${h(a)}`;
}

// ─── Formatters ──────────────────────────────────────────────────────────

export type TokenFormat = 'json' | 'css' | 'js' | 'ts';

export function formatTokens(tokens: Tokens, format: TokenFormat): string {
  switch (format) {
    case 'json': return JSON.stringify(tokens, null, 2) + '\n';
    case 'css':  return formatCss(tokens);
    case 'js':   return formatJs(tokens);
    case 'ts':   return formatTs(tokens);
  }
}

function formatCss(tokens: Tokens): string {
  const lines: string[] = ['/* Generated by figma-reverse — do not edit. */', ':root {'];
  for (const [name, t] of Object.entries(tokens.colors)) {
    lines.push(`  --color-${slug(name)}: ${t.value};`);
  }
  for (const [name, t] of Object.entries(tokens.typography)) {
    const s = slug(name);
    lines.push(`  --typography-${s}-font-family: "${t.fontFamily}";`);
    lines.push(`  --typography-${s}-font-style: ${t.fontStyle};`);
    lines.push(`  --typography-${s}-font-size: ${t.fontSize}px;`);
    lines.push(`  --typography-${s}-line-height: ${cssLineHeight(t.lineHeight)};`);
    lines.push(`  --typography-${s}-letter-spacing: ${cssLetterSpacing(t.letterSpacing)};`);
  }
  for (const [name, t] of Object.entries(tokens.effects)) {
    if (t.type === 'DROP_SHADOW' || t.type === 'INNER_SHADOW') {
      const inset = t.type === 'INNER_SHADOW' ? 'inset ' : '';
      const o = t.offset ?? { x: 0, y: 0 };
      const r = t.radius ?? 0;
      const s = t.spread ?? 0;
      const c = t.color ?? '#000000';
      lines.push(`  --shadow-${slug(name)}: ${inset}${o.x}px ${o.y}px ${r}px ${s}px ${c};`);
    } else if (t.type === 'LAYER_BLUR' || t.type === 'BACKGROUND_BLUR') {
      lines.push(`  --blur-${slug(name)}: blur(${t.blur ?? 0}px);`);
    }
  }
  lines.push('}', '');
  return lines.join('\n');
}

function formatJs(tokens: Tokens): string {
  return `// Generated by figma-reverse — do not edit.\nexport default ${JSON.stringify(tokens, null, 2)};\n`;
}

function formatTs(tokens: Tokens): string {
  return `// Generated by figma-reverse — do not edit.
import type { Tokens } from 'figma-reverse';
export const tokens: Tokens = ${JSON.stringify(tokens, null, 2)};
export default tokens;
`;
}

/**
 * Lowercase, ASCII-clean slug for CSS variable names. Style names from
 * Figma carry slashes ("Heading/XL"), spaces ("Pretendard Variable"),
 * and Korean characters; CSS variable identifiers must start with `--`
 * and accept letters / digits / hyphens / underscores. We strip
 * everything else (and collapse runs of separators).
 */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cssLineHeight(lh: TypographyToken['lineHeight']): string {
  if (lh.unit === 'PX') return `${lh.value}px`;
  if (lh.unit === 'PERCENT') return `${lh.value}%`;
  // AUTO — emit as unitless multiplier (CSS line-height supports this).
  return `${lh.value}`;
}

function cssLetterSpacing(ls: TypographyToken['letterSpacing']): string {
  if (ls.unit === 'PERCENT') return `${ls.value / 100}em`;
  return `${ls.value}px`;
}
