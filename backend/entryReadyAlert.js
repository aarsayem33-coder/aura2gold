import { findOrderFillIndex } from './orderFill.js';

const finite = (value) => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;

function candleTouches(candle, price) {
  const p = finite(price), high = finite(candle?.high), low = finite(candle?.low);
  return p != null && high != null && low != null && low <= p && p <= high;
}

// Conservative lifecycle check for a manual at-entry email. Unknown same-candle
// sequencing is rejected instead of being presented as a safe entry.
export function assessEntryReadiness(candles, {
  isBuy,
  entry,
  stop,
  tp1,
  orderType,
  validUntilMs = NaN,
  nowMs = Date.now(),
  maxFillAgeMs = 10 * 60000,
  maxDataAgeMs = 3 * 60000,
  maxFavorableR = 0.35,
  maxAdverseR = 0.2,
  stopHoldToleranceR = 0.08,
  spreadPointSize = 0,
} = {}) {
  const type = String(orderType || '').toUpperCase();
  const e = finite(entry), s = finite(stop), target1 = finite(tp1);
  if (!['LIMIT', 'STOP'].includes(type)) return { ready: false, terminal: true, code: 'UNSUPPORTED_ORDER' };
  const geometryValid = e != null && s != null && target1 != null
    && (isBuy ? s < e && e < target1 : s > e && e > target1);
  if (!geometryValid) return { ready: false, terminal: true, code: 'INVALID_PLAN' };

  const series = (Array.isArray(candles) ? candles : [])
    .map((candle) => ({ ...candle, timeMs: finite(candle.timeMs) ?? Date.parse(candle.time || '') }))
    .filter((candle) => Number.isFinite(candle.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);
  if (!series.length) return { ready: false, terminal: false, code: 'NO_DATA' };
  const latest = series[series.length - 1];
  const latestReceivedMs = Date.parse(latest.receivedAt || '');
  const latestFreshnessMs = Number.isFinite(latestReceivedMs) ? latestReceivedMs : latest.timeMs + 60000;
  if (nowMs - latestFreshnessMs > maxDataAgeMs) return { ready: false, terminal: false, code: 'STALE_FEED' };

  const spreadFor = (candle) => Math.max(0, finite(candle?.spread) || 0) * Math.max(0, finite(spreadPointSize) || 0);
  const askCandle = (candle) => {
    const spread = spreadFor(candle);
    const high = finite(candle.high), low = finite(candle.low), close = finite(candle.close);
    return {
      ...candle,
      high: high == null ? null : high + spread,
      low: low == null ? null : low + spread,
      close: close == null ? null : close + spread,
    };
  };
  // A bar is eligible only when its complete M1 interval ended before expiry.
  // Otherwise its high/low could include a touch that happened after validity ended.
  const fillCandidates = series
    .filter((candle) => !Number.isFinite(validUntilMs) || candle.timeMs + 60000 <= validUntilMs)
    .map((candle) => isBuy ? askCandle(candle) : candle);
  const candidateFillIdx = findOrderFillIndex(fillCandidates, { isBuy: !!isBuy, entry: e, orderType: type });
  if (candidateFillIdx < 0) {
    const expired = Number.isFinite(validUntilMs) && nowMs >= validUntilMs;
    return { ready: false, terminal: expired, code: expired ? 'EXPIRED_UNFILLED' : 'NO_FILL' };
  }
  const fillMs = fillCandidates[candidateFillIdx].timeMs;
  const fillIdx = series.findIndex((candle) => candle.timeMs === fillMs);

  const stopTouched = (candle) => candleTouches(isBuy ? candle : askCandle(candle), s);
  const tp1Touched = (candle) => candleTouches(isBuy ? candle : askCandle(candle), target1);
  for (let i = 0; i < fillIdx; i++) {
    if (stopTouched(series[i])) return { ready: false, terminal: true, code: 'STOP_BEFORE_ENTRY', fillIdx };
    if (tp1Touched(series[i])) return { ready: false, terminal: true, code: 'TP1_BEFORE_ENTRY', fillIdx };
  }

  const fillCandle = series[fillIdx];
  if (stopTouched(fillCandle)) return { ready: false, terminal: true, code: 'AMBIGUOUS_FILL_STOP', fillIdx };
  if (tp1Touched(fillCandle)) return { ready: false, terminal: true, code: 'TP1_ALREADY_HIT', fillIdx };
  for (let i = fillIdx + 1; i < series.length; i++) {
    if (stopTouched(series[i])) return { ready: false, terminal: true, code: 'STOP_AFTER_FILL', fillIdx };
    if (tp1Touched(series[i])) return { ready: false, terminal: true, code: 'TP1_ALREADY_HIT', fillIdx };
  }

  const fillAgeMs = nowMs - fillMs;
  if (fillAgeMs < -60000 || fillAgeMs > maxFillAgeMs) return { ready: false, terminal: true, code: 'STALE_FILL', fillIdx, fillMs };

  const spreadPrice = spreadFor(latest);
  const currentPrice = finite(isBuy ? askCandle(latest).close : latest.close);
  if (currentPrice == null) return { ready: false, terminal: false, code: 'NO_CURRENT_PRICE', fillIdx, fillMs };
  const risk = Math.abs(e - s);
  const sign = isBuy ? 1 : -1;
  const progressR = sign * (currentPrice - e) / risk;
  if (type === 'STOP' && progressR < -stopHoldToleranceR) {
    return { ready: false, terminal: true, code: 'TRIGGER_FAILED', fillIdx, fillMs, currentPrice, progressR };
  }
  if (progressR > maxFavorableR) return { ready: false, terminal: true, code: 'CHASED', fillIdx, fillMs, currentPrice, progressR };
  if (progressR < -maxAdverseR) return { ready: false, terminal: true, code: 'MOVED_AGAINST', fillIdx, fillMs, currentPrice, progressR };

  const adverseAllowance = type === 'STOP' ? stopHoldToleranceR : maxAdverseR;
  const zoneLow = isBuy ? e - adverseAllowance * risk : e - maxFavorableR * risk;
  const zoneHigh = isBuy ? e + maxFavorableR * risk : e + adverseAllowance * risk;
  return {
    ready: true,
    terminal: false,
    code: 'READY',
    fillIdx,
    fillMs,
    fillAgeMs: Math.max(0, fillAgeMs),
    currentPrice,
    progressR,
    risk,
    spreadPrice,
    zoneLow,
    zoneHigh,
    fillCandle,
    latestCandle: latest,
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function priceDigits(symbol) {
  const value = String(symbol || '').toUpperCase();
  return /XAU|GOLD|XAG|US30|NAS|SPX|USTEC|US100|US500/.test(value) ? 2 : /JPY/.test(value) ? 3 : 5;
}

function formatPrice(value, symbol) {
  const number = finite(value);
  return number == null ? 'n/a' : number.toFixed(priceDigits(symbol));
}

function money(value) {
  const number = finite(value);
  return number == null ? 'n/a' : `$${number.toFixed(2)}`;
}

function bdtStamp(ms) {
  return Number.isFinite(Number(ms))
    ? new Date(Number(ms) + 6 * 3600 * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' BD'
    : 'n/a';
}

function trendLabel(trend, expected) {
  const value = String(trend || 'UNKNOWN').toUpperCase();
  if (value === expected) return `${value} - aligned`;
  if (value === 'NEUTRAL' || value === 'UNKNOWN') return `${value} - not opposing`;
  return `${value} - opposing`;
}

export function buildEntryReadyEmail({
  row,
  strategyName,
  orderType,
  assessment,
  sizing = null,
  h4Trend = 'UNKNOWN',
  h1Trend = 'UNKNOWN',
  session = null,
  sentMs = Date.now(),
  isTest = false,
} = {}) {
  const symbol = String(row?.symbol || '').toUpperCase();
  const timeframe = String(row?.timeframe || '').toUpperCase();
  const direction = /BUY/.test(String(row?.direction).toUpperCase()) ? 'BUY' : 'SELL';
  const buy = direction === 'BUY';
  const expectedTrend = buy ? 'BULLISH' : 'BEARISH';
  const grade = String(row?.effective_grade || row?.latest_grade || row?.grade || '');
  const score = Math.round(finite(row?.effective_score ?? row?.latest_score ?? row?.score) || 0);
  const entry = formatPrice(row?.entry_price, symbol);
  const stop = formatPrice(row?.stop_loss, symbol);
  const tp1 = formatPrice(row?.take_profit_1, symbol);
  const tp2 = formatPrice(row?.take_profit_2, symbol);
  const tp3 = formatPrice(row?.take_profit_3, symbol);
  const current = formatPrice(assessment?.currentPrice, symbol);
  const spread = finite(assessment?.spreadPrice);
  const spreadText = spread != null && spread > 0 ? formatPrice(spread, symbol) : 'not supplied';
  const zoneLow = formatPrice(assessment?.zoneLow, symbol);
  const zoneHigh = formatPrice(assessment?.zoneHigh, symbol);
  const rr = finite(row?.risk_reward);
  const fillAgeMin = Math.max(0, Math.round((finite(assessment?.fillAgeMs) || 0) / 6000) / 10);
  const validityMs = row?.valid_until ? Date.parse(row.valid_until) : NaN;
  const signalMs = row?.signal_time ? Date.parse(row.signal_time) : NaN;
  const reason = String(row?.reason || 'The original strategy conditions qualified and the planned entry has now filled.');
  const directionColor = buy ? '#047857' : '#b91c1c';
  const directionBg = buy ? '#ecfdf5' : '#fef2f2';
  const holdRule = String(orderType).toUpperCase() === 'STOP'
    ? `The breakout must continue holding ${buy ? 'above' : 'below'} ${entry}.`
    : `Price must remain close to the planned limit entry ${entry}.`;
  const sessionText = session?.label ? `${session.label}${session.bdRange ? ` (${session.bdRange})` : ''}` : 'n/a';
  const lots = sizing?.suggestedLots != null ? `${sizing.suggestedLots} lots` : 'n/a';
  const conditions = [
    `${grade} setup, score ${score}/100`,
    `${String(orderType).toUpperCase()} entry filled inside its validity window`,
    `Fresh M1 confirmation (${fillAgeMin} min old)`,
    'Stop was not touched before or after the fill',
    'TP1 has not already been reached',
    `Spread-adjusted execution price remains inside ${zoneLow} - ${zoneHigh}`,
    `H4 is ${trendLabel(h4Trend, expectedTrend)}`,
  ];
  const ignoreRules = [
    `Price is no longer inside ${zoneLow} - ${zoneHigh}. Do not chase it.`,
    `Price touches or crosses the stop ${stop} before you enter.`,
    holdRule,
    `Your spread or slippage prevents entry near ${entry}.`,
    `You cannot place the stop immediately or the suggested ${lots} exceeds your risk limit.`,
  ];
  const management = [
    `Enter only near ${entry}; current verified price was ${current}.`,
    `Attach the stop immediately at ${stop}. Never widen it.`,
    `TP1 ${tp1}: take the first partial and protect the remaining position at breakeven when your strategy requires it.`,
    `TP2 ${tp2}; TP3 ${tp3}. Do not move targets farther after entry.`,
  ];

  const subject = `${isTest ? '[TEST PREVIEW] ' : ''}[ENTRY READY ${grade}] ${symbol} ${timeframe} | ${direction} NOW | ${score}/100 | ${strategyName}`.slice(0, 180);
  const text = [
    ...(isTest ? ['TEST PREVIEW - SAMPLE VALUES ONLY - DO NOT TRADE', ''] : []),
    `AURA GOLD - ENTRY WINDOW OPEN - ${direction} ${symbol} ${timeframe}`,
    `${strategyName} | ${score}/100 ${grade} | ${String(orderType).toUpperCase()} filled ${fillAgeMin} min ago`,
    '',
    `ACTION: Enter only while price remains inside ${zoneLow} - ${zoneHigh}. Current ${current}.`,
    `Entry ${entry} | Current ${current} | Spread ${spreadText} | Stop ${stop} | TP1 ${tp1} | TP2 ${tp2} | TP3 ${tp3} | R:R ${rr != null ? `1:${rr}` : 'n/a'}`,
    `Volume ${lots} | Risk ${sizing?.riskPercent != null ? `${sizing.riskPercent}% = ${money(sizing.riskAmount)}` : 'n/a'} | Max loss ${money(sizing?.lossAtStop)}`,
    '',
    `CONDITIONS PASSED (${conditions.length}/${conditions.length})`,
    ...conditions.map((item) => `[PASS] ${item}`),
    '',
    'WHY THIS SETUP QUALIFIED',
    reason,
    '',
    'EXECUTION PLAN',
    ...management.map((item, index) => `${index + 1}. ${item}`),
    '',
    'IGNORE THIS ALERT IF',
    ...ignoreRules.map((item) => `- ${item}`),
    '',
    `Context: H4 ${trendLabel(h4Trend, expectedTrend)} | H1 ${trendLabel(h1Trend, expectedTrend)} | ${sessionText}`,
    `Signal ${bdtStamp(signalMs)} | Entry filled ${bdtStamp(assessment?.fillMs)} | Email ${bdtStamp(sentMs)} | Valid until ${bdtStamp(validityMs)}`,
    'This is a one-time Strategy Lab at-entry notice. It is advisory, not a guarantee or financial advice.',
  ].join('\n');

  const conditionRows = conditions.map((item) => `<tr><td style="padding:5px 0;width:54px;color:#047857;font-size:11px;font-weight:800">PASS</td><td style="padding:5px 0;color:#334155;font-size:12px">${escapeHtml(item)}</td></tr>`).join('');
  const planRows = management.map((item, index) => `<tr><td style="vertical-align:top;padding:5px 8px 5px 0;color:${directionColor};font-size:12px;font-weight:800">${index + 1}</td><td style="padding:5px 0;color:#334155;font-size:12px;line-height:1.45">${escapeHtml(item)}</td></tr>`).join('');
  const ignoreRows = ignoreRules.map((item) => `<li style="margin:5px 0">${escapeHtml(item)}</li>`).join('');
  const targetRow = (label, price, profit) => `<tr><td style="padding:7px 10px;color:#64748b;border-bottom:1px solid #e2e8f0">${label}</td><td style="padding:7px 10px;text-align:right;color:#047857;font-weight:700;border-bottom:1px solid #e2e8f0">${price}${profit != null ? ` <span style="color:#94a3b8;font-weight:400">+${money(profit)}</span>` : ''}</td></tr>`;
  const testBanner = isTest ? '<tr><td style="padding:9px 14px;background:#fef3c7;border-bottom:1px solid #f59e0b;text-align:center;color:#92400e;font-size:11px;font-weight:900;letter-spacing:.08em">TEST PREVIEW - SAMPLE VALUES ONLY - DO NOT TRADE</td></tr>' : '';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#e9eef5;font-family:Arial,sans-serif;color:#0f172a">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">${isTest ? 'Test preview only. ' : ''}${escapeHtml(direction)} entry is live at ${entry}. Conditions passed; ignore if price leaves ${zoneLow}-${zoneHigh}.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#e9eef5"><tr><td align="center" style="padding:20px 10px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,.12)">
        <tr><td style="padding:18px 22px;background:#0b1220;border-bottom:3px solid #d9a441">
          <table role="presentation" width="100%"><tr><td><div style="font-size:10px;letter-spacing:.18em;color:#d9a441;font-weight:800">AURA GOLD ALERTS</div><div style="margin-top:4px;color:#ffffff;font-size:19px;font-weight:800">Entry window is open</div></td><td align="right"><span style="display:inline-block;padding:6px 9px;border:1px solid #475569;border-radius:999px;color:#cbd5e1;font-size:10px;font-weight:700">M1 VERIFIED</span></td></tr></table>
        </td></tr>
        ${testBanner}
        <tr><td style="padding:20px 22px">
          <table role="presentation" width="100%" style="background:${directionBg};border:1px solid ${directionColor};border-radius:10px"><tr><td style="padding:16px">
            <div style="font-size:11px;letter-spacing:.13em;color:${directionColor};font-weight:800">${escapeHtml(direction)} NOW - ${escapeHtml(symbol)} ${escapeHtml(timeframe)}</div>
            <div style="margin-top:5px;font-size:25px;color:${directionColor};font-weight:900">Entry ${entry}</div>
            <div style="margin-top:5px;font-size:12px;color:#334155">Current ${current} - acceptable zone <b>${zoneLow} - ${zoneHigh}</b> - spread ${spreadText} - fill ${fillAgeMin} min ago</div>
          </td></tr></table>

          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:12px"><tr>
            <td width="33%" style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px 0 0 8px"><div style="font-size:9px;color:#64748b;letter-spacing:.1em">QUALITY</div><div style="margin-top:3px;font-size:16px;font-weight:800">${score}/100 ${escapeHtml(grade)}</div></td>
            <td width="33%" style="padding:10px;background:#f8fafc;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0"><div style="font-size:9px;color:#64748b;letter-spacing:.1em">ORDER</div><div style="margin-top:3px;font-size:16px;font-weight:800">${escapeHtml(String(orderType).toUpperCase())}</div></td>
            <td width="34%" style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:0 8px 8px 0"><div style="font-size:9px;color:#64748b;letter-spacing:.1em">RISK / REWARD</div><div style="margin-top:3px;font-size:16px;font-weight:800">${rr != null ? `1:${rr}` : 'n/a'}</div></td>
          </tr></table>

          <div style="margin-top:16px;font-size:10px;letter-spacing:.12em;color:#64748b;font-weight:800">TRADE TICKET</div>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:6px;border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;border-spacing:0;font-size:12px">
            <tr><td style="padding:7px 10px;color:#64748b;border-bottom:1px solid #e2e8f0">Entry / current</td><td style="padding:7px 10px;text-align:right;font-weight:800;border-bottom:1px solid #e2e8f0">${entry} / ${current}</td></tr>
            <tr><td style="padding:7px 10px;color:#64748b;border-bottom:1px solid #e2e8f0">Stop loss</td><td style="padding:7px 10px;text-align:right;color:#b91c1c;font-weight:800;border-bottom:1px solid #e2e8f0">${stop} <span style="color:#94a3b8;font-weight:400">${sizing?.stopPips != null ? `(${sizing.stopPips} pips)` : ''}</span></td></tr>
            ${targetRow('TP1 - protect trade', tp1, sizing?.profitAtTp1)}
            ${targetRow('TP2 - scale', tp2, sizing?.profitAtTp2)}
            ${targetRow('TP3 - final target', tp3, sizing?.profitAtTp3)}
            <tr><td style="padding:7px 10px;color:#64748b">Position size</td><td style="padding:7px 10px;text-align:right;font-weight:800">${escapeHtml(lots)} <span style="color:#94a3b8;font-weight:400">risk ${sizing?.riskPercent != null ? `${sizing.riskPercent}% / ${money(sizing.riskAmount)}` : 'n/a'} - max loss ${money(sizing?.lossAtStop)}</span></td></tr>
          </table>

          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px"><tr><td style="padding:12px 14px">
            <div style="font-size:10px;letter-spacing:.12em;color:#047857;font-weight:800">CONDITIONS PASSED - ${conditions.length}/${conditions.length}</div><table role="presentation" width="100%" style="margin-top:5px">${conditionRows}</table>
          </td></tr></table>

          <div style="margin-top:14px;padding:12px 14px;background:#f8fafc;border-left:3px solid #7c3aed;border-radius:6px">
            <div style="font-size:10px;letter-spacing:.12em;color:#7c3aed;font-weight:800">WHY THIS SETUP QUALIFIED</div><div style="margin-top:5px;font-size:12px;line-height:1.55;color:#334155">${escapeHtml(reason)}</div>
          </div>

          <div style="margin-top:14px;font-size:10px;letter-spacing:.12em;color:#64748b;font-weight:800">EXECUTION PLAN</div><table role="presentation" width="100%" style="margin-top:4px">${planRows}</table>

          <div style="margin-top:14px;padding:12px 14px;background:#fff7ed;border:1px solid #fdba74;border-radius:8px">
            <div style="font-size:10px;letter-spacing:.12em;color:#c2410c;font-weight:800">IGNORE THIS ALERT IF</div><ul style="margin:6px 0 0;padding-left:18px;font-size:12px;line-height:1.45;color:#7c2d12">${ignoreRows}</ul>
          </div>

          <table role="presentation" width="100%" style="margin-top:14px;background:#0f172a;border-radius:8px"><tr><td style="padding:11px 13px;color:#cbd5e1;font-size:11px;line-height:1.55">
            <b style="color:#ffffff">Market context:</b> H4 ${escapeHtml(trendLabel(h4Trend, expectedTrend))} - H1 ${escapeHtml(trendLabel(h1Trend, expectedTrend))} - ${escapeHtml(sessionText)}<br>
            <b style="color:#ffffff">Timing:</b> signal ${escapeHtml(bdtStamp(signalMs))} - filled ${escapeHtml(bdtStamp(assessment?.fillMs))} - emailed ${escapeHtml(bdtStamp(sentMs))} - valid until ${escapeHtml(bdtStamp(validityMs))}<br>
            <b style="color:#ffffff">Strategy:</b> ${escapeHtml(strategyName)} - isolated Strategy Lab measurement
          </td></tr></table>
          <div style="margin-top:10px;text-align:center;font-size:10px;color:#94a3b8;line-height:1.45">One-time at-entry notice. Conditions can change after email delivery. Re-check price and spread before entry. Advisory only, not a guarantee or financial advice.</div>
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
  return { subject, text, html };
}
