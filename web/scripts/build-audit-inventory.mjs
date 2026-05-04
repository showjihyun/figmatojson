/**
 * Phase A — build the deep audit inventory across all 6 pages.
 *
 *   node scripts/build-audit-inventory.mjs
 *
 * Reads the metarich .fig via the running backend, walks every page, and
 * emits docs/audit-round11/_INVENTORY.json (machine-readable) plus a
 * human-readable _INVENTORY.md.
 *
 * Selection rules:
 *  - capture: page overview + every container-typed node whose size ≥ 50×50
 *  - container types: FRAME, SECTION, SYMBOL, INSTANCE, COMPONENT_SET
 *  - depth limit: 3 (page child = depth 1, that child's children = depth 2…)
 *  - dedupe: when ≥ 10 same-name+same-size nodes show up under the same parent,
 *    keep only the first — the rest are visually identical (e.g. 100 icon
 *    swatches in `icons` page).
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const FIG_PATH = resolve(REPO_ROOT, 'docs', '메타리치 화면 UI Design.fig');
const OUT_ROOT = resolve(REPO_ROOT, 'docs', 'audit-round11');

const CONTAINER_TYPES = new Set(['FRAME', 'SECTION', 'SYMBOL', 'INSTANCE', 'COMPONENT_SET']);
// Per-depth size filter — coarser at depth 1, finer-grained allowed deeper.
// Higher floors at depth ≥3 weed out icons / chrome elements while still
// catching real composite components.
const MIN_SIZE_BY_DEPTH = { 1: 50, 2: 80, 3: 150 };
const MIN_DIM_BY_DEPTH = { 1: 50, 2: 60, 3: 80 };
const MAX_DEPTH = 3;
const DEDUPE_THRESHOLD = 10;

function slugify(s) {
  if (!s) return 'unnamed';
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w가-힣 -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60) || 'unnamed';
}

function uniqueSlug(base, used) {
  let s = base;
  let i = 2;
  while (used.has(s)) {
    s = `${base}-${i}`;
    i++;
  }
  used.add(s);
  return s;
}

function pageBox(page) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of page.children ?? []) {
    const t = c.transform ?? {};
    const sz = c.size ?? {};
    const x = t.m02 ?? 0;
    const y = t.m12 ?? 0;
    const w = sz.x ?? 0;
    const h = sz.y ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function visit(node, depth, parentAbsX, parentAbsY, used, out) {
  const t = node.transform ?? {};
  const sz = node.size ?? {};
  const absX = parentAbsX + (t.m02 ?? 0);
  const absY = parentAbsY + (t.m12 ?? 0);
  const w = sz.x ?? 0;
  const h = sz.y ?? 0;
  const minMaj = MIN_SIZE_BY_DEPTH[depth] ?? 50;
  const minMin = MIN_DIM_BY_DEPTH[depth] ?? 50;
  const maj = Math.max(w, h);
  const min = Math.min(w, h);
  if (CONTAINER_TYPES.has(node.type) && maj >= minMaj && min >= minMin && depth <= MAX_DEPTH) {
    const baseSlug = `${slugify(node.name)}-${node.id?.replace(':', '_') ?? 'noid'}`;
    const slug = uniqueSlug(baseSlug, used);
    out.push({
      slug,
      name: node.name ?? '',
      type: node.type,
      id: node.id ?? '',
      depth,
      x: absX, y: absY, w, h,
    });
  }
  if (depth < MAX_DEPTH && Array.isArray(node.children)) {
    // Dedupe pass: if ≥ DEDUPE_THRESHOLD direct kids share the same name+w+h,
    // keep only the first. Cheap O(n) sketch via Map<key, count>.
    const sigCount = new Map();
    for (const c of node.children) {
      const k = `${c.name ?? ''}__${c.size?.x ?? 0}__${c.size?.y ?? 0}`;
      sigCount.set(k, (sigCount.get(k) ?? 0) + 1);
    }
    const seenSig = new Set();
    for (const c of node.children) {
      const k = `${c.name ?? ''}__${c.size?.x ?? 0}__${c.size?.y ?? 0}`;
      if (sigCount.get(k) >= DEDUPE_THRESHOLD) {
        if (seenSig.has(k)) continue;
        seenSig.add(k);
      }
      visit(c, depth + 1, absX, absY, used, out);
    }
  }
}

async function main() {
  // Upload + fetch doc via the running backend.
  const buf = readFileSync(FIG_PATH);
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'metarich.fig');
  const upRes = await fetch('http://localhost:5274/api/upload', { method: 'POST', body: fd });
  if (!upRes.ok) throw new Error(`upload failed: ${upRes.status}`);
  const { sessionId } = await upRes.json();
  const docRes = await fetch(`http://localhost:5274/api/doc/${sessionId}`);
  const doc = await docRes.json();

  mkdirSync(OUT_ROOT, { recursive: true });
  const inv = { sessionId, pages: [] };

  for (let pi = 0; pi < (doc.children ?? []).length; pi++) {
    const page = doc.children[pi];
    // Skip CANVAS pages hidden from Figma's UI tab strip (e.g. "Internal Only
    // Canvas" — designer scratchpad holding VARIABLE/BRUSH/SYMBOL definitions
    // referenced from other pages). Figma's REST API also returns no thumbnail
    // for these, so the inventory entry has nothing to compare against.
    if (page.visible === false) continue;
    const pageSlug = uniqueSlug(slugify(page.name), new Set());
    const used = new Set();
    const out = [];
    const pb = pageBox(page);
    for (const c of page.children ?? []) {
      visit(c, 1, 0, 0, used, out);
    }
    inv.pages.push({
      index: pi,
      name: page.name,
      slug: pageSlug,
      pageBox: pb,
      children: out,
    });
  }

  writeFileSync(resolve(OUT_ROOT, '_INVENTORY.json'), JSON.stringify(inv, null, 2));

  // Markdown summary
  const lines = [
    '# Round 11 — full audit inventory',
    '',
    `Source: \`docs/메타리치 화면 UI Design.fig\``,
    `Total pages: ${inv.pages.length}`,
    '',
    'Selection rules:',
    `- containers (\`FRAME / SECTION / SYMBOL / INSTANCE / COMPONENT_SET\`)`,
    `- size floors per depth (major × minor): d1 ≥ 50×50, d2 ≥ 80×60, d3 ≥ 150×80`,
    `- depth ≤ ${MAX_DEPTH} from the page root`,
    `- dedupe: same name+size repeated ≥ ${DEDUPE_THRESHOLD} times under one parent → keep first only`,
    '',
  ];
  for (const p of inv.pages) {
    lines.push(`## ${p.name} (\`${p.slug}\`) — ${p.children.length} captures, page bbox ${p.pageBox ? `(${p.pageBox.x},${p.pageBox.y}) ${p.pageBox.w}×${p.pageBox.h}` : 'empty'}`);
    lines.push('');
    if (p.children.length === 0) { lines.push('_(no captures — empty page or all children below threshold)_', ''); continue; }
    lines.push('| depth | type | name | id | x | y | w | h | slug |');
    lines.push('|---:|---|---|---|---:|---:|---:|---:|---|');
    for (const c of p.children) {
      const safeName = (c.name || '').replace(/\|/g, '\\|').slice(0, 60);
      lines.push(`| ${c.depth} | ${c.type} | ${safeName} | ${c.id} | ${c.x} | ${c.y} | ${c.w} | ${c.h} | \`${c.slug}\` |`);
    }
    lines.push('');
  }
  writeFileSync(resolve(OUT_ROOT, '_INVENTORY.md'), lines.join('\n'));

  console.log(`Wrote ${OUT_ROOT}/_INVENTORY.{json,md}`);
  console.log(`Total captures across pages: ${inv.pages.reduce((s, p) => s + p.children.length, 0)}`);
  for (const p of inv.pages) {
    console.log(`  ${p.name.padEnd(24)} → ${p.children.length} captures`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
