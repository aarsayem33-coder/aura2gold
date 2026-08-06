// Server-side candlestick chart renderer — candles in, PNG buffer out.
//
// Exists so the vision model can LOOK at the market without anyone uploading a screenshot.
// The image is generated from the same candles the engine analysed, so what the model sees and
// what the maths saw are guaranteed to be the same data — a real screenshot of the UI could
// drift from it (different timeframe loaded, stale render, an indicator toggled off).
//
// Zero dependencies. PNG is a container around a zlib stream, and Node ships zlib, so encoding
// it directly avoids adding a native image module to a trading backend for the sake of drawing
// rectangles. Everything is pure: same candles in, byte-identical PNG out, which is what makes
// it testable.

import zlib from 'node:zlib';

const n = (v) => Number(v);
// Number(null) is 0 and 0 is finite, so a bare isFinite check treats an ABSENT price as a real
// one at zero — which drew a phantom line off the bottom of the chart and reported it as a
// marked level. Every optional price goes through this.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));

// ── PNG encoding ─────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode an RGB pixel buffer (w*h*3) as a PNG. */
export function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 2;      // colour type 2 = truecolour RGB
  // 10..12 = compression, filter, interlace — all 0

  // Each scanline is prefixed with its filter byte; 0 (None) keeps the encoder trivial and
  // compresses fine for flat-colour chart art.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── drawing surface ──────────────────────────────────────────────────────────

export function createSurface(width, height, bg = [255, 255, 255]) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = bg[0]; rgb[i * 3 + 1] = bg[1]; rgb[i * 3 + 2] = bg[2];
  }
  const px = (x, y, c) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;   // clip, never wrap
    const o = (yi * width + xi) * 3;
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  };
  const rect = (x0, y0, x1, y1, c) => {
    const xa = Math.round(Math.min(x0, x1)), xb = Math.round(Math.max(x0, x1));
    const ya = Math.round(Math.min(y0, y1)), yb = Math.round(Math.max(y0, y1));
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) px(x, y, c);
  };
  const hLine = (x0, x1, y, c, dash = 0) => {
    const xa = Math.round(Math.min(x0, x1)), xb = Math.round(Math.max(x0, x1));
    for (let x = xa; x <= xb; x++) {
      if (dash && Math.floor(x / dash) % 2) continue;
      px(x, y, c);
    }
  };
  /**
   * Alpha-blended fill, so a zone drawn UNDER the candles tints them instead of erasing them.
   * A solid rectangle would hide the very price action the zone is meant to give context to.
   */
  const fill = (x0, y0, x1, y1, c, alpha = 0.18) => {
    const a = Math.max(0, Math.min(1, Number(alpha)));
    const xa = Math.round(Math.min(x0, x1)), xb = Math.round(Math.max(x0, x1));
    const ya = Math.round(Math.min(y0, y1)), yb = Math.round(Math.max(y0, y1));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const o = (y * width + x) * 3;
        rgb[o] = Math.round(rgb[o] * (1 - a) + c[0] * a);
        rgb[o + 1] = Math.round(rgb[o + 1] * (1 - a) + c[1] * a);
        rgb[o + 2] = Math.round(rgb[o + 2] * (1 - a) + c[2] * a);
      }
    }
  };
  /** Dashed outline, so a zone's exact edges stay readable through the fill. */
  const box = (x0, y0, x1, y1, c, dash = 4) => {
    hLine(x0, x1, y0, c, dash); hLine(x0, x1, y1, c, dash);
    const ya = Math.round(Math.min(y0, y1)), yb = Math.round(Math.max(y0, y1));
    for (let y = ya; y <= yb; y++) {
      if (dash && Math.floor(y / dash) % 2) continue;
      px(x0, y, c); px(x1, y, c);
    }
  };
  return { width, height, rgb, px, rect, hLine, fill, box, toPng: () => encodePng(width, height, rgb) };
}

export const COLOURS = {
  bg: [255, 255, 255],
  grid: [238, 240, 245],
  up: [5, 150, 105],
  down: [225, 29, 72],
  wick: [100, 116, 139],
  level: [124, 58, 237],
  levelSwept: [203, 213, 225],
  zone: [237, 233, 254],
  target: [16, 185, 129],
  stop: [244, 63, 94],
  axis: [148, 163, 184],
  // Overlay palette. Order blocks are deliberately neutral grey: they are CONTEXT, and a
  // coloured zone competes with the bull/bear candles for the eye.
  orderBlock: [100, 116, 139],
  supportZone: [16, 185, 129],
  resistZone: [244, 63, 94],
  retest: [217, 119, 6],
};

