import fetch from 'node-fetch';
import { GoogleAuth } from 'google-auth-library';
import { getUpcomingForSymbol } from './economicCalendar.js';

function stripCodeFences(text) {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function normalizeDecision(decision) {
  const value = String(decision || 'HOLD').toUpperCase();
  if (['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL'].includes(value)) return value;
  return 'HOLD';
}

// ─────────────────────────────────────────────────────────────────────────
// SHARED PROFESSIONAL-TRADER DOCTRINE
// This block is prepended to every section's prompt (signals, fixed-time,
// projections). It turns the model from a "signal bot" into a risk-focused
// professional trader whose FIRST duty is capital protection. It enforces the
// math-first workflow: read the deterministic engine output, then reason.
// ─────────────────────────────────────────────────────────────────────────
export const TRADER_DOCTRINE = `
You are a PROFESSIONAL, RISK-FOCUSED TRADING ANALYST for Forex and Gold (XAU).
You are NOT a gambling signal bot. Your FIRST duty is to PROTECT CAPITAL; finding a
trade is only your SECOND duty. A good trader does not trade every candle — they wait
patiently for price to come to a high-probability area.

NON-NEGOTIABLE PRINCIPLES:
1. CAPITAL PROTECTION FIRST. "NO TRADE" / "WAIT" is a professional, valid, and often
   correct decision. When the picture is unclear, choose NO TRADE.
2. NO GUARANTEES. Never claim 90%/95%/100% accuracy or a "sure win". Professional
   trading is about POSITIVE EXPECTANCY, not certainty. Confidence is a probability
   estimate, never a promise. Keep confidence <= 90 unless confluence is exceptional,
   and never above 95.
3. EXPECTANCY OVER ACCURACY. Judge every setup by expected value (win% x avgWin vs
   loss% x avgLoss), not by confidence alone. Reject good-looking entries with poor
   reward-to-risk.
4. MATH FIRST, THEN JUDGEMENT. A deterministic engine has already computed the scores,
   structure, indicators, zones and timing below. READ AND RECONCILE THAT MATH FIRST.
   If your read disagrees with the math, say so explicitly and explain why. Do not
   invent levels the data does not support.

WORKFLOW (apply in order):
A. MARKET REGIME: First classify the market — TRENDING, RANGING, VOLATILE/NEWS, or
   UNCLEAR. If UNCLEAR or mid-range with no clean level => NO TRADE.
   - Trending: only take pullback entries in the trend direction.
   - Ranging: only trade reactions from strong S/R zone edges, never the middle.
   - Volatile/News: avoid unless the setup is explicitly a news-resilient structure.
B. MULTI-TIMEFRAME: Higher TF sets bias, middle TF sets direction, lower TF sets entry.
   Never flip the bias because of one small candle. The timeframes must not DIRECTLY
   CONFLICT (e.g. higher TF clearly bullish while you sell). A NEUTRAL / flat higher TF
   is NOT a conflict — in that case derive bias from market structure, EMA stacking and
   momentum, and you MAY still trade a clean entry setup at a logical level.
C. STRUCTURE: Use HH/HL/LH/LL, BOS, CHoCH, liquidity sweeps, false breakouts, and
   supply/demand & support/resistance zones. Buys only on bullish structure or a strong
   reaction from demand/support; sells only on bearish structure or rejection from
   supply/resistance.
D. INDICATORS ARE SUPPORT TOOLS, NOT TRIGGERS: EMA20/50/200 for bias, RSI for momentum
   (>50 bullish lean, <50 bearish lean), ATR for volatility/room. Never enter on one
   indicator alone.
E. RISK MANAGEMENT: For Forex, NEVER propose an entry without a stop loss at a logical
   invalidation (below swing low for buys, above swing high for sells). Target the next
   logical S/R. Require reward:risk >= 1.5 (prefer >= 2). Reject poor R:R even if the
   entry looks attractive. Risk per trade is small (0.25%-1% of equity). NEVER suggest
   martingale, averaging into losers, or revenge trading.
F. NEWS & SESSION: Avoid entries immediately before/after high-impact news. Respect that
   thin/quiet sessions give weak signals; London/NY overlaps move best.
G. SCORING GATE: Add points for trend alignment, clean S/R reaction, candle confirmation,
   good momentum, normal volatility, acceptable spread, positive R:R. Subtract for
   high-impact news, wide spread, unclear structure, weak momentum, mid-range price,
   exhausted ADR. If the net score is weak, output NO TRADE / WAIT.

Be honest and concise. Explain the bias, the trend, the entry trigger, the invalidation,
the risk, the expected value, and your final verdict. If you would not risk your own
capital on it, do not call it a trade.`;

// Words/phrases that over-promise. We neutralise them in any model output so the UI
// never shows a "guaranteed 100% win" style claim, regardless of what the model wrote.
const OVERPROMISE_PATTERNS = [
  [/\b100\s*%\s*(accuracy|accurate|win(?:\s*rate)?|sure|guarantee[d]?|certain)\b/gi, 'high-probability'],
  [/\b9[0-9]\s*%\s*(accuracy|accurate|win\s*rate|sure|guarantee[d]?)\b/gi, 'elevated-probability'],
  [/\bguarantee[d]?\b/gi, 'favoured (not guaranteed)'],
  [/\bsure\s*(win|shot|thing)\b/gi, 'high-probability setup'],
  [/\bcan'?t\s*lose\b/gi, 'still carries risk'],
  [/\brisk[- ]?free\b/gi, 'risk-managed'],
  [/\bcertain(ty)?\b/gi, 'likely'],
];

function enforceHonesty(text) {
  let out = String(text || '');
  for (const [pattern, replacement] of OVERPROMISE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Clamp a confidence value into an honest professional band (never a "100% certainty"). */
function capConfidence(value, { max = 95 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(max, Math.round(n)));
}

function fallbackAnalysis(signalSummary) {
  const composite = Number(signalSummary?.compositeScore || 0);
  const decision = composite >= 0.6 ? 'STRONG_BUY' : composite >= 0.3 ? 'BUY' : composite <= -0.6 ? 'STRONG_SELL' : composite <= -0.3 ? 'SELL' : 'HOLD';
  return {
    decision,
    confidence: Math.max(25, Math.min(90, Math.round(Math.abs(composite) * 100))),
    entry_price: signalSummary?.marketContext?.price ?? null,
    stop_loss: null,
    take_profit_1: null,
    take_profit_2: null,
    take_profit_3: null,
    risk_reward_ratio: null,
    reasoning: 'Fallback signal-based decision because Gemini is unavailable.',
    key_factors: (signalSummary?.signals || []).slice(0, 3).map((signal) => signal.reason).filter(Boolean),
    risk_level: 'MEDIUM',
    suggested_lot_size: null,
    trade_trigger: 'IMMEDIATE',
    predicted_time: 'Immediate / Within 15 minutes',
  };
}

const vertexAuth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

async function getVertexAccessToken() {
  const client = await vertexAuth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  if (!token) {
    throw new Error('Unable to resolve an access token from Application Default Credentials.');
  }
  return token;
}

function buildVertexEndpoint({ projectId, location, model }) {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

// ─── Auth mode: Gemini API key (AI Studio) OR Vertex AI (ADC) ──────────────
// If GEMINI_API_KEY (or GOOGLE_API_KEY) is set we route through the public
// Generative Language API (key-based, no GCP project needed). Otherwise we fall
// back to Vertex AI with Application Default Credentials — the original setup.
// Both APIs accept the same { contents, generationConfig } body and return the
// same { candidates: [{ content: { parts: [{ text }] } }] } shape, so every
// caller below works unchanged regardless of which mode is active.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

/** True when AI can run at all — either an API key OR a Vertex project is present. */
export function isGeminiConfigured(projectId) {
  return Boolean(GEMINI_API_KEY || projectId);
}

/** Which auth mode is active, for logging / health reporting. */
export function geminiAuthMode() {
  return GEMINI_API_KEY ? 'api-key' : 'vertex-adc';
}

/**
 * Single entry point for a generateContent call. Returns the raw fetch Response
 * so callers keep their existing response.ok / .status / .text() / .json() logic.
 * Throws only if Vertex ADC token resolution fails (mirrors prior behaviour).
 */
async function geminiGenerateContent({ projectId, location = 'global', model, contents, generationConfig }) {
  const body = JSON.stringify({ contents, generationConfig });

  if (GEMINI_API_KEY) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body,
    });
  }

  // Vertex AI (Application Default Credentials)
  const accessToken = await getVertexAccessToken();
  const endpoint = buildVertexEndpoint({ projectId, location, model });
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Goog-User-Project': projectId,
    },
    body,
  });
}

