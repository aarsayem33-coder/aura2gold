/**
 * economicCalendar.js — multi-source economic calendar store & matching.
 *
 * Sources (in preference order):
 *   1. 'mt5-ea'           — pushed by the MQL5 EA (CalendarValueHistory). Broker-time aligned.
 *   2. 'trading-economics'— polled from api.tradingeconomics.com as an automatic FALLBACK,
 *                           so the system keeps working when the MT5 calendar is empty/stale.
 *
 * Selection: we use MT5 data while it is FRESH; if it goes stale or empty we automatically
 * fall back to Trading Economics. Both stores are kept warm in the background.
 *
 * NO AI is involved in news observation: it is pure structured-data matching —
 *   parse event {currency, impact, time} -> match the symbol's currencies ->
 *   check the time window -> adjust the score. Deterministic rules only.
 *
 * ⚠ TIMEZONE:
 *   - MT5 events: the EA sends `serverGmtOffsetSec`; we normalise to UTC here.
 *   - Trading Economics: `Date` is ISO without a zone and is in UTC; we parse it as UTC.
 *   Always verify empirically via GET /api/mt5/news (AGENTS.md trap #8).
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, '.cache', 'economic_calendar.json');

// ── per-source stores ────────────────────────────────────────────────
const SOURCES = {
  'mt5-ea': { events: [], updatedAt: null, serverGmtOffsetSec: 0, error: null },
  'trading-economics': { events: [], updatedAt: null, serverGmtOffsetSec: 0, error: null },
};

// Freshness windows: how long a source's data is trusted before we fall back.
const FRESHNESS_MS = {
  'mt5-ea': 90 * 60 * 1000,            // EA pushes every ~30m; allow 90m before "stale"
  'trading-economics': 6 * 60 * 60 * 1000, // polled hourly; allow 6h
};

// MT5 is preferred when fresh; otherwise we cascade down this list.
const PREFERENCE = ['mt5-ea', 'trading-economics'];

const IMPACT_RANK = { HIGH: 3, MODERATE: 2, LOW: 1, NONE: 0, HOLIDAY: 0 };

function normalizeImpact(value) {
  if (value === null || value === undefined) return 'NONE';
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    if (n >= 3) return 'HIGH';
    if (n === 2) return 'MODERATE';
    if (n === 1) return 'LOW';
    return 'NONE';
  }
  const s = String(value).trim().toUpperCase();
  if (s.includes('HIGH') || s === 'RED') return 'HIGH';
  if (s.includes('MOD') || s.includes('MEDIUM') || s === 'ORANGE') return 'MODERATE';
  if (s.includes('LOW') || s === 'YELLOW') return 'LOW';
  if (s.includes('HOLIDAY')) return 'HOLIDAY';
  return 'NONE';
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resolveTimestampUtc(rawEvent, serverGmtOffsetSec) {
  if (rawEvent.timestampUtc != null) {
    const ms = Number(rawEvent.timestampUtc);
    if (Number.isFinite(ms)) return ms > 1e12 ? ms : ms * 1000;
  }
  const epochSec = toNumberOrNull(rawEvent.time ?? rawEvent.epoch ?? rawEvent.timeSec);
  if (epochSec !== null) {
    return (epochSec - (serverGmtOffsetSec || 0)) * 1000;
  }
  if (rawEvent.timeIso || typeof rawEvent.time === 'string') {
    const parsed = Date.parse(rawEvent.timeIso || rawEvent.time);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function normalizeEvents(rawEvents, serverGmtOffsetSec, sourceKey) {
  const events = [];
  for (const raw of rawEvents || []) {
    const timestampUtc = resolveTimestampUtc(raw, serverGmtOffsetSec);
    if (timestampUtc === null) continue;
    const currency = String(raw.currency || raw.country || '').trim().toUpperCase();
    events.push({
      id: String(raw.id || `${sourceKey}-${currency}-${timestampUtc}-${raw.title || ''}`),
      source: sourceKey,
      currency,
      country: String(raw.country || '').trim().toUpperCase(),
      impact: normalizeImpact(raw.impact ?? raw.importance),
      title: String(raw.title || raw.event || 'Economic Event').trim(),
      timestampUtc,
      timeIso: new Date(timestampUtc).toISOString(),
      actual: toNumberOrNull(raw.actual),
      forecast: toNumberOrNull(raw.forecast),
      previous: toNumberOrNull(raw.previous),
    });
  }
  events.sort((a, b) => a.timestampUtc - b.timestampUtc);
  return events;
}

/** Store a fresh batch for a given source. */
function setSourceEvents(sourceKey, payload = {}) {
  if (!SOURCES[sourceKey]) SOURCES[sourceKey] = { events: [], updatedAt: null, serverGmtOffsetSec: 0, error: null };
  const serverGmtOffsetSec = Number(payload.serverGmtOffsetSec) || 0;
  SOURCES[sourceKey].events = normalizeEvents(payload.events, serverGmtOffsetSec, sourceKey);
  SOURCES[sourceKey].updatedAt = new Date().toISOString();
  SOURCES[sourceKey].serverGmtOffsetSec = serverGmtOffsetSec;
  SOURCES[sourceKey].error = payload.error || null;
  saveToDisk();
  return SOURCES[sourceKey];
}

