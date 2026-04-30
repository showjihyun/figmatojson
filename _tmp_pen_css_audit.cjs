/**
 * pen CSS coverage audit — reference .pen vs our .pen.
 *
 * Pairs nodes by signature (type|name|width|height) and produces, per node type:
 *   - "ref-only" keys (CSS we MISS)
 *   - "our-only" keys (CSS we add unnecessarily — usually default values pencil omits)
 *   - "value-diff" keys (we emit but with wrong format/unit/value)
 * Plus sample values for each.
 *
 * Run:    node _tmp_pen_css_audit.cjs
 * Output: console table + writes JSON to _tmp_pen_css_audit.json
 */
const fs = require('fs');

const REF_PATH = 'docs/메타리치 화면 UI Design.pen';
const OUR_PATH = 'extracted/메타리치 화면 UI Design/08_pen/00_design setting.pen';

function* walk(n) { if (!n || typeof n !== 'object') return; yield n; if (Array.isArray(n.children)) for (const c of n.children) yield* walk(c); }

function sig(n) {
  return [
    n.type,
    n.name || '',
    typeof n.width === 'number' ? Math.round(n.width) : (n.width || ''),
    typeof n.height === 'number' ? Math.round(n.height) : (n.height || ''),
  ].join('|');
}

function loadAndBucket(path) {
  const doc = JSON.parse(fs.readFileSync(path, 'utf8'));
  const m = new Map();
  for (const n of walk(doc)) {
    if (!n.type) continue;
    const s = sig(n);
    if (!m.has(s)) m.set(s, []);
    m.get(s).push(n);
  }
  return m;
}

function shortVal(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v.length > 30 ? v.slice(0, 30) + '…' : JSON.stringify(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

const A = loadAndBucket(REF_PATH);
const B = loadAndBucket(OUR_PATH);

// Per-type coverage. Type comes from PenNode.type (frame/text/path/rectangle/...).
// stats[type][key] = { refSeen, ourSeen, valueMatch, valueDiff, refSamples[], ourSamples[] }
const stats = {};
function bump(type, key) {
  if (!stats[type]) stats[type] = {};
  if (!stats[type][key]) stats[type][key] = { refSeen: 0, ourSeen: 0, valueMatch: 0, valueDiff: 0, refSamples: [], ourSamples: [] };
  return stats[type][key];
}

let totalPairs = 0;
const unmatchedSigsA = []; // sigs only in ref
const unmatchedSigsB = []; // sigs only in ours
for (const [s, refs] of A) {
  const ours = B.get(s);
  if (!ours) { unmatchedSigsA.push({ sig: s, count: refs.length }); continue; }
  if (refs.length !== 1 || ours.length !== 1) continue; // skip ambiguous
  const a = refs[0], b = ours[0];
  const t = a.type;
  totalPairs++;
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of allKeys) {
    if (k === 'id' || k === 'children') continue;
    const inA = k in a, inB = k in b;
    const e = bump(t, k);
    if (inA) e.refSeen++;
    if (inB) e.ourSeen++;
    if (inA && inB) {
      const va = JSON.stringify(a[k]), vb = JSON.stringify(b[k]);
      if (va === vb) e.valueMatch++;
      else {
        e.valueDiff++;
        if (e.refSamples.length < 3) {
          e.refSamples.push({ name: a.name, ref: shortVal(a[k]), ours: shortVal(b[k]) });
        }
      }
    } else if (inA && !inB) {
      // we emit nothing but ref does — record as our-missing
      if (e.refSamples.length < 3) e.refSamples.push({ name: a.name, ref: shortVal(a[k]), ours: '(MISSING)' });
    } else if (!inA && inB) {
      if (e.ourSamples.length < 3) e.ourSamples.push({ name: a.name, ref: '(omit)', ours: shortVal(b[k]) });
    }
  }
}
for (const [s, ours] of B) if (!A.has(s)) unmatchedSigsB.push({ sig: s, count: ours.length });

// Render table per type
console.log(`\nPen CSS Coverage Audit — ${REF_PATH} (REF) vs ${OUR_PATH} (OURS)`);
console.log(`Compared ${totalPairs} unambiguous signature pairs.`);
console.log(`Unmatched signatures: ${unmatchedSigsA.length} ref-only, ${unmatchedSigsB.length} ours-only`);

for (const t of Object.keys(stats).sort()) {
  console.log(`\n=== ${t} (${stats[t].length || ''}) ===`);
  const rows = [];
  for (const [k, e] of Object.entries(stats[t])) {
    rows.push({
      key: k,
      ref: e.refSeen,
      ours: e.ourSeen,
      match: e.valueMatch,
      diff: e.valueDiff,
      missing: Math.max(0, e.refSeen - e.ourSeen),
      extra: Math.max(0, e.ourSeen - e.refSeen),
    });
  }
  // sort by issue severity: missing+diff descending
  rows.sort((a, b) => (b.missing + b.diff) - (a.missing + a.diff));
  console.log('  ' + 'key'.padEnd(22) + ' ref  ours match  diff  miss  extra');
  for (const r of rows) {
    const flag = (r.missing > 0 || r.diff > 0 || r.extra > 0) ? '⚠ ' : '  ';
    console.log(flag + r.key.padEnd(22) + String(r.ref).padStart(4) + String(r.ours).padStart(6) + String(r.match).padStart(6) + String(r.diff).padStart(6) + String(r.missing).padStart(6) + String(r.extra).padStart(7));
  }
  // print samples for issues
  for (const [k, e] of Object.entries(stats[t])) {
    if (e.refSamples.length === 0) continue;
    console.log(`    ↳ ${k} samples:`);
    for (const s of e.refSamples) console.log(`        [${(s.name||'').slice(0,30)}]  ref=${s.ref}  ours=${s.ours}`);
  }
}

// JSON dump
const json = { totalPairs, unmatchedSigsA: unmatchedSigsA.slice(0,30), unmatchedSigsB: unmatchedSigsB.slice(0,30), stats };
fs.writeFileSync('_tmp_pen_css_audit.json', JSON.stringify(json, null, 2));
console.log('\n→ Full JSON: _tmp_pen_css_audit.json');
