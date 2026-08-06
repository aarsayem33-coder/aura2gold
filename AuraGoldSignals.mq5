//+------------------------------------------------------------------+
//|                                             AuraGoldSignals.mq5  |
//|                                  Copyright 2026, Aura Gold Corp  |
//|                                       https://www.auragold.com   |
//|                                                                  |
//| Expert Advisor to stream market alerts, heartbeats, and trade    |
//| events from MetaTrader 5 to the Aura Gold dashboard.            |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Aura Gold Corp"
#property link      "https://www.auragold.com"
#property version   "1.03"
#property description "Streams alerts and heartbeats to Aura Gold dashboard."

//--- input parameters
input group             "API Config"
input string            InpServerUrl     = "http://127.0.0.1:5000"; // API Server URL (no trailing slash)
input int               InpTimeout       = 5000;                    // Request Timeout (ms)
input bool              InpDiagnostics   = true;                    // Print connection/symbol diagnostics

input group             "Heartbeat Settings"
input bool              InpSendHeartbeat = true;                    // Enable Heartbeats
input int               InpHeartbeatSec  = 60;                      // Heartbeat Interval (seconds)

input group             "Snapshot Settings"
input bool              InpSendSnapshot  = true;                    // Send Account/Candles/Trades/Indicators Snapshot
input int               InpSnapshotSec   = 5;                       // Snapshot Interval (seconds)
input string            InpSymbols       = "XAUUSD,EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD,EURJPY,GBPJPY,USTEC"; // Symbols CSV (* = all). Curated set + Nasdaq (USTEC resolves to broker USTECm)
input int               InpMaxSymbols    = 0;                       // Max auto symbols, 0 = unlimited
input string            InpTimeframes    = "*";                     // Timeframes CSV, * = all MT5 timeframes
input int               InpBarsPerTf     = 200;                      // Candles per symbol/timeframe
input int               InpSnapshotSymbolsPerBatch = 1;             // Symbols per snapshot request
input bool              InpSendIndicators = true;                  // Include indicator payloads in snapshots
input bool              InpSyncOnStartup = true;                    // Sync priority symbols on startup
input int               InpSyncCandlesLimit = 4000;                 // Sync candle history depth (4000 is ample for 200-period indicators)

input group             "Economic Calendar (Native MT5 News)"
input bool              InpSendNews      = true;                    // Push MT5 economic calendar events to backend
input int               InpNewsSec       = 1800;                    // News push interval (seconds, default 30 min)
input int               InpNewsDaysAhead = 7;                       // Days of upcoming events to send
input int               InpNewsDaysBack  = 1;                       // Days of past events to send (for "minutes ago" window)
input int               InpNewsDeltaSec  = 7;                       // Fast delta poll for actual values (seconds)

input group             "Real-Time Priority Symbols"
input bool              InpSendPriorityRT = true;                   // Stream curated symbols in real time every second
input string            InpPrioritySymbols   = "XAUUSD,EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD,EURJPY,GBPJPY,USTEC"; // Curated liquid symbols kept real-time (USTEC = Nasdaq/USTECm)
input string            InpPriorityTimeframes = "M1,M5,M15";        // Timeframes kept real-time for priority symbols

input group             "Auto Trading Bridge"
input bool              InpAutoTrade     = true;                    // Enable trade bridge (backend gates all trading)
input int               InpTradePollSec  = 3;                       // Trade command poll interval (seconds)
input long              InpTradeMagic    = 990045;                  // Magic number for Aura auto-trades
input int               InpTradeSlippage = 30;                      // Max slippage (points)
input int               InpHistoryHours  = 48;                      // Reconciliation window (hours of closed-trade history to re-push)

input group             "Manual Trade Reporting"
input bool              InpReportManualTrades = true;               // Import future manual MT5 closes into Auto Trade Report
input int               InpManualReportSec = 60;                    // Manual close reconciliation interval (seconds)

input group             "Alert Settings"
input bool              InpTrackTrades   = true;                    // Send Alerts on Trades (Open/Close)
input bool              InpTrackSMACross = false;                   // Send Alerts on SMA Crossover
input ENUM_TIMEFRAMES   InpSMAtimeframe  = PERIOD_M15;              // SMA Timeframe
input int               InpFastSmaPeriod = 10;                      // Fast SMA Period
input int               InpSlowSmaPeriod = 20;                      // Slow SMA Period

//--- global variables
int      timer_ticks      = 0;
datetime last_heartbeat   = 0;
datetime last_trade_poll  = 0;
datetime last_manual_report = 0;
datetime g_manual_history_activated = 0;
datetime g_manual_history_cursor = 0;
long     g_manual_history_scope = 0;
long     g_known_positions[];       // magic-filtered position ids seen last poll (close detection)
bool     g_known_positions_primed = false;
int      g_spec_tick      = 0;      // 0 = include broker contract specs on this poll
int      g_history_tick   = 0;      // 0 = run the closed-trade reconciliation sweep on this poll
datetime last_snapshot    = 0;
datetime last_live_candle = 0;
datetime last_sma_alert   = 0;
datetime last_news        = 0;
datetime last_news_delta  = 0;
ulong    g_calendar_change_id = 0;
string   g_realtime_symbols[];      // resolved broker names for InpPrioritySymbols
bool     g_realtime_resolved = false;
int      fast_sma_handle  = INVALID_HANDLE;
int      slow_sma_handle  = INVALID_HANDLE;
int      snapshot_symbol_cursor = 0;
string   g_active_symbol  = "";
string   g_active_timeframe = "";

//--- synchronization state variables
enum ENUM_SYNC_STATE {
   SYNC_STATE_IDLE,
   SYNC_STATE_RESOLVING,
   SYNC_STATE_SYNCING,
   SYNC_STATE_COMPLETE
};

ENUM_SYNC_STATE g_sync_state = SYNC_STATE_IDLE;
string g_priority_pairs[] = {
   "XAUUSD",
   "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURJPY", "GBPJPY"
};
string g_sync_symbols[];            // Resolved symbols to sync
int    g_sync_symbol_index = 0;
int    g_sync_timeframe_index = 0;
int    g_sync_retry_count = 0;
int    g_sync_last_bars = 0;
int    g_sync_chunk_start = 0;


//--- structure for requests
struct RequestData {
   string method;
   string path;
   string body;
};

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   Print("Aura Gold EA Initializing...");
   PrintStartupDiagnostics();
   
   if(InpReportManualTrades) ManualHistoryInit();

   // Set timer for heartbeats, snapshots and independent manual trade reporting.
   if(InpSendHeartbeat || InpSendSnapshot || InpReportManualTrades)
   {
      EventSetTimer(1); // Check every second for interval matching
   }
   
   // Initialize indicators if SMA crossover tracking is enabled
   if(InpTrackSMACross)
   {
      fast_sma_handle = iMA(_Symbol, InpSMAtimeframe, InpFastSmaPeriod, 0, MODE_SMA, PRICE_CLOSE);
      slow_sma_handle = iMA(_Symbol, InpSMAtimeframe, InpSlowSmaPeriod, 0, MODE_SMA, PRICE_CLOSE);
      
      if(fast_sma_handle == INVALID_HANDLE || slow_sma_handle == INVALID_HANDLE)
      {
         Print("Error initializing SMA indicators.");
         return(INIT_FAILED);
      }
   }
   
   // Send initial status to the Aura dashboard.
   SendHeartbeat();
   if(InpSyncOnStartup)
   {
      g_sync_state = SYNC_STATE_IDLE;
      g_sync_chunk_start = 0;
   }
   else
   {
      g_sync_state = SYNC_STATE_COMPLETE;
      SendSnapshot();
   }
   
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("Aura Gold EA Deinitializing...");
   // Hand the trade bridge over immediately rather than leaving the next chart to wait out the
   // lease. Changing a chart's timeframe deinitialises and reinitialises the EA, so without this
   // the bridge would go quiet for up to the lease duration on every timeframe switch.
   TradeBridgeReleaseLeadership();
   if(InpSendHeartbeat || InpSendSnapshot || InpReportManualTrades)
   {
      EventKillTimer();
   }
   
   if(fast_sma_handle != INVALID_HANDLE) IndicatorRelease(fast_sma_handle);
   if(slow_sma_handle != INVALID_HANDLE) IndicatorRelease(slow_sma_handle);
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // Check SMA Crossover if enabled
   if(InpTrackSMACross)
   {
      CheckSmaCrossover();
   }

   // Push the live candle on incoming ticks for true real-time updates, but throttle
   // to at most once per second so the synchronous WebRequest never floods/blocks the
   // tick handler. Skip entirely while the startup history sync is still running.
   if(InpSendSnapshot && (!InpSyncOnStartup || g_sync_state == SYNC_STATE_COMPLETE))
   {
      datetime now = TimeLocal();
      if(now - last_live_candle >= 1)
      {
         SendLiveCandle();
      }
   }
}

//+------------------------------------------------------------------+
//| Timer function                                                   |
//+------------------------------------------------------------------+
void OnTimer()
{
   datetime now = TimeLocal();

   // Heartbeat and manual-history are ACCOUNT-WIDE, not per-chart: they describe the terminal
   // and the account, so sending them from every chart is the same fact repeated N times.
   //
   // With 24 charts attached this was the traffic that starved the feed — 1,512 failed POSTs
   // (err 5203) — and a failed heartbeat is exactly what makes the backend declare the EA
   // disconnected after 120s. Leader-gating them is what keeps the connection up.
   //
   // Live candles below are deliberately NOT gated: each chart streams its OWN symbol and
   // timeframe, so that traffic is distinct work rather than duplication.
   bool bridge_leader = TradeBridgeIsLeader();

   if(InpSendHeartbeat && bridge_leader && (now - last_heartbeat >= InpHeartbeatSec))
   {
      SendHeartbeat();
   }

   // Reporting is independent of auto execution. Enabling this never polls for or places
   // an order; it only imports manual positions closed after the feature was activated.
   if(InpReportManualTrades && bridge_leader && (now - last_manual_report >= MathMax(10, InpManualReportSec)))
   {
      last_manual_report = now;
      ManualHistoryReport();
   }

   // Auto-trading bridge: poll the backend for approved trade commands, execute them,
   // and report closed positions. Runs even during history sync — a trade command is
   // time-critical. The backend gates everything (mode/filters/caps/armed account).
   //
   // ONE INSTANCE ONLY — see TradeBridgeIsLeader(). The bridge is account-wide, not per-chart,
   // and 24 charts each polling it produced ~8 requests/second, 1,512 failed POSTs, eleven
   // duplicate reports of a single position close, and commands that executed at the broker but
   // could never report back ("EA picked the command up but never reported a result").
   if(InpAutoTrade && bridge_leader && (now - last_trade_poll >= InpTradePollSec))
   {
      last_trade_poll = now;
      TradeBridgePoll();
   }

   // ALWAYS keep real-time data flowing, even while the background history sync runs.
   // The live/active candle and the curated priority symbols must never go stale just
   // because a deep sync is in progress — otherwise analysis reports "outdated data".
   SendLiveCandle();
   if(InpSendPriorityRT)
   {
      SendPriorityCandles();
   }

   if(InpSyncOnStartup && g_sync_state != SYNC_STATE_COMPLETE)
   {
      RunHistorySync();
      return; // Background history sync; live data above already sent this tick.
   }

   // The heavy account/candles/indicators snapshot runs on its own slower cadence.
   if(InpSendSnapshot && (now - last_snapshot >= InpSnapshotSec))
   {
      SendSnapshot();
   }

   // Economic calendar push runs on its own slow cadence (default every 30 min).
   if(InpSendNews && (last_news == 0 || now - last_news >= InpNewsSec))
   {
      SendEconomicCalendar();
   }

   // Fast delta poll for actual values (default every 7s) — near-real-time releases.
   if(InpSendNews && (last_news_delta == 0 || now - last_news_delta >= InpNewsDeltaSec))
   {
      SendCalendarDelta();
   }
}

//+------------------------------------------------------------------+
//| Send full account/candles/trades snapshot                        |
//+------------------------------------------------------------------+
void SendSnapshot()
{
   if(!InpSendSnapshot) return;

   string url = InpServerUrl + "/api/mt5/snapshot";
   string headers = "Content-Type: application/json\r\n";

   long account = AccountInfoInteger(ACCOUNT_LOGIN);
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   string currency = AccountInfoString(ACCOUNT_CURRENCY);
   string symbols[];
   int symbol_count = GetConfiguredSymbols(symbols);
   int batch_size = InpSnapshotSymbolsPerBatch;
   if(batch_size <= 0) batch_size = 1;
   if(symbol_count > 0 && snapshot_symbol_cursor >= symbol_count) snapshot_symbol_cursor = 0;
   int batch_start = snapshot_symbol_cursor;

   string body = "{"
      "\"account\":\"" + IntegerToString(account) + "\"," 
      "\"broker\":\"" + EscapeString(broker) + "\"," 
      "\"terminal\":\"MetaTrader 5\"," 
      "\"version\":\"1.03\"," 
      "\"snapshotBatchStart\":" + IntegerToString(batch_start) + ","
      "\"snapshotBatchSize\":" + IntegerToString(batch_size) + ","
      "\"snapshotSymbolCount\":" + IntegerToString(symbol_count) + ","
      "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ","
      "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ","
      "\"margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ","
      "\"freeMargin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ","
      "\"profit\":" + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2) + ","
      "\"currency\":\"" + EscapeString(currency) + "\","
      "\"leverage\":" + IntegerToString((int)AccountInfoInteger(ACCOUNT_LEVERAGE)) + ","
      "\"marginLevel\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) + ","
      "\"openOrders\":" + IntegerToString(OrdersTotal()) + ","
      "\"openTrades\":" + IntegerToString(PositionsTotal()) + ","
      "\"symbols\":" + BuildSymbolsJsonFromArray(symbols) + ","
      "\"timeframes\":" + BuildTimeframesJson() + ","
      "\"candles\":" + BuildCandlesJsonForSymbols(symbols, batch_start, batch_size) + ","
      "\"indicators\":" + (InpSendIndicators ? BuildIndicatorsJsonForSymbols(symbols, batch_start, batch_size) : "[]") + ","
      "\"trades\":" + BuildTradesJson() + ","
      "\"signals\":[]" +
   "}";

   char post_bytes[];
   char result[];
   string result_headers;

   ArrayResize(post_bytes, StringLen(body));
   StringToCharArray(body, post_bytes, 0, StringLen(body), CP_UTF8);

   ResetLastError();
   int res = WebRequest("POST", url, headers, InpTimeout, post_bytes, result, result_headers);

   if(res == -1)
   {
      int err = GetLastError();
      Print("Snapshot WebRequest failed. Error code: ", err, ", URL: ", url, ", payload bytes: ", ArraySize(post_bytes));
      if(err == 4014)
      {
         Print("CRITICAL: WebRequest function not allowed! Add '", InpServerUrl, "' in Tools -> Options -> Expert Advisors.");
      }
   }
   else
   {
      last_snapshot = TimeLocal();
      if(res >= 200 && res < 300) ParseBackendResponse(result);
      if(symbol_count > 0) snapshot_symbol_cursor = (batch_start + batch_size) % symbol_count;
      int batch_end = batch_start + batch_size;
      if(batch_end > symbol_count) batch_end = symbol_count;
      Print("Aura snapshot sent successfully. Response code: ", res, ", symbols ", batch_start, "-", batch_end - 1, " of ", symbol_count, ", payload bytes: ", ArraySize(post_bytes), ", response: ", ResponseSnippet(result));
   }
}

