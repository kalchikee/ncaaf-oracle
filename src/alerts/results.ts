// NCAAF Oracle v4.1 — Weekend Recap: Score predictions, update accuracy
// Runs Monday morning (Sunday 11 PM ET) after weekend games are final.
// Fetches results, grades predictions, updates running totals, sends Discord recap.

import { logger } from '../logger.js';
import { fetchCompletedGames, toGameResult, normalizeTeamName } from '../api/cfbdClient.js';
import { brierScore, logLoss } from '../models/marketEdge.js';
import {
  getDb, getPendingPredictions, markPredictionResult,
  getSeasonAccuracy, upsertSeasonAccuracy, upsertGameResult,
} from '../db/database.js';
import { sendRecapEmbed } from './discord.js';
import type { Prediction, SeasonAccuracy, WeeklyRecord, WeekInfo } from '../types.js';

// ─── Grade predictions for a given week ─────────────────────────────────────

export async function gradeWeek(weekInfo: WeekInfo): Promise<{
  graded: Prediction[];
  weekWins: number;
  weekLosses: number;
  weekBrier: number;
}> {
  const { season, week } = weekInfo;
  const db = getDb();

  // Fetch completed game results
  const rawGames = await fetchCompletedGames(season, week);
  const rawPostseason = await fetchCompletedGames(season, week).catch(() => []);

  const allGames = [...rawGames, ...rawPostseason];
  const resultsMap = new Map<string, { winner: string; homeScore: number; awayScore: number }>();

  for (const g of allGames) {
    if (g.home_points === undefined || g.away_points === undefined) continue;
    const result = toGameResult(g);
    if (!result) continue;
    upsertGameResult(db, result);
    const key = `${normalizeTeamName(g.home_team)}-${normalizeTeamName(g.away_team)}`;
    resultsMap.set(key, {
      winner: result.winner,
      homeScore: result.homeScore,
      awayScore: result.awayScore,
    });
  }

  // Get predictions for this week that haven't been graded
  const pendingPreds = getPendingPredictions(db, season).filter(p => p.week === week);

  const graded: Prediction[] = [];
  let weekWins = 0;
  let weekLosses = 0;
  let totalBrier = 0;
  let gradedCount = 0;

  for (const pred of pendingPreds) {
    const homeKey = normalizeTeamName(pred.home_team);
    const awayKey = normalizeTeamName(pred.away_team);
    const key = `${homeKey}-${awayKey}`;
    const result = resultsMap.get(key);

    if (!result) {
      logger.debug({ game: key }, 'No result found for prediction');
      continue;
    }

    const homeWin = pred.calibrated_prob >= 0.5;
    const modelPick = homeWin ? pred.home_team : pred.away_team;
    const correct = normalizeTeamName(result.winner) === normalizeTeamName(modelPick);

    const outcome = normalizeTeamName(result.winner) === homeKey ? 1 : 0;
    const bs = brierScore(pred.calibrated_prob, outcome);

    markPredictionResult(db, pred.game_id, result.winner, result.homeScore, result.awayScore, correct, bs);

    const gradedPred: Prediction = {
      ...pred,
      actual_winner: result.winner,
      home_score: result.homeScore,
      away_score: result.awayScore,
      correct,
      brier_score: bs,
    };
    graded.push(gradedPred);

    if (correct) weekWins++;
    else weekLosses++;
    totalBrier += bs;
    gradedCount++;
  }

  const weekBrier = gradedCount > 0 ? totalBrier / gradedCount : 0;
  logger.info({ week, weekWins, weekLosses, weekBrier: weekBrier.toFixed(3) }, 'Week graded');

  return { graded, weekWins, weekLosses, weekBrier };
}

// ─── Update season accuracy totals ───────────────────────────────────────────

