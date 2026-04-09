// NCAAF Oracle v4.1 — SQLite Database
// Persisted between GitHub Actions runs via workflow artifacts.
// Stores: predictions, game results, accuracy logs, Elo ratings, season state.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import initSqlJs, { type Database } from 'sql.js';
import { logger } from '../logger.js';
import type { Prediction, SeasonAccuracy, WeeklyRecord, EloRating, GameResult } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.DB_PATH ?? resolve(__dirname, '../../data/oracle.sqlite');
const DATA_DIR = resolve(__dirname, '../../data');

let _db: Database | null = null;

// ─── Initialize ───────────────────────────────────────────────────────────────

export async function initDatabase(): Promise<Database> {
  if (_db) return _db;

  mkdirSync(DATA_DIR, { recursive: true });
  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const fileBuffer = readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
    logger.info({ path: DB_PATH }, 'Loaded existing database');
  } else {
    _db = new SQL.Database();
    logger.info({ path: DB_PATH }, 'Created new database');
  }

  createSchema(_db);
  return _db;
}

export function getDb(): Database {
  if (!_db) throw new Error('Database not initialized. Call initDatabase() first.');
  return _db;
}

export function saveDatabase(): void {
  if (!_db) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  writeFileSync(DB_PATH, buffer);
  logger.info({ path: DB_PATH }, 'Database saved');
}

// ─── Schema ───────────────────────────────────────────────────────────────────

