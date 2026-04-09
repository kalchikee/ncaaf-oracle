// NCAAF Oracle v4.1 — Entry Point
// Usage:
//   node index.ts --alert picks       → run weekly prediction pipeline
//   node index.ts --alert recap       → run weekend recap pipeline
//   node index.ts --alert preseason   → run preseason setup
//   node index.ts --alert test        → send test Discord embed
//   node index.ts --week 5            → override week number
//   node index.ts --season 2025       → override season year

import 'dotenv/config';
import { logger } from './logger.js';
import { checkSeasonGate, getCurrentSeasonWindow, getCurrentWeek, getRecapWeek, SEASON_YEAR } from './season/seasonManager.js';
import { runPredictionPipeline } from './pipeline.js';
import { runRecapPipeline } from './alerts/results.js';
import { sendTestEmbed, sendPreseasonEmbed } from './alerts/discord.js';
import { initDatabase, getDb, saveDatabase } from './db/database.js';
import { fetchSPRatings, fetchRecruitingRatings, fetchReturningProduction, fetchFBSTeams } from './api/cfbdClient.js';
import { buildPreseasonPriors, loadPortalImpact } from './features/bootstrapEngine.js';
import { computePreseasonElo, recruitingToElo, saveEloRatings } from './features/eloEngine.js';
import { loadModel } from './models/metaModel.js';
import { saveEloRatingsToDB } from './db/database.js';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Parse CLI arguments ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const alertType = getArg('--alert') ?? 'picks';
const overrideWeek = getArg('--week') ? parseInt(getArg('--week')!) : undefined;
const overrideSeason = getArg('--season') ? parseInt(getArg('--season')!) : undefined;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info({ alertType, overrideWeek, overrideSeason }, 'NCAAF Oracle v4.1 starting');

  if (alertType === 'test') {
    await sendTestEmbed();
    logger.info('Test embed sent');
    return;
  }

  if (alertType === 'preseason') {
    await runPreseasonSetup(overrideSeason ?? SEASON_YEAR);
    return;
  }

  // Season gate check (skip for manual overrides)
  if (!overrideWeek && !overrideSeason) {
    const active = checkSeasonGate();
    if (!active) {
      logger.info('Season gate: off-season. Exiting cleanly.');
      process.exit(0);
    }
  }

  if (alertType === 'recap') {
    const now = new Date();
    const seasonWindow = getCurrentSeasonWindow(now);
    const season = overrideSeason ?? seasonWindow?.season ?? SEASON_YEAR;
    const weekInfo = overrideWeek
      ? buildWeekInfoFromOverride(season, overrideWeek)
      : getRecapWeek(season, now);

    if (!weekInfo) {
      logger.warn('Could not determine recap week');
      return;
    }

    await initDatabase();
    await runRecapPipeline(weekInfo);
    return;
  }

  // Default: run prediction pipeline
  await runPredictionPipeline(overrideWeek, overrideSeason);
}

// ─── Preseason setup ──────────────────────────────────────────────────────────

async function runPreseasonSetup(season: number): Promise<void> {
  logger.info({ season }, 'Running preseason setup');

  await initDatabase();
  const db = getDb();

  // Load prior-year data
  const priorSeason = season - 1;
  logger.info({ priorSeason }, 'Fetching prior-year SP+ ratings');
  const [priorSP, recruiting, returning] = await Promise.all([
    fetchSPRatings(priorSeason),
    fetchRecruitingRatings(season),
    fetchReturningProduction(season).catch(() => []),
  ]);

  // Load portal impact (should be pre-loaded)
  const portalImpact = loadPortalImpact();

  // Build preseason priors
  const priors = buildPreseasonPriors(
    season,
    priorSP,
    recruiting,
    returning,
    portalImpact,
  );

  // Compute preseason Elo
  const eloInputs = priors.map(p => ({
    school: p.school,
    priorYearFinalElo: 1500 + p.spPrior * 8.33,
    recruitingCompositeElo: recruitingToElo(p.recruitingComposite),
    leagueMeanElo: 1500,
  }));
  const eloRatings = computePreseasonElo(eloInputs);

  // Save preseason priors
  const preseasonDir = resolve(__dirname, '../data/preseason');
  mkdirSync(preseasonDir, { recursive: true });
  writeFileSync(
    resolve(preseasonDir, 'preseason_priors.json'),
    JSON.stringify(priors, null, 2),
  );

  // Save Elo ratings
  saveEloRatings(eloRatings);
  saveEloRatingsToDB(db, eloRatings);
  saveDatabase();

  const fbsTeams = await fetchFBSTeams().catch(() => []);
  await sendPreseasonEmbed(season, fbsTeams.length || priors.length);

  logger.info({ season, teams: priors.length }, 'Preseason setup complete');
}

// ─── Helper ───────────────────────────────────────────────────────────────────

import { getBlendWeights } from './features/bootstrapEngine.js';
import type { WeekInfo } from './types.js';

function buildWeekInfoFromOverride(season: number, week: number): WeekInfo {
  const blendW = getBlendWeights(week);
  return {
    season,
    week,
    weekLabel: week >= 16 ? 'Bowl Season' : week >= 15 ? 'Conference Championships' : `Week ${week}`,
    startDate: new Date().toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
    isPriorYearMode: blendW.isPriorYearMode,
    isBlendingMode: blendW.isBlendingMode,
    priorYearWeight: blendW.priorWeight,
    inSeasonWeight: blendW.inSeasonWeight,
    earlySeasonLabel: blendW.label,
  };
}

main().catch(err => {
  logger.error({ err }, 'Fatal error in NCAAF Oracle');
  process.exit(1);
});