//+------------------------------------------------------------------+
//| Send native MT5 economic calendar events to the backend           |
//+------------------------------------------------------------------+
void SendEconomicCalendar()
{
   if(!InpSendNews) return;

   datetime from = TimeTradeServer() - (datetime)InpNewsDaysBack  * 86400;
   datetime to   = TimeTradeServer() + (datetime)InpNewsDaysAhead * 86400;

   MqlCalendarValue values[];
   int total = CalendarValueHistory(values, from, to, NULL, NULL);
   if(total <= 0)
   {
      // 0 is normal off-hours; -1 means the terminal has no calendar (broker/Strategy Tester).
      if(InpDiagnostics) Print("Aura news: CalendarValueHistory returned ", total, " (error ", GetLastError(), "). Calendar may be unavailable on this server / tester.");
      return;
   }

   // Server-to-GMT offset so the backend can normalise event times to UTC.
   long serverGmtOffsetSec = (long)(TimeTradeServer() - TimeGMT());

   string items = "";
   int sent = 0;
   for(int i = 0; i < total; i++)
   {
      MqlCalendarEvent event;
      if(!CalendarEventById(values[i].event_id, event)) continue;

      // Skip purely informational / no-impact rows to keep the payload lean.
      if(event.importance == CALENDAR_IMPORTANCE_NONE) continue;

      MqlCalendarCountry country;
      string currency = "";
      if(CalendarCountryById(event.country_id, country)) currency = country.currency;

      // actual / forecast / previous are stored as long scaled by 1e6; LONG_MIN = no value.
      string actual   = (values[i].actual_value   != LONG_MIN) ? DoubleToString(values[i].actual_value   / 1000000.0, 4) : "null";
      string forecast = (values[i].forecast_value != LONG_MIN) ? DoubleToString(values[i].forecast_value / 1000000.0, 4) : "null";
      string previous = (values[i].prev_value     != LONG_MIN) ? DoubleToString(values[i].prev_value     / 1000000.0, 4) : "null";

      if(sent > 0) items += ",";
      items += "{"
         "\"id\":\"" + IntegerToString(values[i].id) + "\","
         "\"time\":" + IntegerToString((long)values[i].time) + ","
         "\"currency\":\"" + EscapeString(currency) + "\","
         "\"impact\":" + IntegerToString((int)event.importance) + ","
         "\"title\":\"" + EscapeString(event.name) + "\","
         "\"actual\":" + actual + ","
         "\"forecast\":" + forecast + ","
         "\"previous\":" + previous +
      "}";
      sent++;
   }

   string body = "{"
      "\"source\":\"mt5-ea\","
      "\"serverGmtOffsetSec\":" + IntegerToString(serverGmtOffsetSec) + ","
      "\"events\":[" + items + "]"
   "}";

   string url = InpServerUrl + "/api/mt5/news";
   string headers = "Content-Type: application/json\r\n";

   char post_bytes[];
   char result[];
   string result_headers;
   ArrayResize(post_bytes, StringLen(body));
   StringToCharArray(body, post_bytes, 0, StringLen(body), CP_UTF8);

   ResetLastError();
   int res = WebRequest("POST", url, headers, InpTimeout, post_bytes, result, result_headers);
   if(res == -1)
   {
      int err = GetLastError();
      Print("Aura news WebRequest failed. Error code: ", err, ", URL: ", url);
      if(err == 4014) Print("CRITICAL: WebRequest not allowed! Add '", InpServerUrl, "' in Tools -> Options -> Expert Advisors.");
   }
   else
   {
      last_news = TimeLocal();
      if(InpDiagnostics) Print("Aura news sent: ", sent, " events (offset ", serverGmtOffsetSec, "s, server time ", TimeToString(TimeTradeServer()), ", GMT ", TimeToString(TimeGMT()), "). Response: ", res);
   }
}

//+------------------------------------------------------------------+
//| Fast delta poll: push only changed calendar values (actuals)      |
//+------------------------------------------------------------------+
void SendCalendarDelta()
{
   if(!InpSendNews) return;

   MqlCalendarValue values[];
   int total = CalendarValueLast(g_calendar_change_id, values, NULL, NULL);
   last_news_delta = TimeLocal();
   if(total <= 0) return; // nothing changed since last poll (the common case)

   long serverGmtOffsetSec = (long)(TimeTradeServer() - TimeGMT());

   string items = "";
   int sent = 0;
   for(int i = 0; i < total; i++)
   {
      MqlCalendarEvent event;
      if(!CalendarEventById(values[i].event_id, event)) continue;
      if(event.importance == CALENDAR_IMPORTANCE_NONE) continue;

      MqlCalendarCountry country;
      string currency = "";
      if(CalendarCountryById(event.country_id, country)) currency = country.currency;

      string actual   = (values[i].actual_value   != LONG_MIN) ? DoubleToString(values[i].actual_value   / 1000000.0, 4) : "null";
      string forecast = (values[i].forecast_value != LONG_MIN) ? DoubleToString(values[i].forecast_value / 1000000.0, 4) : "null";
      string previous = (values[i].prev_value     != LONG_MIN) ? DoubleToString(values[i].prev_value     / 1000000.0, 4) : "null";

      if(sent > 0) items += ",";
      items += "{"
         "\"id\":\"" + IntegerToString(values[i].id) + "\","
         "\"time\":" + IntegerToString((long)values[i].time) + ","
         "\"currency\":\"" + EscapeString(currency) + "\","
         "\"impact\":" + IntegerToString((int)event.importance) + ","
         "\"title\":\"" + EscapeString(event.name) + "\","
         "\"actual\":" + actual + ","
         "\"forecast\":" + forecast + ","
         "\"previous\":" + previous +
      "}";
      sent++;
   }
   if(sent == 0) return;

   string body = "{"
      "\"source\":\"mt5-ea\","
      "\"serverGmtOffsetSec\":" + IntegerToString(serverGmtOffsetSec) + ","
      "\"events\":[" + items + "]"
   "}";

   string url = InpServerUrl + "/api/mt5/news/delta";
   string headers = "Content-Type: application/json\r\n";
   char post_bytes[];
   char result[];
   string result_headers;
   ArrayResize(post_bytes, StringLen(body));
   StringToCharArray(body, post_bytes, 0, StringLen(body), CP_UTF8);

   ResetLastError();
   int res = WebRequest("POST", url, headers, InpTimeout, post_bytes, result, result_headers);
   if(res == -1)
   {
      int err = GetLastError();
      if(err == 4014) Print("CRITICAL: WebRequest not allowed for ", InpServerUrl);
   }
   else if(InpDiagnostics)
   {
      Print("Aura news delta sent: ", sent, " changed value(s). Response: ", res);
   }
}

//+------------------------------------------------------------------+
//| Print account/API/symbol diagnostics                              |
//+------------------------------------------------------------------+
void PrintStartupDiagnostics()
{
   if(!InpDiagnostics) return;

   string symbols[];
   ENUM_TIMEFRAMES periods[];
   string labels[];
   int symbol_count = GetConfiguredSymbols(symbols);
   int timeframe_count = GetConfiguredTimeframes(periods, labels);

   Print("Aura diagnostics: account=", AccountInfoInteger(ACCOUNT_LOGIN),
         ", company=", AccountInfoString(ACCOUNT_COMPANY),
         ", server=", AccountInfoString(ACCOUNT_SERVER),
         ", chartSymbol=", _Symbol,
         ", serverUrl=", InpServerUrl,
         ", symbolsInput=", InpSymbols,
         ", maxSymbols=", InpMaxSymbols,
         ", timeframesInput=", InpTimeframes,
         ", barsPerTf=", InpBarsPerTf,
         ", snapshotSymbolsPerBatch=", InpSnapshotSymbolsPerBatch,
         ", sendIndicators=", InpSendIndicators);
   Print("Aura diagnostics: broker symbols scanned=", SymbolsTotal(false),
         ", selected symbols=", symbol_count,
         ", selected timeframes=", timeframe_count);

   string symbol_preview = "";
   int max_symbols = symbol_count;
   if(max_symbols > 25) max_symbols = 25;
   for(int i = 0; i < max_symbols; i++)
   {
      if(i > 0) symbol_preview += ",";
      symbol_preview += symbols[i];
   }
   if(symbol_count > max_symbols) symbol_preview += ",...";
   Print("Aura diagnostics: selected symbols preview=", symbol_preview);

   string timeframe_preview = "";
   for(int i = 0; i < timeframe_count; i++)
   {
      if(i > 0) timeframe_preview += ",";
      timeframe_preview += labels[i];
   }
   Print("Aura diagnostics: selected timeframes=", timeframe_preview);
}

//+------------------------------------------------------------------+
//| Build configured symbol list JSON                                |
//+------------------------------------------------------------------+
string BuildSymbolsJson()
{
   string symbols[];
   int count = GetConfiguredSymbols(symbols);
   return BuildSymbolsJsonFromArray(symbols);
}

//+------------------------------------------------------------------+
//| Build symbol list JSON from an existing array                     |
//+------------------------------------------------------------------+
string BuildSymbolsJsonFromArray(string &symbols[])
{
   int count = ArraySize(symbols);
   string json = "[";
   for(int i = 0; i < count; i++)
   {
      if(i > 0) json += ",";
      json += "\"" + EscapeString(symbols[i]) + "\"";
   }
   json += "]";
   return json;
}

//+------------------------------------------------------------------+
//| Build configured timeframe list JSON                             |
//+------------------------------------------------------------------+
string BuildTimeframesJson()
{
   ENUM_TIMEFRAMES periods[];
   string labels[];
   int count = GetConfiguredTimeframes(periods, labels);
   string json = "[";
   for(int i = 0; i < count; i++)
   {
      if(i > 0) json += ",";
      json += "\"" + labels[i] + "\"";
   }
   json += "]";
   return json;
}

//+------------------------------------------------------------------+
//| Build candle payload for configured symbols/timeframes            |
//+------------------------------------------------------------------+
string BuildCandlesJson()
{
   string symbols[];
   int symbol_count = GetConfiguredSymbols(symbols);
   return BuildCandlesJsonForSymbols(symbols, 0, symbol_count);
}

//+------------------------------------------------------------------+
//| Build candle payload for a batch of configured symbols             |
//+------------------------------------------------------------------+
string BuildCandlesJsonForSymbols(string &symbols[], int start, int batch_count)
{
   ENUM_TIMEFRAMES periods[];
   string labels[];
   int symbol_count = ArraySize(symbols);
   int period_count = GetConfiguredTimeframes(periods, labels);
   int bars = MathMax(1, InpBarsPerTf);
   string json = "[";
   bool first = true;

   // 1. Always prioritize and append the active symbol candles first if set
   string active_sym = g_active_symbol;
   if(active_sym != "")
   {
      SymbolSelect(active_sym, true);
      int digits = (int)SymbolInfoInteger(active_sym, SYMBOL_DIGITS);
      for(int p = 0; p < period_count; p++)
      {
         MqlRates rates[];
         int copied = CopyRates(active_sym, periods[p], 0, bars, rates);
         if(copied <= 0) continue;
         ArraySetAsSeries(rates, true);
         for(int i = copied - 1; i >= 0; i--)
         {
            if(!first) json += ",";
            first = false;
            json += "{"
               "\"symbol\":\"" + EscapeString(active_sym) + "\","
               "\"timeframe\":\"" + labels[p] + "\","
               "\"time\":\"" + FormatIsoTime(rates[i].time) + "\","
               "\"open\":" + DoubleToString(rates[i].open, digits) + ","
               "\"high\":" + DoubleToString(rates[i].high, digits) + ","
               "\"low\":" + DoubleToString(rates[i].low, digits) + ","
               "\"close\":" + DoubleToString(rates[i].close, digits) + ","
               "\"volume\":" + IntegerToString((int)rates[i].tick_volume) + ","
               "\"spread\":" + IntegerToString((int)rates[i].spread) +
            "}";
         }
      }
   }

   // 2. Build the standard batch candles, skipping the active symbol to avoid duplicates
   int end = start + batch_count;
   if(start < 0) start = 0;
   if(end > symbol_count) end = symbol_count;

   for(int s = start; s < end; s++)
   {
      // Skip active symbol since it was already sent at the start
      if(symbols[s] == active_sym) continue;

      SymbolSelect(symbols[s], true);
      int digits = (int)SymbolInfoInteger(symbols[s], SYMBOL_DIGITS);

      for(int p = 0; p < period_count; p++)
      {
         MqlRates rates[];
         int copied = CopyRates(symbols[s], periods[p], 0, bars, rates);
         if(copied <= 0) continue;

         ArraySetAsSeries(rates, true);
         for(int i = copied - 1; i >= 0; i--)
         {
            if(!first) json += ",";
            first = false;
            json += "{"
               "\"symbol\":\"" + EscapeString(symbols[s]) + "\","
               "\"timeframe\":\"" + labels[p] + "\","
               "\"time\":\"" + FormatIsoTime(rates[i].time) + "\","
               "\"open\":" + DoubleToString(rates[i].open, digits) + ","
               "\"high\":" + DoubleToString(rates[i].high, digits) + ","
               "\"low\":" + DoubleToString(rates[i].low, digits) + ","
               "\"close\":" + DoubleToString(rates[i].close, digits) + ","
               "\"volume\":" + IntegerToString((int)rates[i].tick_volume) + ","
               "\"spread\":" + IntegerToString((int)rates[i].spread) +
            "}";
         }
      }
   }

   json += "]";
   return json;
}

//+------------------------------------------------------------------+
//| Build indicator payload for configured symbols/timeframes         |
//+------------------------------------------------------------------+
string BuildIndicatorsJson()
{
   string symbols[];
   int symbol_count = GetConfiguredSymbols(symbols);
   return BuildIndicatorsJsonForSymbols(symbols, 0, symbol_count);
}

