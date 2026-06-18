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
import { aggregateSignals, detectSupportResistance } from './signalEngine.js';
import { analyzeWithGemini, checkVertexAiHealth, analyzeFttWithGemini, analyzeProjectionWithGemini, analyzeAiSignalsWithGemini } from './geminiEngine.js';
import { generateFttPrediction, buildFttAiPrompt } from './fttEngine.js';
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

function getEmailTransporter() {
  const user = process?.env?.SMTP_USER;
  const pass = process?.env?.SMTP_PASS;
  if (!user || !pass) {
    throw new Error('SMTP_USER and SMTP_PASS must be set to send email notifications.');
  }

  const port = Number(process?.env?.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process?.env?.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: process?.env?.SMTP_SECURE === 'true' || port === 465,
    auth: { user, pass },
  });
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
      snapshot.symbols ? JSON.stringify(snapshot.symbols) : null,
      snapshot.timeframes ? JSON.stringify(snapshot.timeframes) : null,
      JSON.stringify(snapshot.raw || {}),
    ]
  );
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
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    hour12: false,
    weekday: 'short',
    hour: 'numeric',
  });
  const parts = formatter.formatToParts(new Date());
  const partMap = Object.fromEntries(parts.map(p => [p.type, p.value]));
  
  const weekday = partMap.weekday; // "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"
  const hour = Number(partMap.hour);
  
  // Market closes Friday 22:00 UTC, which is Saturday 04:00 AM in Dhaka
  // Market opens Sunday 22:00 UTC, which is Monday 04:00 AM in Dhaka
  
  if (weekday === 'Sat') {
    return hour >= 4; // closed after 4 AM Saturday
  }
  if (weekday === 'Sun') {
    return true; // closed all day Sunday
  }
  if (weekday === 'Mon') {
    return hour < 4; // closed before 4 AM Monday
  }
  
  return false;
}

function isCandleCurrent(candle, timeframe) {
  if (!candle) return false;
  if (isWeekend()) return true; // Bypass freshness check during weekends (market closed)

  // Use the backend receive time (when the candle last arrived from MT5) rather than
  // the candle open time, which would wrongly age out candles whose open is hours ago
  // but whose close data is still being streamed (e.g. D1 candles, H4 candles).
  // Fall back to candle.time only when no receive timestamp is available.
  const receiveTimeStr = candle.receivedAt || candle.raw?.receivedAt;
  const referenceMs = receiveTimeStr
    ? new Date(receiveTimeStr).getTime()
    : new Date(candle.time).getTime();

  if (isNaN(referenceMs)) return false;

  const nowMs = Date.now();
  const diffSec = (nowMs - referenceMs) / 1000;

  // Candle data is stale if the backend hasn't received an update in more than 3× the
  // snapshot interval (5s × 3 = 15s for active symbol) or at most 5 minutes.
  const MAX_STALE_SEC = Math.min(
    CONNECTION_TIMEOUT_MS / 1000, // same as heartbeat timeout (default 120s)
    300                            // hard cap at 5 minutes
  );

  return diffSec >= 0 && diffSec <= MAX_STALE_SEC;
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

function addCandle(candle) {
  upsertRecord(candles, candle, (item) => item.id, MAX_CANDLES);
  indexCandleSeries(candle);
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

function addAccountSnapshot(snapshot) {
  accountSnapshots.unshift(snapshot);
  trimToLimit(accountSnapshots, 50);
  mt5State.lastHeartbeatAt = snapshot.receivedAt || new Date().toISOString();
  mt5State.accountSnapshot = snapshot;
  mt5State.account = snapshot.account || mt5State.account;
  mt5State.broker = snapshot.broker || mt5State.broker;
  mt5State.terminal = snapshot.terminal || mt5State.terminal;
  mt5State.version = snapshot.version || mt5State.version;
  void persistAccountSnapshot(snapshot).catch((error) => {
    console.error('[MySQL] Failed to persist account snapshot:', error.message);
  });
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
  if (s.includes('XAU') || s.includes('GOLD')) return 0.01;
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}

function forexSizingPipValuePerLot(symbol) {
  const s = String(symbol || '').toUpperCase();
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
    const outcome = req.query.outcome ? String(req.query.outcome).toUpperCase() : null;
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const reports = await querySignalEmailReports('forex', { symbol, days, outcome, limit });
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
    const grade = req.query.grade ? String(req.query.grade) : null;
    const outcome = req.query.outcome ? String(req.query.outcome).toUpperCase() : null;
    const limit = req.query.limit ? Number(req.query.limit) : 300;
    const emailed = req.query.emailed === 'true' ? true : req.query.emailed === 'false' ? false : null;
    const { rows, summary } = await querySystemSignalLog({ symbol, days, grade, outcome, limit, emailed });
    res.json({ ok: true, rows, summary, count: rows.length });
  } catch (error) {
    console.error('[Reports] signal-log failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/fixed', async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const days = req.query.days ? Number(req.query.days) : null;
    const outcome = req.query.outcome ? String(req.query.outcome).toUpperCase() : null;
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const reports = await querySignalEmailReports('fixed', { symbol, days, outcome, limit });
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
      total: calibration.settled,
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
    email_to: SIGNAL_ALERT_EMAIL_TO,
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
const SIGNAL_ALERT_EMAIL_TO = process.env.SIGNAL_ALERT_EMAIL_TO || process.env.EMAIL_TO;
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

const CURATED_BASES = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURJPY', 'GBPJPY'];
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
  return /XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
}
function px(v, symbol) { return (v === null || v === undefined) ? 'n/a' : Number(v).toFixed(digitsFor(symbol)); }

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
    recipient: SIGNAL_ALERT_EMAIL_TO || null,
    signalId: signalId || null,
    status: `Skipped ${reason}`,
    error: `${type} ${symbol}${timeframe ? ` ${timeframe}` : ''}${expiry ? ` ${expiry}` : ''}: ${reason}${detail.ageSeconds !== null ? ` (${detail.ageSeconds}s > ${detail.maxAgeSeconds}s)` : ''}`,
  });
}

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
    settled: settledItems.length,
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