function sanitizeTimeframeSummary(summary, candleLimit = 20) {
  if (!summary) return null;
  const indicators = summary.indicatorsSnapshot || {};
  const recentCandles = summary.marketContext?.recentCandles || [];
  
  // Sanitize indicators
  const sanitizedIndicators = {};
  for (const [key, ind] of Object.entries(indicators)) {
    if (!ind) continue;
    const cleanInd = {};
    if (ind.value1 !== null && ind.value1 !== undefined) cleanInd.value1 = ind.value1;
    if (ind.value2 !== null && ind.value2 !== undefined) cleanInd.value2 = ind.value2;
    if (ind.value3 !== null && ind.value3 !== undefined) cleanInd.value3 = ind.value3;
    if (ind.value4 !== null && ind.value4 !== undefined) cleanInd.value4 = ind.value4;
    if (ind.value5 !== null && ind.value5 !== undefined) cleanInd.value5 = ind.value5;
    
    const keys = Object.keys(cleanInd);
    if (keys.length === 1 && keys[0] === 'value1') {
      sanitizedIndicators[key] = cleanInd.value1;
    } else if (keys.length > 0) {
      sanitizedIndicators[key] = cleanInd;
    }
  }

  // Sanitize candles
  const sanitizedCandles = (recentCandles || []).slice(-candleLimit).map((c) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume
  }));

  // Sanitize signals
  const sanitizedSignals = (summary.signals || []).map((s) => ({
    indicator: s.name,
    direction: s.direction,
    strength: s.strength,
    reason: s.reason
  }));

  return {
    timeframe: summary.timeframe,
    compositeScore: summary.compositeScore,
    decision: summary.decision,
    confidence: summary.confidence,
    price: summary.marketContext?.price,
    indicators: sanitizedIndicators,
    candles: sanitizedCandles,
    signals: sanitizedSignals,
  };
}