//+------------------------------------------------------------------+
//| Build indicator payload for a batch of configured symbols          |
//+------------------------------------------------------------------+
string BuildIndicatorsJsonForSymbols(string &symbols[], int start, int batch_count)
{
   ENUM_TIMEFRAMES periods[];
   string labels[];
   int symbol_count = ArraySize(symbols);
   int period_count = GetConfiguredTimeframes(periods, labels);
   string json = "[";
   bool first = true;

   // 1. Always prioritize and append the active symbol indicators first if set
   string active_sym = g_active_symbol;
   if(active_sym != "")
   {
      SymbolSelect(active_sym, true);
      int digits = (int)SymbolInfoInteger(active_sym, SYMBOL_DIGITS);
      for(int p = 0; p < period_count; p++)
      {
         datetime candle_time = iTime(active_sym, periods[p], 1);
         if(candle_time == 0) candle_time = TimeCurrent();

         int rsi = iRSI(active_sym, periods[p], 14, PRICE_CLOSE);
         if(rsi != INVALID_HANDLE)
         {
            AppendIndicatorJson(json, first, active_sym, labels[p], candle_time, "RSI", BufferValue(rsi, 0, 1), EMPTY_VALUE, EMPTY_VALUE, EMPTY_VALUE, EMPTY_VALUE, 2);
            IndicatorRelease(rsi);
         }

         int macd = iMACD(active_sym, periods[p], 12, 26, 9, PRICE_CLOSE);
         if(macd != INVALID_HANDLE)
         {
            double main = BufferValue(macd, 0, 1);
            double signal = BufferValue(macd, 1, 1);
            double hist = (main == EMPTY_VALUE || signal == EMPTY_VALUE) ? EMPTY_VALUE : main - signal;
            AppendIndicatorJson(json, first, active_sym, labels[p], candle_time, "MACD", main, signal, hist, EMPTY_VALUE, EMPTY_VALUE, digits + 2);
            IndicatorRelease(macd);
         }

         int bands = iBands(active_sym, periods[p], 20, 0, 2.0, PRICE_CLOSE);
         if(bands != INVALID_HANDLE)
         {
            AppendIndicatorJson(json, first, active_sym, labels[p], candle_time, "BOLLINGER", BufferValue(bands, 0, 1), BufferValue(bands, 1, 1), BufferValue(bands, 2, 1), EMPTY_VALUE, EMPTY_VALUE, digits);
            IndicatorRelease(bands);
         }

         int atr = iATR(active_sym, periods[p], 14);
         if(atr != INVALID_HANDLE)
         {
            AppendIndicatorJson(json, first, active_sym, labels[p], candle_time, "ATR", BufferValue(atr, 0, 1), EMPTY_VALUE, EMPTY_VALUE, EMPTY_VALUE, EMPTY_VALUE, digits + 2);
            IndicatorRelease(atr);
         }

         int stochastic = iStochastic(active_sym, periods[p], 14, 3, 3, MODE_SMA, STO_LOWHIGH);
         if(stochastic != INVALID_HANDLE)
         {
            AppendIndicatorJson(json, first, active_sym, labels[p], candle_time, "STOCHASTIC", EMPTY_VALUE, EMPTY_VALUE, EMPTY_VALUE, BufferValue(stochastic, 0, 1), BufferValue(stochastic, 1, 1), 2);
            IndicatorRelease(stochastic);
         }

         int adx = iADX(active_sym, periods[p], 14);
         if(adx != INVALID_HANDLE)
         {
            AppendIndicatorJson(json, first, active_sym, labels[p], candle_time, "ADX", BufferValue(adx, 0, 1), EMPTY_VALUE, EMPTY_VALUE, BufferValue(adx, 1, 1), BufferValue(adx, 2, 1), 2);
            IndicatorRelease(adx);
         }

         AppendEmaIndicator(json, first, active_sym, periods[p], labels[p], candle_time, 9, digits);
         AppendEmaIndicator(json, first, active_sym, periods[p], labels[p], candle_time, 21, digits);
         AppendEmaIndicator(json, first, active_sym, periods[p], labels[p], candle_time, 50, digits);
         AppendEmaIndicator(json, first, active_sym, periods[p], labels[p], candle_time, 200, digits);
         AppendVolumeIndicator(json, first, active_sym, periods[p], labels[p], candle_time);
      }
   }

   // 2. Build standard batch indicators, skipping active symbol to avoid duplicates
   int end = start + batch_count;
   if(start < 0) start = 0;
   if(end > symbol_count) end = symbol_count;

   for(int s = start; s < end; s++)
   {
      if(symbols[s] == active_sym) continue;

      SymbolSelect(symbols[s], true);
      int digits = (int)SymbolInfoInteger(symbols[s], SYMBOL_DIGITS);

      for(int p = 0; p < period_count; p++)
      {
         datetime candle_time = iTime(symbols[s], periods[p], 1);
         if(candle_time == 0) candle_time = TimeCurrent();

         int rsi = iRSI(symbols[s], periods[p], 14, PRICE_CLOSE);
         if(rsi != INVALID_HANDLE)
         {
            AppendIndicatorJson(json, first, symbols[s], labels[p], candle_time, "RSI", BufferValue(rsi, 0, 1), EMPTY_VALUE, EMPTY_VALUE, EMPTY_VALUE, EMPTY_VALUE, 2);
            IndicatorRelease(rsi);
         }

         int macd = iMACD(symbols[s], periods[p], 12, 26, 9, PRICE_CLOSE);
         if(macd != INVALID_HANDLE)
         {
            double main = BufferValue(macd, 0, 1);
            double signal = BufferValue(macd, 1, 1);
            double hist = (main == EMPTY_VALUE || signal == EMPTY_VALUE) ? EMPTY_VALUE : main - signal;
            AppendIndicatorJson(json, first, symbols[s], labels[p], candle_time, "MACD", main, signal, hist, EMPTY_VALUE, EMPTY_VALUE, digits + 2);
            IndicatorRelease(macd);
         }

         int bands = iBands(symbols[s], periods[p], 20, 0, 2.0, PRICE_CLOSE);
         if(bands != INVALID_HANDLE)
         {
            AppendIndicatorJson(json, first, symbols[s], labels[p], candle_time, "BOLLINGER", BufferValue(bands, 0, 1), BufferValue(bands, 1, 1), BufferValue(bands, 2, 1), EMPTY_VALUE, EMPTY_VALUE, digits);
            IndicatorRelease(bands);
         }

         int atr = iATR(symbols[s], periods[p], 14);
         if(atr != INVALID_HANDLE)
         {
            AppendIndicatorJson(json, first, symbols[s], labels[p], candle_time, "ATR", BufferValue(atr, 0, 1), EMPTY_VALUE, EMPTY_VALUE, EMPTY_VALUE, EMPTY_VALUE, digits + 2);
            IndicatorRelease(atr);
         }

         int stochastic = iStochastic(symbols[s], periods[p], 14, 3, 3, MODE_SMA, STO_LOWHIGH);
         if(stochastic != INVALID_HANDLE)
         {
            AppendIndicatorJson(json, first, symbols[s], labels[p], candle_time, "STOCHASTIC", EMPTY_VALUE, EMPTY_VALUE, EMPTY_VALUE, BufferValue(stochastic, 0, 1), BufferValue(stochastic, 1, 1), 2);
            IndicatorRelease(stochastic);
         }

         int adx = iADX(symbols[s], periods[p], 14);
         if(adx != INVALID_HANDLE)
         {
            AppendIndicatorJson(json, first, symbols[s], labels[p], candle_time, "ADX", BufferValue(adx, 0, 1), EMPTY_VALUE, EMPTY_VALUE, BufferValue(adx, 1, 1), BufferValue(adx, 2, 1), 2);
            IndicatorRelease(adx);
         }

         AppendEmaIndicator(json, first, symbols[s], periods[p], labels[p], candle_time, 9, digits);
         AppendEmaIndicator(json, first, symbols[s], periods[p], labels[p], candle_time, 21, digits);
         AppendEmaIndicator(json, first, symbols[s], periods[p], labels[p], candle_time, 50, digits);
         AppendEmaIndicator(json, first, symbols[s], periods[p], labels[p], candle_time, 200, digits);
         AppendVolumeIndicator(json, first, symbols[s], periods[p], labels[p], candle_time);
      }
   }

   json += "]";
   return json;
}

//+------------------------------------------------------------------+
//| Append EMA indicator                                              |
//+------------------------------------------------------------------+
void AppendEmaIndicator(string &json, bool &first, string symbol, ENUM_TIMEFRAMES period, string label, datetime candle_time, int ema_period, int digits)
{
   int handle = iMA(symbol, period, ema_period, 0, MODE_EMA, PRICE_CLOSE);
   if(handle == INVALID_HANDLE) return;
   AppendIndicatorJson(json, first, symbol, label, candle_time, "EMA" + IntegerToString(ema_period), BufferValue(handle, 0, 1), EMPTY_VALUE, EMPTY_VALUE, EMPTY_VALUE, EMPTY_VALUE, digits);
   IndicatorRelease(handle);
}

//+------------------------------------------------------------------+
//| Append volume context indicator                                   |
//+------------------------------------------------------------------+
void AppendVolumeIndicator(string &json, bool &first, string symbol, ENUM_TIMEFRAMES period, string label, datetime candle_time)
{
   MqlRates rates[];
   int copied = CopyRates(symbol, period, 1, 20, rates);
   if(copied <= 0) return;

   ArraySetAsSeries(rates, true);
   double total = 0.0;
   for(int i = 0; i < copied; i++) total += (double)rates[i].tick_volume;
   double average = total / copied;
   double latest = (double)rates[0].tick_volume;
   double ratio = average > 0 ? latest / average : 0.0;
   AppendIndicatorJson(json, first, symbol, label, candle_time, "VOLUME", latest, average, ratio, EMPTY_VALUE, EMPTY_VALUE, 2);
}

//+------------------------------------------------------------------+
//| Copy one indicator buffer value                                   |
//+------------------------------------------------------------------+
double BufferValue(int handle, int buffer, int shift)
{
   double values[];
   ArraySetAsSeries(values, true);
   if(CopyBuffer(handle, buffer, shift, 1, values) != 1) return EMPTY_VALUE;
   return values[0];
}

//+------------------------------------------------------------------+
//| Append one normalized indicator JSON object                       |
//+------------------------------------------------------------------+
void AppendIndicatorJson(string &json, bool &first, string symbol, string timeframe, datetime candle_time, string name, double value1, double value2, double value3, double value4, double value5, int digits)
{
   if(!first) json += ",";
   first = false;
   json += "{"
      "\"symbol\":\"" + EscapeString(symbol) + "\","
      "\"timeframe\":\"" + timeframe + "\","
      "\"time\":\"" + FormatIsoTime(candle_time) + "\","
      "\"indicator\":\"" + name + "\","
      "\"value1\":" + NumberOrNull(value1, digits) + ","
      "\"value2\":" + NumberOrNull(value2, digits) + ","
      "\"value3\":" + NumberOrNull(value3, digits) + ","
      "\"value4\":" + NumberOrNull(value4, digits) + ","
      "\"value5\":" + NumberOrNull(value5, digits) +
   "}";
}

//+------------------------------------------------------------------+
//| Format nullable numeric JSON value                                |
//+------------------------------------------------------------------+
string NumberOrNull(double value, int digits)
{
   if(value == EMPTY_VALUE) return "null";
   return DoubleToString(value, digits);
}

//+------------------------------------------------------------------+
//| Build open trades JSON                                           |
//+------------------------------------------------------------------+
string BuildTradesJson()
{
   long account = AccountInfoInteger(ACCOUNT_LOGIN);
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   string json = "[";
   bool first = true;

   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) continue;

      string symbol = PositionGetString(POSITION_SYMBOL);
      int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
      long position_type = PositionGetInteger(POSITION_TYPE);
      string type = (position_type == POSITION_TYPE_BUY) ? "buy" : "sell";

      if(!first) json += ",";
      first = false;
      json += "{"
         "\"ticket\":\"" + IntegerToString((long)ticket) + "\","
         "\"symbol\":\"" + EscapeString(symbol) + "\","
         "\"type\":\"" + type + "\","
         "\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + ","
         "\"openPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), digits) + ","
         "\"currentPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_CURRENT), digits) + ","
         "\"sl\":" + DoubleToString(PositionGetDouble(POSITION_SL), digits) + ","
         "\"tp\":" + DoubleToString(PositionGetDouble(POSITION_TP), digits) + ","
         "\"profit\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + ","
         "\"swap\":" + DoubleToString(PositionGetDouble(POSITION_SWAP), 2) + ","
         "\"magic\":\"" + IntegerToString((int)PositionGetInteger(POSITION_MAGIC)) + "\","
         "\"comment\":\"" + EscapeString(PositionGetString(POSITION_COMMENT)) + "\","
         "\"status\":\"open\","
         "\"openTime\":\"" + FormatIsoTime((datetime)PositionGetInteger(POSITION_TIME)) + "\","
         "\"account\":\"" + IntegerToString(account) + "\","
         "\"broker\":\"" + EscapeString(broker) + "\","
         "\"terminal\":\"MetaTrader 5\"" +
      "}";
   }

   json += "]";
   return json;
}

//+------------------------------------------------------------------+
//| Resolve symbol input                                              |
//+------------------------------------------------------------------+
int GetConfiguredSymbols(string &symbols[])
{
   ArrayResize(symbols, 0);
   string configured = TrimString(InpSymbols);

   if(configured == "" || configured == "*")
   {
      int total = SymbolsTotal(false);
      int limit = InpMaxSymbols;
      if(IsTrackedMarketSymbol(_Symbol))
      {
         SymbolSelect(_Symbol, true);
         ArrayResize(symbols, 1);
         symbols[0] = _Symbol;
      }

      for(int i = 0; i < total && (limit <= 0 || ArraySize(symbols) < limit); i++)
      {
         string symbol = SymbolName(i, false);
         if(symbol == "" || !IsTrackedMarketSymbol(symbol)) continue;
         if(SymbolAlreadyConfigured(symbols, symbol)) continue;
         SymbolSelect(symbol, true);
         int size = ArraySize(symbols);
         ArrayResize(symbols, size + 1);
         symbols[size] = symbol;
      }

      if(ArraySize(symbols) == 0)
      {
         ArrayResize(symbols, 1);
         symbols[0] = _Symbol;
      }

      return ArraySize(symbols);
   }

   string parts[];
   int count = StringSplit(configured, ',', parts);
   for(int i = 0; i < count; i++)
   {
      string symbol = TrimString(parts[i]);
      if(symbol == "") continue;
      // Resolve to the actual broker symbol (handles suffixes like EURUSDm / XAUUSDm).
      string resolved = MatchBrokerSymbol(symbol);
      if(resolved != "") symbol = resolved;
      if(SymbolAlreadyConfigured(symbols, symbol)) continue;
      SymbolSelect(symbol, true);
      int size = ArraySize(symbols);
      ArrayResize(symbols, size + 1);
      symbols[size] = symbol;
   }

   if(ArraySize(symbols) == 0)
   {
      ArrayResize(symbols, 1);
      symbols[0] = _Symbol;
   }

   return ArraySize(symbols);
}