// ── disk persistence (survives backend restarts; news is otherwise in-memory) ──
function saveToDisk() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(SOURCES), 'utf8');
  } catch (err) {
    console.warn('[News] Failed to persist calendar cache:', err.message);
  }
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const [key, val] of Object.entries(data)) {
      if (!val || !Array.isArray(val.events)) continue;
      SOURCES[key] = {
        events: val.events,
        updatedAt: val.updatedAt || null,
        serverGmtOffsetSec: val.serverGmtOffsetSec || 0,
        error: val.error || null,
      };
    }
    const total = Object.values(SOURCES).reduce((n, s) => n + (s.events?.length || 0), 0);
    if (total) console.log(`[News] Restored ${total} cached calendar events from disk.`);
  } catch (err) {
    console.warn('[News] Failed to load calendar cache:', err.message);
  }
}

// Warm the store from disk immediately on module load.
loadFromDisk();

/** Backwards-compatible: the EA ingest endpoint calls this (source = mt5-ea). */
function setEconomicEvents(payload = {}) {
  return setSourceEvents(payload.source && SOURCES[payload.source] ? payload.source : 'mt5-ea', payload);
}

/**
 * Merge a small DELTA batch (from CalendarValueLast) into the mt5-ea source by event id,
 * WITHOUT wiping the rest. Returns the list of events whose `actual` just transitioned
 * from null -> a value (i.e. the release just printed) so the caller can fire instant alerts.
 */
function upsertEvents(payload = {}) {
  const sourceKey = payload.source && SOURCES[payload.source] ? payload.source : 'mt5-ea';
  if (!SOURCES[sourceKey]) SOURCES[sourceKey] = { events: [], updatedAt: null, serverGmtOffsetSec: 0, error: null };
  const serverGmtOffsetSec = Number(payload.serverGmtOffsetSec) || SOURCES[sourceKey].serverGmtOffsetSec || 0;
  const incoming = normalizeEvents(payload.events, serverGmtOffsetSec, sourceKey);

  const byId = new Map(SOURCES[sourceKey].events.map((e) => [e.id, e]));
  const newlyReleased = [];

  for (const ev of incoming) {
    const prev = byId.get(ev.id);
    const hadActual = prev && prev.actual !== null && prev.actual !== undefined;
    const hasActual = ev.actual !== null && ev.actual !== undefined;
    byId.set(ev.id, ev);
    if (!hadActual && hasActual) newlyReleased.push(ev);
  }

  const merged = [...byId.values()].sort((a, b) => a.timestampUtc - b.timestampUtc);
  SOURCES[sourceKey].events = merged;
  SOURCES[sourceKey].updatedAt = new Date().toISOString();
  SOURCES[sourceKey].serverGmtOffsetSec = serverGmtOffsetSec;
  saveToDisk();
  return { updated: incoming.length, total: merged.length, newlyReleased };
}

function isFresh(sourceKey) {
  const s = SOURCES[sourceKey];
  if (!s || !s.updatedAt || !s.events.length) return false;
  return Date.now() - Date.parse(s.updatedAt) < (FRESHNESS_MS[sourceKey] || 6 * 60 * 60 * 1000);
}

/** Pick the active source: first fresh source by preference, else first non-empty. */
function getActiveSourceKey() {
  for (const key of PREFERENCE) {
    if (isFresh(key)) return key;
  }
  for (const key of PREFERENCE) {
    if (SOURCES[key]?.events.length) return key;
  }
  return null;
}

function getActiveEvents() {
  const key = getActiveSourceKey();
  return key ? SOURCES[key].events : [];
}

