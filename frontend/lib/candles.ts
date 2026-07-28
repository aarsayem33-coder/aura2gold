import type { Mt5Candle } from '../types';

/**
 * Merge fresh candles into the existing set, keyed by bar time (latest wins), sorted
 * ascending and capped. Lets the live SSE stream update a chart between REST polls without
 * duplicating or reordering bars — the charting library rejects unsorted data.
 */
export function mergeCandlesByTime(prev: Mt5Candle[], incoming: Mt5Candle[], cap = 600): Mt5Candle[] {
  const map = new Map<string, Mt5Candle>();
  for (const c of prev) map.set(c.time, c);
  for (const c of incoming) map.set(c.time, c);
  const merged = [...map.values()].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}
