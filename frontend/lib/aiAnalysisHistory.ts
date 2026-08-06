/**
 * Last-20 store for AI chart reads.
 *
 * The desk panel held its result in component state alone, so closing the panel — or
 * switching symbol/timeframe, which remounts the chart — threw the read away. Every one of
 * those costs a Gemini call and is the kind of thing you want to look back at, so the last 20
 * FULL results are persisted here and reachable from the panel's history drawer, surviving
 * reloads.
 *
 * localStorage rather than the backend: these are personal, per-browser reads with no
 * server-side consumer, and writing them to the database would put another table on the
 * growth path that mt5_indicators and mt5_candles already demonstrated.
 */
import type { ChartAnalysisResponse } from '../types';

export interface StoredAnalysis {
  id: string;
  savedAt: string;               // ISO timestamp of when the read was stored
  symbol: string;
  timeframe: string;
  style: 'SCALP' | 'DAY';
  bias: 'LONG' | 'SHORT' | 'BOTH';
  result: ChartAnalysisResponse; // the complete response, not a summary
}

const STORAGE_KEY = 'aura.aiChartAnalysis.history.v1';
export const MAX_ANALYSIS_HISTORY = 20;

function available(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

/** Newest first. Never throws: a corrupt or absent entry reads as an empty history. */
export function loadAnalysisHistory(): StoredAnalysis[] {
  if (!available()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop anything that lost its result payload — a listing entry we cannot reopen is worse
    // than no entry, because the drawer would offer a row that renders blank.
    return parsed.filter((e) => e && typeof e === 'object' && e.id && e.result) as StoredAnalysis[];
  } catch {
    return [];
  }
}

function persist(list: StoredAnalysis[]): StoredAnalysis[] {
  if (!available()) return list;
  let toWrite = list.slice(0, MAX_ANALYSIS_HISTORY);
  // A full analysis is a few KB, so 20 fits comfortably — but if the browser is near quota
  // (other apps share the origin budget) shed the oldest entries rather than lose the newest
  // read, which is the one the user is looking at.
  for (;;) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toWrite));
      return toWrite;
    } catch {
      if (toWrite.length <= 1) return list.slice(0, 1); // give up quietly; keep it in memory
      toWrite = toWrite.slice(0, Math.floor(toWrite.length / 2));
    }
  }
}

/** Store a fresh read at the front. Returns the new history. */
export function saveAnalysis(entry: Omit<StoredAnalysis, 'id' | 'savedAt'>): StoredAnalysis[] {
  const record: StoredAnalysis = {
    ...entry,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: new Date().toISOString(),
  };
  return persist([record, ...loadAnalysisHistory()]);
}

export function deleteAnalysis(id: string): StoredAnalysis[] {
  return persist(loadAnalysisHistory().filter((e) => e.id !== id));
}

export function clearAnalysisHistory(): StoredAnalysis[] {
  if (available()) {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to recover */ }
  }
  return [];
}

/** Most recent read for a series, used to repopulate the panel after an accidental close. */
export function latestAnalysisFor(symbol: string, timeframe: string): StoredAnalysis | null {
  const want = (v: string) => String(v || '').toUpperCase();
  return loadAnalysisHistory().find(
    (e) => want(e.symbol) === want(symbol) && want(e.timeframe) === want(timeframe),
  ) || null;
}