//+------------------------------------------------------------------+
//| Check symbol array for duplicates                                 |
//+------------------------------------------------------------------+
bool SymbolAlreadyConfigured(string &symbols[], string symbol)
{
   string target = symbol;
   StringToUpper(target);
   for(int i = 0; i < ArraySize(symbols); i++)
   {
      string existing = symbols[i];
      StringToUpper(existing);
      if(existing == target) return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Resolve timeframe input                                           |
//+------------------------------------------------------------------+
int GetConfiguredTimeframes(ENUM_TIMEFRAMES &periods[], string &labels[])
{
   ArrayResize(periods, 0);
   ArrayResize(labels, 0);

   string configured = TrimString(InpTimeframes);
   if(configured == "" || configured == "*")
   {
      // Only stream the timeframes the backend signal engine actually consumes
      // (multi-timeframe configs + FTT mappings). Removing the unused 11 timeframes
      // (M4,M6,M10,M12,M20,H2,H3,H6,H8,H12,MN1) cuts snapshot payload ~50% and keeps
      // the synchronous WebRequest fast so real-time candles are never starved.
      AddTimeframe(periods, labels, PERIOD_M1);
      AddTimeframe(periods, labels, PERIOD_M2);
      AddTimeframe(periods, labels, PERIOD_M3);
      AddTimeframe(periods, labels, PERIOD_M5);
      AddTimeframe(periods, labels, PERIOD_M15);
      AddTimeframe(periods, labels, PERIOD_M30);
      AddTimeframe(periods, labels, PERIOD_H1);
      AddTimeframe(periods, labels, PERIOD_H4);
      AddTimeframe(periods, labels, PERIOD_D1);
      AddTimeframe(periods, labels, PERIOD_W1);
      return ArraySize(periods);
   }

   string parts[];
   int count = StringSplit(configured, ',', parts);
   for(int i = 0; i < count; i++)
   {
      string label = TrimString(parts[i]);
      ENUM_TIMEFRAMES tf = StringToTimeframe(label);
      if(tf == PERIOD_CURRENT) continue;
      AddTimeframe(periods, labels, tf);
   }

   if(ArraySize(periods) == 0)
   {
      ArrayResize(periods, 1);
      ArrayResize(labels, 1);
      periods[0] = Period();
      labels[0] = TimeframeToString(Period());
   }

   return ArraySize(periods);
}

//+------------------------------------------------------------------+
//| Append one timeframe if not already configured                    |
//+------------------------------------------------------------------+
void AddTimeframe(ENUM_TIMEFRAMES &periods[], string &labels[], ENUM_TIMEFRAMES tf)
{
   for(int i = 0; i < ArraySize(periods); i++)
   {
      if(periods[i] == tf) return;
   }

   int size = ArraySize(periods);
   ArrayResize(periods, size + 1);
   ArrayResize(labels, size + 1);
   periods[size] = tf;
   labels[size] = TimeframeToString(tf);
}

//+------------------------------------------------------------------+
//| Detect Forex symbols and XAU instruments                          |
//+------------------------------------------------------------------+
bool IsTrackedMarketSymbol(string symbol)
{
   string name = symbol;
   StringToUpper(name);

   if(StringFind(name, "XAUUSD") >= 0) return true;
   if(IsForexSymbolName(name)) return true;
   return false;
}

//+------------------------------------------------------------------+
//| Check common Forex currency codes                                 |
//+------------------------------------------------------------------+
bool IsForexCurrency(string currency)
{
   return currency == "USD" || currency == "EUR" || currency == "GBP" || currency == "JPY" ||
          currency == "CHF" || currency == "CAD" || currency == "AUD" || currency == "NZD" ||
          currency == "CNH" || currency == "HKD" || currency == "SGD" || currency == "ZAR" ||
          currency == "MXN" || currency == "NOK" || currency == "SEK" || currency == "DKK" ||
          currency == "TRY" || currency == "PLN" || currency == "CZK" || currency == "HUF";
}

//+------------------------------------------------------------------+
//| Detect Forex pairs by broker symbol name, including suffixes      |
//+------------------------------------------------------------------+
bool IsForexSymbolName(string symbol)
{
   string currencies[20] = {
      "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNH", "HKD",
      "SGD", "ZAR", "MXN", "NOK", "SEK", "DKK", "TRY", "PLN", "CZK", "HUF"
   };

   for(int i = 0; i < ArraySize(currencies); i++)
   {
      for(int j = 0; j < ArraySize(currencies); j++)
      {
         if(i == j) continue;
         string pair = currencies[i] + currencies[j];
         if(StringFind(symbol, pair) == 0) return true;
      }
   }
   return false;
}

//+------------------------------------------------------------------+
//| Convert timeframe text to enum                                   |
//+------------------------------------------------------------------+
ENUM_TIMEFRAMES StringToTimeframe(string value)
{
   string v = value;
   StringToUpper(v);
   if(v == "M1") return PERIOD_M1;
   if(v == "M2") return PERIOD_M2;
   if(v == "M3") return PERIOD_M3;
   if(v == "M4") return PERIOD_M4;
   if(v == "M5") return PERIOD_M5;
   if(v == "M6") return PERIOD_M6;
   if(v == "M10") return PERIOD_M10;
   if(v == "M12") return PERIOD_M12;
   if(v == "M15") return PERIOD_M15;
   if(v == "M20") return PERIOD_M20;
   if(v == "M30") return PERIOD_M30;
   if(v == "H1") return PERIOD_H1;
   if(v == "H2") return PERIOD_H2;
   if(v == "H3") return PERIOD_H3;
   if(v == "H4") return PERIOD_H4;
   if(v == "H6") return PERIOD_H6;
   if(v == "H8") return PERIOD_H8;
   if(v == "H12") return PERIOD_H12;
   if(v == "D1") return PERIOD_D1;
   if(v == "W1") return PERIOD_W1;
   if(v == "MN1") return PERIOD_MN1;
   return PERIOD_CURRENT;
}

//+------------------------------------------------------------------+
//| Convert timeframe enum to frontend label                         |
//+------------------------------------------------------------------+
string TimeframeToString(ENUM_TIMEFRAMES tf)
{
   switch(tf)
   {
      case PERIOD_M1: return "M1";
      case PERIOD_M2: return "M2";
      case PERIOD_M3: return "M3";
      case PERIOD_M4: return "M4";
      case PERIOD_M5: return "M5";
      case PERIOD_M6: return "M6";
      case PERIOD_M10: return "M10";
      case PERIOD_M12: return "M12";
      case PERIOD_M15: return "M15";
      case PERIOD_M20: return "M20";
      case PERIOD_M30: return "M30";
      case PERIOD_H1: return "H1";
      case PERIOD_H2: return "H2";
      case PERIOD_H3: return "H3";
      case PERIOD_H4: return "H4";
      case PERIOD_H6: return "H6";
      case PERIOD_H8: return "H8";
      case PERIOD_H12: return "H12";
      case PERIOD_D1: return "D1";
      case PERIOD_W1: return "W1";
      case PERIOD_MN1: return "MN1";
   }
   return "CURRENT";
}

//+------------------------------------------------------------------+
//| Format MQL datetime as ISO-like UTC/local string                 |
//+------------------------------------------------------------------+
string FormatIsoTime(datetime broker_time)
{
   datetime current = TimeCurrent();
   datetime gmt = TimeGMT();
   int offset = (int)(current - gmt);
   datetime utc_time = broker_time - offset;

   MqlDateTime t;
   TimeToStruct(utc_time, t);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ", t.year, t.mon, t.day, t.hour, t.min, t.sec);
}

//+------------------------------------------------------------------+
//| Trim whitespace                                                   |
//+------------------------------------------------------------------+
string TrimString(string value)
{
   string out = value;
   StringTrimLeft(out);
   StringTrimRight(out);
   return out;
}

//+------------------------------------------------------------------+
//| Trade Transaction function                                       |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction& trans,
                        const MqlTradeRequest& request,
                        const MqlTradeResult& result)
{
   if(!InpTrackTrades) return;
   
   // We only track deal addition transaction type (which represents completed executions)
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
   {
      ulong deal_ticket = trans.deal;
      if(deal_ticket > 0)
      {
         if(HistoryDealSelect(deal_ticket))
         {
            long deal_type = HistoryDealGetInteger(deal_ticket, DEAL_TYPE);
            long deal_entry = HistoryDealGetInteger(deal_ticket, DEAL_ENTRY);
            
            // We are interested in Entry IN (opening position) and Entry OUT (closing position)
            if(deal_type == DEAL_TYPE_BUY || deal_type == DEAL_TYPE_SELL)
            {
               string symbol = HistoryDealGetString(deal_ticket, DEAL_SYMBOL);
               double price = HistoryDealGetDouble(deal_ticket, DEAL_PRICE);
               double volume = HistoryDealGetDouble(deal_ticket, DEAL_VOLUME);
               string broker = AccountInfoString(ACCOUNT_COMPANY);
               long account = AccountInfoInteger(ACCOUNT_LOGIN);
               
               string dir = (deal_type == DEAL_TYPE_BUY) ? "buy" : "sell";
               string entry_type = (deal_entry == DEAL_ENTRY_IN) ? "Position Opened" : "Position Closed";
               
               string message = "Deal ticket #" + IntegerToString(deal_ticket) + " " + entry_type + " " + dir + " " + DoubleToString(volume, 2) + " lots at " + DoubleToString(price, _Digits);
               
               SendSignal(symbol, EnumToString(Period()), entry_type, dir, price, volume, message);
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Send live candle update for active symbol/timeframe              |
//+------------------------------------------------------------------+
void SendLiveCandle()
{
   string symbol = g_active_symbol;
   if(symbol == "") symbol = _Symbol;
   
   string tf_label = g_active_timeframe;
   ENUM_TIMEFRAMES period = PERIOD_CURRENT;
   if(tf_label == "")
   {
      period = Period();
      tf_label = TimeframeToString(period);
   }
   else
   {
      period = StringToTimeframe(tf_label);
   }
   if(period == PERIOD_CURRENT) period = Period();

   // Select symbol in Market Watch if not already selected
   SymbolSelect(symbol, true);

   MqlRates rates[];
   int copied = CopyRates(symbol, period, 0, 1, rates);
   if(copied <= 0) return;

   string url = InpServerUrl + "/api/mt5/candles";
   string headers = "Content-Type: application/json\r\n";
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

   string body = "{"
      "\"symbol\":\"" + EscapeString(symbol) + "\","
      "\"timeframe\":\"" + tf_label + "\","
      "\"time\":\"" + FormatIsoTime(rates[0].time) + "\","
      "\"open\":" + DoubleToString(rates[0].open, digits) + ","
      "\"high\":" + DoubleToString(rates[0].high, digits) + ","
      "\"low\":" + DoubleToString(rates[0].low, digits) + ","
      "\"close\":" + DoubleToString(rates[0].close, digits) + ","
      "\"volume\":" + IntegerToString((int)rates[0].tick_volume) + ","
      "\"spread\":" + IntegerToString((int)rates[0].spread) +
   "}";

   char post_bytes[];
   char result[];
   string result_headers;

   ArrayResize(post_bytes, StringLen(body));
   StringToCharArray(body, post_bytes, 0, StringLen(body), CP_UTF8);

   ResetLastError();
   // Use 3 second timeout for live candle updates (increased from 1000ms to handle backend load)
   int res = WebRequest("POST", url, headers, 3000, post_bytes, result, result_headers);
   last_live_candle = TimeLocal();
   if(res >= 200 && res < 300)
   {
      ParseBackendResponse(result);
   }
}

//+------------------------------------------------------------------+
//| Resolve curated priority symbols to broker names (cached once)    |
//+------------------------------------------------------------------+
void ResolveRealtimeSymbols()
{
   ArrayResize(g_realtime_symbols, 0);
   string parts[];
   int n = StringSplit(InpPrioritySymbols, ',', parts);
   for(int i = 0; i < n; i++)
   {
      string base = TrimString(parts[i]);
      if(base == "") continue;
      string broker = MatchBrokerSymbol(base);
      if(broker == "") broker = base; // fallback to the raw name
      SymbolSelect(broker, true);
      int sz = ArraySize(g_realtime_symbols);
      ArrayResize(g_realtime_symbols, sz + 1);
      g_realtime_symbols[sz] = broker;
   }
   if(ArraySize(g_realtime_symbols) > 0) g_realtime_resolved = true;
}

//+------------------------------------------------------------------+
//| Stream the current candle for all curated symbols in one batch   |
//| so they stay real-time (<3s) and scannable simultaneously.       |
//+------------------------------------------------------------------+
void SendPriorityCandles()
{
   if(!g_realtime_resolved) ResolveRealtimeSymbols();
   int sc = ArraySize(g_realtime_symbols);
   if(sc == 0) return;

   string tfparts[];
   int tfn = StringSplit(InpPriorityTimeframes, ',', tfparts);
   if(tfn <= 0) return;

   string json = "[";
   bool first = true;

   for(int s = 0; s < sc; s++)
   {
      string sym = g_realtime_symbols[s];
      SymbolSelect(sym, true);
      int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);

      for(int t = 0; t < tfn; t++)
      {
         string tflabel = TrimString(tfparts[t]);
         ENUM_TIMEFRAMES per = StringToTimeframe(tflabel);
         if(per == PERIOD_CURRENT) continue;

         MqlRates rates[];
         int copied = CopyRates(sym, per, 0, 1, rates);
         if(copied <= 0) continue;

         if(!first) json += ",";
         first = false;
         json += "{"
            "\"symbol\":\"" + EscapeString(sym) + "\","
            "\"timeframe\":\"" + tflabel + "\","
            "\"time\":\"" + FormatIsoTime(rates[0].time) + "\","
            "\"open\":" + DoubleToString(rates[0].open, digits) + ","
            "\"high\":" + DoubleToString(rates[0].high, digits) + ","
            "\"low\":" + DoubleToString(rates[0].low, digits) + ","
            "\"close\":" + DoubleToString(rates[0].close, digits) + ","
            "\"volume\":" + IntegerToString((int)rates[0].tick_volume) + ","
            "\"spread\":" + IntegerToString((int)rates[0].spread) +
         "}";
      }
   }
   json += "]";
   if(first) return; // nothing collected

   string body = "{\"candles\":" + json + "}";
   string url = InpServerUrl + "/api/mt5/candles";
   string headers = "Content-Type: application/json\r\n";

   char post_bytes[];
   char result[];
   string result_headers;

   ArrayResize(post_bytes, StringLen(body));
   StringToCharArray(body, post_bytes, 0, StringLen(body), CP_UTF8);

   ResetLastError();
   int res = WebRequest("POST", url, headers, 3000, post_bytes, result, result_headers);
   if(res >= 200 && res < 300)
   {
      ParseBackendResponse(result);
   }
}

//+------------------------------------------------------------------+
//| Send Heartbeat WebRequest                                        |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   string url = InpServerUrl + "/api/mt5/heartbeat";
   string headers = "Content-Type: application/json\r\n";
   
   // Gather account information
   long account = AccountInfoInteger(ACCOUNT_LOGIN);
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   string terminal = "MetaTrader 5";
   string version = "1.03";
   
   // Format JSON payload
   string body = "{"
      "\"account\":\"" + IntegerToString(account) + "\","
      "\"broker\":\"" + EscapeString(broker) + "\","
      "\"terminal\":\"" + terminal + "\","
      "\"version\":\"" + version + "\"" +
   "}";
   
   char post_bytes[];
   char result[];
   string result_headers;
   
   // Convert body string to char array (without null terminator)
   ArrayResize(post_bytes, StringLen(body));
   StringToCharArray(body, post_bytes, 0, StringLen(body), CP_UTF8);
   
   ResetLastError();
   int res = WebRequest("POST", url, headers, InpTimeout, post_bytes, result, result_headers);
   
   if(res == -1)
   {
      int err = GetLastError();
      Print("Heartbeat WebRequest failed. Error code: ", err, ", URL: ", url, ", payload bytes: ", ArraySize(post_bytes));
      if(err == 4014)
      {
         Print("CRITICAL: WebRequest function not allowed! Add '", InpServerUrl, "' in Tools -> Options -> Expert Advisors.");
      }
   }
   else
   {
      last_heartbeat = TimeLocal();
      if(res >= 200 && res < 300) ParseBackendResponse(result);
      if(InpDiagnostics) Print("Heartbeat sent successfully. Response code: ", res, ", response: ", ResponseSnippet(result));
   }
}

//+------------------------------------------------------------------+
//| Send Signal WebRequest                                           |
//+------------------------------------------------------------------+
void SendSignal(string symbol, string timeframe, string type, string direction, double price, double volume, string message)
{
   string url = InpServerUrl + "/api/mt5/signals";
   string headers = "Content-Type: application/json\r\n";
   
   long account = AccountInfoInteger(ACCOUNT_LOGIN);
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   
   string body = "{"
      "\"symbol\":\"" + symbol + "\","
      "\"timeframe\":\"" + timeframe + "\","
      "\"type\":\"" + EscapeString(type) + "\","
      "\"direction\":\"" + direction + "\","
      "\"price\":" + DoubleToString(price, _Digits) + ","
      "\"bid\":" + DoubleToString(bid, _Digits) + ","
      "\"ask\":" + DoubleToString(ask, _Digits) + ","
      "\"volume\":" + DoubleToString(volume, 2) + ","
      "\"account\":\"" + IntegerToString(account) + "\","
      "\"broker\":\"" + EscapeString(broker) + "\","
      "\"terminal\":\"MetaTrader 5\","
      "\"message\":\"" + EscapeString(message) + "\"" +
   "}";
   
   char post_bytes[];
   char result[];
   string result_headers;
   
   ArrayResize(post_bytes, StringLen(body));
   StringToCharArray(body, post_bytes, 0, StringLen(body), CP_UTF8);
   
   ResetLastError();
   int res = WebRequest("POST", url, headers, InpTimeout, post_bytes, result, result_headers);
   
   if(res == -1)
   {
      int err = GetLastError();
      Print("Signal WebRequest failed. Error code: ", err, ", URL: ", url, ", payload bytes: ", ArraySize(post_bytes));
   }
   else
   {
      Print("Signal sent successfully. Response code: ", res, ", response: ", ResponseSnippet(result));
   }
}

//+------------------------------------------------------------------+
//| Convert HTTP response bytes to a short printable snippet           |
//+------------------------------------------------------------------+
string ResponseSnippet(char &result[])
{
   if(ArraySize(result) <= 0) return "";
   string text = CharArrayToString(result, 0, ArraySize(result), CP_UTF8);
   if(StringLen(text) > 300) text = StringSubstr(text, 0, 300) + "...";
   return text;
}

// Helper to parse activeSymbol and activeTimeframe from backend response
void ParseBackendResponse(char &result[])
{
   if(ArraySize(result) <= 0) return;
   string text = CharArrayToString(result, 0, ArraySize(result), CP_UTF8);
   
   // Extract activeSymbol
   int sym_pos = StringFind(text, "\"activeSymbol\":\"");
   if(sym_pos >= 0)
   {
      int val_start = sym_pos + 16;
      int val_end = StringFind(text, "\"", val_start);
      if(val_end > val_start)
      {
         string new_sym = StringSubstr(text, val_start, val_end - val_start);
         // The backend/frontend may send an upper-cased name (e.g. "XAUUSDM"), but MT5
         // symbol names are CASE-SENSITIVE ("XAUUSDm"). Resolve to the real broker symbol
         // so CopyRates/indicators work and the active symbol streams every second.
         string cur = g_active_symbol; StringToUpper(cur);
         string ns = new_sym; StringToUpper(ns);
         if(cur != ns) // only re-resolve when the active symbol actually changes
         {
            string resolved = MatchBrokerSymbol(new_sym);
            g_active_symbol = (resolved != "") ? resolved : new_sym;
         }
      }
   }
   
   // Extract activeTimeframe
   int tf_pos = StringFind(text, "\"activeTimeframe\":\"");
   if(tf_pos >= 0)
   {
      int val_start = tf_pos + 19;
      int val_end = StringFind(text, "\"", val_start);
      if(val_end > val_start)
      {
         g_active_timeframe = StringSubstr(text, val_start, val_end - val_start);
         StringToUpper(g_active_timeframe);
      }
   }
}

//+------------------------------------------------------------------+
//| Check SMA Crossover                                              |
//+------------------------------------------------------------------+
void CheckSmaCrossover()
{
   // Only run on new bar
   static datetime last_bar_time = 0;
   datetime current_bar_time = iTime(_Symbol, InpSMAtimeframe, 0);
   
   if(current_bar_time == last_bar_time) return;
   
   double fast_sma[2], slow_sma[2];
   if(CopyBuffer(fast_sma_handle, 0, 1, 2, fast_sma) != 2) return;
   if(CopyBuffer(slow_sma_handle, 0, 1, 2, slow_sma) != 2) return;
   
   // Index 1 is the previous bar (fully closed)
   // Index 0 is the bar before that
   
   bool cross_up = (fast_sma[0] <= slow_sma[0]) && (fast_sma[1] > slow_sma[1]);
   bool cross_down = (fast_sma[0] >= slow_sma[0]) && (fast_sma[1] < slow_sma[1]);
   
   if(cross_up || cross_down)
   {
      double close_price = iClose(_Symbol, InpSMAtimeframe, 1);
      string direction = cross_up ? "buy" : "sell";
      string signal_type = cross_up ? "SMA Golden Cross" : "SMA Death Cross";
      string message = _Symbol + " " + EnumToString(InpSMAtimeframe) + ": SMA Crossover Alert! " + signal_type + " at price " + DoubleToString(close_price, _Digits);
      
      SendSignal(_Symbol, EnumToString(InpSMAtimeframe), signal_type, direction, close_price, 0.0, message);
      last_bar_time = current_bar_time;
   }
}

//+------------------------------------------------------------------+
//| Escape string characters for JSON safety                         |
//+------------------------------------------------------------------+
string EscapeString(string str)
{
   string out = str;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\r", "\\r");
   StringReplace(out, "\n", "\\n");
   StringReplace(out, "\t", "\\t");
   return out;
}

//+------------------------------------------------------------------+
//| Asynchronous History Synchronization State Machine               |
//+------------------------------------------------------------------+
void RunHistorySync()
{
   if(g_sync_state == SYNC_STATE_IDLE)
   {
      g_sync_state = SYNC_STATE_RESOLVING;
   }

   if(g_sync_state == SYNC_STATE_RESOLVING)
   {
      Print("Aura Sync: Resolving broker symbol names...");
      ArrayResize(g_sync_symbols, 0);

      // 1. Resolve and select all priority symbols
      int total_priority = ArraySize(g_priority_pairs);
      for(int i = 0; i < total_priority; i++)
      {
         string broker_symbol = MatchBrokerSymbol(g_priority_pairs[i]);
         if(broker_symbol != "")
         {
            SymbolSelect(broker_symbol, true);
            int size = ArraySize(g_sync_symbols);
            ArrayResize(g_sync_symbols, size + 1);
            g_sync_symbols[size] = broker_symbol;
         }
      }

      // 2. Also append other symbols already configured in Market Watch/InpSymbols 
      // to ensure they get synchronized too, but after the priority ones
      string other_symbols[];
      int other_count = GetConfiguredSymbols(other_symbols);
      for(int i = 0; i < other_count; i++)
      {
         string sym = other_symbols[i];
         bool already_in = false;
         for(int j = 0; j < ArraySize(g_sync_symbols); j++)
         {
            if(g_sync_symbols[j] == sym)
            {
               already_in = true;
               break;
            }
         }
         if(!already_in)
         {
            int size = ArraySize(g_sync_symbols);
            ArrayResize(g_sync_symbols, size + 1);
            g_sync_symbols[size] = sym;
         }
      }

      int resolved_count = ArraySize(g_sync_symbols);
      Print("Aura Sync: Total symbols to sync = ", resolved_count);
      if(resolved_count > 0)
      {
         g_sync_symbol_index = 0;
         g_sync_timeframe_index = 0;
         g_sync_retry_count = 0;
         g_sync_last_bars = 0;
         g_sync_chunk_start = 0;
         g_sync_state = SYNC_STATE_SYNCING;
      }
      else
      {
         g_sync_state = SYNC_STATE_COMPLETE;
      }
      return;
   }

   if(g_sync_state == SYNC_STATE_SYNCING)
   {
      int total_symbols = ArraySize(g_sync_symbols);
      if(g_sync_symbol_index >= total_symbols)
      {
         g_sync_state = SYNC_STATE_COMPLETE;
         return;
      }

      string symbol = g_sync_symbols[g_sync_symbol_index];
      ENUM_TIMEFRAMES periods[];
      string labels[];
      int total_tfs = GetConfiguredTimeframes(periods, labels);

      if(g_sync_timeframe_index >= total_tfs)
      {
         // Done with all timeframes for this symbol. Move to next symbol.
         g_sync_symbol_index++;
         g_sync_timeframe_index = 0;
         g_sync_retry_count = 0;
         g_sync_last_bars = 0;
         g_sync_chunk_start = 0;
         return;
      }

      ENUM_TIMEFRAMES period = periods[g_sync_timeframe_index];
      string tf_label = labels[g_sync_timeframe_index];

      // Ensure symbol is selected in Market Watch
      SymbolSelect(symbol, true);

      // Query sync status and bars count
      bool is_synchronized = (bool)SeriesInfoInteger(symbol, period, SERIES_SYNCHRONIZED);
      MqlRates rates[];
      int copied = CopyRates(symbol, period, 0, InpSyncCandlesLimit, rates);

      // If we are already in the middle of uploading chunks, bypass state checking
      if(g_sync_chunk_start > 0)
      {
         int chunk_size = 2000;
         bool done = UploadHistoryChunk(symbol, tf_label, rates, g_sync_chunk_start, chunk_size);
         if(done)
         {
            // Move to next timeframe
            g_sync_timeframe_index++;
            g_sync_retry_count = 0;
            g_sync_last_bars = 0;
            g_sync_chunk_start = 0;
         }
         else
         {
            g_sync_chunk_start += chunk_size;
         }
         return;
      }

      string comment_msg = "Aura Sync: Loading [" + IntegerToString(g_sync_symbol_index + 1) + "/" + IntegerToString(total_symbols) + "] " +
                           symbol + " " + tf_label + " (" + IntegerToString(copied > 0 ? copied : 0) + "/" + IntegerToString(InpSyncCandlesLimit) + " bars)...";
      Comment(comment_msg);

      if(copied >= InpSyncCandlesLimit)
      {
         // Start uploading history in non-blocking chunks
         Print("Aura Sync: Uploading history for ", symbol, " ", tf_label, " (", copied, " bars)...");
         int chunk_size = 2000;
         bool done = UploadHistoryChunk(symbol, tf_label, rates, g_sync_chunk_start, chunk_size);
         if(done)
         {
            g_sync_timeframe_index++;
            g_sync_retry_count = 0;
            g_sync_last_bars = 0;
            g_sync_chunk_start = 0;
         }
         else
         {
            g_sync_chunk_start += chunk_size;
         }
      }
      else
      {
         // Wait for download. If bars count hasn't grown after several ticks, or synchronization finished, accept what we have.
         if(copied > 0 && copied == g_sync_last_bars)
         {
            g_sync_retry_count++;
         }
         else
         {
            g_sync_retry_count = 0;
            g_sync_last_bars = copied;
         }

         // Timeout/Synch check: if we've retried 10 times without progress, OR (is_synchronized and progress stopped)
         if(g_sync_retry_count >= 10 || (is_synchronized && g_sync_retry_count >= 3))
         {
            if(copied > 0)
            {
               Print("Aura Sync: Accept partial history for ", symbol, " ", tf_label, " (", copied, " bars)...");
               int chunk_size = 2000;
               bool done = UploadHistoryChunk(symbol, tf_label, rates, g_sync_chunk_start, chunk_size);
               if(done)
                {
                   g_sync_timeframe_index++;
                   g_sync_retry_count = 0;
                   g_sync_last_bars = 0;
                   g_sync_chunk_start = 0;
                }
                else
                {
                   g_sync_chunk_start += chunk_size;
                }
            }
            else
            {
               Print("Aura Sync: Skipping ", symbol, " ", tf_label, " - no rates copied.");
               g_sync_timeframe_index++;
               g_sync_retry_count = 0;
               g_sync_last_bars = 0;
               g_sync_chunk_start = 0;
            }
         }
      }
      return;
   }

   if(g_sync_state == SYNC_STATE_COMPLETE)
   {
      Comment("");
      Print("Aura Sync: History synchronization complete!");
   }
}

//+------------------------------------------------------------------+
//| Dynamic Broker Symbol Matching (handles suffixes like EURUSDm)   |
//+------------------------------------------------------------------+
string MatchBrokerSymbol(string standard_pair)
{
   // standard_pair is like "EURUSD" or "XAUUSD"
   string clean_pair = standard_pair;
   StringReplace(clean_pair, "/", ""); // remove any slashes
   StringToUpper(clean_pair);

   // Resolution order matters. A plain substring search returns whatever the broker
   // happens to list first, which is how "USTEC" once resolved to USTEC_x100m — the
   // x100 contract at $100/point instead of USTECm at $1/point, mis-sizing a trade by
   // 100x. So: exact name wins, then the SHORTEST prefix match (USTECm beats
   // USTEC_x100m), and only then a loose substring, again shortest-first.
   string best = "";
   int    best_len = 0;

   // Pass 1 + 2: exact match, Market Watch first then the full symbol tree.
   for(int pass = 0; pass < 2; pass++)
   {
      bool selected_only = (pass == 0);
      int total_x = SymbolsTotal(selected_only);
      for(int i = 0; i < total_x; i++)
      {
         string symbol = SymbolName(i, selected_only);
         string sym_upper = symbol;
         StringToUpper(sym_upper);
         if(sym_upper == clean_pair) return symbol;      // exact name, unambiguous
      }
   }

   // Pass 3: prefix match ("XAUUSD" -> "XAUUSDm"), shortest suffix wins.
   for(int pass = 0; pass < 2; pass++)
   {
      bool selected_only = (pass == 0);
      int total_x = SymbolsTotal(selected_only);
      for(int i = 0; i < total_x; i++)
      {
         string symbol = SymbolName(i, selected_only);
         string sym_upper = symbol;
         StringToUpper(sym_upper);
         if(StringFind(sym_upper, clean_pair) == 0)
         {
            int len = StringLen(sym_upper);
            if(best == "" || len < best_len) { best = symbol; best_len = len; }
         }
      }
      if(best != "") return best;                        // prefer Market Watch resolution
   }

   int total = SymbolsTotal(false); // fall back to a loose substring, shortest wins
   for(int i = 0; i < total; i++)
   {
      string symbol = SymbolName(i, false);
      string sym_upper = symbol;
      StringToUpper(sym_upper);
      if(StringFind(sym_upper, clean_pair) >= 0)
      {
         int len = StringLen(sym_upper);
         if(best == "" || len < best_len) { best = symbol; best_len = len; }
      }
   }
   if(best != "") return best;

   total = SymbolsTotal(true); // look in all broker symbols
   for(int i = 0; i < total; i++)
   {
      string symbol = SymbolName(i, true);
      string sym_upper = symbol;
      StringToUpper(sym_upper);
      if(StringFind(sym_upper, clean_pair) >= 0)
      {
         return symbol;
      }
   }

   return "";
}

//+------------------------------------------------------------------+
//| Upload rates history in chunked batches of 2,000                 |
//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//| Upload a single chunk of rates history                           |
//| Returns true if this was the last chunk of the array             |
//+------------------------------------------------------------------+
bool UploadHistoryChunk(string symbol, string tf_label, MqlRates &rates[], int start, int chunk_size)
{
   int total_rates = ArraySize(rates);
   if(total_rates <= 0 || start >= total_rates) return true;

   string url = InpServerUrl + "/api/mt5/candles";
   string headers = "Content-Type: application/json\r\n";
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

   int end = start + chunk_size;
   if(end > total_rates) end = total_rates;

   // Update chart comment with chunk progress
   string comment_msg = "Aura Sync: Uploading " + symbol + " " + tf_label + 
                        " chunk [" + IntegerToString(start) + "-" + IntegerToString(end - 1) + 
                        "] of " + IntegerToString(total_rates) + " bars...";
   Comment(comment_msg);
   Print("Aura Sync: Uploading chunk ", start, " to ", end - 1, " for ", symbol, " ", tf_label);

   string body = "{\"candles\":[";
   bool first = true;

   for(int i = start; i < end; i++)
   {
      if(!first) body += ",";
      first = false;

      body += "{"
         "\"symbol\":\"" + EscapeString(symbol) + "\","
         "\"timeframe\":\"" + tf_label + "\","
         "\"time\":\"" + FormatIsoTime(rates[i].time) + "\","
         "\"open\":" + DoubleToString(rates[i].open, digits) + ","
         "\"high\":" + DoubleToString(rates[i].high, digits) + ","
         "\"low\":" + DoubleToString(rates[i].low, digits) + ","
         "\"close\":" + DoubleToString(rates[i].close, digits) + ","
         "\"volume\":" + IntegerToString((int)rates[i].tick_volume) + ","
         "\"spread\":" + IntegerToString((int)rates[i].spread) +
      "}";
   }

   body += "]}";

   char post_bytes[];
   char result[];
   string result_headers;

   ArrayResize(post_bytes, StringLen(body));
   StringToCharArray(body, post_bytes, 0, StringLen(body), CP_UTF8);

   ResetLastError();
   // 5000ms timeout for single chunk to be safe
   int res = WebRequest("POST", url, headers, 5000, post_bytes, result, result_headers);
   if(res < 200 || res >= 300)
   {
      Print("Aura Sync: Upload chunk failed. Symbol = ", symbol, ", Range = [", start, "-", end - 1, "], code = ", res);
   }

   return (end >= total_rates);
}

//+------------------------------------------------------------------+
//| MANUAL TRADE REPORTING                                           |
//| Read-only history export for trades opened by MT5 desktop,       |
//| mobile or web. It is deliberately independent of auto trading.   |
//+------------------------------------------------------------------+
long ManualHistoryScopeId(long account)
{
   string value = IntegerToString(account) + "|" + AccountInfoString(ACCOUNT_COMPANY) + "|" + AccountInfoString(ACCOUNT_SERVER);
   uint hash = 2166136261;
   for(int i = 0; i < StringLen(value); i++)
      hash = (hash ^ (uint)StringGetCharacter(value, i)) * 16777619;
   return (long)hash;
}

string ManualHistoryKey(string kind, long scope)
{
   return "AuraManualV1" + kind + "_" + IntegerToString(scope);
}

datetime ManualHistoryNow()
{
   datetime now = TimeTradeServer();
   if(now <= 0) now = TimeLocal();
   return now;
}

void ManualHistoryInit()
{
   long account = AccountInfoInteger(ACCOUNT_LOGIN);
   if(account <= 0) return;
   long scope = ManualHistoryScopeId(account);
   string start_key = ManualHistoryKey("Start", scope);
   string cursor_key = ManualHistoryKey("Cursor", scope);
   datetime now = ManualHistoryNow();
   if(!GlobalVariableCheck(start_key)) GlobalVariableSet(start_key, (double)now);
   g_manual_history_activated = (datetime)GlobalVariableGet(start_key);
   if(!GlobalVariableCheck(cursor_key)) GlobalVariableSet(cursor_key, (double)g_manual_history_activated);
   g_manual_history_cursor = (datetime)GlobalVariableGet(cursor_key);
   if(g_manual_history_cursor < g_manual_history_activated) g_manual_history_cursor = g_manual_history_activated;
   g_manual_history_scope = scope;
   Print("Aura Manual Report: active for account ", account, " from ", TimeToString(g_manual_history_activated, TIME_DATE|TIME_SECONDS));
}

bool ManualEntryReason(long reason)
{
   return reason == DEAL_REASON_CLIENT || reason == DEAL_REASON_MOBILE || reason == DEAL_REASON_WEB;
}

string ManualReasonName(long reason)
{
   if(reason == DEAL_REASON_MOBILE) return "MOBILE";
   if(reason == DEAL_REASON_WEB) return "WEB";
   return "CLIENT";
}

bool ManualPositionStillOpen(long position_id)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetTicket(i) == 0) continue;
      if(PositionGetInteger(POSITION_IDENTIFIER) == position_id) return true;
   }
   return false;
}

bool ManualPositionKnown(long &ids[], long position_id)
{
   for(int i = 0; i < ArraySize(ids); i++)
      if(ids[i] == position_id) return true;
   return false;
}

bool ManualHistoryPost(string body)
{
   string url = InpServerUrl + "/api/mt5/manual-trade-history";
   string headers = "Content-Type: application/json\r\n";
   char post_bytes[]; char result[]; string result_headers;
   ArrayResize(post_bytes, StringLen(body));
   StringToCharArray(body, post_bytes, 0, StringLen(body), CP_UTF8);
   ResetLastError();
   int res = WebRequest("POST", url, headers, InpTimeout, post_bytes, result, result_headers);
   if(res >= 200 && res < 300) return true;
   Print("Aura Manual Report: POST failed, code=", res, ", err=", GetLastError());
   return false;
}

void ManualHistoryReport()
{
   long account = AccountInfoInteger(ACCOUNT_LOGIN);
   if(account <= 0) return;
   long scope = ManualHistoryScopeId(account);
   if(scope != g_manual_history_scope || g_manual_history_activated <= 0) ManualHistoryInit();
   if(g_manual_history_activated <= 0) return;

   datetime scan_to = ManualHistoryNow();
   datetime scan_from = g_manual_history_cursor - 300; // replay a short overlap after dropped responses
   if(scan_from < g_manual_history_activated) scan_from = g_manual_history_activated;
   if(scan_to <= scan_from || !HistorySelect(scan_from, scan_to + 1)) return;

   long positions[];
   int history_total = HistoryDealsTotal();
   for(int i = 0; i < history_total; i++)
   {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0) continue;
      long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT) continue;
      datetime close_time = (datetime)HistoryDealGetInteger(deal, DEAL_TIME);
      if(close_time < g_manual_history_activated) continue;
      long position_id = HistoryDealGetInteger(deal, DEAL_POSITION_ID);
      if(position_id <= 0 || ManualPositionKnown(positions, position_id)) continue;
      int n = ArraySize(positions);
      ArrayResize(positions, n + 1);
      positions[n] = position_id;
   }

   string deals_json = "[";
   int emitted = 0;
   for(int p = 0; p < ArraySize(positions); p++)
   {
      long position_id = positions[p];
      if(ManualPositionStillOpen(position_id) || !HistorySelectByPosition(position_id)) continue;

      bool has_manual_entry = false, has_non_manual_entry = false, has_inout = false;
      double profit = 0.0, entry_value = 0.0, exit_value = 0.0, entry_volume = 0.0, exit_volume = 0.0;
      datetime open_time = 0, close_time = 0;
      string symbol = "", direction = "BUY", reason_name = "CLIENT";
      int position_deals = HistoryDealsTotal();
      for(int d = 0; d < position_deals; d++)
      {
         ulong pd = HistoryDealGetTicket(d);
         if(pd == 0) continue;
         long entry = HistoryDealGetInteger(pd, DEAL_ENTRY);
         long type = HistoryDealGetInteger(pd, DEAL_TYPE);
         long reason = HistoryDealGetInteger(pd, DEAL_REASON);
         if(entry == DEAL_ENTRY_INOUT) has_inout = true;
         double volume = HistoryDealGetDouble(pd, DEAL_VOLUME);
         double price = HistoryDealGetDouble(pd, DEAL_PRICE);
         datetime deal_time = (datetime)HistoryDealGetInteger(pd, DEAL_TIME);
         profit += HistoryDealGetDouble(pd, DEAL_PROFIT)
                 + HistoryDealGetDouble(pd, DEAL_SWAP)
                 + HistoryDealGetDouble(pd, DEAL_COMMISSION)
                 + HistoryDealGetDouble(pd, DEAL_FEE);

         if(entry == DEAL_ENTRY_IN || entry == DEAL_ENTRY_INOUT)
         {
            if(ManualEntryReason(reason))
            {
               has_manual_entry = true;
               reason_name = ManualReasonName(reason);
            }
            else has_non_manual_entry = true;
            entry_value += price * volume;
            entry_volume += volume;
            if(open_time <= 0 || deal_time < open_time) open_time = deal_time;
            if(symbol == "") symbol = HistoryDealGetString(pd, DEAL_SYMBOL);
            direction = (type == DEAL_TYPE_SELL) ? "SELL" : "BUY";
         }
         if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY || entry == DEAL_ENTRY_INOUT)
         {
            exit_value += price * volume;
            exit_volume += volume;
            if(deal_time > close_time) close_time = deal_time;
         }
      }

      // Mixed manual/EA netting positions cannot be attributed honestly, so skip them.
      if(has_inout)
      {
         Print("Aura Manual Report: skipped netting reversal position ", position_id, " (INOUT cannot be split honestly)");
         continue;
      }
      if(!has_manual_entry || has_non_manual_entry || entry_volume <= 0 || exit_volume <= 0) continue;
      if(open_time < g_manual_history_activated || close_time < g_manual_history_activated) continue;
      double open_price = entry_value / entry_volume;
      double close_price = exit_value / exit_volume;
      if(emitted > 0) deals_json += ",";
      deals_json += "{\"positionId\":" + IntegerToString(position_id) +
                    ",\"symbol\":\"" + EscapeString(symbol) + "\"" +
                    ",\"direction\":\"" + direction + "\"" +
                    ",\"lots\":" + DoubleToString(entry_volume, 2) +
                    ",\"openPrice\":" + DoubleToString(open_price, 8) +
                    ",\"closePrice\":" + DoubleToString(close_price, 8) +
                    ",\"profit\":" + DoubleToString(profit, 2) +
                    ",\"openTime\":" + IntegerToString((long)open_time) +
                    ",\"closeTime\":" + IntegerToString((long)close_time) +
                    ",\"reason\":\"" + reason_name + "\"}";
      emitted++;
   }
   deals_json += "]";

   bool is_demo = (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO);
   string body = "{\"account\":\"" + IntegerToString(account) + "\"" +
                 ",\"broker\":\"" + EscapeString(AccountInfoString(ACCOUNT_COMPANY)) + "\"" +
                 ",\"server\":\"" + EscapeString(AccountInfoString(ACCOUNT_SERVER)) + "\"" +
                 ",\"currency\":\"" + EscapeString(AccountInfoString(ACCOUNT_CURRENCY)) + "\"" +
                 ",\"demo\":" + (is_demo ? "true" : "false") +
                 ",\"activatedAt\":" + IntegerToString((long)g_manual_history_activated) +
                 ",\"deals\":" + deals_json + "}";

   if(emitted == 0 || ManualHistoryPost(body))
   {
      g_manual_history_cursor = scan_to;
      GlobalVariableSet(ManualHistoryKey("Cursor", scope), (double)g_manual_history_cursor);
      if(emitted > 0) Print("Aura Manual Report: imported/reconciled ", emitted, " closed position(s)");
   }
}

