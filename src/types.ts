// NCAAF Oracle v4.1 — Core Type Definitions

// ─── Season / week types ──────────────────────────────────────────────────────

export interface SeasonWindow {
  season: number;
  seasonStart: string;   // YYYY-MM-DD (late August)
  seasonEnd: string;     // YYYY-MM-DD (mid-January, after CFP Championship)
  preseasonSetup: string; // YYYY-MM-DD (early August)
  active: boolean;
}

export interface WeekInfo {
  season: number;
  week: number;           // 0 = Week Zero (late August), 1–15 regular, 16 = conference champs, 17+ = bowls/CFP
  weekLabel: string;      // e.g. "Week 1", "Bowl Season", "CFP Semifinal"
  startDate: string;      // YYYY-MM-DD
  endDate: string;
  isPriorYearMode: boolean;   // Weeks 0–2: use prior-year bootstrap
  isBlendingMode: boolean;    // Weeks 3–6: blending prior + current
  priorYearWeight: number;    // 0.0 – 1.0
  inSeasonWeight: number;     // 0.0 – 1.0
  earlySeasonLabel: string;   // Discord label for early season
}

// ─── Team types ───────────────────────────────────────────────────────────────

export interface CFBTeam {
  id: number;
  school: string;          // Official school name
  abbreviation: string;    // e.g. "ALA", "OHIO"
  mascot: string;
  conference: string;      // "SEC", "Big Ten", "ACC", "Big 12", "Pac-12", "American", "G5"
  division: string;        // "East", "West", etc.
  color: string;           // Primary hex color
  altColor: string;
  logos: string[];
  location: {
    lat: number;
    lon: number;
    city: string;
    state: string;
    stadium: string;
    capacity: number;
  };
  isPower4: boolean;
}

export interface CFBTeamStats {
  teamId: number;
  school: string;
  season: number;
  week: number;
  // SP+ ratings (the gold standard for CFB)
  spOverall: number;
  spOffense: number;
  spDefense: number;
  spSpecialTeams: number;
  // EPA-based efficiency (Week 3+ only)
  offEPA: number;           // offensive EPA per play
  defEPA: number;           // defensive EPA per play (negative = good)
  qbEPA: number;            // QB EPA per play
  qbCPOE: number;           // QB completion % over expected
  passEPA: number;
  rushEPA: number;
  successRate: number;      // offensive success rate
  explosiveness: number;    // explosive play rate
  havocRate: number;        // defensive havoc rate
  finishingDrives: number;  // pts per scoring opportunity
  // Record-based
  wins: number;
  losses: number;
  winPct: number;
  pythagoreanWinPct: number;
  pointsPerGame: number;
  pointsAllowedPerGame: number;
  turnoverMargin: number;
  // Line metrics
  lineYards: number;
  // Pace
  playsPerGame: number;
  // Recent form (last 5 games)
  recentEPA: number;        // EPA/play last 5 games
}

export interface PreseasonPrior {
  school: string;
  season: number;
  // Prior-year SP+ (45% regressed toward mean)
  spPrior: number;
  spOffPrior: number;
  spDefPrior: number;
  // Recruiting
  recruitingComposite: number;  // 247Sports talent composite
  // Roster continuity
  returningProductionOff: number;  // 0–100%
  returningProductionDef: number;
  returningProductionTotal: number;
  // Transfer portal
  portalWAR: number;            // net wins added via portal
  portalQBChange: boolean;      // true if starting QB came via portal
  // Coaching
  newHeadCoach: boolean;
  newOC: boolean;
  newDC: boolean;
  coachingPenalty: number;      // SP+ point penalty for instability
  // Preseason Elo
  preseasonElo: number;
  // FPI
  fpi: number;
}

// ─── Game types ───────────────────────────────────────────────────────────────

export interface CFBGame {
  gameId: number;
  season: number;
  week: number;
  seasonType: 'regular' | 'postseason';
  gameDate: string;      // YYYY-MM-DD
  gameTime: string;      // ISO datetime UTC
  status: 'scheduled' | 'in_progress' | 'final';
  homeTeam: string;
  homeTeamId: number;
  awayTeam: string;
  awayTeamId: number;
  homeScore?: number;
  awayScore?: number;
  neutralSite: boolean;
  conferenceGame: boolean;
  venueName: string;
  venueCity: string;
  venueState: string;
  attendance?: number;
  // Vegas lines (if available)
  vegasSpread?: number;      // positive = home favored
  vegasTotal?: number;
  homeMoneyLine?: number;
  awayMoneyLine?: number;
  overUnderOpen?: number;
  spreadOpen?: number;
}

