// NCAAF Oracle v4.1 — Season Lifecycle Manager
// Auto-activates Week 0/1 (late August), auto-stops after CFP Championship (mid-January).
// Three phases: Dormant → Preseason Setup → Active Season → Dormant

import { logger } from '../logger.js';
import type { SeasonWindow, WeekInfo } from '../types.js';

// ─── Season configuration ─────────────────────────────────────────────────────

const SEASON_YEAR = parseInt(process.env.SEASON_YEAR ?? String(new Date().getFullYear()));

// CFB season runs late August through mid-January
// 2025 season: Aug 23, 2025 → Jan 19, 2026 (CFP Championship)
export const SEASON_WINDOWS: SeasonWindow[] = [
  {
    season: 2026,
    seasonStart: '2026-08-29',
    seasonEnd: '2027-01-19',
    preseasonSetup: '2026-08-01',
    active: true,
  },
  {
    season: 2025,
    seasonStart: '2025-08-23',
    seasonEnd: '2026-01-20',
    preseasonSetup: '2025-08-01',
    active: false,
  },
  {
    season: 2024,
    seasonStart: '2024-08-24',
    seasonEnd: '2025-01-21',
    preseasonSetup: '2024-08-01',
    active: false,
  },
];

// ─── Is active season ────────────────────────────────────────────────────────

export function getCurrentSeasonWindow(date = new Date()): SeasonWindow | null {
  const dateStr = date.toISOString().slice(0, 10);
  for (const window of SEASON_WINDOWS) {
    if (dateStr >= window.seasonStart && dateStr <= window.seasonEnd) {
      return window;
    }
  }
  return null;
}

export function isActiveSeason(date = new Date()): boolean {
  return getCurrentSeasonWindow(date) !== null;
}

export function isPreseasonSetupNeeded(date = new Date()): boolean {
  const dateStr = date.toISOString().slice(0, 10);
  for (const window of SEASON_WINDOWS) {
    if (dateStr >= window.preseasonSetup && dateStr < window.seasonStart) {
      return true;
    }
  }
  return false;
}

// ─── Current week detection ───────────────────────────────────────────────────

// CFB regular season week schedule (approximate start dates)
// Week 0: late August (some games), Week 1: Labor Day weekend
// Week 15/16: Conference championships
// Bowl season: mid-December through early January
// CFP: late December through mid-January

const WEEK_SCHEDULE_2025: Array<{ week: number; start: string; end: string; label: string }> = [
  { week: 0,  start: '2025-08-23', end: '2025-08-25', label: 'Week 0' },
  { week: 1,  start: '2025-08-28', end: '2025-09-01', label: 'Week 1' },
  { week: 2,  start: '2025-09-04', end: '2025-09-08', label: 'Week 2' },
  { week: 3,  start: '2025-09-11', end: '2025-09-15', label: 'Week 3' },
  { week: 4,  start: '2025-09-18', end: '2025-09-22', label: 'Week 4' },
  { week: 5,  start: '2025-09-25', end: '2025-09-29', label: 'Week 5' },
  { week: 6,  start: '2025-10-02', end: '2025-10-06', label: 'Week 6' },
  { week: 7,  start: '2025-10-09', end: '2025-10-13', label: 'Week 7' },
  { week: 8,  start: '2025-10-16', end: '2025-10-20', label: 'Week 8' },
  { week: 9,  start: '2025-10-23', end: '2025-10-27', label: 'Week 9' },
  { week: 10, start: '2025-10-30', end: '2025-11-03', label: 'Week 10' },
  { week: 11, start: '2025-11-06', end: '2025-11-10', label: 'Week 11' },
  { week: 12, start: '2025-11-13', end: '2025-11-17', label: 'Week 12' },
  { week: 13, start: '2025-11-20', end: '2025-11-24', label: 'Week 13 (Rivalry Week)' },
  { week: 14, start: '2025-11-27', end: '2025-12-01', label: 'Week 14' },
  { week: 15, start: '2025-12-04', end: '2025-12-08', label: 'Conference Championships' },
  { week: 16, start: '2025-12-13', end: '2025-12-20', label: 'Bowl Season (Early)' },
  { week: 17, start: '2025-12-20', end: '2026-01-01', label: 'Bowl Season' },
  { week: 18, start: '2026-01-01', end: '2026-01-05', label: 'New Year\'s Six Bowls' },
  { week: 19, start: '2026-01-05', end: '2026-01-12', label: 'CFP Quarterfinals / Semifinals' },
  { week: 20, start: '2026-01-12', end: '2026-01-20', label: 'CFP National Championship' },
];