//+------------------------------------------------------------------+
//| AUTO-TRADING BRIDGE                                              |
//| The backend is the brain (filters, caps, approvals, armed        |
//| account); this module is only the hands: poll for commands,      |
//| execute them, report results and closed positions.               |
//+------------------------------------------------------------------+

// Build the JSON array of OUR open positions (magic-filtered).
string TradeBridgePositionsJson()
{
   string js = "[";
   bool first = true;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpTradeMagic) continue;
      long pid = PositionGetInteger(POSITION_IDENTIFIER);
      string sym = PositionGetString(POSITION_SYMBOL);
      double profit = PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
      double open_price = PositionGetDouble(POSITION_PRICE_OPEN);
      if(!first) js += ",";
      js += "{\"id\":" + IntegerToString(pid) +
            ",\"ticket\":" + IntegerToString((long)ticket) +
            ",\"symbol\":\"" + EscapeString(sym) + "\"" +
            ",\"profit\":" + DoubleToString(profit, 2) +
            ",\"openPrice\":" + DoubleToString(open_price, 8) + "}";
      first = false;
   }
   js += "]";
   return js;
}

// Per-symbol CONTRACT SPECS straight from the broker. The backend was guessing pip
// value from a hardcoded table and had no idea about minimum stop distance, which
// produced both mis-sized trades and outright "Invalid stops" rejections. These are the
// authoritative numbers; sent periodically (they change rarely) to keep the poll small.
string TradeBridgeSpecsJson()
{
   if(!g_realtime_resolved) ResolveRealtimeSymbols();
   int count = ArraySize(g_realtime_symbols);
   string js = "[";
   bool first = true;
   for(int i = 0; i < count; i++)
   {
      string s = g_realtime_symbols[i];
      if(!SymbolSelect(s, true)) continue;
      double point     = SymbolInfoDouble(s, SYMBOL_POINT);
      double tickValue = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE);
      double tickSize  = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_SIZE);
      if(point <= 0 || tickSize <= 0) continue;
      // Margin for exactly 1.00 lot, computed by the terminal itself — this already
      // accounts for leverage, instrument type and any per-symbol margin rate, so the
      // backend never has to reimplement broker margin rules.
      double marginPerLot = 0.0;
      double askPx = SymbolInfoDouble(s, SYMBOL_ASK);
      if(askPx > 0 && !OrderCalcMargin(ORDER_TYPE_BUY, s, 1.0, askPx, marginPerLot)) marginPerLot = 0.0;
      if(!first) js += ",";
      js += "{\"symbol\":\"" + EscapeString(s) + "\"" +
            ",\"digits\":"       + IntegerToString((long)SymbolInfoInteger(s, SYMBOL_DIGITS)) +
            ",\"point\":"        + DoubleToString(point, 10) +
            ",\"tickValue\":"    + DoubleToString(tickValue, 6) +
            ",\"tickSize\":"     + DoubleToString(tickSize, 10) +
            ",\"contractSize\":" + DoubleToString(SymbolInfoDouble(s, SYMBOL_TRADE_CONTRACT_SIZE), 2) +
            ",\"stopsLevel\":"   + IntegerToString((long)SymbolInfoInteger(s, SYMBOL_TRADE_STOPS_LEVEL)) +
            ",\"freezeLevel\":"  + IntegerToString((long)SymbolInfoInteger(s, SYMBOL_TRADE_FREEZE_LEVEL)) +
            ",\"spread\":"       + IntegerToString((long)SymbolInfoInteger(s, SYMBOL_SPREAD)) +
            ",\"volMin\":"       + DoubleToString(SymbolInfoDouble(s, SYMBOL_VOLUME_MIN), 4) +
            ",\"volMax\":"       + DoubleToString(SymbolInfoDouble(s, SYMBOL_VOLUME_MAX), 2) +
            ",\"volStep\":"      + DoubleToString(SymbolInfoDouble(s, SYMBOL_VOLUME_STEP), 4) +
            ",\"marginPerLot\":" + DoubleToString(marginPerLot, 2) + "}";
      first = false;
   }
   js += "]";
   return js;
}

