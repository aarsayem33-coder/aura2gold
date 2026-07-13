// Pure entry-fill locator shared by replay code. Existing LIMIT behavior is preserved;
// STOP and MARKET are opt-in for strategies that persist explicit order semantics.
export function findOrderFillIndex(candles, { isBuy, entry, orderType = 'MARKET', filledAtSignal = false, validUntilMs = NaN } = {}) {
  if (!Array.isArray(candles) || !candles.length) return -1;
  const type = String(orderType || 'MARKET').toUpperCase();
  if (type === 'MARKET' || filledAtSignal) return 0;
  if (!Number.isFinite(Number(entry)) || !['LIMIT', 'STOP'].includes(type)) return -1;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (Number.isFinite(validUntilMs) && Number(candle.timeMs) >= validUntilMs) break;
    const low = Number(candle.low), high = Number(candle.high);
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
    const hit = type === 'STOP'
      ? (isBuy ? high >= entry : low <= entry)
      : (isBuy ? low <= entry : high >= entry);
    if (hit) return i;
  }
  return -1;
}
