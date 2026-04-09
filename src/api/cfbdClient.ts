// NCAAF Oracle v4.1 — collegefootballdata.com API Client
// Free with API key from https://collegefootballdata.com/key
// Covers: schedule, scores, SP+, EPA, recruiting, returning production, rosters

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { logger } from '../logger.js';
import type {
  CFBDGame, CFBDTeamSPRating, CFBDTeamEPA,
  CFBDRecruitingRating, CFBDReturningProduction, GameResult
} from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CACHE_DIR = process.env.CACHE_DIR ?? resolve(__dirname, '../../cache');
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_HOURS ?? 4)) * 60 * 60 * 1000;
const CFBD_BASE = 'https://api.collegefootballdata.com';
const CFBD_API_KEY = process.env.CFBD_API_KEY ?? '';

mkdirSync(CACHE_DIR, { recursive: true });

// ─── Cache helpers ─────────────────────────────────────────────────────────────

function cacheKey(url: string): string {
  return url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 200) + '.json';
}

function readCache<T>(key: string): T | null {
  const path = resolve(CACHE_DIR, key);
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeCache(key: string, data: unknown): void {
  const path = resolve(CACHE_DIR, key);
  writeFileSync(path, JSON.stringify(data), 'utf-8');
}

// ─── HTTP fetch with retry ─────────────────────────────────────────────────────

async function cfbdFetch<T>(endpoint: string, params: Record<string, string | number> = {}): Promise<T> {
  if (!CFBD_API_KEY) {
    throw new Error('CFBD_API_KEY is not set. Get a free key at https://collegefootballdata.com/key');
  }

  const url = new URL(`${CFBD_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const urlStr = url.toString();

  const cached = readCache<T>(cacheKey(urlStr));
  if (cached !== null) {
    logger.debug({ url: urlStr }, 'CFBD cache hit');
    return cached;
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    try {
      logger.debug({ url: urlStr, attempt }, 'CFBD fetch');
      const res = await fetch(urlStr, {
        headers: {
          'Authorization': `Bearer ${CFBD_API_KEY}`,
          'Accept': 'application/json',
        },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`CFBD ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json() as T;
      writeCache(cacheKey(urlStr), data);
      return data;
    } catch (err) {
      lastError = err as Error;
      logger.warn({ url: urlStr, attempt, err: lastError.message }, 'CFBD fetch error, retrying');
    }
  }
  throw lastError!;
}

// ─── Schedule / games ──────────────────────────────────────────────────────────

export async function fetchGames(season: number, week?: number, seasonType = 'regular'): Promise<CFBDGame[]> {
  const params: Record<string, string | number> = { year: season, division: 'fbs', seasonType };
  if (week !== undefined) params.week = week;
  return cfbdFetch<CFBDGame[]>('/games', params);
}

export async function fetchUpcomingGames(season: number, week: number): Promise<CFBDGame[]> {
  const games = await fetchGames(season, week, 'regular');
  const postseason = await fetchGames(season, week, 'postseason').catch(() => [] as CFBDGame[]);
  return [...games, ...postseason].filter(g => !g.home_points && !g.away_points);
}

export async function fetchCompletedGames(season: number, week: number): Promise<CFBDGame[]> {
  const regular = await fetchGames(season, week, 'regular');
  const postseason = await fetchGames(season, week, 'postseason').catch(() => [] as CFBDGame[]);
  return [...regular, ...postseason].filter(g => g.home_points !== undefined && g.away_points !== undefined);
}

export function toGameResult(g: CFBDGame): GameResult | null {
  if (g.home_points === undefined || g.away_points === undefined) return null;
  const winner = g.home_points > g.away_points ? g.home_team : g.away_team;
  return {
    gameId: g.id,
    season: g.season,
    week: g.week,
    gameDate: g.start_date.slice(0, 10),
    homeTeam: g.home_team,
    awayTeam: g.away_team,
    homeScore: g.home_points,
    awayScore: g.away_points,
    winner,
    margin: Math.abs(g.home_points - g.away_points),
  };
}