// Build the JSON array of OUR pending orders (magic-filtered).
string TradeBridgeOrdersJson()
{
   string js = "[";
   bool first = true;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(OrderGetInteger(ORDER_MAGIC) != InpTradeMagic) continue;
      string sym = OrderGetString(ORDER_SYMBOL);
      if(!first) js += ",";
      js += "{\"ticket\":" + IntegerToString((long)ticket) + ",\"symbol\":\"" + EscapeString(sym) + "\"}";
      first = false;
   }
   js += "]";
   return js;
}

// Detect positions (our magic) that vanished since the last poll -> they closed.
// Look the realized P&L up in the deal history and report it to the backend.
void TradeBridgeDetectCloses()
{
   long current[];
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpTradeMagic) continue;
      int n = ArraySize(current);
      ArrayResize(current, n + 1);
      current[n] = PositionGetInteger(POSITION_IDENTIFIER);
   }

   if(g_known_positions_primed)
   {
      for(int k = 0; k < ArraySize(g_known_positions); k++)
      {
         long pid = g_known_positions[k];
         bool still_open = false;
         for(int c = 0; c < ArraySize(current); c++)
            if(current[c] == pid) { still_open = true; break; }
         if(still_open) continue;

         // Closed - sum profit from the position deal history.
         double profit = 0.0;
         double close_price = 0.0;
         if(HistorySelectByPosition(pid))
         {
            int deals = HistoryDealsTotal();
            for(int d = 0; d < deals; d++)
            {
               ulong deal = HistoryDealGetTicket(d);
               if(deal == 0) continue;
               profit += HistoryDealGetDouble(deal, DEAL_PROFIT)
                       + HistoryDealGetDouble(deal, DEAL_SWAP)
                       + HistoryDealGetDouble(deal, DEAL_COMMISSION);
               if(HistoryDealGetInteger(deal, DEAL_ENTRY) == DEAL_ENTRY_OUT)
                  close_price = HistoryDealGetDouble(deal, DEAL_PRICE);
            }
         }
         string body = "{\"positionId\":" + IntegerToString(pid) +
                       ",\"profit\":" + DoubleToString(profit, 2) +
                       ",\"closePrice\":" + DoubleToString(close_price, 8) + "}";
         TradeBridgePost("/api/mt5/trade-closed", body);
         Print("Aura AutoTrade: position ", pid, " closed, P/L=", DoubleToString(profit, 2));
      }
   }

   ArrayResize(g_known_positions, ArraySize(current));
   for(int c = 0; c < ArraySize(current); c++) g_known_positions[c] = current[c];
   g_known_positions_primed = true;
}

