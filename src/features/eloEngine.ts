// NCAAF Oracle v4.1 — Elo Rating Engine
// K-factor: 25 | Margin cap: 28 pts | Offseason regression
// Preseason formula: 0.55 × prior-year final + 0.25 × recruiting composite + 0.20 × league mean

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';
import type { EloRating, GameResult, PreseasonEloInput } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ELO_FILE = resolve(__dirname, '../../data/elo_ratings.json');
const LEAGUE_MEAN_ELO = 1500;
const K_FACTOR = 25;
const MARGIN_CAP = 28;
const OFFSEASON_REGRESSION = 0.55; // how much of prior-year Elo to keep

// ─── Load / save ───────────────────────────────────────────────────────────────

export function loadEloRatings(): Map<string, number> {
  if (!existsSync(ELO_FILE)) return new Map();
  try {
    const data = JSON.parse(readFileSync(ELO_FILE, 'utf-8')) as EloRating[];
    return new Map(data.map(r => [r.school, r.rating]));
  } catch {
    return new Map();
  }
}

export function saveEloRatings(ratings: Map<string, number>): void {
  const data: EloRating[] = [...ratings.entries()].map(([school, rating]) => ({
    school,
    rating,
    updatedAt: new Date().toISOString(),
  }));
  writeFileSync(ELO_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Elo helpers ───────────────────────────────────────────────────────────────

export function expectedWinPct(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function marginMultiplier(margin: number): number {
  const capped = Math.min(margin, MARGIN_CAP);
  return Math.log(capped + 1) * 2.2;
}

// ─── Update Elo after a game ───────────────────────────────────────────────────

export function updateElo(
  ratings: Map<string, number>,
  result: GameResult,
): void {
  const homeRating = ratings.get(result.homeTeam) ?? LEAGUE_MEAN_ELO;
  const awayRating = ratings.get(result.awayTeam) ?? LEAGUE_MEAN_ELO;

  const homeExpected = expectedWinPct(homeRating, awayRating);
  const homeActual = result.homeScore > result.awayScore ? 1 : 0;

  const multiplier = marginMultiplier(result.margin);
  const change = K_FACTOR * multiplier * (homeActual - homeExpected);

  ratings.set(result.homeTeam, homeRating + change);
  ratings.set(result.awayTeam, awayRating - change);
}

// ─── Batch update Elo from a list of results ──────────────────────────────────

export function batchUpdateElo(ratings: Map<string, number>, results: GameResult[]): void {
  for (const result of results) {
    updateElo(ratings, result);
  }
}

// ─── Preseason Elo computation ─────────────────────────────────────────────────
// Formula: 0.55 × prior-year final + 0.25 × recruiting composite Elo + 0.20 × league mean

export function computePreseasonElo(
  inputs: PreseasonEloInput[],
): Map<string, number> {
  const preseasonRatings = new Map<string, number>();

  for (const input of inputs) {
    const regressed =
      OFFSEASON_REGRESSION * input.priorYearFinalElo +
      0.25 * input.recruitingCompositeElo +
      0.20 * input.leagueMeanElo;
    preseasonRatings.set(input.school, regressed);
  }

  return preseasonRatings;
}

// ─── Convert 247Sports recruiting points → Elo scale ─────────────────────────
// 247Sports talent composite: top teams ~300, average ~180, bottom ~80
// Map to Elo range 1300–1750

export function recruitingToElo(talentComposite: number): number {
  const MIN_TALENT = 80;
  const MAX_TALENT = 320;
  const MIN_ELO = 1300;
  const MAX_ELO = 1750;
  const clamped = Math.max(MIN_TALENT, Math.min(MAX_TALENT, talentComposite));
  return MIN_ELO + ((clamped - MIN_TALENT) / (MAX_TALENT - MIN_TALENT)) * (MAX_ELO - MIN_ELO);
}

// ─── SP+ → Elo scale ──────────────────────────────────────────────────────────
// SP+: top teams ~30, average 0, bottom ~-30
// Map to Elo range 1250–1750

export function spPlusToElo(spRating: number): number {
  const BASE = 1500;
  const SCALE = 8.33; // 30 SP+ pts ≈ 250 Elo pts
  return BASE + spRating * SCALE;
}

// ─── Get current Elo with fallback ────────────────────────────────────────────

export function getElo(ratings: Map<string, number>, school: string): number {
  return ratings.get(school) ?? LEAGUE_MEAN_ELO;
}

// ─── Initialize ratings for new teams ────────────────────────────────────────

export function initializeNewTeams(
  ratings: Map<string, number>,
  teams: string[],
): void {
  for (const team of teams) {
    if (!ratings.has(team)) {
      ratings.set(team, LEAGUE_MEAN_ELO);
      logger.debug({ team }, 'Initialized new team Elo');
    }
  }
}

// ─── Apply coaching penalty to Elo ───────────────────────────────────────────

export function applyCoachingPenalty(
  baseElo: number,
  newHeadCoach: boolean,
  newOC: boolean,
  newDC: boolean,
): number {
  // Penalties in SP+ points, then convert to Elo
  let penaltySP = 0;
  if (newHeadCoach) penaltySP -= 3;
  if (newOC) penaltySP -= 1.5;
  if (newDC) penaltySP -= 1.5;
  return baseElo + penaltySP * 8.33; // same scale as spPlusToElo
}

// ─── Export ratings as array ───────────────────────────────────────────────────

export function ratingsToArray(ratings: Map<string, number>): EloRating[] {
  const now = new Date().toISOString();
  return [...ratings.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([school, rating]) => ({ school, rating, updatedAt: now }));
}

export { LEAGUE_MEAN_ELO };