// ─── SP+ ratings ───────────────────────────────────────────────────────────────

export async function fetchSPRatings(season: number, team?: string): Promise<CFBDTeamSPRating[]> {
  const params: Record<string, string | number> = { year: season };
  if (team) params.team = team;
  return cfbdFetch<CFBDTeamSPRating[]>('/ratings/sp', params);
}

// SP+ rating lookup map: { school -> rating }
export async function buildSPMap(season: number): Promise<Map<string, CFBDTeamSPRating>> {
  const ratings = await fetchSPRatings(season);
  const map = new Map<string, CFBDTeamSPRating>();
  for (const r of ratings) map.set(normalizeTeamName(r.team), r);
  return map;
}

// ─── EPA / efficiency stats ───────────────────────────────────────────────────

export async function fetchTeamEPA(season: number, week?: number): Promise<CFBDTeamEPA[]> {
  const params: Record<string, string | number> = { year: season, excludeGarbageTime: 'true' };
  if (week !== undefined) params.week = week;
  return cfbdFetch<CFBDTeamEPA[]>('/ppa/teams', params);
}

export async function buildEPAMap(season: number, week?: number): Promise<Map<string, CFBDTeamEPA>> {
  const epas = await fetchTeamEPA(season, week);
  const map = new Map<string, CFBDTeamEPA>();
  for (const e of epas) map.set(normalizeTeamName(e.team), e);
  return map;
}

// ─── Recruiting ───────────────────────────────────────────────────────────────

export async function fetchRecruitingRatings(season: number): Promise<CFBDRecruitingRating[]> {
  return cfbdFetch<CFBDRecruitingRating[]>('/recruiting/teams', { year: season });
}

export async function buildRecruitingMap(season: number): Promise<Map<string, CFBDRecruitingRating>> {
  const ratings = await fetchRecruitingRatings(season);
  const map = new Map<string, CFBDRecruitingRating>();
  for (const r of ratings) map.set(normalizeTeamName(r.team), r);
  return map;
}

// ─── Returning production ─────────────────────────────────────────────────────

export async function fetchReturningProduction(season: number): Promise<CFBDReturningProduction[]> {
  return cfbdFetch<CFBDReturningProduction[]>('/player/returning', { year: season });
}

export async function buildReturningProdMap(season: number): Promise<Map<string, CFBDReturningProduction>> {
  const data = await fetchReturningProduction(season);
  const map = new Map<string, CFBDReturningProduction>();
  for (const r of data) map.set(normalizeTeamName(r.team), r);
  return map;
}

// ─── FBS teams ────────────────────────────────────────────────────────────────

interface CFBDTeamRaw {
  id: number;
  school: string;
  mascot: string;
  abbreviation: string;
  alt_name1?: string;
  conference: string;
  division?: string;
  color?: string;
  alt_color?: string;
  logos?: string[];
  location?: {
    latitude?: number;
    longitude?: number;
    city?: string;
    state?: string;
    name?: string;
    capacity?: number;
  };
}

export async function fetchFBSTeams(): Promise<CFBDTeamRaw[]> {
  return cfbdFetch<CFBDTeamRaw[]>('/teams/fbs');
}

// ─── AP Top 25 rankings ───────────────────────────────────────────────────────

interface CFBDRankingPoll {
  poll: string;
  ranks: Array<{ rank: number; school: string; firstPlaceVotes: number; points: number }>;
}

interface CFBDRankingWeek {
  season: number;
  seasonType: string;
  week: number;
  polls: CFBDRankingPoll[];
}

/**
 * Fetch AP Top 25 for a given season + week.
 * Returns a Set of normalized school names ranked 1–25.
 */