/**
 * Render candles, key levels and an optional ticket to a PNG.
 *
 * `levels` are drawn as horizontal lines (dashed when already swept, so the model can see which
 * liquidity is still live). `focusLevel` is drawn heavier — it is the level the forecast is
 * about, and without it the model has to guess which line matters.
 */
export function renderCandleChart({
  candles,
  width = 900,
  height = 420,
  levels = [],
  focusLevel = null,
  entry = null,
  stopLoss = null,
  takeProfit = null,
  takeProfit2 = null,
  digits = null,
  labels = true,
  // Context overlays. Each is optional and each degrades to "draw nothing" rather than
  // throwing, so a detector returning junk cannot take the whole chart down.
  orderBlocks = [],   // [{ top, bottom, type }]      transparent grey rectangles
  zones = [],         // [{ price, kind, label }]     support / resistance bands
  retests = [],       // [{ index, price }]           marked candles
  // Right padding leaves room for the price chips; without it a label would sit on top of the
  // most recent candles, which are the ones the model most needs to read.
  padding = { top: 12, right: 96, bottom: 12, left: 8 },
}) {
  const cs = (Array.isArray(candles) ? candles : []).filter(
    (c) => [c?.open, c?.high, c?.low, c?.close].every((v) => Number.isFinite(n(v))),
  );
  if (!cs.length) return null;

  // The right gutter holds the price chips. On a narrow canvas a fixed 96px gutter would leave
  // no plot at all, so it shrinks to at most a third of the width — a cramped label beats no
  // chart, and the small sizes are only ever used in tests and thumbnails.
  const padRight = Math.min(padding.right, Math.floor(width / 3));
  const plotW = width - padding.left - padRight;
  const plotH = height - padding.top - padding.bottom;
  if (plotW < 10 || plotH < 10) return null;

  // Vertical scale spans the candles AND every drawn line, so a level off the top of the price
  // range is still visible rather than silently clipped to the edge.
  const obList = (Array.isArray(orderBlocks) ? orderBlocks : []).filter((z) => num(z?.top) !== null && num(z?.bottom) !== null);
  const zoneList = (Array.isArray(zones) ? zones : []).filter((z) => num(z?.price) !== null);
  // num(), not Number.isFinite: Number(null) is 0 and 0 is a VALID candle index, so a null
  // index would silently mark the first bar as a retest. Same trap as the phantom TP2 line.
  const retestList = (Array.isArray(retests) ? retests : []).filter((r) => num(r?.index) !== null);
  // Overlays join the scale too: a zone drawn off the top of the range would silently clip to
  // the edge and read as though price were sitting inside it.
  const extras = [focusLevel, entry, stopLoss, takeProfit, takeProfit2,
    ...levels.map((l) => l?.price),
    ...obList.flatMap((z) => [z.top, z.bottom]),
    ...zoneList.map((z) => z.price)]
    .map(num).filter((v) => v !== null && v > 0);
  let lo = Math.min(...cs.map((c) => n(c.low)), ...extras);
  let hi = Math.max(...cs.map((c) => n(c.high)), ...extras);
  if (!(hi > lo)) { hi = lo + 1; }
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;

  const s = createSurface(width, height, COLOURS.bg);
  const yOf = (price) => padding.top + plotH - ((n(price) - lo) / (hi - lo)) * plotH;
  const slot = plotW / cs.length;
  const bodyW = Math.max(1, Math.floor(slot * 0.6));

  for (let g = 1; g < 5; g++) s.hLine(padding.left, width - padRight, padding.top + (plotH * g) / 5, COLOURS.grid);

  // ── context overlays, drawn UNDER the candles ─────────────────────────────
  // Order blocks first: transparent grey rectangles spanning the plot, with a dashed edge so
  // the exact boundaries stay readable through the tint. Grey on purpose — these are context,
  // and a coloured fill would compete with the bull/bear candles the model must read.
  const drawn = { orderBlocks: 0, zones: 0, retests: 0 };
  for (const z of obList) {
    const top = num(z.top), bottom = num(z.bottom);
    if (top === null || bottom === null || !(top > bottom)) continue;
    const yTop = yOf(top), yBot = yOf(bottom);
    s.fill(padding.left, yTop, width - padRight, yBot, COLOURS.orderBlock, 0.16);
    s.box(padding.left, yTop, width - padRight, yBot, COLOURS.orderBlock, 4);
    drawn.orderBlocks += 1;
  }
  // Support / resistance bands: a line plus a faint band, coloured by side so the model can
  // tell which way each is expected to hold.
  for (const z of zoneList) {
    const p = num(z.price);
    if (p === null) continue;
    const col = String(z.kind || '').toUpperCase().startsWith('SUP') ? COLOURS.supportZone : COLOURS.resistZone;
    const y = yOf(p);
    s.fill(padding.left, y - 3, width - padRight, y + 3, col, 0.14);
    s.hLine(padding.left, width - padRight, y, col, 3);
    drawn.zones += 1;
  }

  // Levels behind the candles so price action stays readable on top.
  for (const l of levels) {
    const p = n(l.price);
    if (!Number.isFinite(p)) continue;
    s.hLine(padding.left, width - padRight, yOf(p), l.swept ? COLOURS.levelSwept : COLOURS.level, l.swept ? 6 : 0);
  }
  if (num(focusLevel) !== null) {
    const y = yOf(focusLevel);
    for (const dy of [-1, 0, 1]) s.hLine(padding.left, width - padRight, y + dy, COLOURS.level);
  }
  // Digits inferred from the price magnitude when not supplied, so gold shows 4065.00 and
  // EURUSD 1.15044 rather than both being rounded to the same meaningless precision.
  const mid = (lo + hi) / 2;
  // num(), not Number.isFinite: Number(null) is 0 and 0 is finite, so an ABSENT digit count
  // resolved to "0 decimal places" and every price on the chart rounded to a whole number —
  // 214.904 printed as "215", which is useless on a JPY pair. The broker spec is genuinely
  // absent for a while after a restart (it refreshes every ~20 EA polls), so this is the
  // normal path, not an edge case.
  const dpOverride = num(digits);
  const dp = dpOverride !== null && dpOverride > 0 ? dpOverride : (mid >= 1000 ? 2 : mid >= 10 ? 3 : 5);
  const fmt = (v) => n(v).toFixed(dp);

  const marks = [
    [num(entry), COLOURS.axis, 'ENTRY'],
    [num(stopLoss), COLOURS.stop, 'SL'],
    [num(takeProfit), COLOURS.target, 'TP'],
    [num(takeProfit2), COLOURS.target, 'TP2'],
  ].filter(([v]) => v !== null);
  for (const [v, c] of marks) s.hLine(padding.left, width - padRight, yOf(v), c, 4);

  cs.forEach((c, i) => {
    const cx = padding.left + i * slot + slot / 2;
    const up = n(c.close) >= n(c.open);
    const col = up ? COLOURS.up : COLOURS.down;
    // Wick first, body over it — a doji then still shows as a visible line.
    s.rect(cx, yOf(c.high), cx, yOf(c.low), COLOURS.wick);
    const yo = yOf(c.open), yc = yOf(c.close);
    const top = Math.min(yo, yc);
    const bot = Math.max(yo, yc);
    s.rect(cx - bodyW / 2, top, cx + bodyW / 2, Math.max(bot, top + 1), col);
  });

  // Retest markers OVER the candles: a caret under the bar that came back to the level, so the
  // model can see WHICH candle did the retesting rather than inferring it from the shape.
  for (const r of retestList) {
    const i = Math.round(n(r.index));
    if (i < 0 || i >= cs.length) continue;
    const cx = padding.left + i * slot + slot / 2;
    const y = yOf(num(r.price) ?? n(cs[i].low)) + 5;
    for (let k = 0; k < 4; k++) { s.px(cx - k, y + k, COLOURS.retest); s.px(cx + k, y + k, COLOURS.retest); }
    s.rect(cx, y, cx, y + 3, COLOURS.retest);
    drawn.retests += 1;
  }

  // Labels last: drawn over the candles so a value is never hidden behind price action.
  if (labels) {
    if (num(focusLevel) !== null) {
      drawLabel(s, width - 2, yOf(focusLevel), `LVL ${fmt(focusLevel)}`, [255, 255, 255], COLOURS.level, 1);
    }
    for (const [v, c, tag] of marks) drawLabel(s, width - 2, yOf(v), `${tag} ${fmt(v)}`, [255, 255, 255], c, 1);
    // Left-hand labels share one vertical budget. Without this the zone prices stack into an
    // unreadable smear the moment two levels sit within a few pixels of each other — which is
    // exactly when they matter most. A skipped label is better than an illegible one; the
    // dashed zone edge still shows WHERE it is, and the prompt text carries the number.
    const usedY = [];
    const roomFor = (y) => { if (usedY.some((u) => Math.abs(u - y) < 11)) return false; usedY.push(y); return true; };
    for (const z of zoneList) {
      const p = num(z.price);
      if (p === null) continue;
      const y = yOf(p);
      if (!roomFor(y)) continue;
      const sup = String(z.kind || '').toUpperCase().startsWith('SUP');
      drawLabel(s, padding.left + 52, y, `${sup ? 'S' : 'R'} ${fmt(p)}`, [255, 255, 255],
        sup ? COLOURS.supportZone : COLOURS.resistZone, 1);
    }
    // Order blocks are labelled at the TOP edge only. Labelling both edges doubled the number
    // of competing chips for no extra information — the rectangle already shows its depth.
    for (const z of obList) {
      const top = num(z.top);
      if (top === null || num(z.bottom) === null) continue;
      const y = yOf(top);
      if (!roomFor(y)) continue;
      drawLabel(s, padding.left + 104, y, `OB ${fmt(top)}`, [255, 255, 255], COLOURS.orderBlock, 1);
    }
  }

  return {
    png: s.toPng(), width, height, bars: cs.length, priceLow: lo, priceHigh: hi,
    marked: marks.map(([v, , tag]) => ({ tag, price: v })),
    overlays: drawn,
  };
}

