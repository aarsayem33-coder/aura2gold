/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env.local'), override: true });
dotenv.config();
import express from 'express';
import { GoogleAuth } from 'google-auth-library';
import fetch from 'node-fetch';
import rateLimit from 'express-rate-limit';
import { WebSocketServer, WebSocket } from 'ws';
import nodemailer from 'nodemailer';
import mysql from 'mysql2/promise';
import { aggregateSignals, detectSupportResistance, detectMarketStructure, detectLiquiditySweeps, detectOrderBlocks, detectFVGs, getTimeframeTrend } from './signalEngine.js';
import { detectLiquidityPools, detectBreaker, buildLiquidityPlan, classifyDrive, detectKeyLiquidityLevels, gradeSweep } from './liquidityEngine.js';
import { computeSnapshot as computeSignalSnapshot, evaluateSignalHealth, DEFAULT_HEALTH_CONFIG } from './signalHealthEngine.js';
import { listStrategies, evaluateStrategy, strategyTimeframes, computeStage, STRATEGIES as STRATEGY_LAB_REGISTRY } from './strategyLab.js';
import { symbolCapsFor, symbolAllowsSignalTf, symbolAllowsFixedTime, symbolAllowsForecast } from './instruments.js';
import { findOrderFillIndex } from './orderFill.js';
import { analyzeWithGemini, checkVertexAiHealth, analyzeFttWithGemini, analyzeProjectionWithGemini, analyzeAiSignalsWithGemini, analyzeChartImageWithGemini } from './geminiEngine.js';
import { buildSystemChartAnalysis, estimateDirectionalPersistence, buildConditionalTimeTrigger, pickTriggerLevel, normalizeDirection as normalizeChartDir } from './chartAnalysis.js';
import { generateFttPrediction, buildFttAiPrompt } from './fttEngine.js';
import { buildForecast as buildExecutionForecast, reforecast as reforecastExecution, FORECAST_TIMEFRAMES, timeframeSeconds as forecastTfSeconds, EXECUTABLE_SCORE as FC_EXECUTABLE_SCORE, WATCH_FLOOR as FC_WATCH_FLOOR, detectNewsReaction, buildNewsReactionLevels } from './executionForecastEngine.js';
import { buildBreakoutCandidate, breakoutFollowThrough, BREAKOUT_GRADE_RANK } from './breakoutEngine.js';
import { computeProjections } from './projectionEngine.js';
import { evaluateTrackedProjection, extractInvalidationPrice } from './trackedProjectionEngine.js';
import { setEconomicEvents, upsertEvents, getEconomicEvents, getStore as getCalendarStore, getUpcomingForSymbol, startCalendarFallback, fetchTradingEconomicsOnce } from './economicCalendar.js';
import { buildNewsSignals, buildPostNewsSignal, computeSurprise, affectedSymbols } from './newsEngine.js';
import { startNewsAlertScheduler } from './newsAlerts.js';
import { canAlert, recordAlert, pruneAlerts } from './signalAlerts.js';
import * as aiIndicators from './aiSignalsIndicators.js';

const app = express();
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({limit: process?.env?.API_PAYLOAD_MAX_SIZE || "50mb"}));
app.use(express.urlencoded({ extended: true, limit: process?.env?.API_PAYLOAD_MAX_SIZE || "50mb" }));
app.use(express.text({ type: 'text/plain', limit: process?.env?.API_PAYLOAD_MAX_SIZE || "50mb" }));

const PORT = process?.env?.API_BACKEND_PORT || 5000;
const API_BACKEND_HOST = process?.env?.API_BACKEND_HOST || "127.0.0.1";
const APP_TIME_ZONE = process?.env?.APP_TIME_ZONE || 'Asia/Dhaka';

const GOOGLE_CLOUD_LOCATION = process?.env?.GOOGLE_CLOUD_LOCATION;
const GOOGLE_CLOUD_PROJECT = process?.env?.GOOGLE_CLOUD_PROJECT;
const GEMINI_API_KEY = process?.env?.GEMINI_API_KEY || process?.env?.GOOGLE_API_KEY || '';
// AI auth can be EITHER a Gemini API key (AI Studio) OR Vertex AI (GCP project + location).
// Only hard-fail when neither path is configured.
if (!GEMINI_API_KEY && (!GOOGLE_CLOUD_PROJECT || !GOOGLE_CLOUD_LOCATION)) {
  console.error("Error: Configure AI auth — set GEMINI_API_KEY, or both GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.");
  process.exit(1);
}
const PROXY_HEADER = process?.env?.PROXY_HEADER;
if (!PROXY_HEADER) {
  console.error("Error: Environment variables PROXY_HEADER must be set.");
  process.exit(1);
}

// Cached, pooled transporter: creating one per email forced a full TCP+TLS+AUTH handshake
// (~1-3s) on EVERY send, and the notify pass awaits sends serially — on a busy bar close the
// last signal's email could lag many seconds. Pooling reuses warm connections, cutting the
// signal→email latency to the SMTP submit time. Delivery-only; no effect on signal logic.
let emailTransporterCache = null;
function getEmailTransporter() {
  const user = process?.env?.SMTP_USER;
  const pass = process?.env?.SMTP_PASS;
  if (!user || !pass) {
    throw new Error('SMTP_USER and SMTP_PASS must be set to send email notifications.');
  }
  if (emailTransporterCache) return emailTransporterCache;

  const port = Number(process?.env?.SMTP_PORT || 587);
  emailTransporterCache = nodemailer.createTransport({
    host: process?.env?.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: process?.env?.SMTP_SECURE === 'true' || port === 465,
    auth: { user, pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 200,
  });
  return emailTransporterCache;
}

const DB_HOST = process?.env?.DB_HOST;
const DB_PORT = Number(process?.env?.DB_PORT || 3306);
const DB_USER = process?.env?.DB_USER;
const DB_PASSWORD = process?.env?.DB_PASSWORD;
const DB_NAME = process?.env?.DB_NAME;
const DB_SSL = process?.env?.DB_SSL === 'true';
const hasDbConfig = Boolean(DB_HOST && DB_USER && DB_PASSWORD && DB_NAME);
const GEMINI_MODEL = process?.env?.GEMINI_MODEL || 'gemini-2.5-flash';
const AI_ANALYSIS_INTERVAL_MS = Number(process?.env?.AI_ANALYSIS_INTERVAL_MS || 300000);
const AI_MIN_CONFIDENCE = Number(process?.env?.AI_MIN_CONFIDENCE || 60);
let dbPool = null;
let dbInitPromise = null;

function toMysqlDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseJsonField(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeTrackedProjectionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceAnalysisId: row.source_analysis_id || null,
    symbol: row.symbol,
    tradeMode: row.trade_mode,
    decision: row.decision,
    entryPrice: row.entry_price === null || row.entry_price === undefined ? null : Number(row.entry_price),
    stopLoss: row.stop_loss === null || row.stop_loss === undefined ? null : Number(row.stop_loss),
    takeProfit1: row.take_profit_1 === null || row.take_profit_1 === undefined ? null : Number(row.take_profit_1),
    takeProfit2: row.take_profit_2 === null || row.take_profit_2 === undefined ? null : Number(row.take_profit_2),
    takeProfit3: row.take_profit_3 === null || row.take_profit_3 === undefined ? null : Number(row.take_profit_3),
    invalidation: row.invalidation || null,
    invalidationPrice: row.invalidation_price === null || row.invalidation_price === undefined ? null : Number(row.invalidation_price),
    tradeTrigger: row.trade_trigger,
    confidence: Number(row.confidence || 0),
    status: row.status,
    currentPrice: row.current_price === null || row.current_price === undefined ? null : Number(row.current_price),
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    triggeredAt: row.triggered_at ? new Date(row.triggered_at).toISOString() : null,
    invalidatedAt: row.invalidated_at ? new Date(row.invalidated_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    evaluation: parseJsonField(row.evaluation_json, null),
    originalAnalysis: parseJsonField(row.original_analysis_json, null),
  };
}

function formatAppDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-BD', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(date);
}

function getDbPool() {
  if (!hasDbConfig) return null;
  if (!dbPool) {
    dbPool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      ssl: DB_SSL ? { rejectUnauthorized: false } : undefined,
      timezone: 'Z',
    });
  }
  return dbPool;
}

async function addColumnIfMissing(pool, table, column, definition) {
  const [rows] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  if (rows.length) return;
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function ensureTrackedAiProjectionSchema(pool) {
  await addColumnIfMissing(pool, 'mt5_tracked_ai_projections', 'source_analysis_id', 'VARCHAR(128) NULL');
  await addColumnIfMissing(pool, 'mt5_tracked_ai_projections', 'take_profit_3', 'DECIMAL(20,8) NULL');
  await addColumnIfMissing(pool, 'mt5_tracked_ai_projections', 'invalidation_price', 'DECIMAL(20,8) NULL');
  await addColumnIfMissing(pool, 'mt5_tracked_ai_projections', 'current_price', 'DECIMAL(20,8) NULL');
  await addColumnIfMissing(pool, 'mt5_tracked_ai_projections', 'last_checked_at', 'DATETIME(3) NULL');
  await addColumnIfMissing(pool, 'mt5_tracked_ai_projections', 'triggered_at', 'DATETIME(3) NULL');
  await addColumnIfMissing(pool, 'mt5_tracked_ai_projections', 'invalidated_at', 'DATETIME(3) NULL');
  await addColumnIfMissing(pool, 'mt5_tracked_ai_projections', 'evaluation_json', 'LONGTEXT NULL');
  await addColumnIfMissing(pool, 'mt5_tracked_ai_projections', 'original_analysis_json', 'LONGTEXT NULL');
  // HOLD watch-mode tracking may not have a projected entry price.
  await pool.query('ALTER TABLE mt5_tracked_ai_projections MODIFY COLUMN entry_price DECIMAL(20,8) NULL');
}

async function initializeDatabase() {
  if (!hasDbConfig) return null;
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const pool = getDbPool();
      if (!pool) return null;

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_signals (
          id VARCHAR(96) PRIMARY KEY,
          received_at DATETIME(3) NOT NULL,
          signal_timestamp VARCHAR(128) NULL,
          symbol VARCHAR(32) NOT NULL,
          timeframe VARCHAR(32) NOT NULL,
          type VARCHAR(128) NOT NULL,
          direction VARCHAR(16) NOT NULL,
          price DECIMAL(20,8) NULL,
          bid DECIMAL(20,8) NULL,
          ask DECIMAL(20,8) NULL,
          volume DECIMAL(20,8) NULL,
          account VARCHAR(64) NULL,
          broker VARCHAR(128) NULL,
          terminal VARCHAR(128) NULL,
          rule_name VARCHAR(128) NULL,
          message TEXT NULL,
          status VARCHAR(32) NOT NULL,
          delivery_json LONGTEXT NULL,
          source_ip VARCHAR(64) NULL,
          raw_json LONGTEXT NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          KEY idx_mt5_signals_received_at (received_at),
          KEY idx_mt5_signals_symbol (symbol)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_delivery_logs (
          id VARCHAR(96) PRIMARY KEY,
          timestamp DATETIME(3) NOT NULL,
          channel VARCHAR(64) NOT NULL,
          recipient VARCHAR(255) NOT NULL,
          status VARCHAR(32) NOT NULL,
          signal_id VARCHAR(96) NULL,
          message_id VARCHAR(255) NULL,
          message TEXT NULL,
          error TEXT NULL,
          raw_json LONGTEXT NULL,
          KEY idx_mt5_delivery_logs_timestamp (timestamp),
          KEY idx_mt5_delivery_logs_signal_id (signal_id)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_candles (
          id VARCHAR(160) PRIMARY KEY,
          symbol VARCHAR(32) NOT NULL,
          timeframe VARCHAR(32) NOT NULL,
          candle_time DATETIME(3) NOT NULL,
          open_price DECIMAL(20,8) NULL,
          high DECIMAL(20,8) NULL,
          low DECIMAL(20,8) NULL,
          close_price DECIMAL(20,8) NULL,
          volume DECIMAL(20,8) NULL,
          spread DECIMAL(20,8) NULL,
          source_ip VARCHAR(64) NULL,
          raw_json LONGTEXT NOT NULL,
          received_at DATETIME(3) NOT NULL,
          KEY idx_mt5_candles_symbol_tf_time (symbol, timeframe, candle_time)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_trades (
          id VARCHAR(96) PRIMARY KEY,
          ticket VARCHAR(96) NOT NULL,
          symbol VARCHAR(32) NOT NULL,
          type VARCHAR(32) NOT NULL,
          volume DECIMAL(20,8) NULL,
          open_price DECIMAL(20,8) NULL,
          current_price DECIMAL(20,8) NULL,
          stop_loss DECIMAL(20,8) NULL,
          take_profit DECIMAL(20,8) NULL,
          profit DECIMAL(20,8) NULL,
          swap DECIMAL(20,8) NULL,
          commission DECIMAL(20,8) NULL,
          magic VARCHAR(64) NULL,
          comment TEXT NULL,
          status VARCHAR(32) NOT NULL,
          open_time DATETIME(3) NULL,
          close_time DATETIME(3) NULL,
          account VARCHAR(64) NULL,
          broker VARCHAR(128) NULL,
          terminal VARCHAR(128) NULL,
          source_ip VARCHAR(64) NULL,
          raw_json LONGTEXT NOT NULL,
          received_at DATETIME(3) NOT NULL,
          KEY idx_mt5_trades_symbol (symbol),
          KEY idx_mt5_trades_status (status)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_account_snapshots (
          id VARCHAR(128) PRIMARY KEY,
          received_at DATETIME(3) NOT NULL,
          account VARCHAR(64) NULL,
          broker VARCHAR(128) NULL,
          terminal VARCHAR(128) NULL,
          version VARCHAR(64) NULL,
          balance DECIMAL(20,8) NULL,
          equity DECIMAL(20,8) NULL,
          margin DECIMAL(20,8) NULL,
          free_margin DECIMAL(20,8) NULL,
          profit DECIMAL(20,8) NULL,
          currency VARCHAR(16) NULL,
          leverage DECIMAL(20,8) NULL,
          margin_level DECIMAL(20,8) NULL,
          open_orders DECIMAL(20,8) NULL,
          open_trades DECIMAL(20,8) NULL,
          symbols_json LONGTEXT NULL,
          timeframes_json LONGTEXT NULL,
          raw_json LONGTEXT NOT NULL,
          KEY idx_mt5_account_snapshots_received_at (received_at)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_indicators (
          id VARCHAR(255) PRIMARY KEY,
          symbol VARCHAR(20) NOT NULL,
          timeframe VARCHAR(10) NOT NULL,
          candle_time VARCHAR(64) NOT NULL,
          indicator_name VARCHAR(50) NOT NULL,
          value_1 DOUBLE NULL,
          value_2 DOUBLE NULL,
          value_3 DOUBLE NULL,
          value_4 DOUBLE NULL,
          value_5 DOUBLE NULL,
          created_at DATETIME(3) NOT NULL,
          raw_json LONGTEXT NOT NULL,
          KEY idx_symbol_tf (symbol, timeframe),
          KEY idx_time (candle_time)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_ai_decisions (
          id VARCHAR(128) PRIMARY KEY,
          symbol VARCHAR(20) NOT NULL,
          timeframe VARCHAR(10) NOT NULL,
          decision VARCHAR(32) NOT NULL,
          confidence DECIMAL(5,2) NOT NULL,
          entry_price DOUBLE NULL,
          stop_loss DOUBLE NULL,
          take_profit_1 DOUBLE NULL,
          take_profit_2 DOUBLE NULL,
          take_profit_3 DOUBLE NULL,
          risk_reward_ratio DECIMAL(5,2) NULL,
          reasoning TEXT NULL,
          signals_snapshot LONGTEXT NULL,
          indicators_snapshot LONGTEXT NULL,
          market_context LONGTEXT NULL,
          outcome VARCHAR(16) NOT NULL DEFAULT 'PENDING',
          outcome_pips DOUBLE NULL,
          created_at DATETIME(3) NOT NULL,
          expired_at DATETIME(3) NULL,
          trade_trigger VARCHAR(64) NULL,
          predicted_time VARCHAR(128) NULL,
          KEY idx_symbol (symbol),
          KEY idx_decision (decision),
          KEY idx_created (created_at)
        )
      `);

      try {
        await pool.query('ALTER TABLE mt5_ai_decisions ADD COLUMN trade_trigger VARCHAR(64) NULL');
      } catch (err) {
        // column may already exist
      }
      try {
        await pool.query('ALTER TABLE mt5_ai_decisions ADD COLUMN predicted_time VARCHAR(128) NULL');
      } catch (err) {
        // column may already exist
      }
      try {
        await pool.query('ALTER TABLE mt5_ai_decisions ADD COLUMN system_decision LONGTEXT NULL');
      } catch (err) {
        // column may already exist
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_signal_rules (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          indicator VARCHAR(50) NOT NULL,
          condition_type VARCHAR(50) NOT NULL,
          threshold_value DOUBLE NULL,
          threshold_value_2 DOUBLE NULL,
          symbols LONGTEXT NULL,
          timeframes LONGTEXT NULL,
          is_active BOOLEAN DEFAULT TRUE,
          weight DECIMAL(3,2) DEFAULT 1.00,
          notify_email BOOLEAN DEFAULT TRUE,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_market_levels (
          id INT AUTO_INCREMENT PRIMARY KEY,
          symbol VARCHAR(20) NOT NULL,
          level_type VARCHAR(32) NOT NULL,
          price DOUBLE NOT NULL,
          strength INT DEFAULT 1,
          source VARCHAR(50),
          notes TEXT,
          is_active BOOLEAN DEFAULT TRUE,
          created_at DATETIME(3) NOT NULL,
          KEY idx_symbol (symbol),
          KEY idx_active (is_active)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_trade_journal (
          id INT AUTO_INCREMENT PRIMARY KEY,
          decision_id VARCHAR(128) NULL,
          ticket VARCHAR(64) NULL,
          symbol VARCHAR(20) NOT NULL,
          direction VARCHAR(8) NOT NULL,
          entry_price DOUBLE NOT NULL,
          exit_price DOUBLE NULL,
          stop_loss DOUBLE NULL,
          take_profit DOUBLE NULL,
          lot_size DOUBLE NULL,
          profit_loss DOUBLE NULL,
          pips DOUBLE NULL,
          duration_minutes INT NULL,
          notes TEXT,
          tags LONGTEXT NULL,
          opened_at DATETIME(3) NOT NULL,
          closed_at DATETIME(3) NULL,
          KEY idx_symbol (symbol),
          KEY idx_opened (opened_at)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_ftt_predictions (
          id VARCHAR(128) PRIMARY KEY,
          symbol VARCHAR(32) NOT NULL,
          expiry VARCHAR(16) NOT NULL,
          direction VARCHAR(16) NOT NULL,
          confidence DECIMAL(5,2) NOT NULL,
          entry_price DOUBLE NULL,
          entry_time DATETIME(3) NOT NULL,
          expiry_time DATETIME(3) NOT NULL,
          exit_price DOUBLE NULL,
          outcome VARCHAR(16) NOT NULL DEFAULT 'PENDING',
          source VARCHAR(16) NOT NULL DEFAULT 'system',
          reasoning TEXT NULL,
          indicators_json LONGTEXT NULL,
          created_at DATETIME(3) NOT NULL,
          KEY idx_ftt_symbol (symbol),
          KEY idx_ftt_outcome (outcome),
          KEY idx_ftt_created (created_at)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_signal_email_reports (
          id VARCHAR(128) PRIMARY KEY,
          signal_type VARCHAR(16) NOT NULL,
          reference_id VARCHAR(128) NULL,
          symbol VARCHAR(32) NOT NULL,
          timeframe VARCHAR(16) NULL,
          expiry VARCHAR(16) NULL,
          direction VARCHAR(32) NOT NULL,
          entry_price DOUBLE NULL,
          exit_price DOUBLE NULL,
          stop_loss DOUBLE NULL,
          take_profit_1 DOUBLE NULL,
          profit_loss_pips DOUBLE NULL,
          confidence DECIMAL(5,2) NULL,
          grade VARCHAR(64) NULL,
          outcome VARCHAR(16) NOT NULL DEFAULT 'PENDING',
          signal_time DATETIME(3) NOT NULL,
          trade_time DATETIME(3) NULL,
          resolved_at DATETIME(3) NULL,
          email_sent_at DATETIME(3) NOT NULL,
          email_to VARCHAR(255) NULL,
          candle_bias_tf VARCHAR(16) NULL,
          candle_trend_tf VARCHAR(16) NULL,
          candle_entry_tf VARCHAR(16) NULL,
          candle_confirm_tf VARCHAR(16) NULL,
          payload_json LONGTEXT NULL,
          created_at DATETIME(3) NOT NULL,
          KEY idx_reports_type_outcome (signal_type, outcome),
          KEY idx_reports_signal_time (signal_time),
          KEY idx_reports_reference (reference_id)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_projection_reminders (
          id VARCHAR(128) PRIMARY KEY,
          projection_id VARCHAR(255) NOT NULL,
          symbol VARCHAR(32) NOT NULL,
          timeframe VARCHAR(32) NOT NULL,
          bias VARCHAR(16) NOT NULL,
          entry_price DECIMAL(20,8) NOT NULL,
          stop_loss DECIMAL(20,8) NOT NULL,
          take_profit_1 DECIMAL(20,8) NOT NULL,
          take_profit_2 DECIMAL(20,8) NOT NULL,
          suitability_forex BOOLEAN NOT NULL,
          suitability_ftt BOOLEAN NOT NULL,
          suitability_ftt_expiry VARCHAR(32) NULL,
          projected_touch_time DATETIME(3) NOT NULL,
          email VARCHAR(255) NOT NULL,
          math_confidence INT NOT NULL,
          grade VARCHAR(32) NOT NULL,
          rationale TEXT NULL,
          ai_on BOOLEAN NOT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
          check_result_json LONGTEXT NULL,
          created_at DATETIME(3) NOT NULL,
          KEY idx_reminders_status (status),
          KEY idx_reminders_touch_time (projected_touch_time)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_saved_projections (
          id VARCHAR(128) PRIMARY KEY,
          projection_id VARCHAR(255) NOT NULL,
          symbol VARCHAR(32) NOT NULL,
          timeframe VARCHAR(32) NOT NULL,
          bias VARCHAR(16) NOT NULL,
          entry_price DECIMAL(20,8) NOT NULL,
          stop_loss DECIMAL(20,8) NOT NULL,
          take_profit_1 DECIMAL(20,8) NOT NULL,
          take_profit_2 DECIMAL(20,8) NOT NULL,
          suitability_forex BOOLEAN NOT NULL,
          suitability_ftt BOOLEAN NOT NULL,
          suitability_ftt_expiry VARCHAR(32) NULL,
          projected_touch_time DATETIME(3) NOT NULL,
          math_confidence INT NOT NULL,
          grade VARCHAR(32) NOT NULL,
          rationale TEXT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
          created_at DATETIME(3) NOT NULL,
          resolved_at DATETIME(3) NULL,
          KEY idx_saved_status (status)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_tracked_ai_projections (
          id VARCHAR(128) PRIMARY KEY,
          source_analysis_id VARCHAR(128) NULL,
          symbol VARCHAR(32) NOT NULL,
          trade_mode VARCHAR(16) NOT NULL,
          decision VARCHAR(32) NOT NULL,
          entry_price DECIMAL(20,8) NULL,
          stop_loss DECIMAL(20,8) NULL,
          take_profit_1 DECIMAL(20,8) NULL,
          take_profit_2 DECIMAL(20,8) NULL,
          take_profit_3 DECIMAL(20,8) NULL,
          invalidation TEXT NULL,
          invalidation_price DECIMAL(20,8) NULL,
          trade_trigger VARCHAR(64) NOT NULL,
          confidence INT NOT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
          current_price DECIMAL(20,8) NULL,
          last_checked_at DATETIME(3) NULL,
          triggered_at DATETIME(3) NULL,
          invalidated_at DATETIME(3) NULL,
          expires_at DATETIME(3) NOT NULL,
          created_at DATETIME(3) NOT NULL,
          evaluation_json LONGTEXT NULL,
          original_analysis_json LONGTEXT NULL,
          KEY idx_tracked_ai_status (status),
          KEY idx_tracked_ai_symbol_status (symbol, status),
          KEY idx_tracked_ai_expires (expires_at)
        )
      `);

      await ensureTrackedAiProjectionSchema(pool);

      // System signal log: every NEW executable A/A+ forex setup the scanner
      // produces, whether or not it was emailed. One row per symbol|timeframe|bar
      // (unique key prevents re-scan duplicates). emailed flags the ones that also
      // went out as alerts; outcome is auto-resolved later by the same TP/SL logic.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_system_signal_log (
          id VARCHAR(160) PRIMARY KEY,
          symbol VARCHAR(32) NOT NULL,
          timeframe VARCHAR(16) NOT NULL,
          bar_time DATETIME(3) NOT NULL,
          signal_time DATETIME(3) NOT NULL,
          direction VARCHAR(32) NOT NULL,
          grade VARCHAR(64) NULL,
          signal_quality VARCHAR(64) NULL,
          confidence DECIMAL(5,2) NULL,
          entry_price DOUBLE NULL,
          stop_loss DOUBLE NULL,
          take_profit_1 DOUBLE NULL,
          take_profit_2 DOUBLE NULL,
          take_profit_3 DOUBLE NULL,
          strategy_type VARCHAR(64) NULL,
          session VARCHAR(255) NULL,
          regime VARCHAR(64) NULL,
          pattern VARCHAR(64) NULL,
          emailed BOOLEAN NOT NULL DEFAULT 0,
          email_report_id VARCHAR(128) NULL,
          outcome VARCHAR(16) NOT NULL DEFAULT 'PENDING',
          exit_price DOUBLE NULL,
          profit_loss_pips DOUBLE NULL,
          tp_hit_level INT NULL,
          mfe_pips DOUBLE NULL,
          mae_pips DOUBLE NULL,
          resolved_at DATETIME(3) NULL,
          payload_json LONGTEXT NULL,
          created_at DATETIME(3) NOT NULL,
          UNIQUE KEY uniq_signal_bar (symbol, timeframe, bar_time),
          KEY idx_sslog_outcome (outcome),
          KEY idx_sslog_signal_time (signal_time),
          KEY idx_sslog_emailed (emailed)
        )
      `);

      // Breakout alerts: compact record of every graded breakout alert that was
      // emitted (PRE/CONFIRMED), for a track record + dedup audit. Deliberately
      // tiny (no blobs) and retention-pruned so it never re-bloats the DB.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_breakout_alerts (
          id VARCHAR(120) PRIMARY KEY,
          symbol VARCHAR(32) NOT NULL,
          timeframe VARCHAR(16) NOT NULL,
          phase VARCHAR(12) NOT NULL,
          direction VARCHAR(8) NOT NULL,
          grade VARCHAR(2) NOT NULL,
          score DECIMAL(5,1) NOT NULL,
          trend VARCHAR(8) NULL,
          level DOUBLE NULL,
          level_strength INT NULL,
          price DOUBLE NULL,
          atr DOUBLE NULL,
          distance_atr DECIMAL(6,2) NULL,
          body_atr DECIMAL(6,2) NULL,
          displacement TINYINT(1) NOT NULL DEFAULT 0,
          channel VARCHAR(16) NOT NULL,
          bar_time DATETIME(3) NULL,
          created_at DATETIME(3) NOT NULL,
          KEY idx_bk_symbol_tf (symbol, timeframe),
          KEY idx_bk_created (created_at)
        )
      `);

      // Execution forecasts: one CURRENT forecast row per (symbol, timeframe),
      // upserted each hourly scan. Predicts WHEN a favorable setup becomes
      // executable. Deliberately compact (no LONGTEXT blob) and retention-pruned
      // so it never re-bloats the DB like mt5_account_snapshots did.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_execution_forecasts (
          id VARCHAR(96) PRIMARY KEY,
          symbol VARCHAR(32) NOT NULL,
          timeframe VARCHAR(16) NOT NULL,
          scan_time DATETIME(3) NOT NULL,
          current_status VARCHAR(32) NOT NULL,
          execution_status VARCHAR(32) NOT NULL,
          decision VARCHAR(16) NULL,
          setup_score DECIMAL(5,1) NOT NULL,
          score_change DECIMAL(6,1) NULL,
          trend_strength DECIMAL(5,1) NULL,
          momentum DECIMAL(5,1) NULL,
          volatility DECIMAL(5,1) NULL,
          liquidity DECIMAL(5,1) NULL,
          session VARCHAR(64) NULL,
          regime VARCHAR(32) NULL,
          execution_probability DECIMAL(5,1) NULL,
          forecast_confidence DECIMAL(5,1) NULL,
          forecast_basis VARCHAR(48) NULL,
          expected_execution_time DATETIME(3) NULL,
          prev_execution_time DATETIME(3) NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'FORECASTED',
          reforecast_count INT NOT NULL DEFAULT 0,
          reason VARCHAR(255) NULL,
          entry_price DOUBLE NULL,
          stop_loss DOUBLE NULL,
          take_profit_1 DOUBLE NULL,
          original_execution_time DATETIME(3) NULL,
          original_score DECIMAL(5,1) NULL,
          calibrated BOOLEAN NOT NULL DEFAULT 0,
          news_imminent BOOLEAN NOT NULL DEFAULT 0,
          news_event VARCHAR(160) NULL,
          news_event_time DATETIME(3) NULL,
          news_tier VARCHAR(2) NULL,
          email_created BOOLEAN NOT NULL DEFAULT 0,
          email_reminder1 BOOLEAN NOT NULL DEFAULT 0,
          email_reminder2 BOOLEAN NOT NULL DEFAULT 0,
          email_execution BOOLEAN NOT NULL DEFAULT 0,
          actual_execution_time DATETIME(3) NULL,
          forecast_accuracy DECIMAL(5,1) NULL,
          timing_accuracy DECIMAL(5,1) NULL,
          score_accuracy DECIMAL(5,1) NULL,
          resolved_at DATETIME(3) NULL,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          KEY idx_fc_status (status),
          KEY idx_fc_symbol_tf (symbol, timeframe),
          KEY idx_fc_eta (expected_execution_time)
        )
      `);
      // Phase 5 columns (the table may already exist from Phase 1 on the live DB).
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'original_execution_time', 'DATETIME(3) NULL');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'original_score', 'DECIMAL(5,1) NULL');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'calibrated', 'BOOLEAN NOT NULL DEFAULT 0');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'news_imminent', 'BOOLEAN NOT NULL DEFAULT 0');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'news_event', 'VARCHAR(160) NULL');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'news_event_time', 'DATETIME(3) NULL');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'news_tier', 'VARCHAR(2) NULL');
      // Directional lean (BUY/SELL/NEUTRAL) — the tilt of a still-Building setup
      // before its decision commits off HOLD. Compact; heeds Trap #6.
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'lean', "VARCHAR(8) NULL");
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'lean_conviction', 'DECIMAL(6,1) NULL');
      // Trade outcome tracking for EXECUTED forecasts — settles WIN/LOSS by replaying
      // the entry/SL/TP ladder against real candles (same engine as the system signal
      // log). The forecast "track record": did the setup we announced ready pay off?
      // Compact; pruned with the rest of the row, so it never re-bloats the DB.
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'take_profit_2', 'DOUBLE NULL');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'take_profit_3', 'DOUBLE NULL');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'trade_outcome', 'VARCHAR(16) NULL');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'trade_exit_price', 'DOUBLE NULL');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'trade_pips', 'DOUBLE NULL');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'trade_tp_hit_level', 'INT NULL');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'trade_mfe_pips', 'DOUBLE NULL');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'trade_mae_pips', 'DOUBLE NULL');
      await addColumnIfMissing(pool, 'mt5_execution_forecasts', 'trade_resolved_at', 'DATETIME(3) NULL');

      // Signal Tracker "Done" dismissals — user marked the trade closed, so it drops
      // off the tracker and stops alerting. Tiny (one row per dismissed trade), pruned.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_signal_tracker_dismissed (
          id VARCHAR(160) PRIMARY KEY,
          dismissed_at DATETIME(3) NOT NULL
        )
      `);

      // Strategy Lab — isolated single-strategy signals (NOT the main system). One row
      // per strategy|symbol|timeframe|bar. Each signal is scored two ways: forex (TP/SL
      // replay) and fixed-time (direction at next-candle expiry). Compact + pruned.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_strategy_signals (
          id VARCHAR(200) PRIMARY KEY,
          strategy VARCHAR(48) NOT NULL,
          symbol VARCHAR(32) NOT NULL,
          timeframe VARCHAR(16) NOT NULL,
          bar_time DATETIME(3) NOT NULL,
          signal_time DATETIME(3) NOT NULL,
          direction VARCHAR(16) NOT NULL,
          score DECIMAL(5,1) NULL,
          grade VARCHAR(8) NULL,
          entry_price DOUBLE NULL,
          stop_loss DOUBLE NULL,
          take_profit_1 DOUBLE NULL,
          take_profit_2 DOUBLE NULL,
          take_profit_3 DOUBLE NULL,
          risk_reward DOUBLE NULL,
          reason VARCHAR(255) NULL,
          outcome VARCHAR(16) NOT NULL DEFAULT 'PENDING',
          exit_price DOUBLE NULL,
          profit_loss_pips DOUBLE NULL,
          tp_hit_level INT NULL,
          mfe_pips DOUBLE NULL,
          mae_pips DOUBLE NULL,
          ft_outcome VARCHAR(16) NOT NULL DEFAULT 'PENDING',
          ft_exit_price DOUBLE NULL,
          ft_pips DOUBLE NULL,
          resolved_at DATETIME(3) NULL,
          created_at DATETIME(3) NOT NULL,
          KEY idx_strat_outcome (strategy, outcome),
          KEY idx_strat_ft (strategy, ft_outcome),
          KEY idx_strat_signal_time (signal_time),
          KEY idx_strat_sym_tf (strategy, symbol, timeframe)
        )
      `);
      // score/grade may be absent if the table was created before scoring was added.
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'score', 'DECIMAL(5,1) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'grade', 'VARCHAR(8) NULL');
      // Channel tracking (display only — never affects scoring/outcomes): was this signal
      // surfaced as a live popup and/or sent by email when it was first logged.
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'popup_sent', 'TINYINT NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'email_sent', 'TINYINT NULL');
      // AS-TRADED fixed-time outcome (realistic): reference = the LIVE price captured when the
      // signal fired (at_ref_price), expiry = signal_time + one TF candle. Settled close-to-the-
      // expiry-instant. Distinct from the idealized ft_outcome (signal-bar close → next-bar close).
      // at_ref_price NULL = logged before this feature → never settled (no sub-bar history).
      // Score evolution tracking (display-only): `score`/`grade` stay FROZEN at first
      // detection (the honest ranking basis); when a later re-detection of the same signal
      // bar computes a different score, the latest value + when it changed are stored here.
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'latest_score', 'DECIMAL(5,1) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'latest_grade', 'VARCHAR(8) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'score_updated_at', 'DATETIME(3) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'at_ref_price', 'DOUBLE NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'at_outcome', 'VARCHAR(16) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'at_exit_price', 'DOUBLE NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'at_pips', 'DOUBLE NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'at_expiry_time', 'DATETIME(3) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'strategy_version', 'INT NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'setup_plan', 'VARCHAR(32) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'entry_order_type', 'VARCHAR(16) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'entry_state', 'VARCHAR(16) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'entry_filled_at', 'DATETIME(3) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'setup_event_time', 'DATETIME(3) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'alert_bar_time', 'DATETIME(3) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'valid_until', 'DATETIME(3) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'measure_fixed_time', 'TINYINT NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'corrected_outcome', 'VARCHAR(16) NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'corrected_pips', 'DOUBLE NULL');
      await addColumnIfMissing(pool, 'mt5_strategy_signals', 'correction_reason', 'VARCHAR(255) NULL');

      return pool;
    })().catch((error) => {
      console.error('[MySQL] Initialization failed:', error.message);
      console.error('[MySQL] Continuing with existing pool; schema-dependent features may be degraded.');
      return dbPool;
    });
  }

  return dbInitPromise;
}

async function persistSignal(signal) {
  const pool = await initializeDatabase();
  if (!pool) return;

  await pool.execute(
    `INSERT INTO mt5_signals (
      id, received_at, signal_timestamp, symbol, timeframe, type, direction,
      price, bid, ask, volume, account, broker, terminal, rule_name,
      message, status, delivery_json, source_ip, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      received_at = VALUES(received_at),
      signal_timestamp = VALUES(signal_timestamp),
      symbol = VALUES(symbol),
      timeframe = VALUES(timeframe),
      type = VALUES(type),
      direction = VALUES(direction),
      price = VALUES(price),
      bid = VALUES(bid),
      ask = VALUES(ask),
      volume = VALUES(volume),
      account = VALUES(account),
      broker = VALUES(broker),
      terminal = VALUES(terminal),
      rule_name = VALUES(rule_name),
      message = VALUES(message),
      status = VALUES(status),
      delivery_json = VALUES(delivery_json),
      source_ip = VALUES(source_ip),
      raw_json = VALUES(raw_json),
      updated_at = VALUES(updated_at)`,
    [
      signal.id,
      toMysqlDate(signal.receivedAt),
      signal.timestamp || null,
      signal.symbol,
      signal.timeframe,
      signal.type,
      signal.direction,
      signal.price,
      signal.bid,
      signal.ask,
      signal.volume,
      signal.account,
      signal.broker,
      signal.terminal,
      signal.rule,
      signal.message,
      signal.status,
      signal.delivery ? JSON.stringify(signal.delivery) : null,
      signal.sourceIp || null,
      JSON.stringify(signal.raw || {}),
      toMysqlDate(),
    ]
  );
}

async function persistDeliveryLog(log) {
  const pool = await initializeDatabase();
  if (!pool) return;

  await pool.execute(
    `INSERT INTO mt5_delivery_logs (
      id, timestamp, channel, recipient, status, signal_id, message_id, message, error, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      timestamp = VALUES(timestamp),
      channel = VALUES(channel),
      recipient = VALUES(recipient),
      status = VALUES(status),
      signal_id = VALUES(signal_id),
      message_id = VALUES(message_id),
      message = VALUES(message),
      error = VALUES(error),
      raw_json = VALUES(raw_json)`,
    [
      log.id,
      toMysqlDate(log.timestamp),
      log.channel,
      log.recipient,
      log.status,
      log.signalId || null,
      log.messageId || null,
      log.message || null,
      log.error || null,
      JSON.stringify(log.raw || {}),
    ]
  );
}

async function persistCandle(candle) {
  const pool = await initializeDatabase();
  if (!pool) return;

  await pool.execute(
    `INSERT INTO mt5_candles (
      id, symbol, timeframe, candle_time, open_price, high, low, close_price, volume, spread, source_ip, raw_json, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      symbol = VALUES(symbol),
      timeframe = VALUES(timeframe),
      candle_time = VALUES(candle_time),
      open_price = VALUES(open_price),
      high = VALUES(high),
      low = VALUES(low),
      close_price = VALUES(close_price),
      volume = VALUES(volume),
      spread = VALUES(spread),
      source_ip = VALUES(source_ip),
      raw_json = VALUES(raw_json),
      received_at = VALUES(received_at)`,
    [
      candle.id,
      candle.symbol,
      candle.timeframe,
      toMysqlDate(candle.time),
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
      candle.spread,
      candle.sourceIp || null,
      '{}', // raw_json intentionally not stored for candles — saves ~half the table size
      toMysqlDate(),
    ]
  );
}

async function persistCandlesBatch(candlesList) {
  if (!candlesList || candlesList.length === 0) return;
  const pool = await initializeDatabase();
  if (!pool) return;

  const CHUNK_SIZE = 2000;
  for (let i = 0; i < candlesList.length; i += CHUNK_SIZE) {
    const chunk = candlesList.slice(i, i + CHUNK_SIZE);
    const values = [];
    const placeholders = [];

    for (const candle of chunk) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      values.push(
        candle.id,
        candle.symbol,
        candle.timeframe,
        toMysqlDate(candle.time),
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
        candle.spread,
        candle.sourceIp || null,
        '{}', // raw_json intentionally not stored for candles — saves ~half the table size
        toMysqlDate()
      );
    }

    const query = `
      INSERT INTO mt5_candles (
        id, symbol, timeframe, candle_time, open_price, high, low, close_price, volume, spread, source_ip, raw_json, received_at
      ) VALUES ${placeholders.join(', ')}
      ON DUPLICATE KEY UPDATE
        symbol = VALUES(symbol),
        timeframe = VALUES(timeframe),
        candle_time = VALUES(candle_time),
        open_price = VALUES(open_price),
        high = VALUES(high),
        low = VALUES(low),
        close_price = VALUES(close_price),
        volume = VALUES(volume),
        spread = VALUES(spread),
        source_ip = VALUES(source_ip),
        raw_json = VALUES(raw_json),
        received_at = VALUES(received_at)
    `;

    await pool.query(query, values);
  }
}

async function persistTrade(trade) {
  const pool = await initializeDatabase();
  if (!pool) return;

  await pool.execute(
    `INSERT INTO mt5_trades (
      id, ticket, symbol, type, volume, open_price, current_price, stop_loss, take_profit,
      profit, swap, commission, magic, comment, status, open_time, close_time,
      account, broker, terminal, source_ip, raw_json, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      ticket = VALUES(ticket),
      symbol = VALUES(symbol),
      type = VALUES(type),
      volume = VALUES(volume),
      open_price = VALUES(open_price),
      current_price = VALUES(current_price),
      stop_loss = VALUES(stop_loss),
      take_profit = VALUES(take_profit),
      profit = VALUES(profit),
      swap = VALUES(swap),
      commission = VALUES(commission),
      magic = VALUES(magic),
      comment = VALUES(comment),
      status = VALUES(status),
      open_time = VALUES(open_time),
      close_time = VALUES(close_time),
      account = VALUES(account),
      broker = VALUES(broker),
      terminal = VALUES(terminal),
      source_ip = VALUES(source_ip),
      raw_json = VALUES(raw_json),
      received_at = VALUES(received_at)`,
    [
      trade.id,
      trade.ticket,
      trade.symbol,
      trade.type,
      trade.volume,
      trade.openPrice,
      trade.currentPrice,
      trade.stopLoss,
      trade.takeProfit,
      trade.profit,
      trade.swap,
      trade.commission,
      trade.magic,
      trade.comment,
      trade.status,
      toMysqlDate(trade.openTime),
      trade.closeTime ? toMysqlDate(trade.closeTime) : null,
      trade.account,
      trade.broker,
      trade.terminal,
      trade.sourceIp || null,
      JSON.stringify(trade.raw || {}),
      toMysqlDate(),
    ]
  );
}

async function persistAccountSnapshot(snapshot) {
  const pool = await initializeDatabase();
  if (!pool) return;

  await pool.execute(
    `INSERT INTO mt5_account_snapshots (
      id, received_at, account, broker, terminal, version, balance, equity, margin, free_margin,
      profit, currency, leverage, margin_level, open_orders, open_trades, symbols_json, timeframes_json, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      received_at = VALUES(received_at),
      account = VALUES(account),
      broker = VALUES(broker),
      terminal = VALUES(terminal),
      version = VALUES(version),
      balance = VALUES(balance),
      equity = VALUES(equity),
      margin = VALUES(margin),
      free_margin = VALUES(free_margin),
      profit = VALUES(profit),
      currency = VALUES(currency),
      leverage = VALUES(leverage),
      margin_level = VALUES(margin_level),
      open_orders = VALUES(open_orders),
      open_trades = VALUES(open_trades),
      symbols_json = VALUES(symbols_json),
      timeframes_json = VALUES(timeframes_json),
      raw_json = VALUES(raw_json)`,
    [
      snapshot.id,
      toMysqlDate(snapshot.receivedAt),
      snapshot.account,
      snapshot.broker,
      snapshot.terminal,
      snapshot.version,
      snapshot.balance,
      snapshot.equity,
      snapshot.margin,
      snapshot.freeMargin,
      snapshot.profit,
      snapshot.currency,
      snapshot.leverage,
      snapshot.marginLevel,
      snapshot.openOrders,
      snapshot.openTrades,
      // Heartbeat telemetry only: the fat JSON blobs (full symbols/timeframes/raw
      // payload, ~600KB each) were filling the DB. Scoring uses the in-memory live
      // snapshot, and the boot-restore only needs the scalar columns above, so we
      // no longer persist these blobs. (Nothing reads them except a brief boot seed
      // that the first heartbeat overwrites within seconds.) raw_json is NOT NULL in
      // the schema, so write '{}' (same trick as candles) rather than null.
      null,
      null,
      '{}',
    ]
  );
}

// Retention: prune account-snapshot telemetry older than SNAPSHOT_RETENTION_DAYS.
// Throttled to once per hour; batched DELETE keeps it under the statement timeout.
let lastSnapshotPruneMs = 0;
async function pruneOldAccountSnapshots() {
  const nowMs = Date.now();
  if (nowMs - lastSnapshotPruneMs < 3600000) return; // at most hourly
  lastSnapshotPruneMs = nowMs;
  const pool = await initializeDatabase();
  if (!pool) return;
  try {
    await pool.execute(
      'DELETE FROM mt5_account_snapshots WHERE received_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) LIMIT 5000',
      [SNAPSHOT_RETENTION_DAYS]
    );
  } catch (err) {
    console.error('[Snapshots] retention prune failed:', err.message);
  }
}

async function persistIndicator(indicator) {
  const pool = await initializeDatabase();
  if (!pool) return;

  await pool.execute(
    `INSERT INTO mt5_indicators (
      id, symbol, timeframe, candle_time, indicator_name, value_1, value_2, value_3, value_4, value_5, created_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      symbol = VALUES(symbol),
      timeframe = VALUES(timeframe),
      candle_time = VALUES(candle_time),
      indicator_name = VALUES(indicator_name),
      value_1 = VALUES(value_1),
      value_2 = VALUES(value_2),
      value_3 = VALUES(value_3),
      value_4 = VALUES(value_4),
      value_5 = VALUES(value_5),
      created_at = VALUES(created_at),
      raw_json = VALUES(raw_json)`,
    [
      indicator.id,
      indicator.symbol,
      indicator.timeframe,
      indicator.candleTime,
      indicator.indicator,
      indicator.value1,
      indicator.value2,
      indicator.value3,
      indicator.value4,
      indicator.value5,
      toMysqlDate(indicator.createdAt),
      JSON.stringify(indicator.raw || {}),
    ]
  );
}

async function persistAiDecision(decision) {
  const pool = await initializeDatabase();
  if (!pool) return;

  await pool.execute(
    `INSERT INTO mt5_ai_decisions (
      id, symbol, timeframe, decision, confidence, entry_price, stop_loss, take_profit_1, take_profit_2, take_profit_3,
      risk_reward_ratio, reasoning, signals_snapshot, indicators_snapshot, market_context, outcome, outcome_pips, created_at, expired_at,
      trade_trigger, predicted_time, system_decision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      symbol = VALUES(symbol),
      timeframe = VALUES(timeframe),
      decision = VALUES(decision),
      confidence = VALUES(confidence),
      entry_price = VALUES(entry_price),
      stop_loss = VALUES(stop_loss),
      take_profit_1 = VALUES(take_profit_1),
      take_profit_2 = VALUES(take_profit_2),
      take_profit_3 = VALUES(take_profit_3),
      risk_reward_ratio = VALUES(risk_reward_ratio),
      reasoning = VALUES(reasoning),
      signals_snapshot = VALUES(signals_snapshot),
      indicators_snapshot = VALUES(indicators_snapshot),
      market_context = VALUES(market_context),
      outcome = VALUES(outcome),
      outcome_pips = VALUES(outcome_pips),
      created_at = VALUES(created_at),
      expired_at = VALUES(expired_at),
      trade_trigger = VALUES(trade_trigger),
      predicted_time = VALUES(predicted_time),
      system_decision = VALUES(system_decision)`,
    [
      decision.id,
      decision.symbol,
      decision.timeframe,
      decision.decision,
      decision.confidence,
      decision.entry_price,
      decision.stop_loss,
      decision.take_profit_1,
      decision.take_profit_2,
      decision.take_profit_3,
      decision.risk_reward_ratio,
      decision.reasoning,
      JSON.stringify(decision.signals_snapshot || null),
      JSON.stringify(decision.indicators_snapshot || null),
      JSON.stringify(decision.market_context || null),
      decision.outcome,
      decision.outcome_pips,
      toMysqlDate(decision.created_at),
      decision.expired_at ? toMysqlDate(decision.expired_at) : null,
      decision.trade_trigger || null,
      decision.predicted_time || null,
      JSON.stringify(decision.system_decision || null),
    ]
  );
}

async function persistFttPrediction(prediction) {
  const pool = await initializeDatabase();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO mt5_ftt_predictions (id, symbol, expiry, direction, confidence, entry_price, entry_time, expiry_time, exit_price, outcome, source, reasoning, indicators_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE direction=VALUES(direction), confidence=VALUES(confidence), entry_price=VALUES(entry_price), exit_price=VALUES(exit_price), outcome=VALUES(outcome), reasoning=VALUES(reasoning)`,
      [
        prediction.id,
        prediction.symbol,
        prediction.expiry,
        prediction.direction,
        prediction.confidence,
        prediction.entryPrice,
        prediction.entryTime ? toMysqlDate(prediction.entryTime) : toMysqlDate(prediction.created_at),
        prediction.expiryTime ? toMysqlDate(prediction.expiryTime) : toMysqlDate(prediction.created_at),
        prediction.exitPrice,
        prediction.outcome,
        prediction.source,
        prediction.reasoning,
        JSON.stringify(prediction.indicators || {}),
        toMysqlDate(prediction.created_at || new Date()),
      ]
    );
  } catch (err) {
    console.error('[FTT DB] Failed to persist prediction:', err.message);
  }
}

async function persistMarketLevel(level) {
  const pool = await initializeDatabase();
  if (!pool) return;

  await pool.execute(
    `INSERT INTO mt5_market_levels (
      id, symbol, level_type, price, strength, source, notes, is_active, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      symbol = VALUES(symbol),
      level_type = VALUES(level_type),
      price = VALUES(price),
      strength = VALUES(strength),
      source = VALUES(source),
      notes = VALUES(notes),
      is_active = VALUES(is_active),
      created_at = VALUES(created_at)`,
    [
      level.id || null,
      level.symbol,
      level.levelType,
      level.price,
      level.strength,
      level.source,
      level.notes,
      level.isActive,
      toMysqlDate(level.createdAt),
    ]
  );
}

async function persistSignalRule(rule) {
  const pool = await initializeDatabase();
  if (!pool) return;

  await pool.execute(
    `INSERT INTO mt5_signal_rules (
      id, name, description, indicator, condition_type, threshold_value, threshold_value_2, symbols, timeframes, is_active, weight, notify_email, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      description = VALUES(description),
      indicator = VALUES(indicator),
      condition_type = VALUES(condition_type),
      threshold_value = VALUES(threshold_value),
      threshold_value_2 = VALUES(threshold_value_2),
      symbols = VALUES(symbols),
      timeframes = VALUES(timeframes),
      is_active = VALUES(is_active),
      weight = VALUES(weight),
      notify_email = VALUES(notify_email),
      updated_at = VALUES(updated_at)`,
    [
      rule.id || null,
      rule.name,
      rule.description,
      rule.indicator,
      rule.conditionType,
      rule.thresholdValue,
      rule.thresholdValue2,
      JSON.stringify(rule.symbols || []),
      JSON.stringify(rule.timeframes || []),
      rule.isActive,
      rule.weight,
      rule.notifyEmail,
      toMysqlDate(rule.createdAt),
      toMysqlDate(rule.updatedAt),
    ]
  );
}

async function loadSignalCacheFromDatabase() {
  const pool = await initializeDatabase();
  if (!pool) return;

  const [signalRows] = await pool.query('SELECT * FROM mt5_signals ORDER BY received_at DESC LIMIT ?', [MAX_SIGNALS]);
  const [logRows] = await pool.query('SELECT * FROM mt5_delivery_logs ORDER BY timestamp DESC LIMIT ?', [MAX_SIGNALS]);
  const [candleRows] = await pool.query('SELECT * FROM mt5_candles ORDER BY candle_time DESC LIMIT ?', [MAX_CANDLES]);
  const [tradeRows] = await pool.query('SELECT * FROM mt5_trades ORDER BY received_at DESC LIMIT ?', [MAX_TRADES]);
  const [snapshotRows] = await pool.query('SELECT * FROM mt5_account_snapshots ORDER BY received_at DESC LIMIT 1');
  const [indicatorRows] = await pool.query('SELECT * FROM mt5_indicators ORDER BY candle_time DESC LIMIT ?', [MAX_INDICATORS]);
  const [decisionRows] = await pool.query('SELECT * FROM mt5_ai_decisions ORDER BY created_at DESC LIMIT 500');
  const [levelRows] = await pool.query('SELECT * FROM mt5_market_levels ORDER BY created_at DESC LIMIT 200');
  const [ruleRows] = await pool.query('SELECT * FROM mt5_signal_rules ORDER BY updated_at DESC LIMIT 200');
  const [fttRows] = await pool.query('SELECT * FROM mt5_ftt_predictions ORDER BY created_at DESC LIMIT 500');

  signals.splice(0, signals.length, ...signalRows.map((row) => ({
    id: row.id,
    receivedAt: row.received_at ? new Date(row.received_at).toISOString() : new Date().toISOString(),
    timestamp: row.signal_timestamp,
    symbol: row.symbol,
    timeframe: row.timeframe,
    type: row.type,
    direction: row.direction,
    price: row.price === null ? null : Number(row.price),
    bid: row.bid === null ? null : Number(row.bid),
    ask: row.ask === null ? null : Number(row.ask),
    volume: row.volume === null ? null : Number(row.volume),
    account: row.account,
    broker: row.broker,
    terminal: row.terminal,
    rule: row.rule_name,
    message: row.message,
    status: row.status,
    delivery: parseJsonField(row.delivery_json, null),
    sourceIp: row.source_ip,
    raw: parseJsonField(row.raw_json, {}),
  })));

  deliveryLogs.splice(0, deliveryLogs.length, ...logRows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : new Date().toISOString(),
    channel: row.channel,
    recipient: row.recipient,
    status: row.status,
    signalId: row.signal_id,
    messageId: row.message_id,
    message: row.message,
    error: row.error,
    raw: parseJsonField(row.raw_json, {}),
  })));

  candles.splice(0, candles.length, ...candleRows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    time: row.candle_time ? new Date(row.candle_time).toISOString() : new Date().toISOString(),
    open: row.open_price === null ? null : Number(row.open_price),
    high: row.high === null ? null : Number(row.high),
    low: row.low === null ? null : Number(row.low),
    close: row.close_price === null ? null : Number(row.close_price),
    volume: row.volume === null ? null : Number(row.volume),
    spread: row.spread === null ? null : Number(row.spread),
    receivedAt: row.received_at ? new Date(row.received_at).toISOString() : new Date().toISOString(),
    sourceIp: row.source_ip,
    raw: parseJsonField(row.raw_json, {}),
  })));

  // Populate the per-series analysis store from the boot-loaded candles.
  indexCandleSeriesBatch(candles);

  // Per-series HTF hydration (data-load only — does NOT change any signal/scoring logic).
  // The global "newest N" load above is dominated by fast timeframes, so higher timeframes
  // (M15..D1) come back thin/old after a restart, leaving HTF bias/ADR stale for the first
  // minutes. Top up each (symbol, timeframe) series with its most-recent bars so HTF reads
  // are fresh-to-last-closed immediately on boot. Bounded per-TF caps keep memory in check;
  // window function (MariaDB/MySQL 8+) with silent fallback if unsupported.
  try {
    const [htfRows] = await pool.query(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol, timeframe ORDER BY candle_time DESC) AS rn
         FROM mt5_candles
         WHERE timeframe IN ('M15','M30','H1','H4','D1','W1')
       ) t
       WHERE t.rn <= CASE t.timeframe WHEN 'D1' THEN 60 WHEN 'W1' THEN 30 ELSE 200 END`,
    );
    if (htfRows.length) {
      indexCandleSeriesBatch(htfRows.map((row) => ({
        id: row.id,
        symbol: row.symbol,
        timeframe: row.timeframe,
        time: row.candle_time ? new Date(row.candle_time).toISOString() : new Date().toISOString(),
        open: row.open_price === null ? null : Number(row.open_price),
        high: row.high === null ? null : Number(row.high),
        low: row.low === null ? null : Number(row.low),
        close: row.close_price === null ? null : Number(row.close_price),
        volume: row.volume === null ? null : Number(row.volume),
        spread: row.spread === null ? null : Number(row.spread),
        receivedAt: row.received_at ? new Date(row.received_at).toISOString() : new Date().toISOString(),
        sourceIp: row.source_ip,
        raw: parseJsonField(row.raw_json, {}),
      })));
      console.log(`[MySQL] Per-series HTF candle hydration: ${htfRows.length} rows (M15..D1) for fresh bias/ADR after restart.`);
    }
  } catch (e) {
    console.warn('[MySQL] Per-series HTF hydration skipped (continuing with global load):', e.message);
  }

  trades.splice(0, trades.length, ...tradeRows.map((row) => ({
    id: row.id,
    ticket: row.ticket,
    symbol: row.symbol,
    type: row.type,
    volume: row.volume === null ? null : Number(row.volume),
    openPrice: row.open_price === null ? null : Number(row.open_price),
    currentPrice: row.current_price === null ? null : Number(row.current_price),
    stopLoss: row.stop_loss === null ? null : Number(row.stop_loss),
    takeProfit: row.take_profit === null ? null : Number(row.take_profit),
    profit: row.profit === null ? null : Number(row.profit),
    swap: row.swap === null ? null : Number(row.swap),
    commission: row.commission === null ? null : Number(row.commission),
    magic: row.magic,
    comment: row.comment,
    status: row.status,
    openTime: row.open_time ? new Date(row.open_time).toISOString() : new Date().toISOString(),
    closeTime: row.close_time ? new Date(row.close_time).toISOString() : null,
    account: row.account,
    broker: row.broker,
    terminal: row.terminal,
    sourceIp: row.source_ip,
    raw: parseJsonField(row.raw_json, {}),
  })));

  accountSnapshots.splice(0, accountSnapshots.length, ...snapshotRows.map((row) => ({
    id: row.id,
    receivedAt: row.received_at ? new Date(row.received_at).toISOString() : new Date().toISOString(),
    account: row.account,
    broker: row.broker,
    terminal: row.terminal,
    version: row.version,
    balance: row.balance === null ? null : Number(row.balance),
    equity: row.equity === null ? null : Number(row.equity),
    margin: row.margin === null ? null : Number(row.margin),
    freeMargin: row.free_margin === null ? null : Number(row.free_margin),
    profit: row.profit === null ? null : Number(row.profit),
    currency: row.currency,
    leverage: row.leverage === null ? null : Number(row.leverage),
    marginLevel: row.margin_level === null ? null : Number(row.margin_level),
    openOrders: row.open_orders === null ? null : Number(row.open_orders),
    openTrades: row.open_trades === null ? null : Number(row.open_trades),
    symbols: parseJsonField(row.symbols_json, null),
    timeframes: parseJsonField(row.timeframes_json, null),
    raw: parseJsonField(row.raw_json, {}),
  })));

  if (accountSnapshots[0]) {
    mt5State.accountSnapshot = accountSnapshots[0];
  }

  indicators.splice(0, indicators.length, ...indicatorRows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    candleTime: row.candle_time,
    indicator: row.indicator_name,
    value1: row.value_1 === null ? null : Number(row.value_1),
    value2: row.value_2 === null ? null : Number(row.value_2),
    value3: row.value_3 === null ? null : Number(row.value_3),
    value4: row.value_4 === null ? null : Number(row.value_4),
    value5: row.value_5 === null ? null : Number(row.value_5),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    raw: parseJsonField(row.raw_json, {}),
  })));

  aiDecisions.splice(0, aiDecisions.length, ...decisionRows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    decision: row.decision,
    confidence: row.confidence === null ? null : Number(row.confidence),
    entry_price: row.entry_price === null ? null : Number(row.entry_price),
    stop_loss: row.stop_loss === null ? null : Number(row.stop_loss),
    take_profit_1: row.take_profit_1 === null ? null : Number(row.take_profit_1),
    take_profit_2: row.take_profit_2 === null ? null : Number(row.take_profit_2),
    take_profit_3: row.take_profit_3 === null ? null : Number(row.take_profit_3),
    risk_reward_ratio: row.risk_reward_ratio === null ? null : Number(row.risk_reward_ratio),
    reasoning: row.reasoning,
    signals_snapshot: parseJsonField(row.signals_snapshot, null),
    indicators_snapshot: parseJsonField(row.indicators_snapshot, null),
    market_context: parseJsonField(row.market_context, null),
    outcome: row.outcome,
    outcome_pips: row.outcome_pips === null ? null : Number(row.outcome_pips),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    expired_at: row.expired_at ? new Date(row.expired_at).toISOString() : null,
    trade_trigger: row.trade_trigger || null,
    predicted_time: row.predicted_time || null,
    system_decision: parseJsonField(row.system_decision, null),
    raw: parseJsonField(row.raw_json, {}),
  })));

  marketLevels.splice(0, marketLevels.length, ...levelRows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    levelType: row.level_type,
    price: row.price === null ? null : Number(row.price),
    strength: row.strength === null ? null : Number(row.strength),
    source: row.source,
    notes: row.notes,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  })));

  signalRules.splice(0, signalRules.length, ...ruleRows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    indicator: row.indicator,
    conditionType: row.condition_type,
    thresholdValue: row.threshold_value === null ? null : Number(row.threshold_value),
    thresholdValue2: row.threshold_value_2 === null ? null : Number(row.threshold_value_2),
    symbols: parseJsonField(row.symbols, []),
    timeframes: parseJsonField(row.timeframes, []),
    isActive: Boolean(row.is_active),
    weight: row.weight === null ? null : Number(row.weight),
    notifyEmail: Boolean(row.notify_email),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
  })));

  fttPredictions.splice(0, fttPredictions.length, ...fttRows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    expiry: row.expiry,
    direction: row.direction,
    confidence: row.confidence === null ? null : Number(row.confidence),
    entryPrice: row.entry_price === null ? null : Number(row.entry_price),
    entryTime: row.entry_time ? new Date(row.entry_time).toISOString() : new Date().toISOString(),
    expiryTime: row.expiry_time ? new Date(row.expiry_time).toISOString() : new Date().toISOString(),
    exitPrice: row.exit_price === null ? null : Number(row.exit_price),
    outcome: row.outcome,
    source: row.source,
    reasoning: row.reasoning,
    indicators: parseJsonField(row.indicators_json, {}),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  })));
}

const MAX_SIGNALS = Number(process?.env?.MT5_SIGNAL_HISTORY_LIMIT || 500);
const MAX_CANDLES = Number(process?.env?.MT5_CANDLE_HISTORY_LIMIT || 100000);
const MAX_INDICATORS = Number(process?.env?.MT5_INDICATOR_HISTORY_LIMIT || 100000);
const MAX_TRADES = Number(process?.env?.MT5_TRADE_HISTORY_LIMIT || 1000);
const CONNECTION_TIMEOUT_MS = Number(process?.env?.MT5_CONNECTION_TIMEOUT_MS || 120_000);
const signals = [];
const candles = [];
// Per-(symbol|timeframe) candle store with an INDEPENDENT cap per series. This guarantees
// every symbol/timeframe keeps its own recent history for analysis, so a flood of candles
// for one series (e.g. a deep gold sync) can never evict another series (e.g. gold M15).
const candleSeries = new Map();
const MAX_PER_SERIES = Number(process?.env?.MT5_CANDLES_PER_SERIES || 600);
const trades = [];
const accountSnapshots = [];
const indicators = [];
const aiDecisions = [];
const marketLevels = [];
const signalRules = [];
const deliveryLogs = [];
const streamClients = new Set();
const lastAiAnalysisByKey = new Map();
const fttPredictions = [];
const lastFttAiCallBySymbol = new Map();
const mt5State = {
  lastHeartbeatAt: null,
  lastSignalAt: null,
  account: null,
  broker: null,
  terminal: null,
  version: null,
  accountSnapshot: null,
  activeSymbol: 'XAUUSD',
  activeTimeframe: 'M5',
};

function latestByDate(items, getValue) {
  return items.reduce((latest, item) => {
    const itemTime = Date.parse(getValue(item) || '');
    const latestTime = latest ? Date.parse(getValue(latest) || '') : Number.NEGATIVE_INFINITY;
    return Number.isFinite(itemTime) && itemTime > latestTime ? item : latest;
  }, null);
}

function isWeekend() {
  // Forex trades ~24/5: it CLOSES Friday 17:00 and REOPENS Sunday 17:00 America/New_York.
  // Deriving the boundary from the New York session clock makes it DST-correct year-round:
  //   Fri 17:00 NY = 21:00 UTC = ~03:00 BD in summer (EDT) / 22:00 UTC = ~04:00 BD in winter (EST).
  // A fixed Dhaka hour (the old "4 AM") drifts an hour with US daylight saving, so we read the
  // NY clock directly instead.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const weekday = map.weekday;          // "Sun" … "Sat"
  const hour = Number(map.hour) % 24;   // 0..23 (Intl can emit "24" at midnight)

  if (weekday === 'Sat') return true;          // all Saturday = closed
  if (weekday === 'Fri') return hour >= 17;    // Friday from 17:00 NY = closed
  if (weekday === 'Sun') return hour < 17;     // Sunday before 17:00 NY = still closed
  return false;                                // Mon–Thu = open
}

// Forex market open/closed state, derived from the NY session boundary in isWeekend().
// Single source of truth for "is the market trading right now". The UI uses this to show
// "Market Closed" (an expected, non-error state) as distinct from "Disconnected" (an actual
// telemetry problem). Kept separate from candle freshness on purpose: freshness reflects data
// FLOW (is MT5 streaming), marketStatus reflects the trading CALENDAR (is it a session) — and
// both must hold for a live signal, because some brokers stream fresh synthetic weekend bars.
function getForexMarketStatus() {
  const closed = isWeekend();
  return {
    open: !closed,
    state: closed ? 'CLOSED' : 'OPEN',
    reason: closed
      ? 'Forex market is closed for the weekend (Fri 17:00 – Sun 17:00 New York ≈ Sat 03:00 – Mon 03:00 BD, DST-aware). Live signals resume when the market reopens.'
      : 'Forex market is open.',
  };
}

// HARD weekend guard for EMISSION: when the market is calendar-closed, no LIVE signal may be
// emitted (email / popup / topbar / SSE) or surfaced as actionable — even if the broker streams
// fresh weekend bars (so candleFreshness() alone would pass). Background scanning + DB logging
// still run, so strategy ranking / system signal log stay intact. This is the chokepoint every
// emit path checks in addition to its existing freshness gate.
function liveSignalsAllowed() {
  return getForexMarketStatus().open === true;
}

// SINGLE SOURCE OF TRUTH for "did this candle come from a live MT5 feed?".
// Returns the four observability fields every signal-bearing response should expose so the
// gating logic can never drift between paths and a consumer can always see, per row, whether
// the data is live or stored:
//   dataFresh        — boolean gate (true = safe to act / alert)
//   sourceReceivedAt — when MT5 last pushed this candle (or null)
//   staleSeconds     — age of that receive vs now (null if unknown)
//   marketStatus     — open/closed weekend state (expected-closed vs actual-disconnect)
//
// NOTE: there is intentionally NO weekend bypass. When the forex market is closed MT5 stops
// streaming, so the latest stored candle is Friday's frozen bar. Treating that as "current"
// would let scanners generate live BUY/SELL signals from stale data even though the market is
// shut. Freshness must reflect real data flow; market-closed state is surfaced separately.
function candleFreshness(candle, timeframe) {
  const marketStatus = getForexMarketStatus();
  if (!candle) return { dataFresh: false, sourceReceivedAt: null, staleSeconds: null, marketStatus };

  // Use the backend receive time (when the candle last arrived from MT5) rather than the
  // candle open time, which would wrongly age out candles whose open is hours ago but whose
  // close data is still being streamed (e.g. D1, H4). Fall back to candle.time only when no
  // receive timestamp is available.
  const sourceReceivedAt = candle.receivedAt || candle.raw?.receivedAt || null;
  const referenceMs = sourceReceivedAt
    ? new Date(sourceReceivedAt).getTime()
    : new Date(candle.time).getTime();

  if (Number.isNaN(referenceMs)) return { dataFresh: false, sourceReceivedAt, staleSeconds: null, marketStatus };

  const diffSec = (Date.now() - referenceMs) / 1000;
  // Stale if the backend hasn't received an update within the heartbeat timeout (default 120s),
  // hard-capped at 5 minutes.
  const MAX_STALE_SEC = Math.min(CONNECTION_TIMEOUT_MS / 1000, 300);

  return {
    dataFresh: diffSec >= 0 && diffSec <= MAX_STALE_SEC,
    sourceReceivedAt,
    staleSeconds: Math.round(diffSec),
    marketStatus,
  };
}

// Thin boolean wrapper — all the existing scanner gates keep calling this unchanged.
function isCandleCurrent(candle, timeframe) {
  return candleFreshness(candle, timeframe).dataFresh;
}

function compareTimeDescending(timeA, timeB) {
  const cleanA = typeof timeA === 'string' ? timeA.replace(/\./g, '/') : timeA;
  const cleanB = typeof timeB === 'string' ? timeB.replace(/\./g, '/') : timeB;
  const parsedA = Date.parse(cleanA || '');
  const parsedB = Date.parse(cleanB || '');
  if (!Number.isNaN(parsedA) && !Number.isNaN(parsedB)) {
    return parsedB - parsedA;
  }
  const strA = String(timeA || '');
  const strB = String(timeB || '');
  if (strA < strB) return 1;
  if (strA > strB) return -1;
  return 0;
}

function isMt5Connected() {
  const lastSeenAt = mt5State.lastHeartbeatAt || mt5State.lastSignalAt;
  return Boolean(lastSeenAt && Date.now() - Date.parse(lastSeenAt) <= CONNECTION_TIMEOUT_MS);
}

function parseMaybeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDirection(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('buy') || text.includes('bull') || text.includes('up') || text.includes('long')) return 'up';
  if (text.includes('sell') || text.includes('bear') || text.includes('down') || text.includes('short')) return 'down';
  return 'neutral';
}

function parseMt5Body(body) {
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      const params = new URLSearchParams(trimmed);
      if ([...params.keys()].length) return Object.fromEntries(params.entries());
      return { message: trimmed };
    }
  }
  return body && typeof body === 'object' ? body : {};
}

function trimToLimit(list, limit) {
  if (list.length > limit) list.length = limit;
}

function upsertRecord(list, item, keyFn, limit) {
  const key = keyFn(item);
  const index = list.findIndex((entry) => keyFn(entry) === key);
  if (index >= 0) list.splice(index, 1);
  list.unshift(item);
  trimToLimit(list, limit);
}

// Robust timeframe → milliseconds for ANY MT5 label (M1..M30, H1..H12, D1, W1).
// Returns null for anything unparseable (e.g. MN1 monthly) so callers can skip
// snapping/collapsing rather than apply a wrong interval.
function timeframeMs(tf) {
  const m = String(tf || '').toUpperCase().trim().match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  const unit = m[1];
  const n = Number(m[2]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === 'M') return n * 60 * 1000;
  if (unit === 'H') return n * 60 * 60 * 1000;
  if (unit === 'D') return n * 24 * 60 * 60 * 1000;
  if (unit === 'W') return n * 7 * 24 * 60 * 60 * 1000;
  return null; // MN (monthly) and unknown units: do not snap
}

function normalizeCandle(body, defaults = {}) {
  const data = parseMt5Body(body);
  const symbol = String(data.symbol || defaults.symbol || 'UNKNOWN').toUpperCase();
  const timeframe = String(data.timeframe || data.period || data.tf || defaults.timeframe || 'UNKNOWN').toUpperCase();
  const rawTime = data.time || data.timestamp || data.datetime || data.candleTime || new Date().toISOString();
  // Fix A (durable): the feed pushes an intra-bar snapshot on every update. Snap
  // the timestamp to the bar-open boundary and key the id on that boundary so
  // repeated snapshots of the same bar UPSERT into one row (both in-memory via
  // indexCandleSeries' id match, and in MySQL via ON DUPLICATE KEY(id)) — instead
  // of accumulating ~5x rows per bar and corrupting every sequential indicator.
  const tfMs = timeframeMs(timeframe);
  const rawMs = Date.parse(rawTime);
  let time = rawTime;
  let id = data.id || `${symbol}|${timeframe}|${rawTime}`;
  if (tfMs && Number.isFinite(rawMs)) {
    const barMs = Math.floor(rawMs / tfMs) * tfMs;
    time = new Date(barMs).toISOString();
    id = `${symbol}|${timeframe}|${barMs}`;
  }
  return {
    id,
    symbol,
    timeframe,
    time,
    open: parseMaybeNumber(data.open),
    high: parseMaybeNumber(data.high),
    low: parseMaybeNumber(data.low),
    close: parseMaybeNumber(data.close),
    volume: parseMaybeNumber(data.volume || data.tickVolume),
    spread: parseMaybeNumber(data.spread),
    receivedAt: new Date().toISOString(),
    sourceIp: defaults.sourceIp || null,
    raw: data,
  };
}

function normalizeTrade(body, defaults = {}) {
  const data = parseMt5Body(body);
  const symbol = String(data.symbol || defaults.symbol || 'UNKNOWN').toUpperCase();
  const ticket = String(data.ticket || data.id || data.order || `${symbol}-${data.time || Date.now()}`);
  return {
    id: ticket,
    ticket,
    symbol,
    type: String(data.type || data.side || data.direction || 'unknown'),
    volume: parseMaybeNumber(data.volume || data.lots),
    openPrice: parseMaybeNumber(data.openPrice || data.entryPrice || data.priceOpen || data.price),
    currentPrice: parseMaybeNumber(data.currentPrice || data.marketPrice || data.priceCurrent),
    stopLoss: parseMaybeNumber(data.sl || data.stopLoss),
    takeProfit: parseMaybeNumber(data.tp || data.takeProfit),
    profit: parseMaybeNumber(data.profit),
    swap: parseMaybeNumber(data.swap),
    commission: parseMaybeNumber(data.commission),
    magic: data.magic ? String(data.magic) : null,
    comment: data.comment || null,
    status: String(data.status || 'open').toLowerCase(),
    openTime: data.openTime || data.time || data.openedAt || new Date().toISOString(),
    closeTime: data.closeTime || data.closedAt || null,
    account: data.account || data.accountNumber || defaults.account || mt5State.account,
    broker: data.broker || defaults.broker || mt5State.broker,
    terminal: data.terminal || defaults.terminal || mt5State.terminal,
    sourceIp: defaults.sourceIp || null,
    raw: data,
  };
}

function normalizeAccountSnapshot(body, defaults = {}) {
  const data = parseMt5Body(body);
  const symbols = Array.isArray(data.symbols) ? data.symbols.map((symbol) => String(symbol).toUpperCase()) : null;
  const timeframes = Array.isArray(data.timeframes) ? data.timeframes.map((timeframe) => String(timeframe).toUpperCase()) : null;
  return {
    id: data.id || `${data.account || defaults.account || mt5State.account || 'account'}-${Date.now()}`,
    receivedAt: new Date().toISOString(),
    account: data.account || data.accountNumber || defaults.account || mt5State.account,
    broker: data.broker || defaults.broker || mt5State.broker,
    terminal: data.terminal || defaults.terminal || mt5State.terminal,
    version: data.version || data.eaVersion || mt5State.version,
    balance: parseMaybeNumber(data.balance),
    equity: parseMaybeNumber(data.equity),
    margin: parseMaybeNumber(data.margin),
    freeMargin: parseMaybeNumber(data.freeMargin || data.free_margin),
    profit: parseMaybeNumber(data.profit),
    currency: data.currency || null,
    leverage: parseMaybeNumber(data.leverage),
    marginLevel: parseMaybeNumber(data.marginLevel || data.margin_level),
    openOrders: parseMaybeNumber(data.openOrders),
    openTrades: parseMaybeNumber(data.openTrades),
    symbols,
    timeframes,
    raw: data,
  };
}

function normalizeIndicator(body, defaults = {}) {
  const data = parseMt5Body(body);
  const symbol = String(data.symbol || defaults.symbol || 'UNKNOWN').toUpperCase();
  const timeframe = String(data.timeframe || defaults.timeframe || 'UNKNOWN').toUpperCase();
  const candleTime = data.candleTime || data.time || data.timestamp || new Date().toISOString();
  const indicatorName = String(data.indicator || data.name || data.type || 'UNKNOWN').toUpperCase();
  return {
    id: data.id || `${symbol}|${timeframe}|${candleTime}|${indicatorName}`,
    symbol,
    timeframe,
    candleTime,
    indicator: indicatorName,
    value1: parseMaybeNumber(data.value1 ?? data.value_1 ?? data.main ?? data.value),
    value2: parseMaybeNumber(data.value2 ?? data.value_2 ?? data.signal ?? data.upper),
    value3: parseMaybeNumber(data.value3 ?? data.value_3 ?? data.histogram ?? data.lower),
    value4: parseMaybeNumber(data.value4 ?? data.value_4 ?? data.plusDi ?? data.k),
    value5: parseMaybeNumber(data.value5 ?? data.value_5 ?? data.minusDi ?? data.d),
    createdAt: new Date().toISOString(),
    sourceIp: defaults.sourceIp || null,
    raw: data,
  };
}

function normalizeDecisionRecord(decision) {
  return {
    id: decision.id || `${decision.symbol || 'UNKNOWN'}|${decision.timeframe || 'UNKNOWN'}|${Date.now()}`,
    symbol: decision.symbol,
    timeframe: decision.timeframe,
    decision: decision.decision,
    confidence: decision.confidence,
    entry_price: decision.entry_price ?? decision.entryPrice ?? null,
    stop_loss: decision.stop_loss ?? decision.stopLoss ?? null,
    take_profit_1: decision.take_profit_1 ?? decision.takeProfit_1 ?? null,
    take_profit_2: decision.take_profit_2 ?? decision.takeProfit_2 ?? null,
    take_profit_3: decision.take_profit_3 ?? decision.takeProfit_3 ?? null,
    risk_reward_ratio: decision.risk_reward_ratio ?? decision.riskRewardRatio ?? null,
    reasoning: decision.reasoning || null,
    signals_snapshot: decision.signals_snapshot || decision.signalsSnapshot || null,
    indicators_snapshot: decision.indicators_snapshot || decision.indicatorsSnapshot || null,
    market_context: decision.market_context || decision.marketContext || null,
    outcome: decision.outcome || 'PENDING',
    outcome_pips: decision.outcome_pips ?? null,
    created_at: decision.created_at || new Date().toISOString(),
    expired_at: decision.expired_at || null,
    trade_trigger: decision.trade_trigger || decision.tradeTrigger || null,
    predicted_time: decision.predicted_time || decision.predictedTime || null,
    system_decision: decision.system_decision || decision.systemDecision || null,
    raw: decision.raw || decision,
  };
}

function normalizeMarketLevel(body) {
  const data = parseMt5Body(body);
  return {
    id: data.id || undefined,
    symbol: String(data.symbol || 'UNKNOWN').toUpperCase(),
    levelType: String(data.levelType || data.level_type || 'SUPPORT').toUpperCase(),
    price: parseMaybeNumber(data.price),
    strength: parseMaybeNumber(data.strength) || 1,
    source: data.source || 'manual',
    notes: data.notes || null,
    isActive: data.isActive === undefined ? true : Boolean(data.isActive),
    createdAt: data.createdAt || new Date().toISOString(),
    raw: data,
  };
}

function normalizeSignalRule(body) {
  const data = parseMt5Body(body);
  return {
    id: data.id ? Number(data.id) : null,
    name: data.name || 'Rule',
    description: data.description || null,
    indicator: String(data.indicator || 'RSI').toUpperCase(),
    conditionType: String(data.conditionType || data.condition_type || 'GREATER_THAN').toUpperCase(),
    thresholdValue: parseMaybeNumber(data.thresholdValue ?? data.threshold_value),
    thresholdValue2: parseMaybeNumber(data.thresholdValue2 ?? data.threshold_value_2),
    symbols: Array.isArray(data.symbols) ? data.symbols : parseMt5Body(data.symbols || '[]'),
    timeframes: Array.isArray(data.timeframes) ? data.timeframes : parseMt5Body(data.timeframes || '[]'),
    isActive: data.isActive === undefined ? true : Boolean(data.isActive),
    weight: parseMaybeNumber(data.weight) || 1,
    notifyEmail: data.notifyEmail === undefined ? true : Boolean(data.notifyEmail),
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    raw: data,
  };
}

function normalizeSignal(body, req) {
  const data = parseMt5Body(body);
  const timestamp = data.timestamp || data.time || data.datetime || new Date().toISOString();
  const type = data.type || data.signal || data.signalType || data.alert || data.action || 'MT5 Signal';
  const price = parseMaybeNumber(data.price || data.close || data.bid || data.ask);
  const direction = normalizeDirection(data.direction || data.action || type);
  const signal = {
    id: data.id || `MT5-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    receivedAt: new Date().toISOString(),
    timestamp,
    symbol: data.symbol || data.pair || data.instrument || 'UNKNOWN',
    timeframe: data.timeframe || data.period || data.tf || 'UNKNOWN',
    type,
    direction,
    price,
    bid: parseMaybeNumber(data.bid),
    ask: parseMaybeNumber(data.ask),
    volume: parseMaybeNumber(data.volume || data.lots),
    account: data.account || data.accountNumber || mt5State.account,
    broker: data.broker || mt5State.broker,
    terminal: data.terminal || mt5State.terminal,
    rule: data.rule || data.ruleName || null,
    message: data.message || data.comment || `${data.symbol || 'MT5'} ${type}`,
    status: 'Pending',
    delivery: null,
    sourceIp: req.ip,
    raw: data,
  };
  return signal;
}

function addSignal(signal) {
  signals.unshift(signal);
  if (signals.length > MAX_SIGNALS) signals.length = MAX_SIGNALS;
  mt5State.lastSignalAt = signal.receivedAt;
  mt5State.account = signal.account || mt5State.account;
  mt5State.broker = signal.broker || mt5State.broker;
  mt5State.terminal = signal.terminal || mt5State.terminal;
  void persistSignal(signal).catch((error) => {
    console.error('[MySQL] Failed to persist signal:', error.message);
  });
}

function addDeliveryLog(log) {
  const entry = { id: `LOG-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, timestamp: new Date().toISOString(), ...log };
  deliveryLogs.unshift(entry);
  if (deliveryLogs.length > MAX_SIGNALS) deliveryLogs.length = MAX_SIGNALS;
  void persistDeliveryLog(entry).catch((error) => {
    console.error('[MySQL] Failed to persist delivery log:', error.message);
  });
}

function seriesKey(symbol, timeframe) {
  return `${symbol}|${timeframe}`;
}

// Insert/refresh a single candle into its per-series store (capped, time-sorted).
function indexCandleSeries(candle) {
  if (!candle || !candle.symbol || !candle.timeframe) return;
  const key = seriesKey(candle.symbol, candle.timeframe);
  let arr = candleSeries.get(key);
  if (!arr) { arr = []; candleSeries.set(key, arr); }
  const idx = arr.findIndex((c) => c.id === candle.id);
  if (idx >= 0) arr[idx] = candle;
  else arr.push(candle);
  arr.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (arr.length > MAX_PER_SERIES) arr.splice(0, arr.length - MAX_PER_SERIES);
}

// Efficient batch variant: group by series, merge once, sort once per series.
function indexCandleSeriesBatch(list) {
  const groups = new Map();
  for (const c of list) {
    if (!c || !c.symbol || !c.timeframe) continue;
    const key = seriesKey(c.symbol, c.timeframe);
    let g = groups.get(key);
    if (!g) { g = new Map(); groups.set(key, g); }
    g.set(c.id, c); // de-dupe within the batch, last write wins
  }
  for (const [key, incMap] of groups) {
    let arr = candleSeries.get(key) || [];
    arr = arr.filter((c) => !incMap.has(c.id));
    for (const c of incMap.values()) arr.push(c);
    arr.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    if (arr.length > MAX_PER_SERIES) arr.splice(0, arr.length - MAX_PER_SERIES);
    candleSeries.set(key, arr);
  }
}

// Real-time Strategy Lab notification trigger. When a NEW closed candle appears for a
// curated symbol/timeframe, debounce a notify-only pass so a fresh setup is sent within
// seconds (DB logging stays on the periodic scanner). De-dup is the lifecycle's job.
const strategyNotifyPendingPairs = new Set();
const strategyNotifyLastBar = new Map(); // seriesKey -> last seen bar time ms
let strategyNotifyDebounce = null;
let strategyNotifyCuratedCache = { at: 0, set: new Set() };
function strategyNotifyCuratedSet() {
  const now = Date.now();
  if (now - strategyNotifyCuratedCache.at > 60000) {
    try { strategyNotifyCuratedCache = { at: now, set: new Set(getCuratedSymbols(getMt5Status().symbols)) }; }
    catch { /* keep last cache */ }
  }
  return strategyNotifyCuratedCache.set;
}
function noteCandleForNotify(candle) {
  if (!candle || !candle.symbol || !candle.timeframe) return;
  const tf = String(candle.timeframe).toUpperCase();
  if (!STRATEGY_LAB_TIMEFRAMES.includes(tf)) return;
  if (!strategyNotifyCuratedSet().has(candle.symbol)) return;
  const t = Date.parse(candle.time);
  if (!Number.isFinite(t)) return;
  const k = seriesKey(candle.symbol, tf);
  const prev = strategyNotifyLastBar.get(k);
  if (prev !== undefined && t > prev) {
    // A bar newer than we'd seen → the prior candle just closed → check this series now.
    strategyNotifyPendingPairs.add(`${candle.symbol}|${tf}`);
    if (!strategyNotifyDebounce) {
      // 1s debounce: long enough to batch the burst of candles the EA posts together on a bar
      // close, short enough to keep the bar-close → alert path tight (was 2.5s).
      strategyNotifyDebounce = setTimeout(() => {
        strategyNotifyDebounce = null;
        const pairs = [...strategyNotifyPendingPairs];
        strategyNotifyPendingPairs.clear();
        if (pairs.length) void runStrategyNotifyPass(pairs);
      }, 1000);
      if (typeof strategyNotifyDebounce.unref === 'function') strategyNotifyDebounce.unref();
    }
  }
  if (prev === undefined || t > prev) strategyNotifyLastBar.set(k, t);
}

function addCandle(candle) {
  upsertRecord(candles, candle, (item) => item.id, MAX_CANDLES);
  indexCandleSeries(candle);
  noteCandleForNotify(candle);
  void persistCandle(candle).catch((error) => {
    console.error('[MySQL] Failed to persist candle:', error.message);
  });
}

function addCandlesBatch(candlesList) {
  if (!candlesList || candlesList.length === 0) return;

  // O(n) merge instead of per-item findIndex (which was O(batch * buffer) and blocked
  // the event loop during large history-sync chunks, causing EA WebRequest timeouts).
  // De-duplicate the incoming batch by id (last write wins), drop any existing candles
  // with the same id, then place the fresh batch at the front.
  const incoming = new Map();
  for (const candle of candlesList) {
    incoming.set(candle.id, candle);
  }

  const kept = [];
  for (let i = 0; i < candles.length; i++) {
    if (!incoming.has(candles[i].id)) kept.push(candles[i]);
  }

  const merged = [...incoming.values(), ...kept];
  if (merged.length > MAX_CANDLES) merged.length = MAX_CANDLES;

  // Mutate the shared array in place without spreading a huge arg list.
  candles.length = 0;
  for (let i = 0; i < merged.length; i++) candles.push(merged[i]);

  // Keep the per-series analysis store populated (independent per-series cap).
  indexCandleSeriesBatch(candlesList);
  for (let i = 0; i < candlesList.length; i++) noteCandleForNotify(candlesList[i]);

  void persistCandlesBatch(candlesList).catch((error) => {
    console.error('[MySQL] Failed to persist candles batch:', error.message);
  });
}

function addTrade(trade) {
  upsertRecord(trades, trade, (item) => item.id, MAX_TRADES);
  void persistTrade(trade).catch((error) => {
    console.error('[MySQL] Failed to persist trade:', error.message);
  });
}

// How often account-snapshot heartbeats are persisted to the DB (telemetry only).
// Default 5 min; floor 1 min. In-memory state still updates every heartbeat.
const SNAPSHOT_PERSIST_INTERVAL_MS = Math.max(60000, Number(process.env.SNAPSHOT_PERSIST_INTERVAL_MS || 300000));
// Days of snapshot history to retain; older rows are pruned. Default 14.
const SNAPSHOT_RETENTION_DAYS = Math.max(1, Number(process.env.SNAPSHOT_RETENTION_DAYS || 14));
let lastSnapshotPersistMs = 0;

function addAccountSnapshot(snapshot) {
  accountSnapshots.unshift(snapshot);
  trimToLimit(accountSnapshots, 50);
  mt5State.lastHeartbeatAt = snapshot.receivedAt || new Date().toISOString();
  mt5State.accountSnapshot = snapshot;
  mt5State.account = snapshot.account || mt5State.account;
  mt5State.broker = snapshot.broker || mt5State.broker;
  mt5State.terminal = snapshot.terminal || mt5State.terminal;
  mt5State.version = snapshot.version || mt5State.version;
  // Throttle DB persistence: heartbeats arrive every few seconds, but the snapshot
  // table is pure telemetry (only the latest row is read, on boot). Persist at most
  // once per SNAPSHOT_PERSIST_INTERVAL_MS so it can't bloat the DB. Live scoring is
  // unaffected — it reads mt5State.accountSnapshot, updated above every heartbeat.
  const nowMs = Date.now();
  if (nowMs - lastSnapshotPersistMs >= SNAPSHOT_PERSIST_INTERVAL_MS) {
    lastSnapshotPersistMs = nowMs;
    void persistAccountSnapshot(snapshot).catch((error) => {
      console.error('[MySQL] Failed to persist account snapshot:', error.message);
    });
  }
}

function addIndicator(indicator) {
  upsertRecord(indicators, indicator, (item) => item.id, MAX_INDICATORS);
  void persistIndicator(indicator).catch((error) => {
    console.error('[MySQL] Failed to persist indicator:', error.message);
  });
}

function addAiDecision(decision) {
  upsertRecord(aiDecisions, decision, (item) => item.id, 1000);
  void persistAiDecision(decision).catch((error) => {
    console.error('[MySQL] Failed to persist AI decision:', error.message);
  });
}

function addMarketLevel(level) {
  upsertRecord(marketLevels, level, (item) => String(item.id || `${item.symbol}-${item.levelType}-${item.price}`), 200);
  void persistMarketLevel(level).catch((error) => {
    console.error('[MySQL] Failed to persist market level:', error.message);
  });
}

function addSignalRule(rule) {
  upsertRecord(signalRules, rule, (item) => String(item.id), 200);
  void persistSignalRule(rule).catch((error) => {
    console.error('[MySQL] Failed to persist signal rule:', error.message);
  });
}

function getRecentCandles(symbol, timeframe, limit = 100) {
  // Fix B (read-time safety net): collapse intra-bar snapshots to one bar per
  // interval before returning, so signals computed from already-polluted
  // in-memory/DB data (rows ingested before Fix A) still run on clean bars.
  // Collapse the FULL series first, THEN slice — otherwise slicing -limit raw
  // rows yields far fewer real bars than callers expect.
  // Prefer the per-series store: it always retains this symbol/timeframe's recent
  // history regardless of how much unrelated candle data has flowed through.
  if (symbol && timeframe) {
    const arr = candleSeries.get(seriesKey(symbol, timeframe));
    if (arr && arr.length) return collapseCandlesToBars(arr, timeframe).slice(-limit); // ascending by time
  }
  const filtered = candles.filter((candle) => (!symbol || candle.symbol === symbol) && (!timeframe || candle.timeframe === timeframe));
  filtered.sort((a, b) => compareTimeDescending(a.time, b.time));
  // Over-fetch (collapse can reduce ~5x) then collapse then take the last `limit` bars.
  const asc = filtered.slice(0, Math.max(limit * 8, limit)).reverse();
  return collapseCandlesToBars(asc, timeframe).slice(-limit);
}

function getRecentIndicators(symbol, timeframe, limit = 500) {
  const filtered = indicators.filter((indicator) => (!symbol || indicator.symbol === symbol) && (!timeframe || indicator.timeframe === timeframe));
  filtered.sort((a, b) => compareTimeDescending(a.candleTime, b.candleTime));
  return filtered.slice(0, limit).reverse();
}

function getRecentDecisions(symbol, timeframe, limit = 10) {
  const filtered = aiDecisions.filter((decision) => (!symbol || decision.symbol === symbol) && (!timeframe || decision.timeframe === timeframe));
  filtered.sort((a, b) => compareTimeDescending(a.created_at, b.created_at));
  return filtered.slice(0, limit).reverse();
}

function getMultiTimeframeConfig(timeframe) {
  const tf = String(timeframe || 'M5').toUpperCase();
  switch (tf) {
    case 'M1':
      return { bias: 'M15', trend: 'M5', entry: 'M1' };
    case 'M5':
      return { bias: 'H1', trend: 'M15', entry: 'M5' };
    case 'M15':
      return { bias: 'H4', trend: 'H1', entry: 'M15' };
    case 'M30':
      return { bias: 'H4', trend: 'H1', entry: 'M30' };
    case 'H1':
      return { bias: 'D1', trend: 'H4', entry: 'H1' };
    case 'H4':
      return { bias: 'W1', trend: 'D1', entry: 'H4' };
    case 'D1':
      return { bias: 'W1', trend: 'D1', entry: 'D1' };
    default:
      return { bias: null, trend: null, entry: tf };
  }
}

async function runAiAnalysis(symbol, timeframe, { force = false, reason = 'snapshot' } = {}) {
  const key = `${symbol}|${timeframe}`;
  const tfConfig = getMultiTimeframeConfig(timeframe);

  const candleList = getRecentCandles(symbol, tfConfig.entry, 200);
  const latestCandle = candleList[candleList.length - 1];
  if (!latestCandle) return null;

  const lastRun = lastAiAnalysisByKey.get(key);
  const now = Date.now();

  // Check if candle is current
  if (!isCandleCurrent(latestCandle, tfConfig.entry)) {
    const formattedCandleTime = formatAppDateTime(latestCandle.time) || latestCandle.time;
    const formattedCurrentTime = formatAppDateTime(new Date()) || new Date().toISOString();
    const decision = normalizeDecisionRecord({
      id: `${symbol}|${timeframe}|${Date.now()}`,
      symbol,
      timeframe,
      decision: 'HOLD',
      confidence: 0,
      entry_price: latestCandle.close,
      stop_loss: null,
      take_profit_1: null,
      take_profit_2: null,
      take_profit_3: null,
      risk_reward_ratio: null,
      reasoning: `Market data is outdated. Latest candle time: ${formattedCandleTime}. Current server time: ${formattedCurrentTime} (Asia/Dhaka).`,
      signals_snapshot: {},
      indicators_snapshot: {},
      market_context: { price: latestCandle.close },
      outcome: 'PENDING',
      outcome_pips: null,
      created_at: new Date().toISOString(),
      expired_at: null,
      trade_trigger: null,
      predicted_time: null,
      system_decision: {
        decision: 'HOLD',
        confidence: 0,
        compositeScore: 0,
        grade: 'No Setup (Outdated Telemetry)',
      },
      raw: { reason: 'outdated_telemetry' }
    });
    addAiDecision(decision);
    lastAiAnalysisByKey.set(key, { candleTime: latestCandle.time, generatedAt: now });
    sendStreamEvent('ai_decision', decision);
    sendStreamEvent('status', getMt5Status());
    return decision;
  }

  if (!force && lastRun && lastRun.candleTime === latestCandle.time && now - lastRun.generatedAt < AI_ANALYSIS_INTERVAL_MS) {
    return null;
  }

  // Calculate D1 ADR and daily high/low for system decision
  const dailyCandles = getRecentCandles(symbol, 'D1', 20);
  let adr = null;
  let dailyHighLow = null;
  if (dailyCandles.length >= 14) {
    const dailyRanges = dailyCandles.slice(-14).map(c => {
      const h = Number(c.high);
      const l = Number(c.low);
      return (!isNaN(h) && !isNaN(l)) ? (h - l) : 0;
    }).filter(r => r > 0);
    if (dailyRanges.length >= 10) {
      adr = dailyRanges.reduce((sum, r) => sum + r, 0) / dailyRanges.length;
    }
  }
  const latestDailyCandle = dailyCandles[dailyCandles.length - 1];
  if (latestDailyCandle) {
    dailyHighLow = {
      high: Number(latestDailyCandle.high),
      low: Number(latestDailyCandle.low),
    };
  }

  const signalSummary = aggregateSignals({
    symbol,
    timeframe: tfConfig.entry,
    candles: candleList,
    indicators: getRecentIndicators(symbol, tfConfig.entry, 500),
    marketLevels,
    accountSnapshot: mt5State.accountSnapshot,
    adr,
    dailyHighLow,
    h4Candles: getRecentCandles(symbol, 'H4', 150),
    h1Candles: getRecentCandles(symbol, 'H1', 150),
  });

  let trendSummary = null;
  if (tfConfig.trend) {
    const trendCandles = getRecentCandles(symbol, tfConfig.trend, 200);
    if (trendCandles.length > 0) {
      trendSummary = aggregateSignals({
        symbol,
        timeframe: tfConfig.trend,
        candles: trendCandles,
        indicators: getRecentIndicators(symbol, tfConfig.trend, 500),
        marketLevels,
        accountSnapshot: mt5State.accountSnapshot,
      });
    }
  }

  let biasSummary = null;
  if (tfConfig.bias) {
    const biasCandles = getRecentCandles(symbol, tfConfig.bias, 200);
    if (biasCandles.length > 0) {
      biasSummary = aggregateSignals({
        symbol,
        timeframe: tfConfig.bias,
        candles: biasCandles,
        indicators: getRecentIndicators(symbol, tfConfig.bias, 500),
        marketLevels,
        accountSnapshot: mt5State.accountSnapshot,
      });
    }
  }

  const recentDecisions = getRecentDecisions(symbol, tfConfig.entry, 5);
  const analysis = await analyzeWithGemini({
    projectId: GOOGLE_CLOUD_PROJECT,
    location: GOOGLE_CLOUD_LOCATION,
    model: GEMINI_MODEL,
    signalSummary,
    trendSummary,
    biasSummary,
    accountSnapshot: mt5State.accountSnapshot,
    recentDecisions,
  });

  const decision = normalizeDecisionRecord({
    id: `${symbol}|${timeframe}|${Date.now()}`,
    symbol,
    timeframe,
    decision: analysis.decision,
    confidence: analysis.confidence,
    entry_price: analysis.entry_price,
    stop_loss: analysis.stop_loss,
    take_profit_1: analysis.take_profit_1,
    take_profit_2: analysis.take_profit_2,
    take_profit_3: analysis.take_profit_3,
    risk_reward_ratio: analysis.risk_reward_ratio,
    reasoning: analysis.reasoning,
    signals_snapshot: signalSummary.signals,
    indicators_snapshot: signalSummary.indicatorsSnapshot,
    market_context: {
      ...signalSummary.marketContext,
      trendTimeframe: tfConfig.trend,
      biasTimeframe: tfConfig.bias,
      trendCompositeScore: trendSummary?.compositeScore ?? null,
      biasCompositeScore: biasSummary?.compositeScore ?? null,
    },
    outcome: 'PENDING',
    outcome_pips: null,
    created_at: new Date().toISOString(),
    expired_at: null,
    trade_trigger: analysis.trade_trigger,
    predicted_time: analysis.predicted_time,
    system_decision: signalSummary.systemDecision,
    raw: { analysis, signalSummary, trendSummary, biasSummary, reason },
  });

  addAiDecision(decision);
  lastAiAnalysisByKey.set(key, { candleTime: latestCandle.time, generatedAt: now });
  sendStreamEvent('ai_decision', decision);
  sendStreamEvent('status', getMt5Status());
  return decision;
}

function sendStreamEvent(type, payload) {
  const event = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of streamClients) {
    client.write(event);
  }
}

async function sendNotificationEmail({ to, subject, text, html, signalId }) {
  const transporter = getEmailTransporter();
  const info = await transporter.sendMail({
    from: process?.env?.EMAIL_FROM || process?.env?.SMTP_USER,
    to,
    subject,
    text,
    html,
  });

  addDeliveryLog({
    channel: 'Email',
    recipient: to,
    signalId: signalId || null,
    status: 'Success',
    messageId: info.messageId,
  });
  return info;
}

function formatSignalEmail(signal) {
  const lines = [
    'Aura Gold MT5 signal received.',
    '',
    `Symbol: ${signal.symbol}`,
    `Timeframe: ${signal.timeframe}`,
    `Type: ${signal.type}`,
    `Direction: ${signal.direction}`,
    `Price: ${signal.price ?? 'n/a'}`,
    `Bid: ${signal.bid ?? 'n/a'}`,
    `Ask: ${signal.ask ?? 'n/a'}`,
    `Account: ${signal.account ?? 'n/a'}`,
    `Broker: ${signal.broker ?? 'n/a'}`,
    `Terminal: ${signal.terminal ?? 'n/a'}`,
    `Message: ${signal.message}`,
    `Received: ${signal.receivedAt}`,
    '',
    'Raw payload:',
    JSON.stringify(signal.raw, null, 2),
  ];
  return lines.join('\n');
}

function formatTrackedProjectionEmail(tracked) {
  const lines = [
    'Aura Gold tracked AI projection triggered.',
    '',
    `Symbol: ${tracked.symbol}`,
    `Trade Mode: ${tracked.tradeMode}`,
    `Decision: ${tracked.decision}`,
    `Trigger: ${tracked.tradeTrigger}`,
    `Entry Price: ${tracked.entryPrice ?? 'n/a'}`,
    `Current Price: ${tracked.currentPrice ?? 'n/a'}`,
    `Stop Loss: ${tracked.stopLoss ?? 'n/a'}`,
    `Take Profit 1: ${tracked.takeProfit1 ?? 'n/a'}`,
    `Take Profit 2: ${tracked.takeProfit2 ?? 'n/a'}`,
    `Take Profit 3: ${tracked.takeProfit3 ?? 'n/a'}`,
    `Confidence: ${tracked.confidence}%`,
    `Status: ${tracked.status}`,
    `Triggered At: ${tracked.triggeredAt || 'n/a'}`,
    '',
    `Evaluation: ${tracked.evaluation?.reason || 'Local indicators confirmed the projection.'}`,
  ];

  return lines.join('\n');
}

function formatTrackedProjectionEmailHtml(tracked) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 680px; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; color: #1e293b;">
      <div style="border-bottom: 2px solid #10b981; padding-bottom: 12px; margin-bottom: 15px;">
        <h2 style="margin: 0; color: #059669; font-size: 20px;">🔔 Tracked AI Projection Triggered</h2>
        <p style="margin: 4px 0 0; color: #64748b; font-size: 13px;">${tracked.symbol} · ${tracked.tradeMode} · ${tracked.decision}</p>
      </div>
      <table style="width: 100%; font-size: 13px; border-collapse: collapse; margin-bottom: 15px;">
        <tr><td style="padding: 4px 0; color: #64748b;">Trigger:</td><td><b>${tracked.tradeTrigger}</b></td></tr>
        <tr><td style="padding: 4px 0; color: #64748b;">Entry Price:</td><td><b>${tracked.entryPrice ?? 'n/a'}</b></td></tr>
        <tr><td style="padding: 4px 0; color: #64748b;">Current Price:</td><td><b>${tracked.currentPrice ?? 'n/a'}</b></td></tr>
        <tr><td style="padding: 4px 0; color: #64748b;">Stop Loss:</td><td><b>${tracked.stopLoss ?? 'n/a'}</b></td></tr>
        <tr><td style="padding: 4px 0; color: #64748b;">TP1 / TP2 / TP3:</td><td><b>${tracked.takeProfit1 ?? 'n/a'} / ${tracked.takeProfit2 ?? 'n/a'} / ${tracked.takeProfit3 ?? 'n/a'}</b></td></tr>
        <tr><td style="padding: 4px 0; color: #64748b;">Confidence:</td><td><b>${tracked.confidence}%</b></td></tr>
        <tr><td style="padding: 4px 0; color: #64748b;">Evaluation:</td><td>${tracked.evaluation?.reason || 'Local indicators confirmed the setup.'}</td></tr>
      </table>
      <div style="font-size: 11px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 10px; margin-top: 15px; text-align: center;">AI-free tracking alert from Aura Gold Alert System.</div>
    </div>`;
}

function getMt5Status() {
  const connected = isMt5Connected();
  const liveAccountSnapshot = connected && mt5State.accountSnapshot?.account === mt5State.account ? mt5State.accountSnapshot : null;
  const snapshotSymbols = Array.isArray(liveAccountSnapshot?.symbols) ? liveAccountSnapshot.symbols : [];
  const snapshotTimeframes = Array.isArray(liveAccountSnapshot?.timeframes) ? liveAccountSnapshot.timeframes : [];
  const allSymbols = new Set([
    ...snapshotSymbols,
    ...signals.map((signal) => signal.symbol),
    ...candles.map((candle) => candle.symbol),
    ...trades.map((trade) => trade.symbol),
  ].filter(Boolean));
  const allTimeframes = new Set([
    ...snapshotTimeframes,
    ...signals.map((signal) => signal.timeframe),
    ...candles.map((candle) => candle.timeframe),
  ].filter(Boolean));
  const openTrades = trades.filter((trade) => trade.status === 'open' || trade.status === 'active');
  const latestSignal = latestByDate(signals, (signal) => signal.receivedAt || signal.timestamp);
  const latestCandle = latestByDate(candles, (candle) => candle.time);
  const latestTrade = latestByDate(trades, (trade) => trade.openTime || trade.closeTime);
  const latestAiDecision = latestByDate(aiDecisions, (decision) => decision.created_at);
  const latestAiDecisionSummary = latestAiDecision ? {
    id: latestAiDecision.id,
    symbol: latestAiDecision.symbol,
    timeframe: latestAiDecision.timeframe,
    decision: latestAiDecision.decision,
    confidence: latestAiDecision.confidence,
    entry_price: latestAiDecision.entry_price,
    stop_loss: latestAiDecision.stop_loss,
    take_profit_1: latestAiDecision.take_profit_1,
    take_profit_2: latestAiDecision.take_profit_2,
    take_profit_3: latestAiDecision.take_profit_3,
    risk_reward_ratio: latestAiDecision.risk_reward_ratio,
    reasoning: latestAiDecision.reasoning,
    outcome: latestAiDecision.outcome,
    outcome_pips: latestAiDecision.outcome_pips,
    created_at: latestAiDecision.created_at,
    expired_at: latestAiDecision.expired_at,
    trade_trigger: latestAiDecision.trade_trigger,
    predicted_time: latestAiDecision.predicted_time,
  } : null;

  return {
    connected,
    marketStatus: getForexMarketStatus(),
    lastHeartbeatAt: connected ? mt5State.lastHeartbeatAt : null,
    lastSignalAt: mt5State.lastSignalAt,
    account: connected ? mt5State.account : null,
    broker: connected ? mt5State.broker : null,
    terminal: connected ? mt5State.terminal : null,
    version: connected ? mt5State.version : null,
    accountSnapshot: liveAccountSnapshot,
    signalCount: signals.length,
    candleCount: candles.length,
    tradeCount: trades.length,
    indicatorCount: indicators.length,
    aiDecisionCount: aiDecisions.length,
    openTradesCount: openTrades.length,
    symbols: liveAccountSnapshot ? [...allSymbols].sort() : [],
    timeframes: liveAccountSnapshot ? [...allTimeframes].sort() : [],
    latestSignal: liveAccountSnapshot ? latestSignal : null,
    latestCandle: liveAccountSnapshot ? latestCandle : null,
    latestTrade: liveAccountSnapshot ? latestTrade : null,
    latestAiDecision: liveAccountSnapshot ? latestAiDecisionSummary : null,
    geminiConfigured: Boolean(GEMINI_API_KEY || (GOOGLE_CLOUD_PROJECT && GOOGLE_CLOUD_LOCATION)),
    geminiModel: GEMINI_MODEL,
    dbConfigured: hasDbConfig,
    alertDiagnostics,
    processId: process.pid,
    serverTime: new Date().toISOString(),
    serverTimeBd: formatAppDateTime(),
    appTimeZone: APP_TIME_ZONE,
    ingestUrl: `http://${API_BACKEND_HOST}:${PORT}/api/mt5/signals`,
    heartbeatUrl: `http://${API_BACKEND_HOST}:${PORT}/api/mt5/heartbeat`,
    snapshotUrl: `http://${API_BACKEND_HOST}:${PORT}/api/mt5/snapshot`,
    candlesUrl: `http://${API_BACKEND_HOST}:${PORT}/api/mt5/candles`,
    tradesUrl: `http://${API_BACKEND_HOST}:${PORT}/api/mt5/trades`,
  };
}

function getCandleCoverage() {
  const byKey = new Map();
  for (const candle of candles) {
    if (!candle.symbol || !candle.timeframe) continue;
    const key = `${candle.symbol}|${candle.timeframe}`;
    const time = Date.parse(candle.time || '');
    const existing = byKey.get(key) || {
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      count: 0,
      firstTime: null,
      lastTime: null,
    };
    existing.count += 1;
    if (Number.isFinite(time)) {
      if (!existing.firstTime || time < Date.parse(existing.firstTime)) existing.firstTime = candle.time;
      if (!existing.lastTime || time > Date.parse(existing.lastTime)) existing.lastTime = candle.time;
    }
    byKey.set(key, existing);
  }

  const rows = [...byKey.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.timeframe.localeCompare(b.timeframe));
  const symbols = [...new Set(rows.map((row) => row.symbol))].sort();
  const timeframes = [...new Set(rows.map((row) => row.timeframe))].sort();
  return { rows, symbols, timeframes };
}

// Database-backed coverage: returns ALL symbols/timeframes stored in MySQL, not just
// the ones that happen to fit in the capped in-memory buffer. This is what the
// Historical Data page should use so every synced symbol is visible.
async function getCandleCoverageFromDb() {
  const pool = await initializeDatabase();
  if (!pool) return getCandleCoverage();

  const [rawRows] = await pool.query(
    `SELECT symbol, timeframe, COUNT(*) AS count, MIN(candle_time) AS firstTime, MAX(candle_time) AS lastTime
     FROM mt5_candles
     GROUP BY symbol, timeframe`
  );

  const rows = rawRows
    .map((row) => ({
      symbol: row.symbol,
      timeframe: row.timeframe,
      count: Number(row.count) || 0,
      firstTime: row.firstTime ? new Date(row.firstTime).toISOString() : null,
      lastTime: row.lastTime ? new Date(row.lastTime).toISOString() : null,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.timeframe.localeCompare(b.timeframe));

  const symbols = [...new Set(rows.map((row) => row.symbol))].sort();
  const timeframes = [...new Set(rows.map((row) => row.timeframe))].sort();
  return { rows, symbols, timeframes };
}

app.set('trust proxy', 1 /* number of proxies between user and server */);

// IMPORTANT: Vertex AI Studio Rate Limiting
// This rate limiting configuration protects your backend APIs from abuse.
// Removing it exposes your service to DoS attacks and unexpected costs.
const proxyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // Set ratelimit window at 15min (in ms)
    max: 100, // Limit each IP to 100 requests per window 
    standardHeaders: true, // Return rate limit info in the "RateLimit-*" headers
    legacyHeaders: false, // no "X-RateLimit-*" headers
    message: {
      error: 'Too many requests',
      message: 'You have exceed the request limit, please try again later.'
    },
});
// Apply the rate limiter to the /api-proxy route before the main proxy logic
app.use('/api-proxy', proxyLimiter);

const API_CLIENT_MAP = [
 {
    name: "VertexGenAi:generateContent",
    patternForProxy: "https://aiplatform.googleapis.com/{{version}}/publishers/google/models/{{model}}:generateContent",
    getApiEndpoint: (context, params) => {
      return `https://aiplatform.clients6.google.com/${params['version']}/projects/${context.projectId}/locations/${context.region}/publishers/google/models/${params['model']}:generateContent`;
    },
    isStreaming: false,
    transformFn: null,
  },
 {
    name: "VertexGenAi:predict",
    patternForProxy: "https://aiplatform.googleapis.com/{{version}}/publishers/google/models/{{model}}:predict",
    getApiEndpoint: (context, params) => {
      return `https://aiplatform.clients6.google.com/${params['version']}/projects/${context.projectId}/locations/${context.region}/publishers/google/models/${params['model']}:predict`;
    },
    isStreaming: false,
    transformFn: null,
  },
 {
    name: "VertexGenAi:streamGenerateContent",
    patternForProxy: "https://aiplatform.googleapis.com/{{version}}/publishers/google/models/{{model}}:streamGenerateContent",
    getApiEndpoint: (context, params) => {
      return `https://aiplatform.clients6.google.com/${params['version']}/projects/${context.projectId}/locations/${context.region}/publishers/google/models/${params['model']}:streamGenerateContent`;
    },
    isStreaming: true,
    transformFn: (response) => {
        let normalizedResponse = response.trim();
        while (normalizedResponse.startsWith(',') || normalizedResponse.startsWith('[')) {
          normalizedResponse = normalizedResponse.substring(1).trim();
        }
        while (normalizedResponse.endsWith(',') || normalizedResponse.endsWith(']')) {
          normalizedResponse = normalizedResponse.substring(0, normalizedResponse.length - 1).trim();
        }

        if (!normalizedResponse.length) {
          return {result: null, inProgress: false};
        }

        if (!normalizedResponse.endsWith('}')) {
          return {result: normalizedResponse, inProgress: true};
        }

        try {
          const parsedResponse = JSON.parse(`${normalizedResponse}`);
          const transformedResponse = `data: ${JSON.stringify(parsedResponse)}\n\n`;
          return {result: transformedResponse, inProgress: false};
        } catch (error) {
          throw new Error(`Failed to parse response: ${error}.`);
        }
    },
  },
].map((client) => ({ ...client, patternInfo: parsePattern(client.patternForProxy) }));

// IMPORTANT: Vertex AI Studio SSRF Protection
// The set below is the exhaustive allow-list of upstream hostnames this
// proxy may forward authenticated requests to. It is sourced at code
// generation time from the RestApiClient.getAllowedUpstreamHosts() of every
// client embedded in API_CLIENT_MAP. Removing, weakening, or widening this
// check (for example, by adding wildcards or computing entries from request
// data) re-introduces the SSRF vulnerability that allows the deployed
// service account's OAuth access token to be exfiltrated to an
// attacker-controlled host.
const ALLOWED_UPSTREAM_HOSTS = new Set([
  "aiplatform.clients6.google.com",
]);

// Uses Google Application Default Credentials (ADC).
// Users need to run "gcloud auth application-default login" in order to use the proxy.
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePattern(pattern) {
  const paramRegex = /\{\{(.*?)\}\}/g;
  const params = [];
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = paramRegex.exec(pattern)) !== null) {
    params.push(match[1]);
    const literalPart = pattern.substring(lastIndex, match.index);
    parts.push(escapeRegex(literalPart));
    parts.push(`(?<${match[1]}>[^/]+)`);
    lastIndex = paramRegex.lastIndex;
  }
  parts.push(escapeRegex(pattern.substring(lastIndex)));
  const regexString = parts.join('');

  return {regex: new RegExp(`^${regexString}$`), params};
}

function extractParams(patternInfo, url) {
  const match = url.match(patternInfo.regex);
  if (!match) return null;
  const params = {};
  patternInfo.params.forEach((paramName, index) => {
    params[paramName] = match[index + 1];
  });
  return params;
}

async function getAccessToken(res) {
  try {
    const authClient = await auth.getClient();
    const token = await authClient.getAccessToken();
    return token.token;
  } catch (error) {
    console.error('[Node Proxy] Authentication error:', error);
    if (!res) return null;
    if (error.code === 'ERR_GCLOUD_NOT_LOGGED_IN' || (error.message && error.message.includes('Could not load the default credentials'))) {
      res.status(401).json({
        error: 'Authentication Required',
        message: 'Google Cloud Application Default Credentials not found or invalid. Please run "gcloud auth application-default login" and try again.',
      });
    } else {
      res.status(500).json({ error: `Authentication failed: ${error.message}` });
    }
    return null;
  }
}

function getRequestHeaders(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'X-Goog-User-Project': GOOGLE_CLOUD_PROJECT,
    'Content-Type': 'application/json',
  };
}

// --- Proxy Endpoint ---
app.post('/api-proxy', async (req, res) => {

  // Check for the custom header added by the shim
  if (req.headers['x-app-proxy'] !== PROXY_HEADER) {
    return res.status(403).send('Forbidden: Request must originate from the Vertex App shim.');
  }

  const { originalUrl, method, headers, body } = req.body;
  if (!originalUrl) {
    return res.status(400).send('Bad Request: originalUrl is required.');
  }

  // 1. Find the matching API client
  const apiClient = API_CLIENT_MAP.find(p => {
    // We store extractedParams on req for use later if needed, though getVertexUrl takes it as arg.
    req.extractedParams = extractParams(p.patternInfo, originalUrl);
    return req.extractedParams !== null;
  });

  if (!apiClient) {
    console.error(`[Node Proxy] No API client handler found for URL: ${originalUrl}`);
    return res.status(404).json({ error: `No proxy handler found for URL: ${originalUrl}` });
  }

  const extractedParams = req.extractedParams;
  console.log(`[Node Proxy] Matched API client: ${apiClient.name}`);
  try {
    // 2. Get authenticated access token
    const accessToken = await getAccessToken(res);
    if (!accessToken) return;

    // 3. Construct the full API URL using env-set GOOGLE_CLOUD_PROJECT/LOCATION and extracted params
    const context = {projectId: GOOGLE_CLOUD_PROJECT, region: GOOGLE_CLOUD_LOCATION};
    const apiUrl = apiClient.getApiEndpoint(context, extractedParams);

    // IMPORTANT: Vertex AI Studio SSRF Protection
    // Parse the constructed apiUrl with the standard URL parser (not a
    // regex) and require the resulting hostname to be in the hardcoded
    // ALLOWED_UPSTREAM_HOSTS set. This neutralizes attacks that smuggle a
    // URL-grammar delimiter (e.g. '#') into a pattern parameter to redirect
    // the authenticated upstream request to an attacker-controlled host.
    let parsedApiUrl;
    try {
      parsedApiUrl = new URL(apiUrl);
    } catch (e) {
      console.error(`[Node Proxy] Invalid API URL: ${apiUrl}`);
      return res.status(400).json({ error: 'Invalid API URL.' });
    }
    if (!ALLOWED_UPSTREAM_HOSTS.has(parsedApiUrl.hostname.toLowerCase())) {
      console.error(`[Node Proxy] Upstream host not allowed: ${parsedApiUrl.hostname}`);
      return res.status(400).json({ error: 'Upstream host not allowed.' });
    }
    console.log(`[Node Proxy] Forwarding to Vertex API: ${apiUrl}`);

    // 4. Prepare headers for the API call
    const apiHeaders = getRequestHeaders(accessToken);

    const apiFetchOptions = {
      method: method || 'POST',
      headers: {...apiHeaders, ...headers},
      body: body ? body : undefined,
    };

    // 5. Make the call to the API
    const apiResponse = await fetch(apiUrl, apiFetchOptions);

    // 6. Respond to the client based on stream type
    if (apiClient.isStreaming) {
      console.log(`[Node Proxy] Sending STREAMING response for ${apiClient.name}`);
      // Set headers for a streaming JSON response
      res.writeHead(apiResponse.status, {
        'Content-Type': 'text/event-stream',
        'Transfer-Encoding': 'chunked',
        'Connection': 'keep-alive',
      });
      // Immediately send headers
      res.flushHeaders();

      if (!apiResponse.body) {
        console.error('[Node Proxy] Streaming response has no body.');
        return res.end(JSON.stringify({ error: 'Streaming response body is null' }));
      }

      const decoder = new TextDecoder();
      let deltaChunk = '';
      apiResponse.body.on('data', (encodedChunk) => {
        if (res.writableEnded) return; // Prevent writing after res.end()

        try {
          if (!apiClient.transformFn) {
            res.write(encodedChunk);
          } else {
            const decodedChunk = decoder.decode(encodedChunk, { stream: true });
            deltaChunk = deltaChunk + decodedChunk;

            const {result, inProgress} = apiClient.transformFn(deltaChunk);
            if (result && !inProgress) {
              deltaChunk = '';
              res.write(new TextEncoder().encode(result));
            }
          }
        } catch (error) {
          console.error(`[Node Proxy] Error processing streaming response for ${apiClient.name}`);
          console.error(error);
        }
      });

      apiResponse.body.on('end', () => {
        deltaChunk = '';
        console.log(`[Node Proxy] Vertex stream finished and all data processed for ${apiClient.name}`);
        res.end();
      });

      apiResponse.body.on('error', (streamError) => {
        console.error('[Node Proxy] Error from Vertex stream:', streamError);
        if (!res.writableEnded) {
          res.end(JSON.stringify({ proxyError: 'Stream error from Vertex AI', details: streamError.message }));
        }
      });

      res.on('error', (resError) => {
        console.error('[Node Proxy] Error writing to client response:', resError);
        // The source stream might need to be destroyed if an error occurs here.
        if (apiResponse.body && typeof apiResponse.body.destroy === 'function') {
             apiResponse.body.destroy(resError);
        }
      });
    } else {
      // Non-streaming response handling
      console.log(`[Node Proxy] Sending JSON response for ${apiClient.name}`);
      const data = await apiResponse.json();
      res.status(apiResponse.status).json(data);
    }
  } catch (error) {
    console.error(`[Node Proxy] Error proxying request for ${apiClient.name}`);
    console.error(error)
    res.status(500).json({ error: error });
  }
});

app.get('/api/mt5/status', (req, res) => {
  res.json(getMt5Status());
});

// ── Economic calendar (MT5-native + Trading Economics fallback) ───────
// EA ingest: the MQL5 EA reads CalendarValueHistory() and POSTs a batch here (preferred source).
app.post('/api/mt5/news', (req, res) => {
  const body = parseMt5Body(req.body);
  const events = Array.isArray(body.events) ? body.events : [];
  const stored = setEconomicEvents({
    events,
    serverGmtOffsetSec: body.serverGmtOffsetSec ?? body.gmtOffsetSec ?? 0,
    source: body.source || 'mt5-ea',
  });
  console.log(`[News] Ingested ${stored.events.length} calendar events (offset ${stored.serverGmtOffsetSec}s) from EA.`);
  sendStreamEvent('status', getMt5Status());
  res.status(201).json({ ok: true, count: stored.events.length, updatedAt: stored.updatedAt });
});

// Manual refresh of the Trading Economics fallback source.
app.post('/api/mt5/news/refresh', async (req, res) => {
  try {
    const result = await fetchTradingEconomicsOnce();
    res.json({ ok: result.ok === true, result, sources: getCalendarStore().sources });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Fast DELTA ingest (EA CalendarValueLast ~7s): merge changed events, detect the actual
// value the moment it prints, fire an instant alert, and arm post-news entry signals.
app.post('/api/mt5/news/delta', async (req, res) => {
  const body = parseMt5Body(req.body);
  const events = Array.isArray(body.events) ? body.events : [];
  const result = upsertEvents({
    events,
    serverGmtOffsetSec: body.serverGmtOffsetSec ?? body.gmtOffsetSec ?? 0,
    source: 'mt5-ea',
  });
  if (result.newlyReleased.length) {
    console.log(`[News:Delta] ${result.newlyReleased.length} actual value(s) just released.`);
    for (const ev of result.newlyReleased) {
      void onActualReleased(ev).catch((e) => console.warn('[News:Delta] onActualReleased error:', e.message));
    }
  }
  res.status(201).json({ ok: true, updated: result.updated, total: result.total, released: result.newlyReleased.length });
});

// Post-news entry signals (activate after the +30m blackout) for the Future Predictions page.
app.get('/api/news/post-signals', (req, res) => {
  res.json({ signals: postNewsSignals, count: postNewsSignals.length, generatedAt: new Date().toISOString(), status: getMt5Status() });
});

app.get('/api/trade-news/events', (req, res) => {
  const hours = Math.max(1, Math.min(168, Number(req.query.hours || 24)));
  const minImpact = req.query.minImpact ? String(req.query.minImpact).toUpperCase() : 'HIGH';
  const now = Date.now();
  const events = getEconomicEvents({ from: now - 30 * 60 * 1000, to: now + hours * 60 * 60 * 1000, minImpact })
    .map((event) => ({
      ...event,
      eventType: classifyNewsEvent(event),
      minutesUntil: Math.round((event.timestampUtc - now) / 60000),
    }));
  res.json({ ok: true, events, count: events.length, generatedAt: new Date().toISOString(), calendarSource: getCalendarStore().source, status: getMt5Status() });
});

app.get('/api/trade-news/forex', (req, res) => {
  refreshPostNewsSignals(Date.now());
  const minConfidence = Number(req.query.minConfidence || 0);
  const activeOnly = String(req.query.activeOnly || 'false') === 'true';
  const signals = postNewsSignals
    .map(enrichTradeNewsForexSignal)
    .filter((sig) => sig.confidence >= minConfidence)
    .filter((sig) => !activeOnly || sig.status === 'ACTIVE')
    .sort((a, b) => b.confidence - a.confidence);
  res.json({ ok: true, type: 'forex', signals, count: signals.length, generatedAt: new Date().toISOString(), status: getMt5Status() });
});

app.get('/api/trade-news/fixed', (req, res) => {
  refreshPostNewsSignals(Date.now());
  const now = Date.now();
  const expiries = String(req.query.expiries || '1m,2m,3m,5m,10m,15m,30m,1h')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const minConfidence = Number(req.query.minConfidence || 0);
  const activeOnly = String(req.query.activeOnly || 'false') === 'true';
  const signals = [];
  for (const sig of postNewsSignals.map(enrichTradeNewsForexSignal)) {
    if (sig.direction === 'NEUTRAL') continue;
    if (activeOnly && sig.status !== 'ACTIVE') continue;
    for (const expiry of expiries) {
      const fixed = buildTradeNewsFixedSignal(sig, expiry, now);
      if (fixed.confidence >= minConfidence) signals.push(fixed);
    }
  }
  signals.sort((a, b) => b.confidence - a.confidence);
  res.json({ ok: true, type: 'fixed', signals, count: signals.length, generatedAt: new Date().toISOString(), status: getMt5Status() });
});

// Latest cached FOREX system signals (non-HOLD) from the background scanner — instant read
// for the Future Predictions page's "Forex Trade Signals" section. No news dependency.
app.get('/api/signals/latest', (req, res) => {
  // Calendar gate: surface NO actionable forex signals while the market is closed (weekend),
  // even if the cache holds setups computed from fresh weekend bars.
  if (!liveSignalsAllowed()) {
    return res.json({ signals: [], count: 0, marketClosed: true, generatedAt: new Date().toISOString(), status: getMt5Status() });
  }
  const minGradeRank = SIGNAL_ALERT_MIN_GRADE_RANK; // B+ by default
  const out = [];
  const seen = new Set();
  for (const [tf, cached] of scanCacheByTf.entries()) {
    for (const r of (cached?.results || [])) {
      const sd = r.systemDecision;
      if (!sd || sd.decision === 'HOLD') continue;
      if ((GRADE_RANK[String(sd.grade || '').toUpperCase()] || 0) < minGradeRank) continue;
      const key = `${r.symbol}|${tf}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ symbol: r.symbol, timeframe: tf, systemDecision: sd, latestAiDecision: r.latestAiDecision || null });
    }
  }
  out.sort((a, b) => (b.systemDecision.confidence || 0) - (a.systemDecision.confidence || 0));
  res.json({ signals: out, count: out.length, generatedAt: new Date().toISOString(), status: getMt5Status() });
});

// News-reaction signals: chart-aware "what-if" scenarios for upcoming events,
// prioritising symbols with open positions. Powers the /news-high-impact page.
function buildNewsSignalsNow({ minImpact = 'LOW', horizonHours = 24 } = {}) {
  const status = getMt5Status();
  const openTrades = trades.filter((t) => t.status === 'open' || t.status === 'active');
  const trackedSymbols = [...new Set([
    ...(status.symbols || []),
    ...openTrades.map((t) => t.symbol),
    ...candles.map((c) => c.symbol),
  ].filter(Boolean))];
  return buildNewsSignals({
    now: Date.now(),
    horizonHours,
    minImpact,
    trackedSymbols,
    openTrades,
    getCandles: (symbol, timeframe, limit) => getRecentCandles(symbol, timeframe, limit),
  });
}

app.get('/api/news/signals', (req, res) => {
  const minImpact = req.query.minImpact ? String(req.query.minImpact).toUpperCase() : (process.env.NEWS_SIGNAL_MIN_IMPACT || 'LOW');
  const horizonHours = req.query.hours ? Number(req.query.hours) : 24;
  const signals = buildNewsSignalsNow({ minImpact, horizonHours });
  res.json({
    signals,
    count: signals.length,
    generatedAt: new Date().toISOString(),
    calendarSource: getCalendarStore().source,
    status: getMt5Status(),
  });
});

// Frontend read: list events, optionally filtered by window/impact/symbol.
app.get('/api/mt5/news', (req, res) => {
  const store = getCalendarStore();
  const symbol = req.query.symbol ? String(req.query.symbol) : null;
  const hours = req.query.hours ? Number(req.query.hours) : null;

  let events;
  if (symbol) {
    events = getUpcomingForSymbol(symbol, Date.now(), hours || 24);
  } else {
    const now = Date.now();
    const from = req.query.from ? Number(req.query.from) : now - 24 * 60 * 60 * 1000;
    const to = req.query.to ? Number(req.query.to) : now + (hours ? hours * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000);
    events = getEconomicEvents({ from, to, minImpact: req.query.minImpact || null });
  }

  res.json({
    events,
    count: events.length,
    updatedAt: store.updatedAt,
    source: store.source,
    serverGmtOffsetSec: store.serverGmtOffsetSec,
    sources: store.sources,
    status: getMt5Status(),
  });
});

app.get('/api/mt5/signals', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), MAX_SIGNALS);
  res.json({
    signals: signals.slice(0, limit),
    candles: candles.slice(0, Math.min(Number(req.query.candleLimit || 300), MAX_CANDLES)),
    trades: trades.slice(0, Math.min(Number(req.query.tradeLimit || 100), MAX_TRADES)),
    account: mt5State.accountSnapshot,
    status: getMt5Status(),
  });
});

app.get('/api/mt5/signals/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(`event: snapshot\ndata: ${JSON.stringify({ signals: signals.slice(0, 100), candles: candles.slice(0, 1000), trades: trades.slice(0, 100), account: mt5State.accountSnapshot, status: getMt5Status() })}\n\n`);
  streamClients.add(res);

  req.on('close', () => {
    streamClients.delete(res);
  });
});

app.post('/api/mt5/heartbeat', (req, res) => {
  const data = parseMt5Body(req.body);
  if (data.manualTest || data.terminal === 'Manual dashboard test') {
    return res.json({ ok: true, manualTest: true, status: getMt5Status() });
  }

  console.log('[MT5] Heartbeat received:', {
    account: data.account || data.accountNumber || null,
    broker: data.broker || null,
    terminal: data.terminal || null,
    version: data.version || data.eaVersion || null,
  });

  mt5State.lastHeartbeatAt = new Date().toISOString();
  mt5State.account = data.account || data.accountNumber || mt5State.account;
  mt5State.broker = data.broker || mt5State.broker;
  mt5State.terminal = data.terminal || mt5State.terminal;
  mt5State.version = data.version || data.eaVersion || mt5State.version;

  const status = getMt5Status();
  sendStreamEvent('status', status);
  res.json({ ok: true, status, activeSymbol: mt5State.activeSymbol, activeTimeframe: mt5State.activeTimeframe });
});

app.post('/api/mt5/signals', async (req, res) => {
  const signal = normalizeSignal(req.body, req);
  if (!signal.symbol || signal.symbol === 'UNKNOWN') {
    return res.status(400).json({ error: 'Signal symbol is required.', received: signal.raw });
  }

  addSignal(signal);

  const shouldEmail = process?.env?.EMAIL_ON_SIGNAL !== 'false';
  const to = signal.raw.emailTo || process?.env?.EMAIL_TO || process?.env?.SMTP_USER;
  if (shouldEmail && to) {
    try {
      const info = await sendNotificationEmail({
        to,
        signalId: signal.id,
        subject: `[Aura Gold] ${signal.symbol} ${signal.timeframe} ${signal.type}`,
        text: formatSignalEmail(signal),
      });
      signal.status = 'Delivered';
      signal.delivery = { channel: 'Email', recipient: to, messageId: info.messageId };
    } catch (error) {
      signal.status = 'Failed';
      signal.delivery = { channel: 'Email', recipient: to, error: error.message };
      addDeliveryLog({
        channel: 'Email',
        recipient: to,
        signalId: signal.id,
        status: 'Failed',
        error: error.message,
      });
    }
  } else {
    signal.status = 'Pending';
  }

  await persistSignal(signal);

  const status = getMt5Status();
  sendStreamEvent('signal', signal);
  sendStreamEvent('status', status);
  res.status(201).json({ ok: true, signal, status });
});

app.get('/api/mt5/candles', async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const timeframe = req.query.timeframe ? String(req.query.timeframe).toUpperCase() : null;
  if (symbol) {
    mt5State.activeSymbol = symbol;
  }
  if (timeframe) {
    mt5State.activeTimeframe = timeframe;
  }
  const limit = Math.min(Number(req.query.limit || 300), 100000);

  try {
    const pool = await initializeDatabase();
    if (pool && symbol && timeframe) {
      const [rows] = await pool.query(
        'SELECT * FROM mt5_candles WHERE symbol = ? AND timeframe = ? ORDER BY candle_time DESC LIMIT ?',
        [symbol, timeframe, limit]
      );
      const data = rows.map((row) => ({
        id: row.id,
        symbol: row.symbol,
        timeframe: row.timeframe,
        time: row.candle_time ? new Date(row.candle_time).toISOString() : new Date().toISOString(),
        open: row.open_price === null ? null : Number(row.open_price),
        high: row.high === null ? null : Number(row.high),
        low: row.low === null ? null : Number(row.low),
        close: row.close_price === null ? null : Number(row.close_price),
        volume: row.volume === null ? null : Number(row.volume),
        spread: row.spread === null ? null : Number(row.spread),
        receivedAt: row.received_at ? new Date(row.received_at).toISOString() : new Date().toISOString(),
        raw: parseJsonField(row.raw_json, {}),
      })).reverse();
      
      res.json({ candles: data, status: getMt5Status() });
    } else {
      const filtered = candles.filter((candle) => (!symbol || candle.symbol === symbol) && (!timeframe || candle.timeframe === timeframe));
      filtered.sort((a, b) => compareTimeDescending(a.time, b.time));
      const data = filtered.slice(0, limit).reverse();
      res.json({ candles: data, status: getMt5Status() });
    }
  } catch (error) {
    console.error('[API] Failed to get candles from DB:', error.message);
    const filtered = candles.filter((candle) => (!symbol || candle.symbol === symbol) && (!timeframe || candle.timeframe === timeframe));
    filtered.sort((a, b) => compareTimeDescending(a.time, b.time));
    const data = filtered.slice(0, limit).reverse();
    res.json({ candles: data, status: getMt5Status() });
  }
});

app.get('/api/mt5/history/coverage', async (req, res) => {
  try {
    const coverage = await getCandleCoverageFromDb();
    res.json({ ...coverage, status: getMt5Status() });
  } catch (error) {
    console.error('[API] Failed to load coverage from DB, falling back to memory:', error.message);
    const coverage = getCandleCoverage();
    res.json({ ...coverage, status: getMt5Status() });
  }
});

app.post('/api/mt5/candles', async (req, res) => {
  mt5State.lastHeartbeatAt = new Date().toISOString();
  const body = parseMt5Body(req.body);
  const list = Array.isArray(body.candles) ? body.candles : Array.isArray(body) ? body : body.candle ? [body.candle] : [body];
  const defaults = { symbol: body.symbol, timeframe: body.timeframe, sourceIp: req.ip };
  const normalizedList = [];
  for (const item of list) {
    const candle = normalizeCandle(item, defaults);
    if (!candle.symbol || candle.symbol === 'UNKNOWN') continue;
    normalizedList.push(candle);
  }

  if (normalizedList.length > 0) {
    addCandlesBatch(normalizedList);
    const isHistoryUpload = normalizedList.length > 50;
    if (isHistoryUpload) {
      sendStreamEvent('candle', normalizedList[normalizedList.length - 1]);
    } else {
      for (const candle of normalizedList) {
        sendStreamEvent('candle', candle);
      }
    }
  }

  const status = getMt5Status();
  sendStreamEvent('status', status);
  res.status(201).json({ ok: true, candles: normalizedList, status, activeSymbol: mt5State.activeSymbol, activeTimeframe: mt5State.activeTimeframe });
});

app.get('/api/mt5/trades', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const statusFilter = req.query.status ? String(req.query.status).toLowerCase() : null;
  const limit = Math.min(Number(req.query.limit || 100), MAX_TRADES);
  const data = trades.filter((trade) => (!symbol || trade.symbol === symbol) && (!statusFilter || trade.status === statusFilter)).slice(0, limit);
  res.json({ trades: data, status: getMt5Status() });
});

app.post('/api/mt5/trades', async (req, res) => {
  mt5State.lastHeartbeatAt = new Date().toISOString();
  const body = parseMt5Body(req.body);
  const list = Array.isArray(body.trades) ? body.trades : Array.isArray(body) ? body : body.trade ? [body.trade] : [body];
  const defaults = { account: body.account, broker: body.broker, terminal: body.terminal, sourceIp: req.ip };
  const stored = [];
  for (const item of list) {
    const trade = normalizeTrade(item, defaults);
    if (!trade.symbol || trade.symbol === 'UNKNOWN') continue;
    addTrade(trade);
    stored.push(trade);
    sendStreamEvent('trade', trade);
  }
  const status = getMt5Status();
  sendStreamEvent('status', status);
  res.status(201).json({ ok: true, trades: stored, status });
});

app.get('/api/mt5/account', (req, res) => {
  const status = getMt5Status();
  res.json({ account: status.accountSnapshot, status });
});

app.post('/api/mt5/account', async (req, res) => {
  const snapshot = normalizeAccountSnapshot(req.body, { sourceIp: req.ip });
  addAccountSnapshot(snapshot);
  const status = getMt5Status();
  sendStreamEvent('account', snapshot);
  sendStreamEvent('status', status);
  res.status(201).json({ ok: true, account: snapshot, status });
});

app.get('/api/mt5/indicators', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const timeframe = req.query.timeframe ? String(req.query.timeframe).toUpperCase() : null;
  const indicator = req.query.indicator ? String(req.query.indicator).toUpperCase() : null;
  const limit = Math.min(Number(req.query.limit || 200), MAX_INDICATORS);
  const filtered = indicators.filter((item) => (!symbol || item.symbol === symbol) && (!timeframe || item.timeframe === timeframe) && (!indicator || item.indicator === indicator));
  filtered.sort((a, b) => compareTimeDescending(a.candleTime, b.candleTime));
  const data = filtered.slice(0, limit);
  res.json({ indicators: data, status: getMt5Status() });
});

app.post('/api/mt5/indicators', async (req, res) => {
  mt5State.lastHeartbeatAt = new Date().toISOString();
  const body = parseMt5Body(req.body);
  const list = Array.isArray(body.indicators) ? body.indicators : Array.isArray(body) ? body : body.indicator ? [body.indicator] : [body];
  const defaults = { symbol: body.symbol, timeframe: body.timeframe, sourceIp: req.ip };
  const stored = [];
  for (const item of list) {
    const indicator = normalizeIndicator(item, defaults);
    if (!indicator.symbol || indicator.symbol === 'UNKNOWN') continue;
    addIndicator(indicator);
    stored.push(indicator);
    sendStreamEvent('indicator', indicator);
  }
  const status = getMt5Status();
  sendStreamEvent('status', status);
  res.status(201).json({ ok: true, indicators: stored, status });
});

app.get('/api/mt5/indicators/latest', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const timeframe = req.query.timeframe ? String(req.query.timeframe).toUpperCase() : null;
  const latest = new Map();
  for (const indicator of indicators) {
    if (symbol && indicator.symbol !== symbol) continue;
    if (timeframe && indicator.timeframe !== timeframe) continue;
    const key = `${indicator.symbol}|${indicator.timeframe}|${indicator.indicator}`;
    if (!latest.has(key)) latest.set(key, indicator);
  }
  res.json({ indicators: [...latest.values()], status: getMt5Status() });
});

app.post('/api/mt5/snapshot', async (req, res) => {
  const body = parseMt5Body(req.body);
  console.log('[MT5] Snapshot received:', {
    account: body.account || body.accountNumber || null,
    broker: body.broker || null,
    terminal: body.terminal || null,
    symbols: Array.isArray(body.symbols) ? body.symbols.length : 0,
    timeframes: Array.isArray(body.timeframes) ? body.timeframes.length : 0,
    candles: Array.isArray(body.candles) ? body.candles.length : 0,
    indicators: Array.isArray(body.indicators) ? body.indicators.length : 0,
  });
  const defaults = { account: body.account, broker: body.broker, terminal: body.terminal, symbol: body.symbol, timeframe: body.timeframe, sourceIp: req.ip };
  const storedSignals = [];
  const storedCandles = [];
  const storedTrades = [];
  const storedIndicators = [];

  if (body.account || body.balance || body.equity || body.freeMargin || body.free_margin) {
    const account = normalizeAccountSnapshot(body, defaults);
    addAccountSnapshot(account);
    sendStreamEvent('account', account);
  }

  const signalList = Array.isArray(body.signals) ? body.signals : body.signal ? [body.signal] : [];
  for (const item of signalList) {
    const signal = normalizeSignal(item, { ip: req.ip });
    if (!signal.symbol || signal.symbol === 'UNKNOWN') continue;
    addSignal(signal);
    storedSignals.push(signal);
    sendStreamEvent('signal', signal);
  }

  const candleList = Array.isArray(body.candles) ? body.candles : body.candle ? [body.candle] : [];
  const normalizedCandles = [];
  for (const item of candleList) {
    const candle = normalizeCandle(item, defaults);
    if (!candle.symbol || candle.symbol === 'UNKNOWN') continue;
    normalizedCandles.push(candle);
    storedCandles.push(candle);
  }
  if (normalizedCandles.length > 0) {
    addCandlesBatch(normalizedCandles);
    const isHistoryUpload = normalizedCandles.length > 50;
    if (isHistoryUpload) {
      sendStreamEvent('candle', normalizedCandles[normalizedCandles.length - 1]);
    } else {
      for (const candle of normalizedCandles) {
        sendStreamEvent('candle', candle);
      }
    }
  }

  const indicatorList = Array.isArray(body.indicators) ? body.indicators : body.indicator ? [body.indicator] : [];
  for (const item of indicatorList) {
    const indicator = normalizeIndicator(item, defaults);
    if (!indicator.symbol || indicator.symbol === 'UNKNOWN') continue;
    addIndicator(indicator);
    storedIndicators.push(indicator);
    sendStreamEvent('indicator', indicator);
  }

  const tradeList = Array.isArray(body.trades) ? body.trades : body.trade ? [body.trade] : [];
  for (const item of tradeList) {
    const trade = normalizeTrade(item, defaults);
    if (!trade.symbol || trade.symbol === 'UNKNOWN') continue;
    addTrade(trade);
    storedTrades.push(trade);
    sendStreamEvent('trade', trade);
  }

  const status = getMt5Status();
  const storedCounts = {
    signals: storedSignals.length,
    candles: storedCandles.length,
    trades: storedTrades.length,
    indicators: storedIndicators.length,
  };
  sendStreamEvent('snapshot', { signals: [], candles: [], trades: [], indicators: [], counts: storedCounts, status });
  sendStreamEvent('status', status);
  res.status(201).json({ ok: true, counts: storedCounts, status, activeSymbol: mt5State.activeSymbol, activeTimeframe: mt5State.activeTimeframe });
});

// ── AI Chart Image analysis (vision) ─────────────────────────────────────────
// Upload a chart screenshot → Gemini vision detects structure/S-R/breakout and gives a
// forex + fixed-time plan, RECONCILED with the live symbol|timeframe math. If Gemini is
// unavailable it falls back to pure deterministic system analysis of the LIVE data (it
// cannot read the image without a vision model). READ-ONLY + ISOLATED: it reuses the live
// engines but never writes signals, never changes scoring, never touches the scanners.
app.post('/api/ai/analyze-chart', async (req, res) => {
  try {
    const body = parseMt5Body(req.body);
    const imageBase64 = String(body.imageBase64 || body.image || '').replace(/^data:[^;]+;base64,/, '');
    const mimeType = String(body.mimeType || 'image/jpeg');
    const tradeMode = String(body.tradeMode || 'BOTH').toUpperCase();
    const rawSymbol = String(body.symbol || '').trim();
    const timeframe = String(body.timeframe || 'M15').toUpperCase();
    if (!rawSymbol) return res.status(400).json({ error: 'symbol is required — it grounds the AI read and powers the deterministic fallback.' });

    // Resolve the real broker symbol case-insensitively (Trap #2).
    const status = getMt5Status();
    const availableSymbols = Array.from(new Set([...(status.symbols || []), ...signals.map((s) => s.symbol), ...candles.map((c) => c.symbol)].filter(Boolean)));
    const symbol = availableSymbols.find((s) => s.toUpperCase() === rawSymbol.toUpperCase()) || rawSymbol;

    const candleList = getRecentCandles(symbol, timeframe, 300);
    if (!candleList || candleList.length < 30) {
      return res.status(400).json({ error: `Not enough live candle data for ${symbol} ${timeframe}. Pick a streamed symbol/timeframe (needed to ground the AI and run the fallback).` });
    }

    // Freshness stamp: this is an ON-DEMAND, user-initiated analysis, so we LABEL rather than
    // block — a weekend/last-session chart can still be studied, but the response says plainly
    // whether the underlying math ran on live or stored candles.
    const fresh = candleFreshness(candleList[candleList.length - 1], timeframe);

    // ── Deterministic GROUND TRUTH from the live engines (read-only) ──
    const indicators = getRecentIndicators(symbol, timeframe, 500);
    const h4Candles = getRecentCandles(symbol, 'H4', 150);
    const h1Candles = getRecentCandles(symbol, 'H1', 150);
    const signalSummary = aggregateSignals({ symbol, timeframe, candles: candleList, indicators, marketLevels: [], accountSnapshot: mt5State.accountSnapshot, h4Candles, h1Candles });
    const sd = signalSummary.systemDecision || {};
    const fttPrediction = generateFttPrediction({ symbol, expiry: '5m', timeframe, candles: candleList, indicators, marketLevels: [], accountSnapshot: mt5State.accountSnapshot, h4Candles, h1Candles });
    const breakout = buildBreakoutCandidate({ symbol, timeframe, candles: candleList });
    const sizing = strategyLabSizing(symbol, sd.entryPrice, sd.stopLoss, { tp1: sd.takeProfit1, tp2: sd.takeProfit2, tp3: sd.takeProfit3 });

    // Enabled strategies' read (so the decision "can use strategies" — respects the controller).
    let strategies = [];
    try {
      const ctx = buildStrategyContext(symbol, timeframe);
      if (ctx) {
        strategies = enabledStrategyIds().filter((id) => strategyTimeframes(id).includes(timeframe)).map((id) => {
          const sig = evaluateStrategy(id, ctx);
          return sig && sig.decision && sig.decision !== 'HOLD'
            ? { id, name: STRATEGY_LAB_REGISTRY[id]?.name || id, decision: sig.decision, score: sig.score ?? null, grade: sig.grade ?? null }
            : null;
        }).filter(Boolean);
      }
    } catch { /* strategies are advisory; never block the analysis */ }

    const dir = normalizeChartDir(fttPrediction.direction) !== 'NONE' ? normalizeChartDir(fttPrediction.direction) : normalizeChartDir(sd.decision);
    const persistence = estimateDirectionalPersistence(candleList, dir);
    const level = pickTriggerLevel({ breakout, supportResistance: sd.supportResistance, direction: dir, price: sd.entryPrice });
    const timeTrigger = buildConditionalTimeTrigger({ candles: candleList, timeframe, level, direction: dir, timezone: process.env.APP_TIME_ZONE || 'Asia/Dhaka' });

    const groundTruth = {
      systemDecision: { decision: sd.decision, entry: sd.entryPrice, stopLoss: sd.stopLoss, takeProfit1: sd.takeProfit1, takeProfit2: sd.takeProfit2, takeProfit3: sd.takeProfit3, riskReward: sd.riskRewardRatio, grade: sd.grade, regime: sd.regime, htfBias: sd.htfBias, confidence: sd.confidence },
      supportResistance: sd.supportResistance || { support: [], resistance: [] },
      breakout, persistence, timeTrigger,
      ftt: { direction: fttPrediction.direction, confidence: fttPrediction.confidence, timeframeMapping: fttPrediction.indicators?.timeframeMapping || null },
      suggestedLots: sizing?.suggestedLots ?? null,
      strategies,
    };

    // Deterministic fallback (built once; used if Gemini can't read the image).
    const systemAnalysis = buildSystemChartAnalysis({ symbol, timeframe, tradeMode, systemDecision: sd, fttPrediction, breakout, sizing, candles: candleList, strategies, supportResistance: sd.supportResistance, timezone: process.env.APP_TIME_ZONE || 'Asia/Dhaka' });

    // ── PRIMARY: Gemini vision ──
    const vision = await analyzeChartImageWithGemini({ projectId: GOOGLE_CLOUD_PROJECT, location: GOOGLE_CLOUD_LOCATION, model: GEMINI_MODEL, imageBase64, mimeType, symbol, timeframe, tradeMode, groundTruth });

    if (vision.available) {
      // Recompute lots server-side from the vision entry/SL (never trust the model's lot).
      const vSizing = strategyLabSizing(symbol, vision.forexPlan?.entry, vision.forexPlan?.stopLoss, { tp1: vision.forexPlan?.takeProfit1, tp2: vision.forexPlan?.takeProfit2, tp3: vision.forexPlan?.takeProfit3 });
      const forexPlan = (tradeMode === 'FTT') ? null : {
        ...vision.forexPlan,
        lots: vSizing?.suggestedLots ?? sizing?.suggestedLots ?? null,
        stopPips: vSizing?.stopPips ?? null,
        lossAtStop: vSizing?.lossAtStop ?? null,
      };
      const fttPlan = (tradeMode === 'FOREX') ? null : {
        ...vision.fttPlan,
        expectedCandlesInDirection: vision.fttPlan?.expectedCandlesInDirection ?? persistence.expectedCandles,
        persistenceRange: persistence.p25 != null ? { low: persistence.p25, high: persistence.p75, basis: persistence.basis } : null,
        timeTrigger: vision.fttPlan?.timeTrigger ?? timeTrigger,
      };
      return res.json({
        ok: true, source: 'gemini-vision', symbol, timeframe, tradeMode,
        verdict: vision.verdict, confidence: vision.confidence,
        detection: vision.detection, forexPlan, fttPlan,
        breakout: systemAnalysis.breakout, strategies,
        reasoning: vision.reasoning, keyFactors: vision.key_factors,
        system: systemAnalysis, // deterministic read alongside, for comparison
        dataFresh: fresh.dataFresh, sourceReceivedAt: fresh.sourceReceivedAt, staleSeconds: fresh.staleSeconds, marketStatus: fresh.marketStatus,
        honesty: [
          `Chart read by Gemini vision, reconciled with live ${symbol} ${timeframe} math. Lots recomputed server-side. Estimates, not guarantees.`,
          ...(fresh.dataFresh ? [] : [`Underlying ${symbol} ${timeframe} candles are NOT live (${fresh.marketStatus.state === 'CLOSED' ? 'market closed' : 'feed stale'}, last data ${fresh.staleSeconds}s ago) — treat as last-session study, not a live signal.`]),
        ],
      });
    }

    // ── FALLBACK: deterministic system analysis of the LIVE data (not the image) ──
    return res.json({
      ok: true, source: 'system-fallback', symbol, timeframe, tradeMode,
      ...systemAnalysis,
      dataFresh: fresh.dataFresh, sourceReceivedAt: fresh.sourceReceivedAt, staleSeconds: fresh.staleSeconds, marketStatus: fresh.marketStatus,
      note: `AI vision unavailable — analysed ${fresh.dataFresh ? 'live' : (fresh.marketStatus.state === 'CLOSED' ? 'last-session (market closed)' : 'stale')} ${symbol} ${timeframe} data, not your uploaded image.`,
    });
  } catch (error) {
    console.error('[AI Chart] analyze-chart failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ai/analyze', async (req, res) => {
  const body = parseMt5Body(req.body);
  const symbol = String(body.symbol || candles[0]?.symbol || 'XAUUSD').toUpperCase();
  const timeframe = String(body.timeframe || 'M5').toUpperCase();
  mt5State.activeSymbol = symbol;
  mt5State.activeTimeframe = timeframe;
  try {
    const decision = await runAiAnalysis(symbol, timeframe, { force: body.force !== false, reason: 'manual' });
    if (!decision) return res.status(404).json({ error: 'No candles available for analysis.', symbol, timeframe });
    res.status(201).json({ ok: true, decision, status: getMt5Status() });
  } catch (error) {
    console.error('[AI] Manual analysis failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ai-signals/analyze', async (req, res) => {
  const body = parseMt5Body(req.body);
  const rawSymbol = String(body.symbol || 'XAUUSDm');
  const tradeMode = String(body.tradeMode || 'FTT').toUpperCase(); // 'FTT' or 'FOREX'

  try {
    // Determine active broker symbol (case insensitive match)
    const status = getMt5Status();
    const availableSymbols = Array.from(new Set([
      ...(status.symbols || []),
      ...signals.map((s) => s.symbol),
      ...candles.map((c) => c.symbol)
    ].filter(Boolean)));
    const symbol = availableSymbols.find(s => s.toUpperCase() === rawSymbol.toUpperCase()) || rawSymbol;

    const entryTf = tradeMode === 'FTT' ? 'M5' : 'H1';
    const trendTf = tradeMode === 'FTT' ? 'H1' : 'H4';
    const biasTf = tradeMode === 'FTT' ? 'H4' : 'D1';

    const entryCandles = getRecentCandles(symbol, entryTf, 200);
    const trendCandles = getRecentCandles(symbol, trendTf, 200);
    const biasCandles = getRecentCandles(symbol, biasTf, 200);
    const dailyCandles = getRecentCandles(symbol, 'D1', 20);

    if (!entryCandles || entryCandles.length === 0) {
      return res.status(400).json({
        error: `No candle data available for symbol ${symbol}. Please ensure MT5 terminal is streaming updates.`
      });
    }

    const latestCandle = entryCandles[entryCandles.length - 1];
    const currentPrice = Number(latestCandle.close);

    // Outdated telemetry check
    if (!isCandleCurrent(latestCandle, entryTf)) {
      const lastReceived = latestCandle.receivedAt || latestCandle.time;
      return res.status(400).json({
        error: `Market telemetry is outdated for ${symbol}. Latest price update was at ${new Date(lastReceived).toLocaleString()}. Please check MT5 connection.`
      });
    }

    // Pre-calculate indicators
    const rsi = aiIndicators.calculateRSI(entryCandles, 14);
    const macd = aiIndicators.calculateMACD(entryCandles);
    const bb = aiIndicators.calculateBollingerBands(entryCandles, 20, 2);
    const ema20 = aiIndicators.calculateEMA(entryCandles, 20);
    const ema50 = aiIndicators.calculateEMA(entryCandles, 50);
    const ema200 = aiIndicators.calculateEMA(entryCandles, 200);

    // ADR & High/Low
    let adr = null;
    let dailyHigh = null;
    let dailyLow = null;
    if (dailyCandles.length >= 14) {
      const dailyRanges = dailyCandles.slice(-14).map(c => {
        const h = Number(c.high);
        const l = Number(c.low);
        return (!isNaN(h) && !isNaN(l)) ? (h - l) : 0;
      }).filter(r => r > 0);
      if (dailyRanges.length >= 10) {
        adr = dailyRanges.reduce((sum, r) => sum + r, 0) / dailyRanges.length;
      }
    }
    const latestDailyCandle = dailyCandles[dailyCandles.length - 1];
    if (latestDailyCandle) {
      dailyHigh = Number(latestDailyCandle.high);
      dailyLow = Number(latestDailyCandle.low);
    }

    // Calculate ATR
    let atr = null;
    if (entryCandles.length >= 15) {
      let trSum = 0;
      for (let i = entryCandles.length - 14; i < entryCandles.length; i++) {
        const cur = entryCandles[i];
        const prev = entryCandles[i - 1];
        const val1 = Number(cur.high) - Number(cur.low);
        const val2 = Math.abs(Number(cur.high) - Number(prev.close));
        const val3 = Math.abs(Number(cur.low) - Number(prev.close));
        trSum += Math.max(val1, val2, val3);
      }
      atr = trSum / 14;
    }
    const supportResistance = detectSupportResistance(entryCandles, atr);

    let calculatedIndicators = {
      currentPrice,
      atr,
      adr,
      dailyHigh,
      dailyLow,
      rsi,
      macd,
      bb,
      ema20,
      ema50,
      ema200,
      supportResistance,
    };

    if (tradeMode === 'FTT') {
      const ha = aiIndicators.convertToHeikinAshi(entryCandles);
      const haRecent = ha.slice(-10).map(c => ({
        time: c.time,
        open: Math.round(c.open * 100000) / 100000,
        close: Math.round(c.close * 100000) / 100000,
        high: Math.round(c.high * 100000) / 100000,
        low: Math.round(c.low * 100000) / 100000,
      }));

      const ichimoku = aiIndicators.calculateIchimoku(entryCandles);
      const latestIchimoku = ichimoku ? ichimoku[ichimoku.length - 1] : null;

      const ichimokuHA = aiIndicators.calculateIchimoku(ha);
      let pearlSignal = "HOLD";
      if (ichimokuHA && ichimokuHA.length >= 2) {
        const curTK = ichimokuHA[ichimokuHA.length - 1];
        const prevTK = ichimokuHA[ichimokuHA.length - 2];
        if (prevTK.tenkan <= prevTK.kijun && curTK.tenkan > curTK.kijun) {
          pearlSignal = "BUY (TK Golden Cross on HA)";
        } else if (prevTK.tenkan >= prevTK.kijun && curTK.tenkan < curTK.kijun) {
          pearlSignal = "SELL (TK Dead Cross on HA)";
        } else {
          pearlSignal = curTK.tenkan > curTK.kijun ? "BULLISH LEAN (Tenkan > Kijun)" : "BEARISH LEAN (Tenkan < Kijun)";
        }
      }

      let trendSignal = "HOLD";
      if (ha.length >= 1 && rsi !== null) {
        const latestHA = ha[ha.length - 1];
        const isHAUptrend = latestHA.close > latestHA.open;
        if (isHAUptrend && rsi > 50) {
          trendSignal = "BUY (HA green + RSI > 50)";
        } else if (!isHAUptrend && rsi < 50) {
          trendSignal = "SELL (HA red + RSI < 50)";
        } else {
          trendSignal = `NEUTRAL (HA=${isHAUptrend ? 'green' : 'red'}, RSI=${Math.round(rsi)})`;
        }
      }

      calculatedIndicators = {
        ...calculatedIndicators,
        haRecent,
        latestIchimoku,
        japanesePearl: pearlSignal,
        japaneseTrend: trendSignal,
      };
    } else {
      const obv = aiIndicators.calculateOBV(entryCandles);
      const adLine = aiIndicators.calculateADLine(entryCandles);
      const adx = aiIndicators.calculateADX(entryCandles);
      const aroon = aiIndicators.calculateAroon(entryCandles);
      const stochastic = aiIndicators.calculateStochastic(entryCandles);

      calculatedIndicators = {
        ...calculatedIndicators,
        obv,
        adLine,
        adx,
        aroon,
        stochastic,
      };
    }

    const newsEvents = getUpcomingForSymbol(symbol, Date.now(), 12).map((e) => ({
      currency: e.currency,
      impact: e.impact,
      title: e.title,
      in_minutes: Math.round((e.timestampUtc - Date.now()) / 60000),
      forecast: e.forecast,
      previous: e.previous,
    }));

    let result;
    const engine = body.engine || 'ai';
    if (engine === 'system') {
      const summary = aggregateSignals({
        symbol,
        timeframe: entryTf,
        candles: entryCandles,
        h1Candles: trendCandles,
        h4Candles: biasCandles,
        adr,
        dailyHighLow: latestDailyCandle ? { high: dailyHigh, low: dailyLow } : null,
      });

      const dec = summary.decision;
      const sys = summary.systemDecision;
      const digits = (symbol.toUpperCase().includes('JPY') || symbol.toUpperCase().includes('XAU') || symbol.toUpperCase().includes('GOLD')) ? 3 : 5;

      let invalidationText = 'No active setup structure.';
      if (sys.stopLoss) {
        invalidationText = `Structure breach below key level of ${sys.stopLoss.toFixed(digits)}.`;
      }

      let predictedTimeText = 'No execution target.';
      if (sys.entryTrigger === 'IMMEDIATE') {
        predictedTimeText = `Immediate Execution / Within current ${entryTf} candle (${sys.remainingSeconds || 300}s left).`;
      } else if (sys.entryTrigger === 'LIMIT_PULLBACK') {
        predictedTimeText = `Pullback entry target pending (within 1-3 hours).`;
      } else if (sys.entryTrigger === 'BREAKOUT_CONFIRMATION') {
        predictedTimeText = `Breakout confirmation target (awaiting candle close).`;
      }

      const confluencesMarkdown = sys.confluences && sys.confluences.length > 0
        ? sys.confluences.map(c => `* **${c.name}** (+${c.points} pts): ${c.reason}`).join('\n')
        : '* *No significant trade confluences detected.*';

      const srMarkdown = supportResistance && (supportResistance.support.length > 0 || supportResistance.resistance.length > 0)
        ? `#### Support Levels:\n${supportResistance.support.map((s, idx) => `${idx+1}. **${s.level}** (tested ${s.strength}x)`).join('\n')}\n\n#### Resistance Levels:\n${supportResistance.resistance.map((r, idx) => `${idx+1}. **${r.level}** (tested ${r.strength}x)`).join('\n')}`
        : '*No support or resistance zones clustered.*';

      const reportMarkdown = `
### CLINICAL MARKET SUMMARY (${symbol} - ${tradeMode})
* **Decision**: \`${dec}\` (Setup Grade: **${sys.grade || 'No Trade'}**)
* **Engine Mode**: \`Rule-Based (System Engine)\`
* **Market Regime**: \`${sys.regime.toUpperCase()}\` (ADX: ${sys.adxValue !== null ? sys.adxValue.toFixed(1) : 'n/a'})

---

### TECHNICAL CONFLUENCES & SIGNAL WEIGHTS
${confluencesMarkdown}

---

### SUPPORT & RESISTANCE PIVOT ZONES
${srMarkdown}

---

### EXPECTANCY & RISK ASSESSMENT
* **Stop Loss (SL)**: ${sys.stopLoss ? sys.stopLoss.toFixed(digits) : 'n/a'}
* **Take Profit Targets**:
  - TP1 (1:1 RR): ${sys.takeProfit1 ? sys.takeProfit1.toFixed(digits) : 'n/a'}
  - TP2 (2:1 RR): ${sys.takeProfit2 ? sys.takeProfit2.toFixed(digits) : 'n/a'}
  - TP3 (3:1 RR): ${sys.takeProfit3 ? sys.takeProfit3.toFixed(digits) : 'n/a'}
* **Risk/Reward Profile**: ${sys.riskRewardRatio ? sys.riskRewardRatio : 'n/a'} (suggested risk: 1% equity)
* **Invalidation Level**: ${invalidationText}
* **Volatility & Range**: ATR (${(sys.bodyRatio !== null ? sys.bodyRatio * 100 : 0).toFixed(0)}% body ratio), ADR usage: ${sys.adrUsagePercent ? sys.adrUsagePercent.toFixed(0) : 0}%

---

### CLINICAL FINAL ADVISORY
* **Verdict**: ${sys.rejectionReasons.length > 0 ? `**NO TRADE** — ${sys.rejectionReasons.join(', ')}` : '**EXECUTION READY**'}
* **Timing**: ${predictedTimeText}
`;

      result = {
        decision: dec,
        confidence: sys.confidence,
        entryPrice: currentPrice,
        atr: atr,
        stopLoss: sys.stopLoss,
        takeProfit1: sys.takeProfit1,
        takeProfit2: sys.takeProfit2,
        takeProfit3: sys.takeProfit3,
        invalidation: invalidationText,
        riskLevel: sys.adxValue !== null && sys.adxValue > 35 ? 'HIGH' : (sys.adxValue !== null && sys.adxValue < 18 ? 'LOW' : 'MEDIUM'),
        tradeTrigger: sys.entryTrigger,
        predictedTime: predictedTimeText,
        clinicalReport: reportMarkdown,
      };
    } else {
      result = await analyzeAiSignalsWithGemini({
        projectId: GOOGLE_CLOUD_PROJECT,
        location: GOOGLE_CLOUD_LOCATION,
        model: GEMINI_MODEL,
        symbol,
        tradeMode,
        indicators: calculatedIndicators,
        news: newsEvents,
        currentPrice
      });
    }

    res.status(200).json({
      ok: true,
      symbol,
      tradeMode,
      timestamp: new Date().toISOString(),
      analysis: result
    });
  } catch (error) {
    console.error('[AI Signals] Analysis handler failed:', error);
    res.status(500).json({ error: error.message });
  }
});

function resolveLiveSymbol(rawSymbol) {
  const symbol = String(rawSymbol || '').trim();
  if (!symbol) return '';
  const availableSymbols = Array.from(new Set([
    ...(getMt5Status().symbols || []),
    ...signals.map((s) => s.symbol),
    ...candles.map((c) => c.symbol),
  ].filter(Boolean)));
  return availableSymbols.find((s) => String(s).toUpperCase() === symbol.toUpperCase()) || symbol.toUpperCase();
}

app.post('/api/ai-signals/track', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(503).json({ error: 'Database is not configured; tracked AI projections require MySQL.' });
  await ensureTrackedAiProjectionSchema(pool);

  const body = parseMt5Body(req.body);
  const symbol = resolveLiveSymbol(body.symbol);
  const tradeMode = String(body.tradeMode || body.trade_mode || 'FTT').toUpperCase();
  const decision = String(body.decision || '').toUpperCase();
  const entryPrice = parseMaybeNumber(body.entryPrice ?? body.entry_price);
  const confidence = Math.max(0, Math.min(100, Number(body.confidence || 0)));
  const tradeTrigger = String(body.tradeTrigger || body.trade_trigger || 'LIMIT_PULLBACK').toUpperCase().replace(/\s+/g, '_');
  const expiresAtRaw = body.expiresAt || body.expires_at;
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : new Date(Date.now() + (tradeMode === 'FTT' ? 60 : 4 * 60) * 60 * 1000);

  if (!symbol || !['BUY', 'STRONG_BUY', 'SELL', 'STRONG_SELL', 'HOLD'].includes(decision)) {
    return res.status(400).json({ error: 'Tracking requires symbol and a valid decision (BUY/SELL/HOLD).' });
  }
  if (decision !== 'HOLD' && entryPrice === null) {
    return res.status(400).json({ error: 'Tracking requires an entry price for BUY/SELL decisions.' });
  }
  if (!['FTT', 'FOREX'].includes(tradeMode)) {
    return res.status(400).json({ error: 'tradeMode must be FTT or FOREX.' });
  }
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'expiresAt must be a future date.' });
  }

  const id = body.id || `track_ai_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const invalidation = body.invalidation ? String(body.invalidation) : null;
  const invalidationPrice = parseMaybeNumber(body.invalidationPrice ?? body.invalidation_price) ?? extractInvalidationPrice(invalidation);
  const now = new Date();

  try {
    const insertTrackedProjection = () => pool.execute(
      `INSERT INTO mt5_tracked_ai_projections (
          id, source_analysis_id, symbol, trade_mode, decision, entry_price, stop_loss,
          take_profit_1, take_profit_2, take_profit_3, invalidation, invalidation_price,
          trade_trigger, confidence, status, expires_at, created_at, original_analysis_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [
          id,
          body.sourceAnalysisId || body.source_analysis_id || null,
          symbol,
          tradeMode,
          decision,
          entryPrice,
          parseMaybeNumber(body.stopLoss ?? body.stop_loss),
          parseMaybeNumber(body.takeProfit1 ?? body.take_profit_1),
          parseMaybeNumber(body.takeProfit2 ?? body.take_profit_2),
          parseMaybeNumber(body.takeProfit3 ?? body.take_profit_3),
          invalidation,
          invalidationPrice,
          tradeTrigger,
          confidence,
          toMysqlDate(expiresAt),
          toMysqlDate(now),
          body.originalAnalysis ? JSON.stringify(body.originalAnalysis) : null,
        ]
    );

    try {
      await insertTrackedProjection();
    } catch (insertError) {
      if (insertError?.code !== 'ER_BAD_FIELD_ERROR') throw insertError;
      await ensureTrackedAiProjectionSchema(pool);
      await insertTrackedProjection();
    }

    const [rows] = await pool.query('SELECT * FROM mt5_tracked_ai_projections WHERE id = ?', [id]);
    const tracked = normalizeTrackedProjectionRow(rows[0]);
    sendStreamEvent('ai_tracked_update', tracked);
    res.status(201).json({ ok: true, tracked, status: getMt5Status() });
  } catch (error) {
    console.error('[AI Signals Tracking] Failed to create tracked projection:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ai-signals/tracked', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.json({ tracked: [], status: getMt5Status() });
  try {
    const [rows] = await pool.query(
      `SELECT * FROM mt5_tracked_ai_projections
       WHERE status IN ('PENDING', 'TRIGGERED') OR created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)
       ORDER BY created_at DESC
       LIMIT 200`
    );
    res.json({ tracked: rows.map(normalizeTrackedProjectionRow), status: getMt5Status() });
  } catch (error) {
    console.error('[AI Signals Tracking] Failed to fetch tracked projections:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/ai-signals/track/:id', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(503).json({ error: 'Database is not configured; tracked AI projections require MySQL.' });
  try {
    await pool.execute('DELETE FROM mt5_tracked_ai_projections WHERE id = ?', [req.params.id]);
    sendStreamEvent('ai_tracked_update', { id: req.params.id, deleted: true });
    res.json({ ok: true, id: req.params.id });
  } catch (error) {
    console.error('[AI Signals Tracking] Failed to delete tracked projection:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ai/health', async (req, res) => {
  try {
    const model = req.query.model ? String(req.query.model) : GEMINI_MODEL;
    const health = await checkVertexAiHealth({
      projectId: GOOGLE_CLOUD_PROJECT,
      location: GOOGLE_CLOUD_LOCATION,
      model,
    });
    res.status(health.ok ? 200 : health.status || 500).json(health);
  } catch (error) {
    console.error('[AI] Vertex health check failed:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/ai/decisions', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const timeframe = req.query.timeframe ? String(req.query.timeframe).toUpperCase() : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const filtered = aiDecisions.filter((decision) => (!symbol || decision.symbol === symbol) && (!timeframe || decision.timeframe === timeframe));
  filtered.sort((a, b) => compareTimeDescending(a.created_at, b.created_at));
  const data = filtered.slice(0, limit);
  res.json({ decisions: data, status: getMt5Status() });
});

app.get('/api/ai/decisions/latest', (req, res) => {
  const sortedDecisions = [...aiDecisions].sort((a, b) => compareTimeDescending(a.created_at, b.created_at));
  const latest = new Map();
  for (const decision of sortedDecisions) {
    const key = `${decision.symbol}|${decision.timeframe}`;
    if (!latest.has(key)) latest.set(key, decision);
  }
  res.json({ decisions: [...latest.values()], latest: sortedDecisions[0] || null, status: getMt5Status() });
});

function forexSizingPipSize(symbol) {
  const s = String(symbol || '').toUpperCase();
  const caps = symbolCapsFor(s);
  if (caps?.pipSize) return caps.pipSize;              // index: risk measured in points
  if (s.includes('XAU') || s.includes('GOLD')) return 0.01;
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}

function forexSizingPipValuePerLot(symbol) {
  const s = String(symbol || '').toUpperCase();
  const caps = symbolCapsFor(s);
  if (caps?.pipValuePerLot) return caps.pipValuePerLot; // index: ~$1/point/lot (Exness USTEC)
  if (s.includes('XAU') || s.includes('GOLD')) return 1;
  if (s.includes('JPY')) return 9;
  return 10;
}

function forexSizingContractSize(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return 100;
  return 100000;
}

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function completeForexRiskPlan(result) {
  const sd = result?.systemDecision;
  if (!sd?.riskPlan) return result;

  const risk = { ...sd.riskPlan };
  const configuredFallbackEquity = Number(process.env.FOREX_SIGNAL_DEFAULT_EQUITY || 1000);
  const fallbackEquity = Number.isFinite(configuredFallbackEquity) && configuredFallbackEquity > 0 ? configuredFallbackEquity : 1000;
  const accountEquity = finitePositive(mt5State.accountSnapshot?.equity);
  const accountBalance = finitePositive(mt5State.accountSnapshot?.balance);
  const equity = finitePositive(risk.equity) ?? accountEquity ?? accountBalance ?? fallbackEquity;
  const riskPercent = finitePositive(risk.riskPercent) ?? Math.min(2, Math.max(0.1, Number(process.env.FOREX_SIGNAL_RISK_PERCENT || 1)));
  const leverage = finitePositive(risk.leverage) ?? Math.max(1, Number(process.env.FOREX_SIGNAL_LEVERAGE || 500));
  const entry = Number(sd.entryPrice);
  const stop = Number(sd.stopLoss);
  const pipSize = forexSizingPipSize(result.symbol);
  const pipValue = forexSizingPipValuePerLot(result.symbol);
  const contractSize = forexSizingContractSize(result.symbol);
  const stopDistance = Number.isFinite(entry) && Number.isFinite(stop) ? Math.abs(entry - stop) : Number(risk.stopDistance);
  const stopPips = finitePositive(risk.stopPips) ?? (Number.isFinite(stopDistance) && stopDistance > 0 ? Math.round((stopDistance / pipSize) * 10) / 10 : null);
  const riskAmount = finitePositive(risk.riskAmount ?? risk.amountToRisk) ?? Math.round(equity * (riskPercent / 100) * 100) / 100;
  const suggestedLotSize = finitePositive(risk.suggestedLotSize) ?? (riskAmount > 0 && stopPips > 0 ? Math.max(0.01, Math.round((riskAmount / (stopPips * pipValue)) * 100) / 100) : null);
  const notionalValue = finitePositive(risk.notionalValue) ?? (Number.isFinite(entry) && suggestedLotSize !== null ? Math.round(entry * contractSize * suggestedLotSize * 100) / 100 : null);
  const marginRequired = finitePositive(risk.marginRequired ?? risk.amountToInvestApprox) ?? (notionalValue !== null ? Math.round((notionalValue / leverage) * 100) / 100 : null);
  const calcProfit = (target, existing) => {
    const existingValue = finitePositive(existing);
    if (existingValue !== null) return existingValue;
    const t = Number(target);
    if (!Number.isFinite(t) || !Number.isFinite(entry) || suggestedLotSize === null) return null;
    return Math.round((Math.abs(t - entry) / pipSize) * pipValue * suggestedLotSize * 100) / 100;
  };
  const lossAtStop = finitePositive(risk.lossAtStop ?? risk.maxLoss) ?? (stopPips > 0 && suggestedLotSize !== null ? Math.round(stopPips * pipValue * suggestedLotSize * 100) / 100 : riskAmount);

  return {
    ...result,
    systemDecision: {
      ...sd,
      riskPlan: {
        ...risk,
        riskPercent,
        maxRiskPercent: risk.maxRiskPercent ?? 2,
        leverage,
        multiplier: risk.multiplier || `${leverage}x`,
        contractSize,
        equity,
        riskAmount,
        amountToRisk: riskAmount,
        stopDistance: Number.isFinite(stopDistance) ? stopDistance : null,
        stopPips,
        estimatedPipValuePerLot: pipValue,
        suggestedLotSize,
        notionalValue,
        marginRequired,
        amountToInvestApprox: marginRequired,
        lossAtStop,
        maxLoss: lossAtStop,
        profitAtTp1: calcProfit(sd.takeProfit1, risk.profitAtTp1),
        profitAtTp2: calcProfit(sd.takeProfit2, risk.profitAtTp2),
        profitAtTp3: calcProfit(sd.takeProfit3, risk.profitAtTp3),
      },
    },
  };
}

app.post('/api/signals/scan-all', async (req, res) => {
  const body = parseMt5Body(req.body);
  const timeframe = String(body.timeframe || 'M5').toUpperCase();

  const status = getMt5Status();
  // If the client supplies an explicit symbol list (e.g. the curated primary set),
  // scan only those. Otherwise fall back to scanning every known symbol.
  const requested = Array.isArray(body.symbols)
    ? body.symbols.map((s) => String(s).toUpperCase()).filter(Boolean)
    : null;

  // Serve the background daemon's cached results instantly unless a force refresh is asked.
  if (body.force !== true) {
    const cached = scanCacheByTf.get(timeframe);
    if (cached && Date.now() - cached.at < 90000) {
      const haveAll = !requested || requested.every((s) => cached.results.some((r) => r.symbol === s));
      if (haveAll) {
        const results = (requested ? cached.results.filter((r) => requested.includes(r.symbol)) : cached.results).map(completeForexRiskPlan);
        return res.json({ ok: true, results, status: getMt5Status(), cached: true });
      }
    }
  }

  const symbolsToScan = (requested && requested.length) ? requested : (status.symbols || []);
  const results = [];
  
  for (const symbol of symbolsToScan) {
    const candleList = getRecentCandles(symbol, timeframe, 200);
    if (!candleList || candleList.length < 20) continue;
    
    const latestCandle = candleList[candleList.length - 1];
    if (!isCandleCurrent(latestCandle, timeframe)) {
      const latestAi = aiDecisions.find(d => d.symbol === symbol && d.timeframe === timeframe) || null;
      results.push({
        symbol,
        timeframe,
        systemDecision: {
          decision: 'HOLD',
          confidence: 0,
          compositeScore: 0,
          grade: 'No Setup (Outdated Telemetry)',
          confluences: [],
          buyScore: 0,
          sellScore: 0,
        },
        latestAiDecision: latestAi,
      });
      continue;
    }
    
    const dailyCandles = getRecentCandles(symbol, 'D1', 20);
    let adr = null;
    let dailyHighLow = null;
    if (dailyCandles.length >= 14) {
      const dailyRanges = dailyCandles.slice(-14).map(c => {
        const h = Number(c.high);
        const l = Number(c.low);
        return (!isNaN(h) && !isNaN(l)) ? (h - l) : 0;
      }).filter(r => r > 0);
      if (dailyRanges.length >= 10) {
        adr = dailyRanges.reduce((sum, r) => sum + r, 0) / dailyRanges.length;
      }
    }
    const latestDailyCandle = dailyCandles[dailyCandles.length - 1];
    if (latestDailyCandle) {
      dailyHighLow = {
        high: Number(latestDailyCandle.high),
        low: Number(latestDailyCandle.low),
      };
    }
    
    try {
      const signalSummary = aggregateSignals({
        symbol,
        timeframe,
        candles: candleList,
        indicators: getRecentIndicators(symbol, timeframe, 500),
        marketLevels,
        accountSnapshot: mt5State.accountSnapshot,
        adr,
        dailyHighLow,
        h4Candles: getRecentCandles(symbol, 'H4', 150),
        h1Candles: getRecentCandles(symbol, 'H1', 150),
      });
      
      const latestAi = aiDecisions.find(d => d.symbol === symbol && d.timeframe === timeframe) || null;
      
      results.push({
        symbol,
        timeframe,
        systemDecision: signalSummary.systemDecision,
        latestAiDecision: latestAi,
      });
    } catch (err) {
      console.error(`[Scan All] Failed to scan ${symbol}:`, err.message);
    }
  }
  
  results.sort((a, b) => {
    const scoreA = Math.abs(a.systemDecision?.compositeScore || 0);
    const scoreB = Math.abs(b.systemDecision?.compositeScore || 0);
    return scoreB - scoreA;
  });
  
  res.json({ ok: true, results: results.map(completeForexRiskPlan), status });
});

// ─── Pullback Level & Timing Projections ─────────────────────────────────
// Deterministic math layer (no AI). Locates unmitigated OB/FVG pullback zones
// for the curated symbols and estimates time-to-reach via distance / ATR.
// Cached 60s. The AI layer is separate and ONLY runs on the /analyze route.
// GET /api/projections/scan?timeframe=M15&force=1
app.get('/api/projections/scan', (req, res) => {
  const timeframe = String(req.query.timeframe || 'M15').toUpperCase();
  const force = req.query.force === '1' || req.query.force === 'true';
  const status = getMt5Status();

  // Serve cached results (<=60s old) unless a force refresh is requested.
  const cached = projectionScanCache.get(timeframe);
  if (!force && cached && Date.now() - cached.at < 60000) {
    return res.json({ ok: true, timeframe, results: cached.results, generatedAt: new Date(cached.at).toISOString(), cached: true, status });
  }

  const symbols = getCuratedSymbols(status.symbols);
  const results = [];
  for (const symbol of symbols) {
    try {
      const candleList = getRecentCandles(symbol, timeframe, 300);
      if (!candleList || candleList.length < 20) continue;
      const latestCandle = candleList[candleList.length - 1];
      if (!isCandleCurrent(latestCandle, timeframe)) {
        results.push({ symbol, timeframe, currentPrice: Number(latestCandle?.close) || null, atr: 0, htfTrend: 'NEUTRAL', projections: [], outdated: true, note: 'Outdated telemetry — no live projection.' });
        continue;
      }
      const projection = computeProjections({
        symbol,
        timeframe,
        candles: candleList,
        h4Candles: getRecentCandles(symbol, 'H4', 150),
        h1Candles: getRecentCandles(symbol, 'H1', 150),
      });
      results.push({ ...projection, outdated: false });
    } catch (err) {
      console.error(`[Projections] Failed to project ${symbol} ${timeframe}:`, err.message);
    }
  }

  // Surface symbols with the soonest actionable pullback first.
  results.sort((a, b) => {
    const ma = a.projections?.[0]?.minutesToReach ?? Infinity;
    const mb = b.projections?.[0]?.minutesToReach ?? Infinity;
    return ma - mb;
  });

  projectionScanCache.set(timeframe, { results, at: Date.now() });
  res.json({ ok: true, timeframe, results, generatedAt: new Date().toISOString(), cached: false, status });
});

// POST /api/projections/analyze — on-demand Gemini validation for ONE symbol.
// Body: { symbol, timeframe }. Triggered only when the user enables
// "Run AI Projection". Recomputes the math zones, then asks Gemini to validate
// them against live structure, indicators, ADR and upcoming news.
app.post('/api/projections/analyze', async (req, res) => {
  const body = parseMt5Body(req.body);
  const symbol = String(body.symbol || '').toUpperCase();
  const timeframe = String(body.timeframe || 'M15').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol is required.' });

  try {
    const candleList = getRecentCandles(symbol, timeframe, 300);
    if (!candleList || candleList.length < 20) {
      return res.status(404).json({ error: 'Insufficient candle history for analysis.', symbol, timeframe });
    }
    const h4Candles = getRecentCandles(symbol, 'H4', 150);
    const h1Candles = getRecentCandles(symbol, 'H1', 150);

    const projection = computeProjections({ symbol, timeframe, candles: candleList, h4Candles, h1Candles });
    if (!projection.projections.length) {
      return res.json({ ok: true, symbol, timeframe, projection, ai: { available: false, validations: [], overall_summary: 'No unmitigated pullback zones to validate right now.' } });
    }

    // Build live context for the AI by reusing the signal engine's analysis.
    const { adr, dailyHighLow } = computeAdrDaily(symbol);
    const summary = aggregateSignals({
      symbol, timeframe, candles: candleList,
      indicators: getRecentIndicators(symbol, timeframe, 500),
      marketLevels, accountSnapshot: mt5State.accountSnapshot, adr, dailyHighLow,
      h4Candles, h1Candles,
    });
    const sd = summary.systemDecision || {};
    const context = {
      indicators: summary.indicatorsSnapshot || {},
      structure: sd.htfBias ? `HTF ${sd.htfBias}` : 'n/a',
      regime: sd.regime || 'n/a',
      adx: sd.adxValue ?? null,
      adrUsagePercent: sd.adrUsagePercent ?? null,
      adrExhausted: !!sd.adrExhausted,
      recentCandles: (summary.marketContext?.recentCandles || []).slice(-15).map((c) => ({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
      })),
    };

    const ai = await analyzeProjectionWithGemini({
      projectId: GOOGLE_CLOUD_PROJECT,
      location: GOOGLE_CLOUD_LOCATION,
      model: GEMINI_MODEL,
      symbol,
      timeframe,
      currentPrice: projection.currentPrice,
      atr: projection.atr,
      htfTrend: projection.htfTrend,
      projections: projection.projections,
      context,
    });

    res.json({ ok: true, symbol, timeframe, projection, ai, status: getMt5Status() });
  } catch (error) {
    console.error('[Projections] AI analysis failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// POST /api/projections/reminders
app.post('/api/projections/reminders', async (req, res) => {
  const body = parseMt5Body(req.body);
  const {
    projection_id, symbol, timeframe, bias,
    entryPrice, stopLoss, takeProfit1, takeProfit2,
    suitability, projectedTouchMs, email,
    mathConfidence, grade, rationale, ai_on
  } = body;

  if (!projection_id || !symbol || !timeframe || !bias || entryPrice === undefined || projectedTouchMs === undefined) {
    return res.status(400).json({ error: 'Missing required fields for reminder.' });
  }

  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });

  try {
    const recipientEmail = email || process.env.EMAIL_TO || process.env.SMTP_USER;
    if (!recipientEmail) {
      return res.status(400).json({ error: 'Recipient email not configured.' });
    }

    const reminderId = `rem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const projectedTouchTime = toMysqlDate(projectedTouchMs);

    await pool.execute(
      `INSERT INTO mt5_projection_reminders (
        id, projection_id, symbol, timeframe, bias, entry_price, stop_loss, take_profit_1, take_profit_2,
        suitability_forex, suitability_ftt, suitability_ftt_expiry, projected_touch_time, email,
        math_confidence, grade, rationale, ai_on, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [
        reminderId, projection_id, symbol, timeframe, bias, entryPrice, stopLoss, takeProfit1, takeProfit2,
        !!suitability?.forex, !!suitability?.ftt, suitability?.fttExpiry || null, projectedTouchTime, recipientEmail,
        mathConfidence, grade, rationale || null, !!ai_on, toMysqlDate()
      ]
    );

    res.json({ ok: true, reminderId });
  } catch (err) {
    console.error('[Reminders] Failed to schedule reminder:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projections/reminders/active
app.get('/api/projections/reminders/active', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });

  try {
    const [rows] = await pool.query(
      "SELECT id, projection_id FROM mt5_projection_reminders WHERE status IN ('PENDING', 'CHECKED')"
    );
    res.json({ ok: true, activeReminders: rows });
  } catch (err) {
    console.error('[Reminders] Failed to fetch active reminders:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projections/reminders/:id
app.delete('/api/projections/reminders/:id', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });

  try {
    await pool.execute("DELETE FROM mt5_projection_reminders WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Reminders] Failed to cancel reminder:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projections/saved
app.post('/api/projections/saved', async (req, res) => {
  const body = parseMt5Body(req.body);
  const {
    projection_id, symbol, timeframe, bias,
    entryPrice, stopLoss, takeProfit1, takeProfit2,
    suitability, projectedTouchMs,
    mathConfidence, grade, rationale
  } = body;

  if (!projection_id || !symbol || !timeframe || !bias || entryPrice === undefined || projectedTouchMs === undefined) {
    return res.status(400).json({ error: 'Missing required fields for saved projection.' });
  }

  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });

  try {
    const savedId = `save_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const projectedTouchTime = toMysqlDate(projectedTouchMs);

    await pool.execute(
      `INSERT INTO mt5_saved_projections (
        id, projection_id, symbol, timeframe, bias, entry_price, stop_loss, take_profit_1, take_profit_2,
        suitability_forex, suitability_ftt, suitability_ftt_expiry, projected_touch_time,
        math_confidence, grade, rationale, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [
        savedId, projection_id, symbol, timeframe, bias, entryPrice, stopLoss, takeProfit1, takeProfit2,
        !!suitability?.forex, !!suitability?.ftt, suitability?.fttExpiry || null, projectedTouchTime,
        mathConfidence, grade, rationale || null, toMysqlDate()
      ]
    );

    res.json({ ok: true, savedId });
  } catch (err) {
    console.error('[SavedProjections] Failed to save projection:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projections/saved
app.get('/api/projections/saved', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });

  try {
    const [rows] = await pool.query(
      "SELECT * FROM mt5_saved_projections ORDER BY created_at DESC"
    );
    res.json({ ok: true, savedProjections: rows });
  } catch (err) {
    console.error('[SavedProjections] Failed to fetch saved projections:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/projections/saved/:id/outcome
app.patch('/api/projections/saved/:id/outcome', async (req, res) => {
  const body = parseMt5Body(req.body);
  const outcome = String(body.outcome || 'PENDING').toUpperCase();

  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });

  try {
    await pool.execute(
      "UPDATE mt5_saved_projections SET status = ?, resolved_at = ? WHERE id = ?",
      [outcome, outcome === 'PENDING' ? null : toMysqlDate(), req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[SavedProjections] Failed to update outcome:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projections/saved/:id
app.delete('/api/projections/saved/:id', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });

  try {
    await pool.execute("DELETE FROM mt5_saved_projections WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[SavedProjections] Failed to delete saved projection:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projections/track-record
// Measured hit-rate of saved projections, by grade/timeframe/bias/confidence bucket.
// Honest probability from real settled outcomes (WIN/LOSS) — never a 100% claim.
app.get('/api/projections/track-record', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });
  try {
    const days = req.query.days ? Number(req.query.days) : 365;
    const rows = (await pool.query(
      'SELECT grade, timeframe, bias, math_confidence, status FROM mt5_saved_projections WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)',
      [Math.max(1, Math.min(days, 3650))],
    ))[0];

    const confBucket = (c) => {
      const n = Number(c);
      if (!Number.isFinite(n)) return 'unknown';
      if (n >= 90) return '90+';
      if (n >= 80) return '80-89';
      if (n >= 70) return '70-79';
      return '<70';
    };
    const empty = () => ({ total: 0, wins: 0, losses: 0, expired: 0, pending: 0 });
    const tally = (b, status) => {
      b.total += 1;
      const s = String(status || 'PENDING').toUpperCase();
      if (s === 'WIN') b.wins += 1;
      else if (s === 'LOSS') b.losses += 1;
      else if (s === 'EXPIRED') b.expired += 1;
      else b.pending += 1;
    };
    const finalize = (b) => {
      const settled = b.wins + b.losses;
      return {
        ...b,
        settled,
        hitRate: settled ? Math.round((b.wins / settled) * 1000) / 10 : null,
        confidence: sampleConfidence(settled),
      };
    };
    const dims = { grade: {}, timeframe: {}, bias: {}, confidenceBucket: {} };
    const overall = empty();
    for (const r of rows) {
      tally(overall, r.status);
      const keys = { grade: r.grade || 'unknown', timeframe: r.timeframe || 'unknown', bias: r.bias || 'unknown', confidenceBucket: confBucket(r.math_confidence) };
      for (const d of Object.keys(dims)) {
        const v = keys[d];
        (dims[d][v] ||= empty());
        tally(dims[d][v], r.status);
      }
    }
    const byDim = {};
    for (const d of Object.keys(dims)) {
      byDim[d] = Object.entries(dims[d])
        .map(([value, b]) => ({ value, ...finalize(b) }))
        .sort((a, b) => (b.settled - a.settled) || ((b.hitRate ?? -1) - (a.hitRate ?? -1)));
    }
    res.json({
      ok: true,
      days,
      overall: finalize(overall),
      byGrade: byDim.grade,
      byTimeframe: byDim.timeframe,
      byBias: byDim.bias,
      byConfidence: byDim.confidenceBucket,
      note: overall.wins + overall.losses < 20
        ? 'Thin sample — hit-rates are directional until more projections settle. No projection is ever guaranteed.'
        : 'Hit-rates are measured from settled outcomes (WIN/LOSS). Not a guarantee — markets carry irreducible uncertainty.',
    });
  } catch (err) {
    console.error('[Projections] track-record failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.get('/api/ai/decisions/:id', (req, res) => {
  const decision = aiDecisions.find((item) => item.id === req.params.id);
  if (!decision) return res.status(404).json({ error: 'AI decision not found.' });
  res.json({ decision, status: getMt5Status() });
});

app.patch('/api/ai/decisions/:id/outcome', async (req, res) => {
  const decision = aiDecisions.find((item) => item.id === req.params.id);
  if (!decision) return res.status(404).json({ error: 'AI decision not found.' });
  const body = parseMt5Body(req.body);
  decision.outcome = String(body.outcome || decision.outcome || 'PENDING').toUpperCase();
  decision.outcome_pips = parseMaybeNumber(body.outcomePips ?? body.outcome_pips);
  decision.expired_at = body.expiredAt || body.expired_at || decision.expired_at;
  await persistAiDecision(decision);
  sendStreamEvent('ai_decision', decision);
  res.json({ ok: true, decision, status: getMt5Status() });
});

app.get('/api/ai/accuracy', (req, res) => {
  const scored = aiDecisions.filter((decision) => ['WIN', 'LOSS', 'BREAKEVEN'].includes(decision.outcome));
  const wins = scored.filter((decision) => decision.outcome === 'WIN').length;
  const losses = scored.filter((decision) => decision.outcome === 'LOSS').length;
  const breakeven = scored.filter((decision) => decision.outcome === 'BREAKEVEN').length;
  res.json({
    total: scored.length,
    wins,
    losses,
    breakeven,
    pending: aiDecisions.filter((decision) => decision.outcome === 'PENDING').length,
    winRate: scored.length ? Math.round((wins / scored.length) * 100) : 0,
  });
});

app.get('/api/forex/stats', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const timeframe = req.query.timeframe ? String(req.query.timeframe).toUpperCase() : null;
  const days = req.query.days ? Number(req.query.days) : null;
  const filtered = aiDecisions.filter((decision) => {
    if (symbol && decision.symbol !== symbol) return false;
    if (timeframe && String(decision.timeframe).toUpperCase() !== timeframe) return false;
    if (!withinDays(decision.created_at, days)) return false;
    return true;
  });
  const stats = buildGroupedStats(
    filtered,
    ['symbol', 'timeframe', 'source', 'direction', 'confidenceBucket', 'grade', 'regime'],
    {
      confidence: (d) => d.confidence,
      pips: (d) => d.outcome_pips,
      outcome: (d) => d.outcome,
      dimension: (d, dim) => {
        if (dim === 'source') return 'ai';
        if (dim === 'direction') return d.decision;
        if (dim === 'confidenceBucket') return confidenceBucket(d.confidence);
        if (dim === 'grade') return d.system_decision?.grade || 'unknown';
        if (dim === 'regime') return d.system_decision?.regime || 'unknown';
        return d[dim];
      },
    }
  );
  res.json({ ok: true, type: 'forex', filters: { symbol, timeframe, days }, ...stats, status: getMt5Status() });
});

app.get('/api/reports/forex', async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const days = req.query.days ? Number(req.query.days) : null;
    const preset = req.query.preset ? String(req.query.preset) : null;
    const outcome = req.query.outcome ? String(req.query.outcome).toUpperCase() : null;
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const win = preset ? reportDateWindow({ preset }) : null;
    // Forex Outcomes tracks BOTH emailed and non-emailed forex setups, sourced from the
    // system signal log — but gated by the Forex Scanner toggle. Forex OFF → report is
    // intentionally empty ("if I turned off forex, do not report"); forex ON → read the
    // full log and report every forex signal's outcome (emailed flag preserved per row).
    const forexActive = loadEmailAlertSettings().forexScanner !== false;
    let reports = [];
    if (forexActive) {
      const { rows } = await querySystemSignalLog({ symbol, days: win ? null : days, from: win ? win.from : null, to: win ? win.to : null, outcome, limit: Math.min(Math.max(Number(limit) || 200, 1), 1000) });
      reports = rows.map((r) => ({
        id: r.id, signalType: 'forex', symbol: r.symbol, timeframe: r.timeframe, direction: r.direction,
        entryPrice: r.entryPrice, exitPrice: r.exitPrice, stopLoss: r.stopLoss, takeProfit1: r.takeProfit1,
        profitLossPips: r.profitLossPips, confidence: r.confidence, grade: r.grade, outcome: r.outcome,
        signalTime: r.signalTime, resolvedAt: r.resolvedAt, emailSentAt: null, emailed: r.emailed, alertDelaySeconds: null,
        payload: { ...(r.payload || {}), signalQuality: r.signalQuality, strategyType: r.strategyType },
      }));
    }
    const stats = buildGroupedStats(
      reports,
      ['symbol', 'timeframe', 'direction', 'grade', 'confidenceBucket'],
      {
        confidence: (r) => r.confidence,
        pips: (r) => r.profitLossPips,
        outcome: (r) => r.outcome,
        dimension: (r, dim) => {
          if (dim === 'direction') return r.direction;
          if (dim === 'confidenceBucket') return confidenceBucket(r.confidence);
          return r[dim];
        },
      }
    );
    const scored = stats.overall.wins + stats.overall.losses;
    res.json({
      ok: true,
      type: 'forex',
      reports,
      summary: {
        ...stats.overall,
        successRate: scored ? Math.round((stats.overall.wins / scored) * 100) : 0,
        failRate: scored ? Math.round((stats.overall.losses / scored) * 100) : 0,
        tp1Rate: stats.overall.tp1WinRate,
        tp2Rate: stats.overall.tp2WinRate,
        tp3Rate: stats.overall.tp3WinRate,
      },
      groups: stats.groups,
      filters: { symbol, days, outcome, limit },
      forexActive,
      window: win ? { label: win.label, from: win.fromIso, to: win.toIso, preset: win.preset } : null,
      status: getMt5Status(),
    });
  } catch (error) {
    console.error('[Reports] forex query failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// System signal log: every executable A/A+ forex setup (emailed or filtered),
// with auto-resolved outcomes. Summary splits emailed vs filtered win rates —
// the data answer to "is the email gate dropping winners?".
app.get('/api/reports/signal-log', async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const days = req.query.days ? Number(req.query.days) : 30;
    const preset = req.query.preset ? String(req.query.preset) : null;
    const grade = req.query.grade ? String(req.query.grade) : null;
    const outcome = req.query.outcome ? String(req.query.outcome).toUpperCase() : null;
    const limit = req.query.limit ? Number(req.query.limit) : 300;
    const emailed = req.query.emailed === 'true' ? true : req.query.emailed === 'false' ? false : null;
    const win = preset ? reportDateWindow({ preset }) : null;
    const { rows, summary } = await querySystemSignalLog({ symbol, days: win ? null : days, from: win ? win.from : null, to: win ? win.to : null, grade, outcome, limit, emailed });
    res.json({ ok: true, rows, summary, count: rows.length, window: win ? { label: win.label, from: win.fromIso, to: win.toIso, preset: win.preset } : null });
  } catch (error) {
    console.error('[Reports] signal-log failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Loss autopsy: win/loss + expectancy + MFE/MAE by feature category, with the
// worst-performing "loss clusters" surfaced. Read-only analysis of the signal log.
app.get('/api/reports/loss-autopsy', async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const days = req.query.days ? Number(req.query.days) : 90;
    const minSample = req.query.minSample ? Number(req.query.minSample) : 8;
    const result = await runLossAutopsy({ days, symbol, minSample });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Reports] loss-autopsy failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// MFE/MAE-driven SL/TP calibration: per-symbol excursion percentiles (in R) +
// advisory stop/target suggestions. Read-only — does not change live SL/TP.
app.get('/api/reports/sltp-calibration', async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const days = req.query.days ? Number(req.query.days) : 90;
    const minSample = req.query.minSample ? Number(req.query.minSample) : 8;
    const result = await runSlTpCalibration({ days, symbol, minSample });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Reports] sltp-calibration failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/fixed', async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const days = req.query.days ? Number(req.query.days) : null;
    const preset = req.query.preset ? String(req.query.preset) : null;
    const outcome = req.query.outcome ? String(req.query.outcome).toUpperCase() : null;
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const win = preset ? reportDateWindow({ preset }) : null;
    const reports = await querySignalEmailReports('fixed', { symbol, days: win ? null : days, from: win ? win.from : null, to: win ? win.to : null, outcome, limit });
    const stats = buildGroupedStats(
      reports,
      ['symbol', 'expiry', 'direction', 'grade', 'candleEntryTf'],
      {
        confidence: (r) => r.confidence,
        pips: (r) => r.profitLossPips,
        outcome: (r) => r.outcome,
        dimension: (r, dim) => {
          if (dim === 'candleEntryTf') return r.candleEntryTf || 'unknown';
          return r[dim];
        },
      }
    );
    const scored = stats.overall.wins + stats.overall.losses;
    res.json({
      ok: true,
      type: 'fixed',
      reports,
      summary: {
        ...stats.overall,
        successRate: scored ? Math.round((stats.overall.wins / scored) * 100) : 0,
        failRate: scored ? Math.round((stats.overall.losses / scored) * 100) : 0,
        tp1Rate: stats.overall.tp1WinRate,
        tp2Rate: stats.overall.tp2WinRate,
        tp3Rate: stats.overall.tp3WinRate,
      },
      groups: stats.groups,
      filters: { symbol, days, outcome, limit },
      window: win ? { label: win.label, from: win.fromIso, to: win.toIso, preset: win.preset } : null,
      status: getMt5Status(),
    });
  } catch (error) {
    console.error('[Reports] fixed query failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/calibration/:type', async (req, res) => {
  try {
    const type = String(req.params.type || '').toLowerCase();
    if (!['forex', 'fixed'].includes(type)) {
      return res.status(400).json({ error: 'type must be forex or fixed.' });
    }
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const days = req.query.days ? Number(req.query.days) : null;
    const limit = req.query.limit ? Number(req.query.limit) : 500;
    const reports = await querySignalEmailReports(type, { symbol, days, limit });
    const calibration = buildCalibrationReport(reports, type);
    res.json({
      ok: true,
      type,
      total: calibration.records,                  // all records (was the inflated "settled")
      records: calibration.records,
      winLossSettled: calibration.winLossSettled,  // the honest scored count (use this for headlines)
      settled: calibration.settled,                // win/loss/draw/breakeven (excludes EXPIRED/AMBIGUOUS)
      expired: calibration.expired,
      ambiguous: calibration.ambiguous,
      pending: calibration.pending,
      overall: calibration.overall,
      leaderboards: calibration.leaderboards,
      dimensions: calibration.dimensions,
      filters: { symbol, days, limit },
      status: getMt5Status(),
    });
  } catch (error) {
    console.error('[Reports] calibration query failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/backtest/forex', async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const days = req.query.days ? Number(req.query.days) : null;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const reports = await querySignalEmailReports('forex', { symbol, days, limit });
    const samples = [];
    const summary = {
      total: reports.length,
      valid: 0,
      settled: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      expired: 0,
      ambiguous: 0,
      tp1Wins: 0,
      tp2Wins: 0,
      tp3Wins: 0,
      tp1HitRate: 0,
      tp2HitRate: 0,
      tp3HitRate: 0,
      avgBarsToResolution: 0,
      avgMfePips: 0,
      avgMaePips: 0,
      netPips: 0,
      avgPips: 0,
      expectancyPips: 0,
      winRate: 0,
    };
    let barsSum = 0;
    let mfeSum = 0;
    let maeSum = 0;
    let pipsSum = 0;
    let settledSamples = 0;

    for (const report of reports) {
      const signalMs = Date.parse(report.signalTime || '');
      if (!Number.isFinite(signalMs)) continue;
      const endIso = new Date(signalMs + 72 * 3600 * 1000).toISOString();
      const candles = await getCandlesFromDbRange(report.symbol, report.timeframe, report.signalTime, endIso, 5000);
      const replay = evaluateForexReplay(report, candles);
      if (!replay.valid) continue;

      summary.valid += 1;
      if (replay.outcome === 'TP1_WIN' || replay.outcome === 'TP2_WIN' || replay.outcome === 'TP3_WIN' || replay.outcome === 'WIN') summary.wins += 1;
      else if (replay.outcome === 'LOSS') summary.losses += 1;
      else if (replay.outcome === 'BREAKEVEN' || replay.outcome === 'DRAW') summary.breakeven += 1;
      else if (replay.outcome === 'AMBIGUOUS') summary.ambiguous += 1;
      else if (replay.outcome === 'EXPIRED') summary.expired += 1;

      if (replay.tpHitLevel >= 1) summary.tp1Wins += 1;
      if (replay.tpHitLevel >= 2) summary.tp2Wins += 1;
      if (replay.tpHitLevel >= 3) summary.tp3Wins += 1;

      if (replay.outcome !== 'PENDING') {
        summary.settled += 1;
        settledSamples += 1;
        barsSum += Number(replay.barsToResolution) || 0;
        mfeSum += Number(replay.mfePips) || 0;
        maeSum += Number(replay.maePips) || 0;
        if (Number.isFinite(replay.profitLossPips)) pipsSum += Number(replay.profitLossPips);
      }

      if (samples.length < 20) {
        samples.push({
          id: report.id,
          symbol: report.symbol,
          timeframe: report.timeframe,
          direction: report.direction,
          outcome: replay.outcome,
          tpHitLevel: replay.tpHitLevel,
          entryPrice: report.entryPrice,
          exitPrice: replay.exitPrice,
          profitLossPips: replay.profitLossPips,
          mfePips: replay.mfePips,
          maePips: replay.maePips,
          barsToResolution: replay.barsToResolution,
          signalTime: report.signalTime,
          resolvedAt: replay.resolvedAt,
        });
      }
    }

    summary.tp1HitRate = summary.valid ? Math.round((summary.tp1Wins / summary.valid) * 100) : 0;
    summary.tp2HitRate = summary.valid ? Math.round((summary.tp2Wins / summary.valid) * 100) : 0;
    summary.tp3HitRate = summary.valid ? Math.round((summary.tp3Wins / summary.valid) * 100) : 0;
    summary.winRate = summary.settled ? Math.round((summary.wins / summary.settled) * 100) : 0;
    summary.avgBarsToResolution = settledSamples ? Math.round((barsSum / settledSamples) * 10) / 10 : 0;
    summary.avgMfePips = settledSamples ? Math.round((mfeSum / settledSamples) * 10) / 10 : 0;
    summary.avgMaePips = settledSamples ? Math.round((maeSum / settledSamples) * 10) / 10 : 0;
    summary.netPips = Math.round(pipsSum * 10) / 10;
    summary.avgPips = settledSamples ? Math.round((pipsSum / settledSamples) * 10) / 10 : 0;
    summary.expectancyPips = summary.avgPips;

    res.json({
      ok: true,
      type: 'forex',
      summary,
      samples,
      filters: { symbol, days, limit },
      status: getMt5Status(),
    });
  } catch (error) {
    console.error('[Reports] forex backtest query failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Phase 1: true signal-replay backtest from raw historical candles (not emailed
// reports). Generates and resolves every signal point-in-time, including ones the
// live gate would filter — so byGate.FILTERED_OUT reveals if we're too strict.
app.get('/api/reports/replay/forex', async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const timeframe = req.query.timeframe ? String(req.query.timeframe).toUpperCase() : null;
    if (!symbol || !timeframe) {
      return res.status(400).json({ error: 'symbol and timeframe are required, e.g. ?symbol=XAUUSD&timeframe=M15' });
    }
    const result = await runForexReplay(symbol, timeframe, {
      days: req.query.days,
      horizonHours: req.query.horizon,
      warmup: req.query.warmup,
      maxSignals: req.query.max,
      costPips: req.query.cost,
      split: req.query.split,
    });
    res.json(result);
  } catch (error) {
    console.error('[Reports] forex replay failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/rules', (req, res) => {
  res.json({ rules: signalRules });
});

app.post('/api/rules', async (req, res) => {
  const rule = normalizeSignalRule(req.body);
  if (!rule.id) rule.id = (Math.max(0, ...signalRules.map((item) => Number(item.id) || 0)) + 1);
  addSignalRule(rule);
  res.status(201).json({ ok: true, rule });
});

app.put('/api/rules/:id', async (req, res) => {
  const existing = signalRules.find((rule) => String(rule.id) === String(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Rule not found.' });
  const next = { ...existing, ...normalizeSignalRule({ ...req.body, id: req.params.id }), id: existing.id, updatedAt: new Date().toISOString() };
  addSignalRule(next);
  res.json({ ok: true, rule: next });
});

app.delete('/api/rules/:id', async (req, res) => {
  const index = signalRules.findIndex((rule) => String(rule.id) === String(req.params.id));
  if (index >= 0) signalRules.splice(index, 1);
  const pool = await initializeDatabase();
  if (pool) await pool.execute('DELETE FROM mt5_signal_rules WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/market-levels', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  res.json({ levels: marketLevels.filter((level) => !symbol || level.symbol === symbol) });
});

app.post('/api/market-levels', async (req, res) => {
  const level = normalizeMarketLevel(req.body);
  if (!level.price || !level.symbol || level.symbol === 'UNKNOWN') return res.status(400).json({ error: 'symbol and price are required.' });
  if (!level.id) level.id = (Math.max(0, ...marketLevels.map((item) => Number(item.id) || 0)) + 1);
  addMarketLevel(level);
  res.status(201).json({ ok: true, level });
});

app.get('/api/notifications/logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), MAX_SIGNALS);
  res.json({ logs: deliveryLogs.slice(0, limit) });
});

app.get('/api/notifications/email-settings', (req, res) => {
  res.json({
    ok: true,
    settings: loadEmailAlertSettings(),
    email_to: signalEmailTo(),
    news_email_to: NEWS_ALERT_EMAIL_TO,
    smtpConfigured: Boolean(process?.env?.SMTP_USER && process?.env?.SMTP_PASS),
  });
});

app.put('/api/notifications/email-settings', (req, res) => {
  try {
    const settings = saveEmailAlertSettings(req.body?.settings || req.body || {});
    res.json({ ok: true, settings });
  } catch (error) {
    console.error('[EmailSettings] Save failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Phase 6: read the calibration enforcement policy (mode + thresholds) per kind,
// alongside the effective resolved policy (after env overrides).
app.get('/api/calibration/policy', (req, res) => {
  const stored = loadCalibrationPolicy();
  res.json({
    ok: true,
    modes: CALIBRATION_MODES,
    stored,
    effective: { forex: resolveCalibrationPolicy('forex'), ftt: resolveCalibrationPolicy('ftt') },
  });
});

// Update the policy for one kind. Body: { kind: 'forex'|'ftt', mode, minWinRate,
// minSettled, negExpectancy, ultraMinSettled, ultraWinRateMargin, ultraMinProfitFactor }.
app.put('/api/calibration/policy', (req, res) => {
  try {
    const kind = String(req.body?.kind || '').toLowerCase() === 'ftt' ? 'ftt' : 'forex';
    const updated = saveCalibrationPolicy(kind, req.body || {});
    console.warn(`[CalibrationPolicy] ${kind} updated -> mode=${updated.mode} minWinRate=${updated.minWinRate} minSettled=${updated.minSettled} negExpectancy=${updated.negExpectancy}`);
    res.json({ ok: true, kind, policy: updated, effective: resolveCalibrationPolicy(kind) });
  } catch (error) {
    console.error('[CalibrationPolicy] Save failed:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/notifications/email', async (req, res) => {
  try {
    const to = req.body?.to || process?.env?.EMAIL_TO || process?.env?.SMTP_USER;
    const subject = req.body?.subject || 'Aura Gold Alert Test';
    const text = req.body?.text || 'This is a test email from Aura Gold Alerts.';
    const html = req.body?.html;

    if (!to) {
      return res.status(400).json({ error: 'Recipient email is required.' });
    }

    const info = await sendNotificationEmail({
      to,
      subject,
      text,
      html,
    });

    res.json({
      ok: true,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
    });
  } catch (error) {
    console.error('[Email Notification] Send failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Fixed-Time Trading (FTT) Helpers & Endpoints ───────────────────

function mapExpiryToTimeframe(expiry) {
  const exp = String(expiry || '5m').trim().toLowerCase();
  if (exp === '1m' || exp === '1min') return 'M1';
  if (exp === '2m' || exp === '2min' || exp === '3m' || exp === '3min' || exp === '5m' || exp === '5min') return 'M5';
  if (exp === '15m' || exp === '15min' || exp === '30m' || exp === '30min') return 'M15';
  if (exp === '1h' || exp === '1hr') return 'H1';
  return 'M5'; // fallback
}

function parseExpiryDuration(expiry) {
  const str = String(expiry || '5m').trim().toLowerCase();
  const match = str.match(/^(\d+)\s*(m|min|h|hr|s|sec)$/);
  if (!match) return 5 * 60 * 1000;
  const value = Number(match[1]);
  switch (match[2]) {
    case 's':
    case 'sec':
      return value * 1000;
    case 'm':
    case 'min':
      return value * 60 * 1000;
    case 'h':
    case 'hr':
      return value * 60 * 60 * 1000;
    default:
      return value * 60 * 1000;
  }
}

function getFttInputs(symbol, expiry) {
  const timeframe = mapExpiryToTimeframe(expiry);
  const candleList = getRecentCandles(symbol, timeframe, 200);
  
  const dailyCandles = getRecentCandles(symbol, 'D1', 20);
  let adr = null;
  let dailyHighLow = null;
  if (dailyCandles.length >= 14) {
    const dailyRanges = dailyCandles.slice(-14).map(c => {
      const h = Number(c.high);
      const l = Number(c.low);
      return (!isNaN(h) && !isNaN(l)) ? (h - l) : 0;
    }).filter(r => r > 0);
    if (dailyRanges.length >= 10) {
      adr = dailyRanges.reduce((sum, r) => sum + r, 0) / dailyRanges.length;
    }
  }
  const latestDailyCandle = dailyCandles[dailyCandles.length - 1];
  if (latestDailyCandle) {
    dailyHighLow = {
      high: Number(latestDailyCandle.high),
      low: Number(latestDailyCandle.low),
    };
  }
  
  return {
    timeframe,
    candles: candleList,
    indicators: getRecentIndicators(symbol, timeframe, 500),
    marketLevels,
    accountSnapshot: mt5State.accountSnapshot,
    adr,
    dailyHighLow
  };
}

// POST /api/ftt/predict — generate a single FTT prediction (system or AI)
app.post('/api/ftt/predict', async (req, res) => {
  const body = parseMt5Body(req.body);
  const symbol = String(body.symbol || 'XAUUSD').toUpperCase();
  const expiry = String(body.expiry || '5m');
  const source = String(body.source || 'system').toLowerCase();

  const inputs = getFttInputs(symbol, expiry);
  if (!inputs.candles || inputs.candles.length < 5) {
    return res.status(400).json({ error: `Insufficient candle data for symbol ${symbol}`, symbol });
  }

  const latestCandle = inputs.candles[inputs.candles.length - 1];
  if (!isCandleCurrent(latestCandle, inputs.timeframe)) {
    const formattedCandleTime = formatAppDateTime(latestCandle.time) || latestCandle.time;
    const formattedCurrentTime = formatAppDateTime(new Date()) || new Date().toISOString();
    return res.status(400).json({
      error: `Market data is outdated. Latest candle time: ${formattedCandleTime}. Current server time: ${formattedCurrentTime} (Asia/Dhaka). Please ensure MT5 is connected and updating.`,
      symbol
    });
  }

  try {
    const systemPrediction = generateFttPrediction({
      symbol,
      expiry,
      timeframe: inputs.timeframe,
      candles: inputs.candles,
      indicators: inputs.indicators,
      marketLevels: inputs.marketLevels,
      accountSnapshot: inputs.accountSnapshot,
      adr: inputs.adr,
      dailyHighLow: inputs.dailyHighLow,
      h4Candles: getRecentCandles(symbol, 'H4', 150),
      h1Candles: getRecentCandles(symbol, 'H1', 150),
    });

    let prediction;
    const now = new Date();
    const expiryMs = parseExpiryDuration(expiry);
    const expiryTime = new Date(now.getTime() + expiryMs);

    if (source === 'ai') {
      // Check rate limit: minimum 3 seconds between AI calls per symbol
      const lastCall = lastFttAiCallBySymbol.get(symbol) || 0;
      const nowMs = Date.now();
      if (nowMs - lastCall < 3000) {
        return res.status(429).json({ error: 'AI analysis rate limit exceeded. Minimum 3 seconds between calls.' });
      }
      lastFttAiCallBySymbol.set(symbol, nowMs);

      const prompt = buildFttAiPrompt({
        symbol,
        expiry,
        signalSummary: systemPrediction,
        recentCandles: inputs.candles
      });

      console.log(`[FTT AI] Requesting AI prediction for ${symbol} (${expiry})...`);
      const aiResult = await analyzeFttWithGemini({
        projectId: GOOGLE_CLOUD_PROJECT,
        location: GOOGLE_CLOUD_LOCATION,
        model: GEMINI_MODEL,
        prompt
      });

      prediction = {
        id: `ftt_ai_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        symbol,
        expiry,
        direction: aiResult.direction,
        confidence: aiResult.confidence,
        entryPrice: systemPrediction.entryPrice,
        entryTime: now.toISOString(),
        expiryTime: expiryTime.toISOString(),
        exitPrice: null,
        outcome: 'PENDING',
        source: 'ai',
        reasoning: aiResult.reasoning,
        indicators: systemPrediction.indicators,
        tradeStatus: fttTradeStatus(aiResult.direction, aiResult.confidence, systemPrediction.indicators),
        created_at: now.toISOString()
      };
    } else {
      prediction = {
        id: `ftt_sys_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        symbol,
        expiry,
        direction: systemPrediction.direction,
        confidence: systemPrediction.confidence,
        entryPrice: systemPrediction.entryPrice,
        entryTime: now.toISOString(),
        expiryTime: expiryTime.toISOString(),
        exitPrice: null,
        outcome: 'PENDING',
        source: 'system',
        reasoning: systemPrediction.reasoning,
        indicators: systemPrediction.indicators,
        tradeStatus: fttTradeStatus(systemPrediction.direction, systemPrediction.confidence, systemPrediction.indicators),
        created_at: now.toISOString()
      };
    }

    await persistFttPrediction(prediction);
    fttPredictions.unshift(prediction);
    sendStreamEvent('ftt_prediction', prediction);

    res.status(201).json({ ok: true, prediction, status: getMt5Status() });
  } catch (error) {
    console.error(`[FTT Predict] Failed to generate prediction for ${symbol}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/ftt/scan — scan all symbols for FTT opportunities
app.post('/api/ftt/scan', async (req, res) => {
  const body = parseMt5Body(req.body);
  const expiry = String(body.expiry || '5m');

  const status = getMt5Status();
  const requested = Array.isArray(body.symbols)
    ? body.symbols.map((s) => String(s).toUpperCase()).filter(Boolean)
    : null;

  // Serve the background daemon's cached FTT results instantly unless force-refreshed.
  if (body.force !== true) {
    const cached = fttScanCacheByExpiry.get(expiry);
    if (cached && Date.now() - cached.at < 90000) {
      const haveAll = !requested || requested.every((s) => cached.results.some((r) => r.symbol === s));
      if (haveAll) {
        const results = requested ? cached.results.filter((r) => requested.includes(r.symbol)) : cached.results;
        return res.json({ ok: true, results, status: getMt5Status(), cached: true });
      }
    }
  }

  const symbolsToScan = (requested && requested.length) ? requested : (status.symbols || []);
  const results = [];
  for (const symbol of symbolsToScan) {
    const inputs = getFttInputs(symbol, expiry);
    if (!inputs.candles || inputs.candles.length < 5) continue;

    const latestCandle = inputs.candles[inputs.candles.length - 1];
    if (!isCandleCurrent(latestCandle, inputs.timeframe)) {
      const latestAi = fttPredictions.find(
        p => p.symbol === symbol && p.expiry === expiry && p.source === 'ai'
      ) || null;
      
      const formattedCandleTime = formatAppDateTime(latestCandle.time) || latestCandle.time;
      const formattedCurrentTime = formatAppDateTime(new Date()) || new Date().toISOString();

      results.push({
        symbol,
        expiry,
        systemPrediction: {
          direction: 'HOLD',
          confidence: 20,
          entryPrice: latestCandle.close,
          reasoning: `Outdated telemetry. Latest candle time: ${formattedCandleTime}. Current server time: ${formattedCurrentTime} (Asia/Dhaka).`,
          indicators: {
            grade: 'No Setup (Outdated Telemetry)'
          },
          tradeStatus: 'WATCH_ONLY'
        },
        latestAiPrediction: latestAi
      });
      continue;
    }

    try {
      const pred = generateFttPrediction({
        symbol,
        expiry,
        timeframe: inputs.timeframe,
        candles: inputs.candles,
        indicators: inputs.indicators,
        marketLevels: inputs.marketLevels,
        accountSnapshot: inputs.accountSnapshot,
        adr: inputs.adr,
        dailyHighLow: inputs.dailyHighLow,
        h4Candles: getRecentCandles(symbol, 'H4', 150),
        h1Candles: getRecentCandles(symbol, 'H1', 150),
      });

      const latestAi = fttPredictions.find(
        p => p.symbol === symbol && p.expiry === expiry && p.source === 'ai'
      ) || null;

      results.push({
        symbol,
        expiry,
        systemPrediction: {
          direction: pred.direction,
          confidence: pred.confidence,
          entryPrice: pred.entryPrice,
          reasoning: pred.reasoning,
          indicators: pred.indicators,
          tradeStatus: fttTradeStatus(pred.direction, pred.confidence, pred.indicators)
        },
        latestAiPrediction: latestAi
      });
    } catch (err) {
      console.error(`[FTT Scan] Failed to scan ${symbol}:`, err.message);
    }
  }

  // Sort by system confidence level descending
  results.sort((a, b) => {
    const confA = a.systemPrediction?.confidence || 0;
    const confB = b.systemPrediction?.confidence || 0;
    return confB - confA;
  });

  res.json({ ok: true, results, status });
});

// GET /api/ftt/history — fetch prediction history
app.get('/api/ftt/history', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);

  const filtered = fttPredictions.filter(p => !symbol || p.symbol === symbol);
  // already sorted because we unshift and load ORDER BY created_at DESC
  res.json({ predictions: filtered.slice(0, limit), status: getMt5Status() });
});

app.get('/api/ftt/stats', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const expiry = req.query.expiry ? String(req.query.expiry) : null;
  const source = req.query.source ? String(req.query.source).toLowerCase() : null;
  const days = req.query.days ? Number(req.query.days) : null;
  const filtered = fttPredictions.filter((prediction) => {
    if (symbol && prediction.symbol !== symbol) return false;
    if (expiry && prediction.expiry !== expiry) return false;
    if (source && String(prediction.source).toLowerCase() !== source) return false;
    if (!withinDays(prediction.created_at, days)) return false;
    return true;
  });
  const stats = buildGroupedStats(
    filtered,
    ['symbol', 'expiry', 'source', 'direction', 'confidenceBucket', 'grade'],
    {
      confidence: (p) => p.confidence,
      outcome: (p) => p.outcome,
      dimension: (p, dim) => {
        if (dim === 'confidenceBucket') return confidenceBucket(p.confidence);
        if (dim === 'grade') return p.indicators?.grade || 'unknown';
        return p[dim];
      },
    }
  );
  res.json({ ok: true, type: 'fixed_time', filters: { symbol, expiry, source, days }, ...stats, status: getMt5Status() });
});

// Background outcome resolver for FTT predictions (checks every 10 seconds)
setInterval(async () => {
  const now = new Date();
  const pending = fttPredictions.filter(p => p.outcome === 'PENDING' && new Date(p.expiryTime) <= now);
  if (pending.length === 0) return;

  for (const prediction of pending) {
    const symbolCandles = candles.filter(c => c.symbol === prediction.symbol);
    if (symbolCandles.length === 0) {
      // If no candles exist at all for 5 minutes after expiry, mark it EXPIRED
      const fiveMinsAfterExpiry = new Date(new Date(prediction.expiryTime).getTime() + 5 * 60 * 1000);
      if (now > fiveMinsAfterExpiry) {
        prediction.outcome = 'EXPIRED';
        await persistFttPrediction(prediction);
        void syncFixedReportFromPrediction(prediction);
        sendStreamEvent('ftt_prediction', prediction);
      }
      continue;
    }

    const expiryMs = new Date(prediction.expiryTime).getTime();
    const expiryDurationMs = parseExpiryDuration(prediction.expiry);
    const toleranceMs = expiryDurationMs <= 5 * 60 * 1000
      ? Math.max(15 * 1000, Math.min(60 * 1000, expiryDurationMs * 0.25))
      : Math.min(3 * 60 * 1000, expiryDurationMs * 0.2);

    // Use the nearest M1 candle around expiry. The EA can post candles a second before
    // or after the nominal expiry, and requiring only post-expiry candles can falsely
    // expire otherwise scoreable fixed-time reports.
    const m1Candles = symbolCandles.filter(c => c.timeframe === 'M1');
    const candidates = (m1Candles.length > 0 ? m1Candles : symbolCandles)
      .filter((c) => {
        const t = new Date(c.time).getTime();
        return Number.isFinite(t) && Math.abs(t - expiryMs) <= toleranceMs;
      })
      .sort((a, b) => {
        const at = new Date(a.time).getTime();
        const bt = new Date(b.time).getTime();
        const ad = Math.abs(at - expiryMs);
        const bd = Math.abs(bt - expiryMs);
        if (ad !== bd) return ad - bd;
        return at - bt;
      });

    const closestCandle = candidates[0];

    if (!closestCandle) {
      const expireUnresolvedAt = new Date(expiryMs + toleranceMs + 2 * 60 * 1000);
      if (now > expireUnresolvedAt) {
        prediction.outcome = 'EXPIRED';
        await persistFttPrediction(prediction);
        void syncFixedReportFromPrediction(prediction);
        sendStreamEvent('ftt_prediction', prediction);
      }
      continue;
    }

    const currentPrice = closestCandle.close;

    if (currentPrice === null || currentPrice === undefined) continue;

    prediction.exitPrice = currentPrice;

    if (prediction.direction === 'HOLD') {
      // Noise-filter / no-setup predictions are not directional bets — do not
      // score them as WIN/LOSS, which would distort the FTT win-rate stats.
      prediction.outcome = 'NO_TRADE';
    } else if (currentPrice > prediction.entryPrice) {
      prediction.outcome = prediction.direction === 'UP' ? 'WIN' : 'LOSS';
    } else if (currentPrice < prediction.entryPrice) {
      prediction.outcome = prediction.direction === 'DOWN' ? 'WIN' : 'LOSS';
    } else {
      prediction.outcome = 'DRAW';
    }

    console.log(`[FTT Resolver] Resolved ${prediction.id} (${prediction.symbol}): Entry=${prediction.entryPrice}, Exit=${prediction.exitPrice} -> ${prediction.outcome}`);
    await persistFttPrediction(prediction);
    void syncFixedReportFromPrediction(prediction);
    sendStreamEvent('ftt_prediction', prediction);
  }
}, 10000);

const server = app.listen(PORT, API_BACKEND_HOST, () => {
  console.log(`Vertex AI Backend listening at http://localhost:${PORT}`);
});

void loadSignalCacheFromDatabase().catch((error) => {
  console.error('[MySQL] Failed to warm MT5 cache:', error.message);
});

// Start the Trading Economics fallback calendar poller (keeps a warm backup so the
// system keeps gating around news even when the MT5-native calendar is empty/stale).
startCalendarFallback();

// ─── High-impact news email alerts ──────────────────────────────────
function fmtLead(minutes) {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)} day`;
  if (minutes >= 60) return `${Math.round(minutes / 60)} hour`;
  return `${minutes} min`;
}

function buildNewsAlertEmail(event, bucket, minutesUntil) {
  const eventTime = new Date(event.timestampUtc).toUTCString();
  // Reaction scenarios for this event's affected symbols (open positions first).
  const all = buildNewsSignalsNow({ minImpact: 'LOW' });
  const related = all.filter((s) => s.event.id === event.id).slice(0, 6);

  const textLines = [
    `HIGH-IMPACT ECONOMIC NEWS ALERT (T-${fmtLead(bucket)})`,
    '',
    `Event:    ${event.title}`,
    `Currency: ${event.currency}   Impact: ${event.impact}`,
    `Time:     ${eventTime}  (in ~${minutesUntil} min)`,
    `Forecast: ${event.forecast ?? 'n/a'}   Previous: ${event.previous ?? 'n/a'}`,
    '',
    'AFFECTED INSTRUMENTS & REACTION PLAN:',
  ];
  for (const s of related) {
    textLines.push('');
    textLines.push(`• ${s.symbol}${s.hasPosition ? ` [OPEN ${s.positionSide}]` : ''}  | trend ${s.htfBias} | price ${s.price ?? 'n/a'}`);
    for (const sc of s.scenarios) textLines.push(`   - ${sc.trigger}: ${s.symbol} likely ${sc.pairDirection} (${sc.currencyEffect}). ${sc.note}`);
    textLines.push(`   ➜ ${s.recommendation}`);
  }
  textLines.push('');
  textLines.push('Pre-news rule: avoid fresh entries in the ±30m window; trade the post-release breakout with confirmation.');

  const rows = related.map((s) => `
    <div style="border:1px solid #eee;border-radius:10px;padding:12px;margin:8px 0">
      <div style="font-weight:700;color:#0f172a">${s.symbol} ${s.hasPosition ? `<span style="background:#fee2e2;color:#b91c1c;padding:2px 6px;border-radius:6px;font-size:11px">OPEN ${s.positionSide}</span>` : ''}
        <span style="color:#64748b;font-weight:500;font-size:12px">trend ${s.htfBias} · price ${s.price ?? 'n/a'}</span></div>
      ${s.scenarios.map((sc) => `<div style="font-size:13px;color:#334155;margin-top:4px">• <b>${sc.trigger}</b>: ${s.symbol} likely <b>${sc.pairDirection}</b> — ${sc.note}</div>`).join('')}
      <div style="font-size:12px;color:#475569;margin-top:6px;background:#f8fafc;padding:8px;border-radius:6px">${s.recommendation}</div>
    </div>`).join('');

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:680px">
      <h2 style="color:#b45309;margin:0 0 4px">⚠ High-Impact News — T-${fmtLead(bucket)}</h2>
      <p style="color:#0f172a;font-size:15px;margin:0 0 2px"><b>${event.title}</b> (${event.currency}, ${event.impact})</p>
      <p style="color:#64748b;font-size:13px;margin:0 0 12px">${eventTime} · in ~${minutesUntil} min · Forecast ${event.forecast ?? 'n/a'} · Previous ${event.previous ?? 'n/a'}</p>
      ${rows || '<p style="color:#64748b">No tracked instruments mapped to this event.</p>'}
      <p style="color:#94a3b8;font-size:12px;margin-top:12px">Avoid fresh entries in the ±30m window; trade the post-release breakout with confirmation. — Aura Gold News Engine</p>
    </div>`;

  return {
    subject: `⚠ [${event.impact}] ${event.currency} ${event.title} — T-${fmtLead(bucket)} (in ${minutesUntil}m)`,
    text: textLines.join('\n'),
    html,
  };
}

const NEWS_ALERTS_ENABLED = (process.env.NEWS_ALERTS_ENABLED ?? 'true') !== 'false';
const NEWS_ALERT_LEADS = String(process.env.NEWS_ALERT_LEADS || '1440,720,360,120,60,30,15,5')
  .split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const NEWS_ALERT_EMAIL_TO = process.env.NEWS_ALERT_EMAIL_TO || process.env.EMAIL_TO;

startNewsAlertScheduler({
  enabled: NEWS_ALERTS_ENABLED && Boolean(NEWS_ALERT_EMAIL_TO),
  leads: NEWS_ALERT_LEADS,
  minImpact: process.env.NEWS_ALERT_MIN_IMPACT || 'HIGH',
  onAlert: async (event, bucket, minutesUntil) => {
    if (!isEmailSystemEnabled('highImpactNews')) return;
    const { subject, text, html } = buildNewsAlertEmail(event, bucket, minutesUntil);
    await sendNotificationEmail({ to: NEWS_ALERT_EMAIL_TO, subject, text, html, signalId: `news:${event.id}:${bucket}` });
    console.log(`[NewsAlerts] Sent T-${bucket}m alert for ${event.currency} ${event.title} to ${NEWS_ALERT_EMAIL_TO}`);
  },
});

// ─── Background scanner daemon + signal email alerts ─────────────────
const scanCacheByTf = new Map();          // tf -> { results, at }
const fttScanCacheByExpiry = new Map();   // expiry -> { results, at }
const projectionScanCache = new Map();    // tf -> { results, at } (deterministic math only)
const topbarForexAlertBars = new Map();   // `${symbol}|${tf}` -> candle.time
const lastFttBar = new Map();             // `${symbol}|${expiry}` -> candle.time
const lastScannerAiBar = new Map();       // `${symbol}|${tf}` -> candle.time

const SCANNER_ENABLED = (process.env.SCANNER_ENABLED ?? 'true') !== 'false';
const SCANNER_INTERVAL_MS = Math.max(30000, Number(process.env.SCANNER_INTERVAL_MS || 60000));
const SCAN_TIMEFRAMES = String(process.env.SCANNER_TIMEFRAMES || 'M5,M15').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const FTT_EXPIRIES = String(process.env.SCANNER_FTT_EXPIRIES || '2m,3m,5m,15m,30m,1h').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SIGNAL_ALERTS_ENABLED = (process.env.SIGNAL_ALERTS_ENABLED ?? 'true') !== 'false';
const SIGNAL_ALERT_EMAIL_TO_ENV = process.env.SIGNAL_ALERT_EMAIL_TO || process.env.EMAIL_TO;
// Effective SIGNAL recipient(s), resolved at SEND time: the user-managed recipient list from
// the Notification Settings store (multiple addresses → one comma-joined nodemailer `to`),
// falling back to the single env address when the list is empty. Lets the user add/remove
// recipients from the UI with no env edit or restart. News reminders keep NEWS_ALERT_EMAIL_TO.
function signalEmailTo() {
  try {
    const list = (loadEmailAlertSettings().emailRecipients || []).filter(Boolean);
    if (list.length) return list.join(', ');
  } catch { /* settings store not ready (boot) — fall through to env */ }
  return SIGNAL_ALERT_EMAIL_TO_ENV || null;
}
// Per-recipient routing: like signalEmailTo(), but each recipient can restrict which
// SYMBOLS and TIMEFRAMES they receive (emailRecipientRules, keyed by address; empty
// list = everything). Returns only the recipients whose filters match this signal —
// or null when nobody wants it (the send is skipped). Sends without a symbol/tf
// context (tests, daily digests, health) keep using signalEmailTo() = everyone.
function signalEmailToFor(symbol = null, timeframe = null) {
  try {
    const s = loadEmailAlertSettings();
    const list = (s.emailRecipients || []).filter(Boolean);
    if (list.length) {
      const rules = s.emailRecipientRules || {};
      const sym = symbol ? String(symbol).toUpperCase() : null;
      const tf = timeframe ? String(timeframe).toUpperCase() : null;
      const matched = list.filter((e) => {
        const r = rules[String(e).toLowerCase()];
        if (!r) return true;
        if (sym && Array.isArray(r.symbols) && r.symbols.length && !r.symbols.includes(sym)) return false;
        if (tf && Array.isArray(r.timeframes) && r.timeframes.length && !r.timeframes.includes(tf)) return false;
        return true;
      });
      return matched.length ? matched.join(', ') : null;
    }
  } catch { /* settings store not ready (boot) — fall through to env */ }
  return SIGNAL_ALERT_EMAIL_TO_ENV || null;
}
const SIGNAL_ALERT_MIN_GAP_MS = Math.max(0, Number(process.env.SIGNAL_ALERT_MIN_GAP_MIN || 30)) * 60 * 1000;
const FOREX_M5_MAX_EMAIL_AGE_MS = Math.max(0, Number(process.env.FOREX_M5_MAX_EMAIL_AGE_SEC || 180)) * 1000;
const FOREX_M15_MAX_EMAIL_AGE_MS = Math.max(0, Number(process.env.FOREX_M15_MAX_EMAIL_AGE_SEC || 300)) * 1000;
const FOREX_DEFAULT_MAX_EMAIL_AGE_MS = Math.max(0, Number(process.env.FOREX_MAX_EMAIL_AGE_SEC || 240)) * 1000;
const FTT_SHORT_MAX_EMAIL_AGE_MS = Math.max(0, Number(process.env.FTT_SHORT_MAX_EMAIL_AGE_SEC || 30)) * 1000;
const FTT_LONG_MAX_EMAIL_AGE_MS = Math.max(0, Number(process.env.FTT_LONG_MAX_EMAIL_AGE_SEC || 60)) * 1000;
const FOREX_DAILY_BEST_EMAIL_ENABLED = (process.env.FOREX_DAILY_BEST_EMAIL_ENABLED ?? 'true') !== 'false';
const FOREX_DAILY_BEST_EMAIL_LIMIT = Math.max(1, Number(process.env.FOREX_DAILY_BEST_EMAIL_LIMIT || 5));
const FOREX_DAILY_BEST_EMAIL_UTC_HOUR = Math.max(0, Math.min(23, Number(process.env.FOREX_DAILY_BEST_EMAIL_UTC_HOUR || 23)));
const FTT_ALERT_MIN_CONFIDENCE = Number(process.env.FTT_ALERT_MIN_CONFIDENCE || 75);
const GRADE_RANK = { 'B SETUP': 1, 'A SETUP': 2, 'A+ SETUP': 3 };
const SIGNAL_ALERT_MIN_GRADE_RANK = GRADE_RANK[String(process.env.SIGNAL_ALERT_MIN_GRADE || 'B Setup').toUpperCase()] || 1;
const SIGNAL_QUALITY_RANK = { WATCH: 0, 'B SIGNAL': 1, 'A SIGNAL': 2, 'A+ SIGNAL': 3 };
const forexDailyBestCandidates = new Map();
let lastForexDailyBestEmailDate = null;
const alertDiagnostics = {
  skippedStale: 0,
  lastSkippedStale: null,
};

// USTEC (Nasdaq 100 CFD, broker symbol USTECm) is curated for DATA + forex-style
// signals only — its capabilities (approved TFs M5–H4, no fixed-time, no forecasts,
// USD news sensitivity, index point math) live in backend/instruments.js.
const CURATED_BASES = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURJPY', 'GBPJPY', 'USTEC'];
function getCuratedSymbols(allSymbols = []) {
  const set = new Set();
  for (const sym of allSymbols) {
    const base = String(sym).toUpperCase().replace(/[^A-Z]/g, '');
    if (CURATED_BASES.some((c) => base.startsWith(c))) set.add(sym);
  }
  return [...set];
}

function gradeRank(grade) {
  return GRADE_RANK[String(grade || '').toUpperCase()] || 0;
}

function signalQualityRank(quality) {
  return SIGNAL_QUALITY_RANK[String(quality || '').toUpperCase()] || 0;
}

const FOREX_MIN_GRADE_RANK = { B_SETUP: 1, A_SETUP: 2, A_PLUS_SETUP: 3 };
const FOREX_MIN_QUALITY_RANK = { B_SIGNAL: 1, A_SIGNAL: 2, A_PLUS_SIGNAL: 3 };
const NEWS_MIN_GRADE_RANK = { B_NEWS_SETUP: 1, A_NEWS_SETUP: 2, A_PLUS_NEWS_SETUP: 3 };
const FTT_TIER_RANK = { NO_TRADE: 0, WATCH_ONLY: 0, TRADE_SIGNAL: 1, QUALITY_SIGNAL: 2 };

function selectedRank(settingKey, rankMap, fallbackKey) {
  const value = String(loadEmailAlertSettings()[settingKey] || fallbackKey).toUpperCase();
  return rankMap[value] || rankMap[fallbackKey] || 0;
}

function newsGradeRank(grade) {
  const text = String(grade || '').toUpperCase();
  if (text.includes('A+')) return 3;
  if (text.includes('A')) return 2;
  if (text.includes('B')) return 1;
  return 0;
}

function fttTierAllowed(tier, settingKey) {
  const actualRank = FTT_TIER_RANK[String(tier || '').toUpperCase()] || 0;
  const minRank = selectedRank(settingKey, FTT_TIER_RANK, 'QUALITY_SIGNAL');
  return actualRank >= minRank && actualRank > 0;
}

function forexScannerEmailAllowed(systemDecision) {
  if (!systemDecision || systemDecision.decision === 'HOLD') return false;
  const minGradeRank = selectedRank('forexMinGrade', FOREX_MIN_GRADE_RANK, 'A_SETUP');
  const minQualityRank = selectedRank('forexMinQuality', FOREX_MIN_QUALITY_RANK, 'A_SIGNAL');
  return gradeRank(systemDecision.grade) >= minGradeRank && signalQualityRank(systemDecision.signalQuality) >= minQualityRank;
}

function isTopbarForexSignal(systemDecision) {
  if (!systemDecision || systemDecision.decision === 'HOLD') return false;
  return gradeRank(systemDecision.grade) >= gradeRank('A Setup') && Number(systemDecision.confidence || 0) >= 80;
}

function buildTopbarForexAlert(result) {
  const sd = result?.systemDecision || {};
  const risk = sd.riskPlan || {};
  return {
    id: `forex:${result.symbol}:${result.timeframe}:${result.bar}`,
    kind: 'FOREX',
    symbol: result.symbol,
    timeframe: result.timeframe,
    direction: sd.decision,
    grade: sd.grade || null,
    quality: sd.signalQuality || null,
    confidence: Math.round(Number(sd.confidence || 0)),
    entryPrice: sd.entryPrice ?? null,
    stopLoss: sd.stopLoss ?? null,
    takeProfit1: sd.takeProfit1 ?? null,
    takeProfit2: sd.takeProfit2 ?? null,
    takeProfit3: sd.takeProfit3 ?? null,
    investment: risk.marginRequired ?? risk.amountToInvestApprox ?? null,
    maxLoss: risk.lossAtStop ?? risk.maxLoss ?? risk.amountToRisk ?? risk.riskAmount ?? null,
    lotSize: risk.suggestedLotSize ?? null,
    tradeTime: result.bar || new Date().toISOString(),
    sessionReason: sd.sessionContext?.reason || null,
    createdAt: new Date().toISOString(),
  };
}

function postNewsForexEmailAllowed(signal) {
  const minRank = selectedRank('postNewsForexMinGrade', NEWS_MIN_GRADE_RANK, 'A_NEWS_SETUP');
  return newsGradeRank(signal?.grade) >= minRank;
}

// Phase 6: calibration policy store. Persists the enforcement mode + thresholds
// per kind so the gate can be tuned at runtime (via API) instead of only env.
// Four modes — kept deliberately conservative so nothing enforces by accident:
//   off     — gate disabled; always pass (no measurement applied)
//   observe — measure + log what it WOULD suppress, but always send (safe to watch)
//   enforce — suppress on win-rate-below-floor OR proven negative expectancy
//   ultra   — enforce + stricter: needs a larger sample, positive expectancy,
//             a profit factor >= floor, and a win-rate margin above the floor
// Resolution precedence per setting: persisted file > env var > built-in default.
// The DEFAULT mode is 'off' so live behaviour is unchanged until a real
// out-of-sample (OOS) verdict says the edge HOLDS — then flip to observe/enforce.
const CALIBRATION_POLICY_FILE = path.join(__dirname, '.cache', 'calibration_policy.json');
const CALIBRATION_MODES = ['off', 'observe', 'enforce', 'ultra'];
const DEFAULT_CALIBRATION_POLICY = {
  forex: { mode: 'off', minWinRate: 50, minSettled: 20, negExpectancy: -0.5, ultraMinSettled: 50, ultraWinRateMargin: 5, ultraMinProfitFactor: 1.2 },
  ftt: { mode: 'off', minWinRate: 55, minSettled: 20, negExpectancy: null, ultraMinSettled: 50, ultraWinRateMargin: 5, ultraMinProfitFactor: 1.2 },
};
let calibrationPolicyCache = null;

function loadCalibrationPolicy() {
  if (calibrationPolicyCache) return calibrationPolicyCache;
  let saved = {};
  try {
    if (fs.existsSync(CALIBRATION_POLICY_FILE)) {
      saved = JSON.parse(fs.readFileSync(CALIBRATION_POLICY_FILE, 'utf8')) || {};
    }
  } catch (err) {
    console.warn('[CalibrationPolicy] Failed to load policy:', err.message);
  }
  calibrationPolicyCache = {
    forex: { ...DEFAULT_CALIBRATION_POLICY.forex, ...(saved.forex || {}) },
    ftt: { ...DEFAULT_CALIBRATION_POLICY.ftt, ...(saved.ftt || {}) },
  };
  return calibrationPolicyCache;
}

function saveCalibrationPolicy(kind, patch) {
  const key = String(kind).toLowerCase() === 'ftt' ? 'ftt' : 'forex';
  const current = loadCalibrationPolicy();
  const next = { ...current[key] };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'mode')) {
    const mode = String(patch.mode).trim().toLowerCase();
    if (CALIBRATION_MODES.includes(mode)) next.mode = mode;
  }
  for (const numKey of ['minWinRate', 'minSettled', 'negExpectancy', 'ultraMinSettled', 'ultraWinRateMargin', 'ultraMinProfitFactor']) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, numKey)) {
      const v = patch[numKey];
      if (v === null) next[numKey] = null;
      else if (Number.isFinite(Number(v))) next[numKey] = Number(v);
    }
  }
  calibrationPolicyCache = { ...current, [key]: next };
  fs.mkdirSync(path.dirname(CALIBRATION_POLICY_FILE), { recursive: true });
  fs.writeFileSync(CALIBRATION_POLICY_FILE, JSON.stringify(calibrationPolicyCache, null, 2), 'utf8');
  return calibrationPolicyCache[key];
}

// Resolve the effective policy for a kind: persisted file, then env overrides,
// then defaults. Env kept for backward compat with the earlier shadow gate.
function resolveCalibrationPolicy(kind) {
  const prefix = String(kind).toUpperCase() === 'FTT' ? 'FTT' : 'FOREX';
  const key = prefix.toLowerCase();
  const base = loadCalibrationPolicy()[key];
  const policy = { ...base };

  // Backward-compat env mapping: legacy MIN_CALIBRATED_WINRATE / SHADOW vars.
  const legacyWinRate = Number(process.env[`${prefix}_MIN_CALIBRATED_WINRATE`]);
  if (Number.isFinite(legacyWinRate) && legacyWinRate > 0) policy.minWinRate = legacyWinRate;
  const legacySample = Number(process.env[`${prefix}_MIN_CALIBRATED_SAMPLE`]);
  if (Number.isFinite(legacySample) && legacySample > 0) policy.minSettled = legacySample;

  // Explicit mode env wins over everything else.
  const modeEnv = String(process.env[`${prefix}_CALIBRATION_MODE`] || '').trim().toLowerCase();
  if (CALIBRATION_MODES.includes(modeEnv)) {
    policy.mode = modeEnv;
  } else if (base.mode === 'off' && Number.isFinite(legacyWinRate) && legacyWinRate > 0) {
    // No persisted/env mode, but legacy gate vars are set: honour them. The old
    // SHADOW flag (default true) maps to observe; SHADOW=false maps to enforce.
    const shadowRaw = process.env[`${prefix}_CALIBRATION_SHADOW`];
    const shadow = shadowRaw === undefined || shadowRaw === ''
      ? true
      : ['1', 'true', 'yes', 'on'].includes(String(shadowRaw).trim().toLowerCase());
    policy.mode = shadow ? 'observe' : 'enforce';
  }
  return policy;
}

// Gate alerts on the measured performance of comparable past signals, not just
// the heuristic grade. Fails OPEN on thin/unreliable data — a category is only
// suppressed when there is enough settled history to trust. Returns one of:
//   pass    — send (gate satisfied or evidence too thin to act)
//   shadow  — would suppress, but mode is 'observe' so send anyway (logged)
//   suppress — block the alert (enforce/ultra modes only)
function calibrationGateDecision(kind, calibration) {
  const policy = resolveCalibrationPolicy(kind);
  if (policy.mode === 'off') return { action: 'pass', reason: 'gate disabled (mode=off)', mode: 'off' };

  const minWinRate = Number(policy.minWinRate) || 0;
  const ultra = policy.mode === 'ultra';
  const minSettled = ultra
    ? (Number.isFinite(policy.ultraMinSettled) && policy.ultraMinSettled > 0 ? policy.ultraMinSettled : 50)
    : (Number.isFinite(policy.minSettled) && policy.minSettled > 0 ? policy.minSettled : 20);
  const settled = Number(calibration?.settled || 0);
  const winRate = calibration?.winRate;
  const expectancy = calibration?.expectancy; // forex: avg pips per trade (null for FTT)
  const profitFactor = calibration?.profitFactor;
  const bucket = calibration?.bucket || 'none';

  // Never block on weak evidence: missing rate, too few settled, or a loosely
  // matched bucket all fail open.
  if (winRate === null || winRate === undefined || settled < minSettled || bucket === 'fallback' || bucket === 'none') {
    return { action: 'pass', reason: `insufficient evidence (winRate=${winRate ?? 'n/a'}, settled=${settled}/${minSettled}, bucket=${bucket})`, mode: policy.mode };
  }

  // The verdict: a category fails if its measured win rate is below the floor,
  // or — even with an acceptable win rate — it loses money on average (a few big
  // losers can sink a high-hit-rate category). Negative-expectancy is a forex-only
  // check (FTT has no per-trade pip P/L) and only fires with a real sample.
  const effectiveFloor = ultra ? minWinRate + (Number(policy.ultraWinRateMargin) || 0) : minWinRate;
  const failReasons = [];
  if (winRate < effectiveFloor) failReasons.push(`winRate ${winRate}% < ${effectiveFloor}%`);
  const negThreshold = policy.negExpectancy;
  if (Number.isFinite(expectancy) && Number.isFinite(negThreshold) && expectancy < negThreshold) {
    failReasons.push(`negative expectancy ${expectancy} pips < ${negThreshold}`);
  }
  if (ultra) {
    // Ultra-selective: also require positive expectancy (when measured) and a
    // profit factor above the floor.
    if (Number.isFinite(expectancy) && expectancy <= 0) failReasons.push(`expectancy ${expectancy} pips not positive`);
    const pfFloor = Number(policy.ultraMinProfitFactor);
    if (Number.isFinite(profitFactor) && Number.isFinite(pfFloor) && profitFactor < pfFloor) {
      failReasons.push(`profitFactor ${profitFactor} < ${pfFloor}`);
    }
  }

  if (failReasons.length === 0) {
    return { action: 'pass', reason: `OK (winRate ${winRate}%, settled ${settled}, ${bucket}${Number.isFinite(expectancy) ? `, exp ${expectancy}p` : ''})`, mode: policy.mode };
  }
  const reason = `${failReasons.join('; ')} (settled ${settled}, ${bucket})`;
  return { action: policy.mode === 'observe' ? 'shadow' : 'suppress', reason, mode: policy.mode };
}

// Pull the displayed confidence toward the empirically measured win rate of
// comparable past signals, weighted by how much settled history backs the
// estimate. The heuristic score always retains majority weight (cap 0.6) and
// the raw value is preserved/shown so nothing is hidden. Fails open (returns
// the raw score unchanged) on thin/unreliable evidence. Disable with
// CALIBRATION_BLEND=false; tune the floor with CALIBRATION_BLEND_MIN_SAMPLE.
function blendCalibratedConfidence(rawConfidence, calibration) {
  const raw = Number(rawConfidence);
  const passthrough = { value: Number.isFinite(raw) ? Math.round(raw) : rawConfidence, raw: Number.isFinite(raw) ? Math.round(raw) : null, adjusted: false, weight: 0, note: null };
  if (!Number.isFinite(raw)) return passthrough;
  const enabledRaw = process.env.CALIBRATION_BLEND;
  const enabled = enabledRaw === undefined || enabledRaw === ''
    ? true
    : ['1', 'true', 'yes', 'on'].includes(String(enabledRaw).trim().toLowerCase());
  if (!enabled) return passthrough;
  const sampleRaw = Number(process.env.CALIBRATION_BLEND_MIN_SAMPLE);
  const minSettled = Number.isFinite(sampleRaw) && sampleRaw > 0 ? sampleRaw : 10;
  const settled = Number(calibration?.settled || 0);
  const winRate = calibration?.winRate;
  const bucket = calibration?.bucket || 'none';
  if (winRate === null || winRate === undefined || settled < minSettled || bucket === 'fallback' || bucket === 'none') {
    return passthrough;
  }
  const K = 30; // sample size at which the measured rate earns ~half its capped weight
  const weight = Math.min(0.6, settled / (settled + K));
  const blended = raw * (1 - weight) + Number(winRate) * weight;
  const value = Math.round(blended);
  return {
    value,
    raw: Math.round(raw),
    adjusted: true,
    weight: Math.round(weight * 100) / 100,
    note: `Calibrated confidence ${value}/100 (raw ${Math.round(raw)} blended ${Math.round(weight * 100)}% toward measured ${winRate}% over ${settled} settled, ${bucket})`,
  };
}

function forexCandidateRank(result) {
  const sd = result?.systemDecision || {};
  const datScore = Number(sd.datFramework?.score || 0);
  const rr = Number(sd.riskRewardRatio || 0);
  return signalQualityRank(sd.signalQuality) * 100000 + Number(sd.confidence || 0) * 1000 + datScore * 100 + Math.min(rr, 5) * 10;
}

function computeAdrDaily(symbol) {
  const dailyCandles = getRecentCandles(symbol, 'D1', 20);
  let adr = null;
  let dailyHighLow = null;
  if (dailyCandles.length >= 14) {
    const ranges = dailyCandles.slice(-14).map((c) => {
      const h = Number(c.high); const l = Number(c.low);
      return (!isNaN(h) && !isNaN(l)) ? (h - l) : 0;
    }).filter((r) => r > 0);
    if (ranges.length >= 10) adr = ranges.reduce((s, r) => s + r, 0) / ranges.length;
  }
  const last = dailyCandles[dailyCandles.length - 1];
  if (last) dailyHighLow = { high: Number(last.high), low: Number(last.low) };
  return { adr, dailyHighLow };
}

function scanForexSymbol(symbol, timeframe) {
  const candleList = getRecentCandles(symbol, timeframe, 200);
  if (!candleList || candleList.length < 20) return null;
  const latestCandle = candleList[candleList.length - 1];
  if (!isCandleCurrent(latestCandle, timeframe)) {
    return {
      symbol, timeframe, outdated: true, bar: latestCandle?.time || null,
      sourceReceivedAt: latestCandle?.receivedAt || latestCandle?.raw?.receivedAt || null,
      systemDecision: { decision: 'HOLD', confidence: 0, compositeScore: 0, grade: 'No Setup (Outdated Telemetry)', confluences: [], buyScore: 0, sellScore: 0 },
      latestAiDecision: aiDecisions.find((d) => d.symbol === symbol && d.timeframe === timeframe) || null,
    };
  }
  const { adr, dailyHighLow } = computeAdrDaily(symbol);
  const summary = aggregateSignals({
    symbol, timeframe, candles: candleList,
    indicators: getRecentIndicators(symbol, timeframe, 500),
    marketLevels, accountSnapshot: mt5State.accountSnapshot, adr, dailyHighLow,
    h4Candles: getRecentCandles(symbol, 'H4', 150),
    h1Candles: getRecentCandles(symbol, 'H1', 150),
  });
  return {
    symbol, timeframe, bar: latestCandle.time, outdated: false,
    sourceReceivedAt: latestCandle.receivedAt || latestCandle.raw?.receivedAt || null,
    systemDecision: summary.systemDecision,
    latestAiDecision: aiDecisions.find((d) => d.symbol === symbol && d.timeframe === timeframe) || null,
  };
}

function digitsFor(symbol) {
  const s = String(symbol).toUpperCase();
  const caps = symbolCapsFor(s);
  if (caps?.digits != null) return caps.digits;        // index CFDs: 2 (e.g. 22150.50)
  return /XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
}
function px(v, symbol) { return (v === null || v === undefined) ? 'n/a' : Number(v).toFixed(digitsFor(symbol)); }
function px2(v) { return (v === null || v === undefined || !Number.isFinite(Number(v))) ? 'n/a' : `$${Number(v).toFixed(2)}`; }

function setupLabel(grade) {
  const text = String(grade || '').trim();
  if (!text) return 'SETUP';
  const match = text.match(/^(A\+|A|B)\s+Setup/i);
  if (match) return `${match[1].toUpperCase()} SETUP`;
  return text.toUpperCase();
}

function fttSetupLabel(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return 'WATCH ONLY';
  if (c >= 90) return 'A+ SETUP';
  if (c >= 80) return 'A SETUP';
  if (c >= 75) return 'B SETUP';
  return 'WATCH ONLY';
}

function fttReportGrade(prediction) {
  return fttSetupLabel(prediction?.confidence).replace(' SETUP', ' Setup');
}

function fttTradeStatus(direction, confidence, indicators = null) {
  const c = Number(confidence);
  const tier = indicators?.qualityTier;
  if (tier === 'QUALITY_SIGNAL') return 'QUALITY_SIGNAL';
  if (tier === 'NO_TRADE') return 'NO_TRADE';
  if (tier === 'WATCH_ONLY') return 'WATCH_ONLY';
  if (direction === 'HOLD' || !Number.isFinite(c) || c < FTT_ALERT_MIN_CONFIDENCE) return 'WATCH_ONLY';
  return 'TRADE_SIGNAL';
}

function fttEmailAllowed(prediction) {
  const isPostNewsFixed = prediction?.source === 'news';
  const settingKey = isPostNewsFixed ? 'postNewsFixedMinTier' : 'fixedTimeMinTier';
  return fttTierAllowed(prediction?.indicators?.qualityTier, settingKey);
}

function forexMaxEmailAgeMs(timeframe) {
  const tf = String(timeframe || '').toUpperCase();
  if (tf === 'M5') return FOREX_M5_MAX_EMAIL_AGE_MS;
  if (tf === 'M15') return FOREX_M15_MAX_EMAIL_AGE_MS;
  return FOREX_DEFAULT_MAX_EMAIL_AGE_MS;
}

function fttMaxEmailAgeMs(expiry) {
  const durationMs = parseExpiryDuration(expiry);
  return durationMs <= 5 * 60 * 1000 ? FTT_SHORT_MAX_EMAIL_AGE_MS : FTT_LONG_MAX_EMAIL_AGE_MS;
}

function emailAgeMs(referenceTime) {
  const ms = Date.parse(referenceTime || '');
  if (!Number.isFinite(ms)) return null;
  return Date.now() - ms;
}

function recordSkippedAlert({ type, symbol, timeframe, expiry, reason, ageMs, maxAgeMs, signalId }) {
  const detail = {
    type,
    symbol,
    timeframe: timeframe || null,
    expiry: expiry || null,
    reason,
    ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
    maxAgeSeconds: Number.isFinite(maxAgeMs) ? Math.round(maxAgeMs / 1000) : null,
  };
  alertDiagnostics.skippedStale += reason === 'STALE' ? 1 : 0;
  alertDiagnostics.lastSkippedStale = { ...detail, at: new Date().toISOString() };
  addDeliveryLog({
    channel: 'Email',
    recipient: signalEmailTo() || null,
    signalId: signalId || null,
    status: `Skipped ${reason}`,
    error: `${type} ${symbol}${timeframe ? ` ${timeframe}` : ''}${expiry ? ` ${expiry}` : ''}: ${reason}${detail.ageSeconds !== null ? ` (${detail.ageSeconds}s > ${detail.maxAgeSeconds}s)` : ''}`,
  });
}

// Shadow-mode tracking: when the calibration gate is in 'observe', it would suppress
// some alerts but sends them anyway. We record those "would-suppress" events so they
// can be watched (per-bucket) BEFORE flipping the gate to 'enforce'. In-memory ring
// buffer (no DB bloat); also surfaced in delivery logs for the existing UI.
const recentWouldSuppress = [];
const wouldSuppressCounts = new Map(); // `${type}|${symbol}` -> count
function recordWouldSuppress({ type, symbol, timeframe = null, expiry = null, reason = null, calibration = null }) {
  const entry = {
    type, symbol, timeframe, expiry, reason,
    bucket: calibration?.bucket ?? null,
    winRate: calibration?.winRate ?? null,
    settled: calibration?.settled ?? null,
    expectancy: calibration?.expectancy ?? null,
    at: new Date().toISOString(),
  };
  recentWouldSuppress.unshift(entry);
  if (recentWouldSuppress.length > 200) recentWouldSuppress.length = 200;
  const key = `${type}|${symbol}`;
  wouldSuppressCounts.set(key, (wouldSuppressCounts.get(key) || 0) + 1);
  addDeliveryLog({
    channel: 'Email', recipient: signalEmailTo() || null, signalId: null,
    status: 'Would-suppress (shadow)',
    error: `${type} ${symbol}${timeframe ? ` ${timeframe}` : ''}${expiry ? ` ${expiry}` : ''}: ${reason}`,
  });
}

// GET /api/reports/would-suppress — what the calibration gate WOULD block under
// 'enforce' (nothing is actually blocked while in observe/shadow). Watch before enforcing.
app.get('/api/reports/would-suppress', (req, res) => {
  const summary = [...wouldSuppressCounts.entries()]
    .map(([k, count]) => { const [type, symbol] = k.split('|'); return { type, symbol, count }; })
    .sort((a, b) => b.count - a.count);
  res.json({
    ok: true,
    mode: { forex: resolveCalibrationPolicy('forex').mode, ftt: resolveCalibrationPolicy('ftt').mode },
    summary,
    recent: recentWouldSuppress.slice(0, 100),
    note: 'Signals the calibration gate WOULD suppress under enforce mode. In observe/shadow nothing is blocked — these were still sent. Watch this (and the per-bucket calibration) before flipping to enforce. Counts reset on backend restart.',
  });
});

function shouldSkipStaleForexAlert(result) {
  const maxAgeMs = forexMaxEmailAgeMs(result?.timeframe);
  if (!maxAgeMs) return null;
  const referenceTime = result?.sourceReceivedAt || result?.bar;
  const ageMs = emailAgeMs(referenceTime);
  if (ageMs === null || ageMs <= maxAgeMs) return null;
  return { ageMs, maxAgeMs, referenceTime };
}

function shouldSkipStaleFttAlert(prediction) {
  const maxAgeMs = fttMaxEmailAgeMs(prediction?.expiry);
  if (!maxAgeMs) return null;
  const referenceTime = prediction?.sourceReceivedAt || prediction?.sourceBarTime || prediction?.entryTime;
  const ageMs = emailAgeMs(referenceTime);
  if (ageMs === null || ageMs <= maxAgeMs) return null;
  return { ageMs, maxAgeMs, referenceTime };
}

function expirySubjectLabel(expiry) {
  return String(expiry || '').trim().toUpperCase();
}

function confidenceBucket(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return 'unknown';
  if (c >= 90) return '90-100';
  if (c >= 80) return '80-89';
  if (c >= 70) return '70-79';
  if (c >= 60) return '60-69';
  if (c >= 50) return '50-59';
  return '<50';
}

function sessionBucket(value) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return 'unknown';
  const hour = new Date(ms).getUTCHours();
  if (hour >= 0 && hour < 6) return 'Asia';
  if (hour >= 6 && hour < 12) return 'Europe';
  if (hour >= 12 && hour < 18) return 'New York';
  return 'Late US';
}

function reportPatternBucket(report) {
  const payload = report?.payload || {};
  const patterns = payload.detectedPatterns || payload.candlePatterns || [];
  if (!Array.isArray(patterns) || !patterns.length) return 'unknown';
  const first = patterns[0];
  if (typeof first === 'string') return first;
  return first?.name || 'unknown';
}

function reportStrategyBucket(report) {
  return report?.payload?.strategyType || report?.payload?.source || 'unknown';
}

function reportQualityBucket(report) {
  return report?.payload?.signalQuality || report?.payload?.qualityTier || 'unknown';
}

function reportVolatilityBucket(report) {
  return report?.payload?.volatilityState || 'unknown';
}

function reportIchimokuBucket(report) {
  return report?.payload?.ichimokuState || 'unknown';
}

function reportSessionBucket(report) {
  return report?.payload?.sessionContext?.reason || sessionBucket(report?.signalTime || report?.emailSentAt);
}

// Phase 5: statistical-trust label for a bucket, by settled-trade count. Every
// downstream consumer (dashboard, enforcement, auto-disable) keys off this so it
// never acts on a number backed by too little history.
//   <30 weak | 30–99 early | 100–299 usable | 300+ strong
function sampleConfidence(settled) {
  const n = Number(settled) || 0;
  if (n >= 300) return 'strong';
  if (n >= 100) return 'usable';
  if (n >= 30) return 'early';
  return 'weak';
}

function buildCalibrationReport(items, signalType) {
  const settledItems = items.filter((item) => String(item?.outcome || '').toUpperCase() !== 'PENDING');
  const pending = items.length - settledItems.length;
  const dimensions = signalType === 'forex'
    ? ['grade', 'symbol', 'timeframe', 'strategyType', 'signalQuality', 'session', 'volatilityState', 'pattern', 'confidenceBucket']
    : ['grade', 'symbol', 'expiry', 'strategyType', 'qualityTier', 'session', 'volatilityState', 'ichimokuState', 'pattern', 'confidenceBucket'];

  const stats = buildGroupedStats(settledItems, dimensions, {
    confidence: (r) => r.confidence,
    pips: (r) => r.signalType === 'forex' ? r.profitLossPips : null,
    outcome: (r) => r.outcome,
    dimension: (r, dim) => {
      if (dim === 'strategyType') return reportStrategyBucket(r);
      if (dim === 'signalQuality') return reportQualityBucket(r);
      if (dim === 'qualityTier') return reportQualityBucket(r);
      if (dim === 'session') return reportSessionBucket(r);
      if (dim === 'volatilityState') return reportVolatilityBucket(r);
      if (dim === 'ichimokuState') return reportIchimokuBucket(r);
      if (dim === 'pattern') return reportPatternBucket(r);
      if (dim === 'confidenceBucket') return confidenceBucket(r.confidence);
      if (dim === 'timeframe') return r.timeframe || 'unknown';
      if (dim === 'expiry') return r.expiry || 'unknown';
      return r[dim] || 'unknown';
    },
  });

  const leaderboard = Object.fromEntries(
    Object.entries(stats.groups).map(([dim, groups]) => [
      dim,
      Object.entries(groups)
        .map(([value, summary]) => ({ value, ...summary, confidence: sampleConfidence(summary.settled) }))
        .sort((a, b) => (b.winRate - a.winRate) || (b.settled - a.settled) || (b.total - a.total))
        .slice(0, 10),
    ])
  );

  return {
    overall: { ...stats.overall, confidence: sampleConfidence(stats.overall.settled) },
    leaderboards: leaderboard,
    dimensions,
    records: items.length,                               // every signal in the window
    winLossSettled: stats.overall.wins + stats.overall.losses, // the real scored evidence
    settled: stats.overall.settled,                     // win/loss/draw/breakeven — NOT expired/ambiguous
    expired: stats.overall.expired,
    ambiguous: stats.overall.ambiguous,
    pending,
  };
}

function reportStrategyTags(report) {
  const tags = [];
  const payload = report?.payload || {};
  if (Array.isArray(payload.strategyTags)) tags.push(...payload.strategyTags.map((tag) => String(tag).trim().toUpperCase()).filter(Boolean));
  if (payload.strategyType) tags.push(String(payload.strategyType).trim().toUpperCase());
  if (payload.source) tags.push(String(payload.source).trim().toUpperCase());
  return [...new Set(tags)];
}

function reportPatternNames(report) {
  const payload = report?.payload || {};
  const patterns = Array.isArray(payload.detectedPatterns) ? payload.detectedPatterns : Array.isArray(payload.candlePatterns) ? payload.candlePatterns : [];
  return patterns.map((pattern) => {
    if (typeof pattern === 'string') return pattern.trim().toUpperCase();
    return String(pattern?.name || '').trim().toUpperCase();
  }).filter(Boolean);
}

function reportTradeSession(report) {
  const payload = report?.payload || {};
  if (payload.sessionContext?.reason) return String(payload.sessionContext.reason).trim().toUpperCase();
  return sessionBucket(report?.signalTime || report?.emailSentAt).toUpperCase();
}

function reportTradeRegime(report) {
  const payload = report?.payload || {};
  return String(payload.volatilityState || payload.ichimokuState || 'unknown').trim().toUpperCase();
}

function reportTradeQuality(report) {
  const payload = report?.payload || {};
  return String(payload.signalQuality || payload.qualityTier || report?.grade || 'unknown').trim().toUpperCase();
}

function calibrationMatchScore(report, candidate, signalType) {
  let score = 0;
  const reportTags = reportStrategyTags(report);
  const candidateTags = candidate.strategyTags || [];
  const reportPatterns = reportPatternNames(report);
  const candidatePatterns = candidate.patternNames || [];

  if (String(report.symbol || '').toUpperCase() === String(candidate.symbol || '').toUpperCase()) score += 4;
  if (signalType === 'forex' && String(report.timeframe || '').toUpperCase() === String(candidate.timeframe || '').toUpperCase()) score += 4;
  if (signalType === 'fixed' && String(report.expiry || '').toLowerCase() === String(candidate.expiry || '').toLowerCase()) score += 4;
  if (String(report.grade || '').toUpperCase() === String(candidate.grade || '').toUpperCase()) score += 3;
  if (reportTradeQuality(report) === String(candidate.quality || '').toUpperCase()) score += 2;
  if (reportTradeSession(report) === String(candidate.session || '').toUpperCase()) score += 2;
  if (reportTradeRegime(report) === String(candidate.regime || '').toUpperCase()) score += 2;
  if (reportTags.some((tag) => candidateTags.includes(tag))) score += 2;
  if (reportPatterns.some((pattern) => candidatePatterns.includes(pattern))) score += 2;
  return score;
}

// Adapt a system-signal-log row into the report shape calibrationMatchScore +
// buildGroupedStats expect (maps top-level fields into the payload slots the
// matcher reads). Lets forex calibration learn from the FULL A/A+ set.
function systemLogRowToCalibReport(row) {
  return {
    signalType: 'forex',
    symbol: row.symbol,
    timeframe: row.timeframe,
    grade: row.grade,
    outcome: row.outcome,
    confidence: row.confidence,
    profitLossPips: row.profitLossPips,
    signalTime: row.signalTime,
    payload: {
      strategyType: row.strategyType,
      strategyTags: Array.isArray(row.payload?.strategyTags) ? row.payload.strategyTags : (row.strategyType ? [row.strategyType] : []),
      candlePatterns: (row.pattern && row.pattern !== 'none') ? [row.pattern] : [],
      sessionContext: { reason: row.session },
      volatilityState: row.regime,
      signalQuality: row.signalQuality,
    },
  };
}

async function getCalibrationSnapshot(signalType, candidate, { days = 365, limit = 500 } = {}) {
  // Forex: learn from the FULL system signal log (emailed + filtered A/A+ setups) to
  // avoid survivorship bias from calibrating only on previously-emailed signals.
  // Fixed-time: no full-set log exists, so keep emailed reports.
  let reports;
  if (signalType === 'forex') {
    const { rows } = await querySystemSignalLog({ days, limit: 1000 });
    reports = rows.map(systemLogRowToCalibReport);
  } else {
    reports = await querySignalEmailReports(signalType, { days, limit });
  }
  const settled = reports.filter((report) => !['PENDING'].includes(String(report.outcome || '').toUpperCase()));
  const groups = [
    { name: 'exact', filter: (report) => calibrationMatchScore(report, candidate, signalType) >= 15 },
    { name: 'strong', filter: (report) => calibrationMatchScore(report, candidate, signalType) >= 10 },
    { name: 'medium', filter: (report) => calibrationMatchScore(report, candidate, signalType) >= 7 },
    { name: 'broad', filter: (report) => calibrationMatchScore(report, candidate, signalType) >= 4 },
    { name: 'fallback', filter: () => true },
  ];

  for (const group of groups) {
    const subset = settled.filter(group.filter);
    const stats = buildGroupedStats(subset, ['grade'], {
      confidence: (r) => r.confidence,
      pips: (r) => r.signalType === 'forex' ? r.profitLossPips : null,
      outcome: (r) => r.outcome,
      dimension: (r, dim) => r[dim] || 'unknown',
    });
    const overall = stats.overall;
    const scored = overall.wins + overall.losses;
    if (subset.length && scored > 0) {
      return {
        bucket: group.name,
        sampleSize: subset.length,
        settled: scored,
        confidence: sampleConfidence(scored),
        winRate: overall.winRate,
        expectancy: signalType === 'forex' ? overall.avgPips : null,
        profitFactor: overall.losses > 0 ? Math.round((overall.wins / overall.losses) * 100) / 100 : null,
      };
    }
  }

  return {
    bucket: 'none',
    sampleSize: 0,
    settled: 0,
    confidence: 'weak',
    winRate: null,
    expectancy: null,
    profitFactor: null,
  };
}

async function getForexCalibrationSnapshot(result) {
  const sd = result?.systemDecision || {};
  return getCalibrationSnapshot('forex', {
    symbol: result?.symbol,
    timeframe: result?.timeframe,
    grade: sd.grade,
    quality: sd.signalQuality,
    strategyTags: sd.strategyTags || [],
    session: sd.sessionContext?.reason,
    regime: sd.regime || sd.volatilityState || null,
    patternNames: [
      ...(sd.datFramework?.trigger?.pattern ? [sd.datFramework.trigger.pattern] : []),
      ...(sd.candlePatterns || []).map((pattern) => pattern?.name).filter(Boolean),
    ],
  });
}

async function getFttCalibrationSnapshot(prediction) {
  return getCalibrationSnapshot('fixed', {
    symbol: prediction?.symbol,
    expiry: prediction?.expiry,
    grade: prediction?.indicators?.grade || fttReportGrade(prediction),
    quality: prediction?.indicators?.qualityTier || null,
    strategyTags: prediction?.indicators?.strategyTags || [],
    session: prediction?.indicators?.sessionContext?.reason,
    regime: prediction?.indicators?.volatilityState || prediction?.indicators?.ichimokuState || null,
    patternNames: Array.isArray(prediction?.indicators?.detectedPatterns)
      ? prediction.indicators.detectedPatterns.map((pattern) => pattern?.name).filter(Boolean)
      : [],
  });
}

function withinDays(value, days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return true;
  const t = Date.parse(value || '');
  return Number.isFinite(t) && t >= Date.now() - n * 24 * 60 * 60 * 1000;
}

function createEmptyStats() {
  return {
    total: 0,
    settled: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    breakeven: 0,
    tp1Wins: 0,
    tp2Wins: 0,
    tp3Wins: 0,
    pending: 0,
    noTrade: 0,
    expired: 0,
    ambiguous: 0,
    avgConfidence: 0,
    avgPips: 0,
    netPips: 0,
    winRate: 0,
  };
}

function addToStats(stats, item, { confidence = 0, pips = null, outcome = 'PENDING' } = {}) {
  const o = String(outcome || 'PENDING').toUpperCase();
  stats.total += 1;
  stats._confidenceSum = (stats._confidenceSum || 0) + (Number(confidence) || 0);
  if (o === 'WIN' || o === 'TP1_WIN' || o === 'TP2_WIN' || o === 'TP3_WIN') {
    stats.wins += 1;
    stats.settled += 1;
    if (o === 'TP1_WIN') stats.tp1Wins += 1;
    if (o === 'TP2_WIN') stats.tp2Wins += 1;
    if (o === 'TP3_WIN') stats.tp3Wins += 1;
  }
  else if (o === 'LOSS') { stats.losses += 1; stats.settled += 1; }
  else if (o === 'DRAW') { stats.draws += 1; stats.settled += 1; }
  else if (o === 'BREAKEVEN') { stats.breakeven += 1; stats.settled += 1; }
  else if (o === 'NO_TRADE') stats.noTrade += 1;
  else if (o === 'EXPIRED') stats.expired += 1;
  else if (o === 'AMBIGUOUS') stats.ambiguous += 1;
  else stats.pending += 1;

  const nPips = Number(pips);
  if (Number.isFinite(nPips)) {
    stats.netPips += nPips;
    stats._pipsCount = (stats._pipsCount || 0) + 1;
    if (nPips >= 0) stats._grossWin = (stats._grossWin || 0) + nPips;
    else stats._grossLoss = (stats._grossLoss || 0) + Math.abs(nPips);
  }
}

function finalizeStats(stats) {
  const scored = stats.wins + stats.losses;
  const total = stats.total || 0;
  stats.winRate = scored ? Math.round((stats.wins / scored) * 100) : 0;
  stats.tp1WinRate = total ? Math.round((stats.tp1Wins / total) * 100) : 0;
  stats.tp2WinRate = total ? Math.round((stats.tp2Wins / total) * 100) : 0;
  stats.tp3WinRate = total ? Math.round((stats.tp3Wins / total) * 100) : 0;
  stats.avgConfidence = stats.total ? Math.round(((stats._confidenceSum || 0) / stats.total) * 10) / 10 : 0;
  stats.avgPips = stats._pipsCount ? Math.round((stats.netPips / stats._pipsCount) * 10) / 10 : 0;
  stats.netPips = Math.round(stats.netPips * 10) / 10;
  const grossWin = stats._grossWin || 0;
  const grossLoss = stats._grossLoss || 0;
  // profitFactor = gross winning pips / gross losing pips. null means "no losing
  // pips recorded" (undefined ratio) rather than a misleading Infinity in JSON.
  stats.profitFactor = grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? null : 0);
  delete stats._confidenceSum;
  delete stats._pipsCount;
  delete stats._grossWin;
  delete stats._grossLoss;
  return stats;
}

function forexOutcomeRank(outcome) {
  const o = String(outcome || '').toUpperCase();
  if (o === 'TP3_WIN') return 3;
  if (o === 'TP2_WIN') return 2;
  if (o === 'TP1_WIN' || o === 'WIN') return 1;
  return 0;
}

function forexOutcomeLabel(rank) {
  if (rank >= 3) return 'TP3_WIN';
  if (rank === 2) return 'TP2_WIN';
  if (rank === 1) return 'TP1_WIN';
  return 'PENDING';
}

async function getCandlesFromDbRange(symbol, timeframe, startIso, endIso, limit = 2000) {
  const pool = await initializeDatabase();
  if (!pool) return [];
  const sym = String(symbol).toUpperCase();
  const tf = String(timeframe).toUpperCase();
  // `limit` is the max RAW rows to pull. Historical rows are still ~5x polluted
  // (snapshots ingested before Fix A), so we paginate past the old 5000-row wall
  // via keyset pagination on candle_time, then collapse to real bars. Bounded to
  // avoid runaway scans on very wide ranges.
  const maxRows = Math.max(1, Math.min(Number(limit) || 2000, 200000));
  const batchSize = 5000;
  const all = [];
  let lastSeen = null; // raw DB candle_time of the last row fetched
  while (all.length < maxRows) {
    const lowClause = lastSeen === null ? 'candle_time >= ?' : 'candle_time > ?';
    const lowParam = lastSeen === null ? startIso : lastSeen;
    const take = Math.min(batchSize, maxRows - all.length);
    const [rows] = await pool.query(
      `SELECT candle_time, open_price, high, low, close_price, volume, spread
       FROM mt5_candles
       WHERE symbol = ? AND timeframe = ? AND ${lowClause} AND candle_time <= ?
       ORDER BY candle_time ASC
       LIMIT ?`,
      [sym, tf, lowParam, endIso, take],
    );
    if (!rows.length) break;
    all.push(...rows);
    lastSeen = rows[rows.length - 1].candle_time; // unique per row → strict > is safe
    if (rows.length < take) break; // range exhausted
  }
  const mapped = all.map((row) => ({
    time: row.candle_time ? new Date(row.candle_time).toISOString() : null,
    open: row.open_price === null ? null : Number(row.open_price),
    high: row.high === null ? null : Number(row.high),
    low: row.low === null ? null : Number(row.low),
    close: row.close_price === null ? null : Number(row.close_price),
    volume: row.volume === null || row.volume === undefined ? null : Number(row.volume),
    spread: row.spread === null || row.spread === undefined ? null : Number(row.spread),
  })).filter((candle) => candle.time);
  return collapseCandlesToBars(mapped, timeframe);
}

// The candle table stores multiple intra-bar snapshots per timeframe interval
// (the live feed appends as the bar forms instead of upserting one row per bar),
// so a raw query returns ~5x the real bar count with sub-interval timestamps.
// Feeding that polluted series into sequential indicators (ATR/ADX/EMA/swings)
// badly distorts them — e.g. on XAUUSDM M15, ADX reads 65 raw vs 24 collapsed.
// Collapse to ONE bar per interval: keep the last snapshot (the bar's completed
// state) and snap its timestamp to the interval boundary.
function collapseCandlesToBars(candles, timeframe) {
  const intervalMs = timeframeMs(timeframe);
  if (!intervalMs || !Array.isArray(candles) || candles.length === 0) return candles;
  const byBar = new Map();
  for (const c of candles) {
    const ms = Date.parse(c.time);
    if (!Number.isFinite(ms)) continue;
    const boundary = Math.floor(ms / intervalMs) * intervalMs;
    byBar.set(boundary, { ...c, time: new Date(boundary).toISOString() });
  }
  return [...byBar.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

function evaluateForexReplay(report, candles, { horizonHours = 72, requiresFill = false, orderType = null, filledAtSignal = false, validUntilIso = null, replayStartIso = null } = {}) {
  const signalMs = Date.parse(report.signalTime || '');
  if (!Number.isFinite(signalMs)) return { outcome: 'PENDING', valid: false };
  const replayStartMs = replayStartIso ? Date.parse(replayStartIso) : signalMs;

  const isBuy = String(report.direction).toUpperCase().includes('BUY');
  const entry = Number(report.entryPrice);
  const sl = Number(report.stopLoss);
  const payload = report.payload || {};
  const tp1 = Number(report.takeProfit1 ?? payload.takeProfit1 ?? payload.take_profit_1);
  const tp2 = Number(payload.takeProfit2 ?? payload.take_profit_2 ?? payload.takeProfit2);
  const tp3 = Number(payload.takeProfit3 ?? payload.take_profit_3 ?? payload.takeProfit3);
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp1)) {
    return { outcome: 'PENDING', valid: false };
  }
  // A take-profit only counts if it is finite, positive, and on the correct side of
  // entry. Number(null) coerces to 0, and Number.isFinite(0) is true — without this
  // guard a missing TP2/TP3 (single-target strategies) would register as an
  // instantly-hit target for BUYs (high >= 0 is always true) and produce a bogus win.
  const validTp = (tp) => Number.isFinite(tp) && tp > 0 && (isBuy ? tp > entry : tp < entry);
  const normalizedOrderType = String(orderType || (requiresFill ? 'LIMIT' : 'MARKET')).toUpperCase();
  const validUntilMs = validUntilIso ? Date.parse(validUntilIso) : NaN;

  const horizonMs = Math.max(1, Number(horizonHours) || 72) * 3600 * 1000;
  const laterCandles = candles
    .map((candle) => ({ ...candle, timeMs: Date.parse(candle.time || '') }))
    .filter((candle) => Number.isFinite(candle.timeMs) && candle.timeMs >= (Number.isFinite(replayStartMs) ? replayStartMs : signalMs) && candle.timeMs <= signalMs + horizonMs)
    .sort((a, b) => a.timeMs - b.timeMs);

  if (!laterCandles.length) {
    return { outcome: 'EXPIRED', valid: true, exitPrice: null, resolvedAt: null, barsToResolution: 0, tpHitLevel: 0, mfePips: 0, maePips: 0 };
  }

  // FILL-GATED replay (limit-order strategies, e.g. special-forex-sniper): the signal's entry
  // is a LIMIT the market must trade to. No fill within the horizon → EXPIRED (no trade
  // happened — excluded from the win rate, never a phantom win). Filled → replay TP/SL from
  // the fill bar onward; on the fill bar itself TPs count only off the CLOSE (the bar's
  // extreme may predate the fill), while the SL still counts off the wick — conservative:
  // may understate wins, can never overstate them.
  let startIdx = 0;
  let fillBarIdx = -1;
  if ((normalizedOrderType === 'LIMIT' || normalizedOrderType === 'STOP') && !filledAtSignal) {
    fillBarIdx = findOrderFillIndex(laterCandles, { isBuy, entry, orderType: normalizedOrderType, validUntilMs });
    if (fillBarIdx === -1) {
      return { outcome: 'EXPIRED', valid: true, filledAt: null, exitPrice: null, resolvedAt: null, barsToResolution: laterCandles.length, tpHitLevel: 0, mfePips: 0, maePips: 0 };
    }
    startIdx = fillBarIdx;
  }

  const pip = pipSizeForSymbol(report.symbol);
  let bestRank = forexOutcomeRank(report.outcome);
  let outcome = forexOutcomeLabel(bestRank);
  let exitPrice = report.exitPrice ?? null;
  let resolvedAt = report.resolvedAt ? new Date(report.resolvedAt).toISOString() : null;
  let barsToResolution = 0;
  let mfePips = 0;
  let maePips = 0;
  let tpHitLevel = bestRank;

  for (let ci = startIdx; ci < laterCandles.length; ci++) {
    const candle = laterCandles[ci];
    const isLimitFillBar = normalizedOrderType === 'LIMIT' && ci === fillBarIdx && !filledAtSignal;
    const isStopFillBar = normalizedOrderType === 'STOP' && ci === fillBarIdx && !filledAtSignal;
    barsToResolution += 1;
    const low = Number(candle.low);
    const high = Number(candle.high);
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
    const close = Number(candle.close);
    // On the fill bar the favorable extreme may predate the fill — use the close instead.
    const favHigh = isLimitFillBar && Number.isFinite(close) ? close : high;
    const favLow = isLimitFillBar && Number.isFinite(close) ? close : low;

    const favorable = isBuy ? (favHigh - entry) / pip : (entry - favLow) / pip;
    const adverse = isBuy ? (low - entry) / pip : (entry - high) / pip;
    mfePips = Math.max(mfePips, Math.round(favorable * 10) / 10);
    maePips = Math.min(maePips, Math.round(adverse * 10) / 10);

    const hitTp1 = validTp(tp1) ? (isBuy ? favHigh >= tp1 : favLow <= tp1) : false;
    const hitTp2 = validTp(tp2) ? (isBuy ? favHigh >= tp2 : favLow <= tp2) : false;
    const hitTp3 = validTp(tp3) ? (isBuy ? favHigh >= tp3 : favLow <= tp3) : false;
    const hitAnyTarget = hitTp3 || hitTp2 || hitTp1;
    const hitLevel = hitTp3 ? 3 : hitTp2 ? 2 : hitTp1 ? 1 : 0;
    const hitSl = isBuy ? low <= sl : high >= sl;

    // STOP-entry fill bars are path-ambiguous: the adverse wick may predate the breakout trigger,
    // while the favorable side can only happen after it. When that same bar also touches the
    // stop, we cannot honestly know whether the trade ever existed long enough to lose.
    if (isStopFillBar && hitSl) {
      outcome = 'AMBIGUOUS';
      resolvedAt = candle.time;
      break;
    }

    if (hitSl && !hitAnyTarget) {
      if (bestRank === 0) {
        outcome = 'LOSS';
        exitPrice = sl;
        resolvedAt = candle.time;
      }
      break;
    }

    if (hitAnyTarget && hitSl) {
      // A target banked on an earlier candle remains a known win. A later candle
      // touching both a higher target and SL cannot honestly upgrade or erase it.
      if (bestRank === 0) {
        outcome = 'AMBIGUOUS';
        resolvedAt = candle.time;
      }
      break;
    }

    if (hitAnyTarget && hitLevel > bestRank) {
      bestRank = hitLevel;
      tpHitLevel = hitLevel;
      outcome = forexOutcomeLabel(bestRank);
      exitPrice = hitLevel === 3 ? tp3 : hitLevel === 2 ? tp2 : tp1;
      resolvedAt = candle.time;
    }
  }

  if (outcome === 'PENDING') {
    outcome = 'EXPIRED';
  }

  const diff = isBuy
    ? (Number(exitPrice ?? entry) - entry)
    : (entry - Number(exitPrice ?? entry));
  const profitLossPips = outcome === 'LOSS'
    ? -Math.abs(Math.round((diff / pip) * 10) / 10)
    : outcome === 'AMBIGUOUS'
      ? null
      : Math.round((diff / pip) * 10) / 10;

  return {
    valid: true,
    outcome,
    filledAt: filledAtSignal ? new Date(signalMs).toISOString() : fillBarIdx >= 0 ? laterCandles[fillBarIdx]?.time || null : new Date(signalMs).toISOString(),
    exitPrice,
    resolvedAt,
    barsToResolution,
    tpHitLevel,
    mfePips: Math.round(mfePips * 10) / 10,
    maePips: Math.round(maePips * 10) / 10,
    profitLossPips,
  };
}

// Round-trip transaction cost (spread + slippage) in pips, per instrument.
// Deliberately conservative so the backtest does not flatter marginal setups.
function defaultCostPips(symbol) {
  const s = String(symbol).toUpperCase();
  if (/XAU|GOLD/.test(s)) return 6;   // ~$0.60 round trip at pip 0.1
  if (/XAG/.test(s)) return 4;
  if (/BTC|ETH/.test(s)) return 30;
  if (/JPY/.test(s)) return 2;
  return 2;                           // ~2 pips on majors
}

function timeframeMinutes(tf) {
  const m = { M1: 1, M2: 2, M3: 3, M5: 5, M10: 10, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };
  return m[String(tf).toUpperCase()] || 15;
}

// Phase 4: path-aware management-model simulation. Returns the realized
// R-multiple (risk-multiple, net of cost) for each exit style, walking the SAME
// price path. This strips the optimistic "best TP ever reached" assumption of
// evaluateForexReplay by committing to a consistent rule. Conservative intrabar:
// if a bar touches both the stop and a target, the STOP is assumed first.
//   tp1/tp2/tp3     = all-or-nothing exit at that target (stop = initial SL)
//   halfBE_tp2/tp3  = 50% off at TP1, move stop to breakeven, runner to TP2/TP3
// `candles` should already be horizon-limited (forward path within the horizon).
function simulateManagement(sig, candles, costPips, pip) {
  const { direction, entry, sl, tp1, tp2, tp3 } = sig;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0) || !Array.isArray(candles) || !candles.length) return null;
  const dir = String(direction).toUpperCase().includes('BUY') ? 1 : -1;
  const costR = (costPips * pip) / risk;
  const rMult = (px) => (dir * (px - entry)) / risk;
  const hitTarget = (c, lvl) => Number.isFinite(lvl) && (dir === 1 ? Number(c.high) >= lvl : Number(c.low) <= lvl);
  const hitStop = (c, stop) => dir === 1 ? Number(c.low) <= stop : Number(c.high) >= stop;
  const lastClose = Number(candles[candles.length - 1].close);

  const aon = (target) => {
    if (!Number.isFinite(target)) return null;
    for (const c of candles) {
      if (hitStop(c, sl)) return rMult(sl) - costR;        // stop first (covers ambiguous)
      if (hitTarget(c, target)) return rMult(target) - costR;
    }
    return rMult(lastClose) - costR;                        // horizon end: mark to last close
  };

  const halfBE = (runnerTarget) => {
    if (!Number.isFinite(runnerTarget) || !Number.isFinite(tp1)) return null;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (hitStop(c, sl)) return rMult(sl) - costR;         // full loss before TP1
      if (hitTarget(c, tp1)) {
        const lockedHalf = 0.5 * 1;                         // +0.5R banked (TP1 = 1R)
        if (hitStop(c, entry)) return lockedHalf - costR;   // same bar pierced BE → runner flat
        for (let j = i + 1; j < candles.length; j++) {
          const d = candles[j];
          if (hitStop(d, entry)) return lockedHalf - costR; // BE before target (conservative)
          if (hitTarget(d, runnerTarget)) return lockedHalf + 0.5 * rMult(runnerTarget) - costR;
        }
        return lockedHalf + 0.5 * rMult(lastClose) - costR; // runner marked to last close
      }
    }
    return rMult(lastClose) - costR;
  };

  const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
  return { tp1: r2(aon(tp1)), tp2: r2(aon(tp2)), tp3: r2(aon(tp3)), halfBE_tp2: r2(halfBE(tp2)), halfBE_tp3: r2(halfBE(tp3)) };
}

const MGMT_MODELS = [
  ['tp1', 'TP1 only (1R)'],
  ['tp2', 'TP2 only (2R)'],
  ['tp3', 'TP3 only (3R)'],
  ['halfBE_tp2', '50%@TP1 +BE, run TP2'],
  ['halfBE_tp3', '50%@TP1 +BE, run TP3'],
];
function aggregateManagement(samples) {
  const out = {};
  for (const [key, label] of MGMT_MODELS) {
    const rs = samples.map((s) => s.mgmt && s.mgmt[key]).filter(Number.isFinite);
    const wins = rs.filter((r) => r > 0).length;
    const gw = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
    const gl = rs.filter((r) => r < 0).reduce((a, b) => a + Math.abs(b), 0);
    const sum = rs.reduce((a, b) => a + b, 0);
    out[key] = {
      label,
      n: rs.length,
      winRate: rs.length ? Math.round((wins / rs.length) * 100) : 0,
      expectancyR: rs.length ? Math.round((sum / rs.length) * 100) / 100 : 0,
      netR: Math.round(sum * 100) / 100,
      profitFactor: gl > 0 ? Math.round((gw / gl) * 100) / 100 : (gw > 0 ? null : 0),
    };
  }
  return out;
}

// Walk-forward / out-of-sample validation. Split the chronological samples into
// TRAIN (earlier) and TEST (later, unseen). If grade separation / edge only
// shows up in TRAIN, it's curve-fitting. Reuses the shared stats helpers so the
// fold metrics match the rest of the replay. Samples must be in chronological
// order (the replay loop pushes them bar-ascending).
function runReplayOos(samples, split) {
  const n = samples.length;
  const cut = Math.floor(n * split);
  const train = samples.slice(0, cut);
  const test = samples.slice(cut);
  const fold = (arr) => {
    const st = createEmptyStats();
    for (const s of arr) addToStats(st, s, { confidence: s.confidence, pips: s.netPips, outcome: s.outcome });
    return finalizeStats(st);
  };
  const byGrade = (arr) => buildGroupedStats(arr, ['grade'], {
    confidence: (s) => s.confidence, pips: (s) => s.netPips, outcome: (s) => s.outcome,
    dimension: (s, dim) => s[dim] ?? 'unknown',
  }).groups.grade;
  const t = fold(train);
  const v = fold(test);
  let verdict;
  if (v.settled < 10) verdict = `inconclusive (only ${v.settled} settled in test — need more history)`;
  else if (v.winRate >= t.winRate - 10 && v.netPips > 0) verdict = 'HOLDS out-of-sample';
  else verdict = 'DEGRADES out-of-sample (likely overfit)';
  return { split, trainN: train.length, testN: test.length, train: t, test: v, trainByGrade: byGrade(train), testByGrade: byGrade(test), verdict };
}

// Phase 1 — TRUE signal-replay backtest. Unlike the report-based backtest
// (which only sees signals that already passed the live gates and were
// emailed → survivorship bias), this walks raw historical candles bar by bar,
// runs aggregateSignals POINT-IN-TIME (only data available at each bar), and
// resolves EVERY generated signal — including the ones the live email gate
// would have filtered. That lets us measure whether the gates are discarding
// winners ("too strict?") with data instead of opinion.
//
// Methodology guards baked in:
//  - Point-in-time: each bar only sees candles[0..i] and HTF candles dated <= bar.
//  - No look-ahead resolution: entry is the signal-bar close; the forward sim
//    starts at the NEXT bar (slice(i+1)).
//  - Conservative intrabar rule: evaluateForexReplay marks a bar AMBIGUOUS (not
//    a win) when both TP and SL are touched in the same candle.
//  - Cost modeling: round-trip spread+slippage deducted from every result.
//  - Indicators recomputed from candles (indicators: []), relying on the engine's
//    internal calcs + the new internal ADX fallback — so regime tuning is live.
// Known v1 limitations (documented, flagged for later phases): news-calendar
// state is not reconstructed point-in-time (uses current calendar), and ADR/
// daily-high-low context is omitted (null) to avoid D1 look-ahead.
async function runForexReplay(symbol, timeframe, opts = {}) {
  const sym = String(symbol).toUpperCase();
  const tf = String(timeframe).toUpperCase();
  const days = Math.max(1, Math.min(Number(opts.days) || 14, 120));
  const horizonHours = Math.max(1, Number(opts.horizonHours) || 72);
  const warmup = Math.max(40, Math.min(Number(opts.warmup) || 80, 400));
  const maxSignals = Math.max(1, Math.min(Number(opts.maxSignals) || 1500, 5000));
  const cost = Number.isFinite(Number(opts.costPips)) ? Number(opts.costPips) : defaultCostPips(sym);
  const split = Math.min(0.9, Math.max(0.5, Number(opts.split) || 0.7));

  const endMs = Date.now();
  const startMs = endMs - days * 86400 * 1000;
  // Pull extra history before the window for warmup + HTF context.
  const bufferMs = Math.max(20 * 86400 * 1000, warmup * timeframeMinutes(tf) * 60 * 1000 * 1.4);
  const startIso = new Date(startMs - bufferMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  const tag = (rows) => rows
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite))
    .map((c) => ({ ...c, symbol: sym, timeframe: tf, ms: Date.parse(c.time) }))
    .filter((c) => Number.isFinite(c.ms));

  // Deep raw-row budgets — historical rows are still ~5x polluted, so fetch
  // generously and let pagination + the date range bound the real bar count.
  const tfBudget = Math.min(200000, Math.ceil(days * (1440 / timeframeMinutes(tf)) * 6) + 10000);
  const candles = tag(await getCandlesFromDbRange(sym, tf, startIso, endIso, tfBudget));
  if (candles.length < warmup + 5) {
    return { ok: false, reason: `insufficient candle history (${candles.length} bars; need > ${warmup + 5}). Try a higher timeframe or shorter window.`, candleCount: candles.length };
  }
  // truncated = the data does not reach back to the requested window start.
  const truncated = candles[0].ms > startMs;
  // Actual span of returned bars, so a run reports up front how much real history
  // it found (vs the requested --days) without eyeballing the truncated flag.
  const firstBarMs = candles[0].ms;
  const lastBarMs = candles[candles.length - 1].ms;
  const coverageDays = Math.round(((lastBarMs - firstBarMs) / 86400000) * 10) / 10;
  const h4 = tag(await getCandlesFromDbRange(sym, 'H4', startIso, endIso, 60000));
  const h1 = tag(await getCandlesFromDbRange(sym, 'H1', startIso, endIso, 60000));

  const minGradeRank = selectedRank('forexMinGrade', FOREX_MIN_GRADE_RANK, 'A_SETUP');
  const minQualityRank = selectedRank('forexMinQuality', FOREX_MIN_QUALITY_RANK, 'A_SIGNAL');

  const samples = [];
  let holds = 0;
  let barsProcessed = 0;
  let engineErrors = 0;

  for (let i = warmup; i < candles.length - 1; i++) {
    const bar = candles[i];
    if (bar.ms < startMs) continue; // bars before the window are warmup/HTF only
    barsProcessed += 1;
    const pointInTime = candles.slice(0, i + 1);
    const h4Slice = h4.filter((c) => c.ms <= bar.ms);
    const h1Slice = h1.filter((c) => c.ms <= bar.ms);
    let sd;
    try {
      const summary = aggregateSignals({
        symbol: sym, timeframe: tf, candles: pointInTime, indicators: [],
        marketLevels: [], accountSnapshot: null, adr: null, dailyHighLow: null,
        h4Candles: h4Slice, h1Candles: h1Slice, skipNews: true,
      });
      sd = summary.systemDecision;
    } catch (err) {
      engineErrors += 1;
      continue;
    }
    if (!sd || sd.decision === 'HOLD') { holds += 1; continue; }

    const pseudo = {
      symbol: sym, timeframe: tf, signalTime: bar.time, direction: sd.decision,
      entryPrice: sd.entryPrice, stopLoss: sd.stopLoss, takeProfit1: sd.takeProfit1,
      payload: { takeProfit2: sd.takeProfit2, takeProfit3: sd.takeProfit3 },
      outcome: 'PENDING', exitPrice: null, resolvedAt: null,
    };
    const fwd = evaluateForexReplay(pseudo, candles.slice(i + 1), { horizonHours });
    if (!fwd.valid) continue;
    const rawPips = Number.isFinite(fwd.profitLossPips) ? fwd.profitLossPips : null;
    const netPips = rawPips === null ? null : Math.round((rawPips - cost) * 10) / 10;
    const wouldPassGate = gradeRank(sd.grade) >= minGradeRank && signalQualityRank(sd.signalQuality) >= minQualityRank;
    // Derive stop distance from entry/SL directly (riskPlan.stopPips is unreliable here).
    const stopPips = (Number.isFinite(Number(sd.entryPrice)) && Number.isFinite(Number(sd.stopLoss)))
      ? Math.abs(Number(sd.entryPrice) - Number(sd.stopLoss)) / pipSizeForSymbol(sym) : null;
    // 2R = favorable excursion reached at least twice the stop distance, independent
    // of where the discrete TP levels sit. A direct read on raw edge.
    const hit2R = !!(stopPips && stopPips > 0 && Number(fwd.mfePips) >= 2 * stopPips);
    const pattern = sd.datFramework?.trigger?.pattern
      || (sd.candlePatterns || []).find((p) => p?.direction && p.direction !== 'neutral')?.name
      || 'none';
    // Phase 4: management-model R-multiples over the horizon-limited forward path.
    const fwdAll = candles.slice(i + 1);
    const hStart = fwdAll.length ? fwdAll[0].ms : null;
    const fwdH = hStart === null ? [] : fwdAll.filter((c) => c.ms <= hStart + horizonHours * 3600 * 1000);
    const mgmt = simulateManagement({
      direction: sd.decision, entry: Number(sd.entryPrice), sl: Number(sd.stopLoss),
      tp1: Number(sd.takeProfit1), tp2: Number(sd.takeProfit2), tp3: Number(sd.takeProfit3),
    }, fwdH, cost, pipSizeForSymbol(sym));
    samples.push({
      signalTime: bar.time,
      symbol: sym,
      timeframe: tf,
      direction: sd.decision,
      confidence: sd.confidence,
      grade: sd.grade,
      signalQuality: sd.signalQuality,
      datScore: Number(sd.datFramework?.score || 0),
      rr: sd.riskRewardRatio,
      regime: sd.regime,
      adxSource: sd.adxSource,
      session: sd.sessionContext?.reason || 'none',
      strategyType: sd.strategyType || 'SYSTEM_CONFLUENCE',
      pattern,
      stopPips,
      hit2R,
      outcome: fwd.outcome,
      tpHitLevel: fwd.tpHitLevel,
      rawPips,
      netPips,
      mfePips: fwd.mfePips,
      maePips: fwd.maePips,
      barsToResolution: fwd.barsToResolution,
      wouldPassGate,
      features: sd.features || null,
      mgmt,
    });
    if (samples.length >= maxSignals) break;
  }

  const accessors = {
    confidence: (s) => s.confidence,
    pips: (s) => s.netPips,
    outcome: (s) => s.outcome,
    dimension: (s, dim) => dim === 'gate' ? (s.wouldPassGate ? 'WOULD_EMAIL' : 'FILTERED_OUT') : (s[dim] ?? 'unknown'),
  };
  const grouped = buildGroupedStats(
    samples,
    ['grade', 'regime', 'signalQuality', 'gate', 'symbol', 'timeframe', 'session', 'strategyType', 'pattern'],
    accessors,
  );
  const hit2RCount = samples.filter((s) => s.hit2R).length;
  const twoRWinRate = samples.length ? Math.round((hit2RCount / samples.length) * 1000) / 10 : 0;

  return {
    ok: true,
    symbol: sym,
    timeframe: tf,
    params: { days, horizonHours, warmup, maxSignals, costPips: cost },
    candleMeta: {
      tfBars: candles.length, h4Bars: h4.length, h1Bars: h1.length, truncated, barsProcessed, engineErrors,
      requestedDays: days, coverageDays,
      firstBar: new Date(firstBarMs).toISOString(), lastBar: new Date(lastBarMs).toISOString(),
    },
    signalsGenerated: samples.length,
    holds,
    signalRate: barsProcessed ? Math.round((samples.length / barsProcessed) * 1000) / 10 : 0,
    twoR: { hit2RCount, twoRWinRate },
    overall: grouped.overall,
    management: aggregateManagement(samples),
    oos: samples.length >= 10 ? runReplayOos(samples, split) : null,
    byGrade: grouped.groups.grade,
    byRegime: grouped.groups.regime,
    byQuality: grouped.groups.signalQuality,
    byGate: grouped.groups.gate,
    bySymbol: grouped.groups.symbol,
    byTimeframe: grouped.groups.timeframe,
    bySession: grouped.groups.session,
    byStrategy: grouped.groups.strategyType,
    byPattern: grouped.groups.pattern,
    samples: samples.slice(0, 25),
    methodology: [
      'Point-in-time replay: each bar sees only candles up to its close.',
      'Entry at signal-bar close; resolution begins next bar (no look-ahead).',
      'Ambiguous bars (TP and SL both touched) counted as AMBIGUOUS, not wins.',
      `Round-trip cost of ${cost} pips deducted from every net result.`,
      'Indicators recomputed from candles (incl. internal ADX fallback).',
      'Management models: path-aware R-multiples (TP1/2/3 all-or-nothing, 50%@TP1+BE runner) net of cost — strips best-TP inflation.',
      `Walk-forward: chronological ${Math.round(split * 100)}/${Math.round((1 - split) * 100)} train/test split; verdict HOLDS only if test win rate within 10pts of train AND test net positive.`,
      'v1 limitations: news-calendar not point-in-time; ADR/DHL omitted to avoid D1 look-ahead.',
    ],
  };
}

function buildGroupedStats(items, dimensions, accessors) {
  const overall = createEmptyStats();
  const groups = Object.fromEntries(dimensions.map((dim) => [dim, {}]));
  for (const item of items) {
    const confidence = accessors.confidence(item);
    const pips = accessors.pips ? accessors.pips(item) : null;
    const outcome = accessors.outcome(item);
    addToStats(overall, item, { confidence, pips, outcome });
    for (const dim of dimensions) {
      const key = String(accessors.dimension(item, dim) ?? 'unknown');
      if (!groups[dim][key]) groups[dim][key] = createEmptyStats();
      addToStats(groups[dim][key], item, { confidence, pips, outcome });
    }
  }
  for (const dim of dimensions) {
    groups[dim] = Object.fromEntries(Object.entries(groups[dim]).map(([key, stats]) => [key, finalizeStats(stats)]));
  }
  return { overall: finalizeStats(overall), groups };
}

function pipSizeForSymbol(symbol) {
  const s = String(symbol).toUpperCase();
  const caps = symbolCapsFor(s);
  if (caps?.pipSize) return caps.pipSize;              // index CFDs: 1 "pip" = 1 point
  if (/XAU|GOLD/.test(s)) return 0.1;
  if (/XAG/.test(s)) return 0.01;
  if (/JPY/.test(s)) return 0.01;
  if (/BTC|ETH/.test(s)) return 1.0;
  return 0.0001;
}

function getFttCandleTimeframeMapping(expiry) {
  const exp = String(expiry || '5m').trim().toLowerCase();
  if (exp === '1m' || exp === '2m' || exp === '3m' || exp === '4m') {
    return { bias: 'M5', trend: 'M3', entry: 'M1', confirmation: 'M1' };
  }
  if (exp === '5m') {
    return { bias: 'M15', trend: 'M5', entry: 'M2', confirmation: 'M1' };
  }
  if (exp === '10m') {
    return { bias: 'M15', trend: 'M5', entry: 'M3', confirmation: 'M1' };
  }
  if (exp === '15m' || exp === '20m') {
    return { bias: 'M30', trend: 'M15', entry: 'M5', confirmation: 'M1' };
  }
  if (exp === '30m' || exp === '40m') {
    return { bias: 'H1', trend: 'M30', entry: 'M5', confirmation: 'M1' };
  }
  return { bias: 'H4', trend: 'H1', entry: 'M15', confirmation: 'M5' };
}

function coerceDate(value, fallback = null) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function formatAlertDateTime(value) {
  const date = coerceDate(value);
  if (!date) return 'n/a';
  return date.toLocaleString('en-US', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function formatAlertDelay(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return 'n/a';
  const total = Math.max(0, Math.round(Number(seconds)));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function alertDelaySeconds(signalTime, sentAt) {
  const signalDate = coerceDate(signalTime);
  const sentDate = coerceDate(sentAt);
  if (!signalDate || !sentDate) return null;
  return Math.max(0, Math.round((sentDate.getTime() - signalDate.getTime()) / 1000));
}

function delayColor(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '#64748b';
  if (Number(seconds) <= 20) return '#047857';
  if (Number(seconds) <= 90) return '#b45309';
  return '#b91c1c';
}

function buildAlertTimingMeta({ signalTime, sentAt = new Date(), tradeTime = null, expiryTime = null }) {
  const signalDate = coerceDate(signalTime, coerceDate(sentAt, new Date()));
  const sentDate = coerceDate(sentAt, new Date());
  const delaySeconds = alertDelaySeconds(signalDate, sentDate);
  const delayLabel = formatAlertDelay(delaySeconds);
  const lines = [
    'SIGNAL TIMING',
    `Signal made: ${formatAlertDateTime(signalDate)}`,
    tradeTime ? `Trade/entry time: ${formatAlertDateTime(tradeTime)}` : '',
    expiryTime ? `Expiry time: ${formatAlertDateTime(expiryTime)}` : '',
    `Email sent: ${formatAlertDateTime(sentDate)}`,
    `Alert delay: ${delayLabel}`,
  ].filter(Boolean);
  const html = `
    <div style="margin:10px 0 12px;padding:12px;border:2px solid #f59e0b;background:#fffbeb;border-radius:12px">
      <p style="margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:.12em;color:#92400e;text-transform:uppercase">Signal Timing</p>
      <table style="font-size:13px;border-collapse:collapse;width:100%">
        <tr><td style="padding:3px 12px 3px 0;color:#64748b">Signal made</td><td><b>${formatAlertDateTime(signalDate)}</b></td></tr>
        ${tradeTime ? `<tr><td style="padding:3px 12px 3px 0;color:#64748b">Trade / entry time</td><td><b>${formatAlertDateTime(tradeTime)}</b></td></tr>` : ''}
        ${expiryTime ? `<tr><td style="padding:3px 12px 3px 0;color:#64748b">Expiry time</td><td><b>${formatAlertDateTime(expiryTime)}</b></td></tr>` : ''}
        <tr><td style="padding:3px 12px 3px 0;color:#64748b">Email sent</td><td><b>${formatAlertDateTime(sentDate)}</b></td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#64748b">Alert delay</td><td><b style="color:${delayColor(delaySeconds)}">${delayLabel}</b></td></tr>
      </table>
    </div>`;
  return { signalDate, sentDate, delaySeconds, delayLabel, text: lines.join('\n'), html };
}

function normalizeSignalEmailReportRow(row) {
  if (!row) return null;
  let payload = null;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    payload = null;
  }
  const signalMs = row.signal_time ? new Date(row.signal_time).getTime() : NaN;
  const emailMs = row.email_sent_at ? new Date(row.email_sent_at).getTime() : NaN;
  const alertDelaySeconds = Number.isFinite(signalMs) && Number.isFinite(emailMs)
    ? Math.max(0, Math.round((emailMs - signalMs) / 1000))
    : null;
  return {
    id: row.id,
    signalType: row.signal_type,
    referenceId: row.reference_id || null,
    symbol: row.symbol,
    timeframe: row.timeframe || null,
    expiry: row.expiry || null,
    direction: row.direction,
    entryPrice: row.entry_price === null ? null : Number(row.entry_price),
    exitPrice: row.exit_price === null ? null : Number(row.exit_price),
    stopLoss: row.stop_loss === null ? null : Number(row.stop_loss),
    takeProfit1: row.take_profit_1 === null ? null : Number(row.take_profit_1),
    profitLossPips: row.profit_loss_pips === null ? null : Number(row.profit_loss_pips),
    confidence: row.confidence === null ? null : Number(row.confidence),
    grade: row.grade || null,
    outcome: row.outcome || 'PENDING',
    signalTime: row.signal_time ? new Date(row.signal_time).toISOString() : null,
    tradeTime: row.trade_time ? new Date(row.trade_time).toISOString() : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    emailSentAt: row.email_sent_at ? new Date(row.email_sent_at).toISOString() : null,
    alertDelaySeconds,
    sourceCandleTime: payload?.sourceCandleTime || payload?.bar || null,
    sourceReceivedAt: payload?.sourceReceivedAt || null,
    emailTo: row.email_to || null,
    candleBiasTf: row.candle_bias_tf || null,
    candleTrendTf: row.candle_trend_tf || null,
    candleEntryTf: row.candle_entry_tf || null,
    candleConfirmTf: row.candle_confirm_tf || null,
    payload,
  };
}

async function persistSignalEmailReport(report) {
  const pool = await initializeDatabase();
  if (!pool) return false;
  if (report.reference_id) {
    const [existing] = await pool.query(
      'SELECT id FROM mt5_signal_email_reports WHERE reference_id = ? LIMIT 1',
      [report.reference_id]
    );
    if (existing.length) return false;
  }
  await pool.query(
    `INSERT INTO mt5_signal_email_reports (
      id, signal_type, reference_id, symbol, timeframe, expiry, direction,
      entry_price, exit_price, stop_loss, take_profit_1, profit_loss_pips,
      confidence, grade, outcome, signal_time, trade_time, resolved_at,
      email_sent_at, email_to, candle_bias_tf, candle_trend_tf, candle_entry_tf,
      candle_confirm_tf, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      report.id,
      report.signal_type,
      report.reference_id || null,
      report.symbol,
      report.timeframe || null,
      report.expiry || null,
      report.direction,
      report.entry_price ?? null,
      report.exit_price ?? null,
      report.stop_loss ?? null,
      report.take_profit_1 ?? null,
      report.profit_loss_pips ?? null,
      report.confidence ?? null,
      report.grade || null,
      report.outcome || 'PENDING',
      toMysqlDate(report.signal_time),
      report.trade_time ? toMysqlDate(report.trade_time) : null,
      report.resolved_at ? toMysqlDate(report.resolved_at) : null,
      toMysqlDate(report.email_sent_at),
      report.email_to || null,
      report.candle_bias_tf || null,
      report.candle_trend_tf || null,
      report.candle_entry_tf || null,
      report.candle_confirm_tf || null,
      report.payload_json || null,
      toMysqlDate(report.created_at),
    ]
  );
  return true;
}

async function persistEmailedForexReport(result) {
  const sd = result.systemDecision;
  const now = new Date();
  const signalTime = result.bar ? new Date(result.bar) : now;
  const id = `rpt_forex_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  await persistSignalEmailReport({
    id,
    signal_type: 'forex',
    reference_id: `forex:${result.symbol}:${result.timeframe}:${result.bar}`,
    symbol: result.symbol,
    timeframe: result.timeframe,
    expiry: null,
    direction: sd.decision,
    entry_price: sd.entryPrice,
    exit_price: null,
    stop_loss: sd.stopLoss,
    take_profit_1: sd.takeProfit1,
    profit_loss_pips: null,
    confidence: sd.confidence,
    grade: sd.grade,
    outcome: 'PENDING',
    signal_time: signalTime,
    trade_time: signalTime,
    resolved_at: null,
    email_sent_at: now,
    email_to: signalEmailTo(),
    candle_bias_tf: result.timeframe,
    candle_trend_tf: null,
    candle_entry_tf: result.timeframe,
    candle_confirm_tf: null,
    payload_json: JSON.stringify({
      bar: result.bar,
      sourceCandleTime: result.bar || null,
      sourceReceivedAt: result.sourceReceivedAt || null,
      calibration: result.calibration || null,
      takeProfit2: sd.takeProfit2,
      takeProfit3: sd.takeProfit3,
      signalQuality: sd.signalQuality,
      strategyType: sd.strategyType,
      strategyTags: sd.strategyTags,
      datFramework: sd.datFramework,
      candlePatterns: sd.candlePatterns,
      ote: sd.ote,
      bpr: sd.bpr,
      amd: sd.amd,
      sessionContext: sd.sessionContext,
      riskPlan: sd.riskPlan,
      entryReason: sd.entryReason,
      slReason: sd.slReason,
      tpReason: sd.tpReason,
      features: sd.features || null,
      calibratedConfidence: result.calibratedConfidence || null,
    }),
    created_at: now,
  });
}

const EMAIL_ALERT_SETTINGS_FILE = path.join(__dirname, '.cache', 'email_alert_settings.json');
const DEFAULT_EMAIL_ALERT_SETTINGS = {
  forexScanner: false,
  fixedTime: true,
  postNewsForex: false,
  postNewsFixed: true,
  highImpactNews: true,
  aiTracked: false,
  forecast: true,
  signalTracker: true,
  // Breakout alerts: master email toggle + min grade (B | A | A+). Browser desktop
  // notifications are NOT gated by this (generous by design) — only email is.
  breakout: true,
  breakoutEmailMinGrade: 'A',
  strategyLab: false,
  strategyLabFixedTime: false,
  forexMinGrade: 'A_SETUP',
  forexMinQuality: 'A_SIGNAL',
  fixedTimeMinTier: 'QUALITY_SIGNAL',
  postNewsForexMinGrade: 'A_NEWS_SETUP',
  postNewsFixedMinTier: 'QUALITY_SIGNAL',
  // Strategy Lab email rules (frontend-controlled): which score / grade / strategies email.
  // Forex (TP/SL) framing.
  strategyLabMinScore: 75,
  strategyLabMinGrade: 'ANY',      // ANY | B | A | A+
  strategyLabStrategies: {},       // { [strategyId]: boolean } — empty = all enabled
  // Fixed-time (direction at next-candle expiry) framing — independent rules.
  strategyLabFttMinScore: 75,
  strategyLabFttMinGrade: 'ANY',   // ANY | B | A | A+
  strategyLabFttStrategies: {},    // { [strategyId]: boolean } — empty = all enabled
  // Per-strategy EMAIL refinements — applies to BOTH the forex + fixed-time email gates. Lets you
  // cut email NOISE per strategy (min score, specific symbols, direction) WITHOUT affecting signal
  // generation / logging / popups / ranking (those are untouched). Overrides the global min for
  // that strategy; symbols empty/absent = all symbols.
  //   strategyLabRules: { [id]: { minScore?, minGrade?: ANY|B|A|A+, symbols?: string[], direction?: ANY|LONG|SHORT } }
  strategyLabRules: {},
  // SIGNAL email recipients (user-managed, up to 10). Empty = fall back to the single
  // SIGNAL_ALERT_EMAIL_TO / EMAIL_TO env address. All signal emails go to every address.
  emailRecipients: [],
  // Per-recipient routing (optional, keyed by address): which symbols/timeframes THAT
  // address receives. Missing entry / empty lists = everything. Delivery-only.
  //   emailRecipientRules: { [email]: { symbols?: string[], timeframes?: string[] } }
  emailRecipientRules: {},
  // Strategy Controller (master per-strategy switch — gates EVERYTHING user-facing:
  // popups, emails, SSE, the recent-signals table and reports). Missing entry = fully
  // enabled. Optional per-strategy refinements gate DELIVERY (alerts): minScore, a
  // direction/"setup" filter, and which timeframes may alert. DB logging always continues
  // (Mute), so the win-rate ranking keeps measuring even muted strategies.
  //   strategyControls: { [id]: { enabled, minScore?, direction?: ANY|LONG|SHORT, timeframes?: [] } }
  strategyControls: {},
};
const EMAIL_BOOLEAN_SETTING_KEYS = ['forexScanner', 'fixedTime', 'postNewsForex', 'postNewsFixed', 'highImpactNews', 'aiTracked', 'forecast', 'signalTracker', 'breakout', 'strategyLab', 'strategyLabFixedTime'];
const EMAIL_SELECT_SETTING_VALUES = {
  forexMinGrade: ['B_SETUP', 'A_SETUP', 'A_PLUS_SETUP'],
  forexMinQuality: ['B_SIGNAL', 'A_SIGNAL', 'A_PLUS_SIGNAL'],
  fixedTimeMinTier: ['QUALITY_SIGNAL', 'TRADE_SIGNAL'],
  postNewsForexMinGrade: ['B_NEWS_SETUP', 'A_NEWS_SETUP', 'A_PLUS_NEWS_SETUP'],
  postNewsFixedMinTier: ['QUALITY_SIGNAL', 'TRADE_SIGNAL'],
  breakoutEmailMinGrade: ['B', 'A', 'A+'],
};
let emailAlertSettingsCache = null;

function loadEmailAlertSettings() {
  if (emailAlertSettingsCache) return emailAlertSettingsCache;
  try {
    if (fs.existsSync(EMAIL_ALERT_SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(EMAIL_ALERT_SETTINGS_FILE, 'utf8')) || {};
      emailAlertSettingsCache = { ...DEFAULT_EMAIL_ALERT_SETTINGS, ...saved };
      return emailAlertSettingsCache;
    }
  } catch (err) {
    console.warn('[EmailSettings] Failed to load settings:', err.message);
  }
  emailAlertSettingsCache = { ...DEFAULT_EMAIL_ALERT_SETTINGS };
  return emailAlertSettingsCache;
}

function saveEmailAlertSettings(nextSettings) {
  const current = loadEmailAlertSettings();
  const sanitized = { ...current };
  for (const key of EMAIL_BOOLEAN_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(nextSettings || {}, key)) sanitized[key] = Boolean(nextSettings[key]);
  }
  for (const [key, allowedValues] of Object.entries(EMAIL_SELECT_SETTING_VALUES)) {
    if (!Object.prototype.hasOwnProperty.call(nextSettings || {}, key)) continue;
    const value = String(nextSettings[key] || '').toUpperCase();
    if (allowedValues.includes(value)) sanitized[key] = value;
  }
  // Strategy Lab email rules.
  if (Object.prototype.hasOwnProperty.call(nextSettings || {}, 'strategyLabMinScore')) {
    const v = Number(nextSettings.strategyLabMinScore);
    if (Number.isFinite(v)) sanitized.strategyLabMinScore = Math.max(40, Math.min(95, Math.round(v)));
  }
  if (Object.prototype.hasOwnProperty.call(nextSettings || {}, 'strategyLabMinGrade')) {
    const g = String(nextSettings.strategyLabMinGrade || 'ANY').toUpperCase();
    if (['ANY', 'B', 'A', 'A+'].includes(g)) sanitized.strategyLabMinGrade = g;
  }
  if (nextSettings && nextSettings.strategyLabStrategies && typeof nextSettings.strategyLabStrategies === 'object') {
    const map = {};
    for (const [k, v] of Object.entries(nextSettings.strategyLabStrategies)) map[String(k)] = Boolean(v);
    sanitized.strategyLabStrategies = map;
  }
  // Strategy Lab fixed-time email rules (independent of the forex rules above).
  if (Object.prototype.hasOwnProperty.call(nextSettings || {}, 'strategyLabFttMinScore')) {
    const v = Number(nextSettings.strategyLabFttMinScore);
    if (Number.isFinite(v)) sanitized.strategyLabFttMinScore = Math.max(40, Math.min(95, Math.round(v)));
  }
  if (Object.prototype.hasOwnProperty.call(nextSettings || {}, 'strategyLabFttMinGrade')) {
    const g = String(nextSettings.strategyLabFttMinGrade || 'ANY').toUpperCase();
    if (['ANY', 'B', 'A', 'A+'].includes(g)) sanitized.strategyLabFttMinGrade = g;
  }
  if (nextSettings && nextSettings.strategyLabFttStrategies && typeof nextSettings.strategyLabFttStrategies === 'object') {
    const map = {};
    for (const [k, v] of Object.entries(nextSettings.strategyLabFttStrategies)) map[String(k)] = Boolean(v);
    sanitized.strategyLabFttStrategies = map;
  }
  // Per-strategy EMAIL refinements (score / grade / symbols / direction). Replace the whole map
  // on save (frontend sends the full object). DELIVERY-only — never touches generation/logging/ranking.
  if (nextSettings && nextSettings.strategyLabRules && typeof nextSettings.strategyLabRules === 'object') {
    const out = {};
    for (const [id, rule] of Object.entries(nextSettings.strategyLabRules)) {
      if (!rule || typeof rule !== 'object') continue;
      const r = {};
      if (rule.minScore !== undefined && rule.minScore !== null && rule.minScore !== '') {
        const v = Number(rule.minScore);
        if (Number.isFinite(v)) r.minScore = Math.max(40, Math.min(95, Math.round(v)));
      }
      if (rule.minGrade !== undefined) {
        const g = String(rule.minGrade || 'ANY').toUpperCase();
        if (['ANY', 'B', 'A', 'A+'].includes(g)) r.minGrade = g;
      }
      if (Array.isArray(rule.symbols)) {
        r.symbols = [...new Set(rule.symbols.map((sym) => String(sym).toUpperCase()).filter(Boolean))];
      }
      if (rule.direction !== undefined) {
        const d = String(rule.direction || 'ANY').toUpperCase();
        if (['ANY', 'LONG', 'SHORT'].includes(d)) r.direction = d;
      }
      out[String(id)] = r;
    }
    sanitized.strategyLabRules = out;
  }
  // Signal email recipients — replace the whole list on save; basic shape validation,
  // lowercase + dedup, capped at 10 addresses.
  if (Array.isArray(nextSettings?.emailRecipients)) {
    const seen = new Set();
    sanitized.emailRecipients = nextSettings.emailRecipients
      .map((e) => String(e || '').trim().toLowerCase())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !seen.has(e) && seen.add(e))
      .slice(0, 10);
  }
  // Per-recipient symbol/timeframe routing — replace the whole map on save. Keys must be
  // valid addresses; symbols uppercased (max 30), timeframes restricted to known TFs.
  if (nextSettings && nextSettings.emailRecipientRules && typeof nextSettings.emailRecipientRules === 'object') {
    const KNOWN_TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
    const out = {};
    for (const [email, rule] of Object.entries(nextSettings.emailRecipientRules)) {
      const key = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key) || !rule || typeof rule !== 'object') continue;
      const r = {};
      if (Array.isArray(rule.symbols)) {
        r.symbols = [...new Set(rule.symbols.map((x) => String(x || '').trim().toUpperCase()).filter((x) => /^[A-Z0-9._#-]{2,20}$/.test(x)))].slice(0, 30);
      }
      if (Array.isArray(rule.timeframes)) {
        r.timeframes = [...new Set(rule.timeframes.map((x) => String(x || '').trim().toUpperCase()))].filter((x) => KNOWN_TFS.includes(x));
      }
      if ((r.symbols || []).length || (r.timeframes || []).length) out[key] = r; // all-empty rule = no rule
    }
    sanitized.emailRecipientRules = out;
  }
  // Strategy Controller — replace the whole map on save (frontend sends the full object).
  if (nextSettings && nextSettings.strategyControls && typeof nextSettings.strategyControls === 'object') {
    const out = {};
    for (const [id, ctrl] of Object.entries(nextSettings.strategyControls)) {
      if (!ctrl || typeof ctrl !== 'object') continue;
      const c = {};
      if (Object.prototype.hasOwnProperty.call(ctrl, 'enabled')) c.enabled = Boolean(ctrl.enabled);
      if (ctrl.minScore !== undefined && ctrl.minScore !== null && ctrl.minScore !== '') {
        const v = Number(ctrl.minScore);
        if (Number.isFinite(v)) c.minScore = Math.max(40, Math.min(95, Math.round(v)));
      }
      if (ctrl.direction !== undefined) {
        const d = String(ctrl.direction || 'ANY').toUpperCase();
        if (['ANY', 'LONG', 'SHORT'].includes(d)) c.direction = d;
      }
      if (Array.isArray(ctrl.timeframes)) {
        const allowed = new Set(strategyTimeframes(id));
        c.timeframes = [...new Set(ctrl.timeframes.map((t) => String(t).toUpperCase()).filter((t) => t && allowed.has(t)))];
      }
      out[String(id)] = c;
    }
    sanitized.strategyControls = out;
  }
  emailAlertSettingsCache = sanitized;
  fs.mkdirSync(path.dirname(EMAIL_ALERT_SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(EMAIL_ALERT_SETTINGS_FILE, JSON.stringify(sanitized, null, 2), 'utf8');
  return sanitized;
}

function isEmailSystemEnabled(key) {
  const settings = loadEmailAlertSettings();
  return settings[key] !== false;
}

// Strategy Lab EMAIL rule (frontend-controlled): master toggle + min score + min grade
// + per-strategy enable. Popups are NOT gated by this — only emails.
const STRATEGY_GRADE_RANK = { C: 0, B: 1, A: 2, 'A+': 3 };
// Per-strategy EMAIL refinement (Settings → "Per-strategy email filters"). DELIVERY-only filter
// layered on top of the strategy-lab email gates below — it never touches signal generation,
// logging, popups, or ranking. The SAME rule applies to both the forex and fixed-time framings.
// Returns false only on the HARD filters (symbol allow-list + direction); the min score / grade
// OVERRIDES are resolved inline in each gate so they can fall back to the framing's global min.
function strategyLabRulePassesSymbolDir(rule, symbol, direction) {
  if (!rule) return true;
  if (Array.isArray(rule.symbols) && rule.symbols.length) {
    const want = String(symbol || '').toUpperCase();
    if (!rule.symbols.some((s) => String(s).toUpperCase() === want)) return false;
  }
  const dir = String(rule.direction || 'ANY').toUpperCase();
  if (dir === 'LONG' && direction !== 'BUY') return false;
  if (dir === 'SHORT' && direction !== 'SELL') return false;
  return true;
}
function strategyLabEmailAllowed(strategy, score, grade, symbol, direction) {
  const s = loadEmailAlertSettings();
  if (s.strategyLab === false) return false;
  const rule = (s.strategyLabRules || {})[strategy] || null;
  const minScore = rule && Number.isFinite(Number(rule.minScore)) ? Number(rule.minScore) : Number(s.strategyLabMinScore ?? 75);
  if ((Number(score) || 0) < minScore) return false;
  const minG = String((rule && rule.minGrade) || s.strategyLabMinGrade || 'ANY').toUpperCase();
  if (minG !== 'ANY' && (STRATEGY_GRADE_RANK[String(grade || '').toUpperCase()] ?? 0) < (STRATEGY_GRADE_RANK[minG] ?? 0)) return false;
  const map = s.strategyLabStrategies || {};
  if (map[strategy] === false) return false;  // only an EXPLICIT opt-out blocks; missing = enabled (matches the UI's `?? true`)
  if (!strategyLabRulePassesSymbolDir(rule, symbol, direction)) return false;
  return true;
}

// Strategy Lab FIXED-TIME EMAIL rule (frontend-controlled): master toggle + min score
// + min grade + per-strategy enable. Independent of the forex rule above so the user can
// receive one framing without the other. Popups are NOT gated by this — only emails.
function strategyLabFttEmailAllowed(strategy, score, grade, symbol, direction) {
  const s = loadEmailAlertSettings();
  if (s.strategyLabFixedTime === false || s.strategyLabFixedTime === undefined) return false;
  const rule = (s.strategyLabRules || {})[strategy] || null;
  const minScore = rule && Number.isFinite(Number(rule.minScore)) ? Number(rule.minScore) : Number(s.strategyLabFttMinScore ?? 75);
  if ((Number(score) || 0) < minScore) return false;
  const minG = String((rule && rule.minGrade) || s.strategyLabFttMinGrade || 'ANY').toUpperCase();
  if (minG !== 'ANY' && (STRATEGY_GRADE_RANK[String(grade || '').toUpperCase()] ?? 0) < (STRATEGY_GRADE_RANK[minG] ?? 0)) return false;
  const map = s.strategyLabFttStrategies || {};
  if (map[strategy] === false) return false;  // only an EXPLICIT opt-out blocks; missing = enabled (matches the UI's `?? true`)
  if (!strategyLabRulePassesSymbolDir(rule, symbol, direction)) return false;
  return true;
}

// Strategy Controller (Settings → Strategy Controller). The master per-strategy switch that
// gates DELIVERY of any signal — popups, emails, SSE. OFF = silent everywhere. When ON, the
// optional refinements (minScore, direction/"setup", timeframes) further gate the alert.
// Missing entry = fully enabled so the live setup is unchanged until the user toggles.
function strategyDelivers(stratId, { score, direction, timeframe } = {}) {
  const ctrl = (loadEmailAlertSettings().strategyControls || {})[stratId];
  if (!ctrl) return true;
  if (ctrl.enabled === false) return false;
  if (Number.isFinite(Number(ctrl.minScore)) && (Number(score) || 0) < Number(ctrl.minScore)) return false;
  const dir = String(ctrl.direction || 'ANY').toUpperCase();
  if (dir === 'LONG' && direction !== 'BUY') return false;
  if (dir === 'SHORT' && direction !== 'SELL') return false;
  if (Array.isArray(ctrl.timeframes) && ctrl.timeframes.length && timeframe && !ctrl.timeframes.includes(String(timeframe).toUpperCase())) return false;
  return true;
}
// Strategies whose signals belong in the aggregated recent-signals table + reports (enabled
// set). Uses only the on/off flag — the per-signal score/setup/timeframe filters live in the
// dashboard's own grid filters. DB logging always continues, so muted strategies keep ranking.
function enabledStrategyIds() {
  const controls = loadEmailAlertSettings().strategyControls || {};
  return listStrategies().map((m) => m.id).filter((id) => controls[id]?.enabled !== false);
}
// True when the Strategy Controller master switch is explicitly OFF for this strategy.
// Disabled strategies must vanish from every USER-FACING surface (live page, dropdowns,
// signal log, reports, popups, emails) while still being scanned + logged in the background
// so the win-rate ranking keeps accumulating (see strategyControls design). Admin/debug
// callers can still see them by passing includeMuted=1.
function strategyMuted(stratId) {
  const ctrl = (loadEmailAlertSettings().strategyControls || {})[stratId];
  return ctrl ? ctrl.enabled === false : false;
}

async function persistEmailedPostNewsForexReport(sig, referenceId) {
  const now = new Date();
  const tradeTime = sig.tradeableAtIso ? new Date(sig.tradeableAtIso) : now;
  const eventTime = sig.event?.timeIso ? new Date(sig.event.timeIso) : tradeTime;
  const direction = sig.direction === 'UP' ? 'BUY' : sig.direction === 'DOWN' ? 'SELL' : 'HOLD';
  const id = `rpt_news_forex_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  await persistSignalEmailReport({
    id,
    signal_type: 'forex',
    reference_id: referenceId,
    symbol: sig.symbol,
    timeframe: 'M5',
    expiry: null,
    direction,
    entry_price: sig.price,
    exit_price: null,
    stop_loss: sig.stopLoss,
    take_profit_1: sig.takeProfit1,
    profit_loss_pips: null,
    confidence: sig.confidence,
    grade: sig.confidence >= 85 ? 'A+ News Setup' : sig.confidence >= 75 ? 'A News Setup' : 'B News Setup',
    outcome: 'PENDING',
    signal_time: eventTime,
    trade_time: tradeTime,
    resolved_at: null,
    email_sent_at: now,
    email_to: signalEmailTo(),
    candle_bias_tf: 'H4',
    candle_trend_tf: 'H1',
    candle_entry_tf: 'M5',
    candle_confirm_tf: 'M1',
    payload_json: JSON.stringify({
      source: 'trade_news',
      event: sig.event,
      surprise: sig.surprise,
      expectedDir: sig.expectedDir,
      realizedDir: sig.realizedDir,
      realizedMovePct: sig.realizedMovePct,
      takeProfit2: sig.takeProfit2,
      note: sig.note,
    }),
    created_at: now,
  });
}

async function persistEmailedFixedReport(prediction) {
  const tfMap = getFttCandleTimeframeMapping(prediction.expiry);
  const now = new Date();
  const id = `rpt_fixed_${prediction.id}`;
  const fixedGrade = fttReportGrade(prediction);
  const underlyingSetupGrade = prediction.indicators?.grade || null;
  await persistSignalEmailReport({
    id,
    signal_type: 'fixed',
    reference_id: prediction.id,
    symbol: prediction.symbol,
    timeframe: mapExpiryToTimeframe(prediction.expiry),
    expiry: prediction.expiry,
    direction: prediction.direction,
    entry_price: prediction.entryPrice,
    exit_price: null,
    stop_loss: null,
    take_profit_1: null,
    profit_loss_pips: null,
    confidence: prediction.confidence,
    grade: fixedGrade,
    outcome: 'PENDING',
    signal_time: prediction.entryTime ? new Date(prediction.entryTime) : now,
    trade_time: prediction.entryTime ? new Date(prediction.entryTime) : now,
    resolved_at: null,
    email_sent_at: now,
    email_to: signalEmailTo(),
    candle_bias_tf: tfMap.bias,
    candle_trend_tf: tfMap.trend,
    candle_entry_tf: tfMap.entry,
    candle_confirm_tf: tfMap.confirmation,
    payload_json: JSON.stringify({
      sourceCandleTime: prediction.sourceBarTime || null,
      sourceReceivedAt: prediction.sourceReceivedAt || null,
      calibration: prediction.calibration || null,
      expiryTime: prediction.expiryTime,
      source: prediction.source,
      reasoning: prediction.reasoning,
      underlyingSetupGrade,
      qualityTier: prediction.indicators?.qualityTier || null,
      qualityScore: prediction.indicators?.qualityScore ?? null,
      qualityReasons: prediction.indicators?.qualityReasons || [],
      riskWarnings: prediction.indicators?.riskWarnings || [],
      detectedPatterns: prediction.indicators?.detectedPatterns || [],
      volatilityState: prediction.indicators?.volatilityState || null,
    }),
    created_at: now,
  });
}

async function syncFixedReportFromPrediction(prediction) {
  if (!prediction?.id || prediction.outcome === 'PENDING') return;
  const pool = await initializeDatabase();
  if (!pool) return;
  const entry = Number(prediction.entryPrice);
  const exit = Number(prediction.exitPrice);
  let profitLoss = null;
  if (Number.isFinite(entry) && Number.isFinite(exit) && prediction.direction !== 'HOLD') {
    const raw = prediction.direction === 'UP' ? exit - entry : entry - exit;
    const pip = pipSizeForSymbol(prediction.symbol);
    profitLoss = Math.round((raw / pip) * 10) / 10;
  }
  try {
    await pool.execute(
      `UPDATE mt5_signal_email_reports
       SET outcome = ?, exit_price = ?, profit_loss_pips = ?, resolved_at = ?, trade_time = COALESCE(trade_time, ?)
       WHERE signal_type = 'fixed' AND reference_id = ?`,
      [
        prediction.outcome,
        prediction.exitPrice ?? null,
        profitLoss,
        toMysqlDate(new Date()),
        prediction.entryTime ? toMysqlDate(prediction.entryTime) : null,
        prediction.id,
      ]
    );
  } catch (err) {
    console.error('[EmailReports] Fixed report sync failed:', err.message);
  }
}

async function processForexEmailReports() {
  const pool = await initializeDatabase();
  if (!pool) return;
  const nowMs = Date.now();
  try {
    // Keep PENDING trades open for resolution; keep TP1/TP2 wins open ONLY while
    // they're young enough to still progress to a higher TP (<72h). A win older
    // than 72h is final and must NOT be re-touched (it used to get overwritten to
    // EXPIRED here, which erased real wins from win-rate scoring).
    const [rows] = await pool.query(
      "SELECT * FROM mt5_signal_email_reports WHERE signal_type = 'forex' AND (outcome = 'PENDING' OR (outcome IN ('TP1_WIN','TP2_WIN') AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 72 HOUR))) ORDER BY signal_time ASC LIMIT 50"
    );
    for (const row of rows) {
      const report = normalizeSignalEmailReportRow(row);
      const signalMs = Date.parse(report.signalTime || '');
      if (!Number.isFinite(signalMs)) continue;

      const ageHrs = (nowMs - signalMs) / (3600 * 1000);
      if (ageHrs > 72) {
        // ONLY a still-PENDING trade expires. A TP1/TP2 win is excluded above, but
        // guard defensively so a win is never relabeled EXPIRED.
        if (String(report.outcome || '').toUpperCase() === 'PENDING') {
          await pool.execute(
            "UPDATE mt5_signal_email_reports SET outcome = 'EXPIRED', resolved_at = ? WHERE id = ?",
            [toMysqlDate(), report.id]
          );
        }
        continue;
      }

      const candles = getRecentCandles(report.symbol, report.timeframe, 1000);
      if (!candles || candles.length < 2) continue;

      const replay = evaluateForexReplay(report, candles);
      // EXPIRED from the replay only means "no TP/SL hit within the candles we
      // have so far" — for a still-open trade that is simply PENDING, not expired.
      // Genuine expiry is owned solely by the ageHrs > 72 gate above, so a fresh
      // signal stays PENDING until it hits a target/stop or actually ages out.
      if (!replay.valid || replay.outcome === 'PENDING' || replay.outcome === 'EXPIRED') continue;
      if (replay.outcome === 'AMBIGUOUS') {
        await pool.execute(
          `UPDATE mt5_signal_email_reports
           SET outcome = 'AMBIGUOUS', resolved_at = ?
           WHERE id = ?`,
          [toMysqlDate(replay.resolvedAt || new Date()), report.id]
        );
        continue;
      }

      await pool.execute(
        `UPDATE mt5_signal_email_reports
         SET outcome = ?, exit_price = ?, profit_loss_pips = ?, resolved_at = ?
         WHERE id = ?`,
        [replay.outcome || 'AMBIGUOUS', replay.exitPrice ?? null, replay.profitLossPips ?? null, toMysqlDate(replay.resolvedAt || new Date()), report.id]
      );
      console.log(`[EmailReports] Resolved forex ${report.id} (${report.symbol}) -> ${replay.outcome} (${replay.profitLossPips} pips)`);
    }
  } catch (err) {
    console.error('[EmailReports] Forex outcome resolver error:', err.message);
  }
}

// Generic report date window (shared by the /reports endpoints). Either a rolling
// day-window (days=N) or a Bangladesh-time (UTC+6) calendar preset: today / yesterday /
// last7. Returns MySQL UTC datetime strings ready for signal_time range filtering.
function reportDateWindow({ days = null, preset = null } = {}) {
  const BD = 6 * 3600 * 1000;
  const nowMs = Date.now();
  let fromMs;
  let toMs = nowMs;
  let label;
  const p = preset ? String(preset).toLowerCase() : null;
  if (p === 'today' || p === 'yesterday' || p === 'last7') {
    const bdNow = new Date(nowMs + BD);
    const mid = Date.UTC(bdNow.getUTCFullYear(), bdNow.getUTCMonth(), bdNow.getUTCDate()) - BD; // BD 00:00 in real UTC
    if (p === 'today') { fromMs = mid; label = 'Today (BD)'; }
    else if (p === 'yesterday') { fromMs = mid - 86400000; toMs = mid; label = 'Yesterday (BD)'; }
    else { fromMs = mid - 6 * 86400000; label = 'Last 7 days (BD)'; }
  } else {
    const d = Math.max(1, Math.min(Number(days) || 30, 365));
    fromMs = nowMs - d * 86400000;
    label = `Last ${d} days`;
  }
  return { fromMs, toMs, from: toMysqlDate(new Date(fromMs)), to: toMysqlDate(new Date(toMs)), fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString(), preset: p, label };
}

async function querySignalEmailReports(signalType, { symbol = null, days = null, from = null, to = null, outcome = null, limit = 200 } = {}) {
  const pool = await initializeDatabase();
  if (!pool) return [];
  let sql = 'SELECT * FROM mt5_signal_email_reports WHERE signal_type = ?';
  const params = [signalType];
  if (symbol) {
    sql += ' AND symbol = ?';
    params.push(String(symbol).toUpperCase());
  }
  if (outcome) {
    sql += ' AND outcome = ?';
    params.push(String(outcome).toUpperCase());
  }
  if (from && to) {
    sql += ' AND signal_time >= ? AND signal_time < ?';
    params.push(from, to);
  } else if (days && Number(days) > 0) {
    sql += ' AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)';
    params.push(Number(days));
  }
  sql += ' ORDER BY email_sent_at DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 500));
  const [rows] = await pool.query(sql, params);
  return rows.map(normalizeSignalEmailReportRow).filter(Boolean);
}

// ── Signal Tracker — live health of given signals (system + emailed) ──────────
// Combines active rows from the system signal log + emailed forex reports into one
// live view: where each trade stands (pips/R/MFE/MAE), and an advisory health state
// that warns to MANAGE or CLOSE before the stop is hit. Real broker P/L is overlaid
// when an open MT5 position matches the signal. See backend/signalHealthEngine.js.
const SIGNAL_TRACKER_WINDOW_HOURS = Math.max(1, Number(process.env.SIGNAL_TRACKER_WINDOW_HOURS || 72));
const SIGNAL_TRACKER_COOLDOWN_MS = Math.max(60000, Number(process.env.SIGNAL_TRACKER_COOLDOWN_MS || 12 * 60 * 1000));
const signalTrackerAlertState = new Map(); // `${id}|${alertType}` -> { at, severity }

async function fetchOpenMt5Trades(pool) {
  const map = new Map();
  try {
    const [rows] = await pool.query(
      "SELECT symbol, type, volume, open_price, current_price, profit, ticket FROM mt5_trades WHERE close_time IS NULL OR UPPER(status)='OPEN' ORDER BY received_at DESC LIMIT 300",
    );
    for (const r of rows) {
      const sym = String(r.symbol || '').toUpperCase();
      if (!map.has(sym)) map.set(sym, []);
      map.get(sym).push(r);
    }
  } catch { /* table may be empty */ }
  return map;
}
function tradeDirMatches(tradeType, direction) {
  const t = String(tradeType || '').toUpperCase();
  const wantBuy = /BUY/.test(String(direction || '').toUpperCase());
  const isBuy = /BUY/.test(t) || t === '0' || t === 'POSITION_TYPE_BUY';
  const isSell = /SELL/.test(t) || t === '1' || t === 'POSITION_TYPE_SELL';
  return wantBuy ? isBuy : isSell;
}

async function buildSignalTrackerView() {
  const pool = await initializeDatabase();
  if (!pool) return { items: [], generatedAt: new Date().toISOString(), config: { windowHours: SIGNAL_TRACKER_WINDOW_HOURS } };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const winH = SIGNAL_TRACKER_WINDOW_HOURS;
  const merged = new Map();
  // System and email logs can describe the same trade, so collapse those by market
  // identity. Strategy Lab rows keep their own persisted IDs because two isolated
  // strategies can legitimately hold different entries/stops in the same market.
  const keyOf = (sym, tf, dir) => `${sym}|${tf}|${dir}`;

  try {
    const [sysRows] = await pool.query(
      "SELECT * FROM mt5_system_signal_log WHERE outcome IN ('PENDING','TP1_WIN','TP2_WIN') AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR) ORDER BY signal_time DESC LIMIT 200",
      [winH],
    );
    for (const r of sysRows) {
      const sym = String(r.symbol).toUpperCase(), tf = String(r.timeframe).toUpperCase(), dir = String(r.direction).toUpperCase();
      const ms = new Date(r.signal_time).getTime();
      if (!Number.isFinite(ms)) continue;
      if (merged.has(keyOf(sym, tf, dir))) continue;  // keep the most recent
      merged.set(keyOf(sym, tf, dir), {
        id: r.id, source: r.emailed ? 'email' : 'system', symbol: sym, timeframe: tf, direction: dir,
        signalTime: new Date(r.signal_time).toISOString(), signalMs: ms, grade: r.grade || null, outcome: r.outcome,
        entryPrice: num(r.entry_price), stopLoss: num(r.stop_loss),
        takeProfit1: num(r.take_profit_1), takeProfit2: num(r.take_profit_2), takeProfit3: num(r.take_profit_3),
      });
    }
  } catch (e) { console.error('[SignalTracker] system log query failed:', e.message); }

  try {
    const [emRows] = await pool.query(
      "SELECT * FROM mt5_signal_email_reports WHERE signal_type='forex' AND outcome IN ('PENDING','TP1_WIN','TP2_WIN') AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR) ORDER BY signal_time DESC LIMIT 100",
      [winH],
    );
    for (const r of emRows) {
      const sym = String(r.symbol).toUpperCase(), tf = String(r.timeframe || '').toUpperCase(), dir = String(r.direction).toUpperCase();
      const ms = new Date(r.signal_time).getTime();
      if (!Number.isFinite(ms)) continue;
      const k = keyOf(sym, tf, dir);
      if (merged.has(k)) continue;  // already represented by the (richer / more recent) system-log row
      let pl = null; try { pl = r.payload_json ? JSON.parse(r.payload_json) : null; } catch { pl = null; }
      merged.set(k, {
        id: r.id, source: 'email', symbol: sym, timeframe: tf, direction: dir,
        signalTime: new Date(r.signal_time).toISOString(), signalMs: ms, grade: r.grade || null, outcome: r.outcome,
        entryPrice: num(r.entry_price), stopLoss: num(r.stop_loss),
        takeProfit1: num(r.take_profit_1), takeProfit2: num(pl?.takeProfit2 ?? pl?.take_profit_2), takeProfit3: num(pl?.takeProfit3 ?? pl?.take_profit_3),
      });
    }
  } catch (e) { console.error('[SignalTracker] email reports query failed:', e.message); }

  // Strategy Lab handoff: lab signals that are actually IN the trade get the
  // same live-health lifecycle (P/L, danger detection, CLOSE/MANAGE alerts) as system
  // and emailed signals. "In the trade" = MARKET entries immediately; pending LIMIT/
  // STOP entries only once the entry really filled (persisted entry_state, else
  // detected from post-alert M1 candles via the shared fill locator — M1 so a fill
  // inside the alert's own M15 bar is not missed). Unfilled rows stay in Entry Watch.
  try {
    const [labRows] = await pool.query(
      "SELECT * FROM mt5_strategy_signals WHERE outcome IN ('PENDING','TP1_WIN','TP2_WIN') AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR) ORDER BY signal_time DESC LIMIT 200",
      [winH],
    );
    const enabled = new Set(enabledStrategyIds());
    for (const r of labRows) {
      const stratId = String(r.strategy || '');
      if (!enabled.has(stratId)) continue;                          // controller OFF = hidden everywhere
      const entryState = String(r.entry_state || '').toUpperCase();
      if (entryState === 'EXPIRED') continue;                       // trigger never came — no trade to track
      const sym = String(r.symbol).toUpperCase(), tf = String(r.timeframe).toUpperCase(), dir = String(r.direction).toUpperCase();
      const ms = new Date(r.signal_time).getTime();
      if (!Number.isFinite(ms)) continue;
      const k = `strategy-lab|${r.id}`;
      const orderType = strategySignalOrderType(r);
      let inTrade = orderType === 'MARKET' || entryState === 'FILLED';
      let filledAt = r.entry_filled_at ? new Date(r.entry_filled_at) : null;
      if (!inTrade) {
        const entry = num(r.entry_price);
        if (entry === null) continue;
        const fine = (getRecentCandles(sym, 'M1', 1000) || [])
          .map((c) => ({ ...c, timeMs: Date.parse(c.time) }))
          .filter((c) => Number.isFinite(c.timeMs) && c.timeMs >= ms);
        const coarse = fine.length ? fine : (getRecentCandles(sym, tf, 500) || [])
          .map((c) => ({ ...c, timeMs: Date.parse(c.time) }))
          .filter((c) => Number.isFinite(c.timeMs) && c.timeMs >= ms);
        const validUntilMs = r.valid_until ? Date.parse(new Date(r.valid_until).toISOString()) : NaN;
        const fillIndex = findOrderFillIndex(coarse, { isBuy: /BUY/.test(dir), entry, orderType, validUntilMs });
        inTrade = fillIndex >= 0;
        if (inTrade) {
          const fillMs = Date.parse(coarse[fillIndex]?.time || '');
          filledAt = Number.isFinite(fillMs) ? new Date(fillMs) : new Date();
          try {
            await pool.execute(
              "UPDATE mt5_strategy_signals SET entry_state='FILLED', entry_filled_at=COALESCE(entry_filled_at, ?) WHERE id=? AND COALESCE(entry_state,'WAIT') <> 'FILLED'",
              [toMysqlDate(filledAt), r.id],
            );
          } catch (e) { console.error(`[SignalTracker] failed to persist fill for ${r.id}:`, e.message); }
        }
      }
      if (!inTrade) continue;                                       // still waiting for the entry — Entry Watch owns it
      merged.set(k, {
        id: r.id, source: 'strategy-lab', strategy: stratId,
        strategyName: STRATEGY_LAB_REGISTRY[stratId]?.name || stratId,
        symbol: sym, timeframe: tf, direction: dir,
        signalTime: new Date(r.signal_time).toISOString(), signalMs: ms, grade: r.grade || null, outcome: r.outcome,
        entryPrice: num(r.entry_price), stopLoss: num(r.stop_loss),
        takeProfit1: num(r.take_profit_1), takeProfit2: num(r.take_profit_2), takeProfit3: num(r.take_profit_3),
      });
    }
  } catch (e) { console.error('[SignalTracker] strategy-lab query failed:', e.message); }

  const openTrades = await fetchOpenMt5Trades(pool);
  const dismissed = new Set();
  try {
    const [drows] = await pool.query(
      'SELECT id FROM mt5_signal_tracker_dismissed WHERE dismissed_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)', [winH],
    );
    for (const r of drows) dismissed.add(r.id);
  } catch { /* table may not exist yet */ }

  const ctxCache = new Map();
  const items = [];
  for (const sig of merged.values()) {
    if (dismissed.has(sig.id)) continue;  // user marked this trade Done — hide + no alerts
    try {
      const candles = getRecentCandles(sig.symbol, sig.timeframe, 1000);
      if (!candles || candles.length < 5) continue;
      const pip = pipSizeForSymbol(sig.symbol);
      const snap = computeSignalSnapshot({ ...sig, candles, pip, signalMs: sig.signalMs, horizonHours: winH });
      // Skip terminal trades: stop already hit (closed loss) or final target reached.
      // These are done — the outcome resolver will settle them; don't show/alert as active.
      if (snap.valid && (snap.slHit || snap.tpHit >= 3)) continue;

      const ck = `${sig.symbol}|${sig.timeframe}`;
      let ctx = ctxCache.get(ck);
      if (!ctx) {
        let sd = null, breaker = null;
        try {
          const cl = getRecentCandles(sig.symbol, sig.timeframe, 250);
          if (cl && cl.length >= 20) {
            const { adr, dailyHighLow } = computeAdrDaily(sig.symbol);
            sd = aggregateSignals({
              symbol: sig.symbol, timeframe: sig.timeframe, candles: cl,
              indicators: getRecentIndicators(sig.symbol, sig.timeframe, 500),
              marketLevels, accountSnapshot: mt5State.accountSnapshot, adr, dailyHighLow,
              h4Candles: getRecentCandles(sig.symbol, 'H4', 150), h1Candles: getRecentCandles(sig.symbol, 'H1', 150),
            }).systemDecision;
            breaker = detectBreaker(cl);
          }
        } catch { /* per-symbol resilience */ }
        ctx = { sd, breaker };
        ctxCache.set(ck, ctx);
      }

      const health = evaluateSignalHealth({ snapshot: snap, direction: sig.direction, freshDecision: ctx.sd, breaker: ctx.breaker, newsRisk: ctx.sd?.newsRisk || null });

      const cand = (openTrades.get(sig.symbol) || []).find((t) => tradeDirMatches(t.type, sig.direction));
      const real = cand ? { ticket: String(cand.ticket), profit: num(cand.profit), volume: num(cand.volume), openPrice: num(cand.open_price), currentPrice: num(cand.current_price) } : null;

      items.push({
        id: sig.id, source: sig.source, symbol: sig.symbol, timeframe: sig.timeframe, direction: sig.direction,
        strategy: sig.strategy || null, strategyName: sig.strategyName || null,
        signalTime: sig.signalTime, grade: sig.grade,
        entryPrice: sig.entryPrice, stopLoss: sig.stopLoss,
        takeProfit1: sig.takeProfit1, takeProfit2: sig.takeProfit2, takeProfit3: sig.takeProfit3,
        currentPrice: snap.currentPrice, currentPips: snap.currentPips, currentR: snap.currentR,
        mfeR: snap.mfeR, maeR: snap.maeR, distToSlPips: snap.distToSlPips,
        tpHit: snap.tpHit, slHit: snap.slHit,
        status: health.status, riskState: health.riskState, severity: health.severity,
        warningReason: health.warningReason, suggestedAction: health.suggestedAction, alertType: health.alertType,
        realPosition: real, unrealizedProfit: real ? real.profit : null,
      });
    } catch (e) { /* per-signal resilience */ }
  }
  items.sort((a, b) => (b.severity - a.severity) || (Math.abs(b.currentR || 0) - Math.abs(a.currentR || 0)));
  return { items, generatedAt: new Date().toISOString(), config: { windowHours: winH }, note: 'Advisory live health of given signals — early warning, not a guarantee. P/L is real only for matched open MT5 positions; otherwise estimated from signal levels.' };
}

// GET /api/signal-tracker — live health of all active signals.
app.get('/api/signal-tracker', async (req, res) => {
  try { res.json(await buildSignalTrackerView()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// GET /api/signal-tracker/:id — one signal's live health.
app.get('/api/signal-tracker/:id', async (req, res) => {
  try {
    const view = await buildSignalTrackerView();
    const item = view.items.find((i) => i.id === String(req.params.id));
    if (!item) return res.status(404).json({ error: 'Signal not found or no longer active.' });
    res.json({ item, generatedAt: view.generatedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/signal-tracker/:id/done — user closed the trade: drop it from the tracker
// and stop all alerts (popup + email) for it. Durable (survives restart), pruned by window.
app.post('/api/signal-tracker/:id/done', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });
  const id = String(req.params.id);
  try {
    await pool.execute(
      'INSERT INTO mt5_signal_tracker_dismissed (id, dismissed_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE dismissed_at = VALUES(dismissed_at)',
      [id, toMysqlDate()],
    );
    // Clear any pending alert dedupe state so it never re-fires for this signal.
    for (const key of signalTrackerAlertState.keys()) {
      if (key.startsWith(`${id}|`)) signalTrackerAlertState.delete(key);
    }
    // Best-effort prune of old dismissals (keep the table tiny).
    pool.execute('DELETE FROM mt5_signal_tracker_dismissed WHERE dismissed_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)', [SIGNAL_TRACKER_WINDOW_HOURS * 2]).catch(() => {});
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function sendSignalTrackerEmail(item) {
  if (!SIGNAL_ALERTS_ENABLED || !signalEmailTo() || !isEmailSystemEnabled('signalTracker')) return;
  const sym = item.symbol;
  const close = item.severity >= 3;
  const tag = close ? 'CLOSE TRADE' : 'MANAGE TRADE';
  const rTxt = item.currentR != null ? `${item.currentR}R` : '';
  const subject = `[${tag}] ${sym} ${item.timeframe} ${item.direction} ${rTxt} — ${item.warningReason}`.slice(0, 180);
  const text = [
    `AURA GOLD — SIGNAL TRACKER (${tag})`,
    `${sym} ${item.timeframe} ${item.direction}  (${item.source} signal)`,
    `Entry ${px(item.entryPrice, sym)}  SL ${px(item.stopLoss, sym)}  TP1 ${px(item.takeProfit1, sym)}`,
    `Now ${px(item.currentPrice, sym)}  |  ${item.currentPips != null ? item.currentPips + ' pips' : ''} ${rTxt ? '(' + rTxt + ')' : ''}`,
    item.unrealizedProfit != null ? `Live position P/L: ${item.unrealizedProfit}` : '',
    `Why: ${item.warningReason}`,
    `Action: ${item.suggestedAction}`,
    'Advisory early warning — not a guarantee, not financial advice.',
  ].filter(Boolean).join('\n');
  const color = close ? '#b91c1c' : '#b45309';
  const html = `<div style="font-family:Arial,sans-serif;max-width:640px">
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.12em;color:${color};text-transform:uppercase">Signal Tracker · ${tag}</p>
    <h2 style="margin:0 0 4px;color:${color}">${item.direction} ${sym} <span style="font-size:13px;color:#64748b">${item.timeframe} · ${item.source}</span></h2>
    <p style="font-size:13px;color:#0f172a;margin:2px 0"><b>${item.warningReason}</b></p>
    <table style="font-size:13px;border-collapse:collapse">
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Entry / SL / TP1</td><td>${px(item.entryPrice, sym)} / ${px(item.stopLoss, sym)} / ${px(item.takeProfit1, sym)}</td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Now</td><td><b>${px(item.currentPrice, sym)}</b>  ${item.currentPips != null ? item.currentPips + ' pips' : ''} ${rTxt ? '(' + rTxt + ')' : ''}</td></tr>
      ${item.unrealizedProfit != null ? `<tr><td style="padding:2px 10px 2px 0;color:#64748b">Live P/L</td><td><b>${item.unrealizedProfit}</b></td></tr>` : ''}
    </table>
    <p style="font-size:13px;color:#0f172a;margin:8px 0 0">Action: <b>${item.suggestedAction}</b></p>
    <p style="font-size:11px;color:#94a3b8;margin-top:8px">Advisory early warning — not a guarantee, not financial advice. — Aura Gold Signal Tracker</p></div>`;
  try {
    const trackerTo = signalEmailToFor(item.symbol, item.timeframe);
    if (!trackerTo) return;
    await sendNotificationEmail({ to: trackerTo, subject, text, html, signalId: `tracker:${item.id}:${item.alertType}` });
    console.log(`[SignalTracker] Emailed ${tag} ${item.direction} ${sym} (${item.warningReason})`);
  } catch (e) { console.error('[SignalTracker] email failed:', e.message); }
}

// Monitor loop: emit SSE popup + email when a tracked signal needs managing/closing.
// Deduped per (signal, alertType): re-alerts only on escalation or after the cooldown.
async function processSignalTracker() {
  let view;
  try { view = await buildSignalTrackerView(); } catch { return; }
  const now = Date.now();
  for (const item of view.items) {
    const actionable = item.severity >= 2 || item.alertType === 'tp_hit';
    if (!actionable || !item.alertType) continue;
    const key = `${item.id}|${item.alertType}`;
    const prev = signalTrackerAlertState.get(key);
    const escalate = !prev || item.severity > prev.severity || (now - prev.at) >= SIGNAL_TRACKER_COOLDOWN_MS;
    if (!escalate) continue;
    signalTrackerAlertState.set(key, { at: now, severity: item.severity });
    sendStreamEvent('signal_tracker_alert', {
      id: item.id, symbol: item.symbol, timeframe: item.timeframe, direction: item.direction,
      status: item.status, riskState: item.riskState, severity: item.severity,
      currentR: item.currentR, currentPips: item.currentPips, currentPrice: item.currentPrice,
      warningReason: item.warningReason, suggestedAction: item.suggestedAction, alertType: item.alertType,
      unrealizedProfit: item.unrealizedProfit, at: new Date(now).toISOString(),
    });
    // Email only for trades the user likely actually took: an emailed signal or a
    // matched real MT5 position. System-only signals still pop in-app, but don't
    // email (avoids "close" emails for signals that were never acted on).
    const worthEmailing = item.source === 'email' || item.realPosition;
    if (worthEmailing && (item.severity >= 3 || item.alertType === 'tp_hit')) {
      try { await sendSignalTrackerEmail(item); } catch { /* logged inside */ }
    }
  }
  for (const [k, v] of signalTrackerAlertState) {
    if (now - v.at > 6 * 3600 * 1000) signalTrackerAlertState.delete(k);
  }
}

// ── System Signal Log (Phase: executable-signal record) ──────────────────────
// Persist every NEW executable A/A+ forex setup the scanner finds, deduped to one
// row per symbol|timeframe|bar. `emailed` flags the ones that also went out as
// alerts; the rest are exactly the setups the email gate filtered. Outcomes are
// auto-resolved later by processSystemSignalLog (same TP/SL logic as email reports).
async function logSystemSignal(result, { emailed = false, emailReportId = null } = {}) {
  const sd = result?.systemDecision;
  if (!sd || sd.decision === 'HOLD') return;
  if (gradeRank(sd.grade) < GRADE_RANK['A SETUP']) return; // log A / A+ only
  const barIso = result.bar || null;
  const barMs = Date.parse(barIso || '');
  if (!Number.isFinite(barMs)) return;
  const pool = await initializeDatabase();
  if (!pool) return;
  const symbol = String(result.symbol).toUpperCase();
  const tf = String(result.timeframe).toUpperCase();
  const id = `ssl:${symbol}:${tf}:${barMs}`;
  const now = new Date();
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const pattern = sd.datFramework?.trigger?.pattern
    || (sd.candlePatterns || []).find((p) => p?.direction && p.direction !== 'neutral')?.name
    || 'none';
  const payload = {
    riskPlan: sd.riskPlan || null,
    datFramework: sd.datFramework || null,
    confluences: sd.confluences || [],
    calibration: result.calibration || null,
    calibratedConfidence: result.calibratedConfidence || null,
    features: sd.features || null,
    riskRewardRatio: sd.riskRewardRatio ?? null,
    htfBias: sd.htfBias || null,
    adrUsagePercent: sd.adrUsagePercent ?? null,
    signalQuality: sd.signalQuality || null,
    drive: sd.drive || null,
    premiumDiscount: sd.premiumDiscount || null,
  };
  try {
    await pool.execute(
      `INSERT INTO mt5_system_signal_log
        (id, symbol, timeframe, bar_time, signal_time, direction, grade, signal_quality, confidence,
         entry_price, stop_loss, take_profit_1, take_profit_2, take_profit_3,
         strategy_type, session, regime, pattern, emailed, email_report_id, outcome, payload_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?)
       ON DUPLICATE KEY UPDATE
         emailed = GREATEST(emailed, VALUES(emailed)),
         email_report_id = COALESCE(email_report_id, VALUES(email_report_id))`,
      [
        id, symbol, tf, toMysqlDate(barIso), toMysqlDate(now), sd.decision,
        sd.grade || null, sd.signalQuality || null, n(sd.confidence),
        n(sd.entryPrice), n(sd.stopLoss), n(sd.takeProfit1), n(sd.takeProfit2), n(sd.takeProfit3),
        sd.strategyType || 'SYSTEM_CONFLUENCE', sd.sessionContext?.reason || null, sd.regime || null, pattern,
        emailed ? 1 : 0, emailReportId, JSON.stringify(payload), toMysqlDate(now),
      ]
    );
  } catch (err) {
    console.error('[SignalLog] persist failed:', err.message);
  }
}

// Auto-resolve outcomes for logged signals, mirroring processForexEmailReports:
// expire >72h-old, otherwise replay against recent candles (conservative AMBIGUOUS).
async function processSystemSignalLog() {
  const pool = await initializeDatabase();
  if (!pool) return;
  const nowMs = Date.now();
  try {
    // Same rule as the email-report resolver: PENDING stays open; a TP1/TP2 win is
    // only re-checked while <72h (could still hit a higher TP). Wins ≥72h are final
    // and excluded — they must never be overwritten to EXPIRED.
    const [rows] = await pool.query(
      "SELECT * FROM mt5_system_signal_log WHERE (outcome = 'PENDING' OR (outcome IN ('TP1_WIN','TP2_WIN') AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 72 HOUR))) ORDER BY signal_time ASC LIMIT 100"
    );
    for (const row of rows) {
      const signalMs = row.signal_time ? new Date(row.signal_time).getTime() : NaN;
      if (!Number.isFinite(signalMs)) continue;
      const ageHrs = (nowMs - signalMs) / (3600 * 1000);
      if (ageHrs > 72) {
        // Only a still-PENDING trade expires; never relabel a recorded win.
        if (String(row.outcome || '').toUpperCase() === 'PENDING') {
          await pool.execute("UPDATE mt5_system_signal_log SET outcome = 'EXPIRED', resolved_at = ? WHERE id = ?", [toMysqlDate(), row.id]);
        }
        continue;
      }
      const candles = getRecentCandles(row.symbol, row.timeframe, 1000);
      if (!candles || candles.length < 2) continue;
      const report = {
        symbol: row.symbol, timeframe: row.timeframe,
        signalTime: new Date(row.signal_time).toISOString(),
        direction: row.direction, entryPrice: row.entry_price, stopLoss: row.stop_loss,
        takeProfit1: row.take_profit_1,
        payload: { takeProfit2: row.take_profit_2, takeProfit3: row.take_profit_3 },
        outcome: row.outcome, exitPrice: row.exit_price, resolvedAt: row.resolved_at,
      };
      const replay = evaluateForexReplay(report, candles);
      // Same as the email-report resolver: replay 'EXPIRED' = "no hit yet", keep
      // PENDING. Real expiry is the ageHrs > 72 gate above.
      if (!replay.valid || replay.outcome === 'PENDING' || replay.outcome === 'EXPIRED') continue;
      if (replay.outcome === 'AMBIGUOUS') {
        await pool.execute("UPDATE mt5_system_signal_log SET outcome = 'AMBIGUOUS', resolved_at = ? WHERE id = ?", [toMysqlDate(replay.resolvedAt || new Date()), row.id]);
        continue;
      }
      await pool.execute(
        `UPDATE mt5_system_signal_log
         SET outcome = ?, exit_price = ?, profit_loss_pips = ?, tp_hit_level = ?, mfe_pips = ?, mae_pips = ?, resolved_at = ?
         WHERE id = ?`,
        [replay.outcome || 'AMBIGUOUS', replay.exitPrice ?? null, replay.profitLossPips ?? null, replay.tpHitLevel ?? null, replay.mfePips ?? null, replay.maePips ?? null, toMysqlDate(replay.resolvedAt || new Date()), row.id]
      );
    }
  } catch (err) {
    console.error('[SignalLog] outcome resolver error:', err.message);
  }
}

// Open the trade-outcome ledger for a forecast that just became EXECUTED. Captures
// the TP2/TP3 levels from the live systemDecision (the forecast row only stores TP1)
// and flags it PENDING so processForecastTradeOutcomes will settle it later.
async function initForecastTrade(pool, id, sd) {
  if (!pool) return;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  try {
    await pool.execute(
      `UPDATE mt5_execution_forecasts
          SET take_profit_2 = COALESCE(take_profit_2, ?),
              take_profit_3 = COALESCE(take_profit_3, ?),
              trade_outcome = COALESCE(trade_outcome, 'PENDING')
        WHERE id = ?`,
      [n(sd?.takeProfit2), n(sd?.takeProfit3), id],
    );
  } catch (err) {
    console.error('[Forecast] initForecastTrade failed:', err.message);
  }
}

// Settle WIN/LOSS for forecasts that became EXECUTED — replays the entry/SL/TP
// ladder against real candles, exactly like processSystemSignalLog. This is the
// forecast "track record": a setup we announced ready is only a win if the trade
// actually reached target before stop. Conservative same-bar handling (AMBIGUOUS).
async function processForecastTradeOutcomes() {
  const pool = await initializeDatabase();
  if (!pool) return;
  const nowMs = Date.now();
  try {
    const [rows] = await pool.query(
      "SELECT * FROM mt5_execution_forecasts WHERE status='EXECUTED' AND trade_outcome IN ('PENDING','TP1_WIN','TP2_WIN') ORDER BY actual_execution_time ASC LIMIT 100"
    );
    for (const row of rows) {
      const entryMs = row.actual_execution_time ? new Date(row.actual_execution_time).getTime() : NaN;
      if (!Number.isFinite(entryMs)) continue;
      const ageHrs = (nowMs - entryMs) / (3600 * 1000);
      if (ageHrs > 72) {
        await pool.execute("UPDATE mt5_execution_forecasts SET trade_outcome='EXPIRED', trade_resolved_at=? WHERE id=?", [toMysqlDate(), row.id]);
        continue;
      }
      const candles = getRecentCandles(row.symbol, row.timeframe, 1000);
      if (!candles || candles.length < 2) continue;
      const report = {
        symbol: row.symbol, timeframe: row.timeframe,
        signalTime: new Date(row.actual_execution_time).toISOString(),
        direction: row.decision, entryPrice: row.entry_price, stopLoss: row.stop_loss,
        takeProfit1: row.take_profit_1,
        payload: { takeProfit2: row.take_profit_2, takeProfit3: row.take_profit_3 },
        outcome: row.trade_outcome, exitPrice: row.trade_exit_price, resolvedAt: row.trade_resolved_at,
      };
      const replay = evaluateForexReplay(report, candles);
      // Same convention as the signal-log resolver: replay 'EXPIRED'/'PENDING' = "no
      // hit yet", stay PENDING. Real expiry is the ageHrs > 72 gate above.
      if (!replay.valid || replay.outcome === 'PENDING' || replay.outcome === 'EXPIRED') continue;
      if (replay.outcome === 'AMBIGUOUS') {
        await pool.execute("UPDATE mt5_execution_forecasts SET trade_outcome='AMBIGUOUS', trade_resolved_at=? WHERE id=?", [toMysqlDate(replay.resolvedAt || new Date()), row.id]);
        continue;
      }
      await pool.execute(
        `UPDATE mt5_execution_forecasts
            SET trade_outcome=?, trade_exit_price=?, trade_pips=?, trade_tp_hit_level=?, trade_mfe_pips=?, trade_mae_pips=?, trade_resolved_at=?
          WHERE id=?`,
        [replay.outcome || 'AMBIGUOUS', replay.exitPrice ?? null, replay.profitLossPips ?? null, replay.tpHitLevel ?? null, replay.mfePips ?? null, replay.maePips ?? null, toMysqlDate(replay.resolvedAt || new Date()), row.id]
      );
    }
  } catch (err) {
    console.error('[Forecast] Trade outcome resolver error:', err.message);
  }
}

// Win/loss track-record summary for EXECUTED forecasts (overall + by ETA basis).
function summarizeForecastTradeOutcomes(rows) {
  const bucket = () => ({ total: 0, settled: 0, wins: 0, losses: 0, ambiguous: 0, expired: 0, pending: 0, netPips: 0, netR: 0, rCount: 0 });
  const tally = (b, r) => {
    b.total += 1;
    const o = String(r.tradeOutcome || 'PENDING').toUpperCase();
    if (o.endsWith('_WIN') || o === 'WIN') { b.wins += 1; b.settled += 1; }
    else if (o === 'LOSS') { b.losses += 1; b.settled += 1; }
    else if (o === 'AMBIGUOUS') b.ambiguous += 1;
    else if (o === 'EXPIRED') b.expired += 1;
    else b.pending += 1;
    if (Number.isFinite(r.tradePips)) b.netPips += r.tradePips;
    // R-multiple: realized pips ÷ initial risk (|entry-SL|). Think in R, not pips.
    if (o.endsWith('_WIN') || o === 'WIN' || o === 'LOSS') {
      const rm = rMultiple(r.symbol, r.entryPrice, r.stopLoss, r.tradePips);
      if (rm !== null) { b.netR += rm; b.rCount += 1; }
    }
  };
  const finalize = (b) => ({
    ...b,
    netPips: Math.round(b.netPips * 10) / 10,
    netR: Math.round(b.netR * 100) / 100,
    expectancyR: b.rCount ? Math.round((b.netR / b.rCount) * 100) / 100 : null,
    winRate: (b.wins + b.losses) ? Math.round((b.wins / (b.wins + b.losses)) * 100) : 0,
  });
  const overall = bucket();
  const byBasis = new Map();
  for (const r of rows) {
    tally(overall, r);
    const basis = r.forecastBasis || 'UNKNOWN';
    if (!byBasis.has(basis)) byBasis.set(basis, { basis, ...bucket() });
    tally(byBasis.get(basis), r);
  }
  return {
    overall: finalize(overall),
    byBasis: [...byBasis.values()].map((b) => ({ basis: b.basis, ...finalize(b) })).sort((a, b) => b.total - a.total),
  };
}

function normalizeSystemSignalRow(row) {
  if (!row) return null;
  let payload = null;
  try { payload = row.payload_json ? JSON.parse(row.payload_json) : null; } catch { payload = null; }
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    barTime: row.bar_time ? new Date(row.bar_time).toISOString() : null,
    signalTime: row.signal_time ? new Date(row.signal_time).toISOString() : null,
    direction: row.direction,
    grade: row.grade || null,
    signalQuality: row.signal_quality || null,
    confidence: num(row.confidence),
    entryPrice: num(row.entry_price),
    stopLoss: num(row.stop_loss),
    takeProfit1: num(row.take_profit_1),
    takeProfit2: num(row.take_profit_2),
    takeProfit3: num(row.take_profit_3),
    strategyType: row.strategy_type || null,
    session: row.session || null,
    regime: row.regime || null,
    pattern: row.pattern || null,
    emailed: Boolean(row.emailed),
    emailReportId: row.email_report_id || null,
    outcome: row.outcome || 'PENDING',
    exitPrice: num(row.exit_price),
    profitLossPips: num(row.profit_loss_pips),
    tpHitLevel: row.tp_hit_level === null || row.tp_hit_level === undefined ? null : Number(row.tp_hit_level),
    mfePips: num(row.mfe_pips),
    maePips: num(row.mae_pips),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    payload,
  };
}

function summarizeSignalLog(rows) {
  const bucket = () => ({ total: 0, settled: 0, wins: 0, losses: 0, netPips: 0 });
  const tally = (b, r) => {
    b.total += 1;
    const o = String(r.outcome || 'PENDING').toUpperCase();
    if (o.endsWith('_WIN') || o === 'WIN') { b.wins += 1; b.settled += 1; }
    else if (o === 'LOSS') { b.losses += 1; b.settled += 1; }
    if (Number.isFinite(r.profitLossPips)) b.netPips += r.profitLossPips;
  };
  const finalize = (b) => ({
    ...b,
    netPips: Math.round(b.netPips * 10) / 10,
    winRate: (b.wins + b.losses) ? Math.round((b.wins / (b.wins + b.losses)) * 100) : 0,
  });
  const all = bucket(); const emailed = bucket(); const filtered = bucket();
  for (const r of rows) {
    tally(all, r);
    tally(r.emailed ? emailed : filtered, r);
  }
  return { all: finalize(all), emailed: finalize(emailed), filtered: finalize(filtered) };
}

async function querySystemSignalLog({ days = 30, from = null, to = null, symbol = null, grade = null, emailed = null, outcome = null, limit = 300 } = {}) {
  const pool = await initializeDatabase();
  if (!pool) return { rows: [], summary: summarizeSignalLog([]) };
  let sql = 'SELECT * FROM mt5_system_signal_log WHERE 1=1';
  const params = [];
  if (symbol) { sql += ' AND symbol = ?'; params.push(String(symbol).toUpperCase()); }
  if (grade) { sql += ' AND grade = ?'; params.push(grade); }
  if (emailed === true || emailed === false) { sql += ' AND emailed = ?'; params.push(emailed ? 1 : 0); }
  if (outcome) { sql += ' AND outcome = ?'; params.push(String(outcome).toUpperCase()); }
  if (from && to) { sql += ' AND signal_time >= ? AND signal_time < ?'; params.push(from, to); }
  else if (days && Number(days) > 0) { sql += ' AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)'; params.push(Number(days)); }
  sql += ' ORDER BY signal_time DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 300, 1), 1000));
  const [rows] = await pool.query(sql, params);
  const normalized = rows.map(normalizeSystemSignalRow).filter(Boolean);
  return { rows: normalized, summary: summarizeSignalLog(normalized) };
}

// ── Loss autopsy (Task #2, read-only) ────────────────────────────────────────
// Mine settled system-signal-log outcomes by feature/category to surface what
// systematically WINS vs LOSES — the foundation for outcome-weighted scoring.
// Read-only: computes stats, changes nothing. Honest sample-confidence labels so
// thin categories aren't over-trusted. Count-preserving by design (analysis only).
function isWinOutcome(o) { const s = String(o || '').toUpperCase(); return s === 'WIN' || s.endsWith('_WIN'); }
function isLossOutcome(o) { return String(o || '').toUpperCase() === 'LOSS'; }

// Feature → bucket helpers (derive interpretable categories from the stored features).
function adxBucket(v) {
  if (v === null || v === undefined) return 'unknown'; // Number(null) === 0, guard it
  const n = Number(v);
  if (!Number.isFinite(n)) return 'unknown';
  if (n < 20) return 'ranging (<20)';
  if (n < 25) return 'transitional (20-25)';
  if (n < 40) return 'trending (25-40)';
  return 'strong-trend (40+)';
}
function adrBucket(v) {
  if (v === null || v === undefined) return 'unknown';
  const n = Number(v);
  if (!Number.isFinite(n)) return 'unknown';
  if (n < 50) return 'fresh (<50%)';
  if (n < 80) return 'mid (50-80%)';
  if (n < 100) return 'late (80-100%)';
  return 'exhausted (100%+)';
}
function htfAlignment(direction, htfBias) {
  const dir = String(direction || '').toUpperCase();
  const bias = String(htfBias || '').toLowerCase();
  if (!bias || bias === 'neutral' || bias === 'none') return 'neutral-HTF';
  const isBuy = dir.includes('BUY');
  const isSell = dir.includes('SELL');
  const bullish = bias.includes('bull') || bias.includes('up');
  const bearish = bias.includes('bear') || bias.includes('down');
  if ((isBuy && bullish) || (isSell && bearish)) return 'aligned-HTF';
  if ((isBuy && bearish) || (isSell && bullish)) return 'counter-HTF';
  return 'neutral-HTF';
}
function autopsyConfidenceBucket(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return 'unknown';
  if (n >= 90) return '90+';
  if (n >= 80) return '80-89';
  if (n >= 70) return '70-79';
  return '<70';
}

function autopsyDimensions(row) {
  const f = row.payload?.features || {};
  return {
    grade: row.grade || 'unknown',
    signalQuality: row.signalQuality || 'unknown',
    pattern: row.pattern || 'none',
    session: row.session || 'none',
    regime: row.regime || 'unknown',
    strategyType: row.strategyType || 'unknown',
    direction: row.direction || 'unknown',
    emailed: row.emailed ? 'EMAILED' : 'FILTERED',
    symbol: row.symbol || 'unknown',
    timeframe: row.timeframe || 'unknown',
    confidence: autopsyConfidenceBucket(row.confidence),
    adxRegime: adxBucket(f.adxValue),
    htfAlignment: htfAlignment(row.direction, f.htfBias),
    adrUsage: adrBucket(f.adrUsagePercent),
  };
}

function autopsyAccumulate(bucket, row) {
  bucket.total += 1;
  if (isWinOutcome(row.outcome)) bucket.wins += 1;
  else if (isLossOutcome(row.outcome)) bucket.losses += 1;
  else { bucket.unsettled += 1; return; }
  if (Number.isFinite(row.profitLossPips)) bucket.netPips += row.profitLossPips;
  if (Number.isFinite(row.mfePips)) { bucket.mfeSum += row.mfePips; bucket.mfeN += 1; }
  if (Number.isFinite(row.maePips)) { bucket.maeSum += row.maePips; bucket.maeN += 1; }
}
function autopsyFinalize(bucket) {
  const settled = bucket.wins + bucket.losses;
  return {
    total: bucket.total,
    settled,
    wins: bucket.wins,
    losses: bucket.losses,
    winRate: settled ? Math.round((bucket.wins / settled) * 1000) / 10 : null,
    expectancyPips: settled ? Math.round((bucket.netPips / settled) * 10) / 10 : null,
    avgMfePips: bucket.mfeN ? Math.round((bucket.mfeSum / bucket.mfeN) * 10) / 10 : null,
    avgMaePips: bucket.maeN ? Math.round((bucket.maeSum / bucket.maeN) * 10) / 10 : null,
    confidence: sampleConfidence(settled),
  };
}
const emptyAutopsyBucket = () => ({ total: 0, wins: 0, losses: 0, unsettled: 0, netPips: 0, mfeSum: 0, mfeN: 0, maeSum: 0, maeN: 0 });

async function runLossAutopsy({ days = 90, symbol = null, minSample = 8 } = {}) {
  // Pull a wide window of settled-or-not rows; we settle in JS so totals include
  // pending/expired for context but win-rate uses only win/loss.
  const { rows } = await querySystemSignalLog({ days, symbol, limit: 1000 });
  const DIMS = ['grade', 'signalQuality', 'pattern', 'session', 'regime', 'strategyType', 'direction', 'emailed', 'symbol', 'timeframe', 'confidence', 'adxRegime', 'htfAlignment', 'adrUsage'];
  const groups = Object.fromEntries(DIMS.map((d) => [d, {}]));
  const overall = emptyAutopsyBucket();
  for (const row of rows) {
    autopsyAccumulate(overall, row);
    const dims = autopsyDimensions(row);
    for (const d of DIMS) {
      const v = dims[d];
      (groups[d][v] ||= emptyAutopsyBucket());
      autopsyAccumulate(groups[d][v], row);
    }
  }
  const byDimension = {};
  const flat = [];
  for (const d of DIMS) {
    byDimension[d] = Object.entries(groups[d])
      .map(([value, b]) => ({ dimension: d, value, ...autopsyFinalize(b) }))
      .sort((a, b) => (b.settled - a.settled));
    for (const entry of byDimension[d]) flat.push(entry);
  }
  // Loss clusters: enough settled to trust + losing or negative expectancy, worst first.
  const scored = flat.filter((e) => e.settled >= minSample);
  const lossClusters = scored
    .filter((e) => (e.winRate !== null && e.winRate < 50) || (e.expectancyPips !== null && e.expectancyPips < 0))
    .sort((a, b) => (a.winRate - b.winRate) || (a.expectancyPips - b.expectancyPips))
    .slice(0, 15);
  const winClusters = scored
    .filter((e) => e.winRate !== null && e.winRate >= 55 && e.expectancyPips > 0)
    .sort((a, b) => (b.winRate - a.winRate) || (b.expectancyPips - a.expectancyPips))
    .slice(0, 15);
  return {
    params: { days, symbol, minSample },
    overall: autopsyFinalize(overall),
    sampleNote: overall.wins + overall.losses < 30
      ? 'Thin sample — outcomes still accruing since the recent resolver fix; treat clusters as directional, not conclusive.'
      : null,
    byDimension,
    lossClusters,
    winClusters,
  };
}

// ── MFE/MAE → SL/TP calibration (Task #4, read-only) ─────────────────────────
// Use recorded max-favorable (MFE) / max-adverse (MAE) excursion per signal to
// see whether stops clip winners and whether targets capture the available move.
// Everything is expressed in R-multiples (excursion ÷ stop distance) so it's
// comparable across symbols. Read-only: emits SUGGESTIONS only; the actual SL/TP
// change happens later, validated on the replay/OOS harness. Count-preserving.
function percentileAsc(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))));
  return Math.round(sortedAsc[idx] * 100) / 100;
}

function deriveSlTpSuggestions(winnerMaeR, loserMfeR, allMfeR, minSample) {
  const settled = winnerMaeR.length + loserMfeR.length;
  if (settled < minSample) return { ready: false, note: `Need ≥${minSample} settled (have ${settled}).` };
  const out = [];
  // Stop sizing: how deep do WINNERS dip before working? (MAE-R of winners.)
  const wP75 = percentileAsc(winnerMaeR, 75);
  const wP90 = percentileAsc(winnerMaeR, 90);
  if (wP75 !== null) {
    if (wP75 >= 0.85) out.push(`Stops may be clipping winners — 75% of winners dipped to ${wP75}R adverse before working; consider widening the stop ~${Math.round((Math.max(wP90, 1.05) - 1) * 100)}%.`);
    else if (wP90 !== null && wP90 <= 0.6) out.push(`Stops have headroom — even 90% of winners only dipped to ${wP90}R; a tighter stop would improve R-multiple without clipping winners.`);
    else out.push(`Stop distance looks reasonable — winner MAE p75 ${wP75}R, p90 ${wP90}R (within the 1R stop).`);
  }
  // Target sizing: how far does price actually run? (overall MFE-R + losers' MFE-R.)
  const aP50 = percentileAsc(allMfeR, 50);
  const aP75 = percentileAsc(allMfeR, 75);
  const aP90 = percentileAsc(allMfeR, 90);
  if (aP75 !== null) {
    out.push(`Realistic reach: MFE p50 ${aP50}R · p75 ${aP75}R · p90 ${aP90}R. Suggested targets TP1≈${aP50}R, TP2≈${aP75}R, TP3≈${aP90}R (vs current 1/2/3R).`);
    if (aP90 < 3) out.push(`TP3 at 3R is rarely reached (p90 only ${aP90}R) — lowering it would bank more of the move.`);
  }
  const lP50 = percentileAsc(loserMfeR, 50);
  if (lP50 !== null && lP50 >= 0.8) out.push(`Losers often run favorably first (median ${lP50}R MFE before failing) — a partial TP / move-to-breakeven at ~${lP50}R would rescue R from many eventual losers.`);
  return { ready: true, suggestions: out };
}

// Cap per-trade excursion R before percentiles/suggestions. A tiny stop distance or
// post-close drift over the 72h horizon can yield absurd MFE-R (e.g. 147R) that
// blows out the p75/p90 and produces unrealistic target guidance. Clamp to a sane
// max so one outlier can't distort the suggestion. Configurable via SLTP_MAX_R.
const SLTP_MAX_R = Math.max(2, Number(process.env.SLTP_MAX_R || 10));

async function runSlTpCalibration({ days = 90, symbol = null, minSample = 8 } = {}) {
  const { rows } = await querySystemSignalLog({ days, symbol, limit: 1000 });
  const bySymbol = {};
  const capR = (v) => (v === null ? null : Math.min(v, SLTP_MAX_R));
  for (const r of rows) {
    const entry = Number(r.entryPrice);
    const sl = Number(r.stopLoss);
    if (!Number.isFinite(entry) || !Number.isFinite(sl)) continue;
    const pip = pipSizeForSymbol(r.symbol);
    const stopPips = Math.abs(entry - sl) / pip;
    if (!(stopPips > 0)) continue;
    const mfeRraw = Number.isFinite(r.mfePips) ? r.mfePips / stopPips : null;
    const maeRraw = Number.isFinite(r.maePips) ? Math.abs(r.maePips) / stopPips : null;
    const mfeR = capR(mfeRraw);
    const maeR = capR(maeRraw);
    const g = (bySymbol[r.symbol] ||= { rows: 0, stopPipsSum: 0, capped: 0, winnersMaeR: [], losersMfeR: [], allMfeR: [] });
    g.rows += 1;
    g.stopPipsSum += stopPips;
    if ((mfeRraw !== null && mfeRraw > SLTP_MAX_R) || (maeRraw !== null && maeRraw > SLTP_MAX_R)) g.capped += 1;
    if (mfeR !== null) g.allMfeR.push(mfeR);
    if (isWinOutcome(r.outcome) && maeR !== null) g.winnersMaeR.push(maeR);
    else if (isLossOutcome(r.outcome) && mfeR !== null) g.losersMfeR.push(mfeR);
  }
  const sortAsc = (a) => [...a].sort((x, y) => x - y);
  const perSymbol = {};
  for (const [sym, g] of Object.entries(bySymbol)) {
    const wMae = sortAsc(g.winnersMaeR);
    const lMfe = sortAsc(g.losersMfeR);
    const aMfe = sortAsc(g.allMfeR);
    const settled = g.winnersMaeR.length + g.losersMfeR.length;
    perSymbol[sym] = {
      sampleRows: g.rows,
      settled,
      confidence: sampleConfidence(settled),
      cappedOutliers: g.capped,         // trades whose excursion R was clamped to capR
      capR: SLTP_MAX_R,
      avgStopPips: g.rows ? Math.round((g.stopPipsSum / g.rows) * 10) / 10 : null,
      winnerMaeR: { n: wMae.length, p50: percentileAsc(wMae, 50), p75: percentileAsc(wMae, 75), p90: percentileAsc(wMae, 90) },
      loserMfeR: { n: lMfe.length, p50: percentileAsc(lMfe, 50), p75: percentileAsc(lMfe, 75), p90: percentileAsc(lMfe, 90) },
      allMfeR: { n: aMfe.length, p50: percentileAsc(aMfe, 50), p75: percentileAsc(aMfe, 75), p90: percentileAsc(aMfe, 90) },
      suggestions: deriveSlTpSuggestions(wMae, lMfe, aMfe, minSample),
    };
  }
  const totalSettled = Object.values(bySymbol).reduce((s, g) => s + g.winnersMaeR.length + g.losersMfeR.length, 0);
  return {
    params: { days, symbol, minSample },
    perSymbol,
    capR: SLTP_MAX_R,
    note: totalSettled < 30
      ? `Thin sample — suggestions are directional until more signals settle. Excursion R is capped at ${SLTP_MAX_R}R so outliers (tiny stops / 72h drift) don't distort percentiles.`
      : `Suggestions are advisory and must be validated on the replay/OOS harness before changing live SL/TP. Excursion R is capped at ${SLTP_MAX_R}R; see cappedOutliers per symbol.`,
  };
}

async function sendForexAlert(result) {
  if (!signalEmailTo()) return false;
  if (!isEmailSystemEnabled('forexScanner')) return false;
  const stale = shouldSkipStaleForexAlert(result);
  if (stale) {
    console.warn(`[Scanner] Skipped stale FOREX ${result.symbol} ${result.timeframe}: age ${Math.round(stale.ageMs / 1000)}s > max ${Math.round(stale.maxAgeMs / 1000)}s`);
    recordSkippedAlert({ type: 'FOREX', symbol: result.symbol, timeframe: result.timeframe, reason: 'STALE', ageMs: stale.ageMs, maxAgeMs: stale.maxAgeMs, signalId: `forex:${result.symbol}:${result.timeframe}:${result.bar}` });
    return false;
  }
  const sd = result.systemDecision;
  const calibration = await getForexCalibrationSnapshot(result);
  result.calibration = calibration;
  const calGate = calibrationGateDecision('forex', calibration);
  if (calGate.action === 'suppress') {
    console.warn(`[Calibration] Suppressed FOREX ${result.symbol} ${result.timeframe}: ${calGate.reason}`);
    recordSkippedAlert({ type: 'FOREX', symbol: result.symbol, timeframe: result.timeframe, reason: 'CALIBRATION', detail: calGate.reason, signalId: `forex:${result.symbol}:${result.timeframe}:${result.bar}` });
    return false;
  }
  if (calGate.action === 'shadow') {
    console.warn(`[Calibration][OBSERVE] Would suppress FOREX ${result.symbol} ${result.timeframe}: ${calGate.reason} (set forex calibration mode to 'enforce' to act)`);
    recordWouldSuppress({ type: 'FOREX', symbol: result.symbol, timeframe: result.timeframe, reason: calGate.reason, calibration });
  }
  const calConfidence = blendCalibratedConfidence(sd.confidence, calibration);
  result.calibratedConfidence = calConfidence;
  const displayScore = calConfidence.adjusted ? `${calConfidence.value}/100 (raw ${calConfidence.raw})` : `${Math.round(sd.confidence)}/100`;
  const conf = sd.confluences || [];
  const news = sd.newsRisk;
  const dat = sd.datFramework;
  const risk = sd.riskPlan;
  const pattern = dat?.trigger?.pattern || sd.candlePatterns?.find((p) => p.direction !== 'neutral')?.name || 'Structure trigger';
  // Drive label line (advisory): 2nd drive = higher quality; 1st drive = fakeout risk.
  const drive = sd.drive;
  const driveActive = drive && drive.label && drive.label !== 'NONE';
  const driveText = driveActive
    ? (drive.label === 'SECOND_DRIVE'
        ? `Drive: 2nd drive${drive.basis ? ` (${drive.basis === 'FAILED_FIRST' ? 'after shakeout' : 'after retest'})` : ''} ✓`
        : `Drive: 1st drive — fakeout risk, wait for the second`)
    : '';
  // Premium/discount location line (advisory): buy discount / sell premium.
  const pd = sd.premiumDiscount;
  const pdText = pd
    ? `Zone: ${pd.zone} ${pd.pct}%${pd.fit === 'GOOD' ? ' ✓ (well-located)' : pd.fit === 'POOR' ? ' ⚠ (against location — buy discount / sell premium)' : ''}`
    : '';
  const pdColor = !pd ? '#475569' : pd.fit === 'GOOD' ? '#047857' : pd.fit === 'POOR' ? '#b45309' : '#475569';
  const money = (value) => value === null || value === undefined ? 'n/a' : `$${Number(value).toFixed(2)}`;
  const quality = sd.signalQuality || setupLabel(sd.grade);
  const sentAt = new Date();
  const signalTime = result.sourceReceivedAt || result.bar || sentAt;
  const timingMeta = buildAlertTimingMeta({ signalTime, sentAt, tradeTime: result.bar || signalTime });
  const subject = `[FOREX TRADE | ${quality}] ${sd.decision.replace('_', ' ')} ${result.symbol} ${result.timeframe} | Score ${displayScore}`;
  const text = [
    `AURA GOLD - FOREX TRADE SIGNAL`,
    timingMeta.text,
    '',
    `Trade type: Forex spot/CFD trade with stop loss and take profits`,
    `Strategy: ${sd.strategyType || 'SYSTEM_CONFLUENCE'}`,
    calibration.winRate !== null ? `Calibrated probability: ${calibration.winRate}% (${calibration.bucket}, ${calibration.settled} settled)` : 'Calibrated probability: n/a',
    calConfidence.adjusted ? calConfidence.note : '',
    `${result.symbol} ${result.timeframe} | ${sd.decision} | ${quality} | Grade ${sd.grade} | Score ${displayScore}`,
    `Entry ${px(sd.entryPrice, result.symbol)}  SL ${px(sd.stopLoss, result.symbol)}  TP1 ${px(sd.takeProfit1, result.symbol)}  TP2 ${px(sd.takeProfit2, result.symbol)}  TP3 ${px(sd.takeProfit3, result.symbol)}`,
    `RR ${sd.riskRewardRatio ?? 'n/a'} | Entry trigger ${sd.entryTrigger || 'IMMEDIATE'} | ${sd.timingTip || ''}`,
    dat ? `DAT: Direction ${dat.direction.pass ? 'PASS' : 'FAIL'} (${dat.direction.reason}) | Area ${dat.area.pass ? 'PASS' : 'FAIL'} | Trigger ${dat.trigger.pass ? 'PASS' : 'FAIL'} (${pattern})` : '',
    driveText,
    pdText,
    sd.sessionContext ? `Session: ${sd.sessionContext.reason}` : '',
    risk ? '' : '',
    risk ? 'POSITION PLAN' : '',
    risk ? `Account equity: ${money(risk.equity)}` : '',
    risk ? `Risk: ${risk.riskPercent}% | Amount to risk / max loss: ${money(risk.amountToRisk ?? risk.riskAmount ?? risk.maxLoss)}` : '',
    risk ? `Suggested lot size: ${risk.suggestedLotSize ?? 'n/a'} lots` : '',
    risk ? `Approx margin / investment needed: ${money(risk.marginRequired ?? risk.amountToInvestApprox)}` : '',
    risk ? `Multiplier / leverage used: ${risk.multiplier || `${risk.leverage || 'n/a'}x`}` : '',
    risk ? `Stop distance: ${risk.stopPips ?? 'n/a'} pips | Loss if SL hits: -${money(risk.lossAtStop ?? risk.maxLoss)}` : '',
    risk ? '' : '',
    risk ? 'PROFIT PLAN' : '',
    risk ? `TP1 ${px(sd.takeProfit1, result.symbol)} | Approx profit: ${money(risk.profitAtTp1)}` : '',
    risk ? `TP2 ${px(sd.takeProfit2, result.symbol)} | Approx profit: ${money(risk.profitAtTp2)}` : '',
    risk ? `TP3 ${px(sd.takeProfit3, result.symbol)} | Approx profit: ${money(risk.profitAtTp3)}` : '',
    sd.entryReason ? `Entry reason: ${sd.entryReason}` : '',
    sd.slReason ? `SL reason: ${sd.slReason}` : '',
    sd.tpReason ? `TP reason: ${sd.tpReason}` : '',
    news && (news.block || news.caution) ? `News: ${news.reason}` : 'News: clear',
    `Confluences: ${conf.map((c) => `${c.name}+${c.points}`).join(', ') || 'none'}`,
    '',
    'Advisory only — not financial advice. Manage your own risk.',
  ].join('\n');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:680px">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.12em;color:#b45309;text-transform:uppercase">Forex Trade Signal</p>
      <h2 style="margin:0 0 4px;color:${sd.decision.includes('BUY') ? '#047857' : sd.decision.includes('SELL') ? '#b91c1c' : '#334155'}">${sd.decision.replace('_', ' ')} ${result.symbol} <span style="font-size:13px;color:#64748b">${result.timeframe}</span></h2>
      ${timingMeta.html}
      <p style="margin:0 0 8px;font-size:12px;color:#64748b">Trade type: Forex spot/CFD setup with SL/TP management.</p>
      <p style="margin:0 0 8px"><b>${quality}</b> · ${sd.grade} · ${sd.strategyType || 'SYSTEM_CONFLUENCE'} · Score ${Math.round(sd.confidence)}/100 · RR ${sd.riskRewardRatio ?? 'n/a'} · ${sd.entryTrigger || 'IMMEDIATE'}</p>
      <table style="font-size:13px;border-collapse:collapse">
        <tr><td style="padding:2px 10px 2px 0;color:#64748b">Entry</td><td><b>${px(sd.entryPrice, result.symbol)}</b></td></tr>
        <tr><td style="padding:2px 10px 2px 0;color:#64748b">Stop Loss</td><td style="color:#b91c1c">${px(sd.stopLoss, result.symbol)}</td></tr>
        <tr><td style="padding:2px 10px 2px 0;color:#64748b">TP1 / TP2 / TP3</td><td style="color:#047857">${px(sd.takeProfit1, result.symbol)} / ${px(sd.takeProfit2, result.symbol)} / ${px(sd.takeProfit3, result.symbol)}</td></tr>
      </table>
      ${dat ? `<p style="font-size:12px;color:#334155"><b>DAT</b>: Direction ${dat.direction.pass ? 'PASS' : 'FAIL'} · Area ${dat.area.pass ? 'PASS' : 'FAIL'} · Trigger ${dat.trigger.pass ? 'PASS' : 'FAIL'} (${pattern})</p>` : ''}
      ${driveActive ? `<p style="font-size:12px;color:${drive.label === 'SECOND_DRIVE' ? '#047857' : '#b45309'}"><b>${drive.label === 'SECOND_DRIVE' ? '2nd drive ✓' : '1st drive — wait'}</b> · ${drive.note}</p>` : ''}
      ${pd ? `<p style="font-size:12px;color:${pdColor}"><b>Zone: ${pd.zone} ${pd.pct}%</b>${pd.fit === 'GOOD' ? ' · well-located ✓' : pd.fit === 'POOR' ? ' · against location (buy discount / sell premium)' : ''}</p>` : ''}
      ${sd.sessionContext ? `<p style="font-size:12px;color:#475569">Session: ${sd.sessionContext.reason}</p>` : ''}
      ${risk ? `<div style="margin:10px 0;padding:10px;border:1px solid #fde68a;background:#fffbeb;border-radius:10px"><p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#92400e;text-transform:uppercase">Position Plan</p><p style="font-size:13px;margin:2px 0">Risk <b>${risk.riskPercent}%</b> · Amount to risk / max loss <b>${money(risk.amountToRisk ?? risk.riskAmount ?? risk.maxLoss)}</b></p><p style="font-size:13px;margin:2px 0">Suggested lot <b>${risk.suggestedLotSize ?? 'n/a'}</b> · Approx margin/investment <b>${money(risk.marginRequired ?? risk.amountToInvestApprox)}</b> · Multiplier <b>${risk.multiplier || `${risk.leverage || 'n/a'}x`}</b></p><p style="font-size:13px;margin:2px 0">SL loss <b style="color:#b91c1c">-${money(risk.lossAtStop ?? risk.maxLoss)}</b> · Stop ${risk.stopPips ?? 'n/a'} pips</p><p style="font-size:13px;margin:6px 0 0;color:#047857">TP1 ${money(risk.profitAtTp1)} · TP2 ${money(risk.profitAtTp2)} · TP3 ${money(risk.profitAtTp3)}</p></div>` : ''}
      <p style="font-size:12px;color:#475569;margin:8px 0">${sd.timingTip || ''}</p>
      ${news && (news.block || news.caution) ? `<p style="font-size:12px;color:#b45309">⚠ ${news.reason}</p>` : ''}
      <p style="font-size:12px;color:#64748b">Confluences: ${conf.map((c) => `${c.name} +${c.points}`).join(', ') || 'none'}</p>
      <p style="font-size:11px;color:#94a3b8;margin-top:10px">Advisory only — not financial advice. — Aura Gold Scanner</p>
    </div>`;
  const forexTo = signalEmailToFor(result.symbol, result.timeframe);
  if (!forexTo) return false;
  await sendNotificationEmail({ to: forexTo, subject, text, html, signalId: `forex:${result.symbol}:${result.timeframe}:${result.bar}` });
  try {
    await persistEmailedForexReport(result);
  } catch (err) {
    console.error('[EmailReports] Failed to persist forex email report:', err.message);
  }
  return true;
}

function recordForexDailyBestCandidate(result) {
  const sd = result?.systemDecision;
  if (!sd || sd.decision === 'HOLD' || signalQualityRank(sd.signalQuality) < 1) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${day}|${result.symbol}|${result.timeframe}|${sd.decision}`;
  const ranked = { ...result, _dailyBestDay: day, _rank: forexCandidateRank(result), _seenAt: new Date().toISOString() };
  const existing = forexDailyBestCandidates.get(key);
  if (!existing || ranked._rank > (existing._rank || 0)) forexDailyBestCandidates.set(key, ranked);
  for (const [candidateKey, candidate] of forexDailyBestCandidates.entries()) {
    if (candidate?._dailyBestDay !== day) forexDailyBestCandidates.delete(candidateKey);
  }
}

async function maybeSendForexDailyBestEmail(now = new Date()) {
  if (!FOREX_DAILY_BEST_EMAIL_ENABLED || !SIGNAL_ALERTS_ENABLED || !signalEmailTo() || !isEmailSystemEnabled('forexScanner')) return false;
  const day = now.toISOString().slice(0, 10);
  if (lastForexDailyBestEmailDate === day) return false;
  if (now.getUTCHours() < FOREX_DAILY_BEST_EMAIL_UTC_HOUR) return false;
  const candidates = [...forexDailyBestCandidates.values()]
    .filter((item) => item?._dailyBestDay === day && item.systemDecision?.decision !== 'HOLD')
    .sort((a, b) => (b._rank || 0) - (a._rank || 0))
    .slice(0, FOREX_DAILY_BEST_EMAIL_LIMIT);
  if (!candidates.length) return false;
  const signalId = `forex-daily-best:${day}`;
  if (!canAlert(signalId, day, { minGapMs: 0 })) return false;
  const money = (value) => value === null || value === undefined ? 'n/a' : `$${Number(value).toFixed(2)}`;
  const lines = [
    `AURA GOLD - BEST FOREX SIGNALS OF THE DAY (${day} UTC)`,
    `Top ${candidates.length} scanner setup(s), ranked by quality, confidence, DAT, and RR.`,
    '',
    ...candidates.flatMap((item, index) => {
      const sd = item.systemDecision;
      const risk = sd.riskPlan;
      return [
        `${index + 1}. ${sd.signalQuality || setupLabel(sd.grade)} - ${sd.decision} ${item.symbol} ${item.timeframe} | Score ${Math.round(sd.confidence)}/100 | DAT ${sd.datFramework?.score ?? 'n/a'}/3 | RR ${sd.riskRewardRatio ?? 'n/a'}`,
        `   Entry ${px(sd.entryPrice, item.symbol)} | SL ${px(sd.stopLoss, item.symbol)} | TP1 ${px(sd.takeProfit1, item.symbol)} | TP2 ${px(sd.takeProfit2, item.symbol)} | TP3 ${px(sd.takeProfit3, item.symbol)}`,
        `   Lot ${risk?.suggestedLotSize ?? 'n/a'} | Multiplier ${risk?.multiplier || `${risk?.leverage || 'n/a'}x`} | Risk ${money(risk?.amountToRisk ?? risk?.riskAmount)} | SL loss ${money(risk?.lossAtStop ?? risk?.maxLoss)} | TP1/2/3 ${money(risk?.profitAtTp1)} / ${money(risk?.profitAtTp2)} / ${money(risk?.profitAtTp3)}`,
        `   Strategy ${sd.strategyType || 'SYSTEM_CONFLUENCE'} | Session ${sd.sessionContext?.reason || 'n/a'}`,
        '',
      ];
    }),
    'Advisory only - not financial advice. Review chart context before execution.',
  ];
  const rows = candidates.map((item, index) => {
    const sd = item.systemDecision;
    const risk = sd.riskPlan;
    const color = sd.decision.includes('BUY') ? '#047857' : '#b91c1c';
    return `<tr><td style="padding:8px;border-bottom:1px solid #e2e8f0">${index + 1}</td><td style="padding:8px;border-bottom:1px solid #e2e8f0"><b style="color:${color}">${sd.decision.replace('_', ' ')}</b><br>${item.symbol} ${item.timeframe}<br><span style="font-size:11px;color:#b45309">${sd.signalQuality || setupLabel(sd.grade)}</span></td><td style="padding:8px;border-bottom:1px solid #e2e8f0">Score ${Math.round(sd.confidence)}/100<br>DAT ${sd.datFramework?.score ?? 'n/a'}/3<br>RR ${sd.riskRewardRatio ?? 'n/a'}</td><td style="padding:8px;border-bottom:1px solid #e2e8f0">Entry <b>${px(sd.entryPrice, item.symbol)}</b><br>SL <span style="color:#b91c1c">${px(sd.stopLoss, item.symbol)}</span><br>TP1/2/3 <span style="color:#047857">${px(sd.takeProfit1, item.symbol)} / ${px(sd.takeProfit2, item.symbol)} / ${px(sd.takeProfit3, item.symbol)}</span></td><td style="padding:8px;border-bottom:1px solid #e2e8f0">Lot ${risk?.suggestedLotSize ?? 'n/a'}<br>Multiplier ${risk?.multiplier || `${risk?.leverage || 'n/a'}x`}<br>Risk ${money(risk?.amountToRisk ?? risk?.riskAmount)}<br>SL loss ${money(risk?.lossAtStop ?? risk?.maxLoss)}<br>TP1/2/3 ${money(risk?.profitAtTp1)} / ${money(risk?.profitAtTp2)} / ${money(risk?.profitAtTp3)}</td></tr>`;
  }).join('');
  const html = `<div style="font-family:Arial,sans-serif;max-width:900px"><p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.12em;color:#b45309;text-transform:uppercase">Best Forex Signals Of The Day</p><h2 style="margin:0 0 8px;color:#0f172a">Top ${candidates.length} Scanner Setup(s) - ${day} UTC</h2><p style="font-size:12px;color:#64748b">Ranked by signal quality, confidence, DAT score, and RR. Advisory only - verify chart context before trading.</p><table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr style="text-align:left;background:#f8fafc"><th style="padding:8px">#</th><th style="padding:8px">Signal</th><th style="padding:8px">Quality</th><th style="padding:8px">Levels</th><th style="padding:8px">Risk Plan</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  await sendNotificationEmail({ to: signalEmailTo(), subject: `[BEST FOREX SIGNALS | ${day}] Top ${candidates.length} scanner setups`, text: lines.join('\n'), html, signalId });
  recordAlert(signalId, day);
  lastForexDailyBestEmailDate = day;
  console.log(`[Scanner] Emailed daily best forex summary (${candidates.length} setup(s)).`);
  return true;
}

async function sendFttAlert(prediction) {
  if (!signalEmailTo()) return false;
  const isPostNewsFixed = prediction?.source === 'news';
  if (!isEmailSystemEnabled(isPostNewsFixed ? 'postNewsFixed' : 'fixedTime')) return false;
  if (!fttEmailAllowed(prediction)) return false;
  const stale = shouldSkipStaleFttAlert(prediction);
  if (stale) {
    console.warn(`[Scanner] Skipped stale FTT ${prediction.symbol} ${prediction.expiry}: age ${Math.round(stale.ageMs / 1000)}s > max ${Math.round(stale.maxAgeMs / 1000)}s`);
    recordSkippedAlert({ type: 'FTT', symbol: prediction.symbol, expiry: prediction.expiry, reason: 'STALE', ageMs: stale.ageMs, maxAgeMs: stale.maxAgeMs, signalId: prediction.id });
    return false;
  }
  const sym = prediction.symbol;
  const calibration = await getFttCalibrationSnapshot(prediction);
  prediction.calibration = calibration;
  const calGate = calibrationGateDecision('ftt', calibration);
  if (calGate.action === 'suppress') {
    console.warn(`[Calibration] Suppressed FTT ${prediction.symbol} ${prediction.expiry}: ${calGate.reason}`);
    recordSkippedAlert({ type: 'FTT', symbol: prediction.symbol, expiry: prediction.expiry, reason: 'CALIBRATION', detail: calGate.reason, signalId: prediction.id });
    return false;
  }
  if (calGate.action === 'shadow') {
    console.warn(`[Calibration][OBSERVE] Would suppress FTT ${prediction.symbol} ${prediction.expiry}: ${calGate.reason} (set ftt calibration mode to 'enforce' to act)`);
    recordWouldSuppress({ type: 'FTT', symbol: prediction.symbol, expiry: prediction.expiry, reason: calGate.reason, calibration });
  }
  const calConfidence = blendCalibratedConfidence(prediction.confidence, calibration);
  prediction.calibratedConfidence = calConfidence;
  const displayConfidence = calConfidence.adjusted ? `${calConfidence.value}% (raw ${calConfidence.raw}%)` : `${Math.round(prediction.confidence)}%`;
  const qualityTier = prediction.indicators?.qualityTier || fttTradeStatus(prediction.direction, prediction.confidence, prediction.indicators);
  const qualityPrefix = qualityTier === 'QUALITY_SIGNAL' ? 'QUALITY FTT' : 'FTT';
  const sentAt = new Date();
  const signalTime = prediction.sourceReceivedAt || prediction.sourceBarTime || prediction.entryTime || sentAt;
  const timingMeta = buildAlertTimingMeta({
    signalTime,
    sentAt,
    tradeTime: prediction.entryTime || signalTime,
    expiryTime: prediction.expiryTime || null,
  });
  const subject = `[${qualityPrefix} | ${expirySubjectLabel(prediction.expiry)} | ${fttSetupLabel(prediction.confidence)}] ${prediction.direction} ${sym} | Score ${displayConfidence}`;
  const grade = fttReportGrade(prediction);
  const underlyingGrade = prediction.indicators?.grade || '';
  const tip = prediction.indicators?.timingTip || '';
  const qualityReasons = prediction.indicators?.qualityReasons || [];
  const riskWarnings = prediction.indicators?.riskWarnings || [];
  const patterns = prediction.indicators?.detectedPatterns || [];
  const volatilityState = prediction.indicators?.volatilityState || 'UNKNOWN';
  // Premium/discount location (advisory): buy discount / sell premium.
  const fttPd = prediction.indicators?.premiumDiscount || null;
  const fttPdText = fttPd
    ? `Zone: ${fttPd.zone} ${fttPd.pct}%${fttPd.fit === 'GOOD' ? ' ✓ (well-located)' : fttPd.fit === 'POOR' ? ' ⚠ (against location — buy discount / sell premium)' : ''}`
    : '';
  const fttPdColor = !fttPd ? '#334155' : fttPd.fit === 'GOOD' ? '#047857' : fttPd.fit === 'POOR' ? '#b45309' : '#334155';
  const text = [
    `AURA GOLD - FIXED TIME TRADE (${prediction.expiry})`,
    timingMeta.text,
    '',
    `Trade type: Fixed-time direction prediction; result settles at expiry with no SL/TP management`,
    `${sym} | ${prediction.direction} | Confidence ${displayConfidence}`,
    calibration.winRate !== null ? `Calibrated probability: ${calibration.winRate}% (${calibration.bucket}, ${calibration.settled} settled)` : 'Calibrated probability: n/a',
    calConfidence.adjusted ? calConfidence.note : '',
    `Quality: ${qualityTier} (${prediction.indicators?.qualityScore ?? 'n/a'}/100)`,
    `Entry ${px(prediction.entryPrice, sym)} | Entry time ${new Date(prediction.entryTime).toLocaleString()} | Expires ${new Date(prediction.expiryTime).toLocaleString()}`,
    `Source: ${prediction.source || 'system'}`,
    grade ? `Grade: ${grade}` : '',
    underlyingGrade ? `Underlying setup grade: ${underlyingGrade}` : '',
    patterns.length ? `Patterns: ${patterns.join(', ')}` : '',
    `Volatility: ${volatilityState}`,
    fttPdText,
    qualityReasons.length ? `Quality reasons: ${qualityReasons.join('; ')}` : '',
    riskWarnings.length ? `Risk warnings: ${riskWarnings.join('; ')}` : '',
    tip ? `Timing: ${tip}` : '',
    prediction.reasoning ? `Reasoning: ${prediction.reasoning}` : '',
    '',
    'Advisory only — not financial advice. Manage your own risk.',
  ].filter(Boolean).join('\n');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.12em;color:#4f46e5;text-transform:uppercase">Fixed Time Trade</p>
      <h2 style="margin:0 0 4px;color:${prediction.direction === 'UP' ? '#047857' : prediction.direction === 'DOWN' ? '#b91c1c' : '#334155'}">${prediction.direction} ${sym} <span style="font-size:13px;color:#64748b">${prediction.expiry}</span></h2>
      ${timingMeta.html}
      <p style="margin:0 0 8px;font-size:12px;color:#64748b">Trade type: direction must settle above/below entry at expiry. No SL/TP management.</p>
      <p style="margin:0 0 8px">Quality <b>${qualityTier}</b> (${prediction.indicators?.qualityScore ?? 'n/a'}/100) · FTT confidence <b>${Math.round(prediction.confidence)}%</b> ${grade ? `· ${grade}` : ''}</p>
      ${underlyingGrade ? `<p style="margin:0 0 8px;font-size:12px;color:#64748b">Underlying system setup: ${underlyingGrade}</p>` : ''}
      ${patterns.length ? `<p style="font-size:12px;color:#334155"><b>Patterns</b>: ${patterns.join(', ')}</p>` : ''}
      <p style="font-size:12px;color:#334155"><b>Volatility</b>: ${volatilityState}</p>
      ${fttPd ? `<p style="font-size:12px;color:${fttPdColor}"><b>Zone: ${fttPd.zone} ${fttPd.pct}%</b>${fttPd.fit === 'GOOD' ? ' · well-located ✓' : fttPd.fit === 'POOR' ? ' · against location (buy discount / sell premium)' : ''}</p>` : ''}
      ${qualityReasons.length ? `<p style="font-size:12px;color:#047857"><b>Why quality</b>: ${qualityReasons.join('; ')}</p>` : ''}
      ${riskWarnings.length ? `<p style="font-size:12px;color:#b45309"><b>Warnings</b>: ${riskWarnings.join('; ')}</p>` : ''}
      <p style="font-size:13px">Entry <b>${px(prediction.entryPrice, sym)}</b> · enter ${new Date(prediction.entryTime).toLocaleString()} · expires ${new Date(prediction.expiryTime).toLocaleString()} · source ${prediction.source || 'system'}</p>
      <p style="font-size:12px;color:#475569">${tip}</p>
      <p style="font-size:12px;color:#334155">${prediction.reasoning || ''}</p>
      <p style="font-size:11px;color:#94a3b8;margin-top:10px">Advisory only — not financial advice. — Aura Gold Future Predictions</p>
    </div>`;
  const fttTo = signalEmailToFor(sym, prediction.timeframe || null);
  if (!fttTo) return false;
  await sendNotificationEmail({ to: fttTo, subject, text, html, signalId: prediction.id });
  try {
    await persistEmailedFixedReport(prediction);
  } catch (err) {
    console.error('[EmailReports] Failed to persist fixed email report:', err.message);
  }
  return true;
}

// ─── Post-news: instant actual-value alert + post-blackout entry signals ──
const postNewsSignals = [];          // current post-news entry signals (UI + email)
const postNewsWatch = new Map();     // eventId -> event (released, within window)
const POST_NEWS_WINDOW_H = Math.max(1, Number(process.env.POST_NEWS_WINDOW_H || 4));
const POST_NEWS_BLACKOUT_MIN = Number(process.env.POST_NEWS_BLACKOUT_MIN || 30);
const TRADE_NEWS_FIXED_EXPIRY = String(process.env.TRADE_NEWS_FIXED_EXPIRY || '5m').toLowerCase();
const ACTUAL_RANK = { HIGH: 3, MODERATE: 2, LOW: 1, NONE: 0, HOLIDAY: 0 };
const ACTUAL_ALERT_MIN_RANK = ACTUAL_RANK[String(process.env.ACTUAL_ALERT_MIN_IMPACT || 'HIGH').toUpperCase()] || 3;

function classifyNewsEvent(event) {
  const title = String(event?.title || '').toUpperCase();
  if (/NON[-\s]?FARM|NFP|PAYROLL|UNEMPLOYMENT|JOBLESS|EMPLOYMENT|AVERAGE EARNINGS|WAGE/.test(title)) return 'JOBS';
  if (/CPI|CONSUMER PRICE|PPI|PRODUCER PRICE|PCE|INFLATION/.test(title)) return 'INFLATION';
  if (/INTEREST RATE|RATE DECISION|FOMC|FED|ECB|BOE|BOJ|BOC|RBA|RBNZ|MONETARY POLICY/.test(title)) return 'CENTRAL_BANK';
  if (/PMI|PURCHASING MANAGERS|ISM/.test(title)) return 'PMI';
  if (/GDP|GROSS DOMESTIC/.test(title)) return 'GDP';
  if (/RETAIL SALES|DURABLE GOODS|HOUSING|HOME SALES|BUILDING PERMITS/.test(title)) return 'DEMAND';
  if (/SPEECH|TESTIFIES|TESTIMONY|PRESS CONFERENCE/.test(title)) return 'SPEAKER';
  return 'MACRO';
}

function tradeNewsSignalGrade(confidence) {
  const c = Number(confidence) || 0;
  if (c >= 85) return 'A+ News Setup';
  if (c >= 75) return 'A News Setup';
  if (c >= 65) return 'B News Setup';
  return 'Watch Only';
}

function enrichTradeNewsForexSignal(sig) {
  const eventType = classifyNewsEvent(sig.event);
  const rr = sig.price && sig.stopLoss && sig.takeProfit1
    ? Math.round((Math.abs(sig.takeProfit1 - sig.price) / Math.max(Math.abs(sig.price - sig.stopLoss), 1e-9)) * 100) / 100
    : null;
  return {
    ...sig,
    tradeType: 'forex',
    eventType,
    directionLabel: sig.direction === 'UP' ? 'BUY' : sig.direction === 'DOWN' ? 'SELL' : 'WAIT',
    grade: tradeNewsSignalGrade(sig.confidence),
    riskRewardRatio: rr,
    setupChecklist: [
      'Actual value released and compared against forecast/previous',
      'Waited for post-news blackout before entry',
      'Market reaction confirms direction',
      'Entry uses post-news structure with SL/TP levels',
      'Skip if spread/volatility is erratic or confirmation fails',
    ],
  };
}

function buildTradeNewsFixedSignal(sig, expiry = TRADE_NEWS_FIXED_EXPIRY, now = Date.now()) {
  const exp = String(expiry || '5m').toLowerCase();
  const durationMs = parseExpiryDuration(exp);
  const tfMap = getFttCandleTimeframeMapping(exp);
  const entryMs = Math.max(now, Date.parse(sig.tradeableAtIso || '') || now);
  const confidence = Math.max(0, Math.min(95, Number(sig.confidence || 0) - (exp === '1m' ? 8 : exp === '2m' ? 5 : exp === '3m' ? 3 : 0)));
  const qualityTier = confidence >= 85 ? 'QUALITY_SIGNAL' : confidence >= FTT_ALERT_MIN_CONFIDENCE ? 'TRADE_SIGNAL' : 'WATCH_ONLY';
  return {
    id: `trade_news_fixed_${sig.event.id}_${sig.symbol}_${exp}`,
    tradeType: 'fixed',
    symbol: sig.symbol,
    event: sig.event,
    eventType: classifyNewsEvent(sig.event),
    surprise: sig.surprise,
    expectedDir: sig.expectedDir,
    realizedDir: sig.realizedDir,
    direction: sig.direction,
    expiry: exp,
    confidence,
    grade: tradeNewsSignalGrade(confidence),
    qualityTier,
    qualityScore: confidence,
    qualityReasons: ['Actual release, blackout window, and realized post-news direction checked'],
    riskWarnings: confidence < 85 ? ['News fixed-time setup is not top-tier quality'] : [],
    volatilityState: 'NEWS_REACTION',
    detectedPatterns: [],
    entryPrice: sig.price,
    entryTime: new Date(entryMs).toISOString(),
    expiryTime: new Date(entryMs + durationMs).toISOString(),
    status: sig.status,
    candleBiasTf: tfMap.bias,
    candleTrendTf: tfMap.trend,
    candleEntryTf: tfMap.entry,
    candleConfirmTf: tfMap.confirmation,
    note: `${sig.note} Fixed-time variant: direction must settle ${sig.direction === 'UP' ? 'above' : 'below'} entry at expiry.`,
    reasoning: `Post-news ${sig.event.currency} ${sig.event.title}: surprise ${sig.surprise.bias}, realized reaction ${sig.realizedDir}, confidence ${Math.round(confidence)}%.`,
  };
}

function buildTradeNewsFixedPrediction(fixed) {
  return {
    id: `ftt_news_${fixed.event.id}_${fixed.symbol}_${fixed.expiry}`,
    symbol: fixed.symbol,
    expiry: fixed.expiry,
    direction: fixed.direction,
    confidence: fixed.confidence,
    entryPrice: fixed.entryPrice,
    entryTime: fixed.entryTime,
    expiryTime: fixed.expiryTime,
    exitPrice: null,
    outcome: 'PENDING',
    source: 'news',
    reasoning: fixed.reasoning,
    indicators: {
      grade: fixed.grade,
      qualityTier: fixed.qualityTier,
      qualityScore: fixed.qualityScore,
      qualityReasons: fixed.qualityReasons,
      riskWarnings: fixed.riskWarnings,
      detectedPatterns: fixed.detectedPatterns,
      volatilityState: fixed.volatilityState,
      timingTip: `Use ${fixed.candleEntryTf} entry with ${fixed.candleConfirmTf} confirmation after the news blackout.`,
      event: fixed.event,
      candleMap: {
        bias: fixed.candleBiasTf,
        trend: fixed.candleTrendTf,
        entry: fixed.candleEntryTf,
        confirmation: fixed.candleConfirmTf,
      },
    },
    created_at: new Date().toISOString(),
  };
}

function buildActualReleasedEmail(event, surprise, affected) {
  const dirWord = surprise.bias === 'bullish' ? `${event.currency} bullish` : surprise.bias === 'bearish' ? `${event.currency} bearish` : 'in line';
  const subject = `🔔 ACTUAL: ${event.currency} ${event.title} = ${event.actual} (${dirWord})`;
  const lines = [
    `ACTUAL VALUE RELEASED — ${event.title} (${event.currency}, ${event.impact})	op`,
    `Actual ${event.actual}  |  Forecast ${event.forecast ?? 'n/a'}  |  Previous ${event.previous ?? 'n/a'}`,
    `Surprise: ${surprise.bias.toUpperCase()} (${surprise.basis}, ${surprise.deltaPct.toFixed(1)}%)`,
    `Affected: ${affected.join(', ') || 'n/a'}`,
    '',
    `Entry signals will be issued AFTER the +${POST_NEWS_BLACKOUT_MIN}m blackout, based on the realized post-news direction. Do not trade inside the window.`,
    'Advisory only — not financial advice.',
  ];
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:660px">
      <h2 style="margin:0 0 4px;color:#b45309">🔔 Actual Released — ${event.currency} ${event.title}</h2>
      <p style="font-size:15px;margin:0 0 8px"><b>Actual ${event.actual}</b> · Forecast ${event.forecast ?? 'n/a'} · Previous ${event.previous ?? 'n/a'}</p>
      <p style="font-size:14px;margin:0 0 8px">Surprise: <b style="color:${surprise.bias === 'bullish' ? '#047857' : surprise.bias === 'bearish' ? '#b91c1c' : '#334155'}">${surprise.bias.toUpperCase()}</b> (${surprise.basis}, ${surprise.deltaPct.toFixed(1)}%)</p>
      <p style="font-size:13px;color:#475569">Affected: ${affected.join(', ') || 'n/a'}</p>
      <p style="font-size:12px;color:#b45309;margin-top:8px">Entry signals issue after the +${POST_NEWS_BLACKOUT_MIN}m blackout, based on realized direction. No entry inside the window.</p>
      <p style="font-size:11px;color:#94a3b8">Advisory only — not financial advice. — Aura Gold News Engine</p>
    </div>`;
  return { subject, text: lines.join('\n'), html };
}

async function onActualReleased(event) {
  if ((ACTUAL_RANK[event.impact] || 0) < ACTUAL_ALERT_MIN_RANK) return;
  const surprise = computeSurprise(event);
  const curated = getCuratedSymbols(getMt5Status().symbols);
  const affected = affectedSymbols(event.currency, curated);

  // Instant email, once per event.
  if (SIGNAL_ALERTS_ENABLED && signalEmailTo() && isEmailSystemEnabled('highImpactNews')) {
    const key = `actual:${event.id}`;
    if (canAlert(key, event.id, { minGapMs: 0 })) {
      const { subject, text, html } = buildActualReleasedEmail(event, surprise, affected);
      try {
        await sendNotificationEmail({ to: signalEmailTo(), subject, text, html, signalId: key });
        recordAlert(key, event.id);
        console.log(`[News:Delta] Emailed ACTUAL RELEASED for ${event.currency} ${event.title} = ${event.actual}`);
      } catch (e) { console.warn('[News:Delta] actual email failed:', e.message); }
    }
  }

  // Arm post-news entry signals (activate after blackout).
  postNewsWatch.set(event.id, event);
  refreshPostNewsSignals(Date.now());
}

function refreshPostNewsSignals(now = Date.now()) {
  const curated = getCuratedSymbols(getMt5Status().symbols);
  const next = [];
  for (const [eventId, event] of [...postNewsWatch.entries()]) {
    const expiresAt = event.timestampUtc + POST_NEWS_WINDOW_H * 60 * 60 * 1000;
    if (now > expiresAt) { postNewsWatch.delete(eventId); continue; }
    const symbols = affectedSymbols(event.currency, curated);
    for (const symbol of symbols) {
      let sig;
      try {
        sig = buildPostNewsSignal({ event, symbol, deps: { getCandles: getRecentCandles }, now, blackoutMins: POST_NEWS_BLACKOUT_MIN, windowHours: POST_NEWS_WINDOW_H });
      } catch { continue; }
      const forexSig = enrichTradeNewsForexSignal(sig);
      next.push(forexSig);
      // Email + SSE once when it becomes ACTIVE with a real direction.
      if (forexSig.status === 'ACTIVE' && forexSig.direction !== 'NEUTRAL') {
        const key = `postnews:${eventId}:${symbol}`;
        if (SIGNAL_ALERTS_ENABLED && signalEmailTo() && isEmailSystemEnabled('postNewsForex') && postNewsForexEmailAllowed(forexSig) && canAlert(key, eventId, { minGapMs: 0 })) {
          const subject = `[POST-NEWS FOREX | ${forexSig.grade}] ${forexSig.directionLabel} ${symbol} — ${event.currency} ${event.title} (${Math.round(forexSig.confidence)}%)`;
          const text = [
            `POST-NEWS FOREX ENTRY SIGNAL (blackout cleared)`,
            `${symbol} | ${forexSig.directionLabel} | confidence ${Math.round(forexSig.confidence)}% | ${forexSig.grade}`,
            `Driver: ${event.title} (${event.currency}) — surprise ${forexSig.surprise.bias}, market reacted ${forexSig.realizedDir} (${forexSig.realizedMovePct}%).`,
            `Entry ${px(forexSig.price, symbol)}  SL ${px(forexSig.stopLoss, symbol)}  TP1 ${px(forexSig.takeProfit1, symbol)}  TP2 ${px(forexSig.takeProfit2, symbol)}  RR ${forexSig.riskRewardRatio ?? 'n/a'}`,
            `Rule: do not predict the news; this signal waits for actual release, reaction, blackout, and confirmation.`,
            'Advisory only — not financial advice.',
          ].join('\n');
          const html = `<div style="font-family:Arial,sans-serif;max-width:640px">
            <h2 style="margin:0 0 4px;color:${forexSig.direction === 'UP' ? '#047857' : '#b91c1c'}">POST-NEWS FOREX ${forexSig.directionLabel} ${symbol}</h2>
            <p style="font-size:14px">Confidence <b>${Math.round(forexSig.confidence)}%</b> · ${forexSig.grade} · driver ${event.currency} ${event.title}</p>
            <p style="font-size:13px;color:#475569">Surprise ${forexSig.surprise.bias} · market reacted ${forexSig.realizedDir} (${forexSig.realizedMovePct}%) · RR ${forexSig.riskRewardRatio ?? 'n/a'}</p>
            <p style="font-size:13px">Entry <b>${px(forexSig.price, symbol)}</b> · SL ${px(forexSig.stopLoss, symbol)} · TP1 ${px(forexSig.takeProfit1, symbol)} · TP2 ${px(forexSig.takeProfit2, symbol)}</p>
            <p style="font-size:12px;color:#475569">Rule: wait for release, market reaction, blackout, and confirmation. No blind news prediction.</p>
            <p style="font-size:11px;color:#94a3b8">Advisory only — not financial advice. — Aura Gold Post-News Engine</p></div>`;
          const postNewsTo = signalEmailToFor(symbol, null);
          if (postNewsTo) sendNotificationEmail({ to: postNewsTo, subject, text, html, signalId: key })
            .then(async (info) => {
              if (!info) return;
              recordAlert(key, eventId);
              await persistEmailedPostNewsForexReport(forexSig, key);
              console.log(`[News:PostNews] Emailed ${forexSig.directionLabel} ${symbol} (${event.title})`);
            })
            .catch((e) => console.warn('[News:PostNews] email failed:', e.message));
        }
        sendStreamEvent('post_news_signal', forexSig);

        const fixedSig = buildTradeNewsFixedSignal(forexSig, TRADE_NEWS_FIXED_EXPIRY, now);
        if (fttTierAllowed(fixedSig.qualityTier, 'postNewsFixedMinTier') && isEmailSystemEnabled('postNewsFixed')) {
          const fixedKey = `postnewsftt:${eventId}:${symbol}:${fixedSig.expiry}`;
          if (SIGNAL_ALERTS_ENABLED && signalEmailTo() && canAlert(fixedKey, eventId, { minGapMs: 0 })) {
            const prediction = buildTradeNewsFixedPrediction(fixedSig);
            persistFttPrediction(prediction)
              .then(async () => {
                if (!fttPredictions.some((p) => p.id === prediction.id)) fttPredictions.unshift(prediction);
                const sent = await sendFttAlert(prediction);
                if (sent) recordAlert(fixedKey, eventId);
                sendStreamEvent('ftt_prediction', prediction);
                sendStreamEvent('trade_news_fixed_signal', fixedSig);
                if (sent) console.log(`[News:PostNews] Emailed FIXED ${fixedSig.direction} ${symbol} ${fixedSig.expiry} (${event.title})`);
              })
              .catch((e) => console.warn('[News:PostNews] fixed email failed:', e.message));
          }
        }
      }
    }
  }
  postNewsSignals.splice(0, postNewsSignals.length, ...next.sort((a, b) => b.confidence - a.confidence));
}

// ─── Breakout alerts (graded, two-tier notification controller) ──────────────
// Additive + ISOLATED: detects PRE (approaching a strong level) and CONFIRMED
// (decisive close beyond it) breakouts on WELL-FORMED charts only, grades each
// A+/A/B/C, then routes through a two-tier controller:
//   • EMAIL  — strict, anti-flood: grade-gated (configurable min), per-level
//              dedup, and a hard hourly budget. PRE is held to a higher bar
//              (>= A) than CONFIRMED (>= configured min, default B) because a
//              pre-warning is a prediction. M5 gets the CONFIRMED email only.
//   • BROWSER — generous: SSE desktop notification for any B+ candidate, once
//               per bar/phase. Never gated by the email budget.
// Reuses buildBreakoutCandidate (pure) — never touches live signal logic.
const BREAKOUT_ENABLED = String(process.env.BREAKOUT_ENABLED || 'true').toLowerCase() !== 'false';
const BREAKOUT_TIMEFRAMES = String(process.env.BREAKOUT_TIMEFRAMES || 'M5,M15,M30,H1')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const BREAKOUT_APPROACH_ATR = Math.max(0.05, Number(process.env.BREAKOUT_APPROACH_ATR || 0.3));
const BREAKOUT_MIN_BREAK_BODY_ATR = Math.max(0.1, Number(process.env.BREAKOUT_MIN_BREAK_BODY_ATR || 0.5));
const BREAKOUT_EMAIL_MAX_PER_HOUR = Math.max(1, Number(process.env.BREAKOUT_EMAIL_MAX_PER_HOUR || 4));
const BREAKOUT_EMAIL_MIN_GAP_MS = Math.max(0, Number(process.env.BREAKOUT_EMAIL_MIN_GAP_MIN || 30)) * 60 * 1000;
const BREAKOUT_BROWSER_MIN_GRADE = String(process.env.BREAKOUT_BROWSER_MIN_GRADE || 'B').toUpperCase();
const BREAKOUT_RETENTION_DAYS = Math.max(1, Number(process.env.BREAKOUT_RETENTION_DAYS || 14));

const breakoutBrowserBars = new Map();   // `${symbol}|${tf}|${phase}` -> bar time (browser dedup)
const breakoutEmailTimes = [];           // rolling timestamps of emails sent in the last hour

// Hard hourly email budget: anti-flood ceiling so a volatile day cannot spam the
// inbox. Lower-priority candidates simply fall back to browser-only when spent.
function spendBreakoutEmailBudget(now = Date.now()) {
  const cutoff = now - 60 * 60 * 1000;
  while (breakoutEmailTimes.length && breakoutEmailTimes[0] < cutoff) breakoutEmailTimes.shift();
  if (breakoutEmailTimes.length >= BREAKOUT_EMAIL_MAX_PER_HOUR) return false;
  breakoutEmailTimes.push(now);
  return true;
}
function refundBreakoutEmailBudget() { breakoutEmailTimes.pop(); }

function breakoutEmailMinRank() {
  const v = String(loadEmailAlertSettings().breakoutEmailMinGrade || 'A').toUpperCase();
  return BREAKOUT_GRADE_RANK[v] ?? BREAKOUT_GRADE_RANK.A;
}

// Bucket the level so re-tests of the SAME level don't re-fire (dedup key).
function breakoutLevelBucket(cand) {
  if (cand.atr && cand.atr > 0) return Math.round(cand.level / (0.25 * cand.atr));
  return Math.round(cand.level * 100);
}

function buildBreakoutPayload(cand) {
  return {
    id: `breakout:${cand.symbol}:${cand.timeframe}:${cand.phase}:${cand.bar}`,
    kind: 'BREAKOUT',
    phase: cand.phase,
    symbol: cand.symbol,
    timeframe: cand.timeframe,
    direction: cand.direction,
    grade: cand.grade,
    score: cand.score,
    trend: cand.trend,
    level: cand.level,
    levelStrength: cand.levelStrength,
    price: cand.price,
    atr: cand.atr,
    distanceAtr: cand.distanceAtr,
    bodyAtr: cand.bodyAtr,
    displacement: cand.displacement
      ? { present: cand.displacement.present, strong: cand.displacement.strong, atrMultiple: cand.displacement.atrMultiple }
      : null,
    reasons: cand.reasons,
    bar: cand.bar,
    createdAt: new Date().toISOString(),
  };
}

function buildBreakoutEmail(cand) {
  const dirWord = cand.direction === 'BUY' ? 'UP' : 'DOWN';
  const arrow = cand.direction === 'BUY' ? '▲' : '▼';
  const when = formatAlertDateTime(cand.bar);
  const phaseLabel = cand.phase === 'PRE' ? 'APPROACHING BREAKOUT' : 'BREAKOUT CONFIRMED';
  const icon = cand.phase === 'PRE' ? '⚠️' : '✅';
  const levelTxt = px(cand.level, cand.symbol);
  const priceTxt = px(cand.price, cand.symbol);
  const dispTxt = cand.displacement && cand.displacement.present
    ? `${cand.displacement.strong ? 'strong ' : ''}displacement (${cand.displacement.atrMultiple}x ATR)`
    : 'no displacement';

  const subject = `${icon} [${cand.grade}] ${cand.symbol} ${cand.timeframe} ${dirWord} ${cand.phase === 'PRE' ? 'approaching' : 'breakout'} ${levelTxt}`;

  const lines = [
    `${phaseLabel} — ${cand.symbol} ${cand.timeframe}`,
    '',
    `Grade:      ${cand.grade}  (score ${cand.score}/100)`,
    `Direction:  ${dirWord} ${arrow}`,
    `Level:      ${levelTxt}${cand.levelStrength > 1 ? `  (multi-touch ${cand.levelStrength}x)` : ''}`,
    `Price now:  ${priceTxt}`,
    cand.phase === 'PRE'
      ? `Distance:   ${cand.distanceAtr}x ATR from the level (compressing)`
      : `Break body: ${cand.bodyAtr}x ATR · ${dispTxt}`,
    `Structure:  ${cand.trend === 'UP' ? 'higher highs / higher lows' : 'lower highs / lower lows'}`,
    '',
    'Why this chart qualified:',
    ...cand.reasons.map((r) => `  • ${r}`),
    '',
    `Time (BDT): ${when}`,
    '',
    cand.phase === 'PRE'
      ? 'Pre-breakout warning — price is coiling into a strong level. Wait for a confirmed close before acting.'
      : 'Confirmed breakout — a candle has closed decisively beyond the level.',
    'Advisory only — not financial advice.',
  ];

  const color = cand.direction === 'BUY' ? '#047857' : '#b91c1c';
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px">
      <h2 style="margin:0 0 4px;color:${cand.phase === 'PRE' ? '#b45309' : color}">${icon} ${phaseLabel} — ${cand.symbol} ${cand.timeframe}</h2>
      <p style="font-size:15px;margin:0 0 8px">
        <b style="background:${color};color:#fff;padding:2px 8px;border-radius:6px">${dirWord} ${arrow}</b>
        <span style="margin-left:8px">Grade <b>${cand.grade}</b> · score ${cand.score}/100</span>
      </p>
      <table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:10px">
        <tr><td style="padding:3px 0;color:#64748b">Level</td><td><b>${levelTxt}</b>${cand.levelStrength > 1 ? ` <span style="color:#64748b">(multi-touch ${cand.levelStrength}x)</span>` : ''}</td></tr>
        <tr><td style="padding:3px 0;color:#64748b">Price now</td><td><b>${priceTxt}</b></td></tr>
        ${cand.phase === 'PRE'
          ? `<tr><td style="padding:3px 0;color:#64748b">Distance</td><td>${cand.distanceAtr}x ATR (compressing)</td></tr>`
          : `<tr><td style="padding:3px 0;color:#64748b">Break body</td><td>${cand.bodyAtr}x ATR · ${dispTxt}</td></tr>`}
        <tr><td style="padding:3px 0;color:#64748b">Structure</td><td>${cand.trend === 'UP' ? 'higher highs / higher lows' : 'lower highs / lower lows'}</td></tr>
        <tr><td style="padding:3px 0;color:#64748b">Time (BDT)</td><td>${when}</td></tr>
      </table>
      <div style="font-size:12px;color:#475569;background:#f8fafc;padding:8px;border-radius:6px">
        ${cand.reasons.map((r) => `• ${r}`).join('<br>')}
      </div>
      <p style="font-size:12px;color:#475569;margin-top:8px">${cand.phase === 'PRE'
        ? 'Pre-breakout warning — price is coiling into a strong level. Wait for a confirmed close before acting.'
        : 'Confirmed breakout — a candle has closed decisively beyond the level.'}</p>
      <p style="font-size:11px;color:#94a3b8">Advisory only — not financial advice. — Aura Gold Breakout Engine</p>
    </div>`;

  return { subject, text: lines.join('\n'), html };
}

async function persistBreakoutAlert(cand, channel) {
  const pool = await initializeDatabase();
  if (!pool) return;
  try {
    await pool.execute(
      `INSERT INTO mt5_breakout_alerts (
         id, symbol, timeframe, phase, direction, grade, score, trend, level,
         level_strength, price, atr, distance_atr, body_atr, displacement, channel,
         bar_time, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE channel=VALUES(channel)`,
      [
        `breakout:${cand.symbol}:${cand.timeframe}:${cand.phase}:${cand.bar}`,
        cand.symbol, cand.timeframe, cand.phase, cand.direction, cand.grade, cand.score,
        cand.trend, cand.level, cand.levelStrength, cand.price, cand.atr,
        cand.distanceAtr, cand.bodyAtr,
        cand.displacement && cand.displacement.present ? 1 : 0,
        channel,
        cand.bar ? toMysqlDate(new Date(cand.bar)) : null,
        toMysqlDate(new Date()),
      ],
    );
  } catch (e) {
    // Read-only / over-quota DB (Trap #6): never let logging break alerting.
    console.warn('[Breakout] persist failed:', e.message);
  }
}

async function pruneOldBreakoutAlerts() {
  const pool = await initializeDatabase();
  if (!pool) return;
  try {
    await pool.query(
      `DELETE FROM mt5_breakout_alerts
        WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
        LIMIT 5000`,
      [BREAKOUT_RETENTION_DAYS],
    );
  } catch (e) {
    console.error('[Breakout] Prune failed:', e.message);
  }
}

// Two-tier router for a single graded candidate.
async function routeBreakout(cand) {
  const gradeRankVal = BREAKOUT_GRADE_RANK[cand.grade] ?? 0;

  // ── Tier 1: Browser desktop notification (generous, never budget-gated) ──
  const browserMinRank = BREAKOUT_GRADE_RANK[BREAKOUT_BROWSER_MIN_GRADE] ?? BREAKOUT_GRADE_RANK.B;
  if (gradeRankVal >= browserMinRank) {
    const bkey = `${cand.symbol}|${cand.timeframe}|${cand.phase}`;
    if (breakoutBrowserBars.get(bkey) !== cand.bar) {
      breakoutBrowserBars.set(bkey, cand.bar);
      sendStreamEvent('breakout', buildBreakoutPayload(cand));
      // Persist on the BROWSER tier too so the tracker page has a full history of
      // every surfaced alert (the email tier later upgrades channel → EMAIL).
      void persistBreakoutAlert(cand, 'BROWSER');
    }
  }

  // ── Tier 2: Email (strict, anti-flood) ──
  if (!(SIGNAL_ALERTS_ENABLED && signalEmailTo() && isEmailSystemEnabled('breakout'))) return;

  // Asymmetric bar: PRE (a prediction) requires at least A; CONFIRMED uses the
  // configured minimum (default B). Both respect the user's configured floor.
  const configuredMin = breakoutEmailMinRank();
  const requiredRank = cand.phase === 'PRE'
    ? Math.max(configuredMin, BREAKOUT_GRADE_RANK.A)
    : configuredMin;
  if (gradeRankVal < requiredRank) return;

  // Per-level dedup: at most 1 PRE + 1 CONFIRMED per level (bucketed), with cooldown.
  const key = `breakout-${cand.phase === 'PRE' ? 'pre' : 'confirm'}:${cand.symbol}:${cand.timeframe}:${breakoutLevelBucket(cand)}`;
  if (!canAlert(key, cand.bar, { minGapMs: BREAKOUT_EMAIL_MIN_GAP_MS })) return;

  if (!spendBreakoutEmailBudget()) {
    console.log(`[Breakout] Hourly email budget spent → ${cand.symbol} ${cand.timeframe} ${cand.phase} ${cand.grade} stays browser-only`);
    return;
  }

  const { subject, text, html } = buildBreakoutEmail(cand);
  const breakoutTo = signalEmailToFor(cand.symbol, cand.timeframe);
  if (!breakoutTo) { refundBreakoutEmailBudget(); return false; }
  try {
    await sendNotificationEmail({ to: breakoutTo, subject, text, html, signalId: key });
    recordAlert(key, cand.bar);
    void persistBreakoutAlert(cand, 'EMAIL');
    console.log(`[Breakout] Emailed ${cand.phase} ${cand.grade} ${cand.direction} ${cand.symbol} ${cand.timeframe} @ ${cand.level}`);
  } catch (e) {
    refundBreakoutEmailBudget();
    console.warn('[Breakout] email failed:', e.message);
  }
}

// Scan curated symbols × breakout timeframes for graded breakouts. Strongest
// candidates are routed first so they win the email budget on busy cycles.
async function runBreakoutScan(symbols) {
  if (!BREAKOUT_ENABLED || !Array.isArray(symbols) || !symbols.length) return;
  if (!liveSignalsAllowed()) return; // no breakout alerts while the market is calendar-closed (weekend)
  const candidates = [];
  for (const symbol of symbols) {
    for (const tf of BREAKOUT_TIMEFRAMES) {
      try {
        const candles = getRecentCandles(symbol, tf, 200);
        if (!candles || candles.length < 40) continue;
        const latest = candles[candles.length - 1];
        if (!isCandleCurrent(latest, tf)) continue;          // skip stale/disconnected feeds
        const cand = buildBreakoutCandidate({ symbol, timeframe: tf, candles }, {
          approachAtr: BREAKOUT_APPROACH_ATR,
          minBreakBodyAtr: BREAKOUT_MIN_BREAK_BODY_ATR,
        });
        if (!cand || cand.grade === 'C') continue;            // only well-formed, graded charts
        if (tf === 'M5' && cand.phase === 'PRE') continue;    // M5 = confirmation only (1 email)
        candidates.push(cand);
      } catch { /* per-symbol resilience */ }
    }
  }
  if (!candidates.length) return;
  // Strongest first: grade rank, then score → budget priority on busy cycles.
  candidates.sort((a, b) => (BREAKOUT_GRADE_RANK[b.grade] - BREAKOUT_GRADE_RANK[a.grade]) || (b.score - a.score));
  for (const cand of candidates) {
    await routeBreakout(cand);
  }
}


let scanCycleRunning = false;
async function runScanCycle() {
  if (scanCycleRunning) return;
  scanCycleRunning = true;
  try {
    const status = getMt5Status();
    const symbols = getCuratedSymbols(status.symbols);
    if (!symbols.length) return;

    // ── Fixed-time predictions first: these are expiry-sensitive. ──
    for (const expiry of FTT_EXPIRIES) {
      const results = [];
      for (const symbol of symbols) {
        if (!symbolAllowsFixedTime(symbol)) continue;    // e.g. USTEC: fixed-time disabled
        try {
          const inputs = getFttInputs(symbol, expiry);
          if (!inputs.candles || inputs.candles.length < 5) continue;
          const latest = inputs.candles[inputs.candles.length - 1];
          if (!isCandleCurrent(latest, inputs.timeframe)) continue;
          const bar = latest.time;
          const sourceReceivedAt = latest.receivedAt || latest.raw?.receivedAt || null;
          const pred = generateFttPrediction({
            symbol, expiry, timeframe: inputs.timeframe, candles: inputs.candles, indicators: inputs.indicators,
            marketLevels: inputs.marketLevels, accountSnapshot: inputs.accountSnapshot,
            adr: inputs.adr, dailyHighLow: inputs.dailyHighLow,
            h4Candles: getRecentCandles(symbol, 'H4', 150), h1Candles: getRecentCandles(symbol, 'H1', 150),
          });
          const latestAi = fttPredictions.find((p) => p.symbol === symbol && p.expiry === expiry && p.source === 'ai') || null;
          results.push({ symbol, expiry, systemPrediction: { direction: pred.direction, confidence: pred.confidence, entryPrice: pred.entryPrice, reasoning: pred.reasoning, indicators: pred.indicators, tradeStatus: fttTradeStatus(pred.direction, pred.confidence, pred.indicators) }, latestAiPrediction: latestAi });

          const dedupKey = `${symbol}|${expiry}`;
          if (lastFttBar.get(dedupKey) !== bar) {
            lastFttBar.set(dedupKey, bar);
            const tradeStatus = fttTradeStatus(pred.direction, pred.confidence, pred.indicators);
            // Calendar gate: no live fixed-time prediction is persisted/streamed/emailed while
            // the market is closed (weekend), even on fresh weekend bars.
            if (liveSignalsAllowed() && pred.direction !== 'HOLD' && fttTierAllowed(tradeStatus, 'fixedTimeMinTier') && isEmailSystemEnabled('fixedTime')) {
              const now = new Date();
              const prediction = {
                id: `ftt_sys_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                symbol, expiry, direction: pred.direction, confidence: pred.confidence,
                entryPrice: pred.entryPrice, entryTime: now.toISOString(),
                expiryTime: new Date(now.getTime() + parseExpiryDuration(expiry)).toISOString(),
                exitPrice: null, outcome: 'PENDING', source: 'system',
                reasoning: pred.reasoning, indicators: pred.indicators, created_at: now.toISOString(),
                sourceBarTime: bar, sourceReceivedAt,
              };
              await persistFttPrediction(prediction);
              fttPredictions.unshift(prediction);
              sendStreamEvent('ftt_prediction', prediction);
              if (SIGNAL_ALERTS_ENABLED && signalEmailTo()) {
                const key = `ftt:${symbol}:${expiry}`;
                if (canAlert(key, bar, { minGapMs: SIGNAL_ALERT_MIN_GAP_MS })) {
                  const sent = await sendFttAlert(prediction);
                  if (sent) {
                    recordAlert(key, bar);
                    console.log(`[Scanner] Emailed FUTURE ${prediction.direction} ${symbol} ${expiry} ${Math.round(pred.confidence)}%`);
                  }
                }
              }
            }
          }
        } catch (e) { /* per-symbol resilience */ }
      }
      fttScanCacheByExpiry.set(expiry, { results, at: Date.now() });
    }

    // ── Forex system scans (AI disabled to save token costs) ──
    for (const tf of SCAN_TIMEFRAMES) {
      const results = [];
      for (const symbol of symbols) {
        try {
          const r = scanForexSymbol(symbol, tf);
          if (!r) continue;
          results.push(r);
          const sd = r.systemDecision;
          // Calendar gate: never emit a live forex alert (topbar/SSE/email) while the market is
          // closed, even on fresh weekend bars. logSystemSignal below still records it for reports.
          const marketOpen = liveSignalsAllowed();
          if (marketOpen && !r.outdated && isTopbarForexSignal(sd)) {
            const topbarKey = `${symbol}|${tf}`;
            if (topbarForexAlertBars.get(topbarKey) !== r.bar) {
              topbarForexAlertBars.set(topbarKey, r.bar);
              sendStreamEvent('quality_forex_signal', buildTopbarForexAlert(r));
            }
          }
          let emailed = false;
          if (marketOpen && !r.outdated && forexScannerEmailAllowed(sd)) {
            recordForexDailyBestCandidate(r);
            // Email (dedup: once per symbol/bar + min gap).
            if (SIGNAL_ALERTS_ENABLED && signalEmailTo() && isEmailSystemEnabled('forexScanner')) {
              const key = `forex:${symbol}:${tf}`;
              if (canAlert(key, r.bar, { minGapMs: SIGNAL_ALERT_MIN_GAP_MS })) {
                const sent = await sendForexAlert(r);
                if (sent) {
                  recordAlert(key, r.bar);
                  emailed = true;
                  console.log(`[Scanner] Emailed ${sd.grade} ${sd.decision} ${symbol} ${tf}`);
                }
              }
            }
          }
          // Record every executable A/A+ setup (emailed or filtered) to the signal log.
          if (!r.outdated) await logSystemSignal(r, { emailed });
        } catch (e) { /* per-symbol resilience */ }
      }
      scanCacheByTf.set(tf, { results, at: Date.now() });
    }
    await maybeSendForexDailyBestEmail(new Date());
    refreshPostNewsSignals(Date.now());
    await reforecastActiveForecasts();
    await scanNewsReactions();
    await runBreakoutScan(symbols);
    pruneAlerts();
  } catch (err) {
    console.error('[Scanner] cycle error:', err.message);
  } finally {
    scanCycleRunning = false;
  }
}

function startBackgroundScanner() {
  if (!SCANNER_ENABLED) { console.log('[Scanner] Disabled via SCANNER_ENABLED=false.'); return; }
  const timer = setInterval(() => void runScanCycle(), SCANNER_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  // First cycle shortly after boot (let the cache warm + EA push a snapshot).
  setTimeout(() => void runScanCycle(), 8000);
  console.log(`[Scanner] Background scanner started. TFs=${SCAN_TIMEFRAMES.join(',')} expiries=${FTT_EXPIRIES.join(',')} every ${SCANNER_INTERVAL_MS / 1000}s. AI on >=${process.env.SIGNAL_ALERT_MIN_GRADE || 'B Setup'}. Alerts->${signalEmailTo() || 'disabled'}`);
}
startBackgroundScanner();


// ── Execution Forecast scan (Phase 1: hourly, deterministic) ─────────────────
// Predicts WHEN a favorable-but-not-yet-executable setup becomes executable.
// Reuses aggregateSignals so there is ZERO scoring drift from the live scanner.
// Confidence values are uncalibrated model estimates until Phase 5.
const FORECAST_SCAN_INTERVAL_MS = Math.max(5 * 60 * 1000, Number(process.env.FORECAST_SCAN_INTERVAL_MS || 60 * 60 * 1000));
const FORECAST_RETENTION_DAYS = Math.max(1, Number(process.env.FORECAST_RETENTION_DAYS || 14));
const FORECAST_ENABLED = String(process.env.FORECAST_ENABLED || 'true').toLowerCase() !== 'false';
let forecastScanRunning = false;
const lastForecastByKey = new Map(); // symbol|tf -> last engine output (slope + reforecast)

// News-aware forecasting windows (user choice: 15m pre / 10m post).
const NEWS_PRE_WINDOW_MIN = Math.max(1, Number(process.env.NEWS_PRE_WINDOW_MIN || 15));
const NEWS_POST_WINDOW_MIN = Math.max(1, Number(process.env.NEWS_POST_WINDOW_MIN || 10));
const NEWS_REACTION_MIN_BODY = Math.max(0.2, Number(process.env.NEWS_REACTION_MIN_BODY || 0.5));
const newsReactionSent = new Map(); // `${eventId}|${symbol}|${tier}` -> ts (dedup reaction signals)

// Nearest HIGH-impact event for a symbol within the pre-window (upcoming) or
// post-window (just released). Returns { event, isUpcoming, isReacting } | null.
function nearestHighImpactEvent(symbol, nowMs) {
  let events;
  try { events = getUpcomingForSymbol(symbol, nowMs, 12); } catch { return null; }
  if (!events || !events.length) return null;
  const preMs = NEWS_PRE_WINDOW_MIN * 60 * 1000;
  const postMs = NEWS_POST_WINDOW_MIN * 60 * 1000;
  let best = null;
  for (const e of events) {
    if (String(e.impact).toUpperCase() !== 'HIGH') continue;
    const dt = e.timestampUtc - nowMs;
    if (dt >= -postMs && dt <= preMs) {
      if (!best || Math.abs(dt) < Math.abs(best.event.timestampUtc - nowMs)) {
        best = { event: e, isUpcoming: dt >= 0, isReacting: dt < 0 && dt >= -postMs };
      }
    }
  }
  return best;
}

async function persistExecutionForecast(fc, transition) {
  const pool = await initializeDatabase();
  if (!pool) return;
  const now = new Date();
  const eta = Number.isFinite(fc.expectedExecutionMs) ? new Date(fc.expectedExecutionMs) : null;
  const prevEta = transition && Number.isFinite(transition.prevExecutionMs) ? new Date(transition.prevExecutionMs) : null;
  await pool.execute(
    `INSERT INTO mt5_execution_forecasts (
       id, symbol, timeframe, scan_time, current_status, execution_status, decision,
       lean, lean_conviction,
       setup_score, score_change, trend_strength, momentum, volatility, liquidity,
       session, regime, execution_probability, forecast_confidence, forecast_basis,
       expected_execution_time, prev_execution_time, status, reforecast_count, reason,
       entry_price, stop_loss, take_profit_1, original_execution_time, original_score, calibrated,
       news_imminent, news_event, news_event_time, news_tier,
       created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       scan_time=VALUES(scan_time), current_status=VALUES(current_status),
       execution_status=VALUES(execution_status), decision=VALUES(decision),
       lean=VALUES(lean), lean_conviction=VALUES(lean_conviction),
       setup_score=VALUES(setup_score), score_change=VALUES(score_change),
       trend_strength=VALUES(trend_strength), momentum=VALUES(momentum),
       volatility=VALUES(volatility), liquidity=VALUES(liquidity),
       session=VALUES(session), regime=VALUES(regime),
       execution_probability=VALUES(execution_probability),
       forecast_confidence=VALUES(forecast_confidence), forecast_basis=VALUES(forecast_basis),
       expected_execution_time=VALUES(expected_execution_time),
       prev_execution_time=VALUES(prev_execution_time), status=VALUES(status),
       reforecast_count=VALUES(reforecast_count), reason=VALUES(reason),
       entry_price=VALUES(entry_price), stop_loss=VALUES(stop_loss),
       take_profit_1=VALUES(take_profit_1), calibrated=VALUES(calibrated),
       news_imminent=VALUES(news_imminent), news_event=VALUES(news_event),
       news_event_time=VALUES(news_event_time), news_tier=VALUES(news_tier),
       updated_at=VALUES(updated_at)`,
    [
      fc.id, fc.symbol, fc.timeframe, toMysqlDate(now), fc.currentStatus, fc.executionStatus, fc.decision,
      fc.lean || null, fc.leanConviction ?? null,
      fc.setupScore, fc.scoreChange, fc.trendStrength, fc.momentum, fc.volatility, fc.liquidity,
      fc.session || null, fc.regime, fc.executionProbability, fc.forecastConfidence, fc.forecastBasis,
      eta ? toMysqlDate(eta) : null, prevEta ? toMysqlDate(prevEta) : null,
      transition ? transition.status : 'FORECASTED', transition ? transition.reforecastCount : 0, fc.reason,
      fc.entryPrice, fc.stopLoss, fc.takeProfit1,
      eta ? toMysqlDate(eta) : null, fc.setupScore, fc.calibrated ? 1 : 0,
      fc.newsImminent ? 1 : 0,
      fc.newsEvent ? `${fc.newsEvent.currency || ''} ${fc.newsEvent.title || ''}`.trim().slice(0, 160) : null,
      fc.newsEvent && fc.newsEvent.timeIso ? toMysqlDate(new Date(fc.newsEvent.timeIso)) : null,
      fc.newsTier || null,
      toMysqlDate(now), toMysqlDate(now),
    ],
  );
}

// Build the SSE payload for a forecast — identical shape to normalizeForecastRow
// so the frontend handles one type whether it arrives by fetch or by stream.
function emitForecast(fc, transition) {
  sendStreamEvent('execution_forecast', {
    id: fc.id, symbol: fc.symbol, timeframe: fc.timeframe,
    scanTime: new Date(fc.scanTimeMs || Date.now()).toISOString(),
    currentStatus: fc.currentStatus, executionStatus: fc.executionStatus, decision: fc.decision,
    lean: fc.lean || null, leanConviction: fc.leanConviction ?? null,
    setupScore: fc.setupScore, scoreChange: fc.scoreChange,
    trendStrength: fc.trendStrength, momentum: fc.momentum, volatility: fc.volatility, liquidity: fc.liquidity,
    session: fc.session || null, regime: fc.regime,
    executionProbability: fc.executionProbability, forecastConfidence: fc.forecastConfidence,
    forecastBasis: fc.forecastBasis,
    expectedExecutionTime: Number.isFinite(fc.expectedExecutionMs) ? new Date(fc.expectedExecutionMs).toISOString() : null,
    prevExecutionTime: transition && Number.isFinite(transition.prevExecutionMs) ? new Date(transition.prevExecutionMs).toISOString() : null,
    status: transition ? transition.status : 'FORECASTED',
    reforecastCount: transition ? transition.reforecastCount : 0,
    reason: fc.reason,
    entryPrice: fc.entryPrice, stopLoss: fc.stopLoss, takeProfit1: fc.takeProfit1,
    newsImminent: Boolean(fc.newsImminent),
    newsEvent: fc.newsEvent ? `${fc.newsEvent.currency || ''} ${fc.newsEvent.title || ''}`.trim() : null,
    newsEventTime: fc.newsEvent && fc.newsEvent.timeIso ? fc.newsEvent.timeIso : null,
    newsTier: fc.newsTier || null,
    calibrated: Boolean(fc.calibrated),
  });
}

async function runExecutionForecastScan() {
  if (!FORECAST_ENABLED || forecastScanRunning) return;
  forecastScanRunning = true;
  try {
    await refreshForecastCalibration();
    const status = getMt5Status();
    const symbols = getCuratedSymbols(status.symbols);
    if (!symbols.length) return;
    let written = 0;
    for (const symbol of symbols) {
      if (!symbolAllowsForecast(symbol)) continue;       // e.g. USTEC: forecasts assume FX sessions
      const newsHit = nearestHighImpactEvent(symbol, Date.now());
      const upcomingEvent = newsHit && newsHit.isUpcoming ? newsHit.event : null;
      for (const tf of FORECAST_TIMEFRAMES) {
        try {
          const candleList = getRecentCandles(symbol, tf, 200);
          if (!candleList || candleList.length < 20) continue;
          const latest = candleList[candleList.length - 1];
          if (!isCandleCurrent(latest, tf)) continue; // can't forecast on stale data
          const { adr, dailyHighLow } = computeAdrDaily(symbol);
          const summary = aggregateSignals({
            symbol, timeframe: tf, candles: candleList,
            indicators: getRecentIndicators(symbol, tf, 500),
            marketLevels, accountSnapshot: mt5State.accountSnapshot, adr, dailyHighLow,
            h4Candles: getRecentCandles(symbol, 'H4', 150),
            h1Candles: getRecentCandles(symbol, 'H1', 150),
          });
          const sd = summary.systemDecision;
          const key = `${symbol}|${tf}`;
          const prev = lastForecastByKey.get(key) || null;
          const fc = buildExecutionForecast({
            symbol, timeframe: tf, systemDecision: sd, nowMs: Date.now(),
            prevForecast: prev, scanIntervalMs: FORECAST_SCAN_INTERVAL_MS,
            newsEvent: upcomingEvent, newsPreWindowMs: NEWS_PRE_WINDOW_MIN * 60 * 1000,
          });
          if (!fc) {
            // No longer a candidate — cancel any forecast we were tracking.
            if (prev) {
              const transition = reforecastExecution(prev, null);
              const cancelled = { ...prev, reason: transition.reason };
              await persistExecutionForecast(cancelled, transition);
              emitForecast(cancelled, transition);
              lastForecastByKey.delete(key);
            }
            continue;
          }
          fc.session = sd?.sessionContext?.reason ? String(sd.sessionContext.reason).slice(0, 60) : null;
          applyForecastCalibration(fc);
          const transition = prev
            ? reforecastExecution(prev, fc)
            : { status: 'FORECASTED', reason: fc.reason, prevExecutionMs: null, reforecastCount: 0 };
          await persistExecutionForecast(fc, transition);
          emitForecast(fc, transition);
          lastForecastByKey.set(key, { ...fc, reforecastCount: transition.reforecastCount, status: transition.status });
          written++;
        } catch (e) { /* per-symbol resilience */ }
      }
    }
    if (written) console.log(`[Forecast] Scan complete — ${written} forecasts across ${symbols.length} symbols x ${FORECAST_TIMEFRAMES.length} TFs.`);
  } catch (err) {
    console.error('[Forecast] Scan error:', err.message);
  } finally {
    forecastScanRunning = false;
  }
}

async function pruneOldExecutionForecasts() {
  const pool = await initializeDatabase();
  if (!pool) return;
  try {
    await pool.query(
      `DELETE FROM mt5_execution_forecasts
        WHERE status IN ('CANCELLED','EXPIRED','EXECUTED')
          AND updated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
        LIMIT 5000`,
      [FORECAST_RETENTION_DAYS],
    );
  } catch (e) {
    console.error('[Forecast] Prune failed:', e.message);
  }
}

// Lightweight reforecast pass run from the 60s scanner. Only re-evaluates
// in-memory active forecasts approaching/just past their ETA — implements the
// "2:50 / 2:55 / 2:59" re-check logic and streams Delayed/Cancelled/Ready/Expired.
const FORECAST_REFORECAST_WINDOW_MS = Math.max(60000, Number(process.env.FORECAST_REFORECAST_WINDOW_MS || 20 * 60 * 1000));

async function reforecastActiveForecasts() {
  if (!FORECAST_ENABLED || !lastForecastByKey.size) return;
  const nowMs = Date.now();
  const pool = await initializeDatabase();
  for (const [key, prev] of [...lastForecastByKey.entries()]) {
    try {
      const eta = Number.isFinite(prev.expectedExecutionMs) ? prev.expectedExecutionMs : null;
      // Skip forecasts whose ETA is still comfortably in the future — keeps the tick cheap.
      if (eta !== null && (eta - nowMs) > FORECAST_REFORECAST_WINDOW_MS) continue;
      const [symbol, tf] = key.split('|');
      const candleList = getRecentCandles(symbol, tf, 200);
      if (!candleList || candleList.length < 20) continue;
      const latest = candleList[candleList.length - 1];
      if (!isCandleCurrent(latest, tf)) continue;
      const { adr, dailyHighLow } = computeAdrDaily(symbol);
      const summary = aggregateSignals({
        symbol, timeframe: tf, candles: candleList,
        indicators: getRecentIndicators(symbol, tf, 500),
        marketLevels, accountSnapshot: mt5State.accountSnapshot, adr, dailyHighLow,
        h4Candles: getRecentCandles(symbol, 'H4', 150), h1Candles: getRecentCandles(symbol, 'H1', 150),
      });
      const sd = summary.systemDecision;
      const reHit = nearestHighImpactEvent(symbol, nowMs);
      const reUpcoming = reHit && reHit.isUpcoming ? reHit.event : null;
      const fresh = buildExecutionForecast({
        symbol, timeframe: tf, systemDecision: sd, nowMs, prevForecast: prev, scanIntervalMs: SCANNER_INTERVAL_MS,
        newsEvent: reUpcoming, newsPreWindowMs: NEWS_PRE_WINDOW_MIN * 60 * 1000,
      });
      if (!fresh) {
        // Setup invalidated → CANCELLED (counts as a miss in calibration).
        const transition = reforecastExecution(prev, null);
        const cancelled = { ...prev, reason: transition.reason };
        await persistExecutionForecast(cancelled, transition);
        if (pool) await resolveForecastRow(pool, prev.id, 'CANCELLED', nowMs, null);
        emitForecast(cancelled, transition);
        lastForecastByKey.delete(key);
        continue;
      }
      fresh.session = sd?.sessionContext?.reason ? String(sd.sessionContext.reason).slice(0, 60) : null;
      applyForecastCalibration(fresh);
      let transition = reforecastExecution(prev, fresh);
      // Expire forecasts whose ETA passed by > 1 bar and never became ready.
      if (transition.status !== 'READY' && eta !== null && (nowMs - eta) > forecastTfSeconds(tf) * 1000) {
        transition = { status: 'EXPIRED', reason: 'Execution window passed without becoming executable.', prevExecutionMs: eta, reforecastCount: (prev.reforecastCount || 0) + 1 };
      }

      if (transition.status === 'READY') {
        // Became executable → this IS the execution moment: full-detail email + resolve.
        await persistExecutionForecast(fresh, transition);
        await sendForecastReadyEmail(pool, fresh.id, symbol, tf, sd);
        if (pool) await resolveForecastRow(pool, fresh.id, 'EXECUTED', nowMs, fresh.setupScore);
        // Open the trade-outcome ledger for this execution: capture the full TP
        // ladder so processForecastTradeOutcomes can later settle WIN/LOSS.
        if (pool) await initForecastTrade(pool, fresh.id, sd);
        emitForecast(fresh, { ...transition, status: 'EXECUTED' });
        lastForecastByKey.delete(key);
      } else if (transition.status === 'EXPIRED') {
        await persistExecutionForecast(fresh, transition);
        if (pool) await resolveForecastRow(pool, fresh.id, 'EXPIRED', nowMs, null);
        emitForecast(fresh, transition);
        lastForecastByKey.delete(key);
      } else {
        await persistExecutionForecast(fresh, transition);
        emitForecast(fresh, transition);
        lastForecastByKey.set(key, { ...fresh, reforecastCount: transition.reforecastCount, status: transition.status });
      }
    } catch (e) { /* per-forecast resilience */ }
  }
}

// ── News reaction scanner (two-tier) — runs on the 60s scanner ───────────────
// Reacts to ACTUAL post-release price (never predicts the number). Tier A = the
// first decisive candle (the spike, aggressive); Tier B = confirmed follow-through.
const NEWS_REACTION_TF = (process.env.NEWS_REACTION_TF || 'M5').toUpperCase();

async function sendNewsReactionEmail(fc, event, reaction, levels) {
  if (!SIGNAL_ALERTS_ENABLED || !signalEmailTo() || !isEmailSystemEnabled('forecast')) return;
  const sym = fc.symbol;
  const tierLabel = reaction.tier === 'B' ? 'CONFIRMED REACTION' : 'SPIKE (aggressive)';
  const dirColor = fc.decision === 'BUY' ? '#047857' : '#b91c1c';
  const warn = reaction.tier === 'A'
    ? 'Tier A spike — entered on the FIRST candle. Spreads are wide and reversals common; size down and use the stop.'
    : 'Tier B — direction confirmed by follow-through. Still a volatile news move; manage risk.';
  const subject = `[NEWS ${tierLabel}] ${fc.decision} ${sym} ${NEWS_REACTION_TF} · ${event.currency} ${event.title}`;
  const text = [
    `AURA GOLD - NEWS REACTION (${tierLabel})`,
    `${sym} ${NEWS_REACTION_TF} | ${fc.decision} | driver: ${event.currency} ${event.title}`,
    `Entry ${px(levels.entry, sym)}  SL ${px(levels.stopLoss, sym)}  TP1 ${px(levels.takeProfit1, sym)}  TP2 ${px(levels.takeProfit2, sym)}  TP3 ${px(levels.takeProfit3, sym)}  (ATR-scaled, RR 1:1/1:2/1:3)`,
    `Direction is from the ACTUAL price reaction, not a prediction of the release.`,
    warn,
    'Advisory only — not financial advice.',
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:640px">
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.12em;color:#b45309;text-transform:uppercase">News Reaction · ${tierLabel}</p>
    <h2 style="margin:0 0 4px;color:${dirColor}">${fc.decision} ${sym} <span style="font-size:13px;color:#64748b">${NEWS_REACTION_TF}</span></h2>
    <p style="font-size:13px;color:#0f172a">Driver: <b>${event.currency} ${event.title}</b></p>
    <table style="font-size:13px;border-collapse:collapse">
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Entry</td><td><b>${px(levels.entry, sym)}</b></td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Stop Loss</td><td style="color:#b91c1c">${px(levels.stopLoss, sym)}</td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">TP1 / TP2 / TP3</td><td style="color:#047857">${px(levels.takeProfit1, sym)} / ${px(levels.takeProfit2, sym)} / ${px(levels.takeProfit3, sym)}</td></tr>
    </table>
    <p style="font-size:12px;color:#b45309;margin:8px 0 0">${warn}</p>
    <p style="font-size:12px;color:#475569;margin:4px 0 0">Direction is from the <b>actual price reaction</b>, not a pre-release guess. ATR-scaled levels.</p>
    <p style="font-size:11px;color:#94a3b8;margin-top:8px">Advisory only — not financial advice. — Aura Gold News Reaction</p></div>`;
  const newsTo = signalEmailToFor(sym, null);
  if (!newsTo) return;
  try {
    await sendNotificationEmail({ to: newsTo, subject, text, html, signalId: `newsreact:${event.id}:${sym}:${reaction.tier}` });
    console.log(`[Forecast] Emailed NEWS ${tierLabel} ${fc.decision} ${sym} (${event.title})`);
  } catch (e) {
    console.error('[Forecast] News reaction email failed:', e.message);
  }
}

async function scanNewsReactions() {
  if (!FORECAST_ENABLED) return;
  const nowMs = Date.now();
  const symbols = getCuratedSymbols(getMt5Status().symbols);
  if (!symbols.length) return;
  const pool = await initializeDatabase();
  // Expire stale READY reaction rows whose post-window has closed (keeps the table clean).
  if (pool) {
    try {
      await pool.execute(
        `UPDATE mt5_execution_forecasts SET status='EXPIRED', resolved_at=?, updated_at=?
          WHERE news_tier IS NOT NULL AND status='READY'
            AND news_event_time < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)`,
        [toMysqlDate(new Date()), toMysqlDate(new Date()), NEWS_POST_WINDOW_MIN],
      );
    } catch { /* non-fatal */ }
  }
  for (const symbol of symbols) {
    try {
      const hit = nearestHighImpactEvent(symbol, nowMs);
      if (!hit || !hit.isReacting) continue;
      const event = hit.event;
      const candles = getRecentCandles(symbol, NEWS_REACTION_TF, 60);
      if (!candles || candles.length < 16) continue;
      const reaction = detectNewsReaction({
        candles, eventMs: event.timestampUtc,
        postWindowMs: NEWS_POST_WINDOW_MIN * 60 * 1000, minBodyPct: NEWS_REACTION_MIN_BODY,
      });
      if (!reaction) continue;
      const dedupKey = `${event.id}|${symbol}|${reaction.tier}`;
      if (newsReactionSent.has(dedupKey)) continue;
      const levels = buildNewsReactionLevels({ candles, direction: reaction.direction });
      if (!levels) continue;
      newsReactionSent.set(dedupKey, nowMs);
      const id = `fc:${symbol.toUpperCase()}|NEWS|${event.id}`;
      const fc = {
        id, symbol: symbol.toUpperCase(), timeframe: NEWS_REACTION_TF, scanTimeMs: nowMs,
        currentStatus: 'Good Condition', executionStatus: 'EXECUTABLE',
        decision: reaction.direction, lean: reaction.direction, leanConviction: null,
        regime: 'news', setupScore: reaction.tier === 'B' ? 78 : 72, scoreChange: null,
        trendStrength: null, momentum: null, volatility: null, liquidity: null,
        executionProbability: reaction.tier === 'B' ? 72 : 58,
        forecastConfidence: reaction.tier === 'B' ? 70 : 50,
        forecastBasis: 'NEWS', expectedExecutionMs: nowMs,
        reason: `News reaction Tier ${reaction.tier} — ${reaction.direction} after ${event.currency} ${event.title} (${reaction.candles} candle${reaction.candles > 1 ? 's' : ''}).`,
        entryPrice: levels.entry, stopLoss: levels.stopLoss, takeProfit1: levels.takeProfit1,
        newsImminent: true,
        newsEvent: { title: event.title, currency: event.currency, impact: event.impact, timeIso: event.timeIso },
        newsTier: reaction.tier, calibrated: false,
      };
      const transition = { status: 'READY', reason: fc.reason, prevExecutionMs: null, reforecastCount: 0 };
      await persistExecutionForecast(fc, transition);
      emitForecast(fc, transition);
      await sendNewsReactionEmail(fc, event, reaction, levels);
    } catch (e) { /* per-symbol resilience */ }
  }
}

// ── Forecast email workflow (Phase 3) ───────────────────────────────────────
// Four one-shot stages per forecast row: Created, T-10m, T-5m, at-ETA. Reuses
// sendNotificationEmail, the 'forecast' email-system toggle, signalEmailTo(),
// and natural dedup via the email_* boolean flags on the row.
const FORECAST_EMAIL_MIN_SCORE = Number(process.env.FORECAST_EMAIL_MIN_SCORE || 75);
// The "now executable" READY email fires at the executable threshold — a setup
// is, by definition, ready at EXECUTABLE_SCORE. Gating it at the higher
// FORECAST_EMAIL_MIN_SCORE (75) silently dropped ready setups in the 70-74.9
// band (they resolved EXECUTED with no direction emailed). The pre-execution
// reminders keep the higher FORECAST_EMAIL_MIN_SCORE bar.
const FORECAST_READY_EMAIL_MIN_SCORE = Number(process.env.FORECAST_READY_EMAIL_MIN_SCORE || FC_EXECUTABLE_SCORE);
const FORECAST_BASIS_LABELS = {
  IMMEDIATE: 'Ready now', NEXT_CANDLE: 'Next candle', PULLBACK: 'Pullback',
  SCORE_SLOPE: 'Score rising', SESSION: 'Session open', UNKNOWN: 'No clear path',
};
const FORECAST_STAGE_LABELS = {
  created: 'Forecast created', reminder1: 'Reminder · ~10 min to execution',
  reminder2: 'Reminder · ~5 min to execution', execution: 'Execution window reached',
};

function buildForecastEmail(row, stage, etaMs) {
  const dir = row.decision && row.decision !== 'HOLD' ? String(row.decision).replace('_', ' ') : '—';
  const etaClock = etaMs ? `${formatAppDateTime(etaMs)} BDT` : 'n/a';
  const basis = FORECAST_BASIS_LABELS[row.forecast_basis] || row.forecast_basis || '—';
  const stageLabel = FORECAST_STAGE_LABELS[stage] || stage;
  const dirColor = String(row.decision || '').includes('BUY') ? '#047857' : String(row.decision || '').includes('SELL') ? '#b91c1c' : '#334155';
  const subject = `[FORECAST | ${stageLabel}] ${dir} ${row.symbol} ${row.timeframe} · ETA ${etaClock} · score ${row.setup_score}`;
  const text = [
    `AURA GOLD - EXECUTION FORECAST (${stageLabel})`,
    `${row.symbol} ${row.timeframe} | ${dir} | ${row.current_status}`,
    `Expected execution: ${etaClock} (${basis})`,
    `Setup score: ${row.setup_score}${row.score_change !== null && row.score_change !== undefined ? ` (${Number(row.score_change) >= 0 ? '+' : ''}${row.score_change})` : ''}`,
    `Execution probability: ${row.execution_probability ?? 'n/a'}%`,
    `Forecast confidence: ${row.forecast_confidence ?? 'n/a'}% (uncalibrated model estimate — not a guarantee)`,
    row.entry_price !== null && row.entry_price !== undefined ? `Reference levels — Entry ${px(row.entry_price, row.symbol)} · SL ${px(row.stop_loss, row.symbol)} · TP1 ${px(row.take_profit_1, row.symbol)}` : '',
    row.reason ? `Why: ${row.reason}` : '',
    row.session ? `Session: ${row.session}` : '',
    '',
    'This is a TIMING FORECAST, not a live trade signal. Confirm the setup on the chart before acting.',
    'Advisory only — not financial advice. Manage your own risk.',
  ].filter(Boolean).join('\n');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.12em;color:#b45309;text-transform:uppercase">Execution Forecast · ${stageLabel}</p>
      <h2 style="margin:0 0 4px;color:${dirColor}">${dir} ${row.symbol} <span style="font-size:13px;color:#64748b">${row.timeframe}</span></h2>
      <p style="margin:0 0 8px;font-size:13px;color:#0f172a"><b>Expected execution ${etaClock}</b> · ${basis} · ${row.current_status}</p>
      <table style="font-size:13px;border-collapse:collapse">
        <tr><td style="padding:2px 12px 2px 0;color:#64748b">Setup score</td><td><b>${row.setup_score}</b>${row.score_change !== null && row.score_change !== undefined ? ` <span style="color:${Number(row.score_change) >= 0 ? '#047857' : '#b91c1c'}">(${Number(row.score_change) >= 0 ? '+' : ''}${row.score_change})</span>` : ''}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#64748b">Execution probability</td><td><b>${row.execution_probability ?? 'n/a'}%</b></td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#64748b">Forecast confidence</td><td>${row.forecast_confidence ?? 'n/a'}% <span style="color:#94a3b8">· est. (uncalibrated)</span></td></tr>
        ${row.entry_price !== null && row.entry_price !== undefined ? `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Reference</td><td>Entry ${px(row.entry_price, row.symbol)} · SL <span style="color:#b91c1c">${px(row.stop_loss, row.symbol)}</span> · TP1 <span style="color:#047857">${px(row.take_profit_1, row.symbol)}</span></td></tr>` : ''}
      </table>
      ${row.reason ? `<p style="font-size:12px;color:#475569;margin:8px 0 0">${row.reason}</p>` : ''}
      ${row.session ? `<p style="font-size:12px;color:#475569;margin:2px 0 0">Session: ${row.session}</p>` : ''}
      <p style="font-size:12px;color:#b45309;margin:10px 0 0">This is a <b>timing forecast</b>, not a live trade signal — confirm on the chart before acting.</p>
      <p style="font-size:11px;color:#94a3b8;margin-top:8px">Advisory only — not financial advice. — Aura Gold Forecast</p>
    </div>`;
  return { subject, text, html };
}

// Full-detail "now executable" email sent at the READY transition — the complete
// trade ticket (TP1/2/3, RR, risk plan, confluences), same depth as the Signals
// dashboard / forex alert, built from the live systemDecision.
function buildForecastReadyEmail(symbol, timeframe, sd) {
  const money = (v) => (v === null || v === undefined ? 'n/a' : `$${Number(v).toFixed(2)}`);
  const dir = String(sd.decision || '').replace('_', ' ');
  const dirColor = String(sd.decision || '').includes('BUY') ? '#047857' : String(sd.decision || '').includes('SELL') ? '#b91c1c' : '#334155';
  const quality = sd.signalQuality || setupLabel(sd.grade);
  const risk = sd.riskPlan;
  const conf = sd.confluences || [];
  const subject = `[FORECAST READY → EXECUTE] ${dir} ${symbol} ${timeframe} · ${quality} · score ${Math.round(sd.confidence)}`;
  const text = [
    `AURA GOLD - FORECAST NOW EXECUTABLE`,
    `${symbol} ${timeframe} | ${dir} | ${quality} | Grade ${sd.grade} | Score ${Math.round(sd.confidence)}/100`,
    `Entry ${px(sd.entryPrice, symbol)}  SL ${px(sd.stopLoss, symbol)}  TP1 ${px(sd.takeProfit1, symbol)}  TP2 ${px(sd.takeProfit2, symbol)}  TP3 ${px(sd.takeProfit3, symbol)}`,
    `RR ${sd.riskRewardRatio ?? 'n/a'} | Trigger ${sd.entryTrigger || 'IMMEDIATE'} | ${sd.timingTip || ''}`,
    risk ? `Risk ${risk.riskPercent}% · Max loss ${money(risk.amountToRisk ?? risk.riskAmount ?? risk.maxLoss)} · Lot ${risk.suggestedLotSize ?? 'n/a'} · Margin ${money(risk.marginRequired ?? risk.amountToInvestApprox)}` : '',
    risk ? `Profit @ TP1 ${money(risk.profitAtTp1)} · TP2 ${money(risk.profitAtTp2)} · TP3 ${money(risk.profitAtTp3)}` : '',
    sd.sessionContext ? `Session: ${sd.sessionContext.reason}` : '',
    `Confluences: ${conf.map((c) => `${c.name}+${c.points}`).join(', ') || 'none'}`,
    '',
    'This setup was forecast and is NOW executable. Advisory only — not financial advice; manage your own risk.',
  ].filter(Boolean).join('\n');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:680px">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.12em;color:#b45309;text-transform:uppercase">Forecast Ready → Execute Now</p>
      <h2 style="margin:0 0 4px;color:${dirColor}">${dir} ${symbol} <span style="font-size:13px;color:#64748b">${timeframe}</span></h2>
      <p style="margin:0 0 8px"><b>${quality}</b> · ${sd.grade} · ${sd.strategyType || 'SYSTEM_CONFLUENCE'} · Score ${Math.round(sd.confidence)}/100 · RR ${sd.riskRewardRatio ?? 'n/a'} · ${sd.entryTrigger || 'IMMEDIATE'}</p>
      <table style="font-size:13px;border-collapse:collapse">
        <tr><td style="padding:2px 10px 2px 0;color:#64748b">Entry</td><td><b>${px(sd.entryPrice, symbol)}</b></td></tr>
        <tr><td style="padding:2px 10px 2px 0;color:#64748b">Stop Loss</td><td style="color:#b91c1c">${px(sd.stopLoss, symbol)}</td></tr>
        <tr><td style="padding:2px 10px 2px 0;color:#64748b">TP1 / TP2 / TP3</td><td style="color:#047857">${px(sd.takeProfit1, symbol)} / ${px(sd.takeProfit2, symbol)} / ${px(sd.takeProfit3, symbol)}</td></tr>
      </table>
      ${risk ? `<div style="margin:10px 0;padding:10px;border:1px solid #fde68a;background:#fffbeb;border-radius:10px"><p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#92400e;text-transform:uppercase">Position Plan</p><p style="font-size:13px;margin:2px 0">Risk <b>${risk.riskPercent}%</b> · Max loss <b>${money(risk.amountToRisk ?? risk.riskAmount ?? risk.maxLoss)}</b> · Lot <b>${risk.suggestedLotSize ?? 'n/a'}</b> · Margin <b>${money(risk.marginRequired ?? risk.amountToInvestApprox)}</b></p><p style="font-size:13px;margin:6px 0 0;color:#047857">TP1 ${money(risk.profitAtTp1)} · TP2 ${money(risk.profitAtTp2)} · TP3 ${money(risk.profitAtTp3)}</p></div>` : ''}
      ${sd.sessionContext ? `<p style="font-size:12px;color:#475569">Session: ${sd.sessionContext.reason}</p>` : ''}
      <p style="font-size:12px;color:#64748b">Confluences: ${conf.map((c) => `${c.name} +${c.points}`).join(', ') || 'none'}</p>
      <p style="font-size:12px;color:#b45309;margin:8px 0 0">This setup was forecast and is <b>now executable</b>.</p>
      <p style="font-size:11px;color:#94a3b8;margin-top:8px">Advisory only — not financial advice. — Aura Gold Forecast</p>
    </div>`;
  return { subject, text, html };
}

async function sendForecastReadyEmail(pool, id, symbol, timeframe, sd) {
  if (!SIGNAL_ALERTS_ENABLED || !signalEmailTo() || !isEmailSystemEnabled('forecast')) return;
  if ((Number(sd?.confidence) || 0) < FORECAST_READY_EMAIL_MIN_SCORE) return;
  try {
    const { subject, text, html } = buildForecastReadyEmail(symbol, timeframe, sd);
    const forecastTo = signalEmailToFor(symbol, timeframe);
    if (!forecastTo) return;
    await sendNotificationEmail({ to: forecastTo, subject, text, html, signalId: `forecast:${id}:ready` });
    if (pool) await pool.execute('UPDATE mt5_execution_forecasts SET email_execution = 1, updated_at = ? WHERE id = ?', [toMysqlDate(new Date()), id]);
    console.log(`[Forecast] Emailed READY (full detail) ${symbol} ${timeframe} score ${Math.round(sd.confidence)}`);
  } catch (e) {
    console.error(`[Forecast] READY email failed for ${id}:`, e.message);
  }
}

let forecastEmailRunning = false;
async function processForecastEmails() {
  if (!FORECAST_ENABLED || forecastEmailRunning) return;
  if (!SIGNAL_ALERTS_ENABLED || !signalEmailTo() || !isEmailSystemEnabled('forecast')) return;
  forecastEmailRunning = true;
  try {
    const pool = await initializeDatabase();
    if (!pool) return;
    const nowMs = Date.now();
    // Active forecasts that still have at least one email stage pending, above the score gate.
    const [rows] = await pool.query(
      `SELECT * FROM mt5_execution_forecasts
        WHERE status IN ('FORECASTED','DELAYED','READY')
          AND email_execution = 0
          AND setup_score >= ?
        ORDER BY expected_execution_time ASC
        LIMIT 200`,
      [FORECAST_EMAIL_MIN_SCORE],
    );
    for (const row of rows) {
      // News blackout: don't send generic reminders into a high-impact release —
      // the two-tier news-reaction emails cover that window instead.
      if (row.news_imminent) continue;
      const etaMs = row.expected_execution_time ? new Date(row.expected_execution_time).getTime() : null;
      const toEta = etaMs !== null ? etaMs - nowMs : null;
      // Only the PRE-EXECUTION reminders (~10m and ~5m). No "created" email, and the
      // at-execution email is the FULL-detail "now executable" one sent at the READY
      // transition (in reforecastActiveForecasts), where the live systemDecision exists.
      const stages = [];
      if (etaMs !== null) {
        if (!row.email_reminder1 && toEta <= 10 * 60 * 1000 && toEta > 5 * 60 * 1000) stages.push('reminder1');
        if (!row.email_reminder2 && toEta <= 5 * 60 * 1000 && toEta > 0) stages.push('reminder2');
      }
      if (!stages.length) continue;
      for (const stage of stages) {
        try {
          const { subject, text, html } = buildForecastEmail(row, stage, etaMs);
          const reminderTo = signalEmailToFor(row.symbol, row.timeframe);
          if (!reminderTo) continue;
          await sendNotificationEmail({ to: reminderTo, subject, text, html, signalId: `forecast:${row.id}:${stage}` });
          const col = { reminder1: 'email_reminder1', reminder2: 'email_reminder2' }[stage];
          await pool.execute(`UPDATE mt5_execution_forecasts SET ${col} = 1, updated_at = ? WHERE id = ?`, [toMysqlDate(new Date()), row.id]);
          // keep the in-memory copy in sync so the next cycle doesn't re-pick the stage
          row[col] = 1;
          console.log(`[Forecast] Emailed ${stage} ${row.symbol} ${row.timeframe} (score ${row.setup_score})`);
        } catch (e) {
          console.error(`[Forecast] Email ${stage} failed for ${row.id}:`, e.message);
        }
      }
    }
  } catch (err) {
    console.error('[Forecast] Email workflow error:', err.message);
  } finally {
    forecastEmailRunning = false;
  }
}

// ── Phase 5: post-execution calibration ─────────────────────────────────────
// Measured accuracy of resolved forecasts, grouped by ETA basis. Once a basis
// has enough resolved samples, the live forecast's confidence is FLIPPED from
// the heuristic estimate to this measured timing accuracy (calibrated=true).
const FORECAST_CALIBRATION_MIN_SAMPLE = Math.max(5, Number(process.env.FORECAST_CALIBRATION_MIN_SAMPLE || 20));
const forecastCalibrationByBasis = new Map(); // basis -> { samples, hitRate, avgTiming }

// Confidence-in-timing for an executed forecast: how close actual was to the
// ORIGINAL predicted ETA, within a tolerance window scaled to the timeframe.
function computeForecastAccuracy(row, outcome, nowMs, realizedScore) {
  const executed = outcome === 'EXECUTED';
  const forecastAccuracy = executed ? 100 : 0;
  let timingAccuracy = null;
  let scoreAccuracy = null;
  if (executed) {
    const origEta = row.original_execution_time ? new Date(row.original_execution_time).getTime() : null;
    if (origEta !== null) {
      const tol = Math.max(forecastTfSeconds(row.timeframe) * 1000, 30 * 60 * 1000);
      const err = Math.abs(nowMs - origEta);
      timingAccuracy = Math.max(0, Math.round((1 - err / tol) * 1000) / 10);
    }
    if (Number.isFinite(realizedScore)) {
      // We forecast the score crossing the executable threshold; reward decisiveness.
      scoreAccuracy = Math.max(0, Math.min(100, Math.round((100 - Math.abs(realizedScore - FC_EXECUTABLE_SCORE)) * 10) / 10));
    }
  }
  return { forecastAccuracy, timingAccuracy, scoreAccuracy };
}

async function resolveForecastRow(pool, id, outcome, nowMs, realizedScore) {
  const [rows] = await pool.query('SELECT * FROM mt5_execution_forecasts WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) return;
  const acc = computeForecastAccuracy(rows[0], outcome, nowMs, realizedScore);
  const stamp = toMysqlDate(new Date(nowMs));
  await pool.execute(
    `UPDATE mt5_execution_forecasts
       SET status=?, actual_execution_time=?, forecast_accuracy=?, timing_accuracy=?, score_accuracy=?, resolved_at=?, updated_at=?
       WHERE id=?`,
    [outcome, outcome === 'EXECUTED' ? stamp : null, acc.forecastAccuracy, acc.timingAccuracy, acc.scoreAccuracy, stamp, stamp, id],
  );
}

// Flip the heuristic confidence to the measured timing accuracy when the basis
// has a usable resolved sample. Honest: otherwise leaves it as an estimate.
function applyForecastCalibration(fc) {
  if (!fc) return fc;
  const cal = forecastCalibrationByBasis.get(fc.forecastBasis);
  if (cal && cal.samples >= FORECAST_CALIBRATION_MIN_SAMPLE && Number.isFinite(cal.avgTiming) && Number.isFinite(cal.hitRate)) {
    // Combined measured confidence = hitRate × timingAccuracy. A timing forecast is
    // only trustworthy if the setup BOTH becomes executable (hitRate) AND the ETA was
    // accurate (avgTiming). Timing accuracy ALONE is misleading for a basis that
    // rarely executes — e.g. SESSION at 0% hit rate would otherwise show ~50%
    // "confidence" despite never actually executing; hitRate×timing collapses it to ~0.
    fc.forecastConfidence = Math.round((cal.hitRate / 100) * cal.avgTiming);
    fc.calibrated = true;
  }
  return fc;
}

function summarizeForecastCalibration(rows) {
  const byBasis = new Map();
  const overall = { samples: 0, executed: 0, expired: 0, cancelled: 0, timingSum: 0, timingN: 0, scoreSum: 0, scoreN: 0 };
  for (const r of rows) {
    const basis = r.forecast_basis || 'UNKNOWN';
    if (!byBasis.has(basis)) byBasis.set(basis, { basis, samples: 0, executed: 0, expired: 0, cancelled: 0, timingSum: 0, timingN: 0, scoreSum: 0, scoreN: 0 });
    const b = byBasis.get(basis);
    const status = String(r.status || '').toUpperCase();
    for (const acc of [b, overall]) {
      acc.samples += 1;
      if (status === 'EXECUTED') acc.executed += 1;
      else if (status === 'EXPIRED') acc.expired += 1;
      else if (status === 'CANCELLED') acc.cancelled += 1;
      if (r.timing_accuracy !== null && r.timing_accuracy !== undefined) { acc.timingSum += Number(r.timing_accuracy); acc.timingN += 1; }
      if (r.score_accuracy !== null && r.score_accuracy !== undefined) { acc.scoreSum += Number(r.score_accuracy); acc.scoreN += 1; }
    }
  }
  const finalize = (b) => {
    const hitRate = b.samples ? Math.round((b.executed / b.samples) * 1000) / 10 : null;
    const avgTimingAccuracy = b.timingN ? Math.round((b.timingSum / b.timingN) * 10) / 10 : null;
    return {
      basis: b.basis,
      samples: b.samples,
      executed: b.executed,
      expired: b.expired,
      cancelled: b.cancelled,
      hitRate,
      avgTimingAccuracy,
      avgScoreAccuracy: b.scoreN ? Math.round((b.scoreSum / b.scoreN) * 10) / 10 : null,
      // Combined "is this timing forecast actually reliable?" = hitRate × timingAccuracy.
      // Low when a basis rarely executes (even if its timing-on-execution looks ok).
      combinedConfidence: (hitRate !== null && avgTimingAccuracy !== null) ? Math.round((hitRate / 100) * avgTimingAccuracy) : null,
      confidence: sampleConfidence(b.samples),
    };
  };
  return {
    overall: finalize({ ...overall, basis: 'ALL' }),
    byBasis: [...byBasis.values()].map(finalize).sort((a, b) => b.samples - a.samples),
  };
}

// Refresh the in-memory calibration cache from resolved forecasts (last 90 days).
async function refreshForecastCalibration() {
  const pool = await initializeDatabase();
  if (!pool) return;
  try {
    const [rows] = await pool.query(
      `SELECT forecast_basis, status, timing_accuracy, score_accuracy
         FROM mt5_execution_forecasts
        WHERE resolved_at IS NOT NULL AND resolved_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY)`,
    );
    const summary = summarizeForecastCalibration(rows);
    forecastCalibrationByBasis.clear();
    for (const b of summary.byBasis) {
      forecastCalibrationByBasis.set(b.basis, { samples: b.samples, hitRate: b.hitRate, avgTiming: b.avgTimingAccuracy });
    }
  } catch (e) {
    console.error('[Forecast] Calibration refresh failed:', e.message);
  }
}

// Walk-forward backtest of the deterministic forecaster over stored candles.
// Validates timing accuracy on history BEFORE the live numbers are trusted.
// Self-contained on candles (no historical indicators) — engine's internal ADX
// fallback keeps regime tuning live, matching the FTT replay harness approach.
function runForecastReplay({ symbol, timeframe, candles, maxEvals = 300 }) {
  if (!candles || candles.length < 80) return { valid: false, reason: 'Not enough candles (need 80+).' };
  const tfSec = forecastTfSeconds(timeframe);
  const horizonBars = 24; // look up to 24 bars ahead for actual execution
  const warmup = 50;
  const step = Math.max(1, Math.floor((candles.length - warmup - horizonBars) / maxEvals));
  let forecasts = 0, executed = 0, timingSum = 0, timingN = 0;
  const tolMs = Math.max(tfSec * 1000, 30 * 60 * 1000);

  for (let i = warmup; i < candles.length - horizonBars; i += step) {
    const slice = candles.slice(0, i + 1);
    let sd;
    try {
      sd = aggregateSignals({ symbol, timeframe, candles: slice, indicators: [], marketLevels, accountSnapshot: null }).systemDecision;
    } catch { continue; }
    const nowMs = new Date(slice[slice.length - 1].time).getTime();
    const fc = buildExecutionForecast({ symbol, timeframe, systemDecision: sd, nowMs });
    if (!fc || !Number.isFinite(fc.expectedExecutionMs)) continue;
    if (fc.executionStatus === 'EXECUTABLE') continue; // already executable, not a forecast
    forecasts += 1;
    // Find the first future bar where the setup actually becomes executable.
    let actualMs = null;
    for (let j = i + 1; j <= i + horizonBars && j < candles.length; j++) {
      let sd2;
      try {
        sd2 = aggregateSignals({ symbol, timeframe, candles: candles.slice(0, j + 1), indicators: [], marketLevels, accountSnapshot: null }).systemDecision;
      } catch { continue; }
      const score = Number(sd2?.confidence) || 0;
      const dec = String(sd2?.decision || 'HOLD').toUpperCase();
      if (dec !== 'HOLD' && score >= FC_EXECUTABLE_SCORE && sd2.entryTimingInstruction === 'IMMEDIATE_ENTRY') {
        actualMs = new Date(candles[j].time).getTime();
        break;
      }
    }
    if (actualMs !== null) {
      executed += 1;
      const err = Math.abs(actualMs - fc.expectedExecutionMs);
      timingSum += Math.max(0, (1 - err / tolMs) * 100);
      timingN += 1;
    }
  }
  return {
    valid: true,
    symbol, timeframe,
    forecasts,
    executed,
    hitRate: forecasts ? Math.round((executed / forecasts) * 1000) / 10 : null,
    avgTimingAccuracy: timingN ? Math.round((timingSum / timingN) * 10) / 10 : null,
    confidence: sampleConfidence(forecasts),
    note: 'Backtest of the deterministic forecaster on historical candles. Hit-rate = share of forecasts whose setup actually became executable within 24 bars; timing accuracy = closeness to the predicted ETA. Not a guarantee of live results.',
  };
}

function normalizeForecastRow(row) {
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    scanTime: row.scan_time ? new Date(row.scan_time).toISOString() : null,
    currentStatus: row.current_status,
    executionStatus: row.execution_status,
    decision: row.decision,
    lean: row.lean || null,
    leanConviction: num(row.lean_conviction),
    setupScore: num(row.setup_score),
    scoreChange: num(row.score_change),
    trendStrength: num(row.trend_strength),
    momentum: num(row.momentum),
    volatility: num(row.volatility),
    liquidity: num(row.liquidity),
    session: row.session,
    regime: row.regime,
    executionProbability: num(row.execution_probability),
    forecastConfidence: num(row.forecast_confidence),
    forecastBasis: row.forecast_basis,
    expectedExecutionTime: row.expected_execution_time ? new Date(row.expected_execution_time).toISOString() : null,
    prevExecutionTime: row.prev_execution_time ? new Date(row.prev_execution_time).toISOString() : null,
    status: row.status,
    reforecastCount: num(row.reforecast_count),
    reason: row.reason,
    entryPrice: num(row.entry_price),
    stopLoss: num(row.stop_loss),
    takeProfit1: num(row.take_profit_1),
    takeProfit2: num(row.take_profit_2),
    takeProfit3: num(row.take_profit_3),
    tradeOutcome: row.trade_outcome || null,
    tradeExitPrice: num(row.trade_exit_price),
    tradePips: num(row.trade_pips),
    tradeTpHitLevel: row.trade_tp_hit_level === null || row.trade_tp_hit_level === undefined ? null : Number(row.trade_tp_hit_level),
    tradeMfePips: num(row.trade_mfe_pips),
    tradeMaePips: num(row.trade_mae_pips),
    tradeResolvedAt: row.trade_resolved_at ? new Date(row.trade_resolved_at).toISOString() : null,
    actualExecutionTime: row.actual_execution_time ? new Date(row.actual_execution_time).toISOString() : null,
    forecastAccuracy: num(row.forecast_accuracy),
    timingAccuracy: num(row.timing_accuracy),
    scoreAccuracy: num(row.score_accuracy),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    newsImminent: row.news_imminent === 1 || row.news_imminent === true,
    newsEvent: row.news_event || null,
    newsEventTime: row.news_event_time ? new Date(row.news_event_time).toISOString() : null,
    newsTier: row.news_tier || null,
    calibrated: row.calibrated === 1 || row.calibrated === true,
  };
}

function startExecutionForecastScanner() {
  if (!FORECAST_ENABLED) { console.log('[Forecast] Disabled via FORECAST_ENABLED=false.'); return; }
  const timer = setInterval(() => void runExecutionForecastScan(), FORECAST_SCAN_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  setTimeout(() => void runExecutionForecastScan(), 20000); // warm shortly after boot
  const pruneTimer = setInterval(() => void pruneOldExecutionForecasts(), 6 * 60 * 60 * 1000);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
  const breakoutPruneTimer = setInterval(() => void pruneOldBreakoutAlerts(), 6 * 60 * 60 * 1000);
  if (typeof breakoutPruneTimer.unref === 'function') breakoutPruneTimer.unref();
  console.log(`[Forecast] Execution forecast scanner started. TFs=${FORECAST_TIMEFRAMES.join(',')} every ${Math.round(FORECAST_SCAN_INTERVAL_MS / 60000)}m.`);
}
startExecutionForecastScanner();

// GET /api/forecasts — active execution forecasts (Phase 1 read API).
// Confidence numbers are UNCALIBRATED model estimates until Phase 5 calibration.
app.get('/api/forecasts', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });
  try {
    const [rows] = await pool.query(
      `SELECT * FROM mt5_execution_forecasts
        WHERE status IN ('FORECASTED','DELAYED','READY')
        ORDER BY expected_execution_time IS NULL, expected_execution_time ASC
        LIMIT 200`,
    );
    res.json({
      forecasts: rows.map(normalizeForecastRow),
      calibrated: false,
      note: 'Forecast confidence is an uncalibrated model estimate until enough forecasts resolve (Phase 5). Not a guarantee.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Deterministic "Analyze Execution Opportunity" — TRADE / WAIT / SKIP.
// Re-runs aggregateSignals on the freshest candles so the verdict is current.
// Server-side LLM is not wired (the existing AI-analysis path is rule-based too),
// so this is the deterministic engine; honest source label, zero token cost.
function relMinsServer(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function analyzeForecastDeterministic(sd, fresh, nowMs, tf) {
  const reasoning = [];
  const score = Number(sd?.confidence) || 0;
  const decision = String(sd?.decision || 'HOLD').toUpperCase();
  const news = sd?.newsRisk;
  const etaMs = fresh && Number.isFinite(fresh.expectedExecutionMs) ? fresh.expectedExecutionMs : null;
  const toEta = etaMs !== null ? etaMs - nowMs : null;
  const tfMs = forecastTfSeconds(tf) * 1000;

  if (fresh) {
    if (fresh.momentum !== null) reasoning.push(`Momentum ${fresh.momentum >= 60 ? 'strong' : fresh.momentum >= 40 ? 'building' : 'weak'} (${fresh.momentum}/100)`);
    if (fresh.trendStrength !== null) reasoning.push(`Trend strength ${fresh.trendStrength}/100 (${sd.regime || 'n/a'} regime)`);
    reasoning.push(fresh.liquidity !== null ? `Liquidity ${fresh.liquidity >= 50 ? 'sufficient' : 'thin'} (${fresh.liquidity}/100)` : 'Liquidity: no volume feed on this symbol');
    if (fresh.scoreChange !== null && fresh.scoreChange !== 0) reasoning.push(`Setup score ${fresh.scoreChange > 0 ? 'rising' : 'falling'} (${fresh.scoreChange > 0 ? '+' : ''}${fresh.scoreChange}/scan)`);
    if (toEta !== null) reasoning.push(toEta <= 0 ? 'Execution window is open now' : `Execution window expected within ~${relMinsServer(toEta)}`);
  }
  if (news && (news.block || news.caution)) reasoning.push(`News ${news.block ? 'BLOCK' : 'caution'}: ${news.reason}`);

  let recommendation;
  let confidence;
  if (!fresh || (decision === 'HOLD' && score < FC_WATCH_FLOOR) || (news && news.block)) {
    recommendation = 'SKIP';
    confidence = 70;
    if (!reasoning.length) reasoning.push('Setup is no longer favorable.');
  } else if (fresh.executionStatus === 'EXECUTABLE' || (score >= FC_EXECUTABLE_SCORE && toEta !== null && toEta <= tfMs)) {
    recommendation = 'TRADE';
    confidence = Math.round(fresh.executionProbability ?? score);
  } else {
    recommendation = 'WAIT';
    confidence = Math.round(fresh.forecastConfidence ?? 50);
  }
  return { recommendation, confidence, reasoning };
}

// POST /api/forecasts/:id/analyze
app.post('/api/forecasts/:id/analyze', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });
  try {
    const id = String(req.params.id);
    // Resolve symbol/timeframe from the row, falling back to the id pattern fc:SYMBOL|TF.
    let symbol = null;
    let tf = null;
    const [rows] = await pool.query('SELECT symbol, timeframe FROM mt5_execution_forecasts WHERE id = ? LIMIT 1', [id]);
    if (rows.length) { symbol = rows[0].symbol; tf = rows[0].timeframe; }
    else {
      const m = id.match(/^fc:(.+)\|(.+)$/);
      if (m) { symbol = m[1]; tf = m[2]; }
    }
    if (!symbol || !tf) return res.status(404).json({ error: 'Forecast not found.' });

    const candleList = getRecentCandles(symbol, tf, 200);
    if (!candleList || candleList.length < 20) return res.status(409).json({ error: 'Not enough candle data to analyze right now.' });
    const { adr, dailyHighLow } = computeAdrDaily(symbol);
    const summary = aggregateSignals({
      symbol, timeframe: tf, candles: candleList,
      indicators: getRecentIndicators(symbol, tf, 500),
      marketLevels, accountSnapshot: mt5State.accountSnapshot, adr, dailyHighLow,
      h4Candles: getRecentCandles(symbol, 'H4', 150), h1Candles: getRecentCandles(symbol, 'H1', 150),
    });
    const sd = summary.systemDecision;
    const nowMs = Date.now();
    const fresh = buildExecutionForecast({ symbol, timeframe: tf, systemDecision: sd, nowMs, scanIntervalMs: FORECAST_SCAN_INTERVAL_MS });
    const verdict = analyzeForecastDeterministic(sd, fresh, nowMs, tf);

    // Full trade ticket from the live systemDecision — same depth as the Signals dashboard.
    const risk = sd?.riskPlan || null;
    const plan = {
      decision: sd?.decision || null,
      grade: sd?.grade || null,
      strategyType: sd?.strategyType || null,
      signalQuality: sd?.signalQuality || null,
      entryPrice: Number.isFinite(sd?.entryPrice) ? sd.entryPrice : null,
      stopLoss: Number.isFinite(sd?.stopLoss) ? sd.stopLoss : null,
      takeProfit1: Number.isFinite(sd?.takeProfit1) ? sd.takeProfit1 : null,
      takeProfit2: Number.isFinite(sd?.takeProfit2) ? sd.takeProfit2 : null,
      takeProfit3: Number.isFinite(sd?.takeProfit3) ? sd.takeProfit3 : null,
      riskRewardRatio: sd?.riskRewardRatio ?? null,
      entryTrigger: sd?.entryTrigger || null,
      timingTip: sd?.timingTip || null,
      regime: sd?.regime || null,
      session: sd?.sessionContext?.reason || null,
      lotSize: risk?.suggestedLotSize ?? null,
      maxLoss: risk?.amountToRisk ?? risk?.riskAmount ?? risk?.maxLoss ?? null,
      investment: risk?.marginRequired ?? risk?.amountToInvestApprox ?? null,
      riskPercent: risk?.riskPercent ?? null,
      profitAtTp1: risk?.profitAtTp1 ?? null,
      profitAtTp2: risk?.profitAtTp2 ?? null,
      profitAtTp3: risk?.profitAtTp3 ?? null,
      confluences: (sd?.confluences || []).slice(0, 10).map((c) => ({ name: c.name, points: c.points })),
    };
    res.json({
      ok: true,
      id, symbol, timeframe: tf,
      ...verdict,
      source: 'deterministic',
      expectedExecutionTime: fresh && Number.isFinite(fresh.expectedExecutionMs) ? new Date(fresh.expectedExecutionMs).toISOString() : null,
      forecastBasis: fresh ? fresh.forecastBasis : null,
      setupScore: fresh ? fresh.setupScore : Math.round(Number(sd?.confidence) || 0),
      executionStatus: fresh ? fresh.executionStatus : 'NOT_EXECUTABLE',
      plan,
      note: 'Deterministic engine verdict — not a guarantee. Confirm on the chart before acting.',
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/reports/forecast-calibration — measured accuracy of resolved forecasts.
// This is the honest payoff: it flips live confidence from estimate → measured.
app.get('/api/reports/forecast-calibration', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });
  try {
    const days = Math.max(1, Math.min(Number(req.query.days) || 90, 3650));
    const [rows] = await pool.query(
      `SELECT * FROM mt5_execution_forecasts
        WHERE resolved_at IS NOT NULL AND resolved_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
        ORDER BY resolved_at DESC LIMIT 1000`,
      [days],
    );
    res.json({
      calibration: summarizeForecastCalibration(rows),
      resolved: rows.slice(0, 200).map(normalizeForecastRow),
      minSampleToCalibrate: FORECAST_CALIBRATION_MIN_SAMPLE,
      note: 'Once a basis reaches the minimum resolved sample, live forecast confidence switches from heuristic estimate to this measured timing accuracy. Not a guarantee.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/reports/forecast-replay?symbol=&timeframe=&bars= — backtest the forecaster.
app.get('/api/reports/forecast-replay', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    const timeframe = String(req.query.timeframe || 'M15').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const bars = Math.max(200, Math.min(Number(req.query.bars) || 1500, 5000));
    const candles = getRecentCandles(symbol, timeframe, bars);
    res.json(runForecastReplay({ symbol, timeframe, candles }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/reports/forecast-outcomes — WIN/LOSS track record of EXECUTED forecasts,
// settled by candle replay (TP/SL touch). The honest counterpart to the timing
// calibration: a forecast that said "ready" only counts as a win if the trade it
// implied actually reached target before stop.
app.get('/api/reports/forecast-outcomes', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });
  try {
    const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const outcome = req.query.outcome ? String(req.query.outcome).toUpperCase() : null;
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 300, 1000));
    let sql = "SELECT * FROM mt5_execution_forecasts WHERE status='EXECUTED' AND trade_outcome IS NOT NULL";
    const params = [];
    if (symbol) { sql += ' AND symbol = ?'; params.push(symbol); }
    if (outcome) { sql += ' AND trade_outcome = ?'; params.push(outcome); }
    if (days && Number(days) > 0) { sql += ' AND actual_execution_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)'; params.push(Number(days)); }
    sql += ' ORDER BY actual_execution_time DESC LIMIT ?';
    params.push(limit);
    const [rows] = await pool.query(sql, params);
    const trades = rows.map(normalizeForecastRow);
    res.json({
      trades,
      summary: summarizeForecastTradeOutcomes(trades),
      retentionDays: FORECAST_RETENTION_DAYS,
      note: 'Settled from real candle replay (TP/SL touch). Conservative: if a bar hits both stop and target, it counts AMBIGUOUS, not a win. Track record only — past performance is not a guarantee. Resolved trades are pruned after the retention window.',
      filters: { symbol, outcome, days, limit },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Day-trading discipline layer ────────────────────────────────────────────
// Encodes four rules from the trading playbook as an ADVISORY layer on top of the
// existing signals (no change to the live signal logic — heeds quality-not-quantity):
//   1) Think in R-multiples (risk units), not pips/dollars.
//   2) Daily risk budget — stop after the day's net R hits the limit ("two strikes").
//   3) Over-extension guard — don't chase price stretched far from the EMA.
//   4) Pre-session brief — one screen: bias, levels, extension, news, active forecast.
const DAY_TRADING_DAILY_STOP_R = Math.max(1, Number(process.env.DAY_TRADING_DAILY_STOP_R || 2));
const DAY_TRADING_BRIEF_TF = (process.env.DAY_TRADING_BRIEF_TF || 'M15').toUpperCase();
const DAY_TRADING_EXTENSION_ATR = Math.max(0.5, Number(process.env.DAY_TRADING_EXTENSION_ATR || 2));

// Risk in pips between entry and stop — the denominator for R-multiples.
function riskPipsFor(symbol, entry, sl) {
  const pip = pipSizeForSymbol(symbol);
  if (!pip || !Number.isFinite(Number(entry)) || !Number.isFinite(Number(sl))) return null;
  const r = Math.abs(Number(entry) - Number(sl)) / pip;
  return r > 0 ? r : null;
}
// R-multiple of a realized move: profit pips ÷ initial risk pips. Honest null when
// risk is unknown (can't fake an R without a real stop distance).
function rMultiple(symbol, entry, sl, pips) {
  const rp = riskPipsFor(symbol, entry, sl);
  if (rp === null || !Number.isFinite(Number(pips))) return null;
  return Math.round((Number(pips) / rp) * 100) / 100;
}
function startOfUtcDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

// Today's net R from the system signal log (settled WIN/LOSS only). Advisory: it
// reflects the day's LOGGED signals, not your actual fills — but it's the honest
// proxy for "how is the strategy doing today, and should I stop?".
async function computeDailyRiskBudget(pool) {
  const dailyStopR = DAY_TRADING_DAILY_STOP_R;
  if (!pool) return { available: false, dailyStopR, note: 'Database unavailable.' };
  try {
    const [rows] = await pool.query(
      `SELECT symbol, entry_price, stop_loss, profit_loss_pips, outcome
         FROM mt5_system_signal_log
        WHERE signal_time >= ? ORDER BY signal_time ASC`,
      [toMysqlDate(startOfUtcDay())],
    );
    let settledR = 0, wins = 0, losses = 0, openCount = 0, rCount = 0;
    for (const r of rows) {
      const o = String(r.outcome || 'PENDING').toUpperCase();
      const settled = o.endsWith('_WIN') || o === 'WIN' || o === 'LOSS';
      if (!settled) { openCount += 1; continue; }
      if (o === 'LOSS') losses += 1; else wins += 1;
      const rm = rMultiple(r.symbol, r.entry_price, r.stop_loss, r.profit_loss_pips);
      if (rm !== null) { settledR += rm; rCount += 1; }
    }
    settledR = Math.round(settledR * 100) / 100;
    const limitHit = settledR <= -dailyStopR;
    return {
      available: true,
      dateUtc: startOfUtcDay().toISOString().slice(0, 10),
      settledR,
      wins,
      losses,
      openCount,
      rCount,
      dailyStopR,
      remainingR: Math.round((dailyStopR + Math.min(0, settledR)) * 100) / 100,
      limitHit,
      note: limitHit
        ? `Daily stop hit (${settledR}R ≤ -${dailyStopR}R). The playbook says STOP for today — protect capital.`
        : `Net ${settledR >= 0 ? '+' : ''}${settledR}R today across logged signals. Daily stop at -${dailyStopR}R.`,
    };
  } catch (e) {
    return { available: false, dailyStopR, note: e.message };
  }
}

// GET /api/day-trading/brief — the pre-session brief. Per curated symbol on one
// timeframe: bias, regime, grade/score, EMA-extension (over-extension guard),
// nearest S/R, ADR usage, and any active execution forecast — plus today's news
// and the daily R budget. Read-only; runs aggregateSignals on fresh candles.
app.get('/api/day-trading/brief', async (req, res) => {
  try {
    const tf = (req.query.timeframe ? String(req.query.timeframe) : DAY_TRADING_BRIEF_TF).toUpperCase();
    const nowMs = Date.now();
    const pool = await initializeDatabase();
    const symbols = getCuratedSymbols(getMt5Status().symbols);
    const out = [];
    const newsMap = new Map();
    for (const symbol of symbols) {
      try {
        const candleList = getRecentCandles(symbol, tf, 200);
        if (!candleList || candleList.length < 20) continue;
        const { adr, dailyHighLow } = computeAdrDaily(symbol);
        const summary = aggregateSignals({
          symbol, timeframe: tf, candles: candleList,
          indicators: getRecentIndicators(symbol, tf, 500),
          marketLevels, accountSnapshot: mt5State.accountSnapshot, adr, dailyHighLow,
          h4Candles: getRecentCandles(symbol, 'H4', 150), h1Candles: getRecentCandles(symbol, 'H1', 150),
        });
        const sd = summary.systemDecision;
        const extAtr = sd?.features?.emaDistanceAtr ?? null;
        const extended = extAtr !== null && Math.abs(extAtr) >= DAY_TRADING_EXTENSION_ATR;
        const price = Number(sd?.latestCandle?.close ?? candleList[candleList.length - 1].close);
        const sr = sd?.supportResistance || { support: [], resistance: [] };
        const nearestSupport = (sr.support || []).map((s) => Number(s.level)).filter((v) => Number.isFinite(v) && v <= price).sort((a, b) => b - a)[0] ?? null;
        const nearestResistance = (sr.resistance || []).map((s) => Number(s.level)).filter((v) => Number.isFinite(v) && v >= price).sort((a, b) => a - b)[0] ?? null;
        const rr = sd?.riskPlan?.riskRewardRatio ?? sd?.riskRewardRatio ?? null;
        const fc = lastForecastByKey.get(`${symbol}|${tf}`) || null;
        out.push({
          symbol, timeframe: tf,
          decision: sd?.decision || 'HOLD',
          grade: sd?.grade || null,
          score: Number.isFinite(sd?.confidence) ? Math.round(sd.confidence) : null,
          regime: sd?.regime || null,
          htfBias: sd?.htfBias || null,
          emaDistanceAtr: extAtr,
          extended,
          adrUsagePercent: sd?.adrUsagePercent ?? null,
          riskRewardRatio: rr,
          entryTiming: sd?.entryTimingInstruction || null,
          nearestSupport, nearestResistance, price,
          newsRisk: sd?.newsRisk?.block ? 'block' : sd?.newsRisk?.caution ? 'caution' : null,
          forecast: fc && Number.isFinite(fc.expectedExecutionMs)
            ? { eta: new Date(fc.expectedExecutionMs).toISOString(), basis: fc.forecastBasis, status: fc.status || null }
            : null,
        });
        for (const e of (getUpcomingForSymbol(symbol, nowMs, 24) || [])) {
          if (String(e.impact).toUpperCase() !== 'HIGH') continue;
          const key = `${e.currency}|${e.title}|${e.timestampUtc}`;
          if (!newsMap.has(key)) newsMap.set(key, { currency: e.currency, title: e.title, impact: e.impact, timeIso: e.timeIso || new Date(e.timestampUtc).toISOString(), timestampUtc: e.timestampUtc });
        }
      } catch { /* per-symbol resilience */ }
    }
    // Sort: actionable first (committed BUY/SELL, higher score), then the rest.
    out.sort((a, b) => {
      const av = (a.decision !== 'HOLD' ? 1000 : 0) + (a.score || 0);
      const bv = (b.decision !== 'HOLD' ? 1000 : 0) + (b.score || 0);
      return bv - av;
    });
    const news = [...newsMap.values()].sort((a, b) => a.timestampUtc - b.timestampUtc).slice(0, 12);
    const dailyRisk = await computeDailyRiskBudget(pool);
    res.json({
      generatedAt: new Date(nowMs).toISOString(),
      timeframe: tf,
      extensionAtrThreshold: DAY_TRADING_EXTENSION_ATR,
      symbols: out,
      news,
      dailyRisk,
      note: 'Advisory pre-session brief. Extension = signed ATR distance from EMA; |value| ≥ threshold means price is stretched (don\'t chase). Daily R is from logged signals, not your fills. Not financial advice.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ─── Day Trading Desk (market-structure read) ────────────────────────────────
// Surfaces what the engine already computes, framed as the "Master Market
// Structure" course teaches: trend phase, close-confirmed BOS, liquidity sweep
// (wick-through vs close), demand/supply zone (order block) + imbalance (FVG),
// HTF bias, the armed setup, extension guard, and the entry/SL/target plan.
// Read-only; reuses the live detectors (no change to signal logic).
function buildStructureDesk(symbol, tf) {
  const rawCandles = getRecentCandles(symbol, tf, 250);
  if (!rawCandles || rawCandles.length < 30) return null;
  const candles = closedBarsOnly(rawCandles, tf);
  if (!candles || candles.length < 30) return null;
  const { adr, dailyHighLow } = computeAdrDaily(symbol);
  let sd;
  try {
    sd = aggregateSignals({
      symbol, timeframe: tf, candles,
      indicators: getRecentIndicators(symbol, tf, 500),
      marketLevels, accountSnapshot: mt5State.accountSnapshot, adr, dailyHighLow,
       h4Candles: closedBarsOnly(getRecentCandles(symbol, 'H4', 150), 'H4'),
       h1Candles: closedBarsOnly(getRecentCandles(symbol, 'H1', 150), 'H1'),
    }).systemDecision;
  } catch { return null; }
  const struct = detectMarketStructure(candles);
  const sweep = detectLiquiditySweeps(candles);
  const obs = detectOrderBlocks(candles);
  const fvgs = detectFVGs(candles);
  const price = Number(candles[candles.length - 1].close);
  const tfTrend = getTimeframeTrend(candles);
  const ranging = sd?.regime === 'ranging';
  const phase = ranging ? 'CONSOLIDATION'
    : tfTrend === 'BULLISH' ? 'UPTREND'
    : tfTrend === 'BEARISH' ? 'DOWNTREND' : 'SIDEWAYS';

  // Directional bias for zone selection: committed decision > HTF bias > TF trend.
  const dec = String(sd?.decision || 'HOLD').toUpperCase();
  const dir = dec.includes('BUY') ? 'BULLISH'
    : dec.includes('SELL') ? 'BEARISH'
    : sd?.htfBias === 'BULLISH' ? 'BULLISH'
    : sd?.htfBias === 'BEARISH' ? 'BEARISH'
    : tfTrend === 'BULLISH' ? 'BULLISH' : tfTrend === 'BEARISH' ? 'BEARISH' : null;

  // Most recent order block in the trend direction = the demand/supply zone.
  const wantOb = dir === 'BULLISH' ? 'BULLISH' : dir === 'BEARISH' ? 'BEARISH' : null;
  const zoneOb = wantOb ? [...obs].reverse().find((o) => o.type === wantOb && o.actionable) : null;
  let zone = null;
  if (zoneOb) {
    const low = Math.min(Number(zoneOb.top), Number(zoneOb.bottom));
    const high = Math.max(Number(zoneOb.top), Number(zoneOb.bottom));
    // Imbalance = an unfilled FVG of the same direction overlapping the zone.
    const imbalance = fvgs.some((f) => f.type === wantOb && f.actionable && Number(f.bottom) <= high && Number(f.top) >= low);
    zone = { kind: wantOb === 'BULLISH' ? 'DEMAND' : 'SUPPLY', low, high, imbalance };
  }

  const bos = struct.bosBullish ? { dir: 'bullish', level: struct.lastSwingHigh }
    : struct.bosBearish ? { dir: 'bearish', level: struct.lastSwingLow } : null;
  const sweepDir = sweep.sweepBullish ? 'bullish' : sweep.sweepBearish ? 'bearish' : null;

  // Liquidity-pool targeting + breaker (the edge both podcast traders converge on).
  const pools = detectLiquidityPools(candles);
  const breaker = detectBreaker(candles);
  const liquidityPlan = buildLiquidityPlan(breaker, pools);

  // Drive label (advisory only — does NOT gate the signal): first drive (fakeout
  // risk) vs second drive (after a failed first / retest = higher quality).
  const drive = dir ? classifyDrive(candles, dir) : { label: 'NONE', basis: null, note: 'No directional bias' };

  // Premium / discount: where price sits in the recent dealing range (50% = equilibrium).
  // Buy discount, sell premium. Uses the last ~60 bars' high/low so price is always
  // inside the range (pct stays 0–100), unlike raw last-swing levels.
  let premiumDiscount = null;
  const pdWindow = candles.slice(-60);
  if (pdWindow.length >= 10) {
    const rangeHigh = Math.max(...pdWindow.map((c) => Number(c.high)).filter(Number.isFinite));
    const rangeLow = Math.min(...pdWindow.map((c) => Number(c.low)).filter(Number.isFinite));
    if (Number.isFinite(rangeHigh) && Number.isFinite(rangeLow) && rangeHigh > rangeLow) {
      const pct = Math.max(0, Math.min(100, Math.round(((price - rangeLow) / (rangeHigh - rangeLow)) * 100)));
      premiumDiscount = {
        pct,
        zone: pct > 55 ? 'PREMIUM' : pct < 45 ? 'DISCOUNT' : 'EQUILIBRIUM',
        rangeHigh: Math.round(rangeHigh * 1e5) / 1e5,
        rangeLow: Math.round(rangeLow * 1e5) / 1e5,
        equilibrium: Math.round(((rangeHigh + rangeLow) / 2) * 1e5) / 1e5,
      };
    }
  }

  // Setup classification (course setups): pullback / breakout / shakeout.
  let setup = null;
  const trig = sd?.entryTrigger;
  if (trig === 'LIMIT_PULLBACK') setup = 'Pullback to zone';
  else if (trig === 'BREAKOUT_CONFIRMATION') setup = 'Breakout';
  if ((dir === 'BULLISH' && sweep.sweepBullish) || (dir === 'BEARISH' && sweep.sweepBearish)) {
    setup = `Shakeout (failed ${dir === 'BULLISH' ? 'breakdown' : 'breakout'})`;
  }
  const armed = Boolean(dec !== 'HOLD');

  const extAtr = sd?.features?.emaDistanceAtr ?? null;
  const extended = extAtr !== null && Math.abs(extAtr) >= DAY_TRADING_EXTENSION_ATR;

  const entry = Number.isFinite(sd?.entryPrice) ? sd.entryPrice : null;
  const sl = Number.isFinite(sd?.stopLoss) ? sd.stopLoss : null;
  const tp = Number.isFinite(sd?.takeProfit1) ? sd.takeProfit1 : null;
  const rr = sd?.riskPlan?.riskRewardRatio ?? sd?.riskRewardRatio ?? null;

  return {
    symbol, timeframe: tf, price,
    phase, htfBias: sd?.htfBias || null, regime: sd?.regime || null,
    decision: dec, grade: sd?.grade || null,
    score: Number.isFinite(sd?.confidence) ? Math.round(sd.confidence) : null,
    bos, sweep: sweepDir, zone,
    setup, armed,
    premiumDiscount,
    emaDistanceAtr: extAtr, extended,
    entryTiming: sd?.entryTimingInstruction || null,
    plan: (entry !== null && sl !== null) ? { entry, sl, tp, rr } : null,
    // Liquidity layer: resting pools, draw-on-liquidity targets, last sweep, breaker, and
    // the liquidity-targeted plan (breaker entry/stop → opposing liquidity pool).
    liquidity: {
      targetAbove: pools.targetAbove, targetBelow: pools.targetBelow, recentSweep: pools.recentSweep,
      buySide: pools.buySide, sellSide: pools.sellSide,
    },
    breaker,
    liquidityPlan,
    drive,
    // Institutional liquidity map (PDH/PDL, session H/L, round numbers, equal highs/lows, swings).
    keyLevels: detectKeyLiquidityLevels(candles, { symbol, dailyCandles: getRecentCandles(symbol, 'D1', 8) }),
    rejectionReasons: Array.isArray(sd?.rejectionReasons) ? sd.rejectionReasons.slice(0, 3) : [],
  };
}

// GET /api/day-trading/desk?symbol=&timeframe= — full structure read for one symbol
// plus a compact watchlist of all curated symbols on the same timeframe.
app.get('/api/day-trading/desk', async (req, res) => {
  try {
    const tf = (req.query.timeframe ? String(req.query.timeframe) : 'M5').toUpperCase();
    const symbols = getCuratedSymbols(getMt5Status().symbols);
    const want = req.query.symbol ? String(req.query.symbol).toUpperCase() : (symbols[0] || 'XAUUSDM');
    const desks = [];
    for (const s of symbols) {
      const d = buildStructureDesk(s, tf);
      if (d) desks.push(d);
    }
    // Ensure the requested symbol is present even if not in the curated set.
    let primary = desks.find((d) => d.symbol === want) || null;
    if (!primary) { primary = buildStructureDesk(want, tf); if (primary) desks.unshift(primary); }
    res.json({
      generatedAt: new Date().toISOString(),
      timeframe: tf,
      extensionAtrThreshold: DAY_TRADING_EXTENSION_ATR,
      primarySymbol: primary ? primary.symbol : want,
      desks,
      note: 'Structure read per the Master Market Structure method. BOS is close-confirmed (not wicks); sweep = wick-through that closed back inside. Zones are order blocks; imbalance = unfilled FVG. Pro-trend only. Advisory — not financial advice.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ─── Live Market Tracker — pre-entry decision cockpit ────────────────────────
// One honest live read for "should I enter right now?". REUSES the Day Trading Desk's
// structural read (buildStructureDesk) plus the raw detectors, and adds: order-block
// proximity/quality, a buyer/seller PRESSURE PROXY, and a single entry verdict — all gated
// by the freshness + market-calendar guards. The pressure model is explicitly a PROXY from
// candle anatomy + tick volume; this feed carries no real order-flow / bid-ask / trader counts.
const lmtRound5 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 1e5) / 1e5 : null);

function lmtAtr14(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const h = Number(candles[i].high), l = Number(candles[i].low), pc = Number(candles[i - 1].close);
    if (![h, l, pc].every(Number.isFinite)) continue;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / period;
}

function lmtCandleAnatomy(c) {
  const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
  const range = Math.max(h - l, 1e-9);
  const body = Math.abs(cl - o);
  return {
    bullish: cl > o,
    bodyRatio: body / range,
    upperWickRatio: (h - Math.max(o, cl)) / range,
    lowerWickRatio: (Math.min(o, cl) - l) / range,
    closePos: (cl - l) / range, // 0 = closed at the low, 1 = closed at the high
    vol: Number(c.volume) || 0,
  };
}

// Buyer/seller PRESSURE PROXY. Honest by construction: blends candle body, wick rejection,
// close position in range, and tick-volume ratio over the last few bars. NOT real order flow.
function lmtPressureProxy(candles, lookback = 20) {
  const recent = candles.slice(-lookback);
  const avgVol = recent.length ? recent.reduce((a, c) => a + (Number(c.volume) || 0), 0) / recent.length : 0;
  const last = lmtCandleAnatomy(candles[candles.length - 1]);
  const volRatio = avgVol > 0 ? last.vol / avgVol : 1;

  // Recent-weighted buyer/seller tug-of-war over the last 5 bars (latest weighted heaviest).
  const window = candles.slice(-5).map(lmtCandleAnatomy);
  let buy = 0, sell = 0, wsum = 0;
  window.forEach((a, idx) => {
    const w = idx + 1; wsum += w;
    buy += ((a.closePos * 0.5) + (a.bullish ? a.bodyRatio * 0.3 : 0) + (a.lowerWickRatio * 0.2)) * w;
    sell += (((1 - a.closePos) * 0.5) + (!a.bullish ? a.bodyRatio * 0.3 : 0) + (a.upperWickRatio * 0.2)) * w;
  });
  buy /= wsum; sell /= wsum;
  const total = (buy + sell) || 1;
  const buyerPressure = Math.round((buy / total) * 100);
  const sellerPressure = 100 - buyerPressure;
  // Aggression needs conviction: a big decisive body on above-average tick volume.
  const aggressiveBuying = Math.round(Math.min(100, (last.bullish ? last.bodyRatio : 0) * last.closePos * Math.min(2, volRatio) * 100));
  const aggressiveSelling = Math.round(Math.min(100, (!last.bullish ? last.bodyRatio : 0) * (1 - last.closePos) * Math.min(2, volRatio) * 100));

  return {
    isProxy: true,
    basis: 'Proxy from candle body/wick/close-position + tick volume. NOT real order-flow, bid/ask volume, or trader counts (this feed has none).',
    buyerPressure, sellerPressure,
    dominant: buyerPressure > sellerPressure ? 'BUYERS' : sellerPressure > buyerPressure ? 'SELLERS' : 'BALANCED',
    aggressiveBuying, aggressiveSelling,
    volumeRatio: Math.round(volRatio * 100) / 100,
    volumeState: volRatio >= 1.5 ? 'HIGH' : volRatio >= 0.8 ? 'NORMAL' : 'LOW',
    lastCandle: { bullish: last.bullish, bodyPct: Math.round(last.bodyRatio * 100), closePosPct: Math.round(last.closePos * 100) },
  };
}

// Score + position every detected order block relative to the current price.
function lmtAnalyzeOrderBlocks(candles, obs, fvgs, price, atr, pip, dirBias) {
  const out = obs.map((ob) => {
    const low = Math.min(Number(ob.top), Number(ob.bottom));
    const high = Math.max(Number(ob.top), Number(ob.bottom));
    const inside = price >= low && price <= high;
    const dist = inside ? 0 : (price < low ? low - price : price - high);
    const distAtr = atr ? Math.round((dist / atr) * 100) / 100 : null;
    const imbalance = fvgs.some((f) => f.type === ob.type && f.actionable && Number(f.bottom) <= high && Number(f.top) >= low);
    // Lifecycle is computed by the detector strictly after BOS confirmation. Gather
    // activity from the same boundary so pre-confirmation candles cannot consume a zone.
    const confirmationMs = Date.parse(ob.confirmationTime || '');
    const mitigated = !ob.actionable;
    let zoneVol = 0, reactions = 0;
    for (const c of candles) {
      const t = Date.parse(c.time || '');
      if (!Number.isFinite(t) || !Number.isFinite(confirmationMs) || t <= confirmationMs) continue;
      const ch = Number(c.high), clo = Number(c.low);
      if (Number.isFinite(ch) && Number.isFinite(clo) && ch >= low && clo <= high) { zoneVol += Number(c.volume) || 0; reactions++; }
    }
    let score = 40;
    if (dirBias && ob.type === dirBias) score += 20; // aligned with bias
    if (!mitigated) score += 20;                      // fresh / unmitigated
    if (imbalance) score += 15;                        // displacement / imbalance present
    if (distAtr !== null && distAtr <= 0.5) score += 10; // price is close to it
    if (inside) score += 10;
    score = Math.min(100, score);
    return {
      type: ob.type, kind: ob.type === 'BULLISH' ? 'DEMAND' : 'SUPPLY',
      low: lmtRound5(low), high: lmtRound5(high), mid: lmtRound5((low + high) / 2),
      inside, distancePips: Math.round((dist / pip) * 10) / 10, distanceAtr: distAtr,
      imbalance, displacement: imbalance, mitigated,
      zoneActivity: { tickVolume: zoneVol, reactions, note: 'Tick-volume that transacted inside the zone (honest stand-in for "buyers/sellers in the OB").' },
      score, grade: score >= 80 ? 'A' : score >= 65 ? 'B' : 'C', time: ob.time,
      confirmationTime: ob.confirmationTime || null, lifecycle: ob.lifecycle || null,
    };
  });
  out.sort((a, b) => (b.score - a.score) || ((a.distanceAtr ?? 99) - (b.distanceAtr ?? 99)));
  return out;
}

// The single entry verdict: WAIT / WATCH / ARMED_IF_CONFIRMED / NO_TRADE / STALE_DATA / MARKET_CLOSED.
// Deliberately strict — "good location" only when fresh + open + at a strong aligned OB in the
// right premium/discount half + liquidity swept + imbalance + pressure agrees.
function lmtVerdict({ fresh, marketOpen, desk, obAnalysis, pressure }) {
  if (!marketOpen) return { verdict: 'MARKET_CLOSED', canEnter: false, direction: null, checklist: null, reasons: ['Forex market is calendar-closed (weekend). Informational read only.'] };
  if (!fresh) return { verdict: 'STALE_DATA', canEnter: false, direction: null, checklist: null, reasons: ['Live feed is stale — not judging entries on old candles.'] };

  const dec = String(desk.decision || 'HOLD').toUpperCase();
  const dir = desk.zone ? (desk.zone.kind === 'DEMAND' ? 'BUY' : 'SELL')
    : dec.includes('BUY') ? 'BUY' : dec.includes('SELL') ? 'SELL'
    : desk.htfBias === 'BULLISH' ? 'BUY' : desk.htfBias === 'BEARISH' ? 'SELL' : null;

  // Actionable zones must be UNMITIGATED — a block price already traded back through
  // is spent (its orders consumed); it may display, but it can't arm an entry verdict.
  const wantedKind = dir === 'BUY' ? 'DEMAND' : dir === 'SELL' ? 'SUPPLY' : null;
  const nearStrongOb = obAnalysis.find((o) => wantedKind && o.kind === wantedKind && !o.mitigated && o.score >= 65 && (o.inside || (o.distanceAtr !== null && o.distanceAtr <= 0.5))) || null;
  const inDiscount = desk.premiumDiscount && desk.premiumDiscount.zone === 'DISCOUNT';
  const inPremium = desk.premiumDiscount && desk.premiumDiscount.zone === 'PREMIUM';
  const goodLocation = (dir === 'BUY' && inDiscount) || (dir === 'SELL' && inPremium);
  const swept = (dir === 'BUY' && desk.sweep === 'bullish') || (dir === 'SELL' && desk.sweep === 'bearish');
  const imbalance = Boolean(nearStrongOb && nearStrongOb.imbalance);
  const pressureAligns = dir === 'BUY' ? pressure.dominant === 'BUYERS' : dir === 'SELL' ? pressure.dominant === 'SELLERS' : false;
  const notExtended = !desk.extended;

  const checklist = { hasBias: !!dir, nearStrongOb: !!nearStrongOb, goodLocation, liquiditySwept: swept, imbalance, pressureAligns, notExtended };
  const reasons = [];
  let verdict;
  if (!dir) { verdict = 'NO_TRADE'; reasons.push('No clear directional bias.'); }
  else if (desk.extended) { verdict = 'NO_TRADE'; reasons.push('Price is over-extended from the mean — do not chase.'); }
  else if (nearStrongOb && goodLocation && swept && imbalance && pressureAligns) {
    verdict = 'ARMED_IF_CONFIRMED';
    reasons.push(`At a ${nearStrongOb.grade}-grade ${nearStrongOb.kind} zone in ${dir === 'BUY' ? 'discount' : 'premium'}, liquidity swept, imbalance present, ${pressure.dominant.toLowerCase()} in control — wait for your confirmation candle, then enter.`);
  } else if (nearStrongOb && goodLocation) {
    verdict = 'WATCH'; reasons.push(`Price at a ${nearStrongOb.kind} zone in the right half of the range — watch for a sweep + confirmation.`);
  } else {
    verdict = 'WAIT';
    if (!nearStrongOb) reasons.push('Not at a strong order block yet.');
    if (!goodLocation && dir) reasons.push(`Not in ${dir === 'BUY' ? 'discount' : 'premium'} — wait for a better location.`);
  }
  return { verdict, canEnter: verdict === 'ARMED_IF_CONFIRMED', direction: dir, checklist, reasons };
}

function buildLiveMarketTracker(symbol, tf) {
  const candles = getRecentCandles(symbol, tf, 250);
  if (!candles || candles.length < 30) return null;
  const analysisCandles = closedBarsOnly(candles, tf);
  if (!analysisCandles || analysisCandles.length < 30) return null;
  const desk = buildStructureDesk(symbol, tf);
  if (!desk) return null;
  const fresh = candleFreshness(candles[candles.length - 1], tf);
  const marketOpen = liveSignalsAllowed();
  const price = Number(candles[candles.length - 1].close);
  const atr = lmtAtr14(analysisCandles);
  const pip = pipSizeForSymbol(symbol) || 0.0001;
  const dirBias = desk.htfBias === 'BULLISH' || desk.phase === 'UPTREND' ? 'BULLISH'
    : desk.htfBias === 'BEARISH' || desk.phase === 'DOWNTREND' ? 'BEARISH' : null;

  const obAnalysis = lmtAnalyzeOrderBlocks(analysisCandles, detectOrderBlocks(analysisCandles), detectFVGs(analysisCandles), price, atr, pip, dirBias).slice(0, 6);
  const pressure = lmtPressureProxy(analysisCandles);
  const verdict = lmtVerdict({ fresh: fresh.dataFresh, marketOpen, desk, obAnalysis, pressure });
  // Institutional liquidity map (computed once in buildStructureDesk): PDH/PDL, session H/L,
  // round numbers, equal highs/lows, major swings.
  const keyLevels = desk.keyLevels || { levels: [], nearestAbove: null, nearestBelow: null };
  // High-probability sweep grade (5-component model) for the current chart — same engine as the
  // liquidity-sweep-pro strategy. minGrade 'C' so the cockpit shows borderline reads too.
  const sweepGrade = gradeSweep(analysisCandles, { symbol, dailyCandles: getRecentCandles(symbol, 'D1', 8), h4Trend: desk.htfBias || null, h1Trend: dirBias, minGrade: 'C' });

  const nearestDemand = obAnalysis.filter((o) => o.kind === 'DEMAND' && !o.mitigated).sort((a, b) => (a.distanceAtr ?? 99) - (b.distanceAtr ?? 99))[0] || null;
  const nearestSupply = obAnalysis.filter((o) => o.kind === 'SUPPLY' && !o.mitigated).sort((a, b) => (a.distanceAtr ?? 99) - (b.distanceAtr ?? 99))[0] || null;
  const pdPct = desk.premiumDiscount?.pct ?? null;

  return {
    symbol, timeframe: tf, price: lmtRound5(price), atr: lmtRound5(atr),
    feedState: !marketOpen ? 'MARKET_CLOSED' : fresh.dataFresh ? 'LIVE' : 'STALE',
    dataFresh: fresh.dataFresh, sourceReceivedAt: fresh.sourceReceivedAt, staleSeconds: fresh.staleSeconds, marketStatus: fresh.marketStatus,
    session: strategyLabSession(new Date().toISOString()),
    pricePosition: desk.premiumDiscount ? {
      pct: pdPct, zone: desk.premiumDiscount.zone,
      label: pdPct < 33 ? 'NEAR RANGE LOW' : pdPct > 66 ? 'NEAR RANGE HIGH' : 'MID-RANGE',
      rangeHigh: desk.premiumDiscount.rangeHigh, rangeLow: desk.premiumDiscount.rangeLow, equilibrium: desk.premiumDiscount.equilibrium,
    } : null,
    bias: dirBias, phase: desk.phase, regime: desk.regime, decision: desk.decision, grade: desk.grade, score: desk.score,
    extended: desk.extended, emaDistanceAtr: desk.emaDistanceAtr,
    pressure,
    orderBlocks: obAnalysis, nearestDemand, nearestSupply,
    liquidity: desk.liquidity, recentSweep: desk.sweep, breaker: desk.breaker, plan: desk.plan,
    keyLevels: keyLevels.levels.slice(0, 14), nearestKeyAbove: keyLevels.nearestAbove, nearestKeyBelow: keyLevels.nearestBelow,
    sweepGrade,
    verdict,
  };
}

// GET /api/live-market-tracker?symbol=&timeframe= — the pre-entry cockpit read for one symbol
// plus a compact watchlist (verdict + pressure) across curated symbols on the same timeframe.
app.get('/api/live-market-tracker', (req, res) => {
  try {
    const tf = (req.query.timeframe ? String(req.query.timeframe) : 'M5').toUpperCase();
    const symbols = getCuratedSymbols(getMt5Status().symbols);
    const want = req.query.symbol ? String(req.query.symbol).toUpperCase() : (symbols[0] || 'XAUUSDM');
    const sym = symbols.find((s) => s.toUpperCase() === want) || want;
    const tracker = buildLiveMarketTracker(sym, tf);
    if (!tracker) return res.status(404).json({ error: `Not enough candle data for ${sym} ${tf}. Pick a streamed symbol/timeframe.` });

    const watchlist = [];
    for (const s of symbols) {
      try {
        const t = buildLiveMarketTracker(s, tf);
        if (t) watchlist.push({
          symbol: s, price: t.price, feedState: t.feedState, bias: t.bias,
          verdict: t.verdict.verdict, buyerPressure: t.pressure.buyerPressure, sellerPressure: t.pressure.sellerPressure,
          nearestDistanceAtr: Math.min(t.nearestDemand?.distanceAtr ?? 99, t.nearestSupply?.distanceAtr ?? 99),
        });
      } catch { /* per-symbol resilience */ }
    }
    watchlist.sort((a, b) => (a.nearestDistanceAtr - b.nearestDistanceAtr));

    res.json({
      ok: true, ...tracker, watchlist,
      generatedAt: new Date().toISOString(),
      honesty: [
        'Buyer/seller pressure is a PROXY from candle anatomy + tick volume — not real order-flow, bid/ask volume, or trader counts.',
        ...(tracker.marketStatus.open ? [] : ['Market is closed (weekend) — this read is informational only, not an actionable signal.']),
        ...(tracker.dataFresh ? [] : ['Feed is stale — values reflect the last received candle, not live price.']),
      ],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Strategy Lab — isolated single-strategy signals (forex + fixed-time, all TFs) ──
// Completely separate from aggregateSignals. Runs each registered strategy over every
// curated symbol × every available timeframe, logs signals, and scores each TWO ways:
// forex (TP/SL replay) + fixed-time (direction at next-candle expiry). Honest per-
// strategy / per-timeframe win rates so we can see which actually works.
const STRATEGY_LAB_TIMEFRAMES = (process.env.STRATEGY_LAB_TIMEFRAMES || 'M1,M5,M15,M30,H1,H4,D1')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const STRATEGY_LAB_SCAN_MS = Math.max(60000, Number(process.env.STRATEGY_LAB_SCAN_MS || 5 * 60 * 1000));
const STRATEGY_LAB_RETENTION_DAYS = Math.max(7, Number(process.env.STRATEGY_LAB_RETENTION_DAYS || 45));
const STRATEGY_LAB_FT_EXPIRY_BARS = Math.max(1, Number(process.env.STRATEGY_LAB_FT_EXPIRY_BARS || 1));
const STRATEGY_LAB_ALERT_MIN_SCORE = Math.max(50, Number(process.env.STRATEGY_LAB_ALERT_MIN_SCORE || 75));
// Delivery-only entry-gap guard: don't alert a setup whose signal bar closed this many (or
// more) bars ago — price has drifted off the planned entry. Logging/ranking never gated.
const STRATEGY_LAB_STALE_SETUP_BARS = Math.max(1, Number(process.env.STRATEGY_LAB_STALE_SETUP_BARS || 2));
let strategyLabScanRunning = false;

// Trading session for a Strategy Lab signal, in Bangladesh time (BDT = UTC+6). Pure
// function of the timestamp — no DB column needed; works for historical rows too. Hour
// ranges are chosen for gold/forex liquidity. The London–NY overlap (19:00–22:00 BD) is
// when XAU moves most. NOTE: fixed offset, ignores DST in London/NY (advisory label only).
const STRATEGY_LAB_SESSION_META = {
  SYDNEY:  { label: 'Sydney',            bdRange: '04:00–07:00 BD' },
  TOKYO:   { label: 'Tokyo (Asian)',     bdRange: '07:00–13:00 BD' },
  LONDON:  { label: 'London',            bdRange: '13:00–19:00 BD' },
  OVERLAP: { label: 'London–NY overlap', bdRange: '19:00–22:00 BD' },
  NEWYORK: { label: 'New York',          bdRange: '22:00–02:00 BD' },
  OFF:     { label: 'Off-hours (quiet)', bdRange: '02:00–04:00 BD' },
  UNKNOWN: { label: 'Unknown',           bdRange: '' },
};
function strategyLabSessionKey(bdHour) {
  if (bdHour >= 4 && bdHour < 7) return 'SYDNEY';
  if (bdHour >= 7 && bdHour < 13) return 'TOKYO';
  if (bdHour >= 13 && bdHour < 19) return 'LONDON';
  if (bdHour >= 19 && bdHour < 22) return 'OVERLAP';
  if (bdHour >= 2 && bdHour < 4) return 'OFF';
  return 'NEWYORK'; // 22, 23, 0, 1
}
function strategyLabSession(value) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return { key: 'UNKNOWN', ...STRATEGY_LAB_SESSION_META.UNKNOWN, bdHour: null, bdTime: null };
  const d = new Date(ms);
  const bdHour = (d.getUTCHours() + 6) % 24;
  const bdMin = d.getUTCMinutes();
  const key = strategyLabSessionKey(bdHour);
  return {
    key, ...STRATEGY_LAB_SESSION_META[key], bdHour,
    bdTime: `${String(bdHour).padStart(2, '0')}:${String(bdMin).padStart(2, '0')} BD`,
  };
}

// Position sizing for a strategy signal. Lots are risk-based: a fixed % of equity divided
// by the stop distance in pips — so the suggested volume scales naturally WITH the
// timeframe (a higher-TF signal has a wider stop → fewer lots; a scalp TF → more lots).
// Equity comes from the live MT5 snapshot, else FOREX_SIGNAL_DEFAULT_EQUITY.
function strategyLabSizing(symbol, entry, stop, targets = {}) {
  const e = Number(entry), s = Number(stop);
  if (!Number.isFinite(e) || !Number.isFinite(s) || e === s) return null;
  const pipSize = forexSizingPipSize(symbol);
  const pipValue = forexSizingPipValuePerLot(symbol);
  const equity = finitePositive(mt5State.accountSnapshot?.equity)
    ?? finitePositive(mt5State.accountSnapshot?.balance)
    ?? Math.max(1, Number(process.env.FOREX_SIGNAL_DEFAULT_EQUITY || 1000));
  const riskPercent = Math.min(3, Math.max(0.1, Number(process.env.STRATEGY_LAB_RISK_PERCENT || process.env.FOREX_SIGNAL_RISK_PERCENT || 1)));
  const stopPips = Math.round((Math.abs(e - s) / pipSize) * 10) / 10;
  if (!(stopPips > 0)) return null;
  const riskAmount = Math.round(equity * (riskPercent / 100) * 100) / 100;
  const lots = Math.max(0.01, Math.round((riskAmount / (stopPips * pipValue)) * 100) / 100);
  const profitAt = (tp) => {
    const t = Number(tp);
    if (!Number.isFinite(t)) return null;
    return Math.round((Math.abs(t - e) / pipSize) * pipValue * lots * 100) / 100;
  };
  return {
    equity, riskPercent, riskAmount, stopPips, pipValuePerLot: pipValue, suggestedLots: lots,
    lossAtStop: Math.round(stopPips * pipValue * lots * 100) / 100,
    profitAtTp1: profitAt(targets.tp1), profitAtTp2: profitAt(targets.tp2), profitAtTp3: profitAt(targets.tp3),
  };
}

// Entry-timing / tradability for a logged signal. These are limit-style entries, so a
// fresh signal is only actionable for a short window after it forms. Deterministic, from
// the candles since the signal bar:
//   WAIT      — price hasn't reached the entry yet, still inside the validity window.
//   TRADABLE  — price has tagged the entry (and not the stop) → take it now.
//   EXPIRED   — entry never filled in time, or the stop was touched first → gone; the
//               scanner will surface the next best setup on its next pass.
//   SETTLED   — outcome already resolved (WIN/LOSS) → it has played out.
const STRATEGY_LAB_ENTRY_VALID_BARS = Math.max(1, Number(process.env.STRATEGY_LAB_ENTRY_VALID_BARS || 4));
function strategySignalPlan(source) {
  const raw = source?.setup_plan ?? source?.setupPlan ?? source?.meta?.plan ?? source?.plan;
  if (raw) return String(raw).toUpperCase();
  const reason = String(source?.reason || '').toUpperCase();
  if (reason.startsWith('SWEEP-REJECT')) return 'SWEEP-REJECT';
  if (reason.startsWith('BREAK-HOLD')) return 'BREAK-HOLD';
  return null;
}
function strategySignalVersion(source) {
  const raw = source?.strategy_version ?? source?.strategyVersion ?? source?.meta?.strategyVersion ?? source?.meta?.v;
  return Number.isFinite(Number(raw)) ? Number(raw) : null;
}
function strategySignalOrderType(source) {
  const raw = source?.entry_order_type ?? source?.entryOrderType ?? source?.meta?.entryOrderType;
  if (raw) return String(raw).toUpperCase();
  const strategy = String(source?.strategy || '').toLowerCase();
  const declared = STRATEGY_LAB_REGISTRY[strategy]?.entryOrderType;
  if (declared) return String(declared).toUpperCase();
  if (strategy === 'special-forex-sniper') return 'LIMIT';
  if (strategy === 'lil-sweep-pro-plus') {
    const plan = strategySignalPlan(source);
    return plan === 'BREAK-HOLD' ? 'MARKET' : plan === 'SWEEP-REJECT' ? 'STOP' : 'STOP';
  }
  return 'MARKET';
}
function strategySignalMeasuresFixedTime(source) {
  const strategy = String(source?.strategy || source?.id || '').toLowerCase();
  if (STRATEGY_LAB_REGISTRY[strategy]?.forexOnly) return false;
  const raw = source?.measure_fixed_time ?? source?.measureFixedTime ?? source?.meta?.measureFixedTime;
  if (raw === 0 || raw === false) return false;
  if (raw === 1 || raw === true) return true;
  return true;
}
function strategySignalValidUntilMs(source, timeframe) {
  const explicit = source?.valid_until ?? source?.validUntilIso ?? source?.meta?.validUntilIso;
  const explicitMs = explicit ? Date.parse(explicit) : NaN;
  if (Number.isFinite(explicitMs)) return explicitMs;
  const sigMs = source?.signal_time ? new Date(source.signal_time).getTime() : source?.signalTime ? Date.parse(source.signalTime) : NaN;
  const tfMs = (timeframeMinutes(timeframe) || 0) * 60000;
  const bars = Number(source?.valid_bars ?? source?.validBars ?? source?.meta?.validBars);
  if (Number.isFinite(sigMs) && tfMs > 0 && Number.isFinite(bars) && bars > 0) return sigMs + bars * tfMs;
  if (Number.isFinite(sigMs) && tfMs > 0 && String(source?.strategy || '').toLowerCase() === 'lil-sweep-pro-plus') return sigMs + STRATEGY_LAB_ENTRY_VALID_BARS * tfMs;
  return NaN;
}
function strategySignalFilledAtSignal(source) {
  if (source?.meta?.fillAtSignal === true) return true;
  const state = String((source?.entry_state ?? source?.entryState ?? source?.meta?.entryState) || '').toUpperCase();
  if (state !== 'FILLED') return false;
  const fillMs = source?.entry_filled_at ? new Date(source.entry_filled_at).getTime() : source?.entryFilledAt ? Date.parse(source.entryFilledAt) : NaN;
  const sigMs = source?.signal_time ? new Date(source.signal_time).getTime() : source?.signalTime ? Date.parse(source.signalTime) : NaN;
  return !Number.isFinite(fillMs) || !Number.isFinite(sigMs) || fillMs <= sigMs;
}
function strategyLabTiming(row) {
  const sigMs = row.signal_time ? new Date(row.signal_time).getTime() : NaN;
  const tfMin = timeframeMinutes(row.timeframe);
  const expectByMs = strategySignalValidUntilMs(row, row.timeframe);
  const expectEntryBy = Number.isFinite(expectByMs) ? new Date(expectByMs).toISOString() : null;
  const hhmm = Number.isFinite(expectByMs)
    ? new Date(expectByMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
    : '';
  const outcome = String(row.outcome || 'PENDING').toUpperCase();
  if (['LOSS', 'TP1_WIN', 'TP2_WIN', 'TP3_WIN', 'WIN', 'AMBIGUOUS'].includes(outcome)) {
    return { status: 'SETTLED', expectEntryBy, message: `Played out — ${outcome.replace('_', ' ')}` };
  }
  if (outcome === 'EXPIRED') {
    return { status: 'EXPIRED', expectEntryBy, message: 'Expired & gone — best setup returns after the next scan' };
  }
  // PENDING — decide from price action since the signal bar.
  const entry = Number(row.entry_price), stop = Number(row.stop_loss);
  const buy = /BUY/.test(String(row.direction).toUpperCase());
  const orderType = strategySignalOrderType(row);
  const filledAtSignal = strategySignalFilledAtSignal(row);
  if (orderType === 'MARKET') {
    return { status: 'FILLED', expectEntryBy, message: 'Entered at signal time — waiting for TP/SL outcome' };
  }
  // Post-alert evidence: prefer M1 bars from the first complete minute after the
  // alert — signal-TF bars are keyed by OPEN time, so the alert's own (still-open)
  // bar was skipped entirely and a fill inside it went unseen (the GBPUSD sniper
  // "filled but WAIT" audit case). Falls back to signal-TF bars when M1 is absent.
  let candles = null, usingM1 = false;
  if (Number.isFinite(sigMs)) {
    const m1From = Math.ceil(sigMs / 60000) * 60000;
    const fine = (getRecentCandles(row.symbol, 'M1', 1000) || []).filter((c) => (Date.parse(c.time) || 0) >= m1From);
    if (fine.length) { candles = fine; usingM1 = true; }
  }
  if (!candles) candles = getRecentCandles(row.symbol, row.timeframe, 300);
  let touchedEntry = filledAtSignal, hitStop = false;
  let filledAtIso = row.entry_filled_at ? new Date(row.entry_filled_at).toISOString() : null;
  if (candles && candles.length && Number.isFinite(sigMs)) {
    const includeLilV2SignalBar = String(row.strategy) === 'lil-sweep-pro-plus'
      && strategySignalVersion(row) >= 2
      && orderType === 'STOP';
    const timingStartMs = usingM1 ? 0 // M1 list is already trimmed to post-alert bars
      : includeLilV2SignalBar
        ? Math.floor(sigMs / (tfMin * 60000)) * tfMin * 60000
        : sigMs;
    for (const c of candles) {
      const t = Date.parse(c.time || '');
      if (!Number.isFinite(t) || (usingM1 ? false : (includeLilV2SignalBar ? t < timingStartMs : t <= timingStartMs))) continue;
      if (Number.isFinite(expectByMs) && t >= expectByMs) break;
      const hi = Number(c.high), lo = Number(c.low);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const hitEntry = Number.isFinite(entry) && (orderType === 'STOP' ? (buy ? hi >= entry : lo <= entry) : (lo <= entry && entry <= hi));
        const stopTouched = Number.isFinite(stop) && (buy ? lo <= stop : hi >= stop);
        if (!touchedEntry) {
          if (hitEntry) { touchedEntry = true; filledAtIso = c.time || filledAtIso; }
          else if (stopTouched) { hitStop = true; break; }
        }
      }
    }
  }
  if (hitStop) return { status: 'EXPIRED', expectEntryBy, message: 'Invalidated (stop touched before entry) — returns after next scan' };
  if (touchedEntry) {
    // A touched LIMIT is a FILL — the resting order executed at the touch. Labeling it
    // "TRADABLE" kept rows shouting EXECUTE_NOW long after price had left the entry
    // (EURUSD M30 audit contradiction). Filled trades belong to the live tracker.
    return orderType === 'STOP'
      ? { status: 'FILLED', expectEntryBy, filledAtIso, message: 'Break trigger filled — waiting for TP/SL outcome' }
      : { status: 'FILLED', expectEntryBy, filledAtIso, message: 'Limit entry filled — trade is live; track it in the Signal Tracker' };
  }
  if (Number.isFinite(expectByMs) && Date.now() <= expectByMs) {
    return { status: 'WAIT', expectEntryBy, message: orderType === 'STOP' ? `Wait for breakout trigger @ entry — valid until ${hhmm}` : `Wait for limit @ entry — valid until ${hhmm}` };
  }
  return { status: 'EXPIRED', expectEntryBy, message: orderType === 'STOP' ? 'Trigger never broke in time — expired & gone; returns after next scan' : 'Entry not reached in time — expired & gone; returns after next scan' };
}

// Honesty gate for FIXED-TIME: a next-candle call is only valid if it was surfaced while
// its expiry candle was still open — i.e. at `atMs` we have not passed bar_time + 2×tf
// (setup bar closes at +1×tf, the expiry candle closes at +2×tf). Setups surfaced later
// (strategy looked back N bars) were never tradable as a next-candle bet. Used to skip
// stale fixed-time outcomes/notifications. Does NOT affect the forex (TP/SL) side.
function strategyFtActionable(barMs, timeframe, atMs = Date.now()) {
  const tfMs = timeframeMinutes(timeframe) * 60000;
  return Number.isFinite(barMs) && tfMs > 0 && atMs < barMs + 2 * tfMs;
}

// LIVE tradability for a current-bar signal, judged against the latest price. These are
// limit entries at a level, so the actionable call is: has price reached the entry yet
// (take it now), is it still away (wait for the pullback/approach), or has the stop
// already been breached (skip — the scanner will surface the next setup).
function strategyLabLiveTiming(symbol, direction, price, entry, stop, signalMeta = null) {
  const buy = /BUY/.test(String(direction).toUpperCase());
  const p = Number(price), e = Number(entry), s = Number(stop);
  const orderType = strategySignalOrderType(signalMeta || {});
  if (![p, e, s].every(Number.isFinite)) return { status: 'WAIT', message: 'Awaiting price' };
  if (buy ? p <= s : p >= s) return { status: 'EXPIRED', message: 'Stop already hit — skip; next scan brings the best setup' };
  if (orderType === 'MARKET') return { status: 'TRADABLE', message: 'Retest candle closed — enter at market now' };
  if (orderType === 'STOP') {
    if (buy ? p >= e : p <= e) return { status: 'TRADABLE', message: 'Break trigger just fired — tradable now' };
  } else if (buy ? p <= e : p >= e) {
    return { status: 'TRADABLE', message: 'Price at entry — tradable now' };
  }
  const pip = pipSizeForSymbol(symbol) || 0.0001;
  const distPips = Math.round((Math.abs(p - e) / pip) * 10) / 10;
  return orderType === 'STOP'
    ? { status: 'WAIT', message: `Wait — ${distPips} pips to breakout trigger ${px(e, symbol)}` }
    : { status: 'WAIT', message: `Wait — ${distPips} pips ${buy ? 'pullback' : 'rally'} to entry ${px(e, symbol)}` };
}

// Short advisory for a forex strategy signal: enter now / wait for the pullback / skip,
// judged from the latest price vs the limit entry + a conviction note from the score.
// Advisory only — not financial advice.
function strategyForexAdvisory(symbol, timeframe, sig) {
  let price = NaN;
  try { const c = getRecentCandles(symbol, timeframe, 2); if (c && c.length) price = Number(c[c.length - 1].close); } catch { /* ignore */ }
  const orderType = strategySignalOrderType(sig.meta || sig);
  const t = strategyLabLiveTiming(symbol, sig.decision, price, sig.entry, sig.stopLoss, sig.meta || sig);
  const conv = (sig.score ?? 0) >= 85 ? ' High-conviction setup.' : (sig.score ?? 0) < 70 ? ' Lower-conviction — be selective.' : '';
  if (t.status === 'TRADABLE') {
    return orderType === 'STOP'
      ? `ENTER NOW — the breakout trigger just fired. Manage from market with SL ${px(sig.stopLoss, symbol)} and scale out at TP1/TP2/TP3.${conv}`
      : orderType === 'MARKET'
        ? `ENTER NOW — the retest candle just closed. Enter at market with SL ${px(sig.stopLoss, symbol)} and scale out at TP1/TP2/TP3.${conv}`
        : `ENTER NOW — price is at the entry. Set SL ${px(sig.stopLoss, symbol)} and scale out at TP1/TP2/TP3.${conv}`;
  }
  if (t.status === 'FILLED') return 'FILLED — the trade is already open and waiting on TP/SL outcome.';
  if (t.status === 'EXPIRED') return 'SKIP — price already reached the stop side; this setup is gone. Wait for the next one.';
  if (orderType === 'STOP') return `WAIT for the break — ${t.message.replace(/^Wait — /, '')}. If the trigger never breaks in time, skip it and wait for the next setup.${conv}`;
  if (orderType === 'MARKET') return `WAIT for the retest close — ${t.message.replace(/^Wait — /, '')}.${conv}`;
  return `WAIT for a pullback — ${t.message.replace(/^Wait — /, '')}. If price runs away without tagging the entry, skip it and wait for the next setup.${conv}`;
}

// Advisory trading notes — MEASURED and beginner-friendly. Plain-English guidance with
// this trade's actual numbers, distilled from the Chart Fanatics interviews (Massi Safi —
// "Little Rizzy"; Fabio Valentino — auction/order-flow scalping). Educational only:
// appended to emails. Does NOT affect scoring/signals/strategies/outcomes.
function strategyAdvisoryNotes(strategy, sig, { symbol, timeframe, fixedTime = false } = {}) {
  const pip = pipSizeForSymbol(symbol) || 0.0001;
  const buy = /BUY/.test(String(sig.decision));
  const entry = Number(sig.entry), stop = Number(sig.stopLoss), tp1 = Number(sig.takeProfit1), tp3 = Number(sig.takeProfit3);
  const pips = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.round(Math.abs(a - b) / pip) : null);
  let price = NaN;
  try { const c = getRecentCandles(symbol, timeframe, 2); if (c && c.length) price = Number(c[c.length - 1].close); } catch { /* ignore */ }
  const notes = [];

  // D1 Stage Analysis advisory filter (Weinstein/Ted Zack). Context overlay only — it does
  // NOT change the score, the signal, or whether the email fires. With-trend = stronger;
  // against = weaker/skip; Stage 1 (base) / Stage 3 (top) = choppy wait zone.
  let stageNote = null;
  try {
    const d1Stage = computeStage(getRecentCandles(symbol, 'D1', 70));
    if (d1Stage) {
      let verdict;
      if ((buy && d1Stage.stage === 2) || (!buy && d1Stage.stage === 4)) verdict = 'WITH the dominant trend — stronger ✓';
      else if ((buy && d1Stage.stage === 4) || (!buy && d1Stage.stage === 2)) verdict = 'AGAINST the dominant trend — weaker; consider skipping ✗';
      else verdict = `a choppy "wait" zone (Stage ${d1Stage.stage}) — lower conviction`;
      stageNote = `Stage filter (D1): ${d1Stage.label}. This ${buy ? 'BUY' : 'SELL'} is ${verdict}.`;
    }
  } catch { /* advisory best-effort */ }

  if (fixedTime) {
    // Fixed-time = a one-candle directional bet; no stop/target to manage.
    notes.push(`This is a ONE-CANDLE bet: it wins only if price closes ${buy ? 'HIGHER' : 'LOWER'} than now by the end of this ${timeframe} candle.`);
    notes.push('There is no stop or target to manage — it just settles at the candle close. Enter now, before the candle ends.');
    notes.push('Skip if the market looks flat or choppy — fixed-time works best when price is clearly moving.');
    notes.push('Quality over quantity — if it is not clear, skip it; the next one will come.');
    if (stageNote) notes.unshift(stageNote);
    return notes.slice(0, 5);
  }

  const riskPips = pips(entry, stop);
  const tp1Pips = pips(tp1, entry);
  const tp3Pips = pips(tp3, entry);
  const rr = sig.riskRewardRatio != null ? Math.round(Number(sig.riskRewardRatio) * 10) / 10 : null;
  const sizing = strategyLabSizing(symbol, entry, stop, { tp1, tp2: sig.takeProfit2, tp3 });
  const lossTxt = sizing?.lossAtStop != null ? ` (≈ ${px2(sizing.lossAtStop)})` : '';

  if (riskPips != null) notes.push(`Max loss ≈ ${riskPips} pips${lossTxt} if it hits the stop ${px(stop, symbol)}. That is the MOST you should lose — never move the stop further away.`);
  if (tp1Pips != null) notes.push(`When price reaches TP1 ${px(tp1, symbol)} (+${tp1Pips} pips), move your stop to your entry ${px(entry, symbol)} — after that you cannot lose on this trade.`);
  if (tp3Pips != null && rr != null) notes.push(`Main target TP3 ${px(tp3, symbol)} (+${tp3Pips} pips) ≈ ${rr}× your risk. Don't aim past it — reaching for more lowers your odds of being right.`);

  if (strategy === 'little-rizzy') {
    const mm = sig.meta && Number.isFinite(sig.meta.measuredMove) ? Math.round(sig.meta.measuredMove / pip) : null;
    if (mm != null) notes.push(`Why this target: the last move was about ${mm} pips, and this pattern usually repeats that distance.`);
    notes.push(`Price is near the ${buy ? 'bottom' : 'top'} of its recent range (Bollinger), so there is room to ${buy ? 'rise' : 'fall'} toward the target.`);
  } else if (strategy === 'ict-breaker' || strategy === 'liquidity-trap') {
    notes.push('Confirm first: only valid once a candle CLOSES the move — a quick wick touching the level is not enough.');
  } else if (strategy === 'market-mechanics-3step') {
    notes.push('Only valid with the bigger (H4) trend and at a good price zone — no location, no trade.');
  } else if (strategy === 'lil-sweep-pro-plus') {
    const m = sig.meta || {};
    const lv = m.level || {};
    const dots = '●'.repeat(Math.max(1, Math.min(5, Number(lv.strength) || 4)));
    if (m.plan === 'SWEEP-REJECT') {
      notes.push(`Plan A — sweep-rejection at ${lv.label || lv.type || 'a key level'} ${dots}: the level was swept, price closed back ${buy ? 'above' : 'below'} and failed to hold. ${buy ? 'BUY' : 'SELL'} only when price BREAKS ${px(entry, symbol)} (the rejection candle's ${buy ? 'high' : 'low'}) — if the break never comes, there is no trade.`);
      notes.push('Do not enter early at the level itself — the break of the rejection candle is the confirmation. The stop sits beyond the sweep wick; never widen it.');
    } else {
      notes.push(`Plan B — break-and-hold at ${lv.label || lv.type || 'a key level'} ${dots}: a strong BODY close broke the level and the retest just HELD with a rejection candle. Enter the continuation now at ${px(entry, symbol)}; invalid if price closes strongly back ${buy ? 'below' : 'above'} the level.`);
    }
    notes.push('This level was chosen from the key liquidity map (strength ≥4 dots). A level already swept bars ago is dead — this alert is only valid while fresh; skip it if you see it late.');
  }

  // Don't-chase, measured against the live price when available.
  const distPips = Number.isFinite(price) ? pips(price, entry) : null;
  if (distPips != null) {
    const atZone = distPips <= Math.max(2, Math.round((riskPips || 10) * 0.3));
    notes.push(atZone
      ? `Price is right at the entry (${distPips} pips away) — you can take it now.`
      : `Don't chase: entry is ${px(entry, symbol)}, price is ${distPips} pips away. Wait for it to pull back; if it runs off without you, skip and wait for the next setup.`);
  } else {
    notes.push(`Don't chase: get in near ${px(entry, symbol)}. If price already ran far past it, skip and wait for the next setup.`);
  }

  if (stageNote) notes.unshift(stageNote);
  return notes.slice(0, 6);
}

// High-score Strategy Lab signal → live popup (SSE) + optional email. Gated by score
// so the every-timeframe scan doesn't flood; signals are already deduped per breaker.
// `kind` (NEW / IMPROVED / RE-ENTRY / CONFIRMED) is set by the notification lifecycle so
// the same setup isn't spammed — it only re-sends on genuine improvement or at candle close.
const STRATEGY_NOTIFY_KIND_LABEL = { NEW: '', IMPROVED: 'UPDATE · ', 'RE-ENTRY': 'RE-ENTRY · ', CONFIRMED: 'CONFIRMED · ' };

// Bangladesh-time (UTC+6) wall-clock stamp, e.g. "Jun 23, 12:10 PM BD".
function bdtStamp(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  return new Date(ms + 6 * 3600 * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' BD';
}
// Timing transparency for a strategy signal across the whole pipeline:
//   candle formed (bar_time) → signal made (detected) → email sent (dispatched),
// with the two delays (candle→signal = how late the strategy surfaced it; signal→email
// = dispatch latency). All times in Bangladesh time (UTC+6).
function strategySignalTiming(sig, timeframe, madeMs = Date.now(), sentMs = Date.now()) {
  const barMs = Date.parse(sig.barIso || '');
  const tfMin = timeframeMinutes(timeframe) || 0;
  const c2sMin = Number.isFinite(barMs) ? Math.max(0, Math.round((madeMs - barMs) / 60000)) : null;
  const c2sBars = (c2sMin != null && tfMin > 0) ? Math.round((c2sMin / tfMin) * 10) / 10 : null;
  const s2eSec = Number.isFinite(madeMs) && Number.isFinite(sentMs) ? Math.max(0, Math.round((sentMs - madeMs) / 1000)) : null;
  return {
    formed: bdtStamp(barMs), made: bdtStamp(madeMs), sent: bdtStamp(sentMs), barMs,
    candleToSignal: c2sMin == null ? 'n/a' : `${c2sMin} min${c2sBars != null ? ` (~${c2sBars} ${timeframe} candle${c2sBars === 1 ? '' : 's'})` : ''}`,
    signalToEmail: s2eSec == null ? 'n/a' : (s2eSec < 60 ? `${s2eSec}s` : `${Math.round(s2eSec / 60)} min`),
  };
}
// ── Gold Desk (xau-session-raid) dedicated email ─────────────────────────────
// Purpose-designed layout for the gold engine: subject `GOLD | <score> <grade> SETUP |
// <direction>`, an ENTER NOW / WAIT (pips-to-entry) action box, the full trade plan
// (entry/SL/TP1-3 with pips + $ at the suggested lots), the raid PSYCHOLOGY (which obvious
// level was swept, displacement, session narrative), and a numbered execution playbook.
// Display-only: changes nothing about scoring, gating, or delivery rules.
function buildGoldDeskEmail({ sig, symbol, timeframe, kind, sizing, lots, timing }) {
  const m = sig.meta || {};
  const buy = /BUY/.test(String(sig.decision));
  const pip = pipSizeForSymbol(symbol) || 0.1;
  const pips = (a, b) => (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Math.round((Math.abs(Number(a) - Number(b)) / pip) * 10) / 10 : null);
  const usd = (p) => (p != null ? `$${(p * pip).toFixed(2)}` : null); // gold: pips → dollars-of-price

  // Live entry timing: at entry now, or how many pips away.
  let live = NaN;
  try { const c = getRecentCandles(symbol, timeframe, 2); if (c && c.length) live = Number(c[c.length - 1].close); } catch { /* best effort */ }
  const t = strategyLabLiveTiming(symbol, sig.decision, live, sig.entry, sig.stopLoss);
  const distPips = Number.isFinite(live) ? pips(live, sig.entry) : null;
  const action = t.status === 'TRADABLE'
    ? { label: 'ENTER NOW', detail: `Market is at the entry (${px(sig.entry, symbol)}). Execute at market with the stop already set.`, color: '#047857' }
    : t.status === 'EXPIRED'
      ? { label: 'SKIP', detail: 'Price already touched the stop side — this raid is gone. The next scan brings the next setup. Never revenge-chase gold.', color: '#b91c1c' }
      : { label: `WAIT — ${distPips != null ? `${distPips} pips (${usd(distPips)})` : 'pullback'} to entry`, detail: `Place a LIMIT ${sig.decision} at ${px(sig.entry, symbol)}. If price runs away without tagging it, let it go — chasing gold is how raids claim their second victim.`, color: '#b45309' };

  const raided = m.raidedLevel || {};
  const sessionLabel = m.session === 'OVERLAP' ? 'London–NY overlap (gold\'s prime window)' : m.session === 'LONDON' ? 'London session' : m.session === 'NY' ? 'New York session' : 'Active session';
  const htfLine = (buy && m.h4Trend === 'BULLISH') || (!buy && m.h4Trend === 'BEARISH')
    ? `H4 trend aligned (${m.h4Trend})` : 'H4 neutral — raid quality carries the setup';
  const slPips = sizing?.stopPips ?? pips(sig.entry, sig.stopLoss);
  const tp1Pips = pips(sig.takeProfit1, sig.entry), tp2Pips = pips(sig.takeProfit2, sig.entry), tp3Pips = pips(sig.takeProfit3, sig.entry);

  const kindTag = kind && kind !== 'NEW' ? ` · ${kind}` : '';
  const subjectAction = t.status === 'TRADABLE' ? 'ENTER NOW' : t.status === 'EXPIRED' ? 'SKIP' : 'WAIT FOR PB';
  const subject = `GOLD | ${Math.round(sig.score)} ${sig.grade} SETUP | ${sig.decision} ${timeframe} | ${subjectAction}${kindTag}`.slice(0, 180);

  const psychology = [
    `The raid: gold is the retail magnet — stops cluster at OBVIOUS levels. ${raided.label || raided.type || 'A key level'} (${raided.strength ?? '?'}/5 obviousness) was swept, trapping breakout traders, then price closed back inside. That trap is the trade.`,
    `The footprint: displacement of ${m.dispAtr ?? '?'}×ATR after the reclaim printed a fair value gap — institutional sponsorship, not drift. Entry is the ${m.entryMode || 'reclaim'}.`,
    `The clock: ${sessionLabel}. Asia accumulates, London manipulates, New York distributes — this raid fired in the distribution window.`,
    `The bias: ${htfLine}.`,
  ];
  const playbook = [
    t.status === 'TRADABLE' ? `Enter ${sig.decision} at market (~${px(live, symbol)}).` : `Set a LIMIT ${sig.decision} @ ${px(sig.entry, symbol)}${distPips != null ? ` — ${distPips} pips away` : ''}. Cancel if the stop side is touched first.`,
    `Hard stop ${px(sig.stopLoss, symbol)} (${slPips} pips${sizing?.lossAtStop != null ? ` = max loss ${px2(sizing.lossAtStop)}` : ''}). Never widen a gold stop — the wick you fear is the raid you just traded.`,
    `TP1 ${px(sig.takeProfit1, symbol)} (+${tp1Pips} pips, 1R): close 50% and move the stop to breakeven — the trade is now free.`,
    `TP2 ${px(sig.takeProfit2, symbol)} (+${tp2Pips} pips, 2R): close another 25%.`,
    `TP3 ${px(sig.takeProfit3, symbol)} (+${tp3Pips} pips — the opposing liquidity draw): let the runner work. No re-entry after TP3.`,
    lots != null ? `Size: ${lots} lots = ${sizing.riskPercent}% risk (${px2(sizing.riskAmount)}) on ${px2(sizing.equity)} equity.` : 'Size to a fixed % risk of equity on the shown stop.',
  ];

  const text = [
    `AURA GOLD DESK — XAU SESSION RAID${kindTag}`,
    `${sig.decision} ${symbol} ${timeframe} | score ${Math.round(sig.score)}/100 (${sig.grade}) | RR 1:${sig.riskRewardRatio ?? 'n/a'}`,
    '',
    `>> ${action.label}`,
    `   ${action.detail}`,
    '',
    'TRADE PLAN',
    `  Entry ${px(sig.entry, symbol)}   SL ${px(sig.stopLoss, symbol)} (${slPips}p)`,
    `  TP1 ${px(sig.takeProfit1, symbol)} (+${tp1Pips}p · 1R)   TP2 ${px(sig.takeProfit2, symbol)} (+${tp2Pips}p · 2R)   TP3 ${px(sig.takeProfit3, symbol)} (+${tp3Pips}p · draw)`,
    lots != null ? `  Volume ${lots} lots (${sizing.riskPercent}% risk = ${px2(sizing.riskAmount)}, max loss ${px2(sizing.lossAtStop)})` : '',
    '',
    'WHY THIS TRADE (the psychology)',
    ...psychology.map((p) => `  • ${p}`),
    '',
    'EXECUTION PLAYBOOK',
    ...playbook.map((p, i) => `  ${i + 1}. ${p}`),
    '',
    `Candle formed ${timing.formed} · signal ${timing.made} (${timing.candleToSignal}) · emailed ${timing.sent} (${timing.signalToEmail})`,
    'Gold Desk — dedicated XAUUSD forex engine. Isolated lab signal. Advisory — not financial advice.',
  ].filter(Boolean).join('\n');

  const dirColor = buy ? '#047857' : '#b91c1c';
  const row = (k, v) => `<tr><td style="padding:3px 12px 3px 0;color:#78716c;white-space:nowrap">${k}</td><td style="font-weight:700;color:#1c1917">${v}</td></tr>`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:640px;border:1px solid #e7e5e4;border-radius:10px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#1c1917,#292524);padding:14px 18px">
      <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:.18em;color:#f59e0b;text-transform:uppercase">Aura Gold Desk · XAU Session Raid${kindTag}</p>
      <h2 style="margin:6px 0 0;color:#fff;font-size:22px">${sig.decision} ${symbol} <span style="color:#a8a29e;font-size:14px">${timeframe}</span>
        <span style="float:right;background:#f59e0b;color:#1c1917;border-radius:6px;padding:2px 10px;font-size:14px">${Math.round(sig.score)} · ${sig.grade}</span></h2>
    </div>
    <div style="padding:14px 18px">
      <div style="padding:10px 12px;border-left:4px solid ${action.color};background:#fafaf9;border-radius:4px;margin-bottom:12px">
        <p style="margin:0;font-size:15px;font-weight:800;color:${action.color}">▶ ${action.label}</p>
        <p style="margin:4px 0 0;font-size:12px;color:#44403c">${action.detail}</p>
      </div>
      <table style="font-size:13px;border-collapse:collapse;width:100%">
        ${row('Entry', `${px(sig.entry, symbol)} <span style="color:#a8a29e">(${m.entryMode || 'raid entry'})</span>`)}
        ${row('Stop loss', `<span style="color:#b91c1c">${px(sig.stopLoss, symbol)}</span> <span style="color:#a8a29e">${slPips} pips${sizing?.lossAtStop != null ? ` · max loss ${px2(sizing.lossAtStop)}` : ''}</span>`)}
        ${row('TP1 · 1R', `<span style="color:#047857">${px(sig.takeProfit1, symbol)}</span> <span style="color:#a8a29e">+${tp1Pips} pips${sizing?.profitAtTp1 != null ? ` · ${px2(sizing.profitAtTp1)}` : ''} — close 50%, SL → breakeven</span>`)}
        ${row('TP2 · 2R', `<span style="color:#047857">${px(sig.takeProfit2, symbol)}</span> <span style="color:#a8a29e">+${tp2Pips} pips${sizing?.profitAtTp2 != null ? ` · ${px2(sizing.profitAtTp2)}` : ''} — close 25%</span>`)}
        ${row('TP3 · draw', `<span style="color:#047857">${px(sig.takeProfit3, symbol)}</span> <span style="color:#a8a29e">+${tp3Pips} pips${sizing?.profitAtTp3 != null ? ` · ${px2(sizing.profitAtTp3)}` : ''} — runner to the opposing liquidity</span>`)}
        ${row('R : R', `1 : ${sig.riskRewardRatio ?? 'n/a'}`)}
        ${lots != null ? row('Volume', `${lots} lots <span style="color:#a8a29e">(${sizing.riskPercent}% risk = ${px2(sizing.riskAmount)} on ${px2(sizing.equity)})</span>`) : ''}
      </table>
      <div style="margin-top:12px;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px">
        <p style="margin:0 0 6px;font-size:10px;font-weight:800;letter-spacing:.14em;color:#b45309;text-transform:uppercase">Why this trade — the psychology</p>
        <ul style="margin:0;padding-left:16px;font-size:12px;color:#44403c">${psychology.map((p) => `<li style="margin:3px 0">${p}</li>`).join('')}</ul>
      </div>
      <div style="margin-top:10px;padding:10px 12px;background:#fafaf9;border:1px solid #e7e5e4;border-radius:6px">
        <p style="margin:0 0 6px;font-size:10px;font-weight:800;letter-spacing:.14em;color:#57534e;text-transform:uppercase">Execution playbook</p>
        <ol style="margin:0;padding-left:18px;font-size:12px;color:#44403c">${playbook.map((p) => `<li style="margin:3px 0">${p}</li>`).join('')}</ol>
      </div>
      <p style="font-size:11px;color:#a8a29e;margin:10px 0 0">Candle formed ${timing.formed} · signal ${timing.made} <b>(${timing.candleToSignal})</b> · emailed ${timing.sent} <b>(${timing.signalToEmail})</b><br/>Gold Desk — dedicated XAUUSD forex engine · isolated lab signal · advisory, not financial advice.</p>
    </div></div>`;
  return { subject, text, html };
}

async function emitStrategyLabSignal({ id, strategy, symbol, timeframe, sig, popup = true, email = false, kind = 'NEW', madeMs = Date.now() }) {  const sizing = strategyLabSizing(symbol, sig.entry, sig.stopLoss, { tp1: sig.takeProfit1, tp2: sig.takeProfit2, tp3: sig.takeProfit3 });
  const lots = sizing?.suggestedLots ?? null;
  const strategyName = STRATEGY_LAB_REGISTRY[strategy]?.name || strategy;
  const at = new Date().toISOString();
  if (popup) {
    sendStreamEvent('strategy_signal', {
      id, strategy, strategyName, symbol, timeframe, direction: sig.decision,
      score: sig.score ?? null, grade: sig.grade ?? null,
      entry: sig.entry ?? null, stopLoss: sig.stopLoss ?? null,
      takeProfit1: sig.takeProfit1 ?? null, takeProfit2: sig.takeProfit2 ?? null, takeProfit3: sig.takeProfit3 ?? null,
      lots, stopPips: sizing?.stopPips ?? null,
      riskReward: sig.riskRewardRatio ?? null, reason: sig.reason || null, kind, at,
    });
  }
  if (!email || !SIGNAL_ALERTS_ENABLED || !signalEmailTo()) return;
  // Per-recipient symbol/timeframe routing — only the recipients who asked for this
  // symbol+TF receive it; nobody matching = skip the send entirely.
  const labTo = signalEmailToFor(symbol, timeframe);
  if (!labTo) return;
  const timing = strategySignalTiming(sig, timeframe, madeMs, Date.now());
  // Gold Desk gets its purpose-designed email (GOLD | score grade SETUP | direction).
  if (strategy === 'xau-session-raid') {
    const g = buildGoldDeskEmail({ sig, symbol, timeframe, kind, sizing, lots, timing });
    try {
      await sendNotificationEmail({ to: labTo, subject: g.subject, text: g.text, html: g.html, signalId: `stratlab:${id}` });
      console.log(`[GoldDesk] Emailed ${sig.grade} ${sig.decision} ${symbol} ${timeframe} (score ${Math.round(sig.score)})`);
    } catch (e) { console.error('[GoldDesk] email failed:', e.message); }
    return;
  }
  const advisory = strategyForexAdvisory(symbol, timeframe, sig);
  // Lab forex subject (user format): Symbol | Direction | Score + Setup + RR |
  // Strategy Name | ENTER NOW / WAIT FOR PB / SKIP — the action judged from the
  // LIVE price vs the entry at send time (TRADABLE→ENTER NOW, WAIT→pullback pending,
  // EXPIRED→stop side already touched). LIL SWEEP-PRO+ shows its plan next to the name.
  let liveNow = NaN;
  try { const c = getRecentCandles(symbol, timeframe, 2); if (c && c.length) liveNow = Number(c[c.length - 1].close); } catch { /* best effort */ }
  const liveT = strategyLabLiveTiming(symbol, sig.decision, liveNow, sig.entry, sig.stopLoss, sig.meta || null);
  const actionTag = liveT.status === 'TRADABLE' ? 'ENTER NOW' : liveT.status === 'EXPIRED' ? 'SKIP' : 'WAIT FOR PB';
  const stratTag = strategy === 'lil-sweep-pro-plus' && sig.meta?.plan ? `${strategyName} ${sig.meta.plan}` : strategyName;
  const subject = `${symbol} ${timeframe} | ${sig.decision} | ${Math.round(sig.score)} ${sig.grade || ''} SETUP · RR 1:${sig.riskRewardRatio ?? 'n/a'} | ${stratTag} | ${actionTag}${kind && kind !== 'NEW' ? ` · ${kind}` : ''}`.slice(0, 180);
  const lotLine = lots !== null ? `Volume ${lots} lots (${sizing.riskPercent}% of ${px2(sizing.equity)} = ${px2(sizing.riskAmount)} risk, ${sizing.stopPips} pip stop)` : 'Volume n/a';
  const text = [
    `AURA GOLD — STRATEGY LAB SIGNAL (${strategyName})${kind !== 'NEW' ? ` — ${kind}` : ''}`,
    `${sig.decision} ${symbol} ${timeframe} | score ${Math.round(sig.score)}/100 (${sig.grade}) | RR 1:${sig.riskRewardRatio ?? 'n/a'}`,
    `>> ACTION: ${advisory}`,
    `Entry ${px(sig.entry, symbol)}   SL ${px(sig.stopLoss, symbol)}`,
    `TP1 ${px(sig.takeProfit1, symbol)} (1R)   TP2 ${px(sig.takeProfit2, symbol)} (2R)   TP3 ${px(sig.takeProfit3, symbol)} (target)`,
    lotLine,
    `Candle formed: ${timing.formed} (${timeframe})`,
    `Signal made:   ${timing.made}   [candle→signal ${timing.candleToSignal}]`,
    `Email sent:    ${timing.sent}   [signal→email ${timing.signalToEmail}]`,
    `Why: ${sig.reason || ''}`,
    '',
    'Trader notes (advisory):',
    ...strategyAdvisoryNotes(strategy, sig, { symbol, timeframe }).map((nNote) => `• ${nNote}`),
    'Isolated strategy-lab signal (not the main system). Advisory — not financial advice.',
  ].join('\n');
  const dirColor = /BUY/.test(sig.decision) ? '#047857' : '#b91c1c';
  const html = `<div style="font-family:Arial,sans-serif;max-width:640px">
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.12em;color:#7c3aed;text-transform:uppercase">Strategy Lab · ${strategyName}</p>
    <h2 style="margin:0 0 4px;color:${dirColor}">${sig.decision} ${symbol} <span style="font-size:13px;color:#64748b">${timeframe} · score ${Math.round(sig.score)} (${sig.grade})</span></h2>
    <p style="margin:6px 0;padding:8px 10px;background:#f1f5f9;border-left:3px solid ${dirColor};border-radius:4px;font-size:13px;font-weight:600;color:#0f172a">▶ ${advisory}</p>
    <table style="font-size:13px;border-collapse:collapse">
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Entry</td><td><b>${px(sig.entry, symbol)}</b></td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Stop loss</td><td style="color:#b91c1c">${px(sig.stopLoss, symbol)} <span style="color:#94a3b8">(${sizing?.stopPips ?? '?'} pips)</span></td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">TP1 (1R)</td><td style="color:#047857">${px(sig.takeProfit1, symbol)}${sizing?.profitAtTp1 != null ? ` <span style="color:#94a3b8">+${px2(sizing.profitAtTp1)}</span>` : ''}</td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">TP2 (2R)</td><td style="color:#047857">${px(sig.takeProfit2, symbol)}${sizing?.profitAtTp2 != null ? ` <span style="color:#94a3b8">+${px2(sizing.profitAtTp2)}</span>` : ''}</td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">TP3 (target)</td><td style="color:#047857">${px(sig.takeProfit3, symbol)}${sizing?.profitAtTp3 != null ? ` <span style="color:#94a3b8">+${px2(sizing.profitAtTp3)}</span>` : ''}</td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Volume</td><td><b>${lots !== null ? `${lots} lots` : 'n/a'}</b>${lots !== null ? ` <span style="color:#94a3b8">(${sizing.riskPercent}% risk = ${px2(sizing.riskAmount)}, max loss ${px2(sizing.lossAtStop)})</span>` : ''}</td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">R:R</td><td>1:${sig.riskRewardRatio ?? 'n/a'}</td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Candle formed</td><td><b>${timing.formed}</b> <span style="color:#94a3b8">(${timeframe})</span></td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Signal made</td><td>${timing.made} <span style="color:#94a3b8">· candle→signal ${timing.candleToSignal}</span></td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Email sent</td><td>${timing.sent} <span style="color:#94a3b8">· signal→email ${timing.signalToEmail}</span></td></tr>
    </table>
    <p style="font-size:12px;color:#475569;margin:6px 0 0">${sig.reason || ''}</p>
    <div style="margin:8px 0 0;padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px">
      <p style="margin:0 0 4px;font-size:10px;font-weight:700;letter-spacing:.1em;color:#64748b;text-transform:uppercase">Trader notes (advisory)</p>
      <ul style="margin:0;padding-left:16px;font-size:12px;color:#475569">${strategyAdvisoryNotes(strategy, sig, { symbol, timeframe }).map((nNote) => `<li style="margin:2px 0">${nNote}</li>`).join('')}</ul>
    </div>
    <p style="font-size:11px;color:#94a3b8;margin-top:8px">Volume sized at ${sizing?.riskPercent ?? '?'}% risk on ${px2(sizing?.equity || 0)} equity, scaled to the ${timeframe} stop. Isolated strategy-lab signal — not the main system. Advisory only. — Aura Gold Strategy Lab</p></div>`;
  try {
    await sendNotificationEmail({ to: labTo, subject, text, html, signalId: `stratlab:${id}` });
    console.log(`[StrategyLab] Emailed ${sig.grade} ${sig.decision} ${symbol} ${timeframe} (${strategyName}, score ${Math.round(sig.score)})`);
  } catch (e) { console.error('[StrategyLab] email failed:', e.message); }
}

// Fixed-time expiry framing for a strategy signal. The strategy's fixed-time outcome
// (resolveStrategyFixedTime) is judged at the close STRATEGY_LAB_FT_EXPIRY_BARS candles
// after the signal bar. For a signal that just formed on the last closed bar, that expiry
// is the close of the current forming bar (+ any extra expiry bars). Returns the expiry
// timestamp + seconds remaining so the UI/email can frame it as a fixed-time trade.
// Human duration for a trade-time in minutes: "5 min", "1 hr 30 min", "1 day".
function formatTradeMinutes(min) {
  if (!(min > 0)) return '—';
  if (min < 60) return `${min} min`;
  if (min < 1440) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h} hr ${m} min` : `${h} hr`; }
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60);
  return h ? `${d} day ${h} hr` : `${d} day`;
}

function strategyLabFttExpiry(timeframe) {
  const tfMin = timeframeMinutes(timeframe);
  if (!(tfMin > 0)) return null;
  const tfMs = tfMin * 60000;
  const now = Date.now();
  const nextBoundary = Math.ceil(now / tfMs) * tfMs;                 // current forming bar closes here
  const expiryMs = nextBoundary + (STRATEGY_LAB_FT_EXPIRY_BARS - 1) * tfMs;
  // The DURATION to set on a fixed-time/binary platform = one timeframe period × expiry bars.
  // (A call is judged at the candle close, so entering at the candle OPEN and setting this
  // duration lines the expiry up with the close. Entering mid-bar → set secondsToExpiry instead.)
  const tradeMinutes = tfMin * STRATEGY_LAB_FT_EXPIRY_BARS;
  const tradeTimeLabel = formatTradeMinutes(tradeMinutes);
  return {
    expiryIso: new Date(expiryMs).toISOString(),
    secondsToExpiry: Math.max(0, Math.round((expiryMs - now) / 1000)),
    expiryBars: STRATEGY_LAB_FT_EXPIRY_BARS,
    tradeMinutes,
    tradeTimeLabel,
    durationLabel: STRATEGY_LAB_FT_EXPIRY_BARS === 1
      ? `${tradeTimeLabel} expiry (next ${timeframe} close)`
      : `${STRATEGY_LAB_FT_EXPIRY_BARS} × ${timeframe} = ${tradeTimeLabel}`,
  };
}

// Candle-pattern read for a FIXED-TIME entry, right now. A fixed-time trade is entered at
// market and judged at the very next candle close, so what matters is the immediate price
// action — not a limit level. We read the last ~5 closed candles + the most recent one and
// ask: is the recent momentum + the latest candle confirming the call's direction, is price
// stretched to a local extreme (likely to snap back), or is it reversing / indecisive against
// the call? Returns a verdict the trader can act on without re-reading the chart:
//   ENTER_NOW     — recent action confirms the call direction and price isn't over-extended.
//   WAIT_PULLBACK — direction agrees but price is at a local high/low or the bar is indecisive.
//   NO_ENTRY      — the latest action contradicts the call (reversal/drive against it).
function fixedTimeCandleRead(candles, ftDir, lookback = 5) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  const up = String(ftDir).toUpperCase() === 'UP';
  const recent = candles.slice(-lookback);
  const last = candles[candles.length - 1];
  const o = Number(last.open), c = Number(last.close), hi = Number(last.high), lo = Number(last.low);
  const range = Math.max(hi - lo, 1e-9);
  const body = Math.abs(c - o);
  const upperWick = hi - Math.max(c, o);
  const lowerWick = Math.min(c, o) - lo;

  // Momentum/trend over the lookback: how many of the last N candles closed up vs down.
  let bull = 0, bear = 0;
  for (const k of recent) { const kc = Number(k.close), ko = Number(k.open); if (kc > ko) bull += 1; else if (kc < ko) bear += 1; }
  const momentum = bull > bear ? 'UP' : bear > bull ? 'DOWN' : 'MIXED';

  // Most-recent candle pattern (the decisive bar for a next-candle bet).
  const doji = body <= range * 0.18;                       // indecision — no conviction either way
  const bullPin = !doji && lowerWick >= body * 1.5 && c >= o; // long lower wick → rejection of lows
  const bearPin = !doji && upperWick >= body * 1.5 && c <= o; // long upper wick → rejection of highs
  const driveUp = !doji && c > o && body >= range * 0.6;   // strong bullish body
  const driveDown = !doji && c < o && body >= range * 0.6; // strong bearish body
  const pattern = doji ? 'indecision' : bullPin ? 'reversal-up' : bearPin ? 'reversal-down'
    : driveUp ? 'drive-up' : driveDown ? 'drive-down' : 'neutral';

  // Local extreme over the lookback — is the latest bar making/at the highest high or lowest low?
  const maxH = Math.max(...recent.map((k) => Number(k.high)));
  const minL = Math.min(...recent.map((k) => Number(k.low)));
  const atHigh = hi >= maxH - range * 0.1;
  const atLow = lo <= minL + range * 0.1;
  const atExtreme = atHigh && !atLow ? 'HIGH' : atLow && !atHigh ? 'LOW' : null;

  const confirms = up ? (momentum === 'UP' || pattern === 'reversal-up' || pattern === 'drive-up')
                      : (momentum === 'DOWN' || pattern === 'reversal-down' || pattern === 'drive-down');
  const contradicts = up ? (pattern === 'reversal-down' || pattern === 'drive-down')
                         : (pattern === 'reversal-up' || pattern === 'drive-up');
  const overExtended = up ? atHigh : atLow;   // call wants to continue but price is already at the extreme

  let verdict;
  if (pattern === 'indecision') verdict = 'WAIT_PULLBACK';
  else if (contradicts) verdict = 'NO_ENTRY';
  else if (confirms && overExtended) verdict = 'WAIT_PULLBACK';
  else if (confirms) verdict = 'ENTER_NOW';
  else verdict = 'WAIT_PULLBACK';

  const bits = [`${up ? bull : bear}/${lookback} ${up ? 'up' : 'down'}`];
  if (pattern !== 'neutral') bits.push(pattern.replace('-', ' '));
  if (atExtreme) bits.push(`at ${lookback}-bar ${atExtreme.toLowerCase()}`);
  return { verdict, momentum, pattern, atExtreme, note: bits.join(' · ') };
}

// Fixed-time framing of a Strategy Lab signal → dedicated live popup (SSE event
// strategy_ftt_signal) + optional fixed-time email. UP = BUY, DOWN = SELL; the call is
// simply "will price be higher/lower than the reference at the next-candle expiry?" — the
// same direction the strategy's fixed-time win rate is measured on. Isolated lab, never
// the main FTT engine.
async function emitStrategyLabFttSignal({ id, strategy, symbol, timeframe, sig, refClose = null, popup = true, email = false, kind = 'NEW', madeMs = Date.now() }) {
  if (!symbolAllowsFixedTime(symbol)) return;            // e.g. USTEC: fixed-time disabled
  const strategyName = STRATEGY_LAB_REGISTRY[strategy]?.name || strategy;
  const ftDir = /BUY/.test(String(sig.decision)) ? 'UP' : 'DOWN';
  const expiry = strategyLabFttExpiry(timeframe);
  const reference = Number.isFinite(Number(refClose)) ? Number(refClose) : (sig.entry ?? null);
  const at = new Date().toISOString();
  if (popup) {
    sendStreamEvent('strategy_ftt_signal', {
      id, strategy, strategyName, symbol, timeframe, direction: ftDir,
      score: sig.score ?? null, grade: sig.grade ?? null,
      reference, expiryIso: expiry?.expiryIso ?? null, secondsToExpiry: expiry?.secondsToExpiry ?? null,
      tradeMinutes: expiry?.tradeMinutes ?? null, tradeTimeLabel: expiry?.tradeTimeLabel ?? null,
      durationLabel: expiry?.durationLabel ?? null, reason: sig.reason || null, kind, at,
    });
  }
  if (!email || !SIGNAL_ALERTS_ENABLED || !signalEmailTo()) return;
  const fttLabTo = signalEmailToFor(symbol, timeframe);
  if (!fttLabTo) return;
  const expiryUtc = expiry?.expiryIso
    ? new Date(expiry.expiryIso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
    : 'next candle';
  const subject = `[FIXED-TIME ${STRATEGY_NOTIFY_KIND_LABEL[kind] || ''}${sig.grade || ''}] ${strategyName}: ${ftDir} ${symbol} ${timeframe} (score ${Math.round(sig.score)})`.slice(0, 180);
  const timing = strategySignalTiming(sig, timeframe, madeMs, Date.now());
  const ftSecs = expiry?.secondsToExpiry ?? null;
  const ftAdvisory = (ftSecs != null && ftSecs < 30)
    ? `Expires in ~${ftSecs}s — too late to enter safely; skip and wait for the next call.`
    : `TAKE THE ${ftDir} NOW — enter before the candle closes (~${expiryUtc}). One-shot bet to expiry, no SL/TP to manage.`;
  const text = [
    `AURA GOLD — STRATEGY LAB FIXED-TIME SIGNAL (${strategyName})`,
    `Predict ${ftDir} on ${symbol} ${timeframe} | score ${Math.round(sig.score)}/100 (${sig.grade})`,
    `>> ACTION: ${ftAdvisory}`,
    `Reference price ${reference != null ? px(reference, symbol) : 'market'}`,
    `Expiry: ${expiry?.durationLabel || 'next candle'} — closes ~${expiryUtc}`,
    `Call: price ${ftDir === 'UP' ? 'HIGHER' : 'LOWER'} than the reference at expiry.`,
    `Candle formed: ${timing.formed} (${timeframe})`,
    `Signal made:   ${timing.made}   [candle→signal ${timing.candleToSignal}]`,
    `Email sent:    ${timing.sent}   [signal→email ${timing.signalToEmail}]`,
    `Why: ${sig.reason || ''}`,
    '',
    'Trader notes (advisory):',
    ...strategyAdvisoryNotes(strategy, sig, { symbol, timeframe, fixedTime: true }).map((nNote) => `• ${nNote}`),
    'Isolated strategy-lab fixed-time signal (not the main system / not the FTT engine). Advisory — not financial advice.',
  ].join('\n');
  const dirColor = ftDir === 'UP' ? '#047857' : '#b91c1c';
  const html = `<div style="font-family:Arial,sans-serif;max-width:640px">
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.12em;color:#7c3aed;text-transform:uppercase">Strategy Lab · Fixed-Time · ${strategyName}</p>
    <h2 style="margin:0 0 4px;color:${dirColor}">${ftDir} ${symbol} <span style="font-size:13px;color:#64748b">${timeframe} · score ${Math.round(sig.score)} (${sig.grade})</span></h2>
    <p style="margin:6px 0;padding:8px 10px;background:#f1f5f9;border-left:3px solid ${dirColor};border-radius:4px;font-size:13px;font-weight:600;color:#0f172a">▶ ${ftAdvisory}</p>
    <table style="font-size:13px;border-collapse:collapse">
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Direction</td><td style="color:${dirColor}"><b>${ftDir}</b> — price ${ftDir === 'UP' ? 'higher' : 'lower'} at expiry</td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Reference</td><td><b>${reference != null ? px(reference, symbol) : 'market'}</b></td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Expiry</td><td>${expiry?.durationLabel || 'next candle'} <span style="color:#94a3b8">(closes ~${expiryUtc})</span></td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Score</td><td>${Math.round(sig.score)}/100 (${sig.grade})</td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Candle formed</td><td><b>${timing.formed}</b> <span style="color:#94a3b8">(${timeframe})</span></td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Signal made</td><td>${timing.made} <span style="color:#94a3b8">· candle→signal ${timing.candleToSignal}</span></td></tr>
      <tr><td style="padding:2px 10px 2px 0;color:#64748b">Email sent</td><td>${timing.sent} <span style="color:#94a3b8">· signal→email ${timing.signalToEmail}</span></td></tr>
    </table>
    <p style="font-size:12px;color:#475569;margin:6px 0 0">${sig.reason || ''}</p>
    <div style="margin:8px 0 0;padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px">
      <p style="margin:0 0 4px;font-size:10px;font-weight:700;letter-spacing:.1em;color:#64748b;text-transform:uppercase">Trader notes (advisory)</p>
      <ul style="margin:0;padding-left:16px;font-size:12px;color:#475569">${strategyAdvisoryNotes(strategy, sig, { symbol, timeframe, fixedTime: true }).map((nNote) => `<li style="margin:2px 0">${nNote}</li>`).join('')}</ul>
    </div>
    <p style="font-size:11px;color:#94a3b8;margin-top:8px">Fixed-time call (direction at next-candle expiry). Isolated strategy-lab signal — not the main system or FTT engine. Advisory only. — Aura Gold Strategy Lab</p></div>`;
  try {
    await sendNotificationEmail({ to: fttLabTo, subject, text, html, signalId: `stratlabftt:${id}` });
    console.log(`[StrategyLab] Emailed FIXED-TIME ${sig.grade} ${ftDir} ${symbol} ${timeframe} (${strategyName}, score ${Math.round(sig.score)})`);
  } catch (e) { console.error('[StrategyLab] FTT email failed:', e.message); }
}

// Next-higher timeframe in the lab ladder — used for multi-timeframe stage agreement.
const NEXT_HIGHER_TF = { M1: 'M5', M5: 'M15', M15: 'M30', M30: 'H1', H1: 'H4', H4: 'D1', D1: null };
// One step DOWN — for strategies that confirm a main-TF setup against lower-TF timing
// (e.g. swing-structure-candles: M15 setup confirmed on M5). M1 is intentionally not a
// confirmation source on its own (too noisy); M5 maps to M1 only as a last resort.
const NEXT_LOWER_TF = { D1: 'H4', H4: 'H1', H1: 'M30', M30: 'M15', M15: 'M5', M5: 'M1', M1: null };

// Drop the trailing bar when its timeframe window is still OPEN — the store carries
// the in-progress bar (partial OHLC that repaints until close), and engines that read
// it as a closed candle can print sweeps/BOS/FVGs that vanish at the close. Lab
// engines must reason over CLOSED bars only; the context explicitly records that contract.
// (Main live scanner is deliberately untouched — its timing is the working setup.)
function closedBarsOnly(list, tf) {
  if (!Array.isArray(list) || !list.length) return list;
  const tfMs = Math.max(1, timeframeMinutes(tf)) * 60000;
  const openMs = Date.parse(list[list.length - 1].time);
  return Number.isFinite(openMs) && Date.now() < openMs + tfMs ? list.slice(0, -1) : list;
}

function buildStrategyContext(symbol, tf) {
  const candles = closedBarsOnly(getRecentCandles(symbol, tf, 400), tf);
  if (!candles || candles.length < 60) return null;
  const htfTf = NEXT_HIGHER_TF[tf] || null;
  const htfCandles = htfTf ? closedBarsOnly(getRecentCandles(symbol, htfTf, 200), htfTf) : null;
  const ltfTf = NEXT_LOWER_TF[tf] || null;
  const ltfCandles = ltfTf ? closedBarsOnly(getRecentCandles(symbol, ltfTf, 200), ltfTf) : null;
  const dailyCandles = getRecentCandles(symbol, 'D1', 8); // keep the forming D1 — it IS "today" (PDH/PDL use [-2])
  return {
    symbol, timeframe: tf, candles, candlesIncludeFormingBar: false, pip: pipSizeForSymbol(symbol),
    h4Trend: getTimeframeTrend(closedBarsOnly(getRecentCandles(symbol, 'H4', 150), 'H4')),
    h1Trend: getTimeframeTrend(closedBarsOnly(getRecentCandles(symbol, 'H1', 150), 'H1')),
    dailyCandles,
    htfTimeframe: htfTf, htfCandles,
    ltfTimeframe: ltfTf, ltfCandles,
  };
}

// ── Notification lifecycle (de-spam) ─────────────────────────────────────────
// DB logging to mt5_strategy_signals stays per-candle (win-rate stats untouched). This
// layer ONLY governs popups/emails so the same setup isn't re-sent every candle:
//   NEW       — first appearance of a setup → send immediately.
//   IMPROVED  — same setup, but score +N / grade up / RR +M vs the best already sent.
//   CONFIRMED — once, when the candle the NEW fired on closes (still-valid setup) →
//               "tradable at the score it had when it formed".
//   RE-ENTRY  — the setup disappeared for ≥1 bar then re-qualified → a fresh send.
// Continuation (same setup persisting candle-after-candle, no improvement) is suppressed.
const strategyNotifyState = new Map(); // key: strategy|symbol|tf|direction
const STRATEGY_NOTIFY_PRUNE_MS = 24 * 3600 * 1000;
const STRATEGY_NOTIFY_IMPROVE_SCORE = Math.max(1, Number(process.env.STRATEGY_LAB_IMPROVE_SCORE || 3));
const STRATEGY_NOTIFY_IMPROVE_RR = Math.max(0.05, Number(process.env.STRATEGY_LAB_IMPROVE_RR || 0.2));

function strategyNotifyKey(strategy, symbol, tf, direction, customKey = null) {
  return `${strategy}|${symbol}|${tf}|${String(direction).toUpperCase()}|${customKey || 'default'}`;
}

// Genuine improvement over the best already notified for this setup? (score / grade / RR;
// RR captures a better entry/position since it's derived from entry vs stop/target.)
function strategySignalImproved(sig, best) {
  if ((Number(sig.score) || 0) >= (Number(best.score) || 0) + STRATEGY_NOTIFY_IMPROVE_SCORE) return 'score';
  if ((STRATEGY_GRADE_RANK[String(sig.grade || '').toUpperCase()] ?? 0) > (STRATEGY_GRADE_RANK[String(best.grade || '').toUpperCase()] ?? 0)) return 'grade';
  if ((Number(sig.riskRewardRatio) || 0) >= (Number(best.rr) || 0) + STRATEGY_NOTIFY_IMPROVE_RR) return 'rr';
  return null;
}

// Decide what (if anything) to notify for a freshly-evaluated signal; updates state.
function strategyNotifyDecide(strategy, symbol, tf, sig) {
  const key = strategyNotifyKey(strategy, symbol, tf, sig.decision, sig?.meta?.notifyKey || null);
  const tfMs = Math.max(1, timeframeMinutes(tf)) * 60000;
  const barMs = Date.parse(sig?.meta?.alertBarIso || sig.barIso || '') || Date.now();
  const now = Date.now();
  const st = strategyNotifyState.get(key);
  let kind = null;
  if (!st) kind = 'NEW';
  else if (barMs > st.lastBarMs + 1.5 * tfMs) kind = 'RE-ENTRY';   // vanished ≥1 bar then back
  else kind = strategySignalImproved(sig, st.best) ? 'IMPROVED' : null;

  if (kind === 'NEW' || kind === 'RE-ENTRY') {
    const alreadyClosed = now >= barMs + tfMs;
    strategyNotifyState.set(key, {
      createdBarMs: barMs, createdBarCloseMs: barMs + tfMs, lastBarMs: barMs,
      firstScore: sig.score ?? null, firstGrade: sig.grade ?? null,
      best: { score: sig.score ?? 0, grade: sig.grade ?? null, rr: sig.riskRewardRatio ?? 0 },
      confirmedSent: alreadyClosed, skipCloseConfirm: alreadyClosed || !!sig?.meta?.skipCloseConfirm, episode: (st?.episode || 0) + 1, updatedAt: now,
      strategy, symbol, tf, direction: sig.decision,
    });
  } else if (st) {
    st.lastBarMs = Math.max(st.lastBarMs, barMs);
    if (kind === 'IMPROVED') {
      const gUp = (STRATEGY_GRADE_RANK[String(sig.grade || '').toUpperCase()] ?? 0) > (STRATEGY_GRADE_RANK[String(st.best.grade || '').toUpperCase()] ?? 0);
      st.best = {
        score: Math.max(st.best.score, sig.score ?? 0),
        grade: gUp ? sig.grade : st.best.grade,
        rr: Math.max(st.best.rr, sig.riskRewardRatio ?? 0),
      };
    }
    st.updatedAt = now;
  }
  return kind;
}

// Send the popup/email for a decided signal (respecting the existing score/email gates).
async function maybeNotifyStrategy(strategy, symbol, tf, sig, ctx, madeMs = Date.now()) {
  // Strategy Controller master gate — OFF (or refined out) = no popup/email/SSE. DB logging
  // (caller) is unaffected, so the strategy keeps being measured for the ranking.
  if (!strategyDelivers(strategy, { score: sig.score, direction: sig.decision, timeframe: tf })) return { popupSent: false, emailSent: false, kind: null };
  // Freshness gate: the caller still LOGS every evaluation (win-rate / ranking data stays
  // intact), but we never popup/email a setup built off a stale candle (weekend / feed-hold).
  // Bail BEFORE strategyNotifyDecide so the de-spam state isn't polluted — the setup then
  // fires cleanly as a NEW alert when live data resumes.
  const lastCandle = ctx?.candles?.length ? ctx.candles[ctx.candles.length - 1] : null;
  if (!isCandleCurrent(lastCandle, tf) || !liveSignalsAllowed()) {
    return { popupSent: false, emailSent: false, kind: null, stale: true };
  }
  // STALE-SETUP gate: some strategies anchor a signal to a bar that qualified several bars
  // ago (lookback re-detection). By alert time price has drifted off the planned entry
  // (measured p90 ≈ 11.6 pips) — alerting now invites a bad fill. Skip DELIVERY when the
  // setup bar closed ≥ STRATEGY_LAB_STALE_SETUP_BARS bars ago; DB logging (caller) is
  // untouched so the ranking keeps measuring every detection. Before strategyNotifyDecide
  // so the de-spam state isn't polluted (a later fresh re-detection still alerts as NEW).
  const barMs = Date.parse(sig?.meta?.alertBarIso || sig.barIso || '') || Date.now();
  const tfMsNotify = Math.max(1, timeframeMinutes(tf)) * 60000;
  // PRE-ENTRY alerts (meta.preEntryAlert, e.g. special-forex-sniper) are exempt: their anchor
  // bar is intentionally a few bars old — the setup waits for the pullback, and the engine's
  // own 6–15-pip gap gate already guarantees the alert is price-fresh when it fires.
  if (!sig?.meta?.preEntryAlert && Date.now() - (barMs + tfMsNotify) >= STRATEGY_LAB_STALE_SETUP_BARS * tfMsNotify) {
    return { popupSent: false, emailSent: false, kind: null, staleSetup: true };
  }
  const kind = strategyNotifyDecide(strategy, symbol, tf, sig);
  if (!kind) return { popupSent: false, emailSent: false, kind: null };
  const wantPopup = (sig.score ?? 0) >= STRATEGY_LAB_ALERT_MIN_SCORE;
  const wantEmail = strategyLabEmailAllowed(strategy, sig.score, sig.grade, symbol, sig.decision);
  const wantFttEmail = strategyLabFttEmailAllowed(strategy, sig.score, sig.grade, symbol, sig.decision);
  const id = `${strategy}:${symbol}:${tf}:${barMs}`;
  // Emits are fire-and-forget: the popup (SSE) is synchronous inside, and the email path
  // catches its own errors. Not awaiting means one slow SMTP round-trip can't delay the
  // NEXT symbol/strategy's alert in the same notify pass.
  if (wantPopup || wantEmail) {
    void emitStrategyLabSignal({ id, strategy, symbol, timeframe: tf, sig, popup: wantPopup, email: wantEmail, kind, madeMs });
  }
  // Fixed-time notification only when the call is still tradable (expiry candle open) —
  // never alert a next-candle bet whose candle has already closed (stale-on-arrival).
  // meta.forexOnly (e.g. lil-sweep-pro-plus trigger entries) = TP/SL framing only, no FTT alert.
  if (!sig?.meta?.forexOnly && strategyFtActionable(barMs, tf) && (wantPopup || wantFttEmail)) {
    const refClose = ctx ? Number(ctx.candles[ctx.candles.length - 1].close) : null;
    void emitStrategyLabFttSignal({ id, strategy, symbol, timeframe: tf, sig, refClose, popup: wantPopup, email: wantFttEmail, kind, madeMs });
  }
  return { popupSent: wantPopup, emailSent: wantEmail || (!sig?.meta?.forexOnly && wantFttEmail), kind };
}

// Candle-close confirmation pass: for any active setup whose creation candle has closed
// and that hasn't been confirmed, re-evaluate; if it still qualifies in the same
// direction, send ONE "CONFIRMED — tradable at the formed score" follow-up. Also prunes.
async function processStrategyNotifyConfirms() {
  const now = Date.now();
  for (const [key, st] of strategyNotifyState) {
    if (now - st.updatedAt > STRATEGY_NOTIFY_PRUNE_MS) { strategyNotifyState.delete(key); continue; }
    if (st.confirmedSent || st.skipCloseConfirm || now < st.createdBarCloseMs) continue;
    if (!strategyDelivers(st.strategy, { score: st.firstScore, direction: st.direction, timeframe: st.tf })) continue; // controller OFF
    st.confirmedSent = true; // mark once so we never nag
    try {
      const ctx = buildStrategyContext(st.symbol, st.tf);
      if (!ctx) continue;
      // Never confirm off a stale candle (feed-hold) or while the market is calendar-closed
      // (weekend). Re-arm so the confirmation can still fire once trading resumes and re-validates.
      if (!isCandleCurrent(ctx.candles[ctx.candles.length - 1], st.tf) || !liveSignalsAllowed()) { st.confirmedSent = false; continue; }
      const sig = evaluateStrategy(st.strategy, ctx);
      if (!sig || sig.decision !== st.direction) continue; // didn't hold at the close
      const wantPopup = (st.firstScore ?? 0) >= STRATEGY_LAB_ALERT_MIN_SCORE;
      const wantEmail = strategyLabEmailAllowed(st.strategy, st.firstScore, st.firstGrade, st.symbol, st.direction);
      const wantFttEmail = strategyLabFttEmailAllowed(st.strategy, st.firstScore, st.firstGrade, st.symbol, st.direction);
      if (!wantPopup && !wantEmail && !wantFttEmail) continue;
      const confirmSig = { ...sig, score: st.firstScore ?? sig.score, grade: st.firstGrade ?? sig.grade };
      const id = `${st.strategy}:${st.symbol}:${st.tf}:${st.createdBarMs}`;
      if (wantPopup || wantEmail) void emitStrategyLabSignal({ id, strategy: st.strategy, symbol: st.symbol, timeframe: st.tf, sig: confirmSig, popup: wantPopup, email: wantEmail, kind: 'CONFIRMED' });
      if (!sig?.meta?.forexOnly && strategyFtActionable(st.createdBarMs, st.tf) && (wantPopup || wantFttEmail)) { const refClose = Number(ctx.candles[ctx.candles.length - 1].close); void emitStrategyLabFttSignal({ id, strategy: st.strategy, symbol: st.symbol, timeframe: st.tf, sig: confirmSig, refClose, popup: wantPopup, email: wantFttEmail, kind: 'CONFIRMED' }); }
    } catch { /* confirm is best-effort */ }
  }
}

// Notify-only pass (NO DB logging) for given symbol|tf pairs — driven by the real-time
// candle-close trigger so a fresh setup is sent within seconds, not at the next scan tick.
async function runStrategyNotifyPass(pairs) {
  const pool = await initializeDatabase();
  for (const pair of pairs) {
    const [symbol, tf] = pair.split('|');
    if (!symbolAllowsSignalTf(symbol, tf)) continue;     // e.g. USTEC: no M1/D1 signals
    for (const stratId of Object.keys(STRATEGY_LAB_REGISTRY)) {
      if (!strategyTimeframes(stratId).includes(tf)) continue; // registry timeframes are a contract
      try {
        const ctx = buildStrategyContext(symbol, tf);
        if (!ctx) continue;
        const sig = evaluateStrategy(stratId, ctx);
        if (!sig || !sig.decision || sig.decision === 'HOLD') continue;
        // Detection = logging: persist on this path too so a setup caught only by the
        // real-time trigger (between scan ticks) is still tracked/reported.
        if (pool) {
          const barMs = Date.parse(sig.barIso || ctx.candles[ctx.candles.length - 1].time);
          if (Number.isFinite(barMs)) {
            try {
              const { id } = await persistStrategySignalRow(pool, stratId, symbol, tf, sig, barMs, new Date(), Number(ctx.candles[ctx.candles.length - 1]?.close));
              const sent = await maybeNotifyStrategy(stratId, symbol, tf, sig, ctx);
              if (sent.popupSent || sent.emailSent) {
                try { await pool.execute('UPDATE mt5_strategy_signals SET popup_sent=?, email_sent=? WHERE id=?', [sent.popupSent ? 1 : 0, sent.emailSent ? 1 : 0, id]); } catch { /* best-effort */ }
              }
              continue;
            } catch { /* fall through to notify-only */ }
          }
        }
        await maybeNotifyStrategy(stratId, symbol, tf, sig, ctx);
      } catch { /* per-pair resilience */ }
    }
  }
  await processStrategyNotifyConfirms();
}

// Persist one strategy signal row (logging). Shared by the periodic scan and the
// real-time notify pass so detection = logging on EVERY path — nothing detected escapes
// the report. Idempotent: ON DUPLICATE keeps the first score/grade for that bar.
async function persistStrategySignalRow(pool, stratId, symbol, tf, sig, barMs, nowDate = new Date(), livePrice = null) {
  const id = `${stratId}:${symbol}:${tf}:${barMs}`;
  const meta = sig?.meta || {};
  const strategyVersion = strategySignalVersion(meta);
  const setupPlan = strategySignalPlan(meta);
  const entryOrderType = strategySignalOrderType({ ...meta, strategy: stratId });
  const entryState = String(meta.entryState || (entryOrderType === 'MARKET' ? 'FILLED' : 'WAIT')).toUpperCase();
  const measureFixedTime = strategySignalMeasuresFixedTime({ ...meta, strategy: stratId });
  const signalMs = nowDate.getTime();
  const validBars = Math.max(1, Number(meta.validBars) || STRATEGY_LAB_ENTRY_VALID_BARS);
  const validUntil = Number.isFinite(signalMs) ? new Date(signalMs + validBars * timeframeMinutes(tf) * 60000) : null;
  const filledAt = meta.fillAtSignal || entryState === 'FILLED' ? nowDate : null;
  const setupEventMs = Date.parse(meta.setupEventIso || '');
  const alertBarMs = Date.parse(meta.alertBarIso || sig.barIso || '');
  // The realistic AS-TRADED reference: the live price at the instant the signal fires (i.e. when
  // you'd see the alert / get the email). Kept from the FIRST insert for this bar (COALESCE), so a
  // re-detect on the same bar never overwrites the original fill price.
  const atRef = measureFixedTime && Number.isFinite(Number(livePrice)) ? Number(livePrice) : null;
  const ftOutcome = measureFixedTime ? 'PENDING' : 'EXPIRED';
  const [res] = await pool.execute(
    `INSERT INTO mt5_strategy_signals
       (id, strategy, symbol, timeframe, bar_time, signal_time, direction, score, grade,
         entry_price, stop_loss, take_profit_1, take_profit_2, take_profit_3,
         risk_reward, reason, outcome, ft_outcome, at_ref_price, created_at,
         strategy_version, setup_plan, entry_order_type, entry_state, entry_filled_at,
         setup_event_time, alert_bar_time, valid_until, measure_fixed_time)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?,?, ?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE score = COALESCE(score, VALUES(score)), grade = COALESCE(grade, VALUES(grade)),
       at_ref_price = COALESCE(at_ref_price, VALUES(at_ref_price)),
       strategy_version = COALESCE(strategy_version, VALUES(strategy_version)),
       setup_plan = COALESCE(setup_plan, VALUES(setup_plan)),
       entry_order_type = COALESCE(entry_order_type, VALUES(entry_order_type)),
       entry_state = CASE WHEN entry_state='FILLED' THEN entry_state ELSE COALESCE(VALUES(entry_state), entry_state) END,
       entry_filled_at = COALESCE(entry_filled_at, VALUES(entry_filled_at)),
       setup_event_time = COALESCE(setup_event_time, VALUES(setup_event_time)),
       alert_bar_time = COALESCE(alert_bar_time, VALUES(alert_bar_time)),
       valid_until = COALESCE(valid_until, VALUES(valid_until)),
       measure_fixed_time = COALESCE(measure_fixed_time, VALUES(measure_fixed_time)),
       score_updated_at = IF(VALUES(score) IS NOT NULL AND NOT (VALUES(score) <=> COALESCE(latest_score, score)), VALUES(signal_time), score_updated_at),
       latest_grade    = IF(VALUES(score) IS NOT NULL AND NOT (VALUES(score) <=> COALESCE(latest_score, score)), VALUES(grade), COALESCE(latest_grade, grade)),
       latest_score    = IF(VALUES(score) IS NOT NULL AND NOT (VALUES(score) <=> COALESCE(latest_score, score)), VALUES(score), COALESCE(latest_score, score))`,
    [id, stratId, symbol, tf, toMysqlDate(new Date(barMs)), toMysqlDate(nowDate), sig.decision, sig.score ?? null, sig.grade ?? null,
     sig.entry ?? null, sig.stopLoss ?? null, sig.takeProfit1 ?? null, sig.takeProfit2 ?? null, sig.takeProfit3 ?? null,
     sig.riskRewardRatio ?? null, String(sig.reason || '').slice(0, 255), ftOutcome, atRef, toMysqlDate(nowDate),
     strategyVersion, setupPlan, entryOrderType, entryState, filledAt ? toMysqlDate(filledAt) : null,
     Number.isFinite(setupEventMs) ? toMysqlDate(new Date(setupEventMs)) : null,
     Number.isFinite(alertBarMs) ? toMysqlDate(new Date(alertBarMs)) : null,
     validUntil ? toMysqlDate(validUntil) : null, measureFixedTime ? 1 : 0],
  );
  return { id, affectedRows: res.affectedRows };
}

async function runStrategyLabScan() {
  if (strategyLabScanRunning) return;
  strategyLabScanRunning = true;
  try {
    const pool = await initializeDatabase();
    if (!pool) return;
    const symbols = getCuratedSymbols(getMt5Status().symbols);
    if (!symbols.length) return;
    const now = new Date();
    let logged = 0;
    for (const stratId of Object.keys(STRATEGY_LAB_REGISTRY)) {
      const declaredTfs = strategyTimeframes(stratId);
      for (const symbol of symbols) {
        for (const tf of STRATEGY_LAB_TIMEFRAMES) {
          if (!declaredTfs.includes(tf)) continue;         // registry timeframes are a contract, not a hint
          if (!symbolAllowsSignalTf(symbol, tf)) continue; // e.g. USTEC: no M1/D1 signals
          const ctx = buildStrategyContext(symbol, tf);
          if (!ctx) continue;
          const sig = evaluateStrategy(stratId, ctx);
          if (!sig || !sig.decision || sig.decision === 'HOLD') continue;
          const barMs = Date.parse(sig.barIso || ctx.candles[ctx.candles.length - 1].time);
          if (!Number.isFinite(barMs)) continue;
          try {
            const { id, affectedRows } = await persistStrategySignalRow(pool, stratId, symbol, tf, sig, barMs, now, Number(ctx.candles[ctx.candles.length - 1]?.close));
            if (affectedRows === 1) logged += 1;
            // Notifications run every pass (not only on a new DB row) so improvements
            // during a forming candle are caught; the lifecycle de-dups continuation
            // spam, so the same setup is sent once (NEW) then only on real improvement,
            // a re-entry, or the candle-close confirmation.
            const sent = await maybeNotifyStrategy(stratId, symbol, tf, sig, ctx, now.getTime());
            if (sent.popupSent || sent.emailSent) {
              try {
                await pool.execute(
                  'UPDATE mt5_strategy_signals SET popup_sent=?, email_sent=? WHERE id=?',
                  [sent.popupSent ? 1 : 0, sent.emailSent ? 1 : 0, id],
                );
              } catch { /* tracking is best-effort */ }
            }
          } catch { /* per-signal resilience */ }
        }
      }
    }
    await processStrategyNotifyConfirms();
    if (logged) console.log(`[StrategyLab] Logged ${logged} new signals across ${symbols.length} symbols.`);
  } catch (e) {
    console.error('[StrategyLab] Scan error:', e.message);
  } finally {
    strategyLabScanRunning = false;
  }
}

// Fixed-time outcome: was the close STRATEGY_LAB_FT_EXPIRY_BARS candles after the
// signal bar in the predicted direction? (entry reference = signal-bar close).
function resolveStrategyFixedTime(row, candles) {
  const barMs = row.bar_time ? new Date(row.bar_time).getTime() : NaN;
  if (!Number.isFinite(barMs) || !candles.length) return null;
  let sigIdx = -1;
  for (let i = 0; i < candles.length; i++) { if (Date.parse(candles[i].time) <= barMs) sigIdx = i; else break; }
  if (sigIdx < 0) return null;
  const expiryIdx = sigIdx + STRATEGY_LAB_FT_EXPIRY_BARS;
  if (expiryIdx >= candles.length) return null; // expiry bar not in the store yet
  // Only settle once the expiry candle has actually CLOSED — never on a still-forming bar.
  // getRecentCandles keeps the current forming bar as the last element, so settling as soon
  // as expiryIdx exists would resolve against an incomplete candle (premature/wrong outcome
  // AND no live window). Wait until the expiry candle's close-time has passed.
  const expiryOpenMs = Date.parse(candles[expiryIdx].time);
  const tfMs = timeframeMinutes(row.timeframe) * 60000;
  if (Number.isFinite(expiryOpenMs) && tfMs > 0 && Date.now() < expiryOpenMs + tfMs) return null; // expiry candle still forming
  const ftEntry = Number(candles[sigIdx].close);
  const expiryClose = Number(candles[expiryIdx].close);
  if (!Number.isFinite(ftEntry) || !Number.isFinite(expiryClose)) return null;
  const pip = pipSizeForSymbol(row.symbol);
  const buy = /BUY/.test(String(row.direction).toUpperCase());
  const diff = buy ? expiryClose - ftEntry : ftEntry - expiryClose;
  return { outcome: diff > 0 ? 'WIN' : diff < 0 ? 'LOSS' : 'DRAW', exitPrice: expiryClose, pips: Math.round((diff / pip) * 10) / 10 };
}

// AS-TRADED fixed-time outcome (realistic): enter at the live price captured when the signal
// fired (row.at_ref_price), expire exactly one TF candle later (signal_time + tradeMinutes). The
// expiry price is the close of the candle covering the expiry instant, once it has closed — the
// nearest available stand-in for a tick-exact fill. Returns null until it can settle.
function resolveStrategyAsTraded(row, candles, nowMs = Date.now()) {
  const ref = Number(row.at_ref_price);
  if (!Number.isFinite(ref)) return null;                       // pre-feature row → never settle
  const sigMs = row.signal_time ? new Date(row.signal_time).getTime() : NaN;
  const tfMs = (timeframeMinutes(row.timeframe) || 0) * 60000;
  if (!Number.isFinite(sigMs) || tfMs <= 0) return null;
  const expiryMs = sigMs + tfMs * STRATEGY_LAB_FT_EXPIRY_BARS;
  if (nowMs < expiryMs) return null;                            // duration not elapsed yet
  if (!candles || !candles.length) return null;
  let expC = null;                                              // candle covering the expiry instant (largest open <= expiryMs)
  for (const c of candles) { const t = Date.parse(c.time); if (Number.isFinite(t) && t <= expiryMs) expC = c; else break; }
  if (!expC) return null;                                       // expiry window not in the buffer
  if (!(Date.parse(expC.time) + tfMs <= nowMs)) return null;    // covering candle still forming
  const exit = Number(expC.close);
  if (!Number.isFinite(exit)) return null;
  const pip = pipSizeForSymbol(row.symbol) || 0.0001;
  const buy = /BUY/.test(String(row.direction).toUpperCase());
  const diff = buy ? exit - ref : ref - exit;
  return { outcome: diff > 0 ? 'WIN' : diff < 0 ? 'LOSS' : 'DRAW', exitPrice: exit, pips: Math.round((diff / pip) * 10) / 10, expiryIso: new Date(expiryMs).toISOString() };
}

let lastLilCorrectionAt = 0;
async function processLilSweepCorrections(pool, nowMs = Date.now()) {
  if (!pool || nowMs - lastLilCorrectionAt < 5 * 60 * 1000) return;
  lastLilCorrectionAt = nowMs;
  const [rows] = await pool.query(
    `SELECT * FROM mt5_strategy_signals
      WHERE strategy='lil-sweep-pro-plus'
        AND (strategy_version IS NULL OR strategy_version < 2)
        AND (corrected_outcome IS NULL
             OR (corrected_outcome IN ('TP1_WIN','TP2_WIN')
                 AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 72 HOUR)))
        AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
      ORDER BY signal_time DESC LIMIT 250`,
    [STRATEGY_LAB_RETENTION_DAYS],
  );
  for (const row of rows) {
    const signalMs = row.signal_time ? new Date(row.signal_time).getTime() : NaN;
    if (!Number.isFinite(signalMs)) continue;
    const endMs = Math.min(nowMs, signalMs + 72 * 3600 * 1000);
    const candles = await getCandlesFromDbRange(row.symbol, row.timeframe, new Date(signalMs).toISOString(), new Date(endMs).toISOString(), 10000);
    if (!candles || candles.length < 2) continue;
    const plan = strategySignalPlan(row);
    const orderType = plan === 'BREAK-HOLD' ? 'MARKET' : 'STOP';
    const tfMs = timeframeMinutes(row.timeframe) * 60000;
    const validUntilMs = signalMs + STRATEGY_LAB_ENTRY_VALID_BARS * tfMs;
    const replayStartMs = orderType === 'MARKET' ? Math.ceil(signalMs / tfMs) * tfMs : signalMs;
    const priorCorrected = String(row.corrected_outcome || 'PENDING').toUpperCase();
    const priorRank = forexOutcomeRank(priorCorrected);
    const report = {
      symbol: row.symbol,
      timeframe: row.timeframe,
      signalTime: new Date(signalMs).toISOString(),
      direction: row.direction,
      entryPrice: row.entry_price,
      stopLoss: row.stop_loss,
      takeProfit1: row.take_profit_1,
      payload: { takeProfit2: row.take_profit_2, takeProfit3: row.take_profit_3 },
      outcome: priorCorrected,
      exitPrice: priorRank === 3 ? row.take_profit_3 : priorRank === 2 ? row.take_profit_2 : priorRank === 1 ? row.take_profit_1 : null,
      resolvedAt: null,
    };
    const replay = evaluateForexReplay(report, candles, {
      orderType,
      filledAtSignal: orderType === 'MARKET' || /ENTER NOW/i.test(String(row.reason || '')),
      validUntilIso: new Date(validUntilMs).toISOString(),
      replayStartIso: new Date(replayStartMs).toISOString(),
    });
    let corrected = null;
    let reason = null;
    if (replay.valid && ['LOSS', 'TP1_WIN', 'TP2_WIN', 'TP3_WIN', 'WIN', 'AMBIGUOUS'].includes(replay.outcome)) {
      corrected = replay.outcome;
      reason = `v2 ${orderType} replay${orderType === 'MARKET' ? ' from first full post-alert candle' : ''}`;
    } else if (!replay.filledAt && nowMs > validUntilMs) {
      corrected = 'EXPIRED';
      reason = `v2 ${orderType} replay: entry never filled within ${STRATEGY_LAB_ENTRY_VALID_BARS} bars`;
    } else if (nowMs - signalMs > 72 * 3600 * 1000) {
      corrected = 'EXPIRED';
      reason = `v2 ${orderType} replay: unresolved after 72h`;
    }
    if (!corrected) continue;
    await pool.execute(
      `UPDATE mt5_strategy_signals
          SET corrected_outcome=?, corrected_pips=?, correction_reason=?
        WHERE id=?
          AND (corrected_outcome IS NULL OR corrected_outcome IN ('TP1_WIN','TP2_WIN'))`,
      [corrected, replay.profitLossPips ?? null, reason, row.id],
    );
  }
}

async function processStrategyLabOutcomes() {
  const pool = await initializeDatabase();
  if (!pool) return;
  const nowMs = Date.now();
  try {
    await processLilSweepCorrections(pool, nowMs);
    // Repair pass (idempotent): re-open any impossible win so it re-resolves with the
    // corrected replay. A win can never have negative pips, and a TP level can't be hit
    // if that target was never defined (the old Number(null)->0 bug faked TP3 wins for
    // BUYs at exit price 0). Recomputed rows won't match, so this self-heals once.
    await pool.execute(
      `UPDATE mt5_strategy_signals
          SET outcome='PENDING', exit_price=NULL, profit_loss_pips=NULL, tp_hit_level=NULL,
              mfe_pips=NULL, mae_pips=NULL, resolved_at=NULL
        WHERE outcome IN ('TP1_WIN','TP2_WIN','TP3_WIN','WIN')
          AND ( profit_loss_pips < 0
                OR (tp_hit_level >= 2 AND take_profit_2 IS NULL)
                OR (tp_hit_level >= 3 AND take_profit_3 IS NULL) )`,
    );
    // Purge degenerate signals: a stop tighter than 3 pips is sub-spread noise (logged
    // before the engine's stopTooTight guard) — untradeable and skews the metrics. Pip
    // size is symbol-derived (JPY/gold = 0.01, else 0.0001). Idempotent; self-heals once.
    await pool.execute(
      `DELETE FROM mt5_strategy_signals
        WHERE entry_price IS NOT NULL AND stop_loss IS NOT NULL
          AND ABS(entry_price - stop_loss) < 3 * (CASE
                WHEN symbol LIKE '%JPY%' OR symbol LIKE '%XAU%' OR symbol LIKE '%GOLD%' THEN 0.01
                ELSE 0.0001 END)
        LIMIT 5000`,
    );
    // Bulk-expire anything past the 72h resolution horizon BEFORE the row-by-row pass — one
    // server-side UPDATE (UTC_TIMESTAMP vs the stored signal_time, both DB-side so no driver-tz
    // ambiguity). Without it, un-resolvable rows (post-signal candles already evicted from the
    // in-memory buffer, so the replay can never see where TP/SL hit) pile up faster than the row
    // loop reaches them and the whole table appears stuck on PENDING.
    await pool.execute(
      `UPDATE mt5_strategy_signals
          SET outcome='EXPIRED', resolved_at=UTC_TIMESTAMP()
        WHERE outcome='PENDING'
          AND signal_time < UTC_TIMESTAMP() - INTERVAL 72 HOUR
          AND NOT (strategy='lil-sweep-pro-plus' AND COALESCE(strategy_version, 1) >= 2)
        LIMIT 5000`,
    );
    await pool.execute(
      "UPDATE mt5_strategy_signals SET ft_outcome='EXPIRED' WHERE strategy <> 'lil-sweep-pro-plus' AND COALESCE(measure_fixed_time, 1) <> 0 AND ft_outcome='PENDING' AND signal_time < UTC_TIMESTAMP() - INTERVAL 72 HOUR LIMIT 5000",
    );
    await pool.execute(
      "UPDATE mt5_strategy_signals SET at_outcome='EXPIRED' WHERE strategy <> 'lil-sweep-pro-plus' AND COALESCE(measure_fixed_time, 1) <> 0 AND at_ref_price IS NOT NULL AND at_outcome IS NULL AND signal_time < UTC_TIMESTAMP() - INTERVAL 72 HOUR LIMIT 5000",
    );
    // NEWEST-first: the bulk-expire above already clears the >72h tail, so the row-by-row pass
    // should prioritise recent signals — those are the ones whose post-signal candles are still
    // in memory (so they CAN resolve to a real WIN/LOSS) and the ones the user is actually
    // trading. Oldest-first starved them: the resolver spun on the un-resolvable old cluster
    // (post-signal candles long evicted) and never reached today's signals. Older un-resolvable
    // rows simply wait for the 72h bulk-expire.
    const [overdueLilRows] = await pool.query(
      `SELECT * FROM mt5_strategy_signals
        WHERE strategy='lil-sweep-pro-plus'
          AND COALESCE(strategy_version, 1) >= 2
          AND outcome='PENDING'
          AND signal_time < UTC_TIMESTAMP() - INTERVAL 72 HOUR
        ORDER BY signal_time ASC LIMIT 100`,
    );
    const [recentRows] = await pool.query(
      `SELECT * FROM mt5_strategy_signals
        WHERE outcome IN ('PENDING','TP1_WIN','TP2_WIN')
           OR (strategy <> 'lil-sweep-pro-plus' AND COALESCE(measure_fixed_time, 1) <> 0 AND ft_outcome = 'PENDING')
           OR (strategy <> 'lil-sweep-pro-plus' AND COALESCE(measure_fixed_time, 1) <> 0 AND at_ref_price IS NOT NULL AND at_outcome IS NULL)
        ORDER BY signal_time DESC LIMIT 800`,
    );
    const overdueIds = new Set(overdueLilRows.map((row) => row.id));
    const rows = [...overdueLilRows, ...recentRows.filter((row) => !overdueIds.has(row.id))];
    for (const row of rows) {
      const signalMs = row.signal_time ? new Date(row.signal_time).getTime() : NaN;
      if (!Number.isFinite(signalMs)) continue;
      const ageHrs = (nowMs - signalMs) / (3600 * 1000);
      const isLilV2 = String(row.strategy) === 'lil-sweep-pro-plus' && Number(row.strategy_version) >= 2;
      const measureFixedTime = strategySignalMeasuresFixedTime(row);
      let candles = getRecentCandles(row.symbol, row.timeframe, 1000);
      if (isLilV2 && ageHrs > 72 && String(row.outcome).toUpperCase() === 'PENDING') {
        const tfMs = timeframeMinutes(row.timeframe) * 60000;
        const replayEndMs = signalMs + 72 * 3600 * 1000;
        const dbCandles = await getCandlesFromDbRange(
          row.symbol,
          row.timeframe,
          new Date(signalMs - tfMs).toISOString(),
          new Date(replayEndMs).toISOString(),
          10000,
        );
        if (dbCandles?.length >= 2) candles = dbCandles;
        else {
          await pool.execute(
            "UPDATE mt5_strategy_signals SET outcome='EXPIRED', resolved_at=? WHERE id=? AND outcome='PENDING'",
            [toMysqlDate(), row.id],
          );
          continue;
        }
      }

      // Forex outcome (TP/SL). Only PENDING expires past 72h — never overwrite a win.
      if (['PENDING', 'TP1_WIN', 'TP2_WIN'].includes(String(row.outcome).toUpperCase())) {
        if (ageHrs > 72 && String(row.outcome).toUpperCase() === 'PENDING' && !isLilV2) {
          await pool.execute("UPDATE mt5_strategy_signals SET outcome='EXPIRED', resolved_at=? WHERE id=?", [toMysqlDate(), row.id]);
        } else if (candles && candles.length >= 2) {
          const report = {
            symbol: row.symbol, timeframe: row.timeframe, signalTime: new Date(row.signal_time).toISOString(),
            direction: row.direction, entryPrice: row.entry_price, stopLoss: row.stop_loss, takeProfit1: row.take_profit_1,
            payload: { takeProfit2: row.take_profit_2, takeProfit3: row.take_profit_3 },
            outcome: row.outcome, exitPrice: row.exit_price, resolvedAt: row.resolved_at,
          };
          const orderType = strategySignalOrderType(row);
          const requiresFill = orderType === 'LIMIT' || orderType === 'STOP';
          const filledAtSignal = strategySignalFilledAtSignal(row);
          const tfMs = timeframeMinutes(row.timeframe) * 60000;
          const replayStartIso = isLilV2 && orderType === 'MARKET'
            ? new Date(Math.ceil(signalMs / tfMs) * tfMs).toISOString()
            : isLilV2 && orderType === 'STOP'
              ? new Date(Math.floor(signalMs / tfMs) * tfMs).toISOString()
              : null;
          // Every strategy now declares honest order semantics. Market-at-close setups
          // replay immediately; FVG/breaker LIMITs and LIL STOPs must actually fill.
          const replay = evaluateForexReplay(report, candles, {
            requiresFill,
            orderType,
            filledAtSignal,
            validUntilIso: row.valid_until ? new Date(row.valid_until).toISOString() : null,
            replayStartIso,
          });
          if (replay.filledAt && String(row.entry_state || '').toUpperCase() !== 'FILLED') {
            await pool.execute(
              "UPDATE mt5_strategy_signals SET entry_state='FILLED', entry_filled_at=COALESCE(entry_filled_at, ?) WHERE id=?",
              [toMysqlDate(replay.filledAt), row.id],
            );
          }
          if (replay.valid && !['PENDING', 'EXPIRED'].includes(replay.outcome)) {
            if (replay.outcome === 'AMBIGUOUS') {
              await pool.execute("UPDATE mt5_strategy_signals SET outcome='AMBIGUOUS', resolved_at=? WHERE id=?", [toMysqlDate(replay.resolvedAt || new Date()), row.id]);
            } else {
              await pool.execute(
                "UPDATE mt5_strategy_signals SET outcome=?, exit_price=?, profit_loss_pips=?, tp_hit_level=?, mfe_pips=?, mae_pips=?, resolved_at=? WHERE id=?",
                [replay.outcome, replay.exitPrice ?? null, replay.profitLossPips ?? null, replay.tpHitLevel ?? null, replay.mfePips ?? null, replay.maePips ?? null, toMysqlDate(replay.resolvedAt || new Date()), row.id],
              );
            }
          } else if (requiresFill && !replay.filledAt && row.valid_until && nowMs >= new Date(row.valid_until).getTime()) {
            await pool.execute(
              "UPDATE mt5_strategy_signals SET outcome='EXPIRED', entry_state='EXPIRED', resolved_at=? WHERE id=? AND outcome='PENDING'",
              [toMysqlDate(), row.id],
            );
          } else if (isLilV2 && ageHrs > 72) {
            await pool.execute(
              "UPDATE mt5_strategy_signals SET outcome='EXPIRED', resolved_at=? WHERE id=? AND outcome='PENDING'",
              [toMysqlDate(), row.id],
            );
          }
        }
      }

      // Fixed-time outcome (direction at expiry). Resolved for EVERY signal so the recent
      // view always shows a real WIN/LOSS/DRAW. "Tradable vs late" is a separate flag
      // (ftActionable) computed from timestamps — late-surfaced calls still show their
      // result, they're just excluded from the tradable win-rate.
      if (measureFixedTime && String(row.ft_outcome).toUpperCase() === 'PENDING') {
        const ft = candles && candles.length ? resolveStrategyFixedTime(row, candles) : null;
        if (ft) {
          await pool.execute("UPDATE mt5_strategy_signals SET ft_outcome=?, ft_exit_price=?, ft_pips=? WHERE id=?", [ft.outcome, ft.exitPrice, ft.pips, row.id]);
        } else if (ageHrs > 72) {
          await pool.execute("UPDATE mt5_strategy_signals SET ft_outcome='EXPIRED' WHERE id=?", [row.id]);
        }
      }

      // AS-TRADED outcome (realistic: live entry @ at_ref_price, expiry = signal_time + 1 candle).
      // Independent of the idealized ft_outcome above; only rows with a captured ref settle here.
      if (measureFixedTime && row.at_ref_price != null && (row.at_outcome == null || String(row.at_outcome).toUpperCase() === 'PENDING')) {
        const at = candles && candles.length ? resolveStrategyAsTraded(row, candles, nowMs) : null;
        if (at) {
          await pool.execute("UPDATE mt5_strategy_signals SET at_outcome=?, at_exit_price=?, at_pips=?, at_expiry_time=? WHERE id=?", [at.outcome, at.exitPrice, at.pips, toMysqlDate(new Date(at.expiryIso)), row.id]);
        } else if (ageHrs > 72) {
          await pool.execute("UPDATE mt5_strategy_signals SET at_outcome='EXPIRED' WHERE id=?", [row.id]);
        }
      }
    }
  } catch (e) {
    console.error('[StrategyLab] outcome resolver error:', e.message);
  }
}

async function pruneStrategyLabSignals() {
  const pool = await initializeDatabase();
  if (!pool) return;
  try {
    await pool.query(
      "DELETE FROM mt5_strategy_signals WHERE outcome <> 'PENDING' AND (strategy='lil-sweep-pro-plus' OR COALESCE(measure_fixed_time, 1) = 0 OR ft_outcome <> 'PENDING') AND created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) LIMIT 5000",
      [STRATEGY_LAB_RETENTION_DAYS],
    );
  } catch (e) { console.error('[StrategyLab] prune failed:', e.message); }
}

// Aggregate per-strategy (and per-timeframe) performance — forex + fixed-time win rates.
function strategyLabAccumulate(b, row) {
  b.fxTotal += 1;
  const fo = String(row.outcome || 'PENDING').toUpperCase();
  if (fo.endsWith('_WIN') || fo === 'WIN') { b.fxWins += 1; }
  else if (fo === 'LOSS') { b.fxLosses += 1; }
  else if (fo === 'EXPIRED') b.fxExpired += 1; else if (fo === 'PENDING') b.fxPending += 1;
  if (Number.isFinite(row.profit_loss_pips)) { b.fxNetPips += Number(row.profit_loss_pips); b.fxPipsN += 1; }
  // Signal R:R is a property of the plan (TP3 vs SL at signal time), so every signal that
  // carries one counts — not just settled rows. Answers "what RR does this bucket offer?".
  if (Number.isFinite(Number(row.risk_reward)) && Number(row.risk_reward) > 0) { b.fxRRSum += Number(row.risk_reward); b.fxRRCount += 1; }
  if (fo.endsWith('_WIN') || fo === 'WIN' || fo === 'LOSS') {
    const rm = rMultiple(row.symbol, row.entry_price, row.stop_loss, row.profit_loss_pips);
    if (rm !== null) { b.fxNetR += rm; b.fxRN += 1; }
  }
  const measureFixedTime = strategySignalMeasuresFixedTime(row);
  if (measureFixedTime) { b.ftTotal += 1; b.atTotal += 1; }
  const fto = String(row.ft_outcome || 'PENDING').toUpperCase();
  // Fixed-time win-rate counts only TRADABLE calls (surfaced before their expiry candle
  // closed). Late-surfaced calls still have a real outcome (shown in the recent view) but
  // were never tradable, so they're excluded from the win-rate. PENDING counts regardless.
  const bt = row.bar_time ? new Date(row.bar_time).getTime() : NaN;
  const st = row.signal_time ? new Date(row.signal_time).getTime() : NaN;
  const ftAct = (Number.isFinite(bt) && Number.isFinite(st)) ? strategyFtActionable(bt, row.timeframe, st) : true;
  if (measureFixedTime && fto === 'PENDING') b.ftPending += 1;
  else if (measureFixedTime && ftAct) { if (fto === 'WIN') b.ftWins += 1; else if (fto === 'LOSS') b.ftLosses += 1; else if (fto === 'DRAW') b.ftDraws += 1; }
  // AS-TRADED (realistic): entered at the live price when the signal fired — tradable by
  // construction, so no ftActionable gate. Only counts rows that captured a ref (going-forward).
  const ato = String(row.at_outcome || '').toUpperCase();
  if (measureFixedTime) {
    if (ato === 'WIN') b.atWins += 1; else if (ato === 'LOSS') b.atLosses += 1; else if (ato === 'DRAW') b.atDraws += 1;
    if (Number.isFinite(Number(row.at_pips)) && (ato === 'WIN' || ato === 'LOSS')) { b.atNetPips += Number(row.at_pips); b.atPipsN += 1; }
  }
  const corrected = String(row.corrected_outcome || '').toUpperCase();
  if (corrected.endsWith('_WIN') || corrected === 'WIN') b.correctedWins += 1;
  else if (corrected === 'LOSS') b.correctedLosses += 1;
  else if (corrected === 'EXPIRED') b.correctedExpired += 1;
  else if (corrected === 'AMBIGUOUS') b.correctedAmbiguous += 1;
  if (Number.isFinite(Number(row.corrected_pips)) && (corrected.endsWith('_WIN') || corrected === 'WIN' || corrected === 'LOSS')) {
    b.correctedNetPips += Number(row.corrected_pips);
    b.correctedPipsN += 1;
  }
}
function strategyLabBucket() {
  return { total: 0, fxTotal: 0, ftTotal: 0, atTotal: 0, fxWins: 0, fxLosses: 0, fxExpired: 0, fxPending: 0, fxNetPips: 0, fxPipsN: 0, fxNetR: 0, fxRN: 0, fxRRSum: 0, fxRRCount: 0, ftWins: 0, ftLosses: 0, ftDraws: 0, ftPending: 0, atWins: 0, atLosses: 0, atDraws: 0, atNetPips: 0, atPipsN: 0, correctedWins: 0, correctedLosses: 0, correctedExpired: 0, correctedAmbiguous: 0, correctedNetPips: 0, correctedPipsN: 0 };
}
function strategyLabFinalize(b) {
  const fxScored = b.fxWins + b.fxLosses;
  const ftScored = b.ftWins + b.ftLosses;
  const correctedScored = b.correctedWins + b.correctedLosses;
  return {
    total: b.total,
    forex: {
      total: b.fxTotal,
      wins: b.fxWins, losses: b.fxLosses, expired: b.fxExpired, pending: b.fxPending,
      winLossSettled: fxScored,
      winRate: fxScored ? Math.round((b.fxWins / fxScored) * 1000) / 10 : null,
      expectancyPips: b.fxPipsN ? Math.round((b.fxNetPips / b.fxPipsN) * 10) / 10 : null,
      expectancyR: b.fxRN ? Math.round((b.fxNetR / b.fxRN) * 100) / 100 : null,
      avgRR: b.fxRRCount ? Math.round((b.fxRRSum / b.fxRRCount) * 100) / 100 : null,
      confidence: sampleConfidence(fxScored),
    },
    fixedTime: {
      total: b.ftTotal,
      wins: b.ftWins, losses: b.ftLosses, draws: b.ftDraws, pending: b.ftPending,
      winLossSettled: ftScored,
      winRate: ftScored ? Math.round((b.ftWins / ftScored) * 1000) / 10 : null,
      confidence: sampleConfidence(ftScored),
    },
    // As-traded: the realistic win rate (live entry at signal time, expiry at +duration). The
    // gap vs fixedTime.winRate = how much the signal→entry delay costs. Going-forward data only.
    asTraded: (() => {
      const atScored = b.atWins + b.atLosses;
      return {
        total: b.atTotal,
        wins: b.atWins, losses: b.atLosses, draws: b.atDraws,
        winLossSettled: atScored,
        winRate: atScored ? Math.round((b.atWins / atScored) * 1000) / 10 : null,
        expectancyPips: b.atPipsN ? Math.round((b.atNetPips / b.atPipsN) * 10) / 10 : null,
        confidence: sampleConfidence(atScored),
      };
    })(),
    correctedForex: (correctedScored || b.correctedExpired || b.correctedAmbiguous) ? {
      wins: b.correctedWins,
      losses: b.correctedLosses,
      expired: b.correctedExpired,
      ambiguous: b.correctedAmbiguous,
      winLossSettled: correctedScored,
      winRate: correctedScored ? Math.round((b.correctedWins / correctedScored) * 1000) / 10 : null,
      expectancyPips: b.correctedPipsN ? Math.round((b.correctedNetPips / b.correctedPipsN) * 10) / 10 : null,
      confidence: sampleConfidence(correctedScored),
    } : null,
  };
}

// Report date window for the Strategy Lab reports. Supports rolling day-windows
// (days=N) and calendar presets in Bangladesh time (UTC+6): today / yesterday / last7,
// so "Today"/"Yesterday" align to BD calendar days (matching the BD session labels).
function strategyLabReportWindow({ days = 90, preset = null, from = null, to = null } = {}) {
  const BD = 6 * 3600 * 1000;
  const nowMs = Date.now();
  // Custom calendar range (from–to inclusive), interpreted in BD time so picking "1st–5th"
  // matches the BD session labels. Takes precedence over preset/days when both dates are valid.
  const parseDay = (v) => (v ? Date.parse(String(v).length <= 10 ? `${v}T00:00:00Z` : v) : NaN);
  const fromD = parseDay(from), toD = parseDay(to);
  if (Number.isFinite(fromD) && Number.isFinite(toD) && fromD <= toD) {
    const fromMs = fromD - BD;                  // BD 00:00 of the from-day, in real UTC
    const toMs = toD - BD + 86400000;           // end of the to-day (exclusive next BD midnight)
    return { fromMs, toMs, preset: 'custom', days: null, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), label: `${String(from).slice(0, 10)} → ${String(to).slice(0, 10)} (BD)` };
  }
  let fromMs;
  let toMs = nowMs;
  let label;
  const p = preset ? String(preset).toLowerCase() : null;
  if (p === 'today' || p === 'yesterday' || p === 'last7') {
    const bdNow = new Date(nowMs + BD);
    const bdMidnightUtc = Date.UTC(bdNow.getUTCFullYear(), bdNow.getUTCMonth(), bdNow.getUTCDate()) - BD; // BD 00:00 expressed in real UTC
    if (p === 'today') { fromMs = bdMidnightUtc; label = 'Today (BD)'; }
    else if (p === 'yesterday') { fromMs = bdMidnightUtc - 86400000; toMs = bdMidnightUtc; label = 'Yesterday (BD)'; }
    else { fromMs = bdMidnightUtc - 6 * 86400000; label = 'Last 7 days (BD)'; } // today + previous 6 BD days
  } else {
    const d = Math.max(1, Math.min(Number(days) || 90, 365));
    fromMs = nowMs - d * 86400000;
    label = `Last ${d} days`;
  }
  return { fromMs, toMs, preset: p, days, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), label };
}

async function buildStrategyLabPerformance({ days = 90, preset = null, from = null, to = null } = {}) {
  const pool = await initializeDatabase();
  const win = strategyLabReportWindow({ days, preset, from, to });
  const out = { strategies: [], timeframeRanking: [], symbolRanking: [], sessionRanking: [], sessionBreakdown: [], scoreRanking: [], combos: [], window: { from: win.from, to: win.to, label: win.label, preset: win.preset, days: win.days }, minSampleToRank: 20, generatedAt: new Date().toISOString() };
  if (!pool) return out;
  const [rows] = await pool.query(
    "SELECT strategy, symbol, timeframe, direction, score, entry_price, stop_loss, risk_reward, outcome, profit_loss_pips, ft_outcome, at_outcome, at_pips, signal_time, bar_time, strategy_version, measure_fixed_time, corrected_outcome, corrected_pips FROM mt5_strategy_signals WHERE signal_time >= ? AND signal_time < ? LIMIT 20000",
    [toMysqlDate(new Date(win.fromMs)), toMysqlDate(new Date(win.toMs))],
  );
  const byStrat = new Map();
  // Cross-cutting aggregates (across ALL strategies) — answer "which timeframe / which
  // symbol actually works", independent of strategy.
  const globalTf = new Map();
  const globalSymbol = new Map();
  const globalSession = new Map();
  const globalScore = new Map(); // score-band (A+/A/B/C/unscored) -> bucket
  // Map a numeric score to its grade band — same thresholds the strategies grade with.
  const scoreBand = (score) => {
    const v = Number(score);
    if (!Number.isFinite(v)) return { key: 'unscored', label: 'Unscored', range: '—', order: 5 };
    if (v >= 85) return { key: 'aplus', label: 'A+', range: '85–100', order: 1 };
    if (v >= 75) return { key: 'a', label: 'A', range: '75–84', order: 2 };
    if (v >= 65) return { key: 'b', label: 'B', range: '65–74', order: 3 };
    return { key: 'c', label: 'C', range: 'below 65', order: 4 };
  };
  // strategy×symbol×timeframe combos — the most granular ranking ("best edge anywhere").
  const comboMap = new Map();
  // Per-SESSION breakdown — within each trading session, which strategies / symbols /
  // timeframes actually work (forex + fixed-time). Answers "what to trade in this session".
  const sessionBreakdown = new Map(); // sessionKey -> { meta, byStrategy:Map, bySymbol:Map, byTf:Map }
  const bumpBreakdown = (map, key, r) => { if (!map.has(key)) map.set(key, strategyLabBucket()); const b = map.get(key); b.total += 1; strategyLabAccumulate(b, r); };
  for (const r of rows) {
    if (!byStrat.has(r.strategy)) byStrat.set(r.strategy, { overall: strategyLabBucket(), byTf: new Map(), bySymbol: new Map(), bySession: new Map(), byScore: new Map() });
    const s = byStrat.get(r.strategy);
    s.overall.total += 1; strategyLabAccumulate(s.overall, r);
    if (!s.byTf.has(r.timeframe)) s.byTf.set(r.timeframe, strategyLabBucket());
    const tb = s.byTf.get(r.timeframe); tb.total += 1; strategyLabAccumulate(tb, r);
    if (!s.bySymbol.has(r.symbol)) s.bySymbol.set(r.symbol, strategyLabBucket());
    const sb = s.bySymbol.get(r.symbol); sb.total += 1; strategyLabAccumulate(sb, r);

    // Trading session (Bangladesh time) — pure function of signal_time.
    const sess = strategyLabSession(r.signal_time);
    if (!s.bySession.has(sess.key)) s.bySession.set(sess.key, { meta: sess, b: strategyLabBucket() });
    const ses = s.bySession.get(sess.key); ses.b.total += 1; strategyLabAccumulate(ses.b, r);

    if (!globalTf.has(r.timeframe)) globalTf.set(r.timeframe, strategyLabBucket());
    const gt = globalTf.get(r.timeframe); gt.total += 1; strategyLabAccumulate(gt, r);
    if (!globalSymbol.has(r.symbol)) globalSymbol.set(r.symbol, strategyLabBucket());
    const gs = globalSymbol.get(r.symbol); gs.total += 1; strategyLabAccumulate(gs, r);
    if (!globalSession.has(sess.key)) globalSession.set(sess.key, { meta: sess, b: strategyLabBucket() });
    const gss = globalSession.get(sess.key); gss.b.total += 1; strategyLabAccumulate(gss.b, r);

    const ckey = `${r.strategy}|${r.symbol}|${r.timeframe}`;
    if (!comboMap.has(ckey)) comboMap.set(ckey, { strategy: r.strategy, symbol: r.symbol, timeframe: r.timeframe, b: strategyLabBucket() });
    const cb = comboMap.get(ckey); cb.b.total += 1; strategyLabAccumulate(cb.b, r);

    // Per-session breakdown accumulation.
    if (!sessionBreakdown.has(sess.key)) sessionBreakdown.set(sess.key, { meta: sess, byStrategy: new Map(), bySymbol: new Map(), byTf: new Map() });
    const sbd = sessionBreakdown.get(sess.key);
    bumpBreakdown(sbd.byStrategy, r.strategy, r);
    bumpBreakdown(sbd.bySymbol, r.symbol, r);
    bumpBreakdown(sbd.byTf, r.timeframe, r);

    // Score band (grade) — per strategy + global. "Do higher-score setups actually win more?"
    const band = scoreBand(r.score);
    if (!s.byScore.has(band.key)) s.byScore.set(band.key, { meta: band, b: strategyLabBucket() });
    const ssc = s.byScore.get(band.key); ssc.b.total += 1; strategyLabAccumulate(ssc.b, r);
    if (!globalScore.has(band.key)) globalScore.set(band.key, { meta: band, b: strategyLabBucket() });
    const gsc = globalScore.get(band.key); gsc.b.total += 1; strategyLabAccumulate(gsc.b, r);
  }
  const meta = Object.fromEntries(listStrategies().map((m) => [m.id, m]));
  // Rank by win rate, but only once a bucket has enough settled samples to trust — thin
  // samples sink to the bottom (never crown a winner on 2 trades). Tie-break by sample size.
  const minSample = out.minSampleToRank;
  const rankByWin = (a, b) => {
    const aOk = (a.forex.winLossSettled ?? 0) >= minSample, bOk = (b.forex.winLossSettled ?? 0) >= minSample;
    if (aOk !== bOk) return aOk ? -1 : 1;
    return ((b.forex.winRate ?? -1) - (a.forex.winRate ?? -1)) || ((b.forex.winLossSettled ?? 0) - (a.forex.winLossSettled ?? 0));
  };
  out.strategies = [...byStrat.entries()].map(([id, s]) => ({
    id, name: meta[id]?.name || id, source: meta[id]?.source || null, forexOnly: Boolean(meta[id]?.forexOnly),
    ...strategyLabFinalize(s.overall),
    byTimeframe: [...s.byTf.entries()].map(([tf, b]) => ({ timeframe: tf, ...strategyLabFinalize(b) }))
      .sort(rankByWin),
    bySymbol: [...s.bySymbol.entries()].map(([symbol, b]) => ({ symbol, ...strategyLabFinalize(b) }))
      .sort(rankByWin),
    bySession: [...s.bySession.values()].map(({ meta: m, b }) => ({ session: m.key, sessionLabel: m.label, bdRange: m.bdRange, ...strategyLabFinalize(b) }))
      .sort(rankByWin),
    byScore: [...s.byScore.values()].map(({ meta: m, b }) => ({ band: m.key, label: m.label, range: m.range, order: m.order, ...strategyLabFinalize(b) }))
      .sort((a, b) => a.order - b.order),
  })).sort(rankByWin);
  out.timeframeRanking = [...globalTf.entries()].map(([timeframe, b]) => ({ timeframe, ...strategyLabFinalize(b) })).sort(rankByWin);
  out.symbolRanking = [...globalSymbol.entries()].map(([symbol, b]) => ({ symbol, ...strategyLabFinalize(b) })).sort(rankByWin);
  out.sessionRanking = [...globalSession.values()].map(({ meta: m, b }) => ({ session: m.key, sessionLabel: m.label, bdRange: m.bdRange, ...strategyLabFinalize(b) })).sort(rankByWin);
  // Score-band ranking (across all strategies) — kept in grade order (A+→C) so the win-rate
  // gradient is readable; the UI re-ranks by the chosen metric on demand.
  out.scoreRanking = [...globalScore.values()].map(({ meta: m, b }) => ({ band: m.key, label: m.label, range: m.range, order: m.order, ...strategyLabFinalize(b) })).sort((a, b) => a.order - b.order);
  // Per-session breakdown: keep the same session ordering as the global session ranking.
  const sessionOrder = out.sessionRanking.map((s) => s.session);
  out.sessionBreakdown = [...sessionBreakdown.values()].map(({ meta: m, byStrategy, bySymbol, byTf }) => ({
    session: m.key, sessionLabel: m.label, bdRange: m.bdRange,
    byStrategy: [...byStrategy.entries()].map(([id, b]) => ({ id, name: meta[id]?.name || id, forexOnly: Boolean(meta[id]?.forexOnly), ...strategyLabFinalize(b) })).sort(rankByWin),
    bySymbol: [...bySymbol.entries()].map(([symbol, b]) => ({ symbol, ...strategyLabFinalize(b) })).sort(rankByWin),
    byTimeframe: [...byTf.entries()].map(([timeframe, b]) => ({ timeframe, ...strategyLabFinalize(b) })).sort(rankByWin),
  })).sort((a, b) => sessionOrder.indexOf(a.session) - sessionOrder.indexOf(b.session));
  out.combos = [...comboMap.values()]
    .map((c) => ({ strategy: c.strategy, strategyName: meta[c.strategy]?.name || c.strategy, forexOnly: Boolean(meta[c.strategy]?.forexOnly), symbol: c.symbol, timeframe: c.timeframe, ...strategyLabFinalize(c.b) }))
    .filter((c) => (c.forex.winLossSettled ?? 0) > 0 || (c.fixedTime.winLossSettled ?? 0) > 0)
    .sort(rankByWin)
    .slice(0, 60);
  return out;
}

// ─── Confluence analysis: do 2-3 strategies AGREEING produce better signals? ──
// A "moment" = (symbol, timeframe, bar_time, direction). Strategies that fire on the SAME
// moment "agree". Because the fixed-time outcome (next-candle direction vs the signal-bar
// close) depends only on the moment — not the strategy — every strategy agreeing on a moment
// shares ONE WIN/LOSS, so confluence is cleanly measurable on the fixed-time + as-traded sides.
function confluenceBucket() { return { moments: 0, ftW: 0, ftL: 0, ftD: 0, atW: 0, atL: 0, atD: 0 }; }
function confluenceFinalize(b) {
  const ftS = b.ftW + b.ftL, atS = b.atW + b.atL;
  return {
    moments: b.moments,
    fixedTime: { wins: b.ftW, losses: b.ftL, draws: b.ftD, settled: ftS, winRate: ftS ? Math.round((b.ftW / ftS) * 1000) / 10 : null, confidence: sampleConfidence(ftS) },
    asTraded: { wins: b.atW, losses: b.atL, draws: b.atD, settled: atS, winRate: atS ? Math.round((b.atW / atS) * 1000) / 10 : null, confidence: sampleConfidence(atS) },
  };
}
function confluenceAccumulate(b, m) {
  b.moments += 1;
  if (m.ftOut === 'WIN') b.ftW += 1; else if (m.ftOut === 'LOSS') b.ftL += 1; else if (m.ftOut === 'DRAW') b.ftD += 1;
  if (m.atOut === 'WIN') b.atW += 1; else if (m.atOut === 'LOSS') b.atL += 1; else if (m.atOut === 'DRAW') b.atD += 1;
}

async function buildStrategyLabConfluence({ days = 90, preset = null, from = null, to = null, timeframe = null, symbol = null, strategies = [] } = {}) {
  const pool = await initializeDatabase();
  const win = strategyLabReportWindow({ days, preset, from, to });
  const minSample = 12; // confluence samples are sparser than single-signal → a lower bar
  const out = { ok: true, window: { from: win.from, to: win.to, label: win.label, preset: win.preset, days: win.days }, minSample, agreementLadder: [], topPairs: [], combo: null, generatedAt: new Date().toISOString() };
  if (!pool) return out;
  const params = [toMysqlDate(new Date(win.fromMs)), toMysqlDate(new Date(win.toMs))];
  let sql = "SELECT strategy, symbol, timeframe, bar_time, direction, ft_outcome, at_outcome FROM mt5_strategy_signals WHERE signal_time >= ? AND signal_time < ? AND strategy <> 'lil-sweep-pro-plus' AND COALESCE(measure_fixed_time, 1) <> 0";
  if (timeframe) { sql += " AND timeframe = ?"; params.push(String(timeframe).toUpperCase()); }
  if (symbol) { sql += " AND symbol = ?"; params.push(String(symbol).toUpperCase()); }
  sql += " LIMIT 50000";
  const [rows] = await pool.query(sql, params);

  // Collapse rows into moments. The fixed-time / as-traded outcome is shared across strategies
  // on the same moment, so keep the first settled WIN/LOSS/DRAW we see.
  const moments = new Map();
  for (const r of rows) {
    const dir = /BUY|UP/.test(String(r.direction).toUpperCase()) ? 'UP' : 'DOWN';
    const key = `${r.symbol}|${r.timeframe}|${new Date(r.bar_time).getTime()}|${dir}`;
    let m = moments.get(key);
    if (!m) { m = { symbol: r.symbol, timeframe: r.timeframe, direction: dir, strategies: new Set(), ftOut: null, atOut: null }; moments.set(key, m); }
    m.strategies.add(r.strategy);
    const fo = String(r.ft_outcome || '').toUpperCase();
    if (!m.ftOut && (fo === 'WIN' || fo === 'LOSS' || fo === 'DRAW')) m.ftOut = fo;
    const ao = String(r.at_outcome || '').toUpperCase();
    if (!m.atOut && (ao === 'WIN' || ao === 'LOSS' || ao === 'DRAW')) m.atOut = ao;
  }

  const strategyMeta = listStrategies();
  const meta = Object.fromEntries(strategyMeta.map((x) => [x.id, x.name]));
  const forexOnlyIds = new Set(strategyMeta.filter((x) => x.forexOnly).map((x) => x.id));
  // 1) Agreement ladder: bucket every moment by how many strategies agreed (1 / 2 / 3 / 4+).
  const ladder = new Map(); // bucketKey -> confluenceBucket
  // 2) Per-pair: every co-occurring pair gets credited on each moment they share.
  const pairs = new Map(); // "a|b" (sorted) -> confluenceBucket
  // Solo per-strategy (all moments a strategy appears in) for comparison.
  const solo = new Map(); // id -> confluenceBucket
  for (const m of moments.values()) {
    const ids = [...m.strategies].sort();
    const n = ids.length;
    const bk = n >= 4 ? '4+' : String(n);
    if (!ladder.has(bk)) ladder.set(bk, confluenceBucket());
    confluenceAccumulate(ladder.get(bk), m);
    for (const id of ids) { if (!solo.has(id)) solo.set(id, confluenceBucket()); confluenceAccumulate(solo.get(id), m); }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const pk = `${ids[i]}|${ids[j]}`;
      if (!pairs.has(pk)) pairs.set(pk, confluenceBucket());
      confluenceAccumulate(pairs.get(pk), m);
    }
  }
  const ladderOrder = ['1', '2', '3', '4+'];
  out.agreementLadder = ladderOrder.filter((k) => ladder.has(k)).map((k) => ({ agree: k, ...confluenceFinalize(ladder.get(k)) }));

  // Top pairs by fixed-time win rate (sample-gated), with each member's solo win rate for lift.
  out.topPairs = [...pairs.entries()].map(([pk, b]) => {
    const [a, c] = pk.split('|');
    const f = confluenceFinalize(b);
    const sa = solo.get(a) ? confluenceFinalize(solo.get(a)) : null;
    const sc = solo.get(c) ? confluenceFinalize(solo.get(c)) : null;
    return {
      a, b: c, aName: meta[a] || a, bName: meta[c] || c,
      moments: f.moments, fixedTime: f.fixedTime, asTraded: f.asTraded,
      soloA: sa ? { winRate: sa.fixedTime.winRate, settled: sa.fixedTime.settled } : null,
      soloB: sc ? { winRate: sc.fixedTime.winRate, settled: sc.fixedTime.settled } : null,
    };
  }).filter((p) => p.fixedTime.settled >= minSample)
    .sort((x, y) => (y.fixedTime.winRate ?? -1) - (x.fixedTime.winRate ?? -1) || y.fixedTime.settled - x.fixedTime.settled)
    .slice(0, 25);

  // 3) Custom combo: moments where ALL the selected strategies fired together.
  const sel = (Array.isArray(strategies) ? strategies : []).filter((id) => id && !forexOnlyIds.has(id));
  if (sel.length >= 2) {
    const comboB = confluenceBucket();
    const bySymbol = new Map();
    for (const m of moments.values()) {
      if (!sel.every((id) => m.strategies.has(id))) continue;
      confluenceAccumulate(comboB, m);
      if (!bySymbol.has(m.symbol)) bySymbol.set(m.symbol, confluenceBucket());
      confluenceAccumulate(bySymbol.get(m.symbol), m);
    }
    out.combo = {
      strategies: sel, names: sel.map((id) => meta[id] || id),
      ...confluenceFinalize(comboB),
      solos: sel.map((id) => ({ id, name: meta[id] || id, ...(solo.get(id) ? confluenceFinalize(solo.get(id)) : confluenceFinalize(confluenceBucket())) })),
      bySymbol: [...bySymbol.entries()].map(([sym, b]) => ({ symbol: sym, ...confluenceFinalize(b) })).sort((x, y) => (y.fixedTime.winRate ?? -1) - (x.fixedTime.winRate ?? -1)),
    };
  }
  return out;
}

// GET /api/strategy-lab/confluence?days=&preset=&timeframe=&symbol=&strategies=a,b,c
app.get('/api/strategy-lab/confluence', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(Number(req.query.days) || 90, 365));
    const preset = req.query.preset ? String(req.query.preset) : null;
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const timeframe = req.query.timeframe ? String(req.query.timeframe) : null;
    const symbol = req.query.symbol ? String(req.query.symbol) : null;
    const strategies = req.query.strategies ? String(req.query.strategies).split(',').map((s) => s.trim()).filter(Boolean) : [];
    res.json(await buildStrategyLabConfluence({ days, preset, from, to, timeframe, symbol, strategies }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/strategy-lab/strategies — registry metadata.
app.get('/api/strategy-lab/strategies', (req, res) => {
  const controls = loadEmailAlertSettings().strategyControls || {};
  // Attach each strategy's controller state (default = enabled) so the Settings page and
  // dashboard can render the on/off switch + refinements and grey muted strategies.
  const strategies = listStrategies().map((m) => {
    const saved = controls[m.id] || { enabled: true };
    const control = Array.isArray(saved.timeframes)
      ? { ...saved, timeframes: saved.timeframes.filter((tf) => strategyTimeframes(m.id).includes(tf)) }
      : saved;
    return { ...m, control };
  });
  // Curated symbol universe the lab scans — lets the Settings page build the per-strategy
  // email symbol filter (empty selection = all symbols).
  const symbols = getCuratedSymbols(getMt5Status().symbols);
  res.json({ ok: true, strategies, symbols, timeframes: STRATEGY_LAB_TIMEFRAMES, ftExpiryBars: STRATEGY_LAB_FT_EXPIRY_BARS });
});

// GET /api/strategy-lab/live?strategy=&timeframe= — LIVE command per curated symbol on
// one timeframe (like the fixed-time scan): ENTRY (with plan) or HOLD / NO-DATA.
// Enrich live ENTRY/CALL rows with the FIRST-call info from the DB (when the signal was
// originally made + the frozen first score) so the live grids can show the signal time and
// the score evolution (first → current). Best-effort: rows render fine without it.
async function enrichLiveRowsWithFirstCall(rows, strategy, commandKind) {
  const targets = rows.filter((r) => r.command === commandKind && r.barIso);
  if (!targets.length) return;
  const idOf = (r) => `${strategy}:${r.symbol}:${r.timeframe}:${Date.parse(r.barIso)}`;
  try {
    const pool = await initializeDatabase();
    if (!pool) return;
    const ids = targets.map(idOf);
    const [dbRows] = await pool.query(
      `SELECT id, signal_time, score, grade, score_updated_at FROM mt5_strategy_signals WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    const byId = new Map(dbRows.map((d) => [d.id, d]));
    for (const r of targets) {
      const d = byId.get(idOf(r));
      if (!d) continue;
      r.signalTime = d.signal_time ? new Date(d.signal_time).toISOString() : null;
      r.firstScore = d.score === null || d.score === undefined ? null : Number(d.score);
      r.firstGrade = d.grade || null;
      r.scoreUpdatedAt = d.score_updated_at ? new Date(d.score_updated_at).toISOString() : null;
    }
  } catch { /* enrichment only */ }
}

app.get('/api/strategy-lab/live', async (req, res) => {
  try {
    const includeMuted = req.query.includeMuted === '1' || req.query.includeMuted === 'true';
    const strategy = req.query.strategy ? String(req.query.strategy) : (enabledStrategyIds()[0] || Object.keys(STRATEGY_LAB_REGISTRY)[0]);
    if (!STRATEGY_LAB_REGISTRY[strategy]) return res.status(404).json({ error: 'Unknown strategy.' });
    const tfParam = (req.query.timeframe ? String(req.query.timeframe) : 'M15').toUpperCase();
    // Disabled in the Strategy Controller → hidden everywhere (return no rows) unless an
    // admin view explicitly asks for muted strategies.
    if (!includeMuted && strategyMuted(strategy)) {
      return res.json({ ok: true, hidden: true, strategy, strategyName: STRATEGY_LAB_REGISTRY[strategy].name, timeframe: tfParam, rows: [], generatedAt: new Date().toISOString() });
    }
    // Registry timeframes are an execution contract. ICT Breaker intentionally declares
    // the full M1/M5/M15/M30/H1/H4/D1 ladder and therefore remains available on all seven.
    const declaredTfs = strategyTimeframes(strategy);
    if (tfParam !== 'ALL' && !declaredTfs.includes(tfParam)) {
      return res.status(400).json({ error: `${STRATEGY_LAB_REGISTRY[strategy].name} does not support ${tfParam}.`, allowedTimeframes: declaredTfs });
    }
    const tfs = tfParam === 'ALL' ? declaredTfs : [tfParam];
    const symbols = getCuratedSymbols(getMt5Status().symbols);
    const rows = [];
    for (const symbol of symbols) {
      for (const tf of tfs) {
        const ctx = buildStrategyContext(symbol, tf);
        if (!ctx) { rows.push({ symbol, timeframe: tf, command: 'NO_DATA' }); continue; }
        const price = Number(ctx.candles[ctx.candles.length - 1].close);
        const fresh = candleFreshness(ctx.candles[ctx.candles.length - 1], tf);
        const sig = evaluateStrategy(strategy, ctx);
        if (sig && sig.decision && sig.decision !== 'HOLD' && liveSignalsAllowed()) {
          const sizing = strategyLabSizing(symbol, sig.entry, sig.stopLoss, { tp1: sig.takeProfit1, tp2: sig.takeProfit2, tp3: sig.takeProfit3 });
          rows.push({
            symbol, timeframe: tf, command: 'ENTRY', direction: sig.decision,
            barIso: sig.barIso ?? null,
            score: sig.score ?? null, grade: sig.grade ?? null, price,
            entry: sig.entry ?? null, stopLoss: sig.stopLoss ?? null,
            takeProfit1: sig.takeProfit1 ?? null, takeProfit2: sig.takeProfit2 ?? null, takeProfit3: sig.takeProfit3 ?? null,
            riskReward: sig.riskRewardRatio ?? null, reason: sig.reason || null,
            lots: sizing?.suggestedLots ?? null, stopPips: sizing?.stopPips ?? null,
            lossAtStop: sizing?.lossAtStop ?? null, riskPercent: sizing?.riskPercent ?? null,
            timing: strategyLabLiveTiming(symbol, sig.decision, price, sig.entry, sig.stopLoss, sig.meta || null),
            dataFresh: fresh.dataFresh, sourceReceivedAt: fresh.sourceReceivedAt, staleSeconds: fresh.staleSeconds,
          });
        } else {
          rows.push({ symbol, timeframe: tf, command: 'HOLD', price, dataFresh: fresh.dataFresh, sourceReceivedAt: fresh.sourceReceivedAt, staleSeconds: fresh.staleSeconds });
        }
      }
    }
    // ENTRY first (by score), then HOLD/NO-DATA.
    rows.sort((a, b) => {
      const rank = (r) => (r.command === 'ENTRY' ? 2 : r.command === 'HOLD' ? 1 : 0);
      return (rank(b) - rank(a)) || ((b.score || 0) - (a.score || 0));
    });
    await enrichLiveRowsWithFirstCall(rows, strategy, 'ENTRY');
    res.json({ ok: true, strategy, strategyName: STRATEGY_LAB_REGISTRY[strategy].name, timeframe: tfParam, marketStatus: getForexMarketStatus(), rows, generatedAt: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/strategy-lab/live-ftt?strategy=&timeframe= — LIVE fixed-time framing of the
// same strategy signals: UP/DOWN call with a next-candle expiry (instead of the forex
// TP/SL plan). One row per curated symbol×timeframe: CALL (UP/DOWN) or HOLD / NO-DATA.
app.get('/api/strategy-lab/live-ftt', async (req, res) => {
  try {
    const includeMuted = req.query.includeMuted === '1' || req.query.includeMuted === 'true';
    const strategy = req.query.strategy ? String(req.query.strategy) : (enabledStrategyIds()[0] || Object.keys(STRATEGY_LAB_REGISTRY)[0]);
    if (!STRATEGY_LAB_REGISTRY[strategy]) return res.status(404).json({ error: 'Unknown strategy.' });
    const tfParam = (req.query.timeframe ? String(req.query.timeframe) : 'M15').toUpperCase();
    if (STRATEGY_LAB_REGISTRY[strategy].forexOnly) {
      return res.json({ ok: true, strategy, strategyName: STRATEGY_LAB_REGISTRY[strategy].name, timeframe: tfParam, expiryBars: STRATEGY_LAB_FT_EXPIRY_BARS, forexOnly: true, rows: [], generatedAt: new Date().toISOString() });
    }
    // Disabled strategies are hidden everywhere (see /live) unless includeMuted.
    if (!includeMuted && strategyMuted(strategy)) {
      return res.json({ ok: true, hidden: true, strategy, strategyName: STRATEGY_LAB_REGISTRY[strategy].name, timeframe: tfParam, expiryBars: STRATEGY_LAB_FT_EXPIRY_BARS, rows: [], generatedAt: new Date().toISOString() });
    }
    const declaredTfs = strategyTimeframes(strategy);
    if (tfParam !== 'ALL' && !declaredTfs.includes(tfParam)) {
      return res.status(400).json({ error: `${STRATEGY_LAB_REGISTRY[strategy].name} does not support ${tfParam}.`, allowedTimeframes: declaredTfs });
    }
    const tfs = tfParam === 'ALL' ? declaredTfs : [tfParam];
    const symbols = getCuratedSymbols(getMt5Status().symbols);
    const rows = [];
    for (const symbol of symbols) {
      for (const tf of tfs) {
        const ctx = buildStrategyContext(symbol, tf);
        if (!ctx) { rows.push({ symbol, timeframe: tf, command: 'NO_DATA' }); continue; }
        const price = Number(ctx.candles[ctx.candles.length - 1].close);
        const fresh = candleFreshness(ctx.candles[ctx.candles.length - 1], tf);
        const sig = evaluateStrategy(strategy, ctx);
        if (sig && sig.decision && sig.decision !== 'HOLD' && liveSignalsAllowed() && !sig?.meta?.forexOnly) {
          const expiry = strategyLabFttExpiry(tf);
          const ftDir = /BUY/.test(String(sig.decision)) ? 'UP' : 'DOWN';
          rows.push({
            symbol, timeframe: tf, command: 'CALL',
            direction: ftDir,
            barIso: sig.barIso ?? null,
            score: sig.score ?? null, grade: sig.grade ?? null,
            reference: Number.isFinite(price) ? price : null,
            candleRead: fixedTimeCandleRead(ctx.candles, ftDir),
            expiryIso: expiry?.expiryIso ?? null, secondsToExpiry: expiry?.secondsToExpiry ?? null,
            tradeMinutes: expiry?.tradeMinutes ?? null, tradeTimeLabel: expiry?.tradeTimeLabel ?? null,
            durationLabel: expiry?.durationLabel ?? null, reason: sig.reason || null,
            dataFresh: fresh.dataFresh, sourceReceivedAt: fresh.sourceReceivedAt, staleSeconds: fresh.staleSeconds,
          });
        } else {
          rows.push({ symbol, timeframe: tf, command: 'HOLD', reference: Number.isFinite(price) ? price : null, dataFresh: fresh.dataFresh, sourceReceivedAt: fresh.sourceReceivedAt, staleSeconds: fresh.staleSeconds });
        }
      }
    }
    // CALL first (by score), then HOLD/NO-DATA.
    rows.sort((a, b) => {
      const rank = (r) => (r.command === 'CALL' ? 2 : r.command === 'HOLD' ? 1 : 0);
      return (rank(b) - rank(a)) || ((b.score || 0) - (a.score || 0));
    });
    await enrichLiveRowsWithFirstCall(rows, strategy, 'CALL');
    res.json({ ok: true, strategy, strategyName: STRATEGY_LAB_REGISTRY[strategy].name, timeframe: tfParam, expiryBars: STRATEGY_LAB_FT_EXPIRY_BARS, marketStatus: getForexMarketStatus(), rows, generatedAt: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live fixed-time position for a still-PENDING call (display only — never affects the
// recorded outcome). Compares the current price to the call's reference (the signal-bar
// close, same reference resolveStrategyFixedTime settles against) and reports whether the
// call is currently winning/losing + the live pips. Returns null once the call has settled.
function strategyLabFtLivePosition(row) {
  if (String(row.ft_outcome || '').toUpperCase() !== 'PENDING') return null;
  const candles = getRecentCandles(row.symbol, row.timeframe, 400);
  if (!candles || !candles.length) return null;
  const barMs = row.bar_time ? new Date(row.bar_time).getTime() : NaN;
  let sigIdx = -1;
  for (let i = 0; i < candles.length; i++) { if (Date.parse(candles[i].time) <= barMs) sigIdx = i; else break; }
  const ref = sigIdx >= 0 ? Number(candles[sigIdx].close) : Number(row.entry_price);
  const current = Number(candles[candles.length - 1].close);
  if (!Number.isFinite(ref) || !Number.isFinite(current)) return null;
  const pip = pipSizeForSymbol(row.symbol) || 0.0001;
  const up = /BUY/.test(String(row.direction).toUpperCase());
  const pips = Math.round(((up ? current - ref : ref - current) / pip) * 10) / 10;
  return {
    currentPrice: current, reference: ref, pips,
    status: pips > 0 ? 'WINNING' : pips < 0 ? 'LOSING' : 'FLAT',
  };
}

// GET /api/strategy-lab/signals?strategy=&timeframe=&limit= — recent logged signals.
app.get('/api/strategy-lab/signals', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });
  try {
    const strategy = req.query.strategy ? String(req.query.strategy) : null;
    const timeframe = req.query.timeframe ? String(req.query.timeframe).toUpperCase() : null;
    const includeMuted = req.query.includeMuted === '1' || req.query.includeMuted === 'true';
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 500));
    // A disabled strategy is hidden everywhere: even an explicit pick returns nothing
    // (unless includeMuted), so its signal log can't leak onto any visible surface.
    if (strategy && !includeMuted && strategyMuted(strategy)) {
      return res.json({ ok: true, signals: [] });
    }
    let sql = 'SELECT * FROM mt5_strategy_signals WHERE 1=1';
    const params = [];
    if (strategy) { sql += ' AND strategy = ?'; params.push(strategy); }       // explicit pick wins
    else if (!includeMuted) {                                                  // "all" view = enabled only
      const ids = enabledStrategyIds();
      if (ids.length) { sql += ` AND strategy IN (${ids.map(() => '?').join(',')})`; params.push(...ids); }
    }
    if (timeframe) { sql += ' AND timeframe = ?'; params.push(timeframe); }
    sql += ' ORDER BY signal_time DESC LIMIT ?'; params.push(limit);
    const [rows] = await pool.query(sql, params);
    const num = (v) => (v === null || v === undefined ? null : Number(v));
    res.json({
      ok: true,
      signals: rows.map((r) => {
        const sizing = strategyLabSizing(r.symbol, r.entry_price, r.stop_loss, { tp1: r.take_profit_1, tp2: r.take_profit_2, tp3: r.take_profit_3 });
        const measureFixedTime = strategySignalMeasuresFixedTime(r);
        return {
          id: r.id, strategy: r.strategy, symbol: r.symbol, timeframe: r.timeframe,
          signalTime: r.signal_time ? new Date(r.signal_time).toISOString() : null,
          direction: r.direction, score: num(r.score), grade: r.grade || null,
          // Score evolution: latest re-detected score/grade + when it last changed. Null until
          // a later scan computes a different score for the same signal bar (score/grade above
          // stay frozen at the first call — the honest basis).
          latestScore: num(r.latest_score), latestGrade: r.latest_grade || null,
          scoreUpdatedAt: r.score_updated_at ? new Date(r.score_updated_at).toISOString() : null,
          entryPrice: num(r.entry_price), stopLoss: num(r.stop_loss),
          takeProfit1: num(r.take_profit_1), takeProfit2: num(r.take_profit_2), takeProfit3: num(r.take_profit_3),
          riskReward: num(r.risk_reward), reason: r.reason,
          strategyVersion: r.strategy_version === null || r.strategy_version === undefined ? null : Number(r.strategy_version),
          setupPlan: r.setup_plan || strategySignalPlan(r),
          entryOrderType: r.entry_order_type || strategySignalOrderType(r),
          entryState: r.entry_state || null,
          entryFilledAt: r.entry_filled_at ? new Date(r.entry_filled_at).toISOString() : null,
          validUntil: r.valid_until ? new Date(r.valid_until).toISOString() : null,
          correctedOutcome: r.corrected_outcome || null,
          correctedPips: num(r.corrected_pips),
          correctionReason: r.correction_reason || null,
          lots: sizing?.suggestedLots ?? null, stopPips: sizing?.stopPips ?? null, lossAtStop: sizing?.lossAtStop ?? null,
          timing: strategyLabTiming(r),
          outcome: r.outcome, profitLossPips: num(r.profit_loss_pips), tpHitLevel: r.tp_hit_level === null ? null : Number(r.tp_hit_level),
          ftOutcome: measureFixedTime ? r.ft_outcome : null, ftPips: measureFixedTime ? num(r.ft_pips) : null,
          // As-traded (realistic) outcome alongside the idealized ft_outcome. atRefPrice null = logged
          // before this feature (no retroactive settle). atGapPips = how much the signal→entry delay cost.
          atOutcome: measureFixedTime ? (r.at_outcome || null) : null, atRefPrice: measureFixedTime ? num(r.at_ref_price) : null, atExitPrice: measureFixedTime ? num(r.at_exit_price) : null, atPips: measureFixedTime ? num(r.at_pips) : null,
          atGapPips: measureFixedTime && r.at_pips != null && r.ft_pips != null ? Math.round((Number(r.at_pips) - Number(r.ft_pips)) * 10) / 10 : null,
          atExpiryIso: measureFixedTime ? (r.at_expiry_time ? new Date(r.at_expiry_time).toISOString() : (() => { const st = r.signal_time ? new Date(r.signal_time).getTime() : NaN; const tfMs = (timeframeMinutes(r.timeframe) || 0) * 60000; return (Number.isFinite(st) && tfMs > 0) ? new Date(st + STRATEGY_LAB_FT_EXPIRY_BARS * tfMs).toISOString() : null; })()) : null,
          ftActionable: measureFixedTime ? (() => { const bt = r.bar_time ? new Date(r.bar_time).getTime() : NaN; const st = r.signal_time ? new Date(r.signal_time).getTime() : NaN; return (Number.isFinite(bt) && Number.isFinite(st)) ? strategyFtActionable(bt, r.timeframe, st) : null; })() : null,
          // Real fixed-time expiry (signal-bar close + expiry candles) so the live "just fired"
          // panel can show a true countdown and drop a call once its expiry has passed.
          ftExpiryIso: measureFixedTime ? (() => { const bt = r.bar_time ? new Date(r.bar_time).getTime() : NaN; const tfMs = (timeframeMinutes(r.timeframe) || 0) * 60000; return (Number.isFinite(bt) && tfMs > 0) ? new Date(bt + STRATEGY_LAB_FT_EXPIRY_BARS * tfMs).toISOString() : null; })() : null,
          live: measureFixedTime ? strategyLabFtLivePosition(r) : null,
          popupSent: r.popup_sent === null || r.popup_sent === undefined ? null : !!r.popup_sent,
          emailSent: r.email_sent === null || r.email_sent === undefined ? null : !!r.email_sent,
          resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
        };
      }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/strategy-lab/performance?days=  |  ?preset=today|yesterday|last7
// per-strategy forex + fixed-time win rates over the chosen window.
app.get('/api/strategy-lab/performance', async (req, res) => {
  try {
    const days = req.query.days ? Number(req.query.days) : 90;
    const preset = req.query.preset ? String(req.query.preset) : null;
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const includeMuted = req.query.includeMuted === '1' || req.query.includeMuted === 'true';
    const perf = await buildStrategyLabPerformance({ days, preset, from, to });
    if (!includeMuted) {
      const enabled = new Set(enabledStrategyIds());
      perf.strategies = (perf.strategies || []).filter((s) => enabled.has(s.id));
    }
    res.json({
      ok: true, ...perf,
      note: 'Each strategy is isolated (never blended with the live system). Scored two ways: forex (TP/SL) and fixed-time (direction at next-candle expiry). A strategy/timeframe is only trustworthy once its sample confidence is usable — don\'t crown a winner on a thin sample.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/strategy-lab/entry-watch — high-conviction ICT / ICT+ / SMC forex signals
// (grade A / A+, score ≥ threshold ~80) that are still PENDING entry, with LIVE price
// vs the limit entry so you can watch the moment price reaches entry. Read-only — never
// scores, settles, or sends anything. Powers the Signal Tracker "Entry Watch" tab.
// Keep the tracker aligned with the Strategy Lab registry. Every registered strategy
// returns a Forex/as-traded entry plan, even when its primary label is fixed-time.
// A hand-maintained subset went stale as new strategies shipped and hid them from filters.
const ENTRY_WATCH_STRATEGIES = Object.keys(STRATEGY_LAB_REGISTRY);
const ENTRY_WATCH_MIN_SCORE = Math.max(0, Number(process.env.STRATEGY_ENTRY_WATCH_MIN_SCORE || 80));
const ENTRY_WATCH_WINDOW_HOURS = Math.max(1, Number(process.env.STRATEGY_ENTRY_WATCH_WINDOW_HOURS || 48));
const ENTRY_WATCH_CACHE_MS = 1500;
const entryWatchResponseCache = new Map();
app.get('/api/strategy-lab/entry-watch', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });
  try {
    const csv = (value, transform = (v) => v) => String(value || '').split(',').map((v) => transform(v.trim())).filter(Boolean);
    const minRaw = Number(req.query.minScore);
    const maxRaw = Number(req.query.maxScore);
    const minScore = Number.isFinite(minRaw) ? Math.max(0, Math.min(100, minRaw)) : ENTRY_WATCH_MIN_SCORE;
    const maxScore = Number.isFinite(maxRaw) ? Math.max(minScore, Math.min(100, maxRaw)) : 100;
    const rawStrategies = csv(req.query.strategies);
    const requestedStrategies = [...new Set(rawStrategies.filter((id) => ENTRY_WATCH_STRATEGIES.includes(id)))].slice(0, ENTRY_WATCH_STRATEGIES.length);
    if (rawStrategies.length && !requestedStrategies.length) return res.status(400).json({ error: 'No valid strategies requested.' });
    const strategies = requestedStrategies.length ? requestedStrategies : ENTRY_WATCH_STRATEGIES;
    const allowedSymbols = new Set(getCuratedSymbols(getMt5Status().symbols).map((v) => String(v).toUpperCase()));
    const rawSymbols = csv(req.query.symbols, (v) => v.toUpperCase());
    const rawTimeframes = csv(req.query.timeframes, (v) => v.toUpperCase());
    const symbols = [...new Set(rawSymbols.filter((v) => allowedSymbols.has(v)))].slice(0, 25);
    const timeframes = [...new Set(rawTimeframes.filter((v) => STRATEGY_LAB_TIMEFRAMES.includes(v)))].slice(0, STRATEGY_LAB_TIMEFRAMES.length);
    if (rawSymbols.length && !symbols.length) return res.status(400).json({ error: 'No valid symbols requested.' });
    if (rawTimeframes.length && !timeframes.length) return res.status(400).json({ error: 'No valid timeframes requested.' });
    const cacheKey = JSON.stringify({ minScore, maxScore, strategies: [...strategies].sort(), symbols: [...symbols].sort(), timeframes: [...timeframes].sort() });
    const cached = entryWatchResponseCache.get(cacheKey);
    if (cached && Date.now() - cached.at < ENTRY_WATCH_CACHE_MS) return res.json(cached.payload);
    const placeholders = strategies.map(() => '?').join(',');
    let sql = `SELECT * FROM mt5_strategy_signals
      WHERE strategy IN (${placeholders})
        AND outcome = 'PENDING'
        AND COALESCE(entry_state, 'WAIT') NOT IN ('FILLED', 'EXPIRED')
        AND score >= ? AND score <= ?
        AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)`;
    const params = [...strategies, minScore, maxScore, ENTRY_WATCH_WINDOW_HOURS];
    if (symbols.length) {
      sql += ` AND symbol IN (${symbols.map(() => '?').join(',')})`;
      params.push(...symbols);
    }
    if (timeframes.length) {
      sql += ` AND timeframe IN (${timeframes.map(() => '?').join(',')})`;
      params.push(...timeframes);
    }
    sql += ' ORDER BY signal_time DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);
    const num = (v) => (v === null || v === undefined ? null : Number(v));
    // Per-request caches so re-evaluating the live strength never rebuilds the same
    // multi-timeframe context twice (several signals can share a symbol×timeframe).
    const ctxCache = new Map();    // `${symbol}|${tf}` → context | null
    const liveCache = new Map();   // `${strategy}|${symbol}|${tf}` → live sig | null
    const getCtx = (symbol, tf) => {
      const k = `${symbol}|${tf}`;
      if (!ctxCache.has(k)) { try { ctxCache.set(k, buildStrategyContext(symbol, tf)); } catch { ctxCache.set(k, null); } }
      return ctxCache.get(k);
    };
    const getLive = (strategy, symbol, tf) => {
      const k = `${strategy}|${symbol}|${tf}`;
      if (!liveCache.has(k)) {
        const ctx = getCtx(symbol, tf);
        let sig = null;
        try { sig = ctx ? evaluateStrategy(strategy, ctx) : null; } catch { sig = null; }
        liveCache.set(k, sig);
      }
      return liveCache.get(k);
    };
    const items = rows.filter((r) => strategyTimeframes(r.strategy).includes(String(r.timeframe).toUpperCase())).map((r) => {
      const pip = pipSizeForSymbol(r.symbol) || 0.0001;
      const buy = /BUY/.test(String(r.direction).toUpperCase());
      let current = null;
      try { const c = getRecentCandles(r.symbol, r.timeframe, 2); if (c && c.length) current = Number(c[c.length - 1].close); } catch { /* feed gap */ }
      const entry = num(r.entry_price);
      // Signed pips still needed to REACH the limit entry: >0 = price must come in toward
      // entry, ≤0 = price has reached / passed the entry. BUY fills on a pullback (price
      // drops to entry), SELL fills on a rally (price rises to entry).
      const pipsToEntry = (current != null && entry != null)
        ? Math.round(((buy ? current - entry : entry - current) / pip) * 10) / 10
        : null;
      const timing = strategyLabTiming(r);
      const entryStatus = timing.status === 'TRADABLE' ? 'AT_ENTRY'
        : timing.status === 'FILLED' ? 'FILLED'
        : timing.status === 'EXPIRED' ? 'MISSED'
        : 'WAIT';
      const sizing = strategyLabSizing(r.symbol, r.entry_price, r.stop_loss, { tp1: r.take_profit_1, tp2: r.take_profit_2, tp3: r.take_profit_3 });

      // ── CURRENT-TIME strength: re-run the strategy live and compare to the logged
      // strength so the row reflects how strong the setup is RIGHT NOW, not when it fired.
      const loggedScore = num(r.score);
      const live = getLive(r.strategy, r.symbol, r.timeframe);
      let currentScore = null, currentGrade = null, currentDirection = null, sameDir = false;
      if (live && live.decision && String(live.decision).toUpperCase() !== 'HOLD') {
        currentDirection = live.decision;
        currentScore = live.score ?? null;
        currentGrade = live.grade ?? null;
        sameDir = /BUY/.test(String(live.decision).toUpperCase()) === buy;
      }
      // STRONGER / SAME / WEAKER vs the logged score, or GONE when the setup no longer
      // confirms live (strategy now HOLDs or flipped direction).
      let strengthTrend;
      if (!sameDir || currentScore == null) strengthTrend = 'GONE';
      else if (loggedScore != null && currentScore >= loggedScore + 2) strengthTrend = 'STRONGER';
      else if (loggedScore != null && currentScore <= loggedScore - 2) strengthTrend = 'WEAKER';
      else strengthTrend = 'SAME';

      // Keep the original logged entry immutable. A live strategy re-evaluation may find
      // a fresher, more favorable same-direction entry as structure changes. Surface that
      // separately only when it improves price by >=1 pip, preserves RR, has a complete
      // live plan, and price has not already run materially through it.
      const liveEntryPrice = sameDir ? num(live?.entry) : null;
      const liveStopLoss = sameDir ? num(live?.stopLoss) : null;
      const liveTakeProfit1 = sameDir ? num(live?.takeProfit1) : null;
      const liveTakeProfit2 = sameDir ? num(live?.takeProfit2) : null;
      const liveTakeProfit3 = sameDir ? num(live?.takeProfit3) : null;
      const liveRiskReward = sameDir ? num(live?.riskRewardRatio) : null;
      const originalRiskReward = num(r.risk_reward);
      const entryImprovementPips = (entry != null && liveEntryPrice != null)
        ? Math.round(((buy ? entry - liveEntryPrice : liveEntryPrice - entry) / pip) * 10) / 10
        : null;
      const pipsToLiveEntry = (current != null && liveEntryPrice != null)
        ? Math.round(((buy ? current - liveEntryPrice : liveEntryPrice - current) / pip) * 10) / 10
        : null;
      const completeLivePlan = liveEntryPrice != null && liveStopLoss != null && liveTakeProfit1 != null;
      const rrPreserved = originalRiskReward == null
        ? true
        : liveRiskReward != null && liveRiskReward >= originalRiskReward - 0.05;
      const notRunPast = pipsToLiveEntry == null || pipsToLiveEntry >= -1;
      const betterEntryAvailable = Boolean(sameDir && completeLivePlan && rrPreserved && notRunPast && entryImprovementPips != null && entryImprovementPips >= 1);
      const betterEntryPrice = betterEntryAvailable ? liveEntryPrice : null;
      const pipsToBetterEntry = betterEntryAvailable ? pipsToLiveEntry : null;
      const activeEntryPrice = betterEntryAvailable ? liveEntryPrice : entry;
      const pipsToActiveEntry = betterEntryAvailable ? pipsToLiveEntry : pipsToEntry;
      const betterSizing = betterEntryAvailable
        ? strategyLabSizing(r.symbol, liveEntryPrice, liveStopLoss, { tp1: liveTakeProfit1, tp2: liveTakeProfit2, tp3: liveTakeProfit3 })
        : null;
      const activeAtEntry = entryStatus !== 'FILLED'
        && pipsToActiveEntry != null && pipsToActiveEntry <= 0 && pipsToActiveEntry >= -1;

      // ── Executability verdict: take it now, wait for a better position, or be cautious.
      let executability, execMessage;
      if (entryStatus === 'MISSED') {
        executability = 'MISSED';
        execMessage = timing.message;
      } else if (entryStatus === 'FILLED') {
        // Filled = the trade is LIVE, not executable-later; the Signal Tracker owns it now.
        executability = 'FILLED';
        execMessage = timing.message;
      } else if (activeAtEntry) {
        if (strengthTrend === 'GONE') {
          executability = 'CAUTION';
          execMessage = 'Price is at the active entry but the setup no longer confirms live — be cautious / skip.';
        } else {
          executability = 'EXECUTE_NOW';
          execMessage = `Executable now — price at ${betterEntryAvailable ? 'the better live entry' : 'the original entry'} and the setup still confirms (${currentGrade || '—'} ${currentScore != null ? Math.round(currentScore) : '—'}).`;
        }
      } else { // WAIT — price not yet at the limit entry
        const away = pipsToActiveEntry != null ? Math.abs(pipsToActiveEntry) : null;
        if (strengthTrend === 'GONE') {
          executability = 'CAUTION';
          execMessage = `Wait — the live setup has weakened; only take it if it re-confirms when price reaches entry${away != null ? ` (${away}p away)` : ''}.`;
        } else {
          executability = 'WAIT';
          execMessage = `Wait for a better position — ${away != null ? `${away}p ` : ''}${buy ? 'pullback' : 'rally'} to ${betterEntryAvailable ? 'better live entry' : 'entry'} ${px(activeEntryPrice, r.symbol)}.`;
        }
      }

      return {
        id: r.id, strategy: r.strategy,
        strategyName: STRATEGY_LAB_REGISTRY[r.strategy]?.name || r.strategy,
        symbol: r.symbol, timeframe: r.timeframe,
        signalTime: r.signal_time ? new Date(r.signal_time).toISOString() : null,
        direction: r.direction, score: loggedScore, grade: r.grade || null,
        currentScore, currentGrade, currentDirection, strengthTrend,
        executability, execMessage,
        entryPrice: entry, currentPrice: current, pipsToEntry,
        liveEntryPrice, liveStopLoss, liveTakeProfit1, liveTakeProfit2, liveTakeProfit3, liveRiskReward,
        betterEntryAvailable, betterEntryPrice,
        betterStopLoss: betterEntryAvailable ? liveStopLoss : null,
        betterTakeProfit1: betterEntryAvailable ? liveTakeProfit1 : null,
        betterTakeProfit2: betterEntryAvailable ? liveTakeProfit2 : null,
        betterTakeProfit3: betterEntryAvailable ? liveTakeProfit3 : null,
        betterRiskReward: betterEntryAvailable ? liveRiskReward : null,
        betterLots: betterSizing?.suggestedLots ?? null,
        betterLossAtStop: betterSizing?.lossAtStop ?? null,
        entryImprovementPips: betterEntryAvailable ? entryImprovementPips : null,
        pipsToBetterEntry, activeEntryPrice, pipsToActiveEntry,
        stopLoss: num(r.stop_loss),
        takeProfit1: num(r.take_profit_1), takeProfit2: num(r.take_profit_2), takeProfit3: num(r.take_profit_3),
        riskReward: num(r.risk_reward),
        lots: sizing?.suggestedLots ?? null, lossAtStop: sizing?.lossAtStop ?? null,
        activeLots: betterSizing?.suggestedLots ?? sizing?.suggestedLots ?? null,
        activeLossAtStop: betterSizing?.lossAtStop ?? sizing?.lossAtStop ?? null,
        entryStatus, reachedEntry: entryStatus === 'FILLED' || activeAtEntry,
        executableNow: executability === 'EXECUTE_NOW',
        timingMessage: timing.message, filledAtIso: timing.filledAtIso || null, reason: r.reason || null,
        popupSent: r.popup_sent == null ? null : !!r.popup_sent,
        emailSent: r.email_sent == null ? null : !!r.email_sent,
      };
    });
    // Keep this GET read-only. Dynamically detected fills disappear from Entry Watch;
    // Signal Tracker independently detects and persists the same handoff when opened.
    const visibleItems = items.filter((item) => item.entryStatus !== 'FILLED');

    // Nearest active entry first. The active entry is the verified better live entry when
    // available, otherwise the immutable original. Actionability and strength break ties.
    const rank = (s) => (s === 'EXECUTE_NOW' ? 3 : s === 'WAIT' ? 2 : s === 'CAUTION' ? 1 : 0);
    visibleItems.sort((a, b) => (Math.abs(a.pipsToActiveEntry ?? 1e9) - Math.abs(b.pipsToActiveEntry ?? 1e9))
      || (rank(b.executability) - rank(a.executability))
      || ((b.currentScore ?? b.score ?? 0) - (a.currentScore ?? a.score ?? 0))
      || (Date.parse(b.signalTime || '') - Date.parse(a.signalTime || '')));
    const payload = {
      ok: true, minScore, maxScore, windowHours: ENTRY_WATCH_WINDOW_HOURS,
      filters: { strategies, symbols, timeframes },
      strategies: ENTRY_WATCH_STRATEGIES, items: visibleItems, generatedAt: new Date().toISOString(),
    };
    entryWatchResponseCache.set(cacheKey, { at: Date.now(), payload });
    if (entryWatchResponseCache.size > 50) entryWatchResponseCache.delete(entryWatchResponseCache.keys().next().value);
    res.json(payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// TEMP test utility: render the REAL strategy-lab advisory emails (forex + fixed-time)
// from a sample signal so you can preview the format. POST /api/strategy-lab/test-email
// ?strategy=&symbol=&timeframe=&dir=BUY|SELL . Safe to remove — sends only to the
// configured alert recipient; does not log, score, or affect any strategy.
app.post('/api/strategy-lab/test-email', async (req, res) => {
  try {
    const strategy = req.query.strategy ? String(req.query.strategy) : 'little-rizzy';
    const isGoldDesk = strategy === 'xau-session-raid';
    const symbol = (req.query.symbol ? String(req.query.symbol) : (isGoldDesk ? 'XAUUSDM' : 'EURUSDM')).toUpperCase();
    const tf = (req.query.timeframe ? String(req.query.timeframe) : (isGoldDesk ? 'M15' : 'M30')).toUpperCase();
    const buy = String(req.query.dir || (isGoldDesk ? 'BUY' : 'SELL')).toUpperCase() === 'BUY';
    let sig;
    if (isGoldDesk) {
      // Gold-realistic sample: round-number raid, reclaimed, displacement, FVG pullback entry.
      const entry = buy ? 4002.80 : 4047.20;
      const stop = buy ? 3996.40 : 4053.60;
      const risk = Math.abs(entry - stop);
      const tp1 = buy ? entry + risk : entry - risk;
      const tp2 = buy ? entry + 2 * risk : entry - 2 * risk;
      const tp3 = buy ? 4031.50 : 4018.50;
      sig = {
        decision: buy ? 'BUY' : 'SELL', score: 87, grade: 'A+',
        entry, stopLoss: stop, takeProfit1: tp1, takeProfit2: tp2, takeProfit3: tp3,
        riskRewardRatio: Math.round((Math.abs(entry - tp3) / risk) * 100) / 100,
        reason: 'TEST sample — Gold Desk raid preview',
        barIso: new Date().toISOString(),
        meta: {
          raidedLevel: { type: 'ROUND_NUMBER', label: buy ? 'Round 4000' : 'Round 4050', price: buy ? 4000 : 4050, strength: 5 },
          sweepLevel: buy ? 4000 : 4050, sweepExtreme: buy ? 3997.6 : 4052.4, dispAtr: 1.4,
          entryMode: 'FVG 50% pullback', session: 'OVERLAP', h4Trend: buy ? 'BULLISH' : 'BEARISH', h1Trend: buy ? 'BULLISH' : 'BEARISH',
        },
      };
    } else {
      // Realistic forex sample (EURUSD-style numbers): measured-move continuation.
      const entry = 1.08500;
      const stop = buy ? 1.08320 : 1.08680;
      const tp1 = buy ? 1.08680 : 1.08320;
      const tp2 = buy ? 1.08860 : 1.08140;
      const tp3 = buy ? 1.09800 : 1.07200;
      sig = {
        decision: buy ? 'BUY' : 'SELL', score: 88, grade: 'A+',
        entry, stopLoss: stop, takeProfit1: tp1, takeProfit2: tp2, takeProfit3: tp3,
        riskRewardRatio: Math.round((Math.abs(entry - tp3) / Math.abs(stop - entry)) * 100) / 100,
        reason: 'TEST sample — pullback to a lower/higher extreme after an impulse; measured-move continuation',
        barIso: new Date().toISOString(),
        meta: { measuredMove: Math.abs(entry - tp3), bbMid: 1.0855, bbUpper: 1.0875, bbLower: 1.0835, legAgeBars: 1 },
      };
    }
    const id = `test:${Date.now()}`;
    await emitStrategyLabSignal({ id, strategy, symbol, timeframe: tf, sig, popup: false, email: true, kind: 'NEW' });
    // Gold Desk is forex-only by design — no fixed-time preview for it.
    if (!isGoldDesk) await emitStrategyLabFttSignal({ id: `${id}:ftt`, strategy, symbol, timeframe: tf, sig, refClose: sig.entry, popup: false, email: true, kind: 'NEW' });
    res.json({ ok: true, sentTo: signalEmailTo(), alertsEnabled: SIGNAL_ALERTS_ENABLED, strategy, symbol, timeframe: tf, dir: buy ? 'BUY' : 'SELL' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Breakout tracker (read-only views for the dedicated /breakout page) ─────
// GET /api/breakout/live?timeframe=ALL|M5|M15|… — scan curated symbols × breakout
// timeframes and return every ACTIVE candidate (PRE approaching a strong level /
// CONFIRMED decisive break) on a well-formed chart, graded A+/A/B/C. Uses the SAME
// pure detector the alert scanner uses; never mutates state or sends anything.
// C-grade is INCLUDED here (the alert scanner drops it) so the page also shows
// setups that are still forming and have not yet earned an alert.
app.get('/api/breakout/live', (req, res) => {
  try {
    const tfParam = (req.query.timeframe ? String(req.query.timeframe) : 'ALL').toUpperCase();
    const tfs = tfParam === 'ALL' ? BREAKOUT_TIMEFRAMES : [tfParam];
    const symbols = getCuratedSymbols(getMt5Status().symbols);
    const browserMinRank = BREAKOUT_GRADE_RANK[BREAKOUT_BROWSER_MIN_GRADE] ?? BREAKOUT_GRADE_RANK.B;
    const emailMinGrade = String(loadEmailAlertSettings().breakoutEmailMinGrade || 'A').toUpperCase();
    const rows = [];
    for (const symbol of symbols) {
      for (const tf of tfs) {
        if (!BREAKOUT_TIMEFRAMES.includes(tf)) continue;
        let candles;
        try { candles = getRecentCandles(symbol, tf, 200); } catch { candles = null; }
        if (!candles || candles.length < 40) continue;
        const latest = candles[candles.length - 1];
        const fresh = isCandleCurrent(latest, tf);
        let cand = null;
        try {
          cand = buildBreakoutCandidate({ symbol, timeframe: tf, candles }, {
            approachAtr: BREAKOUT_APPROACH_ATR,
            minBreakBodyAtr: BREAKOUT_MIN_BREAK_BODY_ATR,
          });
        } catch { /* per-symbol resilience */ }
        if (!cand) continue;
        rows.push({
          symbol, timeframe: tf,
          phase: cand.phase, direction: cand.direction, trend: cand.trend,
          grade: cand.grade, score: cand.score,
          level: cand.level, levelStrength: cand.levelStrength,
          price: cand.price, atr: cand.atr,
          distanceAtr: cand.distanceAtr, bodyAtr: cand.bodyAtr,
          displacement: cand.displacement
            ? { present: cand.displacement.present, strong: cand.displacement.strong }
            : null,
          reasons: cand.reasons, bar: cand.bar, stale: !fresh,
          meetsBrowserBar: (BREAKOUT_GRADE_RANK[cand.grade] ?? 0) >= browserMinRank,
        });
      }
    }
    // CONFIRMED first, then by grade rank, then score → strongest setups on top.
    rows.sort((a, b) => {
      const ph = (r) => (r.phase === 'CONFIRMED' ? 1 : 0);
      return (ph(b) - ph(a))
        || ((BREAKOUT_GRADE_RANK[b.grade] ?? 0) - (BREAKOUT_GRADE_RANK[a.grade] ?? 0))
        || (b.score - a.score);
    });
    res.json({
      ok: true, enabled: BREAKOUT_ENABLED, timeframe: tfParam,
      timeframes: BREAKOUT_TIMEFRAMES,
      browserMinGrade: BREAKOUT_BROWSER_MIN_GRADE, emailMinGrade,
      confirmed: rows.filter((r) => r.phase === 'CONFIRMED').length,
      pre: rows.filter((r) => r.phase === 'PRE').length,
      rows, generatedAt: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/breakout/alerts?limit=&symbol= — recent persisted breakout alerts that
// were actually surfaced (track record of what fired + on which channel). Browser
// alerts persist as BROWSER; emails upgrade the row's channel to EMAIL.
app.get('/api/breakout/alerts', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 150, 500));
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    let sql = 'SELECT * FROM mt5_breakout_alerts WHERE 1=1';
    const params = [];
    if (symbol) { sql += ' AND symbol = ?'; params.push(symbol); }
    sql += ' ORDER BY created_at DESC LIMIT ?'; params.push(limit);
    const [rows] = await pool.query(sql, params);
    const num = (v) => (v === null || v === undefined ? null : Number(v));
    res.json({
      ok: true,
      alerts: rows.map((r) => ({
        id: r.id, symbol: r.symbol, timeframe: r.timeframe, phase: r.phase,
        direction: r.direction, grade: r.grade, score: num(r.score), trend: r.trend,
        level: num(r.level),
        levelStrength: r.level_strength === null || r.level_strength === undefined ? null : Number(r.level_strength),
        price: num(r.price), atr: num(r.atr), distanceAtr: num(r.distance_atr), bodyAtr: num(r.body_atr),
        displacement: !!r.displacement, channel: r.channel,
        barTime: r.bar_time ? new Date(r.bar_time).toISOString() : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/breakout/tracking?windowHours=&timeframe= — CONFIRMED breakouts with LIVE
// follow-through status. Pure read-side replay (no schema change): each recent confirmed
// alert is measured against current candles to show whether the break EXTENDED or FAILED.
// active = still developing (FOLLOWING_THROUGH / STALLING); settled = TARGET_HIT / FAILED.
app.get('/api/breakout/tracking', async (req, res) => {
  const pool = await initializeDatabase();
  if (!pool) return res.status(500).json({ error: 'Database not available.' });
  try {
    const windowHours = Math.max(1, Math.min(Number(req.query.windowHours) || 72, 240));
    const tfParam = (req.query.timeframe ? String(req.query.timeframe) : 'ALL').toUpperCase();
    const [rows] = await pool.query(
      "SELECT * FROM mt5_breakout_alerts WHERE phase='CONFIRMED' AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR) ORDER BY bar_time ASC, created_at ASC",
      [windowHours],
    );
    // One entry per distinct breakout: earliest confirm per (symbol,tf,direction,level).
    const seen = new Map();
    for (const r of rows) {
      if (tfParam !== 'ALL' && String(r.timeframe).toUpperCase() !== tfParam) continue;
      const key = `${r.symbol}|${r.timeframe}|${r.direction}|${Number(r.level).toFixed(5)}`;
      if (!seen.has(key)) seen.set(key, r);                 // rows ASC → keep the first (origin) confirm
    }
    const active = [], settled = [];
    for (const r of seen.values()) {
      let candles; try { candles = getRecentCandles(r.symbol, r.timeframe, 200); } catch { candles = null; }
      if (!candles || candles.length < 5) continue;
      const ft = breakoutFollowThrough(
        { direction: r.direction, level: r.level, price: r.price, atr: r.atr, barTime: r.bar_time ? new Date(r.bar_time).toISOString() : null },
        candles,
      );
      if (!ft) continue;
      const pip = pipSizeForSymbol(r.symbol) || 0.0001;
      const confirmIso = r.bar_time ? new Date(r.bar_time).toISOString() : (r.created_at ? new Date(r.created_at).toISOString() : null);
      const ageMs = confirmIso ? Date.now() - Date.parse(confirmIso) : null;
      const latest = candles[candles.length - 1];
      const entry = {
        id: r.id, symbol: r.symbol, timeframe: r.timeframe, direction: r.direction, trend: r.trend,
        grade: r.grade, score: Number(r.score), levelStrength: r.level_strength === null ? null : Number(r.level_strength),
        confirmIso, ageHours: ageMs != null ? Math.round((ageMs / 3.6e6) * 10) / 10 : null,
        stale: !isCandleCurrent(latest, r.timeframe),
        ...ft,
        beyondPips: Math.round((ft.beyond / pip) * 10) / 10,
        mfePips: Math.round((ft.mfe / pip) * 10) / 10,
        maePips: Math.round((ft.mae / pip) * 10) / 10,
      };
      (ft.state === 'TARGET_HIT' || ft.state === 'FAILED' ? settled : active).push(entry);
    }
    active.sort((a, b) => (b.progressPct - a.progressPct) || (b.score - a.score));
    settled.sort((a, b) => Date.parse(b.confirmIso || 0) - Date.parse(a.confirmIso || 0));
    const targetHit = settled.filter((s) => s.state === 'TARGET_HIT').length;
    const failed = settled.filter((s) => s.state === 'FAILED').length;
    res.json({
      ok: true, timeframe: tfParam, windowHours, active, settled,
      stats: { active: active.length, targetHit, failed, winRate: (targetHit + failed) ? Math.round((targetHit / (targetHit + failed)) * 100) : null },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function startStrategyLabScanner() {
  const timer = setInterval(() => void runStrategyLabScan(), STRATEGY_LAB_SCAN_MS);
  if (typeof timer.unref === 'function') timer.unref();
  setTimeout(() => void runStrategyLabScan(), 25000);
  const prune = setInterval(() => void pruneStrategyLabSignals(), 6 * 60 * 60 * 1000);
  if (typeof prune.unref === 'function') prune.unref();
  console.log(`[StrategyLab] Scanner started — ${Object.keys(STRATEGY_LAB_REGISTRY).length} strategies × ${STRATEGY_LAB_TIMEFRAMES.join(',')} every ${Math.round(STRATEGY_LAB_SCAN_MS / 60000)}m.`);
}
startStrategyLabScanner();


let reminderSchedulerRunning = false;

async function processProjectionReminders() {
  const pool = await initializeDatabase();
  if (!pool) return;

  const nowMs = Date.now();

  try {
    const [pendingReminders] = await pool.query("SELECT * FROM mt5_projection_reminders WHERE status = 'PENDING'");
    for (const rem of pendingReminders) {
      const touchTimeMs = new Date(rem.projected_touch_time).getTime();
      const timeToTouchMs = touchTimeMs - nowMs;
      
      if (timeToTouchMs <= 10 * 60 * 1000) {
        console.log(`[Reminders] Running T-10m check for reminder ${rem.id} (${rem.symbol} ${rem.timeframe})`);
        
        let isStillValid = false;
        let currentPrice = null;
        let currentScore = null;
        let currentGrade = 'No Setup';
        let aiResult = null;
        
        try {
          const candleList = getRecentCandles(rem.symbol, rem.timeframe, 300);
          if (candleList && candleList.length >= 20) {
            const latestCandle = candleList[candleList.length - 1];
            currentPrice = Number(latestCandle?.close) || null;
            
            const h4Candles = getRecentCandles(rem.symbol, 'H4', 150);
            const h1Candles = getRecentCandles(rem.symbol, 'H1', 150);
            const freshProjection = computeProjections({
              symbol: rem.symbol,
              timeframe: rem.timeframe,
              candles: candleList,
              h4Candles,
              h1Candles,
              nowMs
            });
            
            const matchingProj = freshProjection.projections.find(
              p => p.id === rem.projection_id || Math.abs(p.entryPrice - rem.entry_price) < 0.00001
            );
            if (matchingProj) {
              isStillValid = true;
            }
            
            const { adr, dailyHighLow } = computeAdrDaily(rem.symbol);
            const summary = aggregateSignals({
              symbol: rem.symbol,
              timeframe: rem.timeframe,
              candles: candleList,
              indicators: getRecentIndicators(rem.symbol, rem.timeframe, 500),
              marketLevels,
              accountSnapshot: mt5State.accountSnapshot,
              adr,
              dailyHighLow,
              h4Candles,
              h1Candles,
            });
            
            if (summary && summary.systemDecision) {
              currentScore = summary.systemDecision.compositeScore || 0;
              currentGrade = summary.systemDecision.grade || 'No Setup';
            }
            
            if (rem.ai_on && freshProjection.projections.length > 0) {
              const context = {
                indicators: summary.indicatorsSnapshot || {},
                structure: summary.systemDecision?.htfBias ? `HTF ${summary.systemDecision.htfBias}` : 'n/a',
                regime: summary.systemDecision?.regime || 'n/a',
                adx: summary.systemDecision?.adxValue ?? null,
                adrUsagePercent: summary.systemDecision?.adrUsagePercent ?? null,
                adrExhausted: !!summary.systemDecision?.adrExhausted,
                recentCandles: (summary.marketContext?.recentCandles || []).slice(-15).map((c) => ({
                  time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
                })),
              };
              
              const ai = await analyzeProjectionWithGemini({
                projectId: GOOGLE_CLOUD_PROJECT,
                location: GOOGLE_CLOUD_LOCATION,
                model: GEMINI_MODEL,
                symbol: rem.symbol,
                timeframe: rem.timeframe,
                currentPrice: freshProjection.currentPrice,
                atr: freshProjection.atr,
                htfTrend: freshProjection.htfTrend,
                projections: freshProjection.projections,
                context,
              });
              
              if (ai && ai.validations) {
                const matchVal = ai.validations.find(v => v.id === rem.projection_id);
                aiResult = {
                  status: matchVal?.status || 'NEUTRAL',
                  confidence: matchVal?.confidence || 0,
                  rationale: matchVal?.rationale || '',
                  overall_summary: ai.overall_summary || ''
                };
              }
            }
          }
        } catch (checkErr) {
          console.error(`[Reminders] Error during T-10m check for reminder ${rem.id}:`, checkErr.message);
        }
        
        const checkResult = {
          checkedAt: new Date().toISOString(),
          isStillValid,
          currentPrice,
          currentScore,
          currentGrade,
          aiResult
        };
        
        await pool.execute(
          "UPDATE mt5_projection_reminders SET status = 'CHECKED', check_result_json = ? WHERE id = ?",
          [JSON.stringify(checkResult), rem.id]
        );
        console.log(`[Reminders] T-10m check complete for reminder ${rem.id}. Valid: ${isStillValid}`);
      }
    }
  } catch (err) {
    console.error("[Reminders] Error in pending check phase:", err.message);
  }

  try {
    const [checkedReminders] = await pool.query("SELECT * FROM mt5_projection_reminders WHERE status = 'CHECKED'");
    for (const rem of checkedReminders) {
      const touchTimeMs = new Date(rem.projected_touch_time).getTime();
      const timeToTouchMs = touchTimeMs - nowMs;
      
      if (timeToTouchMs <= 5 * 60 * 1000) {
        console.log(`[Reminders] Sending T-5m reminder email for ${rem.id} (${rem.symbol} ${rem.timeframe})`);
        
        const checkResult = JSON.parse(rem.check_result_json || '{}');
        const isStillValid = checkResult.isStillValid;
        
        const validationLabel = isStillValid ? 'VALID' : 'INVALID/MITIGATED';
        const subject = `[REMINDER] ${rem.symbol} (${rem.timeframe}) Pullback Target — Touch in ~5m [${validationLabel}]`;
        
        const originalTouchTimeStr = formatAppDateTime(rem.projected_touch_time);
        
        const isBuy = rem.bias === 'BULLISH';
        const orderTypeStr = isBuy ? 'BUY LIMIT' : 'SELL LIMIT';
        const tradeTypeStr = rem.suitability_ftt ? `Fixed-Time Trade (FTT · ${rem.suitability_ftt_expiry} expiry)` : 'Forex Trade (FT)';
        const rationaleText = rem.rationale || 'n/a';
        
        let aiDetailsText = '';
        let aiDetailsHtml = '';
        if (rem.ai_on && checkResult.aiResult) {
          const ai = checkResult.aiResult;
          aiDetailsText = `
AI Validation Status: ${ai.status} (${ai.confidence}%)
AI Summary: ${ai.overall_summary || 'n/a'}
AI Rationale: ${ai.rationale || 'n/a'}`;
          
          aiDetailsHtml = `
            <div style="margin-top: 15px; padding: 12px; border: 1px solid #ddd6fe; background-color: #f5f3ff; border-radius: 8px;">
              <h4 style="margin: 0 0 6px; color: #6d28d9;">✨ Gemini AI Re-Validation (at T-10m)</h4>
              <p style="margin: 0 0 4px; font-size: 13px;">Status: <b style="color: ${ai.status === 'APPROVED' ? '#047857' : ai.status === 'REJECTED' ? '#b91c1c' : '#4b5563'}">${ai.status}</b> (${Math.round(ai.confidence)}%)</p>
              ${ai.overall_summary ? `<p style="margin: 0 0 4px; font-size: 12px; color: #4c1d95;"><b>Summary:</b> ${ai.overall_summary}</p>` : ''}
              ${ai.rationale ? `<p style="margin: 0; font-size: 12px; color: #5b21b6;"><b>Rationale:</b> ${ai.rationale}</p>` : ''}
            </div>`;
        } else if (rem.ai_on) {
          aiDetailsText = `\nAI Validation: Not available (checking error)`;
          aiDetailsHtml = `<div style="margin-top: 15px; color: #9a3412; font-size: 12px;">⚠ AI Validation was enabled but failed to complete during checking.</div>`;
        }

        const text = `
AURA GOLD — PROJECTION ENTRY REMINDER
---------------------------------------------
Symbol: ${rem.symbol} (${rem.timeframe})
Order Type: ${orderTypeStr} (${rem.bias})
Projected Touch Time: ${originalTouchTimeStr} (Bangladesh Time)
Time Remaining: ~5 minutes

ZONE STATUS (Checked at T-10m): ${validationLabel}
---------------------------------------------
Current Price at Check: ${px(checkResult.currentPrice, rem.symbol)}
Current Score: ${checkResult.currentScore !== null ? Math.round(checkResult.currentScore) : 'n/a'}/100
Current Grade: ${checkResult.currentGrade}
Is Setup Still Valid? ${isStillValid ? 'YES' : 'NO (Price already mitigated or zone invalidated)'}
${aiDetailsText}

TRADE PARAMETERS:
---------------------------------------------
Entry Price: ${px(rem.entry_price, rem.symbol)}
Stop Loss: ${px(rem.stop_loss, rem.symbol)}
Take Profit 1: ${px(rem.take_profit_1, rem.symbol)}
Take Profit 2: ${px(rem.take_profit_2, rem.symbol)}
Trade Recommendation: ${tradeTypeStr}
Math Confidence (Initial): ${rem.math_confidence}/100 (Grade: ${rem.grade})
Initial Rationale: ${rationaleText}

Advisory only — not financial advice. Manage your own risk.
`;

        const html = `
          <div style="font-family: Arial, sans-serif; max-width: 680px; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; color: #1e293b;">
            <div style="border-bottom: 2px solid ${isStillValid ? '#10b981' : '#f43f5e'}; padding-bottom: 12px; margin-bottom: 15px;">
              <h2 style="margin: 0; color: ${isStillValid ? '#059669' : '#e11d48'}; font-size: 20px;">
                ${isStillValid ? '🔔 [VALID]' : '⚠ [INVALID/MITIGATED]'} Pullback Target Reminder
              </h2>
              <p style="margin: 4px 0 0; color: #64748b; font-size: 13px;">
                ${rem.symbol} (${rem.timeframe}) · Touch projected at <b>${originalTouchTimeStr}</b> (Bangladesh Time)
              </p>
            </div>
            
            <div style="background-color: ${isStillValid ? '#ecfdf5' : '#fff5f5'}; border: 1px solid ${isStillValid ? '#a7f3d0' : '#fed7d7'}; border-radius: 8px; padding: 12px; margin-bottom: 15px;">
              <h3 style="margin: 0 0 6px; font-size: 14px; color: ${isStillValid ? '#065f46' : '#991b1b'};">Market Re-check Results (at T-10m)</h3>
              <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
                <tr>
                  <td style="padding: 3px 0; color: #64748b;">Current Price:</td>
                  <td><b>${px(checkResult.currentPrice, rem.symbol)}</b></td>
                </tr>
                <tr>
                  <td style="padding: 3px 0; color: #64748b;">Current Score / Grade:</td>
                  <td><b style="color: ${checkResult.currentScore >= 65 ? '#059669' : '#475569'}">${checkResult.currentScore !== null ? Math.round(checkResult.currentScore) : 'n/a'} / 100</b> (${checkResult.currentGrade})</td>
                </tr>
                <tr>
                  <td style="padding: 3px 0; color: #64748b;">Zone Still Valid?</td>
                  <td>
                    <span style="font-weight: bold; color: ${isStillValid ? '#059669' : '#e11d48'};">
                      ${isStillValid ? 'YES' : 'NO — Mitigated / Invalidated'}
                    </span>
                  </td>
                </tr>
              </table>
            </div>

            ${aiDetailsHtml}

            <h3 style="font-size: 14px; margin: 15px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; color: #334155;">Trade Parameters</h3>
            <table style="width: 100%; font-size: 13px; border-collapse: collapse; margin-bottom: 15px;">
              <tr>
                <td style="padding: 4px 0; color: #64748b; width: 140px;">Order Type:</td>
                <td><b style="color: ${isBuy ? '#059669' : '#e11d48'};">${orderTypeStr}</b></td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #64748b;">Entry Price:</td>
                <td><b style="font-family: monospace; font-size: 14px;">${px(rem.entry_price, rem.symbol)}</b></td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #64748b;">Stop Loss (SL):</td>
                <td><b style="font-family: monospace; color: #e11d48;">${px(rem.stop_loss, rem.symbol)}</b></td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #64748b;">TP1 / TP2:</td>
                <td><b style="font-family: monospace; color: #059669;">${px(rem.take_profit_1, rem.symbol)} / ${px(rem.take_profit_2, rem.symbol)}</b></td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #64748b;">Recommendation:</td>
                <td><b>${tradeTypeStr}</b></td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #64748b;">Initial Confidence:</td>
                <td>${rem.math_confidence} / 100 (${rem.grade})</td>
              </tr>
            </table>

            <p style="font-size: 12px; color: #64748b; font-style: italic; margin-bottom: 15px;">
              <b>Initial Rationale:</b> ${rationaleText}
            </p>

            <div style="font-size: 11px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 10px; margin-top: 15px; text-align: center;">
              Advisory only — not financial advice. Manage your own risk. — Aura Gold Alert System
            </div>
          </div>`;

        try {
          await sendNotificationEmail({
            to: rem.email,
            subject,
            text,
            html,
            signalId: `reminder:${rem.id}`
          });
          
          await pool.execute(
            "UPDATE mt5_projection_reminders SET status = 'SENT' WHERE id = ?",
            [rem.id]
          );
          console.log(`[Reminders] Reminder ${rem.id} sent successfully to ${rem.email}`);
        } catch (sendErr) {
          console.error(`[Reminders] Failed to send reminder email ${rem.id}:`, sendErr.message);
          await pool.execute(
            "UPDATE mt5_projection_reminders SET status = 'FAILED' WHERE id = ?",
            [rem.id]
          );
        }
      }
    }
  } catch (err) {
    console.error("[Reminders] Error in send phase:", err.message);
  }
}

async function processSavedProjections() {
  const pool = await initializeDatabase();
  if (!pool) return;

  const nowMs = Date.now();

  try {
    const [pendingSaved] = await pool.query("SELECT * FROM mt5_saved_projections WHERE status = 'PENDING'");
    for (const rem of pendingSaved) {
      const creationTime = new Date(rem.created_at).getTime();
      const ageHrs = (nowMs - creationTime) / (3600 * 1000);
      
      if (ageHrs > 48) {
        await pool.execute(
          "UPDATE mt5_saved_projections SET status = 'EXPIRED', resolved_at = ? WHERE id = ?",
          [toMysqlDate(), rem.id]
        );
        console.log(`[SavedProjections] Auto-expired setup ${rem.id} (exceeded 48h limit).`);
        continue;
      }

      const candles = getRecentCandles(rem.symbol, rem.timeframe, 1000);
      if (!candles || candles.length < 2) continue;

      const sorted = [...candles].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
      
      const laterCandles = sorted.filter(c => new Date(c.time).getTime() >= creationTime);
      if (!laterCandles.length) continue;

      let entered = false;
      let outcome = 'PENDING';
      let resolvedTime = null;

      for (const candle of laterCandles) {
        const low = Number(candle.low);
        const high = Number(candle.high);
        if (isNaN(low) || isNaN(high)) continue;

        if (!entered) {
          if (rem.bias === 'BULLISH') {
            if (low <= Number(rem.entry_price)) {
              entered = true;
            }
          } else {
            if (high >= Number(rem.entry_price)) {
              entered = true;
            }
          }
        }

        if (entered) {
          if (rem.bias === 'BULLISH') {
            const hitSl = low <= Number(rem.stop_loss);
            const hitTp = high >= Number(rem.take_profit_1);
            if (hitSl && hitTp) {
              outcome = 'LOSS';
              resolvedTime = candle.time;
              break;
            } else if (hitSl) {
              outcome = 'LOSS';
              resolvedTime = candle.time;
              break;
            } else if (hitTp) {
              outcome = 'WIN';
              resolvedTime = candle.time;
              break;
            }
          } else {
            const hitSl = high >= Number(rem.stop_loss);
            const hitTp = low <= Number(rem.take_profit_1);
            if (hitSl && hitTp) {
              outcome = 'LOSS';
              resolvedTime = candle.time;
              break;
            } else if (hitSl) {
              outcome = 'LOSS';
              resolvedTime = candle.time;
              break;
            } else if (hitTp) {
              outcome = 'WIN';
              resolvedTime = candle.time;
              break;
            }
          }
        }
      }

      if (outcome !== 'PENDING') {
        await pool.execute(
          "UPDATE mt5_saved_projections SET status = ?, resolved_at = ? WHERE id = ?",
          [outcome, toMysqlDate(resolvedTime), rem.id]
        );
        console.log(`[SavedProjections] Auto-resolved setup ${rem.id} to ${outcome} at ${resolvedTime}`);
      }
    }
  } catch (err) {
    console.error("[SavedProjections] Error in outcome checker phase:", err.message);
  }
}

async function processTrackedAiProjections() {
  const pool = await initializeDatabase();
  if (!pool) return;

  try {
    const [rows] = await pool.query("SELECT * FROM mt5_tracked_ai_projections WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 100");
    const nowMs = Date.now();

    for (const row of rows) {
      const symbol = resolveLiveSymbol(row.symbol);
      const preferredEntryTf = row.trade_mode === 'FTT' ? 'M5' : 'M15';
      let entryCandles = getRecentCandles(symbol, preferredEntryTf, 220);
      if ((!entryCandles || entryCandles.length < 35) && row.trade_mode !== 'FTT') {
        entryCandles = getRecentCandles(symbol, 'H1', 220);
      }
      if ((!entryCandles || entryCandles.length < 35) && row.trade_mode === 'FTT') {
        entryCandles = getRecentCandles(symbol, 'M1', 220);
      }
      const trendCandles = getRecentCandles(symbol, row.trade_mode === 'FTT' ? 'M15' : 'H1', 220);
      const latestCandle = entryCandles?.[entryCandles.length - 1] || trendCandles?.[trendCandles.length - 1] || null;
      const currentPrice = parseMaybeNumber(latestCandle?.close) ?? parseMaybeNumber(row.current_price);

      const evaluation = evaluateTrackedProjection({
        projection: row,
        currentPrice,
        entryCandles: entryCandles || [],
        trendCandles: trendCandles || [],
        nowMs,
      });

      const nextStatus = evaluation.status || 'PENDING';
      const eventAt = toMysqlDate(new Date(nowMs));
      const evaluationJson = JSON.stringify({
        ...evaluation,
        checkedAt: new Date(nowMs).toISOString(),
        entryTimeframe: preferredEntryTf,
        trendTimeframe: row.trade_mode === 'FTT' ? 'M15' : 'H1',
      });

      if (nextStatus === 'TRIGGERED') {
        await pool.execute(
          `UPDATE mt5_tracked_ai_projections
           SET status = 'TRIGGERED', current_price = ?, last_checked_at = ?, triggered_at = ?, evaluation_json = ?
           WHERE id = ? AND status = 'PENDING'`,
          [evaluation.currentPrice ?? null, eventAt, eventAt, evaluationJson, row.id]
        );
      } else if (nextStatus === 'INVALIDATED') {
        await pool.execute(
          `UPDATE mt5_tracked_ai_projections
           SET status = 'INVALIDATED', current_price = ?, last_checked_at = ?, invalidated_at = ?, evaluation_json = ?
           WHERE id = ? AND status = 'PENDING'`,
          [evaluation.currentPrice ?? null, eventAt, eventAt, evaluationJson, row.id]
        );
      } else if (nextStatus === 'EXPIRED') {
        await pool.execute(
          `UPDATE mt5_tracked_ai_projections
           SET status = 'EXPIRED', current_price = ?, last_checked_at = ?, evaluation_json = ?
           WHERE id = ? AND status = 'PENDING'`,
          [evaluation.currentPrice ?? null, eventAt, evaluationJson, row.id]
        );
      } else {
        await pool.execute(
          `UPDATE mt5_tracked_ai_projections
           SET current_price = ?, last_checked_at = ?, evaluation_json = ?
           WHERE id = ? AND status = 'PENDING'`,
          [evaluation.currentPrice ?? null, eventAt, evaluationJson, row.id]
        );
      }

      const [freshRows] = await pool.query('SELECT * FROM mt5_tracked_ai_projections WHERE id = ?', [row.id]);
      const tracked = normalizeTrackedProjectionRow(freshRows[0]);
      if (!tracked) continue;

      sendStreamEvent('ai_tracked_update', tracked);
      if (nextStatus === 'TRIGGERED') {
        sendStreamEvent('ai_tracked_triggered', tracked);
        const shouldEmail = process?.env?.EMAIL_ON_SIGNAL !== 'false';
        const to = process?.env?.EMAIL_TO || process?.env?.SMTP_USER;
        if (shouldEmail && to && isEmailSystemEnabled('aiTracked')) {
          try {
            await sendNotificationEmail({
              to,
              subject: `[Aura Gold] Tracked AI entry triggered: ${tracked.symbol} ${tracked.tradeMode}`,
              text: formatTrackedProjectionEmail(tracked),
              html: formatTrackedProjectionEmailHtml(tracked),
              signalId: `tracked:${tracked.id}`,
            });
          } catch (emailError) {
            console.error('[AI Signals Tracking] Failed to send tracked projection email:', emailError.message);
          }
        }
      }
      if (nextStatus === 'INVALIDATED') sendStreamEvent('ai_tracked_invalidated', tracked);
      if (nextStatus === 'EXPIRED') sendStreamEvent('ai_tracked_expired', tracked);
    }
  } catch (err) {
    console.error('[AI Signals Tracking] Error in tracker phase:', err.message);
  }
}

async function processAllRemindersAndSavedProjections() {
  if (reminderSchedulerRunning) return;
  reminderSchedulerRunning = true;
  try {
    await processProjectionReminders();
  } catch (err) {
    console.error('[Scheduler] Error in processProjectionReminders:', err.message);
  }
  try {
    await processSavedProjections();
  } catch (err) {
    console.error('[Scheduler] Error in processSavedProjections:', err.message);
  }
  try {
    await processForexEmailReports();
  } catch (err) {
    console.error('[Scheduler] Error in processForexEmailReports:', err.message);
  }
  try {
    await processSystemSignalLog();
  } catch (err) {
    console.error('[Scheduler] Error in processSystemSignalLog:', err.message);
  }
  try {
    await processForecastTradeOutcomes();
  } catch (err) {
    console.error('[Scheduler] Error in processForecastTradeOutcomes:', err.message);
  }
  try {
    await processSignalTracker();
  } catch (err) {
    console.error('[Scheduler] Error in processSignalTracker:', err.message);
  }
  try {
    await processStrategyLabOutcomes();
  } catch (err) {
    console.error('[Scheduler] Error in processStrategyLabOutcomes:', err.message);
  }
  try {
    await pruneOldAccountSnapshots();
  } catch (err) {
    console.error('[Scheduler] Error in pruneOldAccountSnapshots:', err.message);
  }
  try {
    await processForecastEmails();
  } catch (err) {
    console.error('[Scheduler] Error in processForecastEmails:', err.message);
  }
  reminderSchedulerRunning = false;
}

function startReminderScheduler() {
  const checkInterval = 30000;
  const timer = setInterval(() => void processAllRemindersAndSavedProjections(), checkInterval);
  if (typeof timer.unref === 'function') timer.unref();
  
  setTimeout(() => void processAllRemindersAndSavedProjections(), 10000);
  console.log('[Reminders] Background reminder & saved outcome tracker scheduler started.');
}

startReminderScheduler();

let trackedAiSchedulerRunning = false;

async function processTrackedAiProjectionsSafely() {
  if (trackedAiSchedulerRunning) return;
  trackedAiSchedulerRunning = true;
  try {
    await processTrackedAiProjections();
  } finally {
    trackedAiSchedulerRunning = false;
  }
}

function startTrackedAiProjectionScheduler() {
  const checkInterval = Number(process?.env?.AI_TRACKED_PROJECTION_INTERVAL_MS || 5000);
  const timer = setInterval(() => void processTrackedAiProjectionsSafely(), checkInterval);
  if (typeof timer.unref === 'function') timer.unref();
  setTimeout(() => void processTrackedAiProjectionsSafely(), 3000);
  console.log('[AI Signals Tracking] AI-free tracked projection scheduler started.');
}

startTrackedAiProjectionScheduler();


// ─── Automatic candle retention ─────────────────────────────────────
// Caps each (symbol|timeframe) series in the database to the most recent N bars.
// This is timeframe-safe (unlike a flat "older than N days" rule, which would wipe
// the long D1/W1/MN1 history that analysis needs) and keeps the DB from re-bloating.
const DB_CANDLES_PER_SERIES = Number(process?.env?.MT5_DB_CANDLES_PER_SERIES || 5000);
const RETENTION_INTERVAL_MS = Number(process?.env?.MT5_RETENTION_INTERVAL_MS || 6 * 60 * 60 * 1000);
let retentionRunning = false;

async function runCandleRetention() {
  if (retentionRunning) return;
  retentionRunning = true;
  try {
    const pool = await initializeDatabase();
    if (!pool) return;
    const [series] = await pool.query(
      'SELECT symbol, timeframe, COUNT(*) n FROM mt5_candles GROUP BY symbol, timeframe HAVING n > ?',
      [DB_CANDLES_PER_SERIES]
    );
    if (!series.length) return;
    let removed = 0;
    for (const s of series) {
      const [rows] = await pool.query(
        'SELECT candle_time t FROM mt5_candles WHERE symbol=? AND timeframe=? ORDER BY candle_time DESC LIMIT 1 OFFSET ?',
        [s.symbol, s.timeframe, DB_CANDLES_PER_SERIES]
      );
      if (!rows.length) continue;
      const threshold = rows[0].t;
      // Batch the delete so no single statement exceeds the server's statement timeout.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const [r] = await pool.query(
          'DELETE FROM mt5_candles WHERE symbol=? AND timeframe=? AND candle_time < ? LIMIT 20000',
          [s.symbol, s.timeframe, threshold]
        );
        removed += r.affectedRows;
        if (r.affectedRows < 20000) break;
      }
    }
    if (removed > 0) console.log(`[Retention] Trimmed ${removed} old candle rows (cap ${DB_CANDLES_PER_SERIES}/series).`);
  } catch (error) {
    console.error('[Retention] Candle retention failed:', error.message);
  } finally {
    retentionRunning = false;
  }
}

// Run once shortly after boot, then on a recurring schedule.
setTimeout(() => void runCandleRetention(), 90_000);
setInterval(() => void runCandleRetention(), RETENTION_INTERVAL_MS);


const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === '/ws-proxy') {
    
    let targetUrl = url.searchParams.get('target');
    if (!targetUrl) {
      console.log('[Node Proxy] Missing target URL');
      socket.destroy();
      return;
    }

    if (targetUrl === 'wss://aiplatform.googleapis.com//ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent') {
      const location = GOOGLE_CLOUD_LOCATION === 'global' ? 'us-central1' : GOOGLE_CLOUD_LOCATION;
      targetUrl = `wss://${location}-aiplatform.googleapis.com//ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent`;
    } else {
      console.log('[Node Proxy] Invalid target URL');
      socket.destroy();
      return;
    }

    let accessToken;

    try {
      accessToken = await getAccessToken();
      if (!accessToken) throw new Error('No token');
    } catch (err) {
      console.log('[Node Proxy] Authentication failed');
      socket.destroy();
      return;
    }

    console.log(`[Node Proxy] Initiating upstream connection to: ${targetUrl}`);

    let upstreamWs;

    try {
      upstreamWs = new WebSocket(targetUrl, {
        headers: getRequestHeaders(accessToken)
      });
    } catch (e) {
      console.error('[Node Proxy] Invalid Upstream URL');
      socket.destroy();
      return;
    }

    const initialErrorHandler = (error) => {
      console.error('[Node Proxy] Upstream connection failed:', error);
      upstreamWs.removeEventListener('open', onUpstreamOpen);

      if (socket.writable) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
      }
    };

    upstreamWs.once('error', initialErrorHandler);

    // 5. Handle Successful Upstream Connection
    const onUpstreamOpen = () => {
      // Remove the "bootstrapping" error handler
      upstreamWs.removeListener('error', initialErrorHandler);

      // Perform the HTTP -> WebSocket upgrade for the Client
      wss.handleUpgrade(request, socket, head, (ws) => {

        upstreamWs.on('message', (data, isBinary) => {
          const logMsg = isBinary ? '<Binary Data>' : data.toString();
          console.log(`[Upstream -> Client] [${new Date().toISOString()}]: ${logMsg}`);

          if (ws.readyState === WebSocket.OPEN) {
            if (data === undefined || data === null) {
              console.warn('[Node Proxy] Attempted to send undefined/null data to client');
              return;
            }
            ws.send(data, { binary: isBinary });
          }
        });

        ws.on('message', (data, isBinary) => {
          const logMsg = isBinary ? '<Binary Data>' : data.toString();

          let dataJson = {};
          try {
            dataJson = JSON.parse(data.toString());
          } catch (error) {
            console.error('[Node Proxy] Failed to parse message from client:', error);
            ws.close(1011, 'Failed to parse message');
          }

          if (dataJson['setup']) {
            dataJson['setup']['model'] = `projects/${GOOGLE_CLOUD_PROJECT}/locations/${GOOGLE_CLOUD_LOCATION}/${dataJson['setup']['model']}`;
          }

          if (upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.send(JSON.stringify(dataJson), { binary: false });
          }
        });

        upstreamWs.on('error', (error) => {
          console.error('[Node Proxy] Upstream error:', error);
          ws.close(1011, error.message);
        });

        upstreamWs.on('close', (code, reason) => {
          console.log(`[Node Proxy] Upstream closed: ${code} ${reason}`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(code, reason);
          }
        });

        ws.on('error', (error) => {
          console.error('[Node Proxy] Client error:', error);
          upstreamWs.close(1011, error.message);
        });

        ws.on('close', (code, reason) => {
          console.log(`[Node Proxy] Client closed: ${code} ${reason}`);
          if (upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.close(1000, reason);
          }
        });

        wss.emit('connection', ws, request);
      });
    };

    upstreamWs.once('open', onUpstreamOpen);

  } else {
    // Path did not match
    socket.destroy();
  }
});
