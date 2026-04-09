// NCAAF Oracle v4.1 — Monte Carlo Score Simulation
// 10,000 iterations per game
// exp_pts = team_off_efficiency × (opp_def_efficiency / league_avg) × pace_adj × weather_adj × home_adj × injury_adj
// Simulates NCAA overtime rules for ties.

import type { NCAAFFeatureVector, MonteCarloResult } from '../types.js';

const SIMULATIONS = 10_000;
const SCORE_STD = 14;           // CFB typical std dev
const LEAGUE_AVG_SCORE = 27.5;  // FBS average points per game

// ─── Box-Muller Normal random ─────────────────────────────────────────────────

function randNormal(mean: number, std: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z;
}

// ─── Expected scoring from features ──────────────────────────────────────────

export interface ScoringEstimate {
  homeExpPts: number;
  awayExpPts: number;
  homeStd: number;
  awayStd: number;
}

export function estimateScoring(features: NCAAFFeatureVector): ScoringEstimate {
  // Base expected points from SP+ differential
  // SP+ = 0 → ~27.5 pts. Each SP+ point ≈ ~0.7 pts of scoring.
  const SP_SCALE = 0.7;

  // Home offensive efficiency vs away defensive efficiency
  const homeOff = LEAGUE_AVG_SCORE + features.sp_plus_off_diff * SP_SCALE * 0.5;
  const awayOff = LEAGUE_AVG_SCORE - features.sp_plus_off_diff * SP_SCALE * 0.5;

  // Adjust for home field
  const homeFieldBonus = features.is_neutral_site ? 0 : features.home_field_adj * 0.5;

  // EPA-based adjustments (when available)
  const homeEPAAdj = (features.off_epa_diff + features.def_epa_diff) * 3;
  const awayEPAAdj = -(features.off_epa_diff + features.def_epa_diff) * 3;

  // Weather adjustments (reduce total scoring)
  const totalWeatherPenalty = features.wind_adj + features.precip_adj + features.temp_adj;
  const weatherSplit = totalWeatherPenalty / 2;  // split between both teams

  // Injury adjustments
  const homeInjuryAdj = features.injury_qb_flag_home * -4;
  const awayInjuryAdj = features.injury_qb_flag_away * -4;

  // Pace adjustment (high-pace teams score more)
  const paceFactor = 1 + features.pace_diff * 0.003;

  let homeExpPts = (homeOff + homeFieldBonus + homeEPAAdj + weatherSplit + homeInjuryAdj) * paceFactor;
  let awayExpPts = (awayOff - homeFieldBonus + awayEPAAdj + weatherSplit + awayInjuryAdj) * (1 / paceFactor);

  // Floor: college teams always score something
  homeExpPts = Math.max(10, homeExpPts);
  awayExpPts = Math.max(10, awayExpPts);

  // Standard deviation: slightly higher for windy/rainy games
  const stdMultiplier = 1 + Math.abs(totalWeatherPenalty) * 0.02;
  const homeStd = SCORE_STD * stdMultiplier;
  const awayStd = SCORE_STD * stdMultiplier;

  return { homeExpPts, awayExpPts, homeStd, awayStd };
}

// ─── Simulate NCAA overtime ───────────────────────────────────────────────────
// Each OT: teams alternate possessions from the 25-yard line (~50% chance to score each)
// Starting OT4: teams go for 2 after TD

function simulateOT(homeOTProb: number, awayOTProb: number): 'home' | 'away' {
  for (let ot = 1; ot <= 7; ot++) {
    const homeScore = Math.random() < homeOTProb ? (Math.random() < 0.1 ? 3 : 7) : 0;
    const awayScore = Math.random() < awayOTProb ? (Math.random() < 0.1 ? 3 : 7) : 0;
    if (homeScore > awayScore) return 'home';
    if (awayScore > homeScore) return 'away';
    // tie → next OT
  }
  // After 7 OTs, coin flip
  return Math.random() < 0.5 ? 'home' : 'away';
}

// ─── Main simulation ──────────────────────────────────────────────────────────

export function runMonteCarlo(features: NCAAFFeatureVector): MonteCarloResult {
  const est = estimateScoring(features);

  let homeWins = 0;
  const spreads: number[] = [];
  const totals: number[] = [];
  const homeScores: number[] = [];
  const awayScores: number[] = [];
  let blowouts = 0;
  let upsets = 0;

  // Determine if home is the "stronger" team by Elo
  const homeStronger = features.elo_diff > 0;

  for (let i = 0; i < SIMULATIONS; i++) {
    let home = Math.max(0, Math.round(randNormal(est.homeExpPts, est.homeStd)));
    let away = Math.max(0, Math.round(randNormal(est.awayExpPts, est.awayStd)));

    let winner: 'home' | 'away';
    if (home === away) {
      winner = simulateOT(0.55, 0.52); // slight home advantage in OT
      if (winner === 'home') home += 3;
      else away += 3;
    } else {
      winner = home > away ? 'home' : 'away';
    }

    if (winner === 'home') homeWins++;

    const spread = home - away;
    spreads.push(spread);
    totals.push(home + away);
    homeScores.push(home);
    awayScores.push(away);

    if (Math.abs(spread) >= 21) blowouts++;
    // Upset = expected loser wins
    if (homeStronger && winner === 'away') upsets++;
    if (!homeStronger && winner === 'home') upsets++;
  }

  const win_probability = homeWins / SIMULATIONS;
  const away_win_probability = 1 - win_probability;

  const avgSpread = spreads.reduce((a, b) => a + b, 0) / SIMULATIONS;
  const avgTotal = totals.reduce((a, b) => a + b, 0) / SIMULATIONS;

  // Most likely score: mode of rounded scores
  const homeAvg = Math.round(homeScores.reduce((a, b) => a + b, 0) / SIMULATIONS);
  const awayAvg = Math.round(awayScores.reduce((a, b) => a + b, 0) / SIMULATIONS);

  return {
    win_probability,
    away_win_probability,
    spread: avgSpread,
    total_points: avgTotal,
    most_likely_score: [homeAvg, awayAvg],
    upset_probability: upsets / SIMULATIONS,
    blowout_probability: blowouts / SIMULATIONS,
    home_exp_pts: est.homeExpPts,
    away_exp_pts: est.awayExpPts,
    simulations: SIMULATIONS,
  };
}