// ── text ─────────────────────────────────────────────────────────────────────
//
// A 5x7 bitmap font, hand-encoded. The renderer has no font library by design (see the header:
// a PNG is a zlib stream, and pulling a native text-shaping dependency into a trading backend
// to draw "SL 4061.50" is a bad trade). Each glyph is 7 rows of 5 bits, MSB leftmost.
//
// Only the characters price labels actually need are defined. An undefined character renders
// as a blank rather than throwing, so an unexpected label degrades to a gap.
const GLYPHS = {
  '0': [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E], '1': [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
  '2': [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F], '3': [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
  '4': [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02], '5': [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
  '6': [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E], '7': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E], '9': [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
  '.': [0, 0, 0, 0, 0, 0x0C, 0x0C], '-': [0, 0, 0, 0x1F, 0, 0, 0], ':': [0, 0x0C, 0x0C, 0, 0x0C, 0x0C, 0],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  A: [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11], E: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F], N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  P: [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10], R: [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
  S: [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E], T: [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04], Y: [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
};
export const GLYPH_W = 5;
export const GLYPH_H = 7;

export function textWidth(text, scale = 1) {
  const n = String(text || '').length;
  return n ? (n * (GLYPH_W + 1) - 1) * scale : 0;
}

/** Draw uppercase text. Returns the width drawn so callers can lay labels out. */
export function drawText(surface, x, y, text, colour, scale = 1) {
  const s = String(text || '').toUpperCase();
  let cx = Math.round(x);
  for (const ch of s) {
    const g = GLYPHS[ch];
    if (g) {
      for (let row = 0; row < GLYPH_H; row++) {
        for (let col = 0; col < GLYPH_W; col++) {
          if (!(g[row] & (1 << (GLYPH_W - 1 - col)))) continue;
          // Scale by filling a block, so 2x stays crisp rather than blurring.
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) surface.px(cx + col * scale + dx, y + row * scale + dy, colour);
          }
        }
      }
    }
    cx += (GLYPH_W + 1) * scale;
  }
  // The advance includes a trailing inter-character gap; the DRAWN width does not. Returning
  // the advance made every label measure one space wider than it painted.
  return textWidth(s, scale);
}

/**
 * A label on a filled chip, so the value stays readable wherever the line crosses candles.
 * Anchored to the RIGHT edge and clamped inside the canvas.
 */
export function drawLabel(surface, xRight, yCentre, text, fg, bg, scale = 1) {
  const w = textWidth(text, scale);
  const h = GLYPH_H * scale;
  const padX = 2 * scale, padY = 1 * scale;
  const x1 = Math.min(surface.width - 1, Math.round(xRight));
  const x0 = Math.max(0, x1 - w - padX * 2);
  const y0 = Math.max(0, Math.min(surface.height - h - padY * 2 - 1, Math.round(yCentre) - Math.round(h / 2) - padY));
  surface.rect(x0, y0, x1, y0 + h + padY * 2, bg);
  drawText(surface, x0 + padX, y0 + padY, text, fg, scale);
}
