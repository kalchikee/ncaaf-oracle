// NCAAF Oracle v4.1 — Prior-Year Bootstrap Engine (Weeks 0–2)
// The biggest challenge in CFB: zero current-season data in Week 1.
// This engine provides preseason feature vectors using:
//   1. Prior-year final SP+ (with 45% regression toward mean)
//   2. 247Sports recruiting talent composite
//   3. Returning production %
//   4. Transfer portal WAR estimate
//   5. Coaching stability penalties
//   6. Preseason Elo

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';
import { spPlusToElo, recruitingToElo, applyCoachingPenalty } from './eloEngine.js';
import type { PreseasonPrior, CFBDTeamSPRating, CFBDRecruitingRating, CFBDReturningProduction } from '../types.js';
import { normalizeTeamName } from '../api/cfbdClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PRESEASON_FILE = resolve(__dirname, '../../data/preseason/preseason_priors.json');
const PORTAL_FILE = resolve(__dirname, '../../data/preseason/portal_impact.json');

// ─── SP+ mean regression ───────────────────────────────────────────────────────
// 45% regression toward mean each offseason
const SP_REGRESSION = 0.45;
const SP_LEAGUE_MEAN = 0.0; // SP+ is centered at 0

export function regressSPPlus(priorSP: number): number {
  return priorSP * (1 - SP_REGRESSION) + SP_LEAGUE_MEAN * SP_REGRESSION;
}

// ─── Build preseason priors from raw data ─────────────────────────────────────

export function buildPreseasonPriors(
  season: number,
  priorSPRatings: CFBDTeamSPRating[],
  recruitingRatings: CFBDRecruitingRating[],
  returningProduction: CFBDReturningProduction[],
  portalImpact?: Map<string, number>,
  coachingChanges?: Map<string, { newHC: boolean; newOC: boolean; newDC: boolean }>,
): PreseasonPrior[] {
  const recruitMap = new Map<string, CFBDRecruitingRating>();
  for (const r of recruitingRatings) recruitMap.set(normalizeTeamName(r.team), r);

  const returningMap = new Map<string, CFBDReturningProduction>();
  for (const r of returningProduction) returningMap.set(normalizeTeamName(r.team), r);

  const priors: PreseasonPrior[] = [];

  for (const sp of priorSPRatings) {
    const key = normalizeTeamName(sp.team);

    const regressedSP = regressSPPlus(sp.rating);
    const regressedOffSP = regressSPPlus(sp.offense?.rating ?? 0);
    const regressedDefSP = regressSPPlus(sp.defense?.rating ?? 0);

    const recruiting = recruitMap.get(key);
    const returning = returningMap.get(key);
    const portal = portalImpact?.get(key) ?? 0;
    const coaching = coachingChanges?.get(key);

    const newHeadCoach = coaching?.newHC ?? false;
    const newOC = coaching?.newOC ?? false;
    const newDC = coaching?.newDC ?? false;

    // Coaching penalty in SP+ points
    let coachingPenalty = 0;
    if (newHeadCoach) coachingPenalty -= 3;
    if (newOC) coachingPenalty -= 1.5;
    if (newDC) coachingPenalty -= 1.5;

    const adjustedSP = regressedSP + coachingPenalty + portal;

    // Preseason Elo: 55% prior-year final + 25% recruiting composite + 20% league mean
    const priorElo = spPlusToElo(sp.rating);
    const recruitingElo = recruiting ? recruitingToElo(recruiting.points) : 1500;
    const leagueMeanElo = 1500;
    const preseasonElo = 0.55 * priorElo + 0.25 * recruitingElo + 0.20 * leagueMeanElo;
    const adjustedElo = applyCoachingPenalty(preseasonElo, newHeadCoach, newOC, newDC);

    priors.push({
      school: key,
      season,
      spPrior: adjustedSP,
      spOffPrior: regressedOffSP + coachingPenalty * 0.5,
      spDefPrior: regressedDefSP + coachingPenalty * 0.5,
      recruitingComposite: recruiting?.points ?? 150,
      returningProductionOff: returning?.offense?.total ?? 0.5,
      returningProductionDef: returning?.defense?.total ?? 0.5,
      returningProductionTotal: returning?.totalPercent ?? 0.5,
      portalWAR: portal,
      portalQBChange: false, // set externally
      newHeadCoach,
      newOC,
      newDC,
      coachingPenalty,
      preseasonElo: adjustedElo,
      fpi: 0, // filled from ESPN FPI if available
    });
  }

  logger.info({ count: priors.length, season }, 'Built preseason priors');
  return priors;
}

