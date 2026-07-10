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

input group             "Alert Settings"
input bool              InpTrackTrades   = true;                    // Send Alerts on Trades (Open/Close)
input bool              InpTrackSMACross = false;                   // Send Alerts on SMA Crossover
input ENUM_TIMEFRAMES   InpSMAtimeframe  = PERIOD_M15;              // SMA Timeframe
input int               InpFastSmaPeriod = 10;                      // Fast SMA Period
input int               InpSlowSmaPeriod = 20;                      // Slow SMA Period

//--- global variables
int      timer_ticks      = 0;
datetime last_heartbeat   = 0;
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
   
   // Set timer for heartbeats and snapshots
   if(InpSendHeartbeat || InpSendSnapshot)
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
   if(InpSendHeartbeat || InpSendSnapshot)
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

   // Always send heartbeats even during history sync to keep backend connection alive
   if(InpSendHeartbeat && (now - last_heartbeat >= InpHeartbeatSec))
   {
      SendHeartbeat();
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

   int total = SymbolsTotal(false); // first look in Market Watch
   for(int i = 0; i < total; i++)
   {
      string symbol = SymbolName(i, false);
      string sym_upper = symbol;
      StringToUpper(sym_upper);
      if(StringFind(sym_upper, clean_pair) >= 0)
      {
         return symbol;
      }
   }

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
