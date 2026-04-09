// NCAAF Oracle v4.1 — Feature Engineering Engine
// Computes the 40–60 feature vector for each game.
// All features are home-vs-away differences where applicable.
// Prior-year bootstrap blends in for Weeks 0–6.

import { logger } from '../logger.js';
import { getBlendWeights, blendValue } from './bootstrapEngine.js';
import { getEffectiveSP, getEffectiveElo } from './bootstrapEngine.js';
import { getHomeFieldAdj, isRivalryGame, normalizeTeamName } from '../api/cfbdClient.js';
import { computeWeatherAdj, isIndoorVenue } from '../api/weatherClient.js';
import type {
  NCAAFFeatureVector, CFBDGame, CFBDTeamSPRating,
  CFBDTeamEPA, PreseasonPrior, WeatherData
} from '../types.js';

// ─── Feature computation context ─────────────────────────────────────────────

export interface FeatureContext {
  game: CFBDGame;
  week: number;
  season: number;
  // Team ratings
  eloRatings: Map<string, number>;          // school → current Elo
  priors: Map<string, PreseasonPrior>;       // school → preseason prior
  spMap: Map<string, CFBDTeamSPRating>;      // school → current season SP+
  epaMap: Map<string, CFBDTeamEPA>;          // school → current season EPA
  // Recruiting / portal / returning production
  recruitingMap: Map<string, number>;        // school → talent composite points
  portalMap: Map<string, number>;            // school → portal WAR
  returningProdMap: Map<string, number>;     // school → returning production %
  // Weather
  weatherData?: WeatherData;
  // Vegas
  vegasHomeProb?: number;
  vegasSpread?: number;
  // SOS
  sosMap: Map<string, number>;              // school → SOS
  // Coaching experience
  coachExpMap: Map<string, number>;          // school → HC years at school
  // Recent form (last 5 games EPA) — Week 6+
  recentEPAMap: Map<string, number>;         // school → recent EPA
  // Injury: QB availability
  qbOutHome: boolean;
  qbOutAway: boolean;
}

// ─── Main feature computation ─────────────────────────────────────────────────