// Periodic RECONCILIATION sweep: push every closed position (our magic) in a rolling
// window so the backend can adopt whatever the live close report lost.
//
// TradeBridgeDetectCloses() reports a close exactly ONCE, fire-and-forget, and drops the
// position from g_known_positions whether or not the POST arrived. A backend restart, a
// dropped request, or an EA reload therefore loses that trade permanently. This sweep is
// the safety net: it re-states history, so a missed close self-heals on the next pass.
// The backend keys on positionId and ignores duplicates, so replaying is harmless.
void TradeBridgeReportHistory()
{
   datetime from = TimeCurrent() - (datetime)(InpHistoryHours * 3600);
   if(!HistorySelect(from, TimeCurrent() + 3600)) return;

   string js = "{\"deals\":[";
   int emitted = 0;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0) continue;
      if(HistoryDealGetInteger(deal, DEAL_MAGIC) != InpTradeMagic) continue;
      // Only the closing leg carries the realized result for the position.
      if(HistoryDealGetInteger(deal, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;

      long pid = HistoryDealGetInteger(deal, DEAL_POSITION_ID);
      if(pid <= 0) continue;

      // Sum every deal on this position so partial closes and swap/commission are included.
      double profit = 0.0, open_price = 0.0, lots = 0.0;
      long open_time = 0;
      string dir = "?";
      if(HistorySelectByPosition(pid))
      {
         int pdeals = HistoryDealsTotal();
         for(int d = 0; d < pdeals; d++)
         {
            ulong pd = HistoryDealGetTicket(d);
            if(pd == 0) continue;
            profit += HistoryDealGetDouble(pd, DEAL_PROFIT)
                    + HistoryDealGetDouble(pd, DEAL_SWAP)
                    + HistoryDealGetDouble(pd, DEAL_COMMISSION);
            if(HistoryDealGetInteger(pd, DEAL_ENTRY) == DEAL_ENTRY_IN)
            {
               open_price = HistoryDealGetDouble(pd, DEAL_PRICE);
               lots       = HistoryDealGetDouble(pd, DEAL_VOLUME);
               open_time  = (long)HistoryDealGetInteger(pd, DEAL_TIME);
               dir = (HistoryDealGetInteger(pd, DEAL_TYPE) == DEAL_TYPE_BUY) ? "BUY" : "SELL";
            }
         }
         HistorySelect(from, TimeCurrent() + 3600);   // restore the window for the outer loop
      }

      if(emitted > 0) js += ",";
      js += "{\"positionId\":" + IntegerToString(pid) +
            ",\"symbol\":\"" + EscapeString(HistoryDealGetString(deal, DEAL_SYMBOL)) + "\"" +
            ",\"direction\":\"" + dir + "\"" +
            ",\"lots\":" + DoubleToString(lots, 2) +
            ",\"openPrice\":" + DoubleToString(open_price, 8) +
            ",\"closePrice\":" + DoubleToString(HistoryDealGetDouble(deal, DEAL_PRICE), 8) +
            ",\"profit\":" + DoubleToString(profit, 2) +
            ",\"openTime\":" + IntegerToString(open_time) +
            ",\"closeTime\":" + IntegerToString((long)HistoryDealGetInteger(deal, DEAL_TIME)) + "}";
      emitted++;
      if(emitted >= 200) break;   // keep the payload sane; the window rolls forward anyway
   }
   js += "]}";
   if(emitted > 0) TradeBridgePost("/api/mt5/trade-history", js);
}

//+------------------------------------------------------------------+
//| Trade-bridge leader election                                      |
//+------------------------------------------------------------------+
// The trade bridge is ACCOUNT-WIDE, not per-chart: it polls for commands, executes them, and
// reports closes for the whole terminal. Running it on every chart is not redundancy — it is
// the same work done N times.
//
// Measured on 2026-08-05 with 24 charts attached: ~8 bridge polls per second, 1,512 failed
// trade-history POSTs (err 5203), a single position close reported eleven times, and commands
// that executed at the broker but whose result POST never landed — which the backend then
// dead-lettered as "EA picked the command up but never reported a result".
//
// So exactly one chart runs it. The claim is a GlobalVariable holding a heartbeat timestamp,
// the same mechanism this EA already uses for the manual-history cursor. It is deliberately
// lease-based rather than a permanent flag: a permanent claim would leave the bridge dead if
// its chart were closed, the timeframe changed, or the terminal restarted mid-session.
#define TRADE_BRIDGE_LEADER_KEY  "AuraTradeBridgeLeader"
#define TRADE_BRIDGE_LEASE_SEC   15      // a lease older than this is treated as abandoned

// This instance's identity. ChartID is unique per chart within the terminal, which is exactly
// the scope the lease needs to cover.
long   g_bridge_leader_id   = 0;
bool   g_bridge_is_leader   = false;
datetime g_bridge_last_claim = 0;

bool TradeBridgeIsLeader()
{
   if(g_bridge_leader_id == 0) g_bridge_leader_id = ChartID();
   datetime now = TimeLocal();

   string owner_key = TRADE_BRIDGE_LEADER_KEY + "Owner";
   string beat_key  = TRADE_BRIDGE_LEADER_KEY + "Beat";

   double owner = GlobalVariableCheck(owner_key) ? GlobalVariableGet(owner_key) : 0;
   datetime beat = GlobalVariableCheck(beat_key) ? (datetime)GlobalVariableGet(beat_key) : 0;
   bool lease_expired = (now - beat) > TRADE_BRIDGE_LEASE_SEC;

   // Already ours: renew the lease and carry on. The renewal is what tells the other charts the
   // bridge is still alive.
   if((long)owner == g_bridge_leader_id && !lease_expired)
   {
      GlobalVariableSet(beat_key, (double)now);
      return true;
   }

   // Unclaimed, or the holder stopped renewing (chart closed, timeframe changed, terminal
   // restarted). Take it.
   if(owner == 0 || lease_expired)
   {
      GlobalVariableSet(owner_key, (double)g_bridge_leader_id);
      GlobalVariableSet(beat_key, (double)now);
      // Re-read: if two charts claimed in the same tick, only the one whose id survived the
      // write actually owns it. Without this both would believe they had won.
      if((long)GlobalVariableGet(owner_key) != g_bridge_leader_id)
      {
         g_bridge_is_leader = false;
         return false;
      }
      if(!g_bridge_is_leader)
      {
         g_bridge_is_leader = true;
         Print("Aura AutoTrade: this chart (", _Symbol, " ", EnumToString((ENUM_TIMEFRAMES)_Period),
               ") is now the trade-bridge leader — other charts will skip it");
      }
      return true;
   }

   // Someone else holds a live lease.
   if(g_bridge_is_leader)
   {
      g_bridge_is_leader = false;
      Print("Aura AutoTrade: another chart took over the trade bridge — this one is standing down");
   }
   return false;
}

// Release the claim on shutdown so the next chart can take over immediately rather than waiting
// out the lease. Best-effort: a hard terminal kill skips this, and the lease expiry covers it.
void TradeBridgeReleaseLeadership()
{
   if(!g_bridge_is_leader) return;
   string owner_key = TRADE_BRIDGE_LEADER_KEY + "Owner";
   if(GlobalVariableCheck(owner_key) && (long)GlobalVariableGet(owner_key) == g_bridge_leader_id)
   {
      GlobalVariableSet(owner_key, 0);
      GlobalVariableSet(TRADE_BRIDGE_LEADER_KEY + "Beat", 0);
      Print("Aura AutoTrade: released trade-bridge leadership");
   }
   g_bridge_is_leader = false;
}

// Small POST helper for bridge reports (fire-and-forget).
void TradeBridgePost(string path, string body)
{
   string url = InpServerUrl + path;
   string headers = "Content-Type: application/json\r\n";
   char post_bytes[]; char result[]; string result_headers;
   ArrayResize(post_bytes, StringLen(body));
   StringToCharArray(body, post_bytes, 0, StringLen(body), CP_UTF8);
   ResetLastError();
   int res = WebRequest("POST", url, headers, InpTimeout, post_bytes, result, result_headers);
   if(res < 200 || res >= 300)
      Print("Aura AutoTrade: POST ", path, " failed, code=", res, ", err=", GetLastError());
}

// A trade RESULT is not optional telemetry: it is the only record that an order reached the
// broker. A single timed-out POST used to lose it permanently, and the server then dead-lettered
// the command after three minutes as "EA picked the command up but never reported a result" —
// while the order was actually resting live. The backend stalls occasionally (database quota
// throttling, cold report endpoints), so one attempt is not enough.
//
// Retries with a widening pause. Deliberately NOT used for candle streaming, where a dropped
// frame is replaced by the next one a second later.
void TradeBridgePostCritical(string path, string body)
{
   for(int attempt = 0; attempt < 4; attempt++)
   {
      string url = InpServerUrl + path;
      string headers = "Content-Type: application/json\r\n";
      char post_bytes[]; char result[]; string result_headers;
      ArrayResize(post_bytes, StringLen(body));
      StringToCharArray(body, post_bytes, 0, StringLen(body), CP_UTF8);
      ResetLastError();
      // Longer than InpTimeout: this call must survive a slow backend, not give up on it.
      int res = WebRequest("POST", url, headers, 15000, post_bytes, result, result_headers);
      if(res >= 200 && res < 300) return;
      Print("Aura AutoTrade: POST ", path, " attempt ", attempt + 1, " failed, code=", res, ", err=", GetLastError());
      Sleep(500 * (attempt + 1));
   }
   Print("Aura AutoTrade: GIVING UP on ", path, " — the server will dead-letter this command");
}

// Broker-supported filling mode for a symbol.
ENUM_ORDER_TYPE_FILLING TradeBridgeFilling(string sym)
{
   long filling = SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_IOC) != 0) return ORDER_FILLING_IOC;
   if((filling & SYMBOL_FILLING_FOK) != 0) return ORDER_FILLING_FOK;
   return ORDER_FILLING_RETURN;
}

// Clamp lots to the symbol volume constraints.
double TradeBridgeNormalizeLots(string sym, double lots)
{
   double vmin  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double vstep = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(vstep > 0) lots = MathFloor(lots / vstep) * vstep;
   if(lots < vmin) lots = vmin;
   if(lots > vmax) lots = vmax;
   return NormalizeDouble(lots, 2);
}


// Attach a stop and target to an already-open position, retrying briefly.
//
// Only ever called AFTER a market order was refused with 10016 and re-sent bare. The values
// passed in are the STRATEGY's own sl/tp — nothing is recalculated or nudged here, so a trade
// either carries the stop it was designed with or it does not exist.
// Attach a stop (and optionally a target) to an OPEN position on request: SLTP|id|posId|sym|sl|tp
//
// The sniper mode enters bare on purpose — a market order with sl=0 cannot be refused for
// "10016 invalid stops", which is what 29 of 29 of this account's rejections were, and the
// ict-breaker edge dies within minutes of the trigger. This command is what closes that window
// a few seconds later.
//
// A tp of 0 means "stop only", which is the normal case here: the user sets targets by hand.
void TradeBridgeSetSlTp(string line)
{
   string f[];
   int n = StringSplit(line, '|', f);
   if(n < 6) { Print("Aura AutoTrade: malformed sltp: ", line); return; }
   string id      = f[1];
   long   pos_id  = (long)StringToInteger(f[2]);
   string sym     = f[3];
   double sl      = StringToDouble(f[4]);
   double tp      = StringToDouble(f[5]);

   string why = "";
   // Three attempts: the price is moving and a stop can momentarily sit inside the broker's
   // minimum distance. Giving up after one try would leave the position unprotected.
   bool ok = TradeBridgeApplySlTp(sym, pos_id, sl, tp, 3, why);

   string body = "{\"id\":\"" + EscapeString(id) + "\",\"action\":\"SLTP\"" +
                 ",\"ok\":" + (ok ? "true" : "false") +
                 ",\"message\":\"" + EscapeString(ok ? "stop attached" : why) + "\"}";
   TradeBridgePostCritical("/api/mt5/trade-result", body);
   Print("Aura AutoTrade: sltp ", (ok ? "OK " : "FAILED "), sym, " pos=", pos_id, " sl=", sl, (ok ? "" : " " + why));
}

bool TradeBridgeApplySlTp(string sym, long position_id, double sl, double tp, int attempts, string &fail_reason)
{
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   for(int a = 0; a < attempts; a++)
   {
      MqlTradeRequest r; MqlTradeResult rr;
      ZeroMemory(r); ZeroMemory(rr);
      r.action   = TRADE_ACTION_SLTP;
      r.symbol   = sym;
      r.position = position_id;
      r.sl       = (sl > 0) ? NormalizeDouble(sl, digits) : 0;
      r.tp       = (tp > 0) ? NormalizeDouble(tp, digits) : 0;
      r.magic    = InpTradeMagic;
      ResetLastError();
      bool sent = OrderSend(r, rr);
      if(sent && (rr.retcode == TRADE_RETCODE_DONE || rr.retcode == TRADE_RETCODE_PLACED))
         return true;
      fail_reason = "SLTP retcode " + IntegerToString((long)rr.retcode) + " " + rr.comment;
      Sleep(300);   // give the server a moment; prices move and the level may become valid
   }
   return false;
}

// Close a position we could not protect. Losing the trade is strictly better than holding
// unprotected size on an account with a daily-loss limit.
bool TradeBridgeCloseNaked(string sym, long position_id, double lots, bool was_buy)
{
   MqlTradeRequest r; MqlTradeResult rr;
   ZeroMemory(r); ZeroMemory(rr);
   r.action       = TRADE_ACTION_DEAL;
   r.symbol       = sym;
   r.position     = position_id;
   r.volume       = lots;
   r.type         = was_buy ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;   // opposite closes it
   r.price        = was_buy ? SymbolInfoDouble(sym, SYMBOL_BID) : SymbolInfoDouble(sym, SYMBOL_ASK);
   r.deviation    = InpTradeSlippage;
   r.magic        = InpTradeMagic;
   r.type_filling = TradeBridgeFilling(sym);
   r.comment      = "AuraAuto naked-close";
   ResetLastError();
   bool sent = OrderSend(r, rr);
   return sent && (rr.retcode == TRADE_RETCODE_DONE || rr.retcode == TRADE_RETCODE_DONE_PARTIAL);
}

// Remove a resting pending order: DEL|id|ticket|symbol
//
// Reports back through the same result endpoint with action=CANCEL, so the server only marks
// the row cancelled once the BROKER has confirmed it — a request that fails leaves the order
// live and says so, rather than the UI showing it gone while it still rests at the broker.
void TradeBridgeCancel(string line)
{
   string f[];
   int n = StringSplit(line, '|', f);
   if(n < 3) { Print("Aura AutoTrade: malformed cancel: ", line); return; }
   string id = f[1];
   ulong ticket = (ulong)StringToInteger(f[2]);

   MqlTradeRequest r; MqlTradeResult rr;
   ZeroMemory(r); ZeroMemory(rr);
   r.action = TRADE_ACTION_REMOVE;
   r.order  = ticket;
   ResetLastError();
   bool sent = OrderSend(r, rr);
   bool ok = sent && (rr.retcode == TRADE_RETCODE_DONE || rr.retcode == TRADE_RETCODE_PLACED);
   // An order that is already gone is a success from the caller's point of view: the goal was
   // "it must not be resting", and it is not.
   if(!ok && !OrderSelect(ticket)) ok = true;

   string body = "{\"id\":\"" + EscapeString(id) + "\",\"action\":\"CANCEL\"" +
                 ",\"ok\":" + (ok ? "true" : "false") +
                 ",\"retcode\":" + IntegerToString((long)rr.retcode) +
                 ",\"message\":\"" + EscapeString(rr.comment) + "\"}";
   TradeBridgePostCritical("/api/mt5/trade-result", body);
   Print("Aura AutoTrade: cancel ", (ok ? "OK " : "FAILED "), "ticket=", ticket, " retcode=", rr.retcode);
}

