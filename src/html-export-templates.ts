/**
 * 정적 HTML/CSS/JS 템플릿 — html-export.ts에서 사용
 * 의존성 0 (vanilla JS, 인라인 CSS). file:// 프로토콜에서도 동작.
 */

export function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>figma-reverse · Dashboard</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="header">
    <div class="brand">
      <span class="logo">📐</span>
      <span class="title">figma-reverse</span>
      <span class="subtitle" id="file-name">—</span>
    </div>
    <nav class="tabs">
      <button class="tab active" data-tab="overview">Overview</button>
      <button class="tab" data-tab="pages">Pages</button>
      <button class="tab" data-tab="pen">Pen</button>
      <button class="tab" data-tab="tree">Tree</button>
      <button class="tab" data-tab="assets">Assets</button>
      <button class="tab" data-tab="schema">Schema</button>
      <button class="tab" data-tab="verify">Verify</button>
    </nav>
  </header>

  <main class="main">
    <section id="overview" class="panel active"></section>
    <section id="pages" class="panel"></section>
    <section id="pen" class="panel"></section>
    <section id="tree" class="panel"></section>
    <section id="assets" class="panel"></section>
    <section id="schema" class="panel"></section>
    <section id="verify" class="panel"></section>
  </main>

  <!-- 데이터 (글로벌 변수 주입) -->
  <script src="data/overview.js"></script>
  <script src="data/tree.js"></script>
  <script src="data/schema.js"></script>
  <script src="data/pages-index.js"></script>
  <script src="data/pen-index.js"></script>

  <!-- 앱 로직 -->
  <script src="app.js"></script>
</body>
</html>
`;
}

export function renderStyles(): string {
  return `:root {
  --bg: #1e1e1e;
  --bg-2: #2c2c2c;
  --bg-3: #3a3a3a;
  --fg: #e6e6e6;
  --fg-dim: #999;
  --accent: #0d99ff;
  --green: #1bc47d;
  --red: #ef4444;
  --yellow: #f7b500;
  --border: #3a3a3a;
  --mono: 'SF Mono', Menlo, Monaco, Consolas, 'Courier New', monospace;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
  line-height: 1.5;
  height: 100%;
}

body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

/* Header */
.header {
  display: flex;
  align-items: center;
  padding: 0 16px;
  height: 48px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
  gap: 24px;
  flex-shrink: 0;
}
.brand { display: flex; align-items: center; gap: 8px; }
.logo { font-size: 18px; }
.title { font-weight: 700; }
.subtitle { color: var(--fg-dim); font-size: 12px; }

.tabs { display: flex; gap: 2px; }
.tab {
  background: transparent;
  border: none;
  color: var(--fg-dim);
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
  border-radius: 4px;
  transition: all 0.15s;
}
.tab:hover { background: var(--bg-3); color: var(--fg); }
.tab.active { background: var(--accent); color: white; }

/* Main */
.main { flex: 1; overflow: hidden; position: relative; }
.panel {
  display: none;
  height: 100%;
  overflow: auto;
  padding: 24px;
}
.panel.active { display: block; }

/* Overview */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.stat-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
.stat-card .label { color: var(--fg-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
.stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
.stat-card .sub { font-size: 11px; color: var(--fg-dim); margin-top: 4px; }

.section-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--fg-dim);
  margin: 24px 0 8px 0;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

.kv-grid {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 4px 16px;
  font-size: 12px;
}
.kv-grid dt { color: var(--fg-dim); }
.kv-grid dd { margin: 0; font-family: var(--mono); word-break: break-all; }

.color-swatch {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid var(--border);
  vertical-align: middle;
  margin-right: 6px;
}

/* Pages: 좌측 사이드바 + 우측 미리보기 */
#pages {
  display: none;
  padding: 0;
}
#pages.active { display: flex; flex-direction: row; }
.page-sidebar {
  width: 220px;
  background: var(--bg-2);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  flex-shrink: 0;
}
.page-item {
  padding: 10px 16px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.page-item:hover { background: var(--bg-3); }
.page-item.active { background: var(--accent); color: white; }
.page-item .name { font-weight: 600; }
.page-item .meta { font-size: 11px; color: var(--fg-dim); margin-top: 2px; }
.page-item.active .meta { color: rgba(255,255,255,0.7); }

.page-canvas {
  flex: 1;
  overflow: auto;
  background: #2a2a2a;
  position: relative;
}
.page-canvas-inner {
  position: relative;
  margin: 24px;
  background: white;
  box-shadow: 0 4px 20px rgba(0,0,0,0.5);
}
.fr-node {
  position: absolute;
  overflow: hidden;
  font-size: 12px;
}
.fr-node[data-type="TEXT"] { white-space: pre-wrap; }

.page-controls {
  padding: 8px 12px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
}
.page-content { display: flex; flex-direction: column; flex: 1; overflow: hidden; }

/* Tree (가상 스크롤 없이 페이징) */
.tree-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.tree-controls input[type="text"], .tree-controls select {
  background: var(--bg-2);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
}
.tree-controls input[type="text"] { width: 240px; }

.tree-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--mono);
  font-size: 12px;
}
.tree-table th, .tree-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.tree-table th {
  background: var(--bg-2);
  color: var(--fg-dim);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  position: sticky;
  top: 0;
  z-index: 1;
}
.tree-table tr:hover td { background: var(--bg-2); }