export function updateSeasonAccuracy(
  season: number,
  graded: Prediction[],
  week: number,
  weekWins: number,
  weekLosses: number,
  weekBrier: number,
): SeasonAccuracy {
  const db = getDb();
  const existing = getSeasonAccuracy(db, season) ?? initEmptyAccuracy(season);

  existing.totalPicks += weekWins + weekLosses;
  existing.correctPicks += weekWins;

  // High conviction (67%+)
  const highConvWeek = graded.filter(p =>
    p.confidence_tier === 'high_conviction' || p.confidence_tier === 'extreme_conviction'
  );
  existing.highConvPicks += highConvWeek.length;
  existing.highConvCorrect += highConvWeek.filter(p => p.correct).length;

  // Extreme conviction (72%+)
  const extremeConvWeek = graded.filter(p => p.confidence_tier === 'extreme_conviction');
  existing.extremeConvPicks += extremeConvWeek.length;
  existing.extremeConvCorrect += extremeConvWeek.filter(p => p.correct).length;

  // ATS (when spread available)
  const atsGames = graded.filter(p => p.spread !== undefined && p.vegas_prob !== undefined);
  for (const pred of atsGames) {
    const homeWin = pred.home_score !== undefined && pred.away_score !== undefined
      && pred.home_score > pred.away_score;
    const margin = pred.home_score !== undefined && pred.away_score !== undefined
      ? pred.home_score - pred.away_score
      : 0;
    const spread = pred.spread ?? 0;
    // ATS: home covers if margin > spread (or away covers if margin < spread)
    const coversHome = margin > spread;
    const modelPicksHome = pred.calibrated_prob >= 0.5;
    const atsCover = modelPicksHome ? coversHome : !coversHome;
    if (atsCover) existing.atsWins++;
    else existing.atsLosses++;
  }

  // Edge picks
  const edgePicks = graded.filter(p => p.edge_category === 'large' || p.edge_category === 'extreme' || p.edge_category === 'meaningful');
  existing.edgePickWins += edgePicks.filter(p => p.correct).length;
  existing.edgePickLosses += edgePicks.filter(p => !p.correct).length;

  // Brier and accuracy
  existing.accuracy = existing.totalPicks > 0 ? existing.correctPicks / existing.totalPicks : 0;
  existing.highConvAccuracy = existing.highConvPicks > 0 ? existing.highConvCorrect / existing.highConvPicks : 0;
  existing.extremeConvAccuracy = existing.extremeConvPicks > 0 ? existing.extremeConvCorrect / existing.extremeConvPicks : 0;
  existing.atsAccuracy = (existing.atsWins + existing.atsLosses) > 0 ? existing.atsWins / (existing.atsWins + existing.atsLosses) : 0;
  existing.edgePickAccuracy = (existing.edgePickWins + existing.edgePickLosses) > 0 ? existing.edgePickWins / (existing.edgePickWins + existing.edgePickLosses) : 0;

  // Update Brier as running average
  const totalGraded = existing.totalPicks;
  const priorBrierTotal = existing.brierScore * (totalGraded - (weekWins + weekLosses));
  existing.brierScore = (priorBrierTotal + weekBrier * (weekWins + weekLosses)) / totalGraded;

  // Weekly record
  const weeklyEntry: WeeklyRecord = {
    week,
    wins: weekWins,
    losses: weekLosses,
    accuracy: weekWins + weekLosses > 0 ? weekWins / (weekWins + weekLosses) : 0,
    brierScore: weekBrier,
  };

  // Update or insert weekly record
  const existingWeekIdx = existing.weeklyRecord.findIndex(w => w.week === week);
  if (existingWeekIdx >= 0) {
    existing.weeklyRecord[existingWeekIdx] = weeklyEntry;
  } else {
    existing.weeklyRecord.push(weeklyEntry);
    existing.weeklyRecord.sort((a, b) => a.week - b.week);
  }

  // Best/worst week
  const weeksWithGames = existing.weeklyRecord.filter(w => w.wins + w.losses >= 3);
  if (weeksWithGames.length > 0) {
    const best = weeksWithGames.reduce((a, b) => a.accuracy > b.accuracy ? a : b);
    const worst = weeksWithGames.reduce((a, b) => a.accuracy < b.accuracy ? a : b);
    existing.bestWeek = best.week;
    existing.worstWeek = worst.week;
  }

  upsertSeasonAccuracy(db, existing);
  logger.info({
    season,
    record: `${existing.correctPicks}-${existing.totalPicks - existing.correctPicks}`,
    accuracy: (existing.accuracy * 100).toFixed(1),
  }, 'Season accuracy updated');

  return existing;
}

function initEmptyAccuracy(season: number): SeasonAccuracy {
  return {
    season,
    totalPicks: 0,
    correctPicks: 0,
    accuracy: 0,
    highConvPicks: 0,
    highConvCorrect: 0,
    highConvAccuracy: 0,
    extremeConvPicks: 0,
    extremeConvCorrect: 0,
    extremeConvAccuracy: 0,
    atsWins: 0,
    atsLosses: 0,
    atsAccuracy: 0,
    edgePickWins: 0,
    edgePickLosses: 0,
    edgePickAccuracy: 0,
    brierScore: 0,
    logLoss: 0,
    weeklyRecord: [],
    bestWeek: 0,
    worstWeek: 0,
  };
}

// ─── Full recap pipeline ──────────────────────────────────────────────────────

export async function runRecapPipeline(weekInfo: WeekInfo): Promise<void> {
  logger.info({ week: weekInfo.week, season: weekInfo.season }, 'Starting recap pipeline');

  const { graded, weekWins, weekLosses, weekBrier } = await gradeWeek(weekInfo);

  if (graded.length === 0) {
    logger.warn({ week: weekInfo.week }, 'No graded predictions found, skipping recap');
    return;
  }

  const accuracy = updateSeasonAccuracy(
    weekInfo.season, graded, weekInfo.week, weekWins, weekLosses, weekBrier
  );

  await sendRecapEmbed(weekInfo, graded, accuracy);
  logger.info({ week: weekInfo.week }, 'Recap pipeline complete');
}
