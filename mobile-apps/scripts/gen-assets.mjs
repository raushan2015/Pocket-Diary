/**
 * Generates the app icons/splash assets (icon.png, adaptive-icon.png,
 * adaptive-icon-bg.png, splash-icon.png, notification-icon.png, favicon.png)
 * with a dependency-free PNG encoder (zlib is built into Node).
 *
 * Run: npm run assets   (outputs are committed — rerun only to restyle)
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets');
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, no interlace)
// ---------------------------------------------------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Drawing helpers (analytic shapes, 3x supersampling)
// ---------------------------------------------------------------------------
const clamp01 = (t) => Math.min(1, Math.max(0, t));

/** Signed distance to a rounded rectangle. Negative = inside. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Renders `size`×`size` RGBA with 3×3 supersampling.
 * shader(x, y) → [r, g, b, a] (0..255 each; color is NOT premultiplied).
 */
function render(size, shader) {
  const S = 3;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S;
          const py = y + (sy + 0.5) / S;
          const c = shader(px, py);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      if (a === 0) {
        buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 0;
      } else {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
        buf[i + 3] = Math.round(a / n);
      }
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// The Pocket Diary glyph: a white note card with a folded corner, two text
// lines and an amber pin — matching the app palette.
// ---------------------------------------------------------------------------
const INDIGO_DARK = [30, 27, 75]; // #1E1B4B
const INDIGO = [79, 70, 229]; // #4F46E5
const WHITE = [255, 255, 255];
const AMBER = [245, 158, 11]; // #F59E0B
const LINE = [129, 140, 248]; // #818CF8
const FOLD = [203, 213, 225]; // #CBD5E1

/** Opaque icon: indigo gradient field + glyph. */
function fieldIcon(x, y) {
  let color = mix(INDIGO_DARK, INDIGO, clamp01(y / 1024));
  const half = 512;
  const cx = 512;
  const cy = 522;
  const dCard = sdRoundRect(x, y, cx, cy, half * 0.62, half * 0.74, half * 0.09);
  const fold = 0.38 * half;
  const inFoldCut = x > cx + half * 0.62 - fold && y < cy - half * 0.74 + fold;
  if (inFoldCut && y > cy - half * 0.74 + (x - (cx + half * 0.62 - fold))) {
    color = FOLD; // folded corner triangle
  } else if (dCard <= 0) {
    color = WHITE;
  }
  const lineW = [half * 0.66, half * 0.44];
  const lineY = [cy - half * 0.32, cy - half * 0.12];
  for (let i = 0; i < 2; i++) {
    if (
      sdRoundRect(x, y, cx - half * 0.62 + half * 0.08 + lineW[i] / 2, lineY[i], lineW[i] / 2, half * 0.045, half * 0.045) <= 0 &&
      dCard <= 0
    ) {
      color = LINE;
    }
  }
  if (Math.hypot(x - cx, y - (cy - half * 0.56)) <= half * 0.09) color = AMBER;
  return [color[0], color[1], color[2], 255];
}

/** Transparent-background glyph (adaptive foreground / splash / notification). */
function glyphOnly(cardScale) {
  return (x, y) => {
    const half = 512 * cardScale;
    const cx = 512;
    const cy = 512 + 10 * cardScale;
    const dCard = sdRoundRect(x, y, cx, cy, half * 0.62, half * 0.74, half * 0.09);
    const fold = 0.38 * half;
    const inFoldCut = x > cx + half * 0.62 - fold && y < cy - half * 0.74 + fold;
    const pin = Math.hypot(x - cx, y - (cy - half * 0.56)) <= half * 0.09;
    const inside = pin || (dCard <= 0 && !inFoldCut) || (inFoldCut && y > cy - half * 0.74 + (x - (cx + half * 0.62 - fold)));
    let color = pin ? AMBER : inFoldCut && !pin ? FOLD : WHITE;
    if (pin) color = AMBER;
    return [color[0], color[1], color[2], inside ? 255 : 0];
  };
}

function save(name, size, shader) {
  const png = encodePng(size, size, render(size, shader));
  writeFileSync(join(outDir, name), png);
  console.log(`ok  assets/${name} (${size}x${size}, ${(png.length / 1024).toFixed(1)} KiB)`);
}

save('icon.png', 1024, fieldIcon);
save('adaptive-icon-bg.png', 1024, () => [INDIGO[0], INDIGO[1], INDIGO[2], 255]);
save('adaptive-icon.png', 1024, glyphOnly(0.72));
save('splash-icon.png', 512, glyphOnly(0.8));
save('notification-icon.png', 96, glyphOnly(0.8));
save('favicon.png', 48, fieldIcon);
console.log('done');