function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS predictions (
      game_id         INTEGER PRIMARY KEY,
      game_date       TEXT NOT NULL,
      season          INTEGER NOT NULL,
      week            INTEGER NOT NULL,
      season_type     TEXT NOT NULL DEFAULT 'regular',
      home_team       TEXT NOT NULL,
      away_team       TEXT NOT NULL,
      venue           TEXT,
      is_prior_year   INTEGER DEFAULT 0,
      prior_year_weight REAL DEFAULT 0,
      mc_win_pct      REAL,
      calibrated_prob REAL,
      confidence_tier TEXT,
      vegas_prob      REAL,
      edge            REAL,
      edge_category   TEXT,
      home_exp_pts    REAL,
      away_exp_pts    REAL,
      total_points    REAL,
      spread          REAL,
      most_likely_score TEXT,
      upset_prob      REAL,
      blowout_prob    REAL,
      model_version   TEXT,
      feature_vector  TEXT,
      actual_winner   TEXT,
      home_score      INTEGER,
      away_score      INTEGER,
      correct         INTEGER,
      brier_score     REAL,
      created_at      TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS game_results (
      game_id     INTEGER PRIMARY KEY,
      season      INTEGER NOT NULL,
      week        INTEGER NOT NULL,
      game_date   TEXT NOT NULL,
      home_team   TEXT NOT NULL,
      away_team   TEXT NOT NULL,
      home_score  INTEGER NOT NULL,
      away_score  INTEGER NOT NULL,
      winner      TEXT NOT NULL,
      margin      INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS season_accuracy (
      season              INTEGER PRIMARY KEY,
      total_picks         INTEGER DEFAULT 0,
      correct_picks       INTEGER DEFAULT 0,
      accuracy            REAL DEFAULT 0,
      high_conv_picks     INTEGER DEFAULT 0,
      high_conv_correct   INTEGER DEFAULT 0,
      high_conv_accuracy  REAL DEFAULT 0,
      extreme_conv_picks  INTEGER DEFAULT 0,
      extreme_conv_correct INTEGER DEFAULT 0,
      extreme_conv_accuracy REAL DEFAULT 0,
      ats_wins            INTEGER DEFAULT 0,
      ats_losses          INTEGER DEFAULT 0,
      ats_accuracy        REAL DEFAULT 0,
      edge_pick_wins      INTEGER DEFAULT 0,
      edge_pick_losses    INTEGER DEFAULT 0,
      edge_pick_accuracy  REAL DEFAULT 0,
      brier_score         REAL DEFAULT 0,
      log_loss            REAL DEFAULT 0,
      best_week           INTEGER,
      worst_week          INTEGER,
      weekly_record       TEXT DEFAULT '[]',
      updated_at          TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS elo_ratings (
      school      TEXT PRIMARY KEY,
      rating      REAL NOT NULL,
      updated_at  TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS season_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
}

// ─── Predictions ──────────────────────────────────────────────────────────────

export function upsertPrediction(db: Database, pred: Prediction): void {
  db.run(`
    INSERT OR REPLACE INTO predictions (
      game_id, game_date, season, week, season_type, home_team, away_team, venue,
      is_prior_year, prior_year_weight, mc_win_pct, calibrated_prob, confidence_tier,
      vegas_prob, edge, edge_category, home_exp_pts, away_exp_pts, total_points,
      spread, most_likely_score, upset_prob, blowout_prob, model_version,
      feature_vector, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
  `, [
    pred.game_id, pred.game_date, pred.season, pred.week, pred.season_type,
    pred.home_team, pred.away_team, pred.venue,
    pred.is_prior_year_mode ? 1 : 0, pred.prior_year_weight,
    pred.mc_win_pct, pred.calibrated_prob, pred.confidence_tier,
    pred.vegas_prob ?? null, pred.edge ?? null, pred.edge_category,
    pred.home_exp_pts, pred.away_exp_pts, pred.total_points,
    pred.spread, pred.most_likely_score, pred.upset_probability, pred.blowout_probability,
    pred.model_version, JSON.stringify(pred.feature_vector),
    pred.created_at,
  ]);
}

export function getPredictions(db: Database, season: number, week: number): Prediction[] {
  const rows = db.exec(`
    SELECT * FROM predictions WHERE season = ${season} AND week = ${week}
  `);
  if (!rows.length) return [];
  return rowsToObjects(rows[0]) as unknown as Prediction[];
}

export function getPendingPredictions(db: Database, season: number): Prediction[] {
  const rows = db.exec(`
    SELECT * FROM predictions
    WHERE season = ${season} AND correct IS NULL
    ORDER BY game_date ASC
  `);
  if (!rows.length) return [];
  return rowsToObjects(rows[0]) as unknown as Prediction[];
}

export function markPredictionResult(
  db: Database,
  gameId: number,
  winner: string,
  homeScore: number,
  awayScore: number,
  correct: boolean,
  brierScore: number,
): void {
  db.run(`
    UPDATE predictions
    SET actual_winner = ?, home_score = ?, away_score = ?, correct = ?, brier_score = ?
    WHERE game_id = ?
  `, [winner, homeScore, awayScore, correct ? 1 : 0, brierScore, gameId]);
}

// ─── Game results ─────────────────────────────────────────────────────────────

export function upsertGameResult(db: Database, result: GameResult): void {
  db.run(`
    INSERT OR REPLACE INTO game_results (
      game_id, season, week, game_date, home_team, away_team, home_score, away_score, winner, margin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    result.gameId, result.season, result.week, result.gameDate,
    result.homeTeam, result.awayTeam, result.homeScore, result.awayScore,
    result.winner, result.margin,
  ]);
}

// ─── Season accuracy ──────────────────────────────────────────────────────────

export function getSeasonAccuracy(db: Database, season: number): SeasonAccuracy | null {
  const rows = db.exec(`SELECT * FROM season_accuracy WHERE season = ${season}`);
  if (!rows.length || !rows[0].values.length) return null;
  const obj = rowsToObjects(rows[0])[0] as Record<string, unknown>;
  return {
    season: obj.season as number,
    totalPicks: obj.total_picks as number,
    correctPicks: obj.correct_picks as number,
    accuracy: obj.accuracy as number,
    highConvPicks: obj.high_conv_picks as number,
    highConvCorrect: obj.high_conv_correct as number,
    highConvAccuracy: obj.high_conv_accuracy as number,
    extremeConvPicks: obj.extreme_conv_picks as number,
    extremeConvCorrect: obj.extreme_conv_correct as number,
    extremeConvAccuracy: obj.extreme_conv_accuracy as number,
    atsWins: obj.ats_wins as number,
    atsLosses: obj.ats_losses as number,
    atsAccuracy: obj.ats_accuracy as number,
    edgePickWins: obj.edge_pick_wins as number,
    edgePickLosses: obj.edge_pick_losses as number,
    edgePickAccuracy: obj.edge_pick_accuracy as number,
    brierScore: obj.brier_score as number,
    logLoss: obj.log_loss as number,
    weeklyRecord: JSON.parse(obj.weekly_record as string ?? '[]') as WeeklyRecord[],
    bestWeek: obj.best_week as number,
    worstWeek: obj.worst_week as number,
  };
}

export function upsertSeasonAccuracy(db: Database, acc: SeasonAccuracy): void {
  db.run(`
    INSERT OR REPLACE INTO season_accuracy (
      season, total_picks, correct_picks, accuracy,
      high_conv_picks, high_conv_correct, high_conv_accuracy,
      extreme_conv_picks, extreme_conv_correct, extreme_conv_accuracy,
      ats_wins, ats_losses, ats_accuracy,
      edge_pick_wins, edge_pick_losses, edge_pick_accuracy,
      brier_score, log_loss, best_week, worst_week, weekly_record, updated_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `, [
    acc.season, acc.totalPicks, acc.correctPicks, acc.accuracy,
    acc.highConvPicks, acc.highConvCorrect, acc.highConvAccuracy,
    acc.extremeConvPicks, acc.extremeConvCorrect, acc.extremeConvAccuracy,
    acc.atsWins, acc.atsLosses, acc.atsAccuracy,
    acc.edgePickWins, acc.edgePickLosses, acc.edgePickAccuracy,
    acc.brierScore, acc.logLoss, acc.bestWeek, acc.worstWeek,
    JSON.stringify(acc.weeklyRecord), new Date().toISOString(),
  ]);
}

// ─── Elo ratings ──────────────────────────────────────────────────────────────

export function saveEloRatingsToDB(db: Database, ratings: Map<string, number>): void {
  const now = new Date().toISOString();
  for (const [school, rating] of ratings.entries()) {
    db.run(
      'INSERT OR REPLACE INTO elo_ratings (school, rating, updated_at) VALUES (?, ?, ?)',
      [school, rating, now],
    );
  }
}

export function loadEloRatingsFromDB(db: Database): Map<string, number> {
  const rows = db.exec('SELECT school, rating FROM elo_ratings');
  if (!rows.length) return new Map();
  return new Map(rows[0].values.map(row => [row[0] as string, row[1] as number]));
}

// ─── Season state key-value store ────────────────────────────────────────────

export function setState(db: Database, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO season_state (key, value) VALUES (?, ?)', [key, value]);
}

export function getState(db: Database, key: string): string | null {
  const rows = db.exec(`SELECT value FROM season_state WHERE key = '${key}'`);
  if (!rows.length || !rows[0].values.length) return null;
  return rows[0].values[0][0] as string;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function rowsToObjects(result: { columns: string[]; values: unknown[][] }): Record<string, unknown>[] {
  return result.values.map(row => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}
