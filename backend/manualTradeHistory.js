import { createHash } from 'node:crypto';

export const MANUAL_STRATEGY_ID = 'manual';

function clean(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

export function manualTradeId(account, broker, server, positionId) {
  const scope = `${clean(account, 32)}|${clean(broker, 128)}|${clean(server, 128)}`.toLowerCase();
  const scopeHash = createHash('sha256').update(scope).digest('hex').slice(0, 16);
  return `manual:${scopeHash}:${positionId}`;
}

export function normalizeManualTradeHistory(body) {
  const account = clean(body?.account, 32);
  const broker = clean(body?.broker, 128);
  const server = clean(body?.server, 128);
  const activatedAt = Number(body?.activatedAt);
  if (!account || !broker || !server || !Number.isFinite(activatedAt) || activatedAt <= 0) {
    return { error: 'account, broker, server and activatedAt are required', account, broker, server, deals: [] };
  }

  const seen = new Set();
  const deals = [];
  for (const deal of Array.isArray(body?.deals) ? body.deals : []) {
    const positionId = Number(deal?.positionId);
    const openTime = Number(deal?.openTime);
    const closeTime = Number(deal?.closeTime);
    if (!Number.isSafeInteger(positionId) || positionId <= 0
      || !Number.isFinite(openTime) || openTime < activatedAt
      || !Number.isFinite(closeTime) || closeTime < openTime) continue;
    const id = manualTradeId(account, broker, server, positionId);
    if (seen.has(id)) continue;
    const direction = String(deal.direction || '').toUpperCase();
    if (direction !== 'BUY' && direction !== 'SELL') continue;

    const numberOrNull = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    const normalized = {
      id,
      positionId,
      symbol: clean(deal.symbol, 32).toUpperCase() || '?',
      direction,
      lots: numberOrNull(deal.lots),
      openPrice: numberOrNull(deal.openPrice),
      closePrice: numberOrNull(deal.closePrice),
      profit: numberOrNull(deal.profit),
      openTime,
      closeTime,
      reason: clean(deal.reason, 24).toUpperCase() || 'MANUAL',
    };
    if (!(normalized.lots > 0) || normalized.openPrice === null || normalized.closePrice === null || normalized.profit === null) continue;
    seen.add(id);
    deals.push(normalized);
  }

  return { error: null, account, broker, server, activatedAt, deals };
}
