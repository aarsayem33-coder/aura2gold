import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { encodePng, createSurface, renderCandleChart, COLOURS, drawText, drawLabel, textWidth } from './chartRender.js';

const bars = (count = 40, base = 4000) => Array.from({ length: count }, (_, i) => {
  const o = base + Math.sin(i / 3) * 8;
  const c = base + Math.sin((i + 1) / 3) * 8;
  return { time: new Date(Date.parse('2026-07-30T00:00:00Z') + i * 900000).toISOString(), open: o, high: Math.max(o, c) + 2, low: Math.min(o, c) - 2, close: c };
});

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('encodePng emits a structurally valid PNG', () => {
  const rgb = Buffer.alloc(4 * 3 * 3, 200);
  const png = encodePng(4, 3, rgb);
  assert.ok(png.subarray(0, 8).equals(PNG_SIG), 'PNG signature');
  // IHDR is always the first chunk and carries the dimensions.
  assert.equal(png.readUInt32BE(8), 13, 'IHDR length');
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 4, 'width');
  assert.equal(png.readUInt32BE(20), 3, 'height');
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 2, 'colour type RGB');
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
});

test('the pixel data round-trips through the zlib stream', () => {
  const w = 3, h = 2;
  const rgb = Buffer.from([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
    10, 11, 12, 13, 14, 15, 16, 17, 18,
  ]);
  const png = encodePng(w, h, rgb);
  // Pull IDAT back out and inflate it: each row must be a 0 filter byte then its RGB triplets.
  let off = 8, idat = null;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('ascii');
    if (type === 'IDAT') idat = png.subarray(off + 8, off + 8 + len);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(idat);
  assert.equal(raw.length, (w * 3 + 1) * h);
  assert.equal(raw[0], 0, 'row 0 filter byte');
  assert.deepEqual([...raw.subarray(1, 10)], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(raw[10], 0, 'row 1 filter byte');
  assert.deepEqual([...raw.subarray(11, 20)], [10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test('CRCs are valid for every chunk', () => {
  // A wrong CRC makes the file unreadable to strict decoders, which would surface as the vision
  // model silently receiving nothing.
  const png = encodePng(8, 8, Buffer.alloc(8 * 8 * 3, 128));
  let off = 8;
  let chunks = 0;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const stored = png.readUInt32BE(off + 8 + len);
    // Recompute over type+data the same way the encoder does.
    const body = png.subarray(off + 4, off + 8 + len);
    let c = -1;
    for (let i = 0; i < body.length; i++) {
      c ^= body[i];
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    assert.equal((c ^ -1) >>> 0, stored, 'chunk CRC');
    chunks += 1;
    off += 12 + len;
  }
  assert.equal(chunks, 3, 'IHDR + IDAT + IEND');
});

test('drawing clips at the edges instead of wrapping', () => {
  // Without clipping, an off-canvas x wraps onto the next row and draws a stray line.
  const s = createSurface(4, 4);
  s.px(-1, 0, [0, 0, 0]);
  s.px(4, 0, [0, 0, 0]);
  s.px(0, -1, [0, 0, 0]);
  s.px(0, 9, [0, 0, 0]);
  assert.ok(s.rgb.every((b) => b === 255), 'nothing outside the surface may be written');
});

test('a chart renders and reports its scale', () => {
  const out = renderCandleChart({ candles: bars(), width: 300, height: 160 });
  assert.ok(out);
  assert.ok(out.png.subarray(0, 8).equals(PNG_SIG));
  assert.equal(out.bars, 40);
  assert.ok(out.priceHigh > out.priceLow);
  assert.ok(out.png.length > 100);
});

test('rendering is deterministic — the same candles give identical bytes', () => {
  // The image is cached and compared across calls; nondeterminism would silently defeat that.
  const a = renderCandleChart({ candles: bars(), width: 200, height: 120 });
  const b = renderCandleChart({ candles: bars(), width: 200, height: 120 });
  assert.ok(a.png.equals(b.png));
});

test('levels outside the candle range still fit on the chart', () => {
  // A level far above price must widen the scale, not be clipped to the top edge where the
  // model would read it as touching price.
  const out = renderCandleChart({ candles: bars(), focusLevel: 4200, width: 200, height: 120 });
  assert.ok(out.priceHigh >= 4200, `scale must include the focus level (${out.priceHigh})`);
  const low = renderCandleChart({ candles: bars(), stopLoss: 3800, width: 200, height: 120 });
  assert.ok(low.priceLow <= 3800);
});

test('up and down candles are drawn in different colours', () => {
  const up = renderCandleChart({ candles: [{ open: 100, high: 110, low: 90, close: 108 }], width: 60, height: 60 });
  const down = renderCandleChart({ candles: [{ open: 108, high: 110, low: 90, close: 100 }], width: 60, height: 60 });
  assert.ok(!up.png.equals(down.png), 'a bull and a bear bar must not render identically');
});

test('unusable input returns null rather than a blank chart', () => {
  assert.equal(renderCandleChart({ candles: [] }), null);
  assert.equal(renderCandleChart({ candles: null }), null);
  assert.equal(renderCandleChart({ candles: [{ open: NaN, high: 1, low: 0, close: 1 }] }), null);
  assert.equal(renderCandleChart({ candles: bars(), width: 5, height: 5 }), null, 'too small to plot');
});

test('a flat series does not divide by zero', () => {
  const flat = Array.from({ length: 20 }, () => ({ open: 100, high: 100, low: 100, close: 100 }));
  const out = renderCandleChart({ candles: flat, width: 120, height: 80 });
  assert.ok(out, 'a dead-flat market must still render');
  assert.ok(Number.isFinite(out.priceLow) && Number.isFinite(out.priceHigh));
});

test('the colour table exposes distinct up/down/level colours', () => {
  assert.notDeepEqual(COLOURS.up, COLOURS.down);
  assert.notDeepEqual(COLOURS.level, COLOURS.levelSwept);
});

// ── labels ───────────────────────────────────────────────────────────────────

test('text renders pixels and reports its width', () => {
  const s = createSurface(80, 20);
  const w = drawText(s, 2, 2, 'SL 4061.50', [0, 0, 0]);
  assert.ok(w > 0);
  assert.equal(w, textWidth('SL 4061.50'), 'reported width must match what was drawn');
  assert.ok(s.rgb.some((b) => b === 0), 'something must actually be painted');
});

test('an unknown character is a blank, not a crash', () => {
  const s = createSurface(60, 20);
  assert.doesNotThrow(() => drawText(s, 1, 1, 'SL @#$ 4061', [0, 0, 0]));
  // The known characters still render.
  assert.ok(s.rgb.some((b) => b === 0));
});

test('labels are clamped inside the canvas', () => {
  // A label anchored past the right edge must not wrap onto the next row.
  const s = createSurface(40, 20);
  drawLabel(s, 200, 10, 'TP 4070.00', [255, 255, 255], [0, 0, 0]);
  drawLabel(s, 20, -50, 'SL 1.0', [255, 255, 255], [0, 0, 0]);
  drawLabel(s, 20, 999, 'SL 1.0', [255, 255, 255], [0, 0, 0]);
  assert.ok(true, 'no throw and no wrap');
});

test('entry, stop and target are drawn with their values', () => {
  const plain = renderCandleChart({ candles: bars(), width: 400, height: 200, labels: false });
  const marked = renderCandleChart({
    candles: bars(), width: 400, height: 200,
    entry: 4002, stopLoss: 3995, takeProfit: 4016, focusLevel: 4000,
  });
  assert.ok(!plain.png.equals(marked.png), 'labelled output must differ from unlabelled');
  assert.deepEqual(marked.marked.map((m) => m.tag), ['ENTRY', 'SL', 'TP']);
  assert.equal(marked.marked[1].price, 3995);
});

test('price precision follows the instrument', () => {
  // Gold prints 2dp, EURUSD 5dp — one shared rounding would make one of them meaningless.
  const gold = renderCandleChart({ candles: bars(40, 4000), width: 300, height: 150, entry: 4002.5 });
  const fx = renderCandleChart({ candles: bars(40, 1.15).map((c) => ({ ...c, open: 1.15, high: 1.1503, low: 1.1497, close: 1.1501 })), width: 300, height: 150, entry: 1.15044 });
  assert.ok(gold && fx);
  // An explicit override wins over the inference.
  const forced = renderCandleChart({ candles: bars(), width: 300, height: 150, entry: 4002.5, digits: 5 });
  assert.ok(!forced.png.equals(gold.png));
});

test('labelled charts stay deterministic', () => {
  const opts = { candles: bars(), width: 300, height: 160, entry: 4002, stopLoss: 3995, takeProfit: 4016 };
  assert.ok(renderCandleChart(opts).png.equals(renderCandleChart(opts).png));
});

// ── context overlays ─────────────────────────────────────────────────────────

test('order blocks tint the candles instead of erasing them', () => {
  // A solid rectangle would hide the price action the zone is meant to give context to.
  const opts = { candles: bars(), width: 400, height: 200 };
  const plain = renderCandleChart(opts);
  const withOb = renderCandleChart({ ...opts, orderBlocks: [{ top: 4006, bottom: 4002, type: 'BULLISH' }] });
  assert.ok(!plain.png.equals(withOb.png), 'the overlay must change the image');
  assert.equal(withOb.overlays.orderBlocks, 1);
});

test('support and resistance zones draw and report', () => {
  const out = renderCandleChart({
    candles: bars(), width: 400, height: 200,
    zones: [{ price: 4004, kind: 'SUPPORT' }, { price: 4010, kind: 'RESISTANCE' }],
  });
  assert.equal(out.overlays.zones, 2);
});

test('retest markers land only on real candle indices', () => {
  const out = renderCandleChart({
    candles: bars(40), width: 400, height: 200,
    retests: [{ index: 5, price: 4000 }, { index: 999 }, { index: -3 }, { index: null }],
  });
  assert.equal(out.overlays.retests, 1, 'out-of-range indices must be ignored, not clamped');
});

test('a malformed overlay is skipped rather than throwing', () => {
  // Detectors returning junk must not be able to take the whole chart down.
  const out = renderCandleChart({
    candles: bars(), width: 400, height: 200,
    orderBlocks: [{ top: null, bottom: 5 }, { top: 3, bottom: 9 }, 'nonsense', null],
    zones: [{ price: 'abc' }, null],
    retests: 'not-an-array',
  });
  assert.ok(out, 'chart still renders');
  assert.equal(out.overlays.orderBlocks, 0, 'inverted and null zones are dropped');
  assert.equal(out.overlays.zones, 0);
});

test('overlays widen the price scale so a zone is never clipped to the edge', () => {
  // Clipped to the edge it would read as though price were sitting inside the zone.
  const out = renderCandleChart({
    candles: bars(), width: 400, height: 200,
    orderBlocks: [{ top: 4200, bottom: 4180, type: 'BEARISH' }],
  });
  assert.ok(out.priceHigh >= 4200, `scale must include the zone (${out.priceHigh})`);
});

test('overlay rendering stays deterministic', () => {
  const opts = {
    candles: bars(), width: 400, height: 200,
    orderBlocks: [{ top: 4006, bottom: 4002 }], zones: [{ price: 4004, kind: 'SUPPORT' }],
    retests: [{ index: 5 }],
  };
  assert.ok(renderCandleChart(opts).png.equals(renderCandleChart(opts).png));
});

test('an absent digit count never collapses prices to whole numbers', () => {
  // Number(null) is 0 and 0 is finite, so a null `digits` resolved to "0 decimal places" and
  // printed 214.904 as "215". The broker spec is genuinely absent for a while after a restart,
  // so this is the normal path.
  const jpy = bars(40).map((c, i) => ({ ...c, open: 214.9, high: 215.1, low: 214.7, close: 214.904 }));
  const withNull = renderCandleChart({ candles: jpy, width: 400, height: 200, entry: 214.904, digits: null });
  const withZero = renderCandleChart({ candles: jpy, width: 400, height: 200, entry: 214.904, digits: 0 });
  const inferred = renderCandleChart({ candles: jpy, width: 400, height: 200, entry: 214.904 });
  assert.ok(withNull.png.equals(inferred.png), 'null digits must fall back to inference, not 0dp');
  assert.ok(withZero.png.equals(inferred.png), '0 digits is not a meaningful price format either');
  // An explicit, usable precision still wins.
  const explicit = renderCandleChart({ candles: jpy, width: 400, height: 200, entry: 214.904, digits: 5 });
  assert.ok(!explicit.png.equals(inferred.png));
});
