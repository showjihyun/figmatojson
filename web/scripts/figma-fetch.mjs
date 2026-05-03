/**
 * Phase C — fetch figma.png for every node in _INVENTORY.json via the
 * Figma REST API.
 *
 *   node scripts/figma-fetch.mjs [<page-slug>...]
 *
 * Reads .env.local for FIGMA_TOKEN + FIGMA_FILE_KEY. Batches node ids in
 * groups of 50, calls /v1/images, downloads each returned URL into the
 * matching <page>/<component>/figma.png.
 *
 * Also fetches a per-page overview by rendering the page CANVAS itself
 * (page node id like "0:1") at scale 1. The page render gives the same
 * canvas-level image Figma uses for the file thumbnail — useful as the
 * page-overview reference.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const OUT_ROOT = resolve(REPO_ROOT, 'docs', 'audit-round11');
const INV_PATH = resolve(OUT_ROOT, '_INVENTORY.json');

// Figma's images endpoint times out around 50 ids when many are large
// nested frames (saw 60s+ on round-11 design-setting batch). 15 keeps
// each request well under the timeout and parallelism + retry handles
// throughput.
const BATCH_SIZE = 15;
const SCALE = 2;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 4000;

function loadEnv() {
  const env = {};
  const path = resolve(REPO_ROOT, '.env.local');
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function callImagesApi(token, fileKey, ids, scale) {
  const idsParam = ids.join(',');
  const url = `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(idsParam)}&format=png&scale=${scale}`;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'X-Figma-Token': token } });
      if (res.ok) {
        const json = await res.json();
        if (json.err) throw new Error(`Figma API err: ${json.err}`);
        return json.images || {};
      }
      const body = await res.text().catch(() => '');
      const isRetryable = res.status === 400 && body.includes('Render timeout')
        || res.status === 429
        || res.status >= 500;
      if (!isRetryable || attempt === MAX_RETRIES) {
        throw new Error(`Figma API ${res.status}: ${body.slice(0, 300)}`);
      }
      lastErr = new Error(`Figma API ${res.status}: ${body.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_RETRIES) throw e;
    }
    const wait = RETRY_BACKOFF_MS * attempt;
    console.log(`    [retry ${attempt}/${MAX_RETRIES}] ${lastErr.message} — waiting ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastErr;
}

async function downloadTo(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outPath, buf);
}

async function fetchAndSave(token, fileKey, jobs, scale, opts = {}) {
  const { skipExisting = true } = opts;
  // Filter out jobs whose outPath already exists — re-runs after a partial
  // failure should resume, not re-download.
  const todo = skipExisting ? jobs.filter((j) => !existsSync(j.outPath)) : jobs;
  const skipped = jobs.length - todo.length;
  if (skipped > 0) console.log(`  [skip-existing] ${skipped} already present`);
  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const ids = batch.map((j) => j.id);
    const t0 = Date.now();
    const images = await callImagesApi(token, fileKey, ids, scale);
    const dlPromises = batch.map(async (j) => {
      const url = images[j.id];
      if (!url) {
        console.log(`  [no-url] ${j.label}`);
        return;
      }
      mkdirSync(dirname(j.outPath), { recursive: true });
      await downloadTo(url, j.outPath);
      done++;
    });
    await Promise.all(dlPromises);
    console.log(`  batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length}): ${Date.now() - t0}ms — done ${done}/${todo.length}`);
  }
}

async function main() {
  const env = loadEnv();
  const token = env.FIGMA_TOKEN;
  const fileKey = env.FIGMA_FILE_KEY;
  if (!token || !fileKey) throw new Error('FIGMA_TOKEN / FIGMA_FILE_KEY missing in .env.local');
  if (!existsSync(INV_PATH)) throw new Error(`run build-audit-inventory.mjs first — no ${INV_PATH}`);
  const inv = JSON.parse(readFileSync(INV_PATH, 'utf-8'));

  const filterArgs = process.argv.slice(2);
  const pages = filterArgs.length > 0
    ? inv.pages.filter((p) => filterArgs.includes(p.slug))
    : inv.pages;
  if (pages.length === 0) {
    console.log(`No matching pages: ${filterArgs.join(', ')}`);
    return;
  }

  // Build job list: per-component figma.png (priority 1) + per-page overview.
  // Overview uses the page CANVAS id directly. The Figma API renders the
  // CANVAS as its full bbox.
  const componentJobs = [];
  const overviewJobs = [];
  let totalNodes = 0;
  for (const p of pages) {
    overviewJobs.push({
      id: `0:${p.index + 1}`,  // first canvas guid pattern; safer to use the
      // page's own id from the doc — but our inventory only stores children,
      // not the page guid. Look it up via separate fetch below if needed.
      outPath: resolve(OUT_ROOT, p.slug, '_overview', 'figma.png'),
      label: `${p.slug}/_overview`,
    });
    for (const c of p.children) {
      componentJobs.push({
        id: c.id,
        outPath: resolve(OUT_ROOT, p.slug, c.slug, 'figma.png'),
        label: `${p.slug}/${c.slug}`,
      });
      totalNodes++;
    }
  }
  console.log(`pages: ${pages.length}, components: ${totalNodes}, overview: ${overviewJobs.length}`);

  // Look up actual page ids from the file's document tree (need them for
  // overview captures). Calling /v1/files/<key> just to get the page guids.
  const fileRes = await fetch(`https://api.figma.com/v1/files/${fileKey}?depth=1`, {
    headers: { 'X-Figma-Token': token },
  });
  if (fileRes.ok) {
    const fjson = await fileRes.json();
    const pageNodes = fjson?.document?.children ?? [];
    const byName = new Map(pageNodes.map((n) => [n.name, n.id]));
    for (let i = 0; i < overviewJobs.length; i++) {
      const p = pages[i];
      const id = byName.get(p.name);
      if (id) overviewJobs[i].id = id;
    }
  } else {
    console.log(`[warn] could not fetch file metadata for page ids: ${fileRes.status}`);
  }

  console.log(`\n--- components (${componentJobs.length}) ---`);
  await fetchAndSave(token, fileKey, componentJobs, SCALE);

  console.log(`\n--- overviews (${overviewJobs.length}, scale=1) ---`);
  await fetchAndSave(token, fileKey, overviewJobs, 1);

  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
