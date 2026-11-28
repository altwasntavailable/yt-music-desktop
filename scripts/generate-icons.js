'use strict';

/**
 * Generates the app/tray icons without any native image dependencies.
 * Renders simple vector shapes at 4x and downsamples for antialiasing.
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const ASSETS_DIR = path.join(ROOT, 'assets');
const THUMBAR_DIR = path.join(ASSETS_DIR, 'thumbar');
const OVERLAY_DIR = path.join(ASSETS_DIR, 'overlays');
const SUPERSAMPLE = 4;
const MEDIA_ICON_SIZE = 32;
const WHITE = [255, 255, 255, 1];
const COMPLETE_GREEN = [63, 185, 80, 1];
const ERROR_RED = [248, 81, 73, 1];

function insideRoundedRect(x, y, size, radius) {
  const dx = Math.max(Math.abs(x - size / 2) - (size / 2 - radius), 0);
  const dy = Math.max(Math.abs(y - size / 2) - (size / 2 - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

function insideCircle(x, y, cx, cy, radius) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = px - ax;
  const v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const inv = 1 / (dot00 * dot11 - dot01 * dot01);
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= 0 && v >= 0 && u + v <= 1;
}

function blendPixel(buffer, offset, r, g, b, a) {
  const alpha = a / 255;
  const existingAlpha = buffer[offset + 3] / 255;
  const outAlpha = alpha + existingAlpha * (1 - alpha);
  if (outAlpha <= 0) {
    buffer[offset] = 0;
    buffer[offset + 1] = 0;
    buffer[offset + 2] = 0;
    buffer[offset + 3] = 0;
    return;
  }
  buffer[offset] = Math.round((r * alpha + buffer[offset] * existingAlpha * (1 - alpha)) / outAlpha);
  buffer[offset + 1] = Math.round((g * alpha + buffer[offset + 1] * existingAlpha * (1 - alpha)) / outAlpha);
  buffer[offset + 2] = Math.round((b * alpha + buffer[offset + 2] * existingAlpha * (1 - alpha)) / outAlpha);
  buffer[offset + 3] = Math.round(outAlpha * 255);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideLine(x, y, ax, ay, bx, by, halfWidth) {
  return distanceToSegment(x, y, ax, ay, bx, by) <= halfWidth;
}

function renderGlyph(size, shader) {
  const S = size * SUPERSAMPLE;
  const buffer = Buffer.alloc(S * S * 4);

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const color = shader((x + 0.5) / S, (y + 0.5) / S);
      if (!color) continue;

      const alpha = Math.max(0, Math.min(1, Number(color[3])));
      if (alpha <= 0) continue;

      const offset = (y * S + x) * 4;
      blendPixel(buffer, offset, color[0], color[1], color[2], Math.round(alpha * 255));
    }
  }

  return { buffer, S };
}

/* White glyphs for the Windows taskbar thumbnail toolbar. Coordinates are
 * fractions of the canvas so the same shapes can be rendered at other sizes. */
function glyphPrevious(x, y) {
  const bar = x >= 0.22 && x <= 0.32 && y >= 0.2 && y <= 0.8;
  const triangle = insideTriangle(x, y, 0.72, 0.18, 0.72, 0.82, 0.32, 0.5);
  return bar || triangle ? WHITE : null;
}

function glyphNext(x, y) {
  const bar = x >= 0.68 && x <= 0.78 && y >= 0.2 && y <= 0.8;
  const triangle = insideTriangle(x, y, 0.28, 0.18, 0.28, 0.82, 0.68, 0.5);
  return bar || triangle ? WHITE : null;
}

function glyphPlay(x, y) {
  return insideTriangle(x, y, 0.32, 0.18, 0.32, 0.82, 0.82, 0.5) ? WHITE : null;
}

function glyphPause(x, y) {
  return (
    insideLine(x, y, 0.36, 0.2, 0.36, 0.8, 0.085)
    || insideLine(x, y, 0.64, 0.2, 0.64, 0.8, 0.085)
  ) ? WHITE : null;
}

function glyphDownload(x, y) {
  const stem = insideLine(x, y, 0.5, 0.15, 0.5, 0.58, 0.055);
  const arrow = insideTriangle(x, y, 0.25, 0.52, 0.75, 0.52, 0.5, 0.82);
  const tray = insideLine(x, y, 0.22, 0.89, 0.78, 0.89, 0.055);
  return stem || arrow || tray ? WHITE : null;
}

function glyphSettings(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.105) return null;

  const angle = Math.atan2(dy, dx);
  const outer = 0.355 + 0.055 * (Math.cos(angle * 8) * 0.5 + 0.5);
  return distance >= 0.22 && distance <= outer ? WHITE : null;
}

function overlayComplete(x, y) {
  const check = (
    insideLine(x, y, 0.27, 0.52, 0.44, 0.69, 0.07)
    || insideLine(x, y, 0.44, 0.69, 0.75, 0.33, 0.07)
  );
  if (check) return WHITE;
  return Math.hypot(x - 0.5, y - 0.5) <= 0.47 ? COMPLETE_GREEN : null;
}