export interface GameResult {
  gameId: number;
  season: number;
  week: number;
  gameDate: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  winner: string;
  margin: number;
}

// ─── Feature vector ───────────────────────────────────────────────────────────

export interface NCAAFFeatureVector {
  // Team strength (available from Week 0 via prior)
  elo_diff: number;
  sp_plus_diff: number;          // SP+ overall
  sp_plus_off_diff: number;
  sp_plus_def_diff: number;
  sp_plus_st_diff: number;
  fpi_diff: number;
  pythagorean_diff: number;

  // EPA-based efficiency (Week 3+; prior used before)
  qb_epa_diff: number;
  qb_cpoe_diff: number;
  pass_epa_diff: number;
  rush_epa_diff: number;
  off_epa_diff: number;
  def_epa_diff: number;
  success_rate_diff: number;
  explosiveness_diff: number;
  havoc_rate_diff: number;
  finishing_drives_diff: number;
  turnover_margin_diff: number;
  line_yards_diff: number;

  // Recruiting / roster (always available)
  recruiting_composite_diff: number;
  transfer_portal_impact_diff: number;
  returning_production_diff: number;

  // Recent form (Week 6+)
  team_recent_epa_diff: number;

  // Schedule / rest
  rest_days_diff: number;
  sos_diff: number;

  // Venue
  is_home: number;
  is_neutral_site: number;
  home_field_adj: number;      // HFA in points (varies by venue)

  // Weather
  temperature: number;
  wind_speed: number;
  precip_flag: number;
  wind_adj: number;
  precip_adj: number;
  temp_adj: number;

  // Game context
  is_rivalry: number;
  is_conference_game: number;
  is_bowl: number;
  is_cfp: number;

  // Pace
  pace_diff: number;

  // Coaching
  coach_experience_diff: number;

  // Injuries
  injury_qb_flag_home: number;
  injury_qb_flag_away: number;

  // Vegas / model
  vegas_home_prob: number;
  mc_win_pct: number;
}

// ─── Model outputs ────────────────────────────────────────────────────────────

export interface MonteCarloResult {
  win_probability: number;
  away_win_probability: number;
  spread: number;               // home expected spread (positive = home favored)
  total_points: number;
  most_likely_score: [number, number];  // [home, away]
  upset_probability: number;
  blowout_probability: number;  // margin >= 21
  home_exp_pts: number;
  away_exp_pts: number;
  simulations: number;
}

export interface Prediction {
  game_id: number;
  game_date: string;
  season: number;
  week: number;
  season_type: string;
  home_team: string;
  away_team: string;
  venue: string;
  is_prior_year_mode: boolean;
  prior_year_weight: number;
  feature_vector: NCAAFFeatureVector;
  mc_win_pct: number;
  calibrated_prob: number;
  confidence_tier: ConfidenceTier;
  vegas_prob?: number;
  edge?: number;
  edge_category: EdgeCategory;
  model_version: string;
  home_exp_pts: number;
  away_exp_pts: number;
  total_points: number;
  spread: number;
  most_likely_score: string;
  upset_probability: number;
  blowout_probability: number;
  actual_winner?: string;
  home_score?: number;
  away_score?: number;
  correct?: boolean;
  brier_score?: number;
  created_at: string;
}

// ─── Confidence tiers ─────────────────────────────────────────────────────────

export type ConfidenceTier = 'coin_flip' | 'lean' | 'strong' | 'high_conviction' | 'extreme_conviction';

export interface ConfidenceResult {
  tier: ConfidenceTier;
  label: string;
  emoji: string;
  probability: number;
  historicalAccuracy: string;
  showInEmbed: boolean;
}

// ─── Edge detection ───────────────────────────────────────────────────────────

export type EdgeCategory = 'none' | 'small' | 'meaningful' | 'large' | 'extreme';

export interface EdgeResult {
  modelProb: number;
  vegasProb: number;
  edge: number;
  edgeCategory: EdgeCategory;
  edgeEmoji: string;
  homeFavorite: boolean;
}

// ─── Elo system ───────────────────────────────────────────────────────────────

export interface EloRating {
  school: string;
  rating: number;
  updatedAt: string;
}

// ─── Accuracy tracking ────────────────────────────────────────────────────────

