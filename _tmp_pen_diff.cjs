/**
 * .pen 매칭 비교 — 병렬 처리.
 * 비교 대상:
 *   - 참조: docs/메타리치 화면 UI Design.pen (Pencil 원본, 단일 페이지)
 *   - 우리: extracted/<figName>/08_pen/00_design setting.pen.json (해당 페이지)
 * 추가 페이지가 있으면 병렬로 비교 가능.
 */
const fs = require('fs/promises');

const COMPARISONS = [
  {
    name: 'design setting',
    ref: 'docs/메타리치 화면 UI Design.pen',
    ours: 'extracted/메타리치 화면 UI Design/08_pen/00_design setting.pen.json',
  },
];

function* walk(n) {
  if (!n || typeof n !== 'object') return;
  yield n;
  if (Array.isArray(n.children)) for (const c of n.children) yield* walk(c);
}

function key(n) {
  return [n.type, n.x ?? 0, n.y ?? 0, n.width ?? 0, n.height ?? 0, n.name ?? ''].join('|');
}

function buildMap(doc) {
  const map = new Map();
  let count = 0;
  for (const c of doc.children) {
    for (const x of walk(c)) {
      const k = key(x);
      map.set(k, (map.get(k) || 0) + 1);
      count++;
    }
  }
  return { map, count };
}

async function compareFiles(comp) {
  const [origText, oursText] = await Promise.all([
    fs.readFile(comp.ref, 'utf8'),
    fs.readFile(comp.ours, 'utf8'),
  ]);
  const orig = JSON.parse(origText);
  const ours = JSON.parse(oursText);

  const a = buildMap(orig);
  const b = buildMap(ours);

  let pencilOnly = 0;
  let oursOnly = 0;
  const examples = [];
  for (const [k, c] of a.map) {
    const oc = b.map.get(k) || 0;
    if (oc < c) {
      pencilOnly++;
      if (examples.length < 10) examples.push(`pencil-only ${c}→${oc}: ${k}`);
    }
  }
  for (const [k, c] of b.map) {
    const ac = a.map.get(k) || 0;
    if (ac < c) {
      oursOnly++;
      if (examples.length < 20) examples.push(`ours-only ${ac}→${c}: ${k}`);
    }
  }

  return {
    name: comp.name,
    pencilOnly,
    oursOnly,
    pencilTotal: a.count,
    oursTotal: b.count,
    diff: b.count - a.count,
    examples,
  };
}

(async () => {
  // 각 비교를 병렬로 실행
  const results = await Promise.all(COMPARISONS.map(compareFiles));

  for (const r of results) {
    console.log(`\n=== ${r.name} ===`);
    console.log(`pencil-only: ${r.pencilOnly}, ours-only: ${r.oursOnly}`);
    console.log(`total: pencil ${r.pencilTotal}, ours ${r.oursTotal}, diff ${r.diff}`);
    console.log(`\nFirst ${r.examples.length} examples:`);
    for (const e of r.examples) console.log('  ' + e);
  }
})();