function buildPrompt({ signalSummary, trendSummary, biasSummary, accountSnapshot, recentDecisions = [] }) {
  const entry = sanitizeTimeframeSummary(signalSummary, 20);
  const trend = sanitizeTimeframeSummary(trendSummary, 5);
  const bias = sanitizeTimeframeSummary(biasSummary, 5);
  
  // Sanitize recent decisions to exclude nested snapshots, preventing context blowup
  const sanitizedDecisions = (recentDecisions || []).map((d) => ({
    decision: d.decision,
    confidence: d.confidence,
    entry_price: d.entry_price,
    reasoning: d.reasoning,
    outcome: d.outcome,
    outcome_pips: d.outcome_pips,
    created_at: d.created_at
  }));

  // ─── Outcome feedback ("training" loop) ───
  // Gemini can't be fine-tuned here, so we calibrate it in-context: summarise how the
  // recent calls actually performed and feed that back so it adjusts conviction.
  const settled = sanitizedDecisions.filter((d) => d.outcome && !['PENDING', 'EXPIRED'].includes(d.outcome));
  const wins = settled.filter((d) => d.outcome === 'WIN').length;
  const losses = settled.filter((d) => d.outcome === 'LOSS').length;
  const netPips = settled.reduce((sum, d) => sum + (Number(d.outcome_pips) || 0), 0);
  const recentWinRate = settled.length ? Math.round((wins / settled.length) * 100) : null;
  const performanceNote = settled.length
    ? `Your last ${settled.length} settled calls on this symbol: ${wins}W / ${losses}L (win rate ${recentWinRate}%, net ${netPips.toFixed(1)} pips). If recent losing calls share a pattern (e.g. counter-trend entries, trading into news, low conviction), correct for it now. Lower your confidence when the setup resembles a recent loser.`
    : 'No settled trade outcomes yet for this symbol — be conservative with confidence until a track record exists.';

  // ─── Upcoming economic news for this symbol (next 12h) ───
  const upcomingNews = getUpcomingForSymbol(signalSummary?.symbol || '', Date.now(), 12).map((e) => ({
    currency: e.currency,
    impact: e.impact,
    title: e.title,
    in_minutes: Math.round((e.timestampUtc - Date.now()) / 60000),
    forecast: e.forecast,
    previous: e.previous,
    actual: e.actual,
  }));
  const newsBlock = upcomingNews.length
    ? JSON.stringify(upcomingNews, null, 2)
    : 'No high/medium-impact events scheduled for the relevant currencies in the next 12 hours.';

  // Sanitize account snapshot to remove raw body payload and lists of all symbols/timeframes
  const targetAccount = accountSnapshot || signalSummary?.marketContext?.accountSnapshot || null;
  const sanitizedAccount = targetAccount ? {
    balance: targetAccount.balance,
    equity: targetAccount.equity,
    margin: targetAccount.margin,
    freeMargin: targetAccount.freeMargin,
    profit: targetAccount.profit,
    currency: targetAccount.currency,
    leverage: targetAccount.leverage,
    marginLevel: targetAccount.marginLevel,
    openTrades: targetAccount.openTrades,
  } : null;

  return `${TRADER_DOCTRINE}

=== TASK: SIGNALS — MULTI-TIMEFRAME ANALYSIS (MTFA) ===
A deterministic signal engine (SMC scoring, confluences, ADX regime, HTF bias) has
ALREADY analysed this symbol. Its math is provided below as composite scores and
technical signals per timeframe. Read that math FIRST, then perform your own MTFA and
RECONCILE the three timeframes into ONE decision:
1. Higher Timeframe (Bias): overall market bias / trend filter.
2. Middle Timeframe (Trend): current trade direction.
3. Lower Timeframe (Entry): precise entry setup and candle patterns.
Read each timeframe's lean from its composite SCORE, not just the HOLD/BUY/SELL label:
a "decision: HOLD" with a near-zero score means NEUTRAL, NOT a veto. Only reject the
trade when a higher timeframe is CLEARLY opposite to your intended entry direction, or
when structure is genuinely unclear / ranging with no clean level. If the higher
timeframes are neutral but the entry timeframe shows a clean setup at a logical level
with supporting momentum and acceptable R:R, you MAY take it. Do not flip bias on one
small candle.

Symbol: ${signalSummary?.symbol || 'UNKNOWN'}
Target Entry Timeframe: ${entry?.timeframe || 'UNKNOWN'}

Account:
${JSON.stringify(sanitizedAccount, null, 2)}

--- MULTI-TIMEFRAME MARKET DATA ---

${bias ? `[HIGHER TIMEFRAME - BIAS (${bias.timeframe})]
Composite Score: ${bias.compositeScore}
Decision bias: ${bias.decision}
Price: ${bias.price}
Technical signals:
${JSON.stringify(bias.signals, null, 2)}
Recent candles:
${JSON.stringify(bias.candles, null, 2)}
` : ''}

${trend ? `[MIDDLE TIMEFRAME - TREND/DIRECTION (${trend.timeframe})]
Composite Score: ${trend.compositeScore}
Trend direction: ${trend.decision}
Price: ${trend.price}
Technical signals:
${JSON.stringify(trend.signals, null, 2)}
Recent candles:
${JSON.stringify(trend.candles, null, 2)}
` : ''}

[LOWER TIMEFRAME - ENTRY SETUP (${entry?.timeframe || 'UNKNOWN'})]
Composite Score: ${entry?.compositeScore ?? 0}
Signal engine recommendation: ${entry?.decision || 'HOLD'}
Price: ${entry?.price}
Technical signals:
${JSON.stringify(entry?.signals || [], null, 2)}
Indicators detail:
${JSON.stringify(entry?.indicators || {}, null, 2)}
Recent candles (Note: The last candle in this list is the currently active, developing candle [bar 0] and contains the most recent live price):
${JSON.stringify(entry?.candles || [], null, 2)}

Recent decisions history:
${JSON.stringify(sanitizedDecisions, null, 2)}

--- PERFORMANCE FEEDBACK (calibrate your confidence from this) ---
${performanceNote}

--- UPCOMING ECONOMIC CALENDAR (MT5-native, relevant currencies, next 12h) ---
${newsBlock}

NEWS & VOLATILITY RULES (apply strictly):
- If a HIGH-impact event for a relevant currency is within 30 minutes (in_minutes between -30 and 30), you MUST return "HOLD" with trade_trigger "HOLD_NO_TRADE" — do not trade into the release.
- If a HIGH/MODERATE event is within ~90 minutes, prefer "LIMIT_PULLBACK" or "BREAKOUT_CONFIRMATION" over an aggressive "IMMEDIATE" entry, and widen the stop to survive the volatility spike.
- Outside news windows, size and trigger normally based on the multi-timeframe structure.

DECISION DISCIPLINE:
- Only output BUY/STRONG_BUY or SELL/STRONG_SELL when regime is clear, the three timeframes agree, there is a clean structural reason, the stop is logical, and reward:risk >= 1.5. Otherwise output HOLD.
- If you output HOLD, set entry_price/stop_loss/take_profit to the most relevant watch levels (or null) and explain in reasoning what you are waiting for.
- entry_price, stop_loss and take_profit_1..3 must be mathematically consistent with risk_reward_ratio.

Return STRICT JSON ONLY with these fields:
{
  "decision": "STRONG_BUY|BUY|HOLD|SELL|STRONG_SELL",
  "final_verdict": "TRADE_ALLOWED|WAIT|NO_TRADE|TRADE_REJECTED",
  "market_regime": "TRENDING|RANGING|VOLATILE_NEWS|UNCLEAR",
  "confidence": 0-95,
  "setup_score": 0-100,
  "score_breakdown": ["+pts trend alignment", "+pts S/R reaction", "-pts news risk", "..."],
  "entry_price": number,
  "stop_loss": number,
  "invalidation": "the price/structure level that proves this idea wrong and why",
  "take_profit_1": number,
  "take_profit_2": number,
  "take_profit_3": number,
  "risk_reward_ratio": number,
  "expected_value_note": "one line on why expectancy is positive (or why you passed)",
  "reasoning": "A concise but COMPLETE professional write-up, in this order: (1) Market regime; (2) H4 bias; (3) H1 trend; (4) entry-TF setup & candle confirmation; (5) reconciliation of the deterministic math vs your read; (6) invalidation & risk; (7) expectancy; (8) FINAL VERDICT. Be honest. Never promise guaranteed wins.",
  "key_factors": ["Regime: ...", "H4 bias: ...", "H1 trend: ...", "Entry setup: ...", "Risk/Invalidation: ...", "News: ..."],
  "risk_level": "LOW|MEDIUM|HIGH",
  "suggested_lot_size": number,
  "trade_trigger": "IMMEDIATE|LIMIT_PULLBACK|BREAKOUT_CONFIRMATION|HOLD_NO_TRADE",
  "predicted_time": "estimate when this trade will trigger/execute, e.g. 'Immediate / within 15 mins', 'Pullback to entry (1-2 hours)', 'At H1 candle close (~45 mins)'"
}`;
}

