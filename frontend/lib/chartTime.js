// Bar-time arithmetic for the candlestick chart.
//
// Kept as plain JS in its own module so it can be unit-tested with `node --test`
// (chartTime.test.mjs) away from React and the charting library. Every "candles are not
// properly formed on this timeframe" bug lived in here.

/** Seconds per timeframe bucket (M5 -> 300). 0 = unknown / not a fixed width. */
export function timeframeSeconds(tf) {
  const t = String(tf || '').toUpperCase();
  if (/^MN\d*$/.test(t)) return 0;      // calendar months vary in length — never bucket
  const m = /^([MHDW])(\d+)?$/.exec(t);
  if (!m) return 0;
  const unit = m[1];
  const n = Number(m[2] || 1);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (unit === 'M') return n * 60;
  if (unit === 'H') return n * 3600;
  if (unit === 'D') return n * 86400;
  if (unit === 'W') return n * 604800;
  return 0;
}

/**
 * Where the broker's bars actually sit inside the timeframe grid, in seconds.
 *
 * Bucketing with `floor(sec / tfSec) * tfSec` assumes every bar opens on a UTC boundary.
 * That is false for most brokers and every higher timeframe: a UTC+3 server opens H4 bars
 * at 01:00/05:00/09:00 UTC, D1 at 21:00 UTC the previous day, and the epoch week begins on
 * a THURSDAY (1 Jan 1970), so W1 was being bucketed mid-week. Bars split across two buckets
 * or merged in pairs.
 *
 * The feed already sends correctly-formed bars, so measure the phase from the data: every
 * closed bar shares the same offset, making it the modal remainder. Intra-bar snapshots
 * scatter and cannot outvote them. A UTC-aligned feed yields 0.
 */
export function bucketPhase(secs, tfSec) {
  if (!(tfSec > 0) || !Array.isArray(secs) || secs.length === 0) return 0;
  const counts = new Map();
  for (const s of secs) {
    if (!Number.isFinite(s)) continue;
    const r = ((s % tfSec) + tfSec) % tfSec;
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  let phase = 0;
  let best = -1;
  for (const [r, n] of counts) {
    // Ties resolve to the earlier offset so the result is deterministic.
    if (n > best || (n === best && r < phase)) { phase = r; best = n; }
  }
  return phase;
}

/** Open time of the bucket containing `sec`, honouring the broker's phase. */
export function bucketStart(sec, tfSec, phase = 0) {
  if (!(tfSec > 0)) return sec;
  return Math.floor((sec - phase) / tfSec) * tfSec + phase;
}

/**
 * Synthetic live-forming bar for the current period, for feeds that only deliver CLOSED
 * bars. Flat at the last close, so the current slot exists and the axis advances without
 * inventing price movement. Returns null when a real bar already covers the period.
 */
export function formingBarFor(lastClosed, tfSec, phase = 0, nowMs = Date.now()) {
  if (!lastClosed || !(tfSec > 0)) return null;
  const close = Number(lastClosed.close);
  if (!Number.isFinite(close) || close <= 0) return null;
  const open = bucketStart(Math.floor(nowMs / 1000), tfSec, phase);
  if (lastClosed.time >= open) return null;
  // Extend by at most ONE period. Over a weekend or a feed outage the current period sits
  // many bars ahead of the last close; a flat bar there invents a candle across a gap that
  // never traded and drags the time axis into empty space.
  if (open - lastClosed.time > tfSec) return null;
  return { time: open, open: close, high: close, low: close, close, volume: 0 };
}

/** Whole seconds until the current bar closes, or null when the timeframe is unknown. */
export function secsToNextBar(tfSec, phase = 0, nowMs = Date.now()) {
  if (!(tfSec > 0)) return null;
  const nowSec = Math.floor(nowMs / 1000);
  return bucketStart(nowSec, tfSec, phase) + tfSec - nowSec;
}
