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

// Platform-specific variants derived from the one source SVG:
//   SQUARE — corner radius stripped: for surfaces that apply their OWN mask
//            (iOS superellipse, Android circular launchers, Play listing).
//            Using the rounded art there leaves cut corners / octagons.
//   BG_SQUARE — gradient only, square: Android adaptive-icon background layer.
const SVG_SQUARE = SVG.replace(/\s+rx="\d+"\s+ry="\d+"/, '');
const SVG_BG_SQUARE = SVG_SQUARE.replace(/<path[^>]*\/>\s*/, '');

// Old brand's flat splash background (indigo #6366F1) → repaint with the new
// brand's mid gradient stop so splashes match the new tile.
const OLD_SPLASH_BG = [99, 102, 241];
const NEW_SPLASH_BG = [100, 61, 246]; // #643DF6

// Fraction of the SVG canvas the visible tile (rounded rect) occupies —
// measured from the artwork itself so any logo geometry works (the 2026-08
// "S" mark is full-bleed → 1.0; the earlier mic logo had margin → 432/512).
let TILE_FRACTION = 1;

function renderSvg(widthPx, svgSource = SVG) {
  const resvg = new Resvg(svgSource, {
    fitTo: { mode: 'width', value: Math.max(8, Math.round(widthPx)) },
    font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' },
  });
  return PNG.sync.read(Buffer.from(resvg.render().asPng()));
}

function renderSvgPngBuffer(widthPx, svgSource = SVG) {
  const resvg = new Resvg(svgSource, {
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
  const base = path.basename(file);
  const old = PNG.sync.read(fs.readFileSync(file));

  // --- Full-canvas surfaces: the platform applies its own mask/rounding, so
  // the art must fill the file edge-to-edge as a SQUARE (rounded corners
  // there would show as cut corners inside circular/superellipse masks).
  if (base === 'AppIcon-512@2x.png' || base === 'app-icon-512x512.png' || base === 'ic_launcher_background.png') {
    const svg = base === 'ic_launcher_background.png' ? SVG_BG_SQUARE : SVG_SQUARE;
    fs.writeFileSync(file, renderSvgPngBuffer(old.width, svg));
    return { file: path.relative(ROOT, file), size: `${old.width}x${old.height}`, tile: 'full-bleed square', mode: 'platform-masked' };
  }

  const transparent = old.data[3] < 16; // corner pixel alpha
  let bg = [old.data[0], old.data[1], old.data[2]];

  const box = transparent ? alphaBbox(old) : colorBbox(old, bg);
  if (!box) throw new Error(`no logo tile found in ${file}`);

  // Round launchers get the SQUARE variant — the old circular alpha mask
  // below cuts the silhouette; square art fills the whole circle (the rounded
  // art would only intersect it into an octagon).
  const round = base.includes('_round');

  // Render so the *visible tile* fits the measured box, then align the
  // render's own tile bbox onto the old one (robust against rounding).
  const tileSize = Math.max(box.w, box.h);
  const render = renderSvg(tileSize / TILE_FRACTION, round ? SVG_SQUARE : SVG);
  const rBox = alphaBbox(render);

  // Splash backgrounds: repaint the old brand's flat indigo with the new
  // brand color so the backdrop matches the tile. Night/white stay as-is.
  if (!transparent) {
    const d = Math.abs(bg[0] - OLD_SPLASH_BG[0]) + Math.abs(bg[1] - OLD_SPLASH_BG[1]) + Math.abs(bg[2] - OLD_SPLASH_BG[2]);
    if (d < 30) bg = NEW_SPLASH_BG;
  }

  const canvas = new PNG({ width: old.width, height: old.height });
  if (!transparent) {
    for (let i = 0; i < canvas.data.length; i += 4) {
      canvas.data[i] = bg[0]; canvas.data[i + 1] = bg[1]; canvas.data[i + 2] = bg[2]; canvas.data[i + 3] = 255;
    }
  }

  const crop = new PNG({ width: rBox.w, height: rBox.h });
  PNG.bitblt(render, crop, rBox.x, rBox.y, rBox.w, rBox.h, 0, 0);
  blit(canvas, crop, box.x, box.y);

  if (round) {
    // Synthesize a clean antialiased CIRCLE over the tile box. The old files'
    // alpha is NOT trustworthy here: a 2026-08 regeneration min()'d the circle
    // with rounded-square art and baked octagons into the repo.
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2, r = Math.max(box.w, box.h) / 2;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const cover = Math.min(1, Math.max(0, r - dist + 0.5)); // 1px feather
        const i = px(canvas, x, y) + 3;
        canvas.data[i] = Math.round(canvas.data[i] * cover);
      }
    }
  } else if (transparent) {
    // Old alpha is authoritative for the silhouette of square tiles.
    for (let i = 3; i < canvas.data.length; i += 4) {
      if (old.data[i] < canvas.data[i]) canvas.data[i] = old.data[i];
    }
  }

  fs.writeFileSync(file, PNG.sync.write(canvas));
  return { file: path.relative(ROOT, file), size: `${old.width}x${old.height}`, tile: `${box.w}x${box.h}@${box.x},${box.y}`, mode: transparent ? 'alpha' : `bg rgb(${bg})` };
}

