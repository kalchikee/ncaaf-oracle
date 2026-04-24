// NCAAF Oracle v4.1 — Main Prediction Pipeline
// Orchestrates: data fetch → feature engineering → Monte Carlo → meta-model → Discord

import 'dotenv/config';
import { logger } from './logger.js';
import { fetchUpcomingGames, buildSPMap, buildEPAMap, buildRecruitingMap,
  buildReturningProdMap, fetchFBSTeams, buildLinesMap, fetchSPRatings,
  fetchRecruitingRatings, fetchReturningProduction, normalizeTeamName,
  getVenueCoords, isRivalryGame, fetchTop25, filterTop25Games } from './api/cfbdClient.js';
import { buildOddsMap, cfbdLineToOdds } from './api/oddsClient.js';
import { fetchGameWeather, isIndoorVenue } from './api/weatherClient.js';
import { loadEloRatings, saveEloRatings } from './features/eloEngine.js';
import { loadPreseasonPriors, loadPortalImpact, getBlendWeights } from './features/bootstrapEngine.js';
import { computeFeatures } from './features/featureEngine.js';
import { runMonteCarlo } from './models/monteCarlo.js';
import { loadModel, predict, isModelLoaded, getModelVersion } from './models/metaModel.js';
import { detectEdge, classifyConfidence } from './models/marketEdge.js';
import { initDatabase, getDb, upsertPrediction, saveDatabase,
  getSeasonAccuracy, loadEloRatingsFromDB, saveEloRatingsToDB } from './db/database.js';
import { sendPredictionsEmbed } from './alerts/discord.js';
import { getCurrentSeasonWindow, getCurrentWeek } from './season/seasonManager.js';
import { writePredictionsFile } from './kalshi/predictionsFile.js';
import type { CFBDGame, Prediction, WeekInfo } from './types.js';

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export async function runPredictionPipeline(
  overrideWeek?: number,
  overrideSeason?: number,
): Promise<Prediction[]> {
  // ── Step 1: Season gate ───────────────────────────────────────────────────
  const now = new Date();
  const seasonWindow = getCurrentSeasonWindow(now);
  if (!seasonWindow && !overrideWeek) {
    logger.info('Outside active season window — no-op');
    return [];
  }

  const season = overrideSeason ?? seasonWindow?.season ?? new Date().getFullYear();
  const weekInfo = overrideWeek
    ? buildWeekInfo(season, overrideWeek)
    : getCurrentWeek(season, now);

  if (!weekInfo) {
    logger.info({ season }, 'Could not determine current week — no-op');
    return [];
  }

  logger.info({ season, week: weekInfo.week, label: weekInfo.weekLabel }, 'Starting prediction pipeline');

  // ── Step 2: Init database ─────────────────────────────────────────────────
  const db = await initDatabase();

  // ── Step 3: Load model ────────────────────────────────────────────────────
  loadModel();
  const modelVersion = isModelLoaded() ? getModelVersion() : 'fallback-mc';
  logger.info({ modelVersion }, 'Model status');

  // ── Step 4: Load preseason priors and Elo ─────────────────────────────────
  const priors = loadPreseasonPriors();
  const portalMap = loadPortalImpact();
  const eloRatings = loadEloRatingsFromDB(db);
  if (eloRatings.size === 0) {
    // Also try file-based Elo
    const fileElo = loadEloRatings();
    fileElo.forEach((v, k) => eloRatings.set(k, v));
  }

  // ── Step 5: Fetch schedule + filter to Top 25 games ─────────────────────
  logger.info({ week: weekInfo.week }, 'Fetching schedule');
  const [allGames, top25] = await Promise.all([
    fetchUpcomingGames(season, weekInfo.week),
    fetchTop25(season, weekInfo.week),
  ]);

  const games = filterTop25Games(allGames, top25);
  logger.info({ total: allGames.length, top25Games: games.length }, 'Games filtered to Top 25');

  if (games.length === 0) {
    logger.warn({ week: weekInfo.week }, 'No Top 25 games found this week');
    return [];
  }

  // ── Step 6: Fetch stats ───────────────────────────────────────────────────
  logger.info('Fetching SP+, EPA, recruiting, returning production...');
  const [spMap, epaMap, recruitingMap, returningProdMap, linesMap, oddsMap] = await Promise.all([
    buildSPMap(season).catch(() => new Map()),
    buildEPAMap(season, weekInfo.week > 2 ? weekInfo.week - 1 : undefined).catch(() => new Map()),
    buildRecruitingMap(season).catch(() => new Map()),
    buildReturningProdMap(season).catch(() => new Map()),
    buildLinesMap(season, weekInfo.week).catch(() => new Map()),
    buildOddsMap().catch(() => new Map()),
  ]);

  // Flatten recruiting map to just composite points
  const recruitingPoints = new Map<string, number>();
  for (const [school, rating] of recruitingMap.entries()) {
    recruitingPoints.set(school, rating.points);
  }

  // Flatten returning production map to just total percent
  const returningPct = new Map<string, number>();
  for (const [school, rp] of returningProdMap.entries()) {
    returningPct.set(school, rp.totalPercent ?? rp.percentPPA ?? 0.5);
  }

  // ── Step 7: Generate predictions ─────────────────────────────────────────
  const predictions: Prediction[] = [];
  const blendW = getBlendWeights(weekInfo.week);

  for (const game of games) {
    try {
      const pred = await predictGame(
        game, weekInfo, eloRatings, priors, spMap, epaMap,
        recruitingPoints, portalMap, returningPct, linesMap, oddsMap,
        modelVersion,
      );
      predictions.push(pred);
      upsertPrediction(db, pred);
    } catch (err) {
      logger.error({ err, game: `${game.away_team} @ ${game.home_team}` }, 'Failed to predict game');
    }
  }

  // ── Step 8: Save database ─────────────────────────────────────────────────
  saveDatabase();
  saveEloRatingsToDB(db, eloRatings);
  saveEloRatings(eloRatings);

  // ── Step 8b: Write predictions JSON for kalshi-safety ────────────────────
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const outPath = writePredictionsFile(todayET, predictions);
    logger.info({ outPath, count: predictions.length }, 'Wrote kalshi-safety predictions JSON');
  } catch (err) {
    logger.warn({ err }, 'Failed to write predictions JSON (continuing)');
  }

  // ── Step 9: Send Discord embed ────────────────────────────────────────────
  const accuracy = getSeasonAccuracy(db, season);
  await sendPredictionsEmbed(weekInfo, predictions, accuracy);

  logger.info({ count: predictions.length }, 'Prediction pipeline complete');
  return predictions;
}