const WEEK_SCHEDULE_2026: Array<{ week: number; start: string; end: string; label: string }> = [
  { week: 0,  start: '2026-08-29', end: '2026-08-31', label: 'Week 0' },
  { week: 1,  start: '2026-09-03', end: '2026-09-07', label: 'Week 1' },
  { week: 2,  start: '2026-09-10', end: '2026-09-14', label: 'Week 2' },
  { week: 3,  start: '2026-09-17', end: '2026-09-21', label: 'Week 3' },
  { week: 4,  start: '2026-09-24', end: '2026-09-28', label: 'Week 4' },
  { week: 5,  start: '2026-10-01', end: '2026-10-05', label: 'Week 5' },
  { week: 6,  start: '2026-10-08', end: '2026-10-12', label: 'Week 6' },
  { week: 7,  start: '2026-10-15', end: '2026-10-19', label: 'Week 7' },
  { week: 8,  start: '2026-10-22', end: '2026-10-26', label: 'Week 8' },
  { week: 9,  start: '2026-10-29', end: '2026-11-02', label: 'Week 9' },
  { week: 10, start: '2026-11-05', end: '2026-11-09', label: 'Week 10' },
  { week: 11, start: '2026-11-12', end: '2026-11-16', label: 'Week 11' },
  { week: 12, start: '2026-11-19', end: '2026-11-23', label: 'Week 12' },
  { week: 13, start: '2026-11-26', end: '2026-11-30', label: 'Week 13 (Rivalry Week)' },
  { week: 14, start: '2026-12-03', end: '2026-12-07', label: 'Week 14' },
  { week: 15, start: '2026-12-05', end: '2026-12-06', label: 'Conference Championships' },
  { week: 16, start: '2026-12-12', end: '2026-12-19', label: 'Bowl Season (Early)' },
  { week: 17, start: '2026-12-19', end: '2026-12-31', label: 'Bowl Season' },
  { week: 18, start: '2027-01-01', end: '2027-01-04', label: 'New Year\'s Six Bowls' },
  { week: 19, start: '2027-01-04', end: '2027-01-11', label: 'CFP Quarterfinals / Semifinals' },
  { week: 20, start: '2027-01-11', end: '2027-01-19', label: 'CFP National Championship' },
];

export function getCurrentWeek(season: number, date = new Date()): WeekInfo | null {
  const dateStr = date.toISOString().slice(0, 10);
  const schedule = season === 2026 ? WEEK_SCHEDULE_2026 : WEEK_SCHEDULE_2025;

  // Find the upcoming week (games this week or next)
  // Tuesday cron: predict games happening this coming weekend
  let upcomingWeek = schedule.find(w => dateStr >= w.start && dateStr <= w.end);

  if (!upcomingWeek) {
    // Between weeks: find the next upcoming week
    upcomingWeek = schedule.find(w => w.start > dateStr);
    if (!upcomingWeek) return null;
  }

  const { week, label, start, end } = upcomingWeek;

  // Blending weights
  let priorWeight: number;
  let inSeasonWeight: number;
  let isPriorYearMode = false;
  let isBlendingMode = false;
  let earlySeasonLabel = '';

  if (week <= 1) {
    priorWeight = 0.85; inSeasonWeight = 0.15;
    isPriorYearMode = true; earlySeasonLabel = '🟡 EARLY SEASON — Prior-Year Baseline';
  } else if (week === 2) {
    priorWeight = 0.70; inSeasonWeight = 0.30;
    isPriorYearMode = true; earlySeasonLabel = '🟡 EARLY SEASON — Prior-Year Baseline';
  } else if (week <= 4) {
    priorWeight = week === 3 ? 0.55 : 0.40;
    inSeasonWeight = week === 3 ? 0.45 : 0.60;
    isBlendingMode = true; earlySeasonLabel = '🟠 Blending prior-year + current data';
  } else if (week <= 6) {
    priorWeight = week === 5 ? 0.30 : 0.20;
    inSeasonWeight = week === 5 ? 0.70 : 0.80;
  } else if (week <= 14) {
    priorWeight = 0.10; inSeasonWeight = 0.90;
  } else {
    priorWeight = 0.07; inSeasonWeight = 0.93;
  }

  return {
    season,
    week,
    weekLabel: label,
    startDate: start,
    endDate: end,
    isPriorYearMode,
    isBlendingMode,
    priorYearWeight: priorWeight,
    inSeasonWeight,
    earlySeasonLabel,
  };
}

// ─── Season phase label ───────────────────────────────────────────────────────

export type SeasonPhase =
  | 'dormant'
  | 'preseason_setup'
  | 'early_season'
  | 'blending'
  | 'mid_season'
  | 'bowl_season'
  | 'cfp';

export function getSeasonPhase(week: number): SeasonPhase {
  if (week <= 2) return 'early_season';
  if (week <= 6) return 'blending';
  if (week <= 14) return 'mid_season';
  if (week === 15) return 'mid_season'; // conference championships
  if (week <= 18) return 'bowl_season';
  return 'cfp';
}

// ─── Season gate ──────────────────────────────────────────────────────────────
// Returns false if we should exit immediately (off-season)

export function checkSeasonGate(date = new Date()): boolean {
  const active = isActiveSeason(date);
  if (!active) {
    logger.info('Outside active season window — exiting (no-op)');
  }
  return active;
}

// ─── Next week to recap ───────────────────────────────────────────────────────
// Monday recap cron: find the most recently completed week

export function getRecapWeek(season: number, date = new Date()): WeekInfo | null {
  const dateStr = date.toISOString().slice(0, 10);
  const schedule = season === 2026 ? WEEK_SCHEDULE_2026 : WEEK_SCHEDULE_2025;

  // Find the week that ended most recently before today
  let recapWeek = [...schedule].reverse().find(w => w.end < dateStr);
  if (!recapWeek) return null;

  return getCurrentWeek(season, new Date(recapWeek.start));
}

export { SEASON_YEAR };