export async function fetchTop25(season: number, week: number): Promise<Set<string>> {
  try {
    const data = await cfbdFetch<CFBDRankingWeek[]>('/rankings', { year: season, week, seasonType: 'regular' });
    const set = new Set<string>();
    for (const entry of data) {
      const ap = entry.polls.find(p => p.poll === 'AP Top 25');
      if (ap) {
        for (const r of ap.ranks) {
          set.add(normalizeTeamName(r.school));
        }
      }
    }
    if (set.size === 0) {
      // Try postseason rankings (bowl season)
      const postData = await cfbdFetch<CFBDRankingWeek[]>('/rankings', { year: season, week, seasonType: 'postseason' });
      for (const entry of postData) {
        const ap = entry.polls.find(p => p.poll === 'AP Top 25');
        if (ap) for (const r of ap.ranks) set.add(normalizeTeamName(r.school));
      }
    }
    logger.info({ count: set.size, week, season }, 'Fetched AP Top 25');
    return set;
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch Top 25 rankings');
    return new Set();
  }
}

/**
 * Filter games to only those where at least one team is in the AP Top 25.
 */
export function filterTop25Games(games: CFBDGame[], top25: Set<string>): CFBDGame[] {
  if (top25.size === 0) {
    logger.warn('Top 25 set is empty — returning all games as fallback');
    return games;
  }
  return games.filter(g =>
    top25.has(normalizeTeamName(g.home_team)) ||
    top25.has(normalizeTeamName(g.away_team))
  );
}

// ─── Lines / odds from CFBD ───────────────────────────────────────────────────

interface CFBDLine {
  id: number;
  season: number;
  week: number;
  season_type: string;
  home_team: string;
  away_team: string;
  start_date: string;
  provider: string;
  spread?: string;        // e.g. "-7.5"
  formattedSpread?: string;
  overUnder?: string;
  homeMoneyline?: number;
  awayMoneyline?: number;
}

export async function fetchLines(season: number, week: number, seasonType = 'regular'): Promise<CFBDLine[]> {
  return cfbdFetch<CFBDLine[]>('/lines', { year: season, week, seasonType });
}

// Build a map of game lines by "homeTeam-awayTeam"
export async function buildLinesMap(season: number, week: number): Promise<Map<string, CFBDLine>> {
  const lines = await fetchLines(season, week).catch(() => [] as CFBDLine[]);
  const postLines = await fetchLines(season, week, 'postseason').catch(() => [] as CFBDLine[]);
  const all = [...lines, ...postLines];
  const map = new Map<string, CFBDLine>();
  // Prefer consensus or DraftKings
  const priority = ['consensus', 'DraftKings', 'Bovada', 'ESPN Bet'];
  for (const provider of priority) {
    for (const l of all.filter(x => x.provider.toLowerCase() === provider.toLowerCase())) {
      const key = `${normalizeTeamName(l.home_team)}-${normalizeTeamName(l.away_team)}`;
      if (!map.has(key)) map.set(key, l);
    }
  }
  // Fill remaining
  for (const l of all) {
    const key = `${normalizeTeamName(l.home_team)}-${normalizeTeamName(l.away_team)}`;
    if (!map.has(key)) map.set(key, l);
  }
  return map;
}

// ─── Strength of schedule ─────────────────────────────────────────────────────

interface CFBDSPStat {
  year: number;
  team: string;
  rating?: number;
  secondOrderWins?: number;
  sos?: number;
}

export async function fetchSOS(season: number): Promise<Map<string, number>> {
  const data = await cfbdFetch<CFBDSPStat[]>('/ratings/sp', { year: season }).catch(() => [] as CFBDSPStat[]);
  const map = new Map<string, number>();
  for (const d of data) {
    if (d.sos !== undefined) map.set(normalizeTeamName(d.team), d.sos);
  }
  return map;
}

// ─── Team name normalization ───────────────────────────────────────────────────
// CFBD uses full school names. We normalize for consistent map lookups.