// macOS icns convention: the tile floats on a transparent margin (Apple's
// template puts the tile at ~80% of the canvas). A full-bleed icns would look
// oversized next to every other Dock icon.
function macIcnsPngBuffer(size) {
  const canvas = new PNG({ width: size, height: size });
  const tile = Math.round(size * 0.82);
  const render = renderSvg(tile);
  const rBox = alphaBbox(render);
  const crop = new PNG({ width: rBox.w, height: rBox.h });
  PNG.bitblt(render, crop, rBox.x, rBox.y, rBox.w, rBox.h, 0, 0);
  blit(canvas, crop, Math.round((size - rBox.w) / 2), Math.round((size - rBox.h) / 2));
  return PNG.sync.write(canvas);
}

async function main() {
  // Measure the artwork's own tile fraction (bbox of visible pixels at 512px)
  // so full-bleed and margined logos both render at the right scale.
  {
    const probe = renderSvg(512);
    const b = alphaBbox(probe);
    TILE_FRACTION = Math.max(b.w, b.h) / probe.width;
    console.log(`Tile fraction (measured): ${TILE_FRACTION.toFixed(4)}`);
  }

  const targets = [];
  const add = (p) => { if (fs.existsSync(p)) targets.push(p); else console.warn(`SKIP (missing): ${p}`); };

  add(path.join(ROOT, 'src-electron/icons/icon.png'));
  add(path.join(ROOT, 'src/assets/logo.png'));
  add(path.join(ROOT, 'assets/icon.png'));
  add(path.join(ROOT, 'src-capacitor/assets/icon.png'));
  add(path.join(ROOT, 'play-store-assets/app-icon-512x512.png'));
  add(path.join(ROOT, 'src-capacitor/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));

  const splashSet = path.join(ROOT, 'src-capacitor/ios/App/App/Assets.xcassets/Splash.imageset');
  for (const f of fs.readdirSync(splashSet)) if (f.endsWith('.png')) add(path.join(splashSet, f));

  const res = path.join(ROOT, 'src-capacitor/android/app/src/main/res');
  for (const dir of fs.readdirSync(res)) {
    const full = path.join(res, dir);
    if (dir.startsWith('mipmap-') && fs.statSync(full).isDirectory()) {
      for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png', 'ic_launcher_background.png']) {
        const p = path.join(full, name);
        if (fs.existsSync(p)) targets.push(p);
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

  // macOS .icns (tile on transparent margin, per Apple's Dock convention)
  const icns = new Icns();
  for (const [osType, size] of [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]) {
    icns.append(IcnsImage.fromPNG(macIcnsPngBuffer(size), osType));
  }
  fs.writeFileSync(path.join(ROOT, 'src-electron/icons/icon.icns'), icns.data);
  console.log('  src-electron/icons/icon.icns  (32…1024)');

  // Web favicons — index.html links these (public/ is copied into every build)
  const pub = path.join(ROOT, 'public');
  const pubIcons = path.join(pub, 'icons');
  fs.mkdirSync(pubIcons, { recursive: true });
  for (const s of [16, 32, 96, 128]) {
    fs.writeFileSync(path.join(pubIcons, `favicon-${s}x${s}.png`), renderSvgPngBuffer(s));
  }
  fs.writeFileSync(path.join(pub, 'favicon.ico'), await pngToIco([16, 32, 48].map((s) => renderSvgPngBuffer(s))));
  console.log('  public/favicon.ico + public/icons/favicon-{16,32,96,128}.png');

  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
