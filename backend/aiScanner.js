/**
 * aiScanner.js — the hourly AI sweep across a fixed watchlist.
 *
 * WHAT IT DOES
 * Once an hour it asks three different engines the same question about the same six symbols on
 * H1 — "is there a trade here right now?" — and collapses the answers into ONE email and one
 * stored record:
 *   - CHART_AI       the vision reviewer's read of the live chart
 *   - SETUP_FORECAST the conditional level forecasts already produced by setupForecastRunner
 *   - ICT_PREDICT    the sweep/reclaim sequences already produced by ictPredict
 *
 * WHY IT READS THE OTHER TWO RATHER THAN RE-RUNNING THEM
 * Setup forecasts and ICT predictions have their own scanners on their own cadence. Running
 * them again here would double the work, double the Gemini spend, and — worse — produce a
 * second set of rows competing with the first. So this reads their freshest output and reports
 * it. Only the chart AI is actually invoked, because nothing else invokes it on a schedule.
 *
 * PURE-ISH BY DESIGN
 * Everything here that can be tested without a database or an API key is exported: row
 * selection, opportunity filtering, entry timing, and the email table. The scan cycle itself
 * lives in server.js where the pool and the analysis endpoint are.
 */

/** The watchlist. H1 only — the brief is an hourly read, not a scalping feed. */
export const AI_SCANNER_SYMBOLS = ['XAUUSD', 'EURJPY', 'USDCAD', 'EURUSD', 'GBPUSD', 'USDCHF'];
export const AI_SCANNER_TIMEFRAME = 'H1';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const up = (v) => String(v ?? '').toUpperCase();

/** A tradeable call has a direction AND the prices to act on it. */
export function isOpportunity(item) {
  if (!item) return false;
  if (!/BUY|SELL/.test(up(item.direction))) return false;
  return num(item.entry) !== null && num(item.stopLoss) !== null;
}

/**
 * Rank opportunities so the email leads with the best one.
 *
 * Score first, then confidence, then reward-to-risk. A null score sorts last rather than as
 * zero — "not scored" and "scored zero" are different claims, and treating them alike would
 * push unscored chart reads above genuinely weak setups.
 */
export function rankOpportunities(items) {
  const key = (x) => [num(x.score) ?? -1, num(x.confidence) ?? -1, num(x.rr) ?? -1];
  return [...(items || [])].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (kb[i] !== ka[i]) return kb[i] - ka[i];
    return 0;
  });
}

/**
 * When the setup is expected to become actionable.
 *
 * A limit resting at a level is not "enter now" — it fills when price arrives, and saying
 * otherwise invites chasing. So: an ETA from the forecast engines is reported as a window; a
 * chart read with price already at the entry is "now"; anything else is "on touch".
 */
export function suggestedEntryTime(item, nowMs = Date.now()) {
  const etaMin = num(item?.etaMinMinutes);
  const etaMax = num(item?.etaMaxMinutes);
  if (etaMin !== null || etaMax !== null) {
    const lo = etaMin ?? etaMax;
    const hi = etaMax ?? etaMin;
    const at = new Date(nowMs + lo * 60000);
    return {
      label: lo === hi ? `~${dur(lo)} (${hhmm(at)})` : `${dur(lo)}-${dur(hi)} (from ${hhmm(at)})`,
      earliestMs: nowMs + lo * 60000,
      basis: 'engine ETA to the level',
    };
  }
  const price = num(item?.price), entry = num(item?.entry), atr = num(item?.atr);
  if (price !== null && entry !== null && atr && atr > 0) {
    const away = Math.abs(price - entry) / atr;
    if (away <= 0.1) return { label: 'now — price is at the entry', earliestMs: nowMs, basis: 'price at entry' };
    return { label: `on touch of ${entry} (${away.toFixed(1)}x ATR away)`, earliestMs: null, basis: 'distance to entry' };
  }
  return { label: 'on touch of the entry', earliestMs: null, basis: 'no ETA available' };
}

