/**
 * newsAlerts.js — lead-time email alert scheduler for high-impact economic news.
 *
 * Fires one email per (event, lead-time bucket). Default buckets (minutes):
 *   1440 (1d), 720 (12h), 360 (6h), 120 (2h), 60 (1h), 30, 15, 5.
 *
 * A disk-persisted dedup ledger guarantees each bucket is sent once even across restarts,
 * and (importantly) does NOT backfill: if the server starts late it only sends the nearest
 * upcoming bucket, never a burst of every larger bucket.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getEconomicEvents } from './economicCalendar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_FILE = path.join(__dirname, '.cache', 'news_alerts.json');

const IMPACT_RANK = { HIGH: 3, MODERATE: 2, LOW: 1, NONE: 0, HOLIDAY: 0 };

let ledger = {}; // { [eventId]: { sent: number[], eventTimeUtc: number } }

function loadLedger() {
  try {
    if (fs.existsSync(LEDGER_FILE)) ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) || {};
  } catch { ledger = {}; }
}
function saveLedger() {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger), 'utf8');
  } catch (err) { console.warn('[NewsAlerts] Failed to persist ledger:', err.message); }
}
function pruneLedger(now) {
  let changed = false;
  for (const [id, rec] of Object.entries(ledger)) {
    if (rec?.eventTimeUtc && now - rec.eventTimeUtc > 24 * 60 * 60 * 1000) { delete ledger[id]; changed = true; }
  }
  if (changed) saveLedger();
}

/** Smallest lead >= minutesUntil, within a reasonable tolerance window to avoid late alerts. */
function currentBucket(minutesUntil, leadsAsc) {
  for (const L of leadsAsc) {
    const tolerance = Math.max(5, Math.min(60, L * 0.1));
    if (minutesUntil <= L && minutesUntil >= L - tolerance) {
      return L;
    }
  }
  return null;
}

async function runCheck({ leadsAsc, minImpactRank, onAlert, now }) {
  // Look ahead just beyond the largest bucket.
  const horizonMs = (leadsAsc[leadsAsc.length - 1] + 60) * 60 * 1000;
  const events = getEconomicEvents({ from: now, to: now + horizonMs });
  for (const event of events) {
    if ((IMPACT_RANK[event.impact] || 0) < minImpactRank) continue;
    const minutesUntil = Math.round((event.timestampUtc - now) / 60000);
    if (minutesUntil <= 0) continue;
    const bucket = currentBucket(minutesUntil, leadsAsc);
    if (bucket === null) continue;

    const rec = ledger[event.id] || { sent: [], eventTimeUtc: event.timestampUtc };
    if (rec.sent.includes(bucket)) continue;

    try {
      await onAlert(event, bucket, minutesUntil);
      rec.sent.push(bucket);
      rec.eventTimeUtc = event.timestampUtc;
      ledger[event.id] = rec;
      saveLedger();
    } catch (err) {
      console.warn(`[NewsAlerts] Failed to send alert for ${event.id} bucket ${bucket}:`, err.message);
    }
  }
  pruneLedger(now);
}

let timer = null;
/**
 * @param {object} cfg
 *   - enabled: boolean
 *   - leads: number[] (minutes)
 *   - minImpact: 'HIGH'|'MODERATE'|'LOW'
 *   - intervalMs: poll interval (default 60s)
 *   - onAlert: async (event, bucketMinutes, minutesUntil) => void
 */
export function startNewsAlertScheduler(cfg = {}) {
  if (timer) return;
  if (cfg.enabled === false) { console.log('[NewsAlerts] Disabled via config.'); return; }
  const leadsAsc = [...new Set((cfg.leads && cfg.leads.length ? cfg.leads : [1440, 720, 360, 120, 60, 30, 15, 5]).map(Number).filter((n) => n > 0))].sort((a, b) => a - b);
  const minImpactRank = IMPACT_RANK[String(cfg.minImpact || 'HIGH').toUpperCase()] || 3;
  const intervalMs = Math.max(20000, Number(cfg.intervalMs || 60000));
  const onAlert = cfg.onAlert;
  if (typeof onAlert !== 'function') { console.warn('[NewsAlerts] No onAlert handler; scheduler not started.'); return; }

  loadLedger();
  const tick = () => void runCheck({ leadsAsc, minImpactRank, onAlert, now: Date.now() }).catch((e) => console.warn('[NewsAlerts] check error:', e.message));
  tick();
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[NewsAlerts] Scheduler started. Leads(min)=${leadsAsc.join(',')} minImpact=${cfg.minImpact || 'HIGH'} every ${intervalMs / 1000}s.`);
}