function getStore() {
  const activeKey = getActiveSourceKey();
  const active = activeKey ? SOURCES[activeKey] : null;
  return {
    events: active ? active.events : [],
    updatedAt: active ? active.updatedAt : null,
    source: activeKey || 'none',
    serverGmtOffsetSec: active ? active.serverGmtOffsetSec : 0,
    sources: Object.fromEntries(
      Object.entries(SOURCES).map(([k, v]) => [k, {
        count: v.events.length,
        updatedAt: v.updatedAt,
        fresh: isFresh(k),
        active: k === activeKey,
        error: v.error,
      }])
    ),
  };
}

function getEconomicEvents({ from = null, to = null, minImpact = null } = {}) {
  const minRank = minImpact ? (IMPACT_RANK[normalizeImpact(minImpact)] || 0) : 0;
  return getActiveEvents().filter((e) => {
    if (from !== null && e.timestampUtc < from) return false;
    if (to !== null && e.timestampUtc > to) return false;
    if (minRank && (IMPACT_RANK[e.impact] || 0) < minRank) return false;
    return true;
  });
}

function symbolCurrencies(symbol) {
  const raw = String(symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
  const currencies = new Set();
  if (raw.includes('XAU') || raw.includes('GOLD') || raw.includes('XAG') || raw.includes('SILVER')) {
    currencies.add('USD');
    currencies.add('XAU');
  }
  const fx = raw.replace(/^XAU|^XAG|^GOLD|^SILVER/, '');
  const knownCodes = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'CNH', 'CNY', 'SGD', 'HKD', 'SEK', 'NOK', 'MXN', 'ZAR', 'TRY'];
  for (const code of knownCodes) {
    if (fx.includes(code)) currencies.add(code);
  }
  return [...currencies];
}

function assessNewsRisk(symbol, nowMs = Date.now(), { blockMins = 30, cautionMins = 90 } = {}) {
  const currencies = symbolCurrencies(symbol);
  const events = getActiveEvents();
  if (!currencies.length || !events.length) {
    return { block: false, caution: false, event: null, minutesUntil: null, reason: '' };
  }

  const blockMs = blockMins * 60 * 1000;
  const cautionMs = cautionMins * 60 * 1000;

  let blockEvent = null;
  let blockDelta = Infinity;
  let cautionEvent = null;
  let cautionDelta = Infinity;

  for (const e of events) {
    if (!currencies.includes(e.currency)) continue;
    const delta = e.timestampUtc - nowMs;
    const absDelta = Math.abs(delta);
    if (e.impact === 'HIGH' && absDelta <= blockMs && absDelta < blockDelta) {
      blockEvent = e;
      blockDelta = absDelta;
    }
    if ((e.impact === 'HIGH' || e.impact === 'MODERATE') && delta >= 0 && delta <= cautionMs && delta < cautionDelta) {
      cautionEvent = e;
      cautionDelta = delta;
    }
  }

  if (blockEvent) {
    const minutesUntil = Math.round((blockEvent.timestampUtc - nowMs) / 60000);
    const when = minutesUntil >= 0 ? `in ${minutesUntil}m` : `${Math.abs(minutesUntil)}m ago`;
    return { block: true, caution: true, event: blockEvent, minutesUntil, reason: `High-impact ${blockEvent.currency} news (${blockEvent.title}) ${when}` };
  }
  if (cautionEvent) {
    const minutesUntil = Math.round((cautionEvent.timestampUtc - nowMs) / 60000);
    return { block: false, caution: true, event: cautionEvent, minutesUntil, reason: `${cautionEvent.impact} ${cautionEvent.currency} news (${cautionEvent.title}) in ${minutesUntil}m` };
  }
  return { block: false, caution: false, event: null, minutesUntil: null, reason: '' };
}

function getUpcomingForSymbol(symbol, nowMs = Date.now(), hours = 12) {
  const currencies = symbolCurrencies(symbol);
  const horizon = nowMs + hours * 60 * 60 * 1000;
  return getActiveEvents().filter(
    (e) => currencies.includes(e.currency) && e.timestampUtc >= nowMs - 30 * 60 * 1000 && e.timestampUtc <= horizon
  );
}

// ── Trading Economics fallback poller ─────────────────────────────────