function overlayError(x, y) {
  const mark = (
    insideLine(x, y, 0.5, 0.23, 0.5, 0.56, 0.065)
    || Math.hypot(x - 0.5, y - 0.72) <= 0.075
  );
  if (mark) return WHITE;
  return Math.hypot(x - 0.5, y - 0.5) <= 0.47 ? ERROR_RED : null;
}

function renderHighRes(size, transparentBackground) {
  const S = size * SUPERSAMPLE;
  const buffer = Buffer.alloc(S * S * 4);
  const center = S / 2;
  const bgRadius = S * 0.22;
  const circleRadius = S * (transparentBackground ? 0.46 : 0.365);
  const ringOuter = S * 0.425;
  const ringInner = S * 0.407;

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const offset = (y * S + x) * 4;

      if (!transparentBackground && insideRoundedRect(x, y, S, bgRadius)) {
        const t = y / S;
        const r = Math.round(32 - 29 * t);
        const g = Math.round(32 - 29 * t);
        const b = Math.round(34 - 31 * t);
        blendPixel(buffer, offset, r, g, b, 255);
      }

      if (!transparentBackground) {
        const dx = x - center;
        const dy = y - center;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance >= ringInner && distance <= ringOuter) {
          const edge = Math.min(distance - ringInner, ringOuter - distance) / 1.6;
          const alpha = Math.max(0, Math.min(1, edge)) * 0.34;
          blendPixel(buffer, offset, 255, 0, 0, Math.round(alpha * 255));
        }
      }

      if (insideCircle(x, y, center, center, circleRadius)) {
        blendPixel(buffer, offset, 255, 0, 0, 255);
      }

      const ax = S * 0.405;
      const ay = S * 0.325;
      const bx = S * 0.405;
      const by = S * 0.675;
      const cx = S * 0.665;
      const cy = S * 0.5;
      if (insideTriangle(x, y, ax, ay, bx, by, cx, cy)) {
        blendPixel(buffer, offset, 255, 255, 255, 255);
      }
    }
  }

  return { buffer, S };
}

function downsample(size, high) {
  const png = new PNG({ width: size, height: size });
  const { buffer, S } = high;
  const sampleCount = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = x * SUPERSAMPLE + sx;
          const py = y * SUPERSAMPLE + sy;
          const offset = (py * S + px) * 4;
          const alpha = buffer[offset + 3] / 255;
          r += buffer[offset] * alpha;
          g += buffer[offset + 1] * alpha;
          b += buffer[offset + 2] * alpha;
          a += alpha;
        }
      }

      const out = (y * size + x) * 4;
      const outAlpha = a / sampleCount;
      if (outAlpha > 0) {
        png.data[out] = Math.round(r / a);
        png.data[out + 1] = Math.round(g / a);
        png.data[out + 2] = Math.round(b / a);
        png.data[out + 3] = Math.round(outAlpha * 255);
      } else {
        png.data[out] = 0;
        png.data[out + 1] = 0;
        png.data[out + 2] = 0;
        png.data[out + 3] = 0;
      }
    }
  }

  return PNG.sync.write(png);
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + entries.length;

  images.forEach((image, index) => {
    const entry = index * 16;
    entries.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
    entries.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    entries.writeUInt8(0, entry + 2);
    entries.writeUInt8(0, entry + 3);
    entries.writeUInt16LE(1, entry + 4);
    entries.writeUInt16LE(32, entry + 6);
    entries.writeUInt32LE(image.data.length, entry + 8);
    entries.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, entries, ...images.map((image) => image.data)]);
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log('wrote', path.relative(ROOT, file), `${data.length} bytes`);
}

function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const appSizes = [16, 24, 32, 48, 64, 128, 256];
  const appImages = appSizes.map((size) => {
    const high = renderHighRes(size, false);
    return { size, data: downsample(size, high) };
  });

  write(path.join(BUILD_DIR, 'icon.ico'), buildIco(appImages));
  write(path.join(BUILD_DIR, 'icon.png'), appImages[appImages.length - 1].data);
  write(path.join(ASSETS_DIR, 'icon.png'), appImages[appImages.length - 1].data);

  const trayHigh = renderHighRes(32, true);
  write(path.join(ASSETS_DIR, 'tray.png'), downsample(32, trayHigh));

  const tray2xHigh = renderHighRes(64, true);
  write(path.join(ASSETS_DIR, 'tray@2x.png'), downsample(64, tray2xHigh));

  const glyphs = {
    previous: glyphPrevious,
    next: glyphNext,
    play: glyphPlay,
    pause: glyphPause,
    download: glyphDownload,
    settings: glyphSettings
  };
  for (const [name, shader] of Object.entries(glyphs)) {
    write(
      path.join(THUMBAR_DIR, `${name}.png`),
      downsample(MEDIA_ICON_SIZE, renderGlyph(MEDIA_ICON_SIZE, shader))
    );
  }

  const overlays = {
    complete: overlayComplete,
    error: overlayError
  };
  for (const [name, shader] of Object.entries(overlays)) {
    write(
      path.join(OVERLAY_DIR, `${name}.png`),
      downsample(MEDIA_ICON_SIZE, renderGlyph(MEDIA_ICON_SIZE, shader))
    );
  }
}

main();