export function computeFeatures(ctx: FeatureContext): NCAAFFeatureVector {
  const { game, week } = ctx;
  const homeKey = normalizeTeamName(game.home_team);
  const awayKey = normalizeTeamName(game.away_team);

  const blendW = getBlendWeights(week);

  // ── Elo ──────────────────────────────────────────────────────────────────────
  const homeEloCurrent = ctx.eloRatings.get(homeKey);
  const awayEloCurrent = ctx.eloRatings.get(awayKey);
  const homeElo = getEffectiveElo(homeKey, week, ctx.priors, homeEloCurrent);
  const awayElo = getEffectiveElo(awayKey, week, ctx.priors, awayEloCurrent);
  const elo_diff = homeElo - awayElo;

  // ── SP+ ──────────────────────────────────────────────────────────────────────
  const homeSPCurrent = ctx.spMap.get(homeKey)?.rating;
  const awaySPCurrent = ctx.spMap.get(awayKey)?.rating;
  const homeSPOff = ctx.spMap.get(homeKey)?.offense?.rating;
  const awaySPOff = ctx.spMap.get(awayKey)?.offense?.rating;
  const homeSPDef = ctx.spMap.get(homeKey)?.defense?.rating;
  const awaySPDef = ctx.spMap.get(awayKey)?.defense?.rating;
  const homeSPST = ctx.spMap.get(homeKey)?.specialTeams?.rating ?? 0;
  const awaySPST = ctx.spMap.get(awayKey)?.specialTeams?.rating ?? 0;

  const homePrior = ctx.priors.get(homeKey);
  const awayPrior = ctx.priors.get(awayKey);

  const homeSP = blendValue(homePrior?.spPrior ?? 0, homeSPCurrent, week);
  const awaySP = blendValue(awayPrior?.spPrior ?? 0, awaySPCurrent, week);
  const homeSPOffEff = blendValue(homePrior?.spOffPrior ?? 0, homeSPOff, week);
  const awaySPOffEff = blendValue(awayPrior?.spOffPrior ?? 0, awaySPOff, week);
  const homeSPDefEff = blendValue(homePrior?.spDefPrior ?? 0, homeSPDef, week);
  const awaySPDefEff = blendValue(awayPrior?.spDefPrior ?? 0, awaySPDef, week);

  const sp_plus_diff = homeSP - awaySP;
  const sp_plus_off_diff = homeSPOffEff - awaySPOffEff;
  const sp_plus_def_diff = homeSPDefEff - awaySPDefEff;
  const sp_plus_st_diff = homeSPST - awaySPST;

  // ── FPI ───────────────────────────────────────────────────────────────────────
  const homeFPI = homePrior?.fpi ?? 0;
  const awayFPI = awayPrior?.fpi ?? 0;
  const fpi_diff = homeFPI - awayFPI;

  // ── Pythagorean ───────────────────────────────────────────────────────────────
  // Derived from SP+ as proxy when in-season data unavailable
  const homePythagorean = spToPythagorean(homeSP);
  const awayPythagorean = spToPythagorean(awaySP);
  const pythagorean_diff = homePythagorean - awayPythagorean;

  // ── EPA (Week 3+; prior-year SP used before) ─────────────────────────────────
  const homeEPA = ctx.epaMap.get(homeKey);
  const awayEPA = ctx.epaMap.get(awayKey);

  const safeEPA = (val: number | undefined, prior: number) =>
    week <= 2 ? prior : blendValue(prior, val, week);

  const homeQBEPA = homeEPA?.offense?.passingPlays?.ppa ?? undefined;
  const awayQBEPA = awayEPA?.offense?.passingPlays?.ppa ?? undefined;
  const qb_epa_diff = safeEPA(homeQBEPA, homeSPOffEff * 0.02) - safeEPA(awayQBEPA, awaySPOffEff * 0.02);

  const homePassEPA = homeEPA?.offense?.passingPlays?.ppa ?? undefined;
  const awayPassEPA = awayEPA?.offense?.passingPlays?.ppa ?? undefined;
  const pass_epa_diff = safeEPA(homePassEPA, homeSPOffEff * 0.02) - safeEPA(awayPassEPA, awaySPOffEff * 0.02);

  const homeRushEPA = homeEPA?.offense?.rushingPlays?.ppa ?? undefined;
  const awayRushEPA = awayEPA?.offense?.rushingPlays?.ppa ?? undefined;
  const rush_epa_diff = safeEPA(homeRushEPA, homeSPOffEff * 0.01) - safeEPA(awayRushEPA, awaySPOffEff * 0.01);

  const homeOffEPA = homeEPA?.offense?.ppa ?? undefined;
  const awayOffEPA = awayEPA?.offense?.ppa ?? undefined;
  const off_epa_diff = safeEPA(homeOffEPA, homeSPOffEff * 0.02) - safeEPA(awayOffEPA, awaySPOffEff * 0.02);

  const homeDefEPA = homeEPA?.defense?.ppa ?? undefined;
  const awayDefEPA = awayEPA?.defense?.ppa ?? undefined;
  // Defensive EPA: lower is better. Invert so positive = home better
  const def_epa_diff = safeEPA(-(awayDefEPA ?? 0), -awaySPDefEff * 0.02) - safeEPA(-(homeDefEPA ?? 0), -homeSPDefEff * 0.02);

  const qb_cpoe_diff = 0; // CFBD doesn't expose CPOE directly; use QB EPA as proxy

  const homeSuccessRate = homeEPA?.offense?.successRate ?? undefined;
  const awaySuccessRate = awayEPA?.offense?.successRate ?? undefined;
  const success_rate_diff = safeEPA(homeSuccessRate, 0.42 + homeSPOffEff * 0.003)
    - safeEPA(awaySuccessRate, 0.42 + awaySPOffEff * 0.003);

  const homeExplosive = homeEPA?.offense?.explosiveness ?? undefined;
  const awayExplosive = awayEPA?.offense?.explosiveness ?? undefined;
  const explosiveness_diff = safeEPA(homeExplosive, 1.2) - safeEPA(awayExplosive, 1.2);

  const homeHavoc = homeEPA?.defense?.havoc?.total ?? undefined;
  const awayHavoc = awayEPA?.defense?.havoc?.total ?? undefined;
  const havoc_rate_diff = safeEPA(homeHavoc, 0.16 + homeSPDefEff * 0.002) - safeEPA(awayHavoc, 0.16 + awaySPDefEff * 0.002);

  const homeFinish = homeEPA?.offense?.pointsPerOpportunity ?? undefined;
  const awayFinish = awayEPA?.offense?.pointsPerOpportunity ?? undefined;
  const finishing_drives_diff = safeEPA(homeFinish, 4.5 + homeSPOffEff * 0.05) - safeEPA(awayFinish, 4.5 + awaySPOffEff * 0.05);

  const homeLineYds = homeEPA?.offense?.lineYards ?? undefined;
  const awayLineYds = awayEPA?.offense?.lineYards ?? undefined;
  const line_yards_diff = safeEPA(homeLineYds, 2.8) - safeEPA(awayLineYds, 2.8);

  // ── Turnover margin ────────────────────────────────────────────────────────────
  // Not directly from EPA map; approximate from SP+ correlation
  const turnover_margin_diff = sp_plus_diff * 0.05;

  // ── Recruiting / portal / returning production ────────────────────────────────
  const homeRecruit = ctx.recruitingMap.get(homeKey) ?? homePrior?.recruitingComposite ?? 150;
  const awayRecruit = ctx.recruitingMap.get(awayKey) ?? awayPrior?.recruitingComposite ?? 150;
  const recruiting_composite_diff = homeRecruit - awayRecruit;

  const homePortal = ctx.portalMap.get(homeKey) ?? homePrior?.portalWAR ?? 0;
  const awayPortal = ctx.portalMap.get(awayKey) ?? awayPrior?.portalWAR ?? 0;
  const transfer_portal_impact_diff = homePortal - awayPortal;

  const homeReturn = ctx.returningProdMap.get(homeKey) ?? (homePrior?.returningProductionTotal ?? 0.55);
  const awayReturn = ctx.returningProdMap.get(awayKey) ?? (awayPrior?.returningProductionTotal ?? 0.55);
  const returning_production_diff = homeReturn - awayReturn;

  // ── Recent form (Week 6+) ─────────────────────────────────────────────────────
  const homeRecentEPA = week >= 6 ? (ctx.recentEPAMap.get(homeKey) ?? 0) : 0;
  const awayRecentEPA = week >= 6 ? (ctx.recentEPAMap.get(awayKey) ?? 0) : 0;
  const team_recent_epa_diff = homeRecentEPA - awayRecentEPA;

  // ── Rest / schedule ───────────────────────────────────────────────────────────
  const rest_days_diff = 0;   // populated externally from schedule
  const homeSOS = ctx.sosMap.get(homeKey) ?? 0;
  const awaySOS = ctx.sosMap.get(awayKey) ?? 0;
  const sos_diff = homeSOS - awaySOS;

  // ── Venue ─────────────────────────────────────────────────────────────────────
  const is_home = 1;  // always from home team's perspective
  const is_neutral_site = game.neutral_site ? 1 : 0;
  const isPower4Home = isPower4Conference(game.home_team, ctx.priors);
  const home_field_adj = getHomeFieldAdj(homeKey, isPower4Home, game.neutral_site);

  // ── Weather ───────────────────────────────────────────────────────────────────
  const weather = ctx.weatherData ?? { temperature: 65, windSpeed: 5, precipitation: 0, weatherCode: 0, isSnow: false, isRain: false };
  const isDome = isIndoorVenue(homeKey);
  const weatherAdj = computeWeatherAdj(weather, isDome);

  const temperature = weather.temperature;
  const wind_speed = weather.windSpeed;
  const precip_flag = (weather.isRain || weather.isSnow) ? 1 : 0;
  const wind_adj = weatherAdj.windAdj;
  const precip_adj = weatherAdj.precipAdj;
  const temp_adj = weatherAdj.tempAdj;

  // ── Game context ──────────────────────────────────────────────────────────────
  const is_rivalry = isRivalryGame(homeKey, awayKey) ? 1 : 0;
  const is_conference_game = game.conference_game ? 1 : 0;
  const is_bowl = game.season_type === 'postseason' ? 1 : 0;
  const is_cfp = 0; // set externally if CFP game

  // ── Pace ──────────────────────────────────────────────────────────────────────
  const homePace = homeEPA?.offense?.plays ?? 65;
  const awayPace = awayEPA?.offense?.plays ?? 65;
  const pace_diff = homePace - awayPace;

  // ── Coaching experience ────────────────────────────────────────────────────────
  const homeCoachExp = ctx.coachExpMap.get(homeKey) ?? 3;
  const awayCoachExp = ctx.coachExpMap.get(awayKey) ?? 3;
  const coach_experience_diff = homeCoachExp - awayCoachExp;

  // ── Injury ────────────────────────────────────────────────────────────────────
  const injury_qb_flag_home = ctx.qbOutHome ? 1 : 0;
  const injury_qb_flag_away = ctx.qbOutAway ? 1 : 0;

  // ── Vegas ─────────────────────────────────────────────────────────────────────
  const vegas_home_prob = ctx.vegasHomeProb ?? 0;
  const mc_win_pct = 0; // set after Monte Carlo

  const features: NCAAFFeatureVector = {
    elo_diff,
    sp_plus_diff,
    sp_plus_off_diff,
    sp_plus_def_diff,
    sp_plus_st_diff,
    fpi_diff,
    pythagorean_diff,
    qb_epa_diff,
    qb_cpoe_diff,
    pass_epa_diff,
    rush_epa_diff,
    off_epa_diff,
    def_epa_diff,
    success_rate_diff,
    explosiveness_diff,
    havoc_rate_diff,
    finishing_drives_diff,
    turnover_margin_diff,
    line_yards_diff,
    recruiting_composite_diff,
    transfer_portal_impact_diff,
    returning_production_diff,
    team_recent_epa_diff,
    rest_days_diff,
    sos_diff,
    is_home,
    is_neutral_site,
    home_field_adj,
    temperature,
    wind_speed,
    precip_flag,
    wind_adj,
    precip_adj,
    temp_adj,
    is_rivalry,
    is_conference_game,
    is_bowl,
    is_cfp,
    pace_diff,
    coach_experience_diff,
    injury_qb_flag_home,
    injury_qb_flag_away,
    vegas_home_prob,
    mc_win_pct,
  };

  logger.debug({ home: game.home_team, away: game.away_team, elo_diff, sp_plus_diff }, 'Features computed');
  return features;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function spToPythagorean(spRating: number): number {
  // Approximate: SP+ 0 ≈ .500, each 3 pts ≈ 10%
  return 0.5 + spRating * 0.033;
}

function isPower4Conference(school: string, priors: Map<string, PreseasonPrior>): boolean {
  const POWER4_CONFS = new Set(['sec', 'big ten', 'acc', 'big 12', 'pac-12', 'independent']);
  const key = normalizeTeamName(school);
  // We can't easily determine conference without loading team data; use Elo/SP+ tier as proxy
  // Conference info ideally comes from CFBTeam data
  return priors.has(key); // FBS teams in our prior list are mostly Power 4
}