// Modify a RESTING pending order in place: MOD|id|ticket|symbol|entry|sl|tp
//
// TRADE_ACTION_MODIFY changes a pending order's price, stop and target. It deliberately does
// NOT carry a volume: MT5 cannot change a pending order's lot size, and silently ignoring a
// requested size change would leave the server believing a resize happened. The backend sends
// lot changes as a cancel plus a fresh CMD instead.
//
// Reports through the same result endpoint as CANCEL, so the row only leaves MODIFYING once the
// BROKER has confirmed — a failed modify leaves the original order resting and says so.
void TradeBridgeModify(string line)
{
   string f[];
   int n = StringSplit(line, '|', f);
   if(n < 7) { Print("Aura AutoTrade: malformed modify: ", line); return; }
   string id     = f[1];
   ulong  ticket = (ulong)StringToInteger(f[2]);
   string sym    = f[3];
   double entry  = StringToDouble(f[4]);
   double sl     = StringToDouble(f[5]);
   double tp     = StringToDouble(f[6]);

   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   MqlTradeRequest r; MqlTradeResult rr;
   ZeroMemory(r); ZeroMemory(rr);
   r.action = TRADE_ACTION_MODIFY;
   r.order  = ticket;
   r.symbol = sym;
   r.price  = NormalizeDouble(entry, digits);
   r.sl     = (sl > 0) ? NormalizeDouble(sl, digits) : 0;
   r.tp     = (tp > 0) ? NormalizeDouble(tp, digits) : 0;
   r.type_time = ORDER_TIME_GTC;
   ResetLastError();
   bool sent = OrderSend(r, rr);
   bool ok = sent && (rr.retcode == TRADE_RETCODE_DONE || rr.retcode == TRADE_RETCODE_PLACED);

   string body = "{\"id\":\"" + EscapeString(id) + "\",\"action\":\"MODIFY\"" +
                 ",\"ok\":" + (ok ? "true" : "false") +
                 ",\"retcode\":" + IntegerToString((long)rr.retcode) +
                 ",\"message\":\"" + EscapeString(rr.comment) + "\"}";
   TradeBridgePostCritical("/api/mt5/trade-result", body);
   Print("Aura AutoTrade: modify ", (ok ? "OK " : "FAILED "), "ticket=", ticket, " retcode=", rr.retcode);
}

// Execute one CMD line: CMD|id|symbol|dir|type|lots|sl|tp|entry|expiresMsEpoch
void TradeBridgeExecute(string line)
{
   string f[];
   int n = StringSplit(line, '|', f);
   if(n < 10) { Print("Aura AutoTrade: malformed command: ", line); return; }
   string id = f[1];
   string want_symbol = f[2];
   bool is_buy = (StringFind(f[3], "BUY") >= 0);
   string otype = f[4];
   double lots = StringToDouble(f[5]);
   double sl = StringToDouble(f[6]);
   double tp = StringToDouble(f[7]);
   double entry = StringToDouble(f[8]);
   long expires_ms = StringToInteger(f[9]);
   // Optional fields — absent when talking to an older server, in which case both gates stay off.
   double slip_tol_pct = (n >= 11) ? StringToDouble(f[10]) : -1.0;
   double risk_budget  = (n >= 12) ? StringToDouble(f[11]) : 0.0;

   // Resolve to the exact broker symbol (handles suffix/case, e.g. XAUUSDM -> XAUUSDm).
   string sym = MatchBrokerSymbol(want_symbol);
   if(sym == "") sym = want_symbol;
   SymbolSelect(sym, true);

   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   lots = TradeBridgeNormalizeLots(sym, lots);

   MqlTradeRequest req; MqlTradeResult res;
   ZeroMemory(req); ZeroMemory(res);
   req.symbol   = sym;
   req.volume   = lots;
   req.magic    = InpTradeMagic;
   req.deviation = InpTradeSlippage;
   req.sl = (sl > 0) ? NormalizeDouble(sl, digits) : 0;
   req.tp = (tp > 0) ? NormalizeDouble(tp, digits) : 0;
   req.type_filling = TradeBridgeFilling(sym);
   req.comment  = "AuraAuto";

   if(otype == "MARKET")
   {
      req.action = TRADE_ACTION_DEAL;
      req.type   = is_buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      req.price  = is_buy ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);

      // ── Slippage gate ──────────────────────────────────────────────────────────
      //
      // The ticket was priced when the signal fired; this fills at the live price while SL and
      // TP stay where they were. Every pip of adverse movement is taken OUT of the reward and
      // added INTO the risk. Live evidence: 508997768 filled 36.5 pips late, turning a planned
      // $40 risk into $71 and an RR of 2.46 into 0.18.
      //
      // Measured as a share of the STOP distance, mirroring backend/slippageGate.js, which is
      // where this rule is specified and tested.
      if(slip_tol_pct >= 0.0 && entry > 0 && sl > 0)
      {
         double planned_stop = MathAbs(entry - sl);
         if(planned_stop > 0)
         {
            double adverse = is_buy ? (req.price - entry) : (entry - req.price);
            double pct = (adverse / planned_stop) * 100.0;
            if(pct > slip_tol_pct)
            {
               string why = StringFormat("setup moved: filled %.1f%% of the stop distance away (limit %.1f%%)", pct, slip_tol_pct);
               Print("Aura AutoTrade: REFUSED ", sym, " — ", why);
               string body = "{\"id\":\"" + EscapeString(id) + "\",\"ok\":false,\"retcode\":0" +
                             ",\"message\":\"" + EscapeString(why) + "\"}";
               TradeBridgePostCritical("/api/mt5/trade-result", body);
               return;                                  // nothing is sent to the broker
            }

            // Within tolerance but still late: the stop is now further away than planned, so
            // hold the MONEY at risk constant by trimming the size. The stop is never moved —
            // it marks the level that invalidates the trade.
            if(risk_budget > 0 && adverse > 0)
            {
               double real_stop_dist = MathAbs(req.price - sl);
               double tick_val  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
               double tick_size = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
               if(real_stop_dist > 0 && tick_val > 0 && tick_size > 0)
               {
                  double loss_per_lot = (real_stop_dist / tick_size) * tick_val;
                  if(loss_per_lot > 0)
                  {
                     double want = risk_budget / loss_per_lot;
                     double resized = TradeBridgeNormalizeLots(sym, want);
                     if(resized > 0 && resized < lots)
                     {
                        Print("Aura AutoTrade: resized ", sym, " ", DoubleToString(lots, 2), " -> ",
                              DoubleToString(resized, 2), " lots to hold risk at ", DoubleToString(risk_budget, 2));
                        lots = resized;
                        req.volume = lots;
                     }
                  }
               }
            }
         }
      }
   }
   else // LIMIT or STOP pending order at the signal entry
   {
      req.action = TRADE_ACTION_PENDING;
      if(otype == "LIMIT") req.type = is_buy ? ORDER_TYPE_BUY_LIMIT : ORDER_TYPE_SELL_LIMIT;
      else                 req.type = is_buy ? ORDER_TYPE_BUY_STOP  : ORDER_TYPE_SELL_STOP;
      req.price = NormalizeDouble(entry, digits);
      // Expiration in SERVER time: epoch delta applied to the trade-server clock.
      long delta_sec = expires_ms / 1000 - (long)TimeGMT();
      long exp_mode = SymbolInfoInteger(sym, SYMBOL_EXPIRATION_MODE);
      if(delta_sec > 30 && (exp_mode & SYMBOL_EXPIRATION_SPECIFIED) != 0)
      {
         req.type_time   = ORDER_TIME_SPECIFIED;
         req.expiration  = (datetime)(TimeTradeServer() + delta_sec);
      }
      else
      {
         req.type_time = ORDER_TIME_GTC; // broker lacks expiry support; backend reconciles
      }
   }

   ResetLastError();
   bool sent = OrderSend(req, res);
   bool ok = sent && (res.retcode == TRADE_RETCODE_DONE || res.retcode == TRADE_RETCODE_PLACED || res.retcode == TRADE_RETCODE_DONE_PARTIAL);
   long ticket = (long)(res.order > 0 ? res.order : res.deal);
   double price = (res.price > 0) ? res.price : req.price;
   string extra_note = "";

   // ── 10016 fallback: open bare, then attach the SAME stop and target ──
   //
   // On market-execution accounts the broker fills at its own price and then validates the
   // attached SL/TP against THAT fill. If they do not satisfy its live constraint it refuses
   // the whole request, so nothing opens at all — 10016 with no position. This is what a
   // human works around by opening first and setting the stop afterwards.
   //
   // Deliberately a fallback, not the default: the normal path above keeps the position
   // protected from its first instant. Splitting every order into two requests would open a
   // window with no stop on EVERY trade. Here the window only exists on an order that was
   // otherwise refused outright, and it is closed immediately if the stop will not attach.
   //
   // The sl/tp values are the strategy's own, passed through untouched.
   if(!ok && res.retcode == TRADE_RETCODE_INVALID_STOPS && otype == "MARKET" && (sl > 0 || tp > 0))
   {
      Print("Aura AutoTrade: 10016 with stops attached — retrying bare then setting SL/TP on ", sym);
      MqlTradeRequest bare; MqlTradeResult bres;
      ZeroMemory(bare); ZeroMemory(bres);
      bare.action       = TRADE_ACTION_DEAL;
      bare.symbol       = sym;
      bare.volume       = lots;
      bare.magic        = InpTradeMagic;
      bare.deviation    = InpTradeSlippage;
      bare.type         = is_buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      bare.price        = is_buy ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);
      bare.type_filling = TradeBridgeFilling(sym);
      bare.comment      = "AuraAuto";
      bare.sl = 0; bare.tp = 0;                       // the whole point of the retry
      ResetLastError();
      bool bsent = OrderSend(bare, bres);
      bool bok = bsent && (bres.retcode == TRADE_RETCODE_DONE || bres.retcode == TRADE_RETCODE_DONE_PARTIAL);
      if(!bok)
      {
         extra_note = " (bare retry also failed: " + IntegerToString((long)bres.retcode) + ")";
         Print("Aura AutoTrade: bare retry failed on ", sym, " retcode=", bres.retcode);
      }
      else
      {
         // Resolve the position id: for a market fill it equals the opening order ticket.
         long pos_id = (long)bres.order;
         if(pos_id <= 0 && bres.deal > 0 && HistorySelectByPosition((long)bres.deal))
            pos_id = (long)HistoryDealGetInteger(bres.deal, DEAL_POSITION_ID);
         string why = "";
         if(TradeBridgeApplySlTp(sym, pos_id, sl, tp, 3, why))
         {
            ok = true;
            ticket = pos_id;
            price = (bres.price > 0) ? bres.price : bare.price;
            extra_note = " (opened bare, SL/TP set after fill)";
            Print("Aura AutoTrade: recovered ", sym, " — bare fill @", DoubleToString(price, 8), ", SL/TP attached");
         }
         else
         {
            // Could not protect it. Close rather than leave naked size on the account.
            bool closed = TradeBridgeCloseNaked(sym, pos_id, lots, is_buy);
            extra_note = closed
               ? " (opened bare but SL/TP refused: " + why + " — position CLOSED, no naked exposure)"
               : " (opened bare, SL/TP refused: " + why + " — AND CLOSE FAILED, position may be UNPROTECTED)";
            Print("Aura AutoTrade: could not attach SL/TP on ", sym, " — ", why,
                  closed ? " — closed the position" : " — CLOSE FAILED, CHECK THE TERMINAL");
         }
      }
   }

   string body = "{\"id\":\"" + EscapeString(id) + "\"" +
                 ",\"ok\":" + (ok ? "true" : "false") +
                 ",\"ticket\":" + IntegerToString(ticket) +
                 ",\"price\":" + DoubleToString(price, 8) +
                 ",\"retcode\":" + IntegerToString((long)res.retcode) +
                 ",\"message\":\"" + EscapeString(res.comment + extra_note) + "\"}";
   TradeBridgePostCritical("/api/mt5/trade-result", body);
   Print("Aura AutoTrade: ", (ok ? "EXECUTED " : "FAILED "), otype, " ", (is_buy ? "BUY " : "SELL "), sym,
         " lots=", DoubleToString(lots, 2), " retcode=", res.retcode, " ticket=", ticket, extra_note);
}

// Main poll: report state, receive commands, execute, detect closes.
void TradeBridgePoll()
{
   // 1) Detect and report closed positions FIRST (so results reach you fast).
   TradeBridgeDetectCloses();

   // 1b) Reconciliation sweep every ~20 polls (~1 min). The live close report above fires
   // once with no retry, so this is what recovers a close lost to a backend restart, a
   // dropped POST, or an EA reload. Idempotent on the backend.
   if(g_history_tick <= 0) TradeBridgeReportHistory();
   g_history_tick = (g_history_tick + 1) % 20;

   // 2) Poll with the live account + open-position report.
   bool is_demo = (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO);
   string body = "{\"account\":\"" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\"" +
                 ",\"broker\":\"" + EscapeString(AccountInfoString(ACCOUNT_COMPANY)) + "\"" +
                 ",\"server\":\"" + EscapeString(AccountInfoString(ACCOUNT_SERVER)) + "\"" +
                 ",\"demo\":" + (is_demo ? "true" : "false") +
                 ",\"currency\":\"" + EscapeString(AccountInfoString(ACCOUNT_CURRENCY)) + "\"" +
                 ",\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) +
                 ",\"marginFree\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) +
                 ",\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
                 ",\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) +
                 ",\"positions\":" + TradeBridgePositionsJson() +
                 ",\"orders\":" + TradeBridgeOrdersJson() +
                 // Specs change rarely; refresh every ~20 polls (~1 min) to keep polls small.
                 (g_spec_tick <= 0 ? ",\"specs\":" + TradeBridgeSpecsJson() : "") + "}";
   g_spec_tick = (g_spec_tick + 1) % 20;

   string url = InpServerUrl + "/api/mt5/trade-bridge";
   string headers = "Content-Type: application/json\r\n";
   char post_bytes[]; char result[]; string result_headers;
   ArrayResize(post_bytes, StringLen(body));
   StringToCharArray(body, post_bytes, 0, StringLen(body), CP_UTF8);
   ResetLastError();
   int res = WebRequest("POST", url, headers, InpTimeout, post_bytes, result, result_headers);
   if(res < 200 || res >= 300) return; // backend down/unreachable - nothing to do

   // 3) Execute any commands in the plain-text response.
   string text = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   string lines[];
   int count = StringSplit(text, '\n', lines);
   for(int i = 0; i < count; i++)
   {
      string line = lines[i];
      StringReplace(line, "\r", "");
      if(StringFind(line, "CMD|") == 0) TradeBridgeExecute(line);
      else if(StringFind(line, "DEL|") == 0) TradeBridgeCancel(line);
      else if(StringFind(line, "MOD|") == 0) TradeBridgeModify(line);
      else if(StringFind(line, "SLTP|") == 0) TradeBridgeSetSlTp(line);
   }
}