.type-tag {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 10px;
  background: var(--bg-3);
  color: var(--fg);
}
.type-tag.DOCUMENT { background: #555; color: white; }
.type-tag.CANVAS { background: var(--accent); color: white; }
.type-tag.FRAME { background: #6e56cf; color: white; }
.type-tag.TEXT { background: var(--green); color: white; }
.type-tag.VECTOR { background: #f7b500; color: black; }
.type-tag.RECTANGLE, .type-tag.ROUNDED_RECTANGLE { background: #888; color: white; }
.type-tag.INSTANCE { background: #d946ef; color: white; }
.type-tag.SYMBOL { background: #ec4899; color: white; }

/* Assets grid */
.assets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}
.asset-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
}
.asset-card:hover { border-color: var(--accent); }
.asset-thumb {
  width: 100%;
  height: 120px;
  object-fit: contain;
  background: repeating-conic-gradient(#2a2a2a 0% 25%, #333 0% 50%) 50% / 16px 16px;
  display: block;
}
.asset-meta {
  padding: 8px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--fg-dim);
}
.asset-meta .name { color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Schema */
.schema-list { display: flex; flex-direction: column; gap: 8px; }
.schema-def {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 16px;
}
.schema-def header { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.schema-def .name { font-family: var(--mono); font-weight: 600; }
.schema-def .kind {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--bg-3);
  color: var(--fg-dim);
}
.schema-def .field-count { color: var(--fg-dim); font-size: 11px; margin-left: auto; }
.schema-def .fields {
  display: none;
  margin-top: 12px;
  font-family: var(--mono);
  font-size: 11px;
}
.schema-def.expanded .fields { display: block; }
.schema-def .field { padding: 2px 0; color: var(--fg-dim); }
.schema-def .field strong { color: var(--fg); }

/* Verify */
.verify-list { display: flex; flex-direction: column; gap: 8px; }
.verify-row {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 16px;
  display: grid;
  grid-template-columns: 60px 200px 1fr;
  gap: 12px;
  align-items: center;
}
.verify-status {
  font-size: 12px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 3px;
  text-align: center;
}
.verify-status.pass { background: var(--green); color: white; }
.verify-status.warn { background: var(--yellow); color: black; }
.verify-status.fail { background: var(--red); color: white; }
.verify-status.skip { background: var(--bg-3); color: var(--fg-dim); }
.verify-detail { font-family: var(--mono); font-size: 11px; color: var(--fg-dim); word-break: break-all; }

/* Empty state */
.empty {
  color: var(--fg-dim);
  text-align: center;
  padding: 48px;
  font-style: italic;
}

/* Detail drawer (트리 클릭 시 raw 데이터 보기) */
.drawer {
  position: fixed;
  right: 0;
  top: 48px;
  bottom: 0;
  width: 480px;
  background: var(--bg-2);
  border-left: 1px solid var(--border);
  overflow: auto;
  padding: 16px;
  transform: translateX(100%);
  transition: transform 0.2s;
  z-index: 10;
}
.drawer.open { transform: translateX(0); }
.drawer .close {
  float: right;
  background: transparent;
  border: none;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: 18px;
}
.drawer pre {
  font-family: var(--mono);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg);
  padding: 12px;
  border-radius: 4px;
  margin-top: 8px;
}

/* ── Pen viewer (.pen.json structured tree) ────────────────────── */
#pen { display: flex; flex-direction: row; }
.pen-sidebar {
  width: 240px;
  flex: 0 0 auto;
  border-right: 1px solid var(--border);
  overflow-y: auto;
}
.pen-item {
  padding: 10px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.pen-item:hover { background: var(--bg-2); }
.pen-item.active { background: var(--bg-3); }
.pen-item .name { font-size: 13px; }
.pen-item .meta { font-size: 11px; color: var(--fg-dim); margin-top: 2px; }
.pen-content {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pen-controls {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.pen-controls input[type=search] {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 4px 8px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 12px;
}
.pen-controls button {
  background: var(--bg-3);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.pen-controls button:hover { background: var(--bg);}
.pen-tree {
  flex: 1 1 auto;
  overflow: auto;
  padding: 8px;
  font-family: var(--mono);
  font-size: 12px;
}
.pen-node {
  display: block;
  padding: 0;
  margin: 0;
}
.pen-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  cursor: pointer;
  white-space: nowrap;
}
.pen-row:hover { background: var(--bg-2); }
.pen-row.match { background: rgba(255, 215, 0, 0.15); }
.pen-toggle {
  display: inline-block;
  width: 14px;
  text-align: center;
  color: var(--fg-dim);
  user-select: none;
}
.pen-toggle.empty { color: transparent; }
.pen-type {
  display: inline-block;
  font-size: 10px;
  font-weight: bold;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  flex: 0 0 auto;
}
.pen-type.frame { background: #3b82f6; color: white; }
.pen-type.text { background: #10b981; color: white; }
.pen-type.path { background: #f59e0b; color: white; }
.pen-type.rectangle { background: #8b5cf6; color: white; }
.pen-name { color: var(--fg); flex: 0 1 auto; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.pen-name.disabled { color: var(--fg-dim); text-decoration: line-through; }
.pen-attr { color: var(--fg-dim); font-size: 11px; flex: 0 0 auto; }
.pen-children {
  margin-left: 18px;
  display: block;
}
.pen-children.collapsed { display: none; }
.pen-detail-panel {
  background: var(--bg-2);
  border-top: 1px solid var(--border);
  max-height: 40%;
  overflow: auto;
  padding: 10px 14px;
}
.pen-detail-panel pre {
  font-family: var(--mono);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
`;
}

export function renderApp(): string {
  return `// figma-reverse dashboard — vanilla JS, no deps
'use strict';

(function () {
  // ── 데이터 (data/*.js 또는 single-file inline으로 주입) ─────────────
  const OVERVIEW = window.OVERVIEW || {};
  const NODES_FLAT = window.NODES_FLAT || [];
  const SCHEMA = window.SCHEMA || null;
  const PAGES_INDEX = window.PAGES_INDEX || [];
  const IMAGES = window.IMAGES || null;       // single-file: { hash: 'data:...;base64,...' }
  const VECTORS = window.VECTORS || null;     // single-file: { id: '<svg>...</svg>' }
  const PAGES_INLINE = window.PAGES_INLINE || null; // single-file: array of stripped pages
  const THUMBNAIL = window.THUMBNAIL || null;
  const PEN_INDEX = window.PEN_INDEX || []; // [{idx, name, fileName, nodeCount, relPath, bytes}]
  const PEN_INLINE = window.PEN_INLINE || null; // single-file: array of pen docs
  const SINGLE_FILE = !!(IMAGES || VECTORS || PAGES_INLINE);
  let currentPageData = null; // lazy load (multi-file mode)
  let currentPenDoc = null;
  let currentPenIdx = -1;

  function imageUrl(hash) {
    if (!hash) return null;
    if (IMAGES && IMAGES[hash]) return IMAGES[hash];
    // multi-file 모드: 디렉토리에서 — 확장자 추정 (overview.imageHashes에서)
    const item = (OVERVIEW.imageHashes || []).find((x) => x.hash === hash);
    const ext = item ? item.ext : 'png';
    return 'assets/images/' + hash + '.' + ext;
  }
  function svgFor(safeId) {
    if (VECTORS && VECTORS[safeId]) return VECTORS[safeId];
    return '<img src="assets/vectors/' + safeId + '.svg" style="width:100%;height:100%" onerror="this.style.display=\\'none\\'" />';
  }

  // ── Tab 라우팅 ─────────────────────────────────────────────────────
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      const target = t.dataset.tab;
      tabs.forEach((x) => x.classList.toggle('active', x === t));
      panels.forEach((p) => p.classList.toggle('active', p.id === target));
      if (target === 'pages' && PAGES_INDEX.length > 0 && !currentPageData) {
        loadPage(0);
      }
      if (target === 'pen') {
        if (!document.getElementById('pen-sidebar')) renderPenShell();
        if (PEN_INDEX.length > 0 && currentPenIdx < 0) loadPenPage(0);
      }
    });
  });

  // ── 헤더 파일명 ────────────────────────────────────────────────────
  document.getElementById('file-name').textContent = OVERVIEW.fileName || '—';

  // ── Overview 패널 ──────────────────────────────────────────────────
  function renderOverview() {
    const el = document.getElementById('overview');
    const t = OVERVIEW.totals || {};
    const a = OVERVIEW.archive || {};
    const bg = OVERVIEW.backgroundColor;
    const rc = OVERVIEW.renderCoords;

    let typeRows = '';
    const typeEntries = Object.entries(OVERVIEW.typeDistribution || {}).sort((a,b)=>b[1]-a[1]);
    for (const [type, count] of typeEntries) {
      const pct = ((count / t.nodes) * 100).toFixed(1);
      typeRows += '<tr><td><span class="type-tag ' + escapeHtml(type) + '">' + escapeHtml(type) + '</span></td><td>' + count + '</td><td>' + pct + '%</td></tr>';
    }

    const bgSwatch = bg
      ? '<span class="color-swatch" style="background:rgba(' + Math.round(bg.r*255) + ',' + Math.round(bg.g*255) + ',' + Math.round(bg.b*255) + ',' + bg.a + ')"></span>rgba(' + bg.r.toFixed(4) + ', ' + bg.g.toFixed(4) + ', ' + bg.b.toFixed(4) + ', ' + bg.a + ')'
      : '—';

    el.innerHTML =
      '<div class="stats">' +
      statCard('Pages', t.pages, '캔버스 수') +
      statCard('Nodes', (t.nodes||0).toLocaleString(), '전체 트리') +
      statCard('Images', t.images, '컨텐츠 해시 파일') +
      statCard('Vectors', t.vectors, '추출된 SVG') +
      statCard('Schema Defs', t.schemaDefinitions, 'Kiwi type 정의') +
      '</div>' +
      '<div class="section-title">파일 메타</div>' +
      '<dl class="kv-grid">' +
      kv('파일명', escapeHtml(OVERVIEW.fileName || '—')) +
      kv('export 시각', escapeHtml(OVERVIEW.exportedAt || '—')) +
      kv('배경색', bgSwatch) +
      kv('render 좌표', rc ? \`\${rc.width} × \${rc.height} @ (\${rc.x}, \${rc.y})\` : '—') +
      '</dl>' +
      '<div class="section-title">Archive 메타</div>' +
      '<dl class="kv-grid">' +
      kv('ZIP wrap', a.isZipWrapped === null ? '—' : (a.isZipWrapped ? 'true' : 'false')) +
      kv('archive version', a.version ?? '—') +
      kv('schema 압축', a.schemaCompression || '—') +
      kv('data 압축', a.dataCompression || '—') +
      '</dl>' +
      '<div class="section-title">노드 타입 분포</div>' +
      '<table class="tree-table"><thead><tr><th>Type</th><th>Count</th><th>%</th></tr></thead><tbody>' +
      typeRows +
      '</tbody></table>';
  }

  function statCard(label, value, sub) {
    return '<div class="stat-card"><div class="label">' + label + '</div><div class="value">' + (value ?? '—') + '</div><div class="sub">' + (sub || '') + '</div></div>';
  }
  function kv(k, v) {
    return '<dt>' + k + '</dt><dd>' + v + '</dd>';
  }

  // ── Pages 패널 ─────────────────────────────────────────────────────
  function renderPagesShell() {
    const el = document.getElementById('pages');
    let sidebar = '<aside class="page-sidebar" id="page-sidebar">';
    if (PAGES_INDEX.length === 0) {
      sidebar += '<div class="empty">No pages</div>';
    } else {
      PAGES_INDEX.forEach((p, i) => {
        sidebar += '<div class="page-item' + (i===0?' active':'') + '" data-idx="' + i + '"><div class="name">' + escapeHtml(p.name) + '</div><div class="meta">' + p.nodeCount + ' nodes</div></div>';
      });
    }
    sidebar += '</aside>';
    el.innerHTML = sidebar +
      '<div class="page-content">' +
        '<div class="page-controls" id="page-controls"><span id="page-meta">Loading…</span></div>' +
        '<div class="page-canvas" id="page-canvas"><div class="empty">페이지를 선택하세요</div></div>' +
      '</div>';

    el.querySelectorAll('.page-item').forEach((node) => {
      node.addEventListener('click', () => loadPage(parseInt(node.dataset.idx)));
    });
  }

  function loadPage(idx) {
    const info = PAGES_INDEX[idx];
    if (!info) return;
    document.querySelectorAll('.page-item').forEach((n, i) => n.classList.toggle('active', i === idx));
    document.getElementById('page-meta').textContent = 'Loading ' + info.name + '…';

    if (SINGLE_FILE && PAGES_INLINE) {
      currentPageData = PAGES_INLINE[idx];
      renderPageCanvas(currentPageData, info);
      return;
    }

    // multi-file: <script> 태그로 lazy load
    const existing = document.getElementById('page-data-script');
    if (existing) existing.remove();
    const s = document.createElement('script');
    s.id = 'page-data-script';
    s.src = info.relPath;
    s.onload = () => {
      currentPageData = window.PAGE;
      renderPageCanvas(currentPageData, info);
    };
    document.body.appendChild(s);
  }

  function renderPageCanvas(page, info) {
    if (!page) return;
    const canvas = document.getElementById('page-canvas');

    // 페이지의 자식 (top-level frames)을 먼저 모은 후 absolute bounding box 계산
    const children = page.children || [];
    if (children.length === 0) {
      canvas.innerHTML = '<div class="empty">이 페이지는 비어있습니다</div>';
      return;
    }

    // 모든 top-level frame의 bounding box union
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of children) {
      const bb = c.absoluteBoundingBox;
      if (!bb) continue;
      minX = Math.min(minX, bb.x);
      minY = Math.min(minY, bb.y);
      maxX = Math.max(maxX, bb.x + bb.width);
      maxY = Math.max(maxY, bb.y + bb.height);
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1000; maxY = 1000; }
    const totalW = maxX - minX;
    const totalH = maxY - minY;

    document.getElementById('page-meta').textContent =
      info.name + ' · ' + info.nodeCount + ' nodes · ' + Math.round(totalW) + ' × ' + Math.round(totalH);

    let nodesRendered = 0;
    const MAX_NODES = 3000; // 너무 많으면 브라우저 죽음

    function renderNode(n, parentBb) {
      if (nodesRendered >= MAX_NODES) return '';
      nodesRendered++;
      const type = n.type || 'NONE';
      const bb = n.absoluteBoundingBox;
      if (!bb) return ''; // 좌표 없으면 skip

      const x = bb.x - minX;
      const y = bb.y - minY;
      const w = bb.width;
      const h = bb.height;

      const style = ['position:absolute','left:'+x+'px','top:'+y+'px','width:'+w+'px','height:'+h+'px'];

      const fills = n.fills || n.raw?.fillPaints;
      if (Array.isArray(fills) && fills.length > 0) {
        const f = fills[0];
        if (f && f.visible !== false) {
          if (f.type === 'SOLID' && f.color) {
            const c = f.color;
            style.push('background-color:rgba(' + Math.round(c.r*255) + ',' + Math.round(c.g*255) + ',' + Math.round(c.b*255) + ',' + (c.a ?? 1) + ')');
          } else if (f.type === 'IMAGE' && (f.image?.hash || f.imageRef)) {
            const hash = (typeof f.image?.hash === 'string' ? f.image.hash : f.imageRef) || '';
            const url = imageUrl(hash);
            if (url) {
              style.push('background-image:url("' + url + '")');
              style.push('background-size:cover');
              style.push('background-position:center');
            }
          }
        }
      }

      // 코너 라운딩
      const cr = n.raw?.cornerRadius;
      if (typeof cr === 'number' && cr > 0) style.push('border-radius:' + cr + 'px');

      // TEXT 노드 컨텐츠
      let inner = '';
      if (type === 'TEXT') {
        const text = n.raw?.textData?.characters ?? n.raw?.characters ?? '';
        const fontSize = n.raw?.fontSize ?? n.raw?.textData?.fontSize ?? 12;
        const fc = (n.fills || n.raw?.fillPaints || [])[0]?.color;
        const color = fc ? 'rgba(' + Math.round(fc.r*255) + ',' + Math.round(fc.g*255) + ',' + Math.round(fc.b*255) + ',' + (fc.a ?? 1) + ')' : '#000';
        style.push('color:' + color);
        style.push('font-size:' + fontSize + 'px');
        style.push('background-color:transparent');
        inner = escapeHtml(text);
      } else if (type === 'VECTOR' || type === 'STAR' || type === 'LINE' || type === 'ELLIPSE' || type === 'REGULAR_POLYGON') {
        const safeId = (n.id || '').replace(/[^a-zA-Z0-9_]/g, '_');
        inner = '<div style="width:100%;height:100%">' + svgFor(safeId) + '</div>';
      }

      let html = '<div class="fr-node" data-type="' + escapeHtml(type) + '" data-id="' + escapeHtml(n.id||'') + '" title="' + escapeHtml((n.name||'') + ' · ' + type) + '" style="' + style.join(';') + '">' + inner;
      if (Array.isArray(n.children) && n.children.length > 0) {
        for (const c of n.children) html += renderNode(c, bb);
      }
      html += '</div>';
      return html;
    }

    let html = '<div class="page-canvas-inner" style="width:' + totalW + 'px;height:' + totalH + 'px">';
    for (const c of children) html += renderNode(c, null);
    html += '</div>';
    canvas.innerHTML = html;

    if (nodesRendered >= MAX_NODES) {
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = '⚠ ' + MAX_NODES + '개 노드까지만 렌더 (페이지에는 ' + info.nodeCount + '개 있음)';
      canvas.appendChild(note);
    }
  }

  // ── Tree 패널 (가상 스크롤 없이 limit 1000) ─────────────────────────
  function renderTreeShell() {
    const el = document.getElementById('tree');
    el.innerHTML =
      '<div class="tree-controls">' +
        '<input type="text" id="tree-search" placeholder="Search by name…" />' +
        '<select id="tree-type-filter"><option value="">All types</option></select>' +
        '<span id="tree-count" style="color:var(--fg-dim)"></span>' +
      '</div>' +
      '<table class="tree-table"><thead><tr><th>Type</th><th>Name</th><th>ID</th><th>Parent</th><th>Children</th></tr></thead><tbody id="tree-tbody"></tbody></table>';

    // type filter 옵션
    const types = Array.from(new Set(NODES_FLAT.map((n) => n.type))).sort();
    const sel = document.getElementById('tree-type-filter');
    for (const t of types) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }

    document.getElementById('tree-search').addEventListener('input', refreshTree);
    sel.addEventListener('change', refreshTree);
    refreshTree();
  }

  function refreshTree() {
    const q = document.getElementById('tree-search').value.toLowerCase();
    const ft = document.getElementById('tree-type-filter').value;
    const filtered = NODES_FLAT.filter((n) => {
      if (ft && n.type !== ft) return false;
      if (q && !((n.name || '') + n.id).toLowerCase().includes(q)) return false;
      return true;
    });
    const limit = 1000;
    const slice = filtered.slice(0, limit);
    const tbody = document.getElementById('tree-tbody');
    let html = '';
    for (const n of slice) {
      html +=
        '<tr><td><span class="type-tag ' + escapeHtml(n.type) + '">' + escapeHtml(n.type) + '</span></td>' +
        '<td>' + escapeHtml(n.name || '—') + '</td>' +
        '<td>' + escapeHtml(n.id) + '</td>' +
        '<td>' + escapeHtml(n.parentId || '—') + '</td>' +
        '<td>' + n.childCount + '</td></tr>';
    }
    tbody.innerHTML = html;
    document.getElementById('tree-count').textContent =
      filtered.length + ' nodes' + (filtered.length > limit ? ' (showing first ' + limit + ')' : '');
  }

  // ── Assets 패널 ─────────────────────────────────────────────────────
  function renderAssets() {
    const el = document.getElementById('assets');
    const imgHashes = (OVERVIEW.imageHashes || []);
    let html = '<div class="section-title">Images (' + imgHashes.length + ')</div><div class="assets-grid">';
    if (imgHashes.length === 0) {
      html += '<div class="empty">이미지 없음</div>';
    }
    for (const item of imgHashes) {
      const url = imageUrl(item.hash) || ('assets/images/' + item.hash + '.' + item.ext);
      html += '<div class="asset-card" onclick="window.open(\\'' + url + '\\')">' +
              '<img class="asset-thumb" src="' + url + '" loading="lazy" onerror="this.style.opacity=0.3" />' +
              '<div class="asset-meta"><div class="name">' + item.hash.slice(0,8) + '… (' + item.ext + ')</div></div></div>';
    }
    html += '</div>';

    html += '<div class="section-title">Vectors (' + (OVERVIEW.totals?.vectors || 0) + ')</div>';
    html += '<div style="color:var(--fg-dim);margin-bottom:8px">SVG는 Pages 탭의 미리보기에서 인라인 임베드됩니다.</div>';

    if (OVERVIEW.thumbnail) {
      const thumbUrl = THUMBNAIL || 'assets/thumbnail.png';
      html += '<div class="section-title">Thumbnail</div>';
      html += '<img src="' + thumbUrl + '" style="max-width:400px;border:1px solid var(--border)" />';
    }
    el.innerHTML = html;
  }

  // ── Schema 패널 ────────────────────────────────────────────────────
  function renderSchema() {
    const el = document.getElementById('schema');
    if (!SCHEMA) {
      el.innerHTML = '<div class="empty">스키마 데이터 없음</div>';
      return;
    }
    const defs = SCHEMA.definitions || [];
    let html =
      '<div class="tree-controls">' +
        '<input type="text" id="schema-search" placeholder="Search definitions…" />' +
        '<span style="color:var(--fg-dim)">' + defs.length + ' definitions · root: ' + (SCHEMA.rootType || '—') + '</span>' +
      '</div>' +
      '<div class="schema-list" id="schema-list"></div>';
    el.innerHTML = html;

    function refresh() {
      const q = document.getElementById('schema-search').value.toLowerCase();
      const list = document.getElementById('schema-list');
      const filtered = defs.filter((d) => !q || d.name.toLowerCase().includes(q));
      const limit = 200;
      let h = '';
      for (const d of filtered.slice(0, limit)) {
        const fields = d.fields || [];
        h += '<div class="schema-def" data-name="' + escapeHtml(d.name) + '">' +
             '<header onclick="this.parentNode.classList.toggle(\\'expanded\\')">'+
             '<span class="kind">' + escapeHtml(d.kind) + '</span>' +
             '<span class="name">' + escapeHtml(d.name) + '</span>' +
             '<span class="field-count">' + fields.length + ' fields</span>' +
             '</header>' +
             '<div class="fields">' + fields.map((f) =>
               '<div class="field"><strong>' + escapeHtml(f.name) + '</strong>: ' +
               escapeHtml(f.type || '') + (f.isArray ? '[]' : '') +
               (f.value !== undefined ? ' = ' + f.value : '') +
               (f.isDeprecated ? ' <span style="color:var(--red)">(deprecated)</span>' : '') +
               '</div>'
             ).join('') + '</div>' +
             '</div>';
      }
      list.innerHTML = h + (filtered.length > limit ? '<div class="empty">' + filtered.length + ' total · showing first ' + limit + '</div>' : '');
    }
    document.getElementById('schema-search').addEventListener('input', refresh);
    refresh();
  }

  // ── Verify 패널 ────────────────────────────────────────────────────
  function renderVerify() {
    const el = document.getElementById('verify');
    const checks = OVERVIEW.verification;
    if (!checks || checks.length === 0) {
      el.innerHTML = '<div class="empty">검증 결과 없음 (verification_report.md 미발견)</div>';
      return;
    }
    let html = '<div class="verify-list">';
    for (const c of checks) {
      const sCls = c.status.includes('PASS') ? 'pass' : c.status.includes('FAIL') ? 'fail' : c.status.includes('WARN') ? 'warn' : 'skip';
      const sLabel = c.status.replace(/[🟢🔴🟡⚪]/g, '').trim();
      html += '<div class="verify-row">' +
              '<div class="verify-status ' + sCls + '">' + escapeHtml(sLabel) + '</div>' +
              '<div><strong>' + escapeHtml(c.id) + '</strong> ' + escapeHtml(c.name) + '</div>' +
              '<div class="verify-detail">' + escapeHtml(c.detail) + '</div>' +
              '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  // ── Pen 패널 (.pen.json structured viewer) ─────────────────────────
  function renderPenShell() {
    const el = document.getElementById('pen');
    let sidebar = '<aside class="pen-sidebar" id="pen-sidebar">';
    if (PEN_INDEX.length === 0) {
      sidebar += '<div class="empty">No .pen files. Run pen-export first.</div>';
    } else {
      PEN_INDEX.forEach((p, i) => {
        sidebar += '<div class="pen-item' + (i===0?' active':'') + '" data-idx="' + i + '">' +
          '<div class="name">' + escapeHtml(p.name) + '</div>' +
          '<div class="meta">' + p.nodeCount + ' nodes · ' + formatBytes(p.bytes||0) + '</div>' +
          '</div>';
      });
    }
    sidebar += '</aside>';
    el.innerHTML = sidebar +
      '<div class="pen-content">' +
        '<div class="pen-controls" id="pen-controls">' +
          '<input type="search" id="pen-search" placeholder="Filter by name…" />' +
          '<button id="pen-expand-all">Expand all</button>' +
          '<button id="pen-collapse-all">Collapse all</button>' +
          '<span id="pen-meta" style="font-size:12px;color:var(--fg-dim)">—</span>' +
        '</div>' +
        '<div class="pen-tree" id="pen-tree"><div class="empty">파일을 선택하세요</div></div>' +
        '<div class="pen-detail-panel" id="pen-detail" style="display:none"><pre id="pen-detail-pre"></pre></div>' +
      '</div>';

    el.querySelectorAll('.pen-item').forEach((node) => {
      node.addEventListener('click', () => loadPenPage(parseInt(node.dataset.idx)));
    });
    document.getElementById('pen-search').addEventListener('input', (e) => filterPenTree(e.target.value));
    document.getElementById('pen-expand-all').addEventListener('click', () => togglePenAll(false));
    document.getElementById('pen-collapse-all').addEventListener('click', () => togglePenAll(true));
  }

  function loadPenPage(idx) {
    const info = PEN_INDEX[idx];
    if (!info) return;
    currentPenIdx = idx;
    document.querySelectorAll('.pen-item').forEach((n, i) => n.classList.toggle('active', i === idx));
    document.getElementById('pen-meta').textContent = 'Loading ' + info.name + '…';
    document.getElementById('pen-detail').style.display = 'none';

    if (PEN_INLINE) {
      currentPenDoc = PEN_INLINE[idx];
      drawPenTree(currentPenDoc, info);
      return;
    }

    const existing = document.getElementById('pen-data-script');
    if (existing) existing.remove();
    const s = document.createElement('script');
    s.id = 'pen-data-script';
    s.src = info.relPath;
    s.onload = () => { currentPenDoc = window.PEN; drawPenTree(currentPenDoc, info); };
    s.onerror = () => {
      document.getElementById('pen-tree').innerHTML = '<div class="empty">load failed: ' + escapeHtml(info.relPath) + '</div>';
    };
    document.body.appendChild(s);
  }

  function drawPenTree(doc, info) {
    const tree = document.getElementById('pen-tree');
    if (!doc || !Array.isArray(doc.children)) {
      tree.innerHTML = '<div class="empty">Empty</div>';
      return;
    }
    document.getElementById('pen-meta').textContent =
      info.name + ' · ' + (info.nodeCount || 0) + ' nodes · v' + (doc.version || '?');
    const html = doc.children.map((c) => renderPenNode(c, 0)).join('');
    tree.innerHTML = html;
    tree.onclick = (e) => {
      const row = e.target.closest('.pen-row');
      if (!row) return;
      if (e.target.classList.contains('pen-toggle')) {
        const childrenEl = row.nextElementSibling;
        if (childrenEl && childrenEl.classList.contains('pen-children')) {
          childrenEl.classList.toggle('collapsed');
          e.target.textContent = childrenEl.classList.contains('collapsed') ? '▶' : '▼';
        }
      } else {
        const json = row.dataset.json;
        if (json) {
          document.getElementById('pen-detail').style.display = 'block';
          document.getElementById('pen-detail-pre').textContent = json;
        }
      }
    };
  }

  function renderPenNode(node, depth) {
    if (!node || typeof node !== 'object') return '';
    const kids = Array.isArray(node.children) ? node.children : null;
    const hasKids = kids && kids.length > 0;
    const collapsed = depth >= 2;
    const toggle = hasKids ? (collapsed ? '▶' : '▼') : '·';
    const toggleCls = hasKids ? 'pen-toggle' : 'pen-toggle empty';
    const type = (node.type || '?').toLowerCase();
    const enabled = node.enabled === false;

    const attrs = [];
    if (node.x !== undefined || node.y !== undefined) attrs.push('@(' + (node.x ?? 0) + ',' + (node.y ?? 0) + ')');
    if (node.width !== undefined || node.height !== undefined) attrs.push((fmtDim(node.width)) + '×' + fmtDim(node.height));
    if (node.layout && node.layout !== 'none') attrs.push('lay:' + node.layout);
    if (node.gap) attrs.push('gap:' + node.gap);
    if (node.padding !== undefined) attrs.push('pad:' + (Array.isArray(node.padding) ? '['+node.padding.join(',')+']' : node.padding));
    if (typeof node.fill === 'string') attrs.push(node.fill);

    const detail = JSON.stringify(node, (k, v) => {
      if (k === 'children' && Array.isArray(v)) return '[' + v.length + ' kids]';
      return v;
    }, 2);

    let html = '<div class="pen-node">';
    html += '<div class="pen-row" data-name="' + escapeHtml((node.name||'').toLowerCase()) + '" data-json="' + escapeAttrPen(detail) + '">';
    html += '<span class="' + toggleCls + '">' + toggle + '</span>';
    html += '<span class="pen-type ' + type + '">' + type + '</span>';
    html += '<span class="pen-name' + (enabled?' disabled':'') + '">' + escapeHtml(node.name || '(unnamed)') + '</span>';
    if (enabled) html += '<span class="pen-attr">[hidden]</span>';
    if (attrs.length > 0) html += '<span class="pen-attr">' + escapeHtml(attrs.join(' ')) + '</span>';
    html += '</div>';
    if (hasKids) {
      html += '<div class="pen-children' + (collapsed?' collapsed':'') + '">';
      for (const c of kids) html += renderPenNode(c, depth+1);
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function fmtDim(d) {
    if (d === undefined || d === null) return '?';
    if (typeof d === 'number') return Math.round(d * 100) / 100;
    return d;
  }

  function filterPenTree(query) {
    const q = (query || '').trim().toLowerCase();
    const tree = document.getElementById('pen-tree');
    if (!tree) return;
    const rows = tree.querySelectorAll('.pen-row');
    if (!q) { rows.forEach((r) => r.classList.remove('match')); return; }
    rows.forEach((r) => {
      const name = r.dataset.name || '';
      const match = name.includes(q);
      r.classList.toggle('match', match);
      if (match) {
        let p = r.parentElement;
        while (p && p !== tree) {
          if (p.classList.contains('pen-children')) {
            p.classList.remove('collapsed');
            const prev = p.previousElementSibling;
            if (prev && prev.classList.contains('pen-row')) {
              const tg = prev.querySelector('.pen-toggle');
              if (tg && !tg.classList.contains('empty')) tg.textContent = '▼';
            }
          }
          p = p.parentElement;
        }
      }
    });
  }

  function togglePenAll(collapse) {
    const tree = document.getElementById('pen-tree');
    if (!tree) return;
    tree.querySelectorAll('.pen-children').forEach((el) => el.classList.toggle('collapsed', collapse));
    tree.querySelectorAll('.pen-toggle').forEach((t) => {
      if (!t.classList.contains('empty')) t.textContent = collapse ? '▶' : '▼';
    });
  }

  function escapeAttrPen(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/1024/1024).toFixed(2) + ' MB';
  }

  // ── Init ───────────────────────────────────────────────────────────
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  renderOverview();
  renderPagesShell();
  renderTreeShell();
  renderAssets();
  renderSchema();
  renderVerify();
})();
`;
}

// ─── Single-file HTML 렌더러 ─────────────────────────────────────────────

export interface SingleFileInputs {
  overview: unknown;
  tree: unknown;
  schema: unknown;
  pages: unknown[];               // stripped page data, in PAGES_INDEX order
  pagesIndex: Array<{ index: number; name: string; nodeCount: number }>;
  images: Record<string, string>; // hash → "data:image/png;base64,…"
  vectors: Record<string, string>;// id → '<svg>...</svg>' (raw)
  thumbnailDataUri: string | null;
}

/**
 * 단일 .html 파일 — 모든 데이터·CSS·JS·이미지·SVG inline.
 * file:// 프로토콜 OK, 디렉토리 없이 한 파일만 공유 가능.
 */
export function renderSingleFileHtml(inputs: SingleFileInputs): string {
  const css = renderStyles();
  const app = renderApp();

  const dataScripts = [
    inlineGlobal('OVERVIEW', inputs.overview),
    inlineGlobal('NODES_FLAT', inputs.tree),
    inlineGlobal('SCHEMA', inputs.schema),
    inlineGlobal('PAGES_INDEX', inputs.pagesIndex),
    inlineGlobal('PAGES_INLINE', inputs.pages),
    inlineGlobal('IMAGES', inputs.images),
    inlineGlobal('VECTORS', inputs.vectors),
    inlineGlobal('THUMBNAIL', inputs.thumbnailDataUri),
  ].join('\n');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>figma-reverse · Dashboard (Single-file Bundle)</title>
<style>
${css}
</style>
</head>
<body>
<header class="header">
  <div class="brand">
    <span class="logo">📐</span>
    <span class="title">figma-reverse</span>
    <span class="subtitle" id="file-name">—</span>
  </div>
  <nav class="tabs">
    <button class="tab active" data-tab="overview">Overview</button>
    <button class="tab" data-tab="pages">Pages</button>
    <button class="tab" data-tab="tree">Tree</button>
    <button class="tab" data-tab="assets">Assets</button>
    <button class="tab" data-tab="schema">Schema</button>
    <button class="tab" data-tab="verify">Verify</button>
  </nav>
</header>
<main class="main">
  <section id="overview" class="panel active"></section>
  <section id="pages" class="panel"></section>
  <section id="tree" class="panel"></section>
  <section id="assets" class="panel"></section>
  <section id="schema" class="panel"></section>
  <section id="verify" class="panel"></section>
</main>
<script>
${dataScripts}
</script>
<script>
${app}
</script>
</body>
</html>
`;
}

/**
 * `window.<name> = JSON.parse('<escaped>')` 형태로 출력.
 * </script> 시퀀스를 분할해 HTML 파서가 끊지 않도록 한다.
 */
function inlineGlobal(name: string, data: unknown): string {
  if (data === null || data === undefined) {
    return `window.${name} = null;`;
  }
  const json = JSON.stringify(data);
  // </script> → <\/script> escape, 그리고 single-quote 이스케이프
  const escaped = json
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/<\/script>/gi, '<\\/script>');
  return `window.${name} = JSON.parse('${escaped}');`;
}

// ─── Round-trip HTML 렌더러 ──────────────────────────────────────────────

export interface RoundTripHtmlInputs extends SingleFileInputs {
  /** 임베드된 .fig (byte-level repacked) base64 */
  figBase64: string;
  figBytes: number;
  figSha256: string;
  figFileName: string;
}

/**
 * Round-trip HTML — single-file dashboard + 임베드된 .fig + 다운로드 버튼.
 */
export function renderRoundTripHtml(inputs: RoundTripHtmlInputs): string {
  const css = renderStyles();
  const app = renderApp();

  const dataScripts = [
    inlineGlobal('OVERVIEW', inputs.overview),
    inlineGlobal('NODES_FLAT', inputs.tree),
    inlineGlobal('SCHEMA', inputs.schema),
    inlineGlobal('PAGES_INDEX', inputs.pagesIndex),
    inlineGlobal('PAGES_INLINE', inputs.pages),
    inlineGlobal('IMAGES', inputs.images),
    inlineGlobal('VECTORS', inputs.vectors),
    inlineGlobal('THUMBNAIL', inputs.thumbnailDataUri),
    inlineGlobal('FIG_BUNDLE', {
      base64: inputs.figBase64,
      bytes: inputs.figBytes,
      sha256: inputs.figSha256,
      fileName: inputs.figFileName,
    }),
  ].join('\n');

  // 헤더에 round-trip 메타 표시 + 다운로드 버튼
  const downloadButtonScript = `
(function () {
  function setupDownload() {
    const btn = document.getElementById('btn-download-fig');
    if (!btn) return setTimeout(setupDownload, 100);
    btn.addEventListener('click', function () {
      const b = window.FIG_BUNDLE;
      if (!b || !b.base64) { alert('No .fig bundle available'); return; }
      const bin = atob(b.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = b.fileName || 'design.fig';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }
  setupDownload();
})();
`;

  // round-trip 메타를 Overview 탭에 자동 추가하는 패치
  const overviewPatchScript = `
(function () {
  function patch() {
    const ov = document.getElementById('overview');
    if (!ov || !window.FIG_BUNDLE) return setTimeout(patch, 100);
    const b = window.FIG_BUNDLE;
    const note = document.createElement('div');
    note.className = 'round-trip-banner';
    note.innerHTML =
      '<strong>🔁 Round-trip 가능</strong> ' +
      '<span style="color:var(--fg-dim)">이 HTML은 원본 .fig 바이트(<code>' + b.fileName +
      '</code>, ' + (b.bytes/1024/1024).toFixed(2) + ' MB, sha256: ' +
      b.sha256.slice(0,12) + '…)를 포함하고 있습니다. 헤더의 <strong>Download .fig</strong> 버튼으로 추출 → Figma에 import.</span>';
    ov.insertBefore(note, ov.firstChild);
  }
  patch();
})();
`;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>figma-reverse · Round-trip Bundle (${escapeAttr(inputs.figFileName)})</title>
<style>
${css}

/* Round-trip 전용 스타일 */
.round-trip-banner {
  background: linear-gradient(135deg, #0d99ff 0%, #6e56cf 100%);
  color: white;
  padding: 14px 18px;
  border-radius: 8px;
  margin-bottom: 20px;
  font-size: 13px;
  line-height: 1.6;
}
.round-trip-banner code {
  background: rgba(0,0,0,0.25);
  padding: 1px 6px;
  border-radius: 3px;
  font-family: var(--mono);
  font-size: 11px;
}
.round-trip-banner span { color: rgba(255,255,255,0.85) !important; }
.btn-download {
  background: var(--green);
  color: white;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  margin-left: auto;
}
.btn-download:hover { background: #15a86a; }
</style>
</head>
<body>
<header class="header">
  <div class="brand">
    <span class="logo">📐</span>
    <span class="title">figma-reverse</span>
    <span class="subtitle" id="file-name">—</span>
    <span style="color:var(--fg-dim);font-size:11px">· Round-trip Bundle</span>
  </div>
  <nav class="tabs">
    <button class="tab active" data-tab="overview">Overview</button>
    <button class="tab" data-tab="pages">Pages</button>
    <button class="tab" data-tab="tree">Tree</button>
    <button class="tab" data-tab="assets">Assets</button>
    <button class="tab" data-tab="schema">Schema</button>
    <button class="tab" data-tab="verify">Verify</button>
  </nav>
  <button id="btn-download-fig" class="btn-download" title="원본 .fig 다운로드 (${(inputs.figBytes/1024/1024).toFixed(2)} MB)">
    ⬇ Download .fig
  </button>
</header>
<main class="main">
  <section id="overview" class="panel active"></section>
  <section id="pages" class="panel"></section>
  <section id="tree" class="panel"></section>
  <section id="assets" class="panel"></section>
  <section id="schema" class="panel"></section>
  <section id="verify" class="panel"></section>
</main>
<script>
${dataScripts}
</script>
<script>
${app}
</script>
<script>
${downloadButtonScript}
${overviewPatchScript}
</script>
</body>
</html>
`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