export async function checkVertexAiHealth({ projectId, location = 'global', model = 'gemini-2.5-flash' }) {
  if (!isGeminiConfigured(projectId)) {
    return { ok: false, status: 400, error: 'No Gemini auth configured. Set GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT.' };
  }

  const mode = geminiAuthMode();
  let response;
  try {
    response = await geminiGenerateContent({
      projectId,
      location,
      model,
      contents: [{ role: 'user', parts: [{ text: 'Return only this JSON: {"ok":true}' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 32, responseMimeType: 'application/json' },
    });
  } catch (error) {
    return { ok: false, status: 401, error: `Auth unavailable (${mode}): ${error.message}`, mode, model };
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    return { ok: false, status: response.status, error: text, mode, projectId, location, model };
  }

  return { ok: true, status: response.status, mode, projectId, location, model };
}

function calculateSuggestedLotSize({ symbol, accountEquity, riskPercentage = 1.0, entryPrice, stopLoss }) {
  if (!entryPrice || !stopLoss || !accountEquity || entryPrice === stopLoss) return null;

  const priceDiff = Math.abs(entryPrice - stopLoss);
  
  // Get pip size
  let pipSize = 0.0001;
  const sym = String(symbol).toUpperCase();
  if (sym.includes('XAU') || sym.includes('GOLD')) {
    pipSize = 0.1; // 1.00 move is 10 pips
  } else if (sym.includes('JPY')) {
    pipSize = 0.01;
  } else if (sym.includes('BTC') || sym.includes('ETH')) {
    pipSize = 1.0;
  }

  const stopLossPips = priceDiff / pipSize;
  if (stopLossPips <= 0) return null;

  const riskAmount = accountEquity * (riskPercentage / 100);
  const pipValuePerLot = 10.0; // Standard $10.00 per pip for EURUSD, XAUUSD etc.

  const rawLotSize = riskAmount / (stopLossPips * pipValuePerLot);
  
  // Round to 2 decimal places (standard MT5 lot size increment is 0.01)
  const lotSize = Math.max(0.01, Math.round(rawLotSize * 100) / 100);
  return lotSize;
}

export async function analyzeWithGemini({ projectId, location = 'global', model = 'gemini-2.5-flash', signalSummary, trendSummary, biasSummary, accountSnapshot, recentDecisions = [] }) {
  if (!isGeminiConfigured(projectId)) return fallbackAnalysis(signalSummary);

  const prompt = buildPrompt({ signalSummary, trendSummary, biasSummary, accountSnapshot, recentDecisions });

  let response;
  try {
    response = await geminiGenerateContent({
      projectId,
      location,
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });
  } catch (error) {
    console.error(`[Gemini Engine] Request failed (${geminiAuthMode()}):`, error.message);
    const fallback = fallbackAnalysis(signalSummary);
    fallback.reasoning = `Fallback decision: Gemini request failed (${geminiAuthMode()}).`;
    return fallback;
  }

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    
    // Auto-fallback from gemini-2.5-pro to gemini-2.5-flash if pro is unavailable (e.g. quota limits)
    if (model === 'gemini-2.5-pro') {
      console.warn(`[Gemini Engine] gemini-2.5-pro failed with status ${response.status}. Attempting auto-fallback to gemini-2.5-flash...`);
      try {
        return await analyzeWithGemini({
          projectId,
          location,
          model: 'gemini-2.5-flash',
          signalSummary,
          trendSummary,
          biasSummary,
          accountSnapshot,
          recentDecisions,
        });
      } catch (err) {
        console.error(`[Gemini Engine] Fallback to gemini-2.5-flash failed:`, err.message);
      }
    }

    console.error(`[Gemini Engine] API returned error ${response.status}:`, message);
    const fallback = fallbackAnalysis(signalSummary);
    fallback.reasoning = `Fallback decision: Vertex AI returned error ${response.status}. Please check ADC and quota.`;
    return fallback;
  }

  try {
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('[Gemini Engine] Response text:', text);
    let parsed;
    try {
      parsed = JSON.parse(stripCodeFences(text));
    } catch (parseError) {
      console.error(`[Gemini Engine] Failed to parse Gemini response JSON:`, parseError.message);
      console.log('[Gemini Engine] Full response structure:', JSON.stringify(data, null, 2));
      throw parseError;
    }

    let suggestedLotSize = parsed.suggested_lot_size ?? null;
    const accountEquity = accountSnapshot?.equity || accountSnapshot?.balance || null;
    if (accountEquity && parsed.entry_price && parsed.stop_loss) {
      const riskPercent = Number(process.env.TRADE_RISK_PERCENTAGE || 1.0);
      try {
        const calculatedLot = calculateSuggestedLotSize({
          symbol: signalSummary?.symbol || 'XAUUSD',
          accountEquity,
          riskPercentage: riskPercent,
          entryPrice: parsed.entry_price,
          stopLoss: parsed.stop_loss
        });
        if (calculatedLot) {
          suggestedLotSize = calculatedLot;
          console.log(`[Gemini Engine] Calculated lot size: ${suggestedLotSize} (Equity: ${accountEquity}, Risk%: ${riskPercent}, SL pips: ${Math.abs(parsed.entry_price - parsed.stop_loss)})`);
        }
      } catch (err) {
        console.error('[Gemini Engine] Failed to calculate lot size:', err.message);
      }
    }

    // ─── Honesty guard + verdict consistency ───
    const finalVerdict = String(parsed.final_verdict || '').toUpperCase();
    const marketRegime = String(parsed.market_regime || '').toUpperCase();
    let decision = normalizeDecision(parsed.decision);
    // If the model judged it not a trade, the headline decision must be HOLD — no mixed signals.
    if (['NO_TRADE', 'WAIT', 'TRADE_REJECTED'].includes(finalVerdict)) {
      decision = 'HOLD';
    }
    let reasoning = enforceHonesty(String(parsed.reasoning || 'Gemini returned no reasoning.'));
    const headerBits = [];
    if (finalVerdict) headerBits.push(finalVerdict.replace(/_/g, ' '));
    if (marketRegime) headerBits.push(`Regime: ${marketRegime.replace(/_/g, ' ')}`);
    if (parsed.setup_score != null) headerBits.push(`Score: ${parsed.setup_score}/100`);
    if (parsed.invalidation) headerBits.push(`Invalidation: ${parsed.invalidation}`);
    if (headerBits.length) reasoning = `[${headerBits.join(' · ')}]\n${reasoning}`;
    const keyFactors = (Array.isArray(parsed.key_factors) ? parsed.key_factors : []).map((f) => enforceHonesty(String(f)));

    return {
      decision,
      final_verdict: finalVerdict || null,
      market_regime: marketRegime || null,
      setup_score: parsed.setup_score ?? null,
      score_breakdown: Array.isArray(parsed.score_breakdown) ? parsed.score_breakdown : [],
      invalidation: parsed.invalidation ? enforceHonesty(String(parsed.invalidation)) : null,
      expected_value_note: parsed.expected_value_note ? enforceHonesty(String(parsed.expected_value_note)) : null,
      confidence: capConfidence(parsed.confidence ?? signalSummary?.confidence ?? 50),
      entry_price: parsed.entry_price ?? signalSummary?.marketContext?.price ?? null,
      stop_loss: parsed.stop_loss ?? null,
      take_profit_1: parsed.take_profit_1 ?? null,
      take_profit_2: parsed.take_profit_2 ?? null,
      take_profit_3: parsed.take_profit_3 ?? null,
      risk_reward_ratio: parsed.risk_reward_ratio ?? null,
      reasoning,
      key_factors: keyFactors,
      risk_level: String(parsed.risk_level || 'MEDIUM').toUpperCase(),
      suggested_lot_size: suggestedLotSize,
      trade_trigger: parsed.trade_trigger || (decision === 'HOLD' ? 'HOLD_NO_TRADE' : 'IMMEDIATE'),
      predicted_time: parsed.predicted_time || 'Immediate / Within 15 minutes',
      raw: data,
    };
  } catch (error) {
    const fallback = fallbackAnalysis(signalSummary);
    fallback.reasoning = `Fallback decision: Failed to parse Gemini response structure.`;
    return fallback;
  }
}

export async function analyzeFttWithGemini({ projectId, location = 'global', model = 'gemini-2.5-flash', prompt }) {
  const fallback = { direction: 'HOLD', confidence: 30, reasoning: 'AI analysis unavailable' };

  if (!isGeminiConfigured(projectId) || !prompt) return fallback;

  let response;
  try {
    response = await geminiGenerateContent({
      projectId,
      location,
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.15,
        topP: 0.9,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });
  } catch (error) {
    console.error(`[FTT Gemini] Request failed (${geminiAuthMode()}):`, error.message);
    return fallback;
  }

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    console.error(`[FTT Gemini] API error ${response.status}:`, message);
    return fallback;
  }

  try {
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const parsed = JSON.parse(stripCodeFences(text));

    const dir = String(parsed.direction || 'HOLD').toUpperCase();
    const validDirections = ['UP', 'DOWN', 'HOLD'];
    const verdict = String(parsed.final_verdict || '').toUpperCase();
    // Capital-protection discipline: if it's not a clean trade, stay flat.
    let direction = validDirections.includes(dir) ? dir : 'HOLD';
    if (['NO_TRADE', 'WAIT', 'TRADE_REJECTED'].includes(verdict)) direction = 'HOLD';

    let reasoning = enforceHonesty(String(parsed.reasoning || 'AI provided no reasoning.'));
    const bits = [];
    if (verdict) bits.push(verdict.replace(/_/g, ' '));
    if (parsed.market_regime) bits.push(`Regime: ${String(parsed.market_regime).replace(/_/g, ' ')}`);
    if (parsed.setup_score != null) bits.push(`Score: ${parsed.setup_score}/100`);
    if (bits.length) reasoning = `[${bits.join(' · ')}]\n${reasoning}`;

    return {
      direction,
      confidence: capConfidence(parsed.confidence ?? 30),
      reasoning,
    };
  } catch (error) {
    console.error('[FTT Gemini] Failed to parse response:', error.message);
    return fallback;
  }
}



// ─── Pullback & Timing Projection — on-demand AI validation ───────────────
// Runs ONLY when the user explicitly clicks "Run AI Projection". It validates
// the deterministic math zones produced by projectionEngine.computeProjections
// against live structure, indicators, ADR exhaustion and upcoming news, then
// returns a per-zone verdict (APPROVED / REJECTED / NEUTRAL).

function buildProjectionPrompt({ symbol, timeframe, currentPrice, atr, htfTrend, projections, context }) {
  const ctx = context || {};
  const zones = (projections || []).map((p) => ({
    id: p.id,
    source: p.source,
    bias: p.bias,
    order_type: p.orderType,
    entry_price: p.entryPrice,
    zone_top: p.zoneTop,
    zone_bottom: p.zoneBottom,
    distance_pips: Math.round(p.distancePips * 10) / 10,
    math_candles_to_reach: Math.round(p.candlesToReach * 10) / 10,
    math_minutes_to_reach: Math.round(p.minutesToReach),
    math_projected_touch_iso: p.projectedTouchIso,
    math_confidence: p.mathConfidence,
    suggested_stop_loss: p.stopLoss,
    suggested_take_profit: p.takeProfit1,
  }));

  const upcomingNews = Array.isArray(ctx.upcomingNews) ? ctx.upcomingNews : [];
  const newsBlock = upcomingNews.length
    ? JSON.stringify(upcomingNews, null, 2)
    : 'No high/medium-impact events for the relevant currencies in the next 12 hours.';

  return `${TRADER_DOCTRINE}

=== TASK: PROJECTIONS — SMC PULLBACK ZONE VALIDATION ===
You are validating, not inventing. A deterministic math engine has ALREADY located
unmitigated Order Blocks / open Fair Value Gaps and computed WHEN price should reach each
zone (distance / ATR). That timing math is GROUND TRUTH — anchor to it; you may refine it
into a human range but must NOT contradict it without a stated reason. Your job is to
VALIDATE each zone using live structure, candle behaviour, indicators, ADR exhaustion and
news, and to apply the capital-protection doctrine above (reject low-quality zones).

Symbol: ${symbol}
Working timeframe: ${timeframe}
Current price: ${currentPrice}
ATR per candle: ${atr}
Higher-timeframe bias: ${htfTrend}

--- LIVE CONTEXT ---
Indicators: ${JSON.stringify(ctx.indicators || {}, null, 2)}
Market structure: BOS/CHOCH=${ctx.structure || 'n/a'}, regime=${ctx.regime || 'n/a'}, ADX=${ctx.adx ?? 'n/a'}
ADR usage: ${ctx.adrUsagePercent != null ? ctx.adrUsagePercent.toFixed(0) + '%' : 'n/a'} (exhausted=${ctx.adrExhausted ? 'YES' : 'no'})
Recent candles (last is the live forming bar):
${JSON.stringify(ctx.recentCandles || [], null, 2)}

--- UPCOMING ECONOMIC CALENDAR (next 12h) ---
${newsBlock}

--- MATH PULLBACK ZONES TO VALIDATE ---
${JSON.stringify(zones, null, 2)}

RULES:
- Look for confirmation that price is likely to actually reach and react at each zone
  (rejection wicks, engulfing, momentum, liquidity resting beyond the level).
- If a HIGH-impact event is within ~30 minutes of the projected touch time, mark the zone
  NEUTRAL or REJECTED and widen the stop.
- If ADR is exhausted (>=90%), be skeptical of continuation; favour reversals.
- "direction_after_touch" is the expected move AFTER price taps the zone (UP = bounce up,
  DOWN = reject down). It should usually match the zone bias unless you see a reason it fails.
- Keep "predicted_time_to_reach" a human range (e.g. "in 20-30 minutes", "~1.5 hours"),
  anchored to the math estimate but adjusted for current session momentum.
- trade_type is an array; include "FOREX" only when the higher-timeframe bias supports a
  limit order in that direction, and "FTT" when a fixed-time expiry play is viable.

Return STRICT JSON ONLY:
{
  "validations": [
    {
      "id": "<echo the zone id>",
      "status": "APPROVED|REJECTED|NEUTRAL",
      "optimal_entry": number,
      "predicted_time_to_reach": "string",
      "direction_after_touch": "UP|DOWN",
      "trade_type": ["FOREX","FTT"],
      "ftt_expiry_recommended": "2m|3m|5m|15m|30m|1h",
      "stop_loss": number,
      "take_profit": number,
      "confidence": 0-100,
      "rationale": "concise SMC explanation"
    }
  ],
  "overall_summary": "one or two sentences on the best zone and overall read"
}`;
}

export async function analyzeProjectionWithGemini({
  projectId,
  location = 'global',
  model = 'gemini-2.5-flash',
  symbol,
  timeframe,
  currentPrice,
  atr,
  htfTrend,
  projections = [],
  context = {},
}) {
  const fallback = {
    available: false,
    validations: [],
    overall_summary: 'AI validation unavailable — showing deterministic math projections only.',
  };

  if (!isGeminiConfigured(projectId) || !projections.length) return fallback;

  // Enrich context with upcoming news for the symbol (next 12h).
  let upcomingNews = [];
  try {
    upcomingNews = getUpcomingForSymbol(symbol || '', Date.now(), 12).map((e) => ({
      currency: e.currency,
      impact: e.impact,
      title: e.title,
      in_minutes: Math.round((e.timestampUtc - Date.now()) / 60000),
      forecast: e.forecast,
      previous: e.previous,
    }));
  } catch { /* news optional */ }

  const prompt = buildProjectionPrompt({
    symbol,
    timeframe,
    currentPrice,
    atr,
    htfTrend,
    projections,
    context: { ...context, upcomingNews },
  });

  let response;
  try {
    response = await geminiGenerateContent({
      projectId,
      location,
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });
  } catch (error) {
    console.error(`[Projection Gemini] Request failed (${geminiAuthMode()}):`, error.message);
    return { ...fallback, overall_summary: `AI validation unavailable: Gemini auth failed (${geminiAuthMode()}).` };
  }

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    // Mirror the auto-fallback used elsewhere: pro -> flash on quota/availability errors.
    if (model === 'gemini-2.5-pro') {
      console.warn(`[Projection Gemini] pro failed (${response.status}); retrying with flash.`);
      return analyzeProjectionWithGemini({
        projectId, location, model: 'gemini-2.5-flash',
        symbol, timeframe, currentPrice, atr, htfTrend, projections, context,
      });
    }
    console.error(`[Projection Gemini] API error ${response.status}:`, message);
    return { ...fallback, overall_summary: `AI validation failed: Vertex AI returned ${response.status}.` };
  }

  try {
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const parsed = JSON.parse(stripCodeFences(text));
    const validations = Array.isArray(parsed.validations) ? parsed.validations : [];
    return {
      available: true,
      validations: validations.map((v) => ({
        id: String(v.id || ''),
        status: ['APPROVED', 'REJECTED', 'NEUTRAL'].includes(String(v.status || '').toUpperCase())
          ? String(v.status).toUpperCase()
          : 'NEUTRAL',
        optimal_entry: v.optimal_entry ?? null,
        predicted_time_to_reach: String(v.predicted_time_to_reach || ''),
        direction_after_touch: String(v.direction_after_touch || '').toUpperCase() === 'DOWN' ? 'DOWN' : 'UP',
        trade_type: Array.isArray(v.trade_type) ? v.trade_type : [],
        ftt_expiry_recommended: String(v.ftt_expiry_recommended || ''),
        stop_loss: v.stop_loss ?? null,
        take_profit: v.take_profit ?? null,
        confidence: capConfidence(v.confidence ?? 0),
        rationale: enforceHonesty(String(v.rationale || '')),
      })),
      overall_summary: enforceHonesty(String(parsed.overall_summary || '')),
    };
  } catch (error) {
    console.error('[Projection Gemini] Failed to parse response:', error.message);
    return fallback;
  }
}