// Country -> ISO currency. TE's `Currency` field is frequently empty, so we map by country.
const COUNTRY_CURRENCY = {
  'UNITED STATES': 'USD', 'EURO AREA': 'EUR', 'EUROPEAN UNION': 'EUR', 'GERMANY': 'EUR',
  'FRANCE': 'EUR', 'ITALY': 'EUR', 'SPAIN': 'EUR', 'NETHERLANDS': 'EUR', 'PORTUGAL': 'EUR',
  'IRELAND': 'EUR', 'GREECE': 'EUR', 'AUSTRIA': 'EUR', 'BELGIUM': 'EUR', 'FINLAND': 'EUR',
  'UNITED KINGDOM': 'GBP', 'JAPAN': 'JPY', 'AUSTRALIA': 'AUD', 'CANADA': 'CAD',
  'SWITZERLAND': 'CHF', 'NEW ZEALAND': 'NZD', 'CHINA': 'CNY', 'SINGAPORE': 'SGD',
  'HONG KONG': 'HKD', 'SWEDEN': 'SEK', 'NORWAY': 'NOK', 'MEXICO': 'MXN',
  'SOUTH AFRICA': 'ZAR', 'TURKEY': 'TRY',
};

function teCountryToCurrency(country, currencyField) {
  if (currencyField && String(currencyField).trim()) return String(currencyField).trim().toUpperCase();
  return COUNTRY_CURRENCY[String(country || '').trim().toUpperCase()] || '';
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchTradingEconomicsOnce() {
  const enabled = (process.env.TE_CALENDAR_ENABLED ?? 'true') !== 'false';
  if (!enabled) return { ok: false, skipped: true };
  const apiKey = process.env.TRADING_ECONOMICS_API_KEY || 'guest:guest';

  const now = new Date();
  const from = ymd(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const to = ymd(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));
  const url = `https://api.tradingeconomics.com/calendar/country/All/${from}/${to}?c=${encodeURIComponent(apiKey)}&f=json`;

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'AuraGoldAlerts/1.0' }, timeout: 15000 });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      SOURCES['trading-economics'].error = `HTTP ${res.status}: ${body.slice(0, 120)}`;
      console.warn(`[News:TE] Fetch failed ${res.status}. ${apiKey === 'guest:guest' ? '(guest key returns limited data — set TRADING_ECONOMICS_API_KEY)' : ''}`);
      return { ok: false, status: res.status };
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      SOURCES['trading-economics'].error = 'Unexpected response shape';
      return { ok: false };
    }
    const events = data.map((e) => ({
      id: e.CalendarId,
      timestampUtc: Date.parse(`${e.Date}Z`), // TE Date is UTC, no zone suffix
      currency: teCountryToCurrency(e.Country, e.Currency),
      country: e.Country,
      impact: e.Importance, // 1/2/3 -> normalized downstream
      title: e.Event || e.Category,
      actual: e.Actual,
      forecast: e.Forecast || e.TEForecast,
      previous: e.Previous,
    })).filter((e) => Number.isFinite(e.timestampUtc));

    setSourceEvents('trading-economics', { events, source: 'trading-economics' });
    console.log(`[News:TE] Loaded ${events.length} events (${from}..${to}).`);
    return { ok: true, count: events.length };
  } catch (err) {
    SOURCES['trading-economics'].error = err.message;
    console.warn('[News:TE] Fetch error:', err.message);
    return { ok: false, error: err.message };
  }
}

let tePollTimer = null;
/** Start the Trading Economics background poller (fallback source). */
function startCalendarFallback() {
  if (tePollTimer) return;
  const enabled = (process.env.TE_CALENDAR_ENABLED ?? 'true') !== 'false';
  if (!enabled) {
    console.log('[News:TE] Fallback disabled via TE_CALENDAR_ENABLED=false.');
    return;
  }
  const pollMin = Math.max(15, Number(process.env.TE_CALENDAR_POLL_MIN || 60));
  void fetchTradingEconomicsOnce();
  tePollTimer = setInterval(() => void fetchTradingEconomicsOnce(), pollMin * 60 * 1000);
  if (typeof tePollTimer.unref === 'function') tePollTimer.unref();
  console.log(`[News:TE] Fallback poller started (every ${pollMin} min).`);
}

export {
  setEconomicEvents,
  setSourceEvents,
  upsertEvents,
  getEconomicEvents,
  getStore,
  symbolCurrencies,
  assessNewsRisk,
  getUpcomingForSymbol,
  normalizeImpact,
  startCalendarFallback,
  fetchTradingEconomicsOnce,
};
