/**
 * Crop figma.png + ours.png pairs from docs/audit-round11/<group>/<slug>/
 * into vertical tiles (≤TILE_H tall, full width) so each tile fits in
 * the LLM context-image budget without truncation.
 *
 *   node scripts/crop-audit-tiles.mjs <slug-or-folder> [...]
 *
 * Examples:
 *   node scripts/crop-audit-tiles.mjs design-setting/pagenation-131_362
 *   node scripts/crop-audit-tiles.mjs design-setting/table-16_728 design-setting/tbody-16_521
 *
 * Output goes to <folder>/_tiles/{figma,ours}-NN.png so it's gitignorable.
 */
import sharp from 'sharp';
import { readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const AUDIT_ROOT = resolve(REPO_ROOT, 'docs', 'audit-round11');

const TILE_H = 1400;       // max tile height in source-pixel space
const MAX_W = 1800;        // downscale wider images to keep tiles small
const OVERLAP = 80;        // px overlap between consecutive tiles

async function cropOne(folderAbs) {
  const figma = join(folderAbs, 'figma.png');
  const ours = join(folderAbs, 'ours.png');
  if (!existsSync(figma) || !existsSync(ours)) {
    console.warn(`[skip] ${folderAbs} (missing figma.png or ours.png)`);
    return;
  }
  const tilesDir = join(folderAbs, '_tiles');
  if (existsSync(tilesDir)) rmSync(tilesDir, { recursive: true, force: true });
  mkdirSync(tilesDir, { recursive: true });

  for (const [name, src] of [['figma', figma], ['ours', ours]]) {
    const img = sharp(src);
    const meta = await img.metadata();
    let w = meta.width;
    let h = meta.height;
    let pipeline = sharp(src);
    if (w > MAX_W) {
      const scale = MAX_W / w;
      w = MAX_W;
      h = Math.round(h * scale);
      pipeline = pipeline.resize({ width: MAX_W });
    }
    const buf = await pipeline.png().toBuffer();
    const baseImg = sharp(buf);
    const baseMeta = await baseImg.metadata();
    w = baseMeta.width;
    h = baseMeta.height;

    if (h <= TILE_H) {
      await sharp(buf).toFile(join(tilesDir, `${name}-01.png`));
      console.log(`  [${name}] 1 tile (${w}x${h})`);
      continue;
    }

    const stride = TILE_H - OVERLAP;
    const tileCount = Math.ceil((h - OVERLAP) / stride);
    for (let i = 0; i < tileCount; i++) {
      const top = i * stride;
      const height = Math.min(TILE_H, h - top);
      const idx = String(i + 1).padStart(2, '0');
      await sharp(buf)
        .extract({ left: 0, top, width: w, height })
        .toFile(join(tilesDir, `${name}-${idx}.png`));
    }
    console.log(`  [${name}] ${tileCount} tiles (${w}x${h}, stride=${stride})`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node scripts/crop-audit-tiles.mjs <slug-or-folder> [...]');
    process.exit(1);
  }
  for (const arg of args) {
    const abs = resolve(AUDIT_ROOT, arg);
    if (!existsSync(abs)) {
      console.warn(`[skip] no such folder: ${abs}`);
      continue;
    }
    console.log(`[crop] ${arg}`);
    await cropOne(abs);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