const TEAM_NAME_OVERRIDES: Record<string, string> = {
  'miami (fl)': 'miami',
  'miami (oh)': 'miami (oh)',
  'usc': 'usc',
  'ole miss': 'ole miss',
  'lsu': 'lsu',
  'tcu': 'tcu',
  'smu': 'smu',
  'utsa': 'utsa',
  'utep': 'utep',
  'uab': 'uab',
  'fiu': 'fiu',
  'fau': 'florida atlantic',
  'unlv': 'unlv',
  'umass': 'massachusetts',
  'uconn': 'connecticut',
  'byu': 'byu',
  'ucf': 'ucf',
};

export function normalizeTeamName(name: string): string {
  const lower = name.toLowerCase().trim();
  return TEAM_NAME_OVERRIDES[lower] ?? lower;
}

// ─── FBS team venue coordinates for weather lookup ────────────────────────────

export const TEAM_VENUE_COORDS: Record<string, { lat: number; lon: number }> = {
  'alabama': { lat: 33.21, lon: -87.55 },
  'auburn': { lat: 32.60, lon: -85.49 },
  'lsu': { lat: 30.41, lon: -91.18 },
  'georgia': { lat: 33.95, lon: -83.37 },
  'florida': { lat: 29.65, lon: -82.35 },
  'tennessee': { lat: 35.95, lon: -83.93 },
  'arkansas': { lat: 36.07, lon: -94.18 },
  'mississippi state': { lat: 33.46, lon: -88.79 },
  'ole miss': { lat: 34.36, lon: -89.53 },
  'south carolina': { lat: 33.99, lon: -81.02 },
  'vanderbilt': { lat: 36.14, lon: -86.81 },
  'texas a&m': { lat: 30.62, lon: -96.34 },
  'kentucky': { lat: 38.02, lon: -84.50 },
  'missouri': { lat: 38.94, lon: -92.33 },
  'ohio state': { lat: 40.00, lon: -83.02 },
  'michigan': { lat: 42.27, lon: -83.75 },
  'penn state': { lat: 40.81, lon: -77.86 },
  'wisconsin': { lat: 43.07, lon: -89.41 },
  'iowa': { lat: 41.66, lon: -91.55 },
  'michigan state': { lat: 42.73, lon: -84.48 },
  'minnesota': { lat: 44.97, lon: -93.23 },
  'indiana': { lat: 39.18, lon: -86.52 },
  'purdue': { lat: 40.45, lon: -86.92 },
  'illinois': { lat: 40.10, lon: -88.23 },
  'northwestern': { lat: 42.06, lon: -87.67 },
  'rutgers': { lat: 40.52, lon: -74.44 },
  'maryland': { lat: 38.99, lon: -76.94 },
  'nebraska': { lat: 40.82, lon: -96.71 },
  'notre dame': { lat: 41.70, lon: -86.23 },
  'clemson': { lat: 34.68, lon: -82.84 },
  'florida state': { lat: 30.44, lon: -84.30 },
  'miami': { lat: 25.95, lon: -80.24 },
  'nc state': { lat: 35.77, lon: -78.68 },
  'north carolina': { lat: 35.90, lon: -79.04 },
  'duke': { lat: 36.00, lon: -78.94 },
  'virginia': { lat: 38.03, lon: -78.51 },
  'virginia tech': { lat: 37.21, lon: -80.42 },
  'georgia tech': { lat: 33.77, lon: -84.39 },
  'louisville': { lat: 38.25, lon: -85.76 },
  'pittsburgh': { lat: 40.44, lon: -79.96 },
  'boston college': { lat: 42.34, lon: -71.17 },
  'wake forest': { lat: 36.13, lon: -80.28 },
  'syracuse': { lat: 43.04, lon: -76.13 },
  'oklahoma': { lat: 35.21, lon: -97.44 },
  'texas': { lat: 30.28, lon: -97.73 },
  'oklahoma state': { lat: 36.13, lon: -97.07 },
  'baylor': { lat: 31.56, lon: -97.12 },
  'tcu': { lat: 32.71, lon: -97.38 },
  'kansas state': { lat: 39.19, lon: -96.60 },
  'kansas': { lat: 38.97, lon: -95.25 },
  'iowa state': { lat: 42.02, lon: -93.64 },
  'texas tech': { lat: 33.59, lon: -101.87 },
  'west virginia': { lat: 39.65, lon: -79.96 },
  'colorado': { lat: 40.01, lon: -105.27 },
  'utah': { lat: 40.76, lon: -111.85 },
  'usc': { lat: 34.02, lon: -118.29 },
  'ucla': { lat: 34.16, lon: -118.17 },
  'oregon': { lat: 44.06, lon: -123.07 },
  'washington': { lat: 47.65, lon: -122.30 },
  'stanford': { lat: 37.43, lon: -122.16 },
  'arizona state': { lat: 33.43, lon: -111.93 },
  'arizona': { lat: 32.23, lon: -110.95 },
  'oregon state': { lat: 44.56, lon: -123.28 },
  'washington state': { lat: 46.73, lon: -117.16 },
  'california': { lat: 37.87, lon: -122.31 },
  'byu': { lat: 40.25, lon: -111.65 },
  'ucf': { lat: 28.60, lon: -81.19 },
  'cincinnati': { lat: 39.13, lon: -84.52 },
  'houston': { lat: 29.72, lon: -95.41 },
  'tulane': { lat: 29.94, lon: -90.12 },
  'smu': { lat: 32.84, lon: -96.78 },
  'memphis': { lat: 35.12, lon: -89.97 },
  'navy': { lat: 38.99, lon: -76.48 },
  'army': { lat: 41.39, lon: -73.96 },
  'air force': { lat: 38.99, lon: -104.87 },
};