export function buildAiSignalsPrompt({ symbol, tradeMode, indicators, news, currentPrice }) {
  const newsBlock = news && news.length 
    ? JSON.stringify(news, null, 2)
    : "No major scheduled news releases in the next 12 hours.";

  const regimeGuidelines = `
REGIME-BASED INDICATOR WEIGHTING:
- TRENDING REGIME (ADX > 40):
  - Prioritize Trend-Following indicators: EMA Stack alignment (EMA20 vs EMA50 vs EMA200), Aroon state, Ichimoku TK cross.
  - De-emphasize/Discount simple oscillator signals (RSI/Stochastic overbought/oversold levels) because oscillators can stay overextended for long periods in strong trends.
- RANGING REGIME (ADX < 20):
  - Prioritize Oscillator and Boundary indicators: RSI rebounds, Stochastic crossovers, and Bollinger Bands outer limits.
  - De-emphasize/Discount trend indicators like EMA crosses or Ichimoku crosses, as they will generate whipsaws.
`;

  return `${TRADER_DOCTRINE}

=== TASK: CLINICAL ON-DEMAND MARKET ANALYSIS ===
You are an advanced Algorithmic Market Observer. You have been provided with pre-calculated mathematical indicators and upcoming news events for ${symbol} in ${tradeMode === 'FTT' ? 'Fixed Time Trade (FTT)' : 'Forex Trade'} mode.

Your task is to analyze these indicators, determine the current market regime, weigh the indicators accordingly, and produce a clinical Market Observation report and trading decision.

Symbol: ${symbol}
Trade Mode: ${tradeMode}
Current Price: ${currentPrice}

--- MATHEMATICAL INDICATORS PRE-CALCULATED PAYLOAD ---
${JSON.stringify(indicators, null, 2)}

--- ECONOMIC CALENDAR NEWS ---
${newsBlock}

${regimeGuidelines}

--- ANALYSIS DIRECTIONS ---
1. Evaluate the ADX value to classify the regime as TRENDING (ADX > 40), RANGING (ADX < 20), or NORMAL (ADX 20-40).
2. Weight the indicators according to the regime.
3. Analyze the support and resistance levels provided in the "supportResistance" indicators payload. Use these well-formed horizontal zones to justify your entryPrice, stopLoss, and invalidation points (e.g., placing invalidation levels strictly behind major support or resistance boundaries).
4. If FTT mode is selected, project the price action for the next 1 hour. Look at Heikin-Ashi trends, Japanese Pearl TK crosses, and Japanese Trend rules.
5. If Forex mode is selected, calculate risk management parameters including entry price, logical stop loss, three profit targets (TP1, TP2, TP3), and risk-to-reward ratio.
6. In your clinicalReport:
   - Provide a professional, structured Markdown report (using appropriate headings, bullets, and bold text).
   - Detail the regime classification and why you chose it.
   - Describe the support and resistance levels found and how price reacts near them.
   - Reconcile the conflicting signals (e.g. RSI overbought in an uptrend, or EMA cross in a range).
   - Reference the news events and how they affect volatility.
   - Describe the invalidation point (where the trade idea becomes invalid).
   - Write clinical recommendations for the next hour.
   - Do NOT use exaggerated language or guarantee success. Keep a serious, medical/clinical tone.

Return STRICT JSON ONLY:
{
  "decision": "STRONG_BUY|BUY|HOLD|SELL|STRONG_SELL",
  "confidence": 0-95,
  "entryPrice": number,
  "atr": number,
  "stopLoss": number,
  "takeProfit1": number,
  "takeProfit2": number,
  "takeProfit3": number,
  "invalidation": "the structural level that invalidates the trade setup",
  "riskLevel": "LOW|MEDIUM|HIGH",
  "tradeTrigger": "IMMEDIATE|LIMIT_PULLBACK|BREAKOUT_CONFIRMATION|HOLD_NO_TRADE",
  "predictedTime": "e.g. 'Immediate / Next 15 mins', 'Within the hour'",
  "clinicalReport": "markdown formatted report"
}
`;
}