export interface SeasonAccuracy {
  season: number;
  totalPicks: number;
  correctPicks: number;
  accuracy: number;
  highConvPicks: number;
  highConvCorrect: number;
  highConvAccuracy: number;
  extremeConvPicks: number;
  extremeConvCorrect: number;
  extremeConvAccuracy: number;
  atsWins: number;
  atsLosses: number;
  atsAccuracy: number;
  edgePickWins: number;
  edgePickLosses: number;
  edgePickAccuracy: number;
  brierScore: number;
  logLoss: number;
  weeklyRecord: WeeklyRecord[];
  bestWeek: number;
  worstWeek: number;
}

export interface WeeklyRecord {
  week: number;
  wins: number;
  losses: number;
  accuracy: number;
  brierScore: number;
}

// ─── Pipeline options ─────────────────────────────────────────────────────────

export interface PipelineOptions {
  week?: number;
  season?: number;
  forceRefresh?: boolean;
  verbose?: boolean;
  alertType?: 'picks' | 'recap' | 'preseason';
}

// ─── Preseason Elo components ─────────────────────────────────────────────────

export interface PreseasonEloInput {
  school: string;
  priorYearFinalElo: number;
  recruitingCompositeElo: number;  // talent composite normalized to Elo scale
  leagueMeanElo: number;
}

// ─── Weather data ─────────────────────────────────────────────────────────────

export interface WeatherData {
  temperature: number;    // Fahrenheit
  windSpeed: number;      // mph
  precipitation: number;  // mm
  weatherCode: number;
  isSnow: boolean;
  isRain: boolean;
}

// ─── CFBD API raw types ───────────────────────────────────────────────────────

export interface CFBDGame {
  id: number;
  season: number;
  week: number;
  season_type: string;
  start_date: string;
  neutral_site: boolean;
  conference_game: boolean;
  home_team: string;
  home_id: number;
  away_team: string;
  away_id: number;
  home_points?: number;
  away_points?: number;
  venue?: string;
  venue_id?: number;
}

export interface CFBDTeamSPRating {
  year: number;
  team: string;
  conference: string;
  rating: number;
  ranking?: number;
  secondOrderWins?: number;
  sos?: number;
  offense: {
    ranking?: number;
    rating: number;
    success: number;
    explosiveness: number;
    rushingSuccess: number;
    passingSuccess: number;
    standardDowns: number;
    passingDowns: number;
    runRate: number;
    pace: number;
  };
  defense: {
    ranking?: number;
    rating: number;
    success: number;
    explosiveness: number;
    rushingSuccess: number;
    passingSuccess: number;
    standardDowns: number;
    passingDowns: number;
    havoc: {
      total: number;
      frontSeven: number;
      db: number;
    };
  };
  specialTeams: {
    rating: number;
  };
}

export interface CFBDTeamEPA {
  season: number;
  team: string;
  conference: string;
  offense: {
    plays: number;
    drives: number;
    ppa: number;       // points per play (EPA per play)
    totalPPA: number;
    successRate: number;
    explosiveness: number;
    powerSuccess: number;
    stuffRate: number;
    lineYards: number;
    lineYardsTotal: number;
    secondLevelYards: number;
    openFieldYards: number;
    pointsPerOpportunity: number;
    fieldPosition: { averageStart: number; averagePredictedPoints: number };
    havoc: { total: number; db: number; frontSeven: number };
    rushingPlays: { plays: number; ppa: number; totalPPA: number; successRate: number; explosiveness: number };
    passingPlays: { plays: number; ppa: number; totalPPA: number; successRate: number; explosiveness: number };
  };
  defense: {
    plays: number;
    drives: number;
    ppa: number;
    totalPPA: number;
    successRate: number;
    explosiveness: number;
    havoc: { total: number; db: number; frontSeven: number };
    rushingPlays: { plays: number; ppa: number; totalPPA: number; successRate: number; explosiveness: number };
    passingPlays: { plays: number; ppa: number; totalPPA: number; successRate: number; explosiveness: number };
  };
}

export interface CFBDRecruitingRating {
  team: string;
  year: number;
  rank: number;
  points: number;
}

export interface CFBDReturningProduction {
  season: number;
  team: string;
  conference?: string;
  totalPPA: number;
  totalPercent: number;
  percentPPA: number;
  usage: number;
  offense: { total: number; quarter: number; passing: number; standard: number; rushing: number };
  defense: { total: number; frontSeven: number; db: number };
}