export function getVenueCoords(homeTeam: string): { lat: number; lon: number } | null {
  const key = normalizeTeamName(homeTeam);
  return TEAM_VENUE_COORDS[key] ?? null;
}

// Home field advantage in points by venue type
export const POWER4_LARGE_STADIUMS = new Set([
  'alabama', 'ohio state', 'michigan', 'penn state', 'lsu', 'florida', 'tennessee',
  'georgia', 'clemson', 'notre dame', 'texas a&m', 'auburn', 'oklahoma', 'texas',
  'nebraska', 'wisconsin', 'iowa', 'usc', 'washington', 'oregon',
]);

export function getHomeFieldAdj(homeTeam: string, isPower4: boolean, neutralSite: boolean): number {
  if (neutralSite) return 0.5;
  const key = normalizeTeamName(homeTeam);
  if (POWER4_LARGE_STADIUMS.has(key)) return 4.5;
  if (isPower4) return 3.5;
  return 2.8; // Group of 5
}

// Known rivalry games (reduce HFA by 1 point)
export const RIVALRY_GAMES = new Set([
  'alabama-auburn', 'auburn-alabama', 'ohio state-michigan', 'michigan-ohio state',
  'oklahoma-oklahoma state', 'oklahoma state-oklahoma', 'florida-florida state',
  'florida state-florida', 'usc-ucla', 'ucla-usc', 'notre dame-usc', 'usc-notre dame',
  'texas-texas a&m', 'texas a&m-texas', 'georgia-georgia tech', 'georgia tech-georgia',
  'clemson-south carolina', 'south carolina-clemson', 'kansas-kansas state',
  'kansas state-kansas', 'iowa-iowa state', 'iowa state-iowa',
]);

export function isRivalryGame(homeTeam: string, awayTeam: string): boolean {
  const key = `${normalizeTeamName(homeTeam)}-${normalizeTeamName(awayTeam)}`;
  return RIVALRY_GAMES.has(key);
}

// Power 4 conferences
const POWER4_CONFS = new Set(['SEC', 'Big Ten', 'ACC', 'Big 12', 'Pac-12', 'SEC', 'Pac-12']);
export function isPower4(conference: string): boolean {
  return POWER4_CONFS.has(conference) || conference === 'Independent'; // Notre Dame
}