// ─── Predict a single game ────────────────────────────────────────────────────

async function predictGame(
  game: CFBDGame,
  weekInfo: WeekInfo,
  eloRatings: Map<string, number>,
  priors: Map<string, import('./types.js').PreseasonPrior>,
  spMap: Map<string, import('./types.js').CFBDTeamSPRating>,
  epaMap: Map<string, import('./types.js').CFBDTeamEPA>,
  recruitingPoints: Map<string, number>,
  portalMap: Map<string, number>,
  returningPct: Map<string, number>,
  linesMap: Map<string, import('./api/cfbdClient.js').CFBDLine extends never ? never : Awaited<ReturnType<typeof buildLinesMap>> extends Map<string, infer V> ? V : never>,
  oddsMap: Map<string, import('./api/oddsClient.js').GameOdds>,
  modelVersion: string,
): Promise<Prediction> {
  const homeKey = normalizeTeamName(game.home_team);
  const awayKey = normalizeTeamName(game.away_team);
  const gameKey = `${homeKey}-${awayKey}`;

  // Vegas odds (prefer The-Odds-API, fallback to CFBD lines)
  const oddsAPIData = oddsMap.get(gameKey);
  const cfbdLine = linesMap.get(gameKey);

  let vegasHomeProb: number | undefined;
  let vegasSpread: number | undefined;
  let vegasTotal: number | undefined;

  if (oddsAPIData?.vegasHomeProb) {
    vegasHomeProb = oddsAPIData.vegasHomeProb;
    vegasSpread = oddsAPIData.spread;
    vegasTotal = oddsAPIData.total;
  } else if (cfbdLine) {
    const parsed = cfbdLineToOdds(
      { spread: cfbdLine.spread, overUnder: cfbdLine.overUnder,
        homeMoneyline: cfbdLine.homeMoneyline, awayMoneyline: cfbdLine.awayMoneyline },
      game.home_team, game.away_team
    );
    vegasHomeProb = parsed.vegasHomeProb;
    vegasSpread = parsed.spread;
    vegasTotal = parsed.total;
  }

  // Weather
  const coords = getVenueCoords(game.home_team);
  const isDome = isIndoorVenue(homeKey);
  const gameDate = game.start_date.slice(0, 10);
  const weatherData = !isDome && coords
    ? await fetchGameWeather(coords.lat, coords.lon, gameDate).catch(() => undefined)
    : undefined;

  // Feature context
  const ctx = {
    game,
    week: weekInfo.week,
    season: weekInfo.season,
    eloRatings,
    priors,
    spMap,
    epaMap,
    recruitingMap: recruitingPoints,
    portalMap,
    returningProdMap: returningPct,
    weatherData,
    vegasHomeProb,
    vegasSpread,
    sosMap: new Map<string, number>(),
    coachExpMap: new Map<string, number>(),
    recentEPAMap: new Map<string, number>(),
    qbOutHome: false,
    qbOutAway: false,
  };

  const features = computeFeatures(ctx);

  // Monte Carlo
  const mcResult = runMonteCarlo(features);
  features.mc_win_pct = mcResult.win_probability;

  // Meta-model
  const calibratedProb = predict(features, mcResult.win_probability);

  // Confidence + edge
  const confidence = classifyConfidence(calibratedProb);
  const edgeResult = detectEdge(calibratedProb, vegasHomeProb);

  const blendW = getBlendWeights(weekInfo.week);

  const prediction: Prediction = {
    game_id: game.id,
    game_date: gameDate,
    season: weekInfo.season,
    week: weekInfo.week,
    season_type: game.season_type,
    home_team: game.home_team,
    away_team: game.away_team,
    venue: game.neutral_site ? 'Neutral Site' : `${game.home_team}`,
    is_prior_year_mode: blendW.isPriorYearMode,
    prior_year_weight: blendW.priorWeight,
    feature_vector: features,
    mc_win_pct: mcResult.win_probability,
    calibrated_prob: calibratedProb,
    confidence_tier: confidence.tier,
    vegas_prob: vegasHomeProb,
    edge: edgeResult.edge,
    edge_category: edgeResult.edgeCategory,
    model_version: modelVersion,
    home_exp_pts: mcResult.home_exp_pts,
    away_exp_pts: mcResult.away_exp_pts,
    total_points: mcResult.total_points,
    spread: mcResult.spread,
    most_likely_score: `${mcResult.most_likely_score[1]}-${mcResult.most_likely_score[0]}`,
    upset_probability: mcResult.upset_probability,
    blowout_probability: mcResult.blowout_probability,
    created_at: new Date().toISOString(),
  };

  logger.info({
    game: `${game.away_team} @ ${game.home_team}`,
    calibratedProb: calibratedProb.toFixed(3),
    tier: confidence.tier,
    edge: edgeResult.edge.toFixed(3),
  }, 'Game predicted');

  return prediction;
}

// ─── Helper: build WeekInfo from override ─────────────────────────────────────

function buildWeekInfo(season: number, week: number): WeekInfo {
  const blendW = getBlendWeights(week);
  const isBowl = week >= 16;
  return {
    season,
    week,
    weekLabel: isBowl ? 'Bowl Season' : week >= 15 ? 'Conference Championships' : `Week ${week}`,
    startDate: new Date().toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
    isPriorYearMode: blendW.isPriorYearMode,
    isBlendingMode: blendW.isBlendingMode,
    priorYearWeight: blendW.priorWeight,
    inSeasonWeight: blendW.inSeasonWeight,
    earlySeasonLabel: blendW.label,
  };
}

// Re-export for use in workflows
export type { CFBDLine } from './api/cfbdClient.js';
