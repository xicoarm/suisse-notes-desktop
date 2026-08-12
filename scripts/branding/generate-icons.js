/**
 * Regenerates every branded raster asset from scripts/branding/logo.svg.
 *
 * The regeneration is pixel-faithful to the assets already in the repo: for
 * each target PNG the script measures the OLD file (canvas size, the bounding
 * box of the logo tile, transparent vs. solid background) and renders the SVG
 * at exactly that box with the same background treatment, so only the artwork
 * changes — never the layout. Round launcher icons keep their circular shape
 * because the old file's alpha channel is re-applied as a mask.
 *
 * Windows icon.ico and macOS icon.icns are packed from fresh SVG renders.
 *
 * One-shot dependencies (intentionally NOT in package.json):
 *   npm i --no-save @resvg/resvg-js pngjs png-to-ico @fiahfy/icns
 * Run:
 *   node scripts/branding/generate-icons.js
 *
 * NOTE: text is rendered with the system 'Segoe UI' font — run on Windows,
 * like the original assets were, or the wordmark metrics will differ.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { Resvg } = require('@resvg/resvg-js');
const pngToIcoMod = require('png-to-ico');
const pngToIco = pngToIcoMod.default || pngToIcoMod;
const { Icns, IcnsImage } = require('@fiahfy/icns');

const ROOT = path.resolve(__dirname, '..', '..');
const SVG = fs.readFileSync(path.join(__dirname, 'logo.svg'), 'utf8');

// The visible tile (rounded rect) spans 40..472 of the 512 viewBox; the rest
// is transparent margin. Needed to size renders so the *tile* matches a box.
const TILE_FRACTION = 432 / 512;

function renderSvg(widthPx) {
  const resvg = new Resvg(SVG, {
    fitTo: { mode: 'width', value: Math.max(8, Math.round(widthPx)) },
    font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' },
  });
  return PNG.sync.read(Buffer.from(resvg.render().asPng()));
}

function renderSvgPngBuffer(widthPx) {
  const resvg = new Resvg(SVG, {
    fitTo: { mode: 'width', value: widthPx },
    font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' },
  });
  return Buffer.from(resvg.render().asPng());
}

const px = (img, x, y) => (y * img.width + x) * 4;

function alphaBbox(img, threshold = 8) {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[px(img, x, y) + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function colorBbox(img, bg, threshold = 12) {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = px(img, x, y);
      const delta = Math.abs(img.data[i] - bg[0]) + Math.abs(img.data[i + 1] - bg[1]) + Math.abs(img.data[i + 2] - bg[2]);
      if (delta > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// source-over composite of src onto dst at (dx, dy)
function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const si = px(src, x, y);
      const di = px(dst, tx, ty);
      const sa = src.data[si + 3] / 255;
      if (sa === 0) continue;
      const da = dst.data[di + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        dst.data[di + c] = oa === 0 ? 0 :
          Math.round((src.data[si + c] * sa + dst.data[di + c] * da * (1 - sa)) / oa);
      }
      dst.data[di + 3] = Math.round(oa * 255);
    }
  }
}

/**
 * Rebuild one PNG asset: measure the old file, render the new tile into the
 * same box on the same background, optionally re-apply the old alpha mask
 * (keeps circular launcher masks and exact tile silhouettes).
 */
function rebuildAsset(file) {
  const old = PNG.sync.read(fs.readFileSync(file));
  const transparent = old.data[3] < 16; // corner pixel alpha
  const bg = [old.data[0], old.data[1], old.data[2]];

  const box = transparent ? alphaBbox(old) : colorBbox(old, bg);
  if (!box) throw new Error(`no logo tile found in ${file}`);

  // Render so the *visible tile* fits the measured box, then align the
  // render's own tile bbox onto the old one (robust against rounding).
  const tileSize = Math.max(box.w, box.h);
  const render = renderSvg(tileSize / TILE_FRACTION);
  const rBox = alphaBbox(render);

  const canvas = new PNG({ width: old.width, height: old.height });
  if (!transparent) {
    for (let i = 0; i < canvas.data.length; i += 4) {
      canvas.data[i] = bg[0]; canvas.data[i + 1] = bg[1]; canvas.data[i + 2] = bg[2]; canvas.data[i + 3] = 255;
    }
  }

  const crop = new PNG({ width: rBox.w, height: rBox.h });
  PNG.bitblt(render, crop, rBox.x, rBox.y, rBox.w, rBox.h, 0, 0);
  blit(canvas, crop, box.x, box.y);

  if (transparent) {
    // Old alpha is authoritative for the silhouette: identical for square
    // tiles, and it is what clips _round launcher icons to a circle.
    for (let i = 3; i < canvas.data.length; i += 4) {
      if (old.data[i] < canvas.data[i]) canvas.data[i] = old.data[i];
    }
  }

  fs.writeFileSync(file, PNG.sync.write(canvas));
  return { file: path.relative(ROOT, file), size: `${old.width}x${old.height}`, tile: `${box.w}x${box.h}@${box.x},${box.y}`, mode: transparent ? 'alpha' : `bg rgb(${bg})` };
}

async function main() {
  const targets = [];
  const add = (p) => { if (fs.existsSync(p)) targets.push(p); else console.warn(`SKIP (missing): ${p}`); };

  add(path.join(ROOT, 'src-electron/icons/icon.png'));
  add(path.join(ROOT, 'src/assets/logo.png'));
  add(path.join(ROOT, 'src-capacitor/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));

  const splashSet = path.join(ROOT, 'src-capacitor/ios/App/App/Assets.xcassets/Splash.imageset');
  for (const f of fs.readdirSync(splashSet)) if (f.endsWith('.png')) add(path.join(splashSet, f));

  const res = path.join(ROOT, 'src-capacitor/android/app/src/main/res');
  for (const dir of fs.readdirSync(res)) {
    const full = path.join(res, dir);
    if (dir.startsWith('mipmap-') && fs.statSync(full).isDirectory()) {
      for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
        const p = path.join(full, name);
        if (fs.existsSync(p)) targets.push(p);
        // ic_launcher_background.png is the plain gradient — no wordmark, untouched
      }
    }
    if (dir.startsWith('drawable') && fs.statSync(full).isDirectory()) {
      const p = path.join(full, 'splash.png');
      if (fs.existsSync(p)) targets.push(p);
    }
  }

  console.log(`Rebuilding ${targets.length} PNG assets…`);
  for (const t of targets) {
    const info = rebuildAsset(t);
    console.log(`  ${info.file}  (${info.size}, tile ${info.tile}, ${info.mode})`);
  }

  // Windows multi-size .ico (electron-builder needs >=256)
  const icoSizes = [256, 128, 64, 48, 32, 16];
  const ico = await pngToIco(icoSizes.map((s) => renderSvgPngBuffer(s)));
  fs.writeFileSync(path.join(ROOT, 'src-electron/icons/icon.ico'), ico);
  console.log(`  src-electron/icons/icon.ico  (${icoSizes.join(', ')})`);

  // macOS .icns
  const icns = new Icns();
  for (const [osType, size] of [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]) {
    icns.append(IcnsImage.fromPNG(renderSvgPngBuffer(size), osType));
  }
  fs.writeFileSync(path.join(ROOT, 'src-electron/icons/icon.icns'), icns.data);
  console.log('  src-electron/icons/icon.icns  (32…1024)');

  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