export async function analyzeAiSignalsWithGemini({
  projectId,
  location = 'global',
  model = 'gemini-2.5-flash',
  symbol,
  tradeMode,
  indicators,
  news,
  currentPrice
}) {
  const fallback = {
    decision: 'HOLD',
    confidence: 30,
    entryPrice: currentPrice,
    atr: indicators.atr || null,
    stopLoss: null,
    takeProfit1: null,
    takeProfit2: null,
    takeProfit3: null,
    invalidation: 'Fallback mode active due to AI error.',
    riskLevel: 'MEDIUM',
    tradeTrigger: 'HOLD_NO_TRADE',
    predictedTime: 'Unavailable',
    clinicalReport: '### Fallback Report\\nGemini AI is currently unavailable. Deterministic mathematical backup signals show a HOLD stance.'
  };

  if (!isGeminiConfigured(projectId)) return fallback;

  const prompt = buildAiSignalsPrompt({ symbol, tradeMode, indicators, news, currentPrice });

  let response;
  try {
    response = await geminiGenerateContent({
      projectId,
      location,
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.15,
        topP: 0.9,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });
  } catch (error) {
    console.error(`[AI Signals Gemini] Request failed (${geminiAuthMode()}):`, error.message);
    return fallback;
  }

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    if (model === 'gemini-2.5-pro') {
      console.warn(`[AI Signals Gemini] pro failed (${response.status}); retrying with flash.`);
      return analyzeAiSignalsWithGemini({
        projectId, location, model: 'gemini-2.5-flash',
        symbol, tradeMode, indicators, news, currentPrice
      });
    }
    console.error(`[AI Signals Gemini] API error ${response.status}:`, message);
    return fallback;
  }

  try {
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const parsed = JSON.parse(stripCodeFences(text));

    const finalVerdict = String(parsed.decision || 'HOLD').toUpperCase();
    let decision = normalizeDecision(finalVerdict);

    return {
      decision,
      confidence: capConfidence(parsed.confidence ?? 30),
      entryPrice: parsed.entryPrice ?? currentPrice,
      atr: parsed.atr ?? indicators.atr ?? null,
      stopLoss: parsed.stopLoss ?? null,
      takeProfit1: parsed.takeProfit1 ?? null,
      takeProfit2: parsed.takeProfit2 ?? null,
      takeProfit3: parsed.takeProfit3 ?? null,
      invalidation: enforceHonesty(String(parsed.invalidation || 'None')),
      riskLevel: String(parsed.riskLevel || 'MEDIUM').toUpperCase(),
      tradeTrigger: parsed.tradeTrigger || (decision === 'HOLD' ? 'HOLD_NO_TRADE' : 'IMMEDIATE'),
      predictedTime: parsed.predictedTime || 'Within the hour',
      clinicalReport: enforceHonesty(String(parsed.clinicalReport || 'No report generated.'))
    };
  } catch (error) {
    console.error('[AI Signals Gemini] Failed to parse response:', error.message);
    return fallback;
  }
}