// ─── Load cached preseason priors ─────────────────────────────────────────────

export function loadPreseasonPriors(): Map<string, PreseasonPrior> {
  if (!existsSync(PRESEASON_FILE)) {
    logger.warn('No preseason priors file found. Run preseason setup first.');
    return new Map();
  }
  try {
    const data = JSON.parse(readFileSync(PRESEASON_FILE, 'utf-8')) as PreseasonPrior[];
    return new Map(data.map(p => [p.school, p]));
  } catch {
    return new Map();
  }
}

// ─── Load portal impact ────────────────────────────────────────────────────────

export function loadPortalImpact(): Map<string, number> {
  if (!existsSync(PORTAL_FILE)) return new Map();
  try {
    const data = JSON.parse(readFileSync(PORTAL_FILE, 'utf-8')) as Record<string, number>;
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

// ─── Blending weights by week ─────────────────────────────────────────────────

export interface BlendWeights {
  priorWeight: number;
  inSeasonWeight: number;
  isPriorYearMode: boolean;
  isBlendingMode: boolean;
  label: string;
}

export function getBlendWeights(week: number): BlendWeights {
  if (week <= 1) {
    return { priorWeight: 0.85, inSeasonWeight: 0.15, isPriorYearMode: true, isBlendingMode: false, label: '🟡 EARLY SEASON — Prior-Year Baseline' };
  } else if (week === 2) {
    return { priorWeight: 0.70, inSeasonWeight: 0.30, isPriorYearMode: true, isBlendingMode: false, label: '🟡 EARLY SEASON — Prior-Year Baseline' };
  } else if (week === 3) {
    return { priorWeight: 0.55, inSeasonWeight: 0.45, isPriorYearMode: false, isBlendingMode: true, label: '🟠 Blending prior-year + current data' };
  } else if (week === 4) {
    return { priorWeight: 0.40, inSeasonWeight: 0.60, isPriorYearMode: false, isBlendingMode: true, label: '🟠 Blending prior-year + current data' };
  } else if (week === 5) {
    return { priorWeight: 0.30, inSeasonWeight: 0.70, isPriorYearMode: false, isBlendingMode: false, label: '' };
  } else if (week === 6) {
    return { priorWeight: 0.20, inSeasonWeight: 0.80, isPriorYearMode: false, isBlendingMode: false, label: '' };
  } else if (week <= 14) {
    return { priorWeight: 0.10, inSeasonWeight: 0.90, isPriorYearMode: false, isBlendingMode: false, label: '' };
  } else {
    // Bowl season / CFP
    return { priorWeight: 0.07, inSeasonWeight: 0.93, isPriorYearMode: false, isBlendingMode: false, label: '' };
  }
}

// ─── Blend prior + in-season values ──────────────────────────────────────────

export function blendValue(priorValue: number, inSeasonValue: number | undefined, week: number): number {
  const { priorWeight, inSeasonWeight } = getBlendWeights(week);
  if (inSeasonValue === undefined || inSeasonValue === 0) {
    return priorValue;
  }
  return priorWeight * priorValue + inSeasonWeight * inSeasonValue;
}

// ─── Get effective SP+ for a team given current week ─────────────────────────

export function getEffectiveSP(
  school: string,
  week: number,
  priors: Map<string, PreseasonPrior>,
  currentSP?: number,
): number {
  const prior = priors.get(school);
  if (!prior) return 0;
  if (week <= 2 || currentSP === undefined) return prior.spPrior;
  return blendValue(prior.spPrior, currentSP, week);
}

export function getEffectiveElo(
  school: string,
  week: number,
  priors: Map<string, PreseasonPrior>,
  currentElo?: number,
): number {
  const prior = priors.get(school);
  if (!prior) return 1500;
  if (week <= 2 || currentElo === undefined) return prior.preseasonElo;
  return blendValue(prior.preseasonElo, currentElo, week);
}