function hhmm(d) {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/**
 * Minutes as something a human reads at a glance.
 *
 * The forecast engines happily return 7766 minutes, and "7766m" is a number you have to stop
 * and divide. Anything past a day is reported in days, because at that range the precision is
 * fictional anyway — an ETA five days out is a direction, not a schedule.
 */
export function dur(mins) {
  const m = Math.max(0, Math.round(num(mins) ?? 0));
  if (m < 60) return `${m}m`;
  if (m < 1440) {
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h${r}m` : `${h}h`;
  }
  const d = m / 1440;
  return d < 10 ? `${d.toFixed(1)}d` : `${Math.round(d)}d`;
}

const SOURCE_LABEL = {
  CHART_AI: 'Chart AI',
  SETUP_FORECAST: 'Setup forecast',
  ICT_PREDICT: 'ICT predict',
};

const fmt = (v, dp = 5) => (num(v) === null ? '—' : Number(v).toFixed(dp));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The hourly email.
 *
 * One table, one row per opportunity, every number the user asked to see: entry, stop, all
 * three targets, lot size, risk in dollars, and when it is expected to be actionable. The
 * no-opportunity case still returns a body — silence is indistinguishable from a broken
 * scanner, and this runs unattended.
 */
export function buildScannerEmail({ items = [], symbols = [], ranAt = new Date(), timeframe = AI_SCANNER_TIMEFRAME, scannedCount = 0 }) {
  const ops = rankOpportunities(items.filter(isOpportunity));
  const when = ranAt instanceof Date ? ranAt : new Date(ranAt);
  const stamp = `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

  const subject = ops.length
    ? `[Aura Gold] AI hourly scan — ${ops.length} setup${ops.length === 1 ? '' : 's'} (${[...new Set(ops.map((o) => o.symbol))].join(', ')})`
    : `[Aura Gold] AI hourly scan — nothing tradeable`;

  const textLines = [
    `AI hourly scan — ${stamp}`,
    `Scanned ${symbols.length} symbols on ${timeframe}: ${symbols.join(', ')}`,
    '',
  ];
  if (!ops.length) {
    textLines.push(`No tradeable setup found across ${scannedCount} engine reads. Nothing to do — this is a normal result.`);
  } else {
    for (const o of ops) {
      const t = suggestedEntryTime(o, when.getTime());
      textLines.push(
        `${o.symbol} ${o.timeframe} · ${up(o.direction)} · ${SOURCE_LABEL[o.source] || o.source}`,
        `  entry ${fmt(o.entry)}  SL ${fmt(o.stopLoss)}  TP ${fmt(o.takeProfit1)} / ${fmt(o.takeProfit2)} / ${fmt(o.takeProfit3)}`,
        `  ${o.lots ?? '—'} lots · risk ${o.riskUsd === null || o.riskUsd === undefined ? '—' : `$${o.riskUsd}`} · R:R ${o.rr ?? '—'}`,
        `  score ${o.score ?? '—'}${o.grade ? ` (${o.grade})` : ''} · confidence ${o.confidence ?? '—'}`,
        `  enter: ${t.label}`,
        '',
      );
    }
  }
  textLines.push('Estimates from an automated read, not advice. Place from the AI Scanner page if you agree with one.');

  const rows = ops.map((o) => {
    const t = suggestedEntryTime(o, when.getTime());
    const dirColour = up(o.direction) === 'BUY' ? '#047857' : '#b91c1c';
    return `<tr>
      <td style="padding:7px 8px;border-bottom:1px solid #e2e8f0;font-weight:800;color:#0f172a">${esc(o.symbol)}<div style="font-weight:600;color:#94a3b8;font-size:11px">${esc(o.timeframe)}</div></td>
      <td style="padding:7px 8px;border-bottom:1px solid #e2e8f0;font-weight:900;color:${dirColour}">${esc(up(o.direction))}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e2e8f0;color:#475569;font-size:11px">${esc(SOURCE_LABEL[o.source] || o.source)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e2e8f0;font-family:monospace;font-weight:700">${fmt(o.entry)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e2e8f0;font-family:monospace;color:#b91c1c">${fmt(o.stopLoss)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e2e8f0;font-family:monospace;color:#047857;font-size:11px">${fmt(o.takeProfit1)}<br>${fmt(o.takeProfit2)}<br>${fmt(o.takeProfit3)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e2e8f0;font-weight:800">${o.lots ?? '—'}<div style="font-weight:600;color:#94a3b8;font-size:11px">${o.riskUsd === null || o.riskUsd === undefined ? '' : `$${o.riskUsd} risk`}</div></td>
      <td style="padding:7px 8px;border-bottom:1px solid #e2e8f0;font-weight:700">${o.score ?? '—'}${o.grade ? `<span style="color:#94a3b8"> ${esc(o.grade)}</span>` : ''}<div style="font-weight:600;color:#94a3b8;font-size:11px">conf ${o.confidence ?? '—'} · RR ${o.rr ?? '—'}</div></td>
      <td style="padding:7px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#334155">${esc(t.label)}</td>
    </tr>`;
  }).join('');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:auto;color:#0f172a">
    <div style="border-bottom:2px solid #7c3aed;padding-bottom:8px;margin-bottom:12px">
      <div style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#7c3aed">Aura Gold · AI hourly scan</div>
      <div style="font-size:12px;color:#64748b;margin-top:2px">${esc(stamp)} · ${esc(String(symbols.length))} symbols on ${esc(timeframe)} · ${esc(String(scannedCount))} engine reads</div>
    </div>
    ${ops.length ? `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#f1f5f9">
        ${['Symbol', 'Dir', 'Source', 'Entry', 'Stop', 'TP 1/2/3', 'Lots', 'Score', 'Enter'].map((h) =>
    `<th style="padding:6px 8px;text-align:left;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#64748b">${h}</th>`).join('')}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`
    : `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;color:#475569;font-size:13px">
        <strong>No tradeable setup this hour.</strong><br>
        ${esc(String(scannedCount))} engine reads across ${esc(symbols.join(', '))} produced no entry worth resting an order on.
        This is a normal result — most hours do not contain a trade.
      </div>`}
    <div style="margin-top:14px;font-size:11px;color:#94a3b8;line-height:1.5">
      Prices come from the deterministic engines, not from the model's arithmetic. Lot sizes are computed
      server-side against your current risk budget. Nothing here has been sent to MT5 — place from the
      AI Scanner page if you agree with a setup. Estimates, not advice.
    </div>
  </div>`;

  return { subject, text: textLines.join('\n'), html, opportunities: ops.length };
}
