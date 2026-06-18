/**
 * signalAlerts.js — dedup ledger for trade-signal & future-prediction email alerts.
 *
 * Rule: at most ONE alert per (key, candle bar), and at least `minGapMs` since the last
 * alert for that key. Persisted to disk so restarts don't re-send. `key` is typically
 * `forex:SYMBOL:TF` or `ftt:SYMBOL:EXPIRY`.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_FILE = path.join(__dirname, '.cache', 'signal_alerts.json');

let ledger = {}; // { [key]: { lastBar: string, lastSentAt: number } }
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(LEDGER_FILE)) ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) || {};
  } catch { ledger = {}; }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger), 'utf8');
  } catch (err) {
    console.warn('[SignalAlerts] Failed to persist ledger:', err.message);
  }
}

/**
 * Whether an alert may be sent now for this key/bar.
 * @returns boolean
 */
export function canAlert(key, bar, { minGapMs = 30 * 60 * 1000, now = Date.now() } = {}) {
  load();
  const rec = ledger[key];
  if (!rec) return true;
  if (rec.lastBar === String(bar)) return false;           // already alerted this bar
  if (now - (rec.lastSentAt || 0) < minGapMs) return false; // within cooldown window
  return true;
}

/** Record that an alert was sent (call after a successful send). */
export function recordAlert(key, bar, { now = Date.now() } = {}) {
  load();
  ledger[key] = { lastBar: String(bar), lastSentAt: now };
  save();
}

/** Maintenance: drop entries not touched in `maxAgeMs` (default 2 days). */
export function pruneAlerts(maxAgeMs = 2 * 24 * 60 * 60 * 1000, now = Date.now()) {
  load();
  let changed = false;
  for (const [k, rec] of Object.entries(ledger)) {
    if (now - (rec?.lastSentAt || 0) > maxAgeMs) { delete ledger[k]; changed = true; }
  }
  if (changed) save();
}