async function getCalibrationSnapshot(signalType, candidate, { days = 365, limit = 500 } = {}) {
  const reports = await querySignalEmailReports(signalType, { days, limit });
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

function evaluateForexReplay(report, candles, { horizonHours = 72 } = {}) {
  const signalMs = Date.parse(report.signalTime || '');
  if (!Number.isFinite(signalMs)) return { outcome: 'PENDING', valid: false };

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

  const horizonMs = Math.max(1, Number(horizonHours) || 72) * 3600 * 1000;
  const laterCandles = candles
    .map((candle) => ({ ...candle, timeMs: Date.parse(candle.time || '') }))
    .filter((candle) => Number.isFinite(candle.timeMs) && candle.timeMs >= signalMs && candle.timeMs <= signalMs + horizonMs)
    .sort((a, b) => a.timeMs - b.timeMs);

  if (!laterCandles.length) {
    return { outcome: 'EXPIRED', valid: true, exitPrice: null, resolvedAt: null, barsToResolution: 0, tpHitLevel: 0, mfePips: 0, maePips: 0 };
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

  for (const candle of laterCandles) {
    barsToResolution += 1;
    const low = Number(candle.low);
    const high = Number(candle.high);
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;

    const favorable = isBuy ? (high - entry) / pip : (entry - low) / pip;
    const adverse = isBuy ? (low - entry) / pip : (entry - high) / pip;
    mfePips = Math.max(mfePips, Math.round(favorable * 10) / 10);
    maePips = Math.min(maePips, Math.round(adverse * 10) / 10);

    const hitTp1 = isBuy ? high >= tp1 : low <= tp1;
    const hitTp2 = Number.isFinite(tp2) ? (isBuy ? high >= tp2 : low <= tp2) : false;
    const hitTp3 = Number.isFinite(tp3) ? (isBuy ? high >= tp3 : low <= tp3) : false;
    const hitAnyTarget = hitTp3 || hitTp2 || hitTp1;
    const hitLevel = hitTp3 ? 3 : hitTp2 ? 2 : hitTp1 ? 1 : 0;
    const hitSl = isBuy ? low <= sl : high >= sl;

    if (hitSl && !hitAnyTarget) {
      if (bestRank === 0) {
        outcome = 'LOSS';
        exitPrice = sl;
        resolvedAt = candle.time;
      }
      break;
    }

    if (hitAnyTarget && hitSl && hitLevel > bestRank) {
      outcome = 'AMBIGUOUS';
      resolvedAt = candle.time;
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
    email_to: SIGNAL_ALERT_EMAIL_TO,
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
  forexMinGrade: 'A_SETUP',
  forexMinQuality: 'A_SIGNAL',
  fixedTimeMinTier: 'QUALITY_SIGNAL',
  postNewsForexMinGrade: 'A_NEWS_SETUP',
  postNewsFixedMinTier: 'QUALITY_SIGNAL',
};
const EMAIL_BOOLEAN_SETTING_KEYS = ['forexScanner', 'fixedTime', 'postNewsForex', 'postNewsFixed', 'highImpactNews', 'aiTracked'];
const EMAIL_SELECT_SETTING_VALUES = {
  forexMinGrade: ['B_SETUP', 'A_SETUP', 'A_PLUS_SETUP'],
  forexMinQuality: ['B_SIGNAL', 'A_SIGNAL', 'A_PLUS_SIGNAL'],
  fixedTimeMinTier: ['QUALITY_SIGNAL', 'TRADE_SIGNAL'],
  postNewsForexMinGrade: ['B_NEWS_SETUP', 'A_NEWS_SETUP', 'A_PLUS_NEWS_SETUP'],
  postNewsFixedMinTier: ['QUALITY_SIGNAL', 'TRADE_SIGNAL'],
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
  emailAlertSettingsCache = sanitized;
  fs.mkdirSync(path.dirname(EMAIL_ALERT_SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(EMAIL_ALERT_SETTINGS_FILE, JSON.stringify(sanitized, null, 2), 'utf8');
  return sanitized;
}

function isEmailSystemEnabled(key) {
  const settings = loadEmailAlertSettings();
  return settings[key] !== false;
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
    email_to: SIGNAL_ALERT_EMAIL_TO,
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
    email_to: SIGNAL_ALERT_EMAIL_TO,
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
    const [rows] = await pool.query(
      "SELECT * FROM mt5_signal_email_reports WHERE signal_type = 'forex' AND outcome IN ('PENDING','TP1_WIN','TP2_WIN') ORDER BY signal_time ASC LIMIT 50"
    );
    for (const row of rows) {
      const report = normalizeSignalEmailReportRow(row);
      const signalMs = Date.parse(report.signalTime || '');
      if (!Number.isFinite(signalMs)) continue;

      const ageHrs = (nowMs - signalMs) / (3600 * 1000);
      if (ageHrs > 72) {
        await pool.execute(
          "UPDATE mt5_signal_email_reports SET outcome = 'EXPIRED', resolved_at = ? WHERE id = ?",
          [toMysqlDate(), report.id]
        );
        continue;
      }

      const candles = getRecentCandles(report.symbol, report.timeframe, 1000);
      if (!candles || candles.length < 2) continue;

      const replay = evaluateForexReplay(report, candles);
      if (!replay.valid || replay.outcome === 'PENDING') continue;
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

async function querySignalEmailReports(signalType, { symbol = null, days = null, outcome = null, limit = 200 } = {}) {
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
  if (days && Number(days) > 0) {
    sql += ' AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)';
    params.push(Number(days));
  }
  sql += ' ORDER BY email_sent_at DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 500));
  const [rows] = await pool.query(sql, params);
  return rows.map(normalizeSignalEmailReportRow).filter(Boolean);
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
    const [rows] = await pool.query(
      "SELECT * FROM mt5_system_signal_log WHERE outcome IN ('PENDING','TP1_WIN','TP2_WIN') ORDER BY signal_time ASC LIMIT 100"
    );
    for (const row of rows) {
      const signalMs = row.signal_time ? new Date(row.signal_time).getTime() : NaN;
      if (!Number.isFinite(signalMs)) continue;
      const ageHrs = (nowMs - signalMs) / (3600 * 1000);
      if (ageHrs > 72) {
        await pool.execute("UPDATE mt5_system_signal_log SET outcome = 'EXPIRED', resolved_at = ? WHERE id = ?", [toMysqlDate(), row.id]);
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
      if (!replay.valid || replay.outcome === 'PENDING') continue;
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

async function querySystemSignalLog({ days = 30, symbol = null, grade = null, emailed = null, outcome = null, limit = 300 } = {}) {
  const pool = await initializeDatabase();
  if (!pool) return { rows: [], summary: summarizeSignalLog([]) };
  let sql = 'SELECT * FROM mt5_system_signal_log WHERE 1=1';
  const params = [];
  if (symbol) { sql += ' AND symbol = ?'; params.push(String(symbol).toUpperCase()); }
  if (grade) { sql += ' AND grade = ?'; params.push(grade); }
  if (emailed === true || emailed === false) { sql += ' AND emailed = ?'; params.push(emailed ? 1 : 0); }
  if (outcome) { sql += ' AND outcome = ?'; params.push(String(outcome).toUpperCase()); }
  if (days && Number(days) > 0) { sql += ' AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)'; params.push(Number(days)); }
  sql += ' ORDER BY signal_time DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 300, 1), 1000));
  const [rows] = await pool.query(sql, params);
  const normalized = rows.map(normalizeSystemSignalRow).filter(Boolean);
  return { rows: normalized, summary: summarizeSignalLog(normalized) };
}

async function sendForexAlert(result) {
  if (!SIGNAL_ALERT_EMAIL_TO) return false;
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
  }
  const calConfidence = blendCalibratedConfidence(sd.confidence, calibration);
  result.calibratedConfidence = calConfidence;
  const displayScore = calConfidence.adjusted ? `${calConfidence.value}/100 (raw ${calConfidence.raw})` : `${Math.round(sd.confidence)}/100`;
  const conf = sd.confluences || [];
  const news = sd.newsRisk;
  const dat = sd.datFramework;
  const risk = sd.riskPlan;
  const pattern = dat?.trigger?.pattern || sd.candlePatterns?.find((p) => p.direction !== 'neutral')?.name || 'Structure trigger';
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
      ${sd.sessionContext ? `<p style="font-size:12px;color:#475569">Session: ${sd.sessionContext.reason}</p>` : ''}
      ${risk ? `<div style="margin:10px 0;padding:10px;border:1px solid #fde68a;background:#fffbeb;border-radius:10px"><p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#92400e;text-transform:uppercase">Position Plan</p><p style="font-size:13px;margin:2px 0">Risk <b>${risk.riskPercent}%</b> · Amount to risk / max loss <b>${money(risk.amountToRisk ?? risk.riskAmount ?? risk.maxLoss)}</b></p><p style="font-size:13px;margin:2px 0">Suggested lot <b>${risk.suggestedLotSize ?? 'n/a'}</b> · Approx margin/investment <b>${money(risk.marginRequired ?? risk.amountToInvestApprox)}</b> · Multiplier <b>${risk.multiplier || `${risk.leverage || 'n/a'}x`}</b></p><p style="font-size:13px;margin:2px 0">SL loss <b style="color:#b91c1c">-${money(risk.lossAtStop ?? risk.maxLoss)}</b> · Stop ${risk.stopPips ?? 'n/a'} pips</p><p style="font-size:13px;margin:6px 0 0;color:#047857">TP1 ${money(risk.profitAtTp1)} · TP2 ${money(risk.profitAtTp2)} · TP3 ${money(risk.profitAtTp3)}</p></div>` : ''}
      <p style="font-size:12px;color:#475569;margin:8px 0">${sd.timingTip || ''}</p>
      ${news && (news.block || news.caution) ? `<p style="font-size:12px;color:#b45309">⚠ ${news.reason}</p>` : ''}
      <p style="font-size:12px;color:#64748b">Confluences: ${conf.map((c) => `${c.name} +${c.points}`).join(', ') || 'none'}</p>
      <p style="font-size:11px;color:#94a3b8;margin-top:10px">Advisory only — not financial advice. — Aura Gold Scanner</p>
    </div>`;
  await sendNotificationEmail({ to: SIGNAL_ALERT_EMAIL_TO, subject, text, html, signalId: `forex:${result.symbol}:${result.timeframe}:${result.bar}` });
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
  if (!FOREX_DAILY_BEST_EMAIL_ENABLED || !SIGNAL_ALERTS_ENABLED || !SIGNAL_ALERT_EMAIL_TO || !isEmailSystemEnabled('forexScanner')) return false;
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
  await sendNotificationEmail({ to: SIGNAL_ALERT_EMAIL_TO, subject: `[BEST FOREX SIGNALS | ${day}] Top ${candidates.length} scanner setups`, text: lines.join('\n'), html, signalId });
  recordAlert(signalId, day);
  lastForexDailyBestEmailDate = day;
  console.log(`[Scanner] Emailed daily best forex summary (${candidates.length} setup(s)).`);
  return true;
}

async function sendFttAlert(prediction) {
  if (!SIGNAL_ALERT_EMAIL_TO) return false;
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
      ${qualityReasons.length ? `<p style="font-size:12px;color:#047857"><b>Why quality</b>: ${qualityReasons.join('; ')}</p>` : ''}
      ${riskWarnings.length ? `<p style="font-size:12px;color:#b45309"><b>Warnings</b>: ${riskWarnings.join('; ')}</p>` : ''}
      <p style="font-size:13px">Entry <b>${px(prediction.entryPrice, sym)}</b> · enter ${new Date(prediction.entryTime).toLocaleString()} · expires ${new Date(prediction.expiryTime).toLocaleString()} · source ${prediction.source || 'system'}</p>
      <p style="font-size:12px;color:#475569">${tip}</p>
      <p style="font-size:12px;color:#334155">${prediction.reasoning || ''}</p>
      <p style="font-size:11px;color:#94a3b8;margin-top:10px">Advisory only — not financial advice. — Aura Gold Future Predictions</p>
    </div>`;
  await sendNotificationEmail({ to: SIGNAL_ALERT_EMAIL_TO, subject, text, html, signalId: prediction.id });
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
  if (SIGNAL_ALERTS_ENABLED && SIGNAL_ALERT_EMAIL_TO && isEmailSystemEnabled('highImpactNews')) {
    const key = `actual:${event.id}`;
    if (canAlert(key, event.id, { minGapMs: 0 })) {
      const { subject, text, html } = buildActualReleasedEmail(event, surprise, affected);
      try {
        await sendNotificationEmail({ to: SIGNAL_ALERT_EMAIL_TO, subject, text, html, signalId: key });
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
        if (SIGNAL_ALERTS_ENABLED && SIGNAL_ALERT_EMAIL_TO && isEmailSystemEnabled('postNewsForex') && postNewsForexEmailAllowed(forexSig) && canAlert(key, eventId, { minGapMs: 0 })) {
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
          sendNotificationEmail({ to: SIGNAL_ALERT_EMAIL_TO, subject, text, html, signalId: key })
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
          if (SIGNAL_ALERTS_ENABLED && SIGNAL_ALERT_EMAIL_TO && canAlert(fixedKey, eventId, { minGapMs: 0 })) {
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
        try {
          const inputs = getFttInputs(symbol, expiry);
          if (!inputs.candles || inputs.candles.length < 5) continue;
          const latest = inputs.candles[inputs.candles.length - 1];
          if (!isCandleCurrent(latest, inputs.timeframe)) continue;
          const bar = latest.time;
          const sourceReceivedAt = latest.receivedAt || latest.raw?.receivedAt || null;
          const pred = generateFttPrediction({
            symbol, expiry, candles: inputs.candles, indicators: inputs.indicators,
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
            if (pred.direction !== 'HOLD' && fttTierAllowed(tradeStatus, 'fixedTimeMinTier') && isEmailSystemEnabled('fixedTime')) {
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
              if (SIGNAL_ALERTS_ENABLED && SIGNAL_ALERT_EMAIL_TO) {
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
          if (!r.outdated && isTopbarForexSignal(sd)) {
            const topbarKey = `${symbol}|${tf}`;
            if (topbarForexAlertBars.get(topbarKey) !== r.bar) {
              topbarForexAlertBars.set(topbarKey, r.bar);
              sendStreamEvent('quality_forex_signal', buildTopbarForexAlert(r));
            }
          }
          let emailed = false;
          if (!r.outdated && forexScannerEmailAllowed(sd)) {
            recordForexDailyBestCandidate(r);
            // Email (dedup: once per symbol/bar + min gap).
            if (SIGNAL_ALERTS_ENABLED && SIGNAL_ALERT_EMAIL_TO && isEmailSystemEnabled('forexScanner')) {
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
  console.log(`[Scanner] Background scanner started. TFs=${SCAN_TIMEFRAMES.join(',')} expiries=${FTT_EXPIRIES.join(',')} every ${SCANNER_INTERVAL_MS / 1000}s. AI on >=${process.env.SIGNAL_ALERT_MIN_GRADE || 'B Setup'}. Alerts->${SIGNAL_ALERT_EMAIL_TO || 'disabled'}`);
}
startBackgroundScanner();


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
