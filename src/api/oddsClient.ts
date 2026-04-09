// NCAAF Oracle v4.1 — The-Odds-API Client
// Free tier at https://the-odds-api.com — 500 requests/month
// Also pulls moneyline/spread from CFBD lines as primary source

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { logger } from '../logger.js';
import { normalizeTeamName } from './cfbdClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CACHE_DIR = process.env.CACHE_DIR ?? resolve(__dirname, '../../cache');
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_HOURS ?? 4)) * 60 * 60 * 1000;
const ODDS_API_KEY = process.env.ODDS_API_KEY ?? '';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

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
  writeFileSync(resolve(CACHE_DIR, key), JSON.stringify(data), 'utf-8');
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface OddsOutcome {
  name: string;
  price: number;    // American odds
  point?: number;   // spread/total value
}

interface OddsMarket {
  key: string;  // 'h2h' | 'spreads' | 'totals'
  outcomes: OddsOutcome[];
}

interface OddsBookmaker {
  key: string;
  title: string;
  markets: OddsMarket[];
}

interface OddsEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

export interface GameOdds {
  homeTeam: string;
  awayTeam: string;
  homeMoneyLine?: number;
  awayMoneyLine?: number;
  spread?: number;       // positive = home favored
  total?: number;
  vegasHomeProb?: number; // vig-removed implied probability
}

// ─── Moneyline → implied probability ──────────────────────────────────────────

function moneylineToProb(ml: number): number {
  if (ml > 0) return 100 / (ml + 100);
  return (-ml) / (-ml + 100);
}

export function vigRemovedProb(homeML: number, awayML: number): number {
  const rawHome = moneylineToProb(homeML);
  const rawAway = moneylineToProb(awayML);
  const total = rawHome + rawAway;
  return rawHome / total;  // normalized, vig removed
}

// ─── The-Odds-API fetch ────────────────────────────────────────────────────────

async function fetchOddsAPI(): Promise<OddsEvent[]> {
  if (!ODDS_API_KEY) {
    logger.warn('ODDS_API_KEY not set — skipping odds API');
    return [];
  }

  const url = `${ODDS_API_BASE}/sports/americanfootball_ncaaf/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
  const key = cacheKey(url);
  const cached = readCache<OddsEvent[]>(key);
  if (cached !== null) {
    logger.debug('Odds API cache hit');
    return cached;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Odds API request failed');
      return [];
    }
    const data = await res.json() as OddsEvent[];
    writeCache(key, data);
    return data;
  } catch (err) {
    logger.warn({ err }, 'Odds API fetch error');
    return [];
  }
}

// ─── Build odds map: "homeTeam-awayTeam" → GameOdds ──────────────────────────

export async function buildOddsMap(): Promise<Map<string, GameOdds>> {
  const events = await fetchOddsAPI();
  const map = new Map<string, GameOdds>();

  for (const event of events) {
    const homeKey = normalizeTeamName(event.home_team);
    const awayKey = normalizeTeamName(event.away_team);
    const gameKey = `${homeKey}-${awayKey}`;

    const odds: GameOdds = { homeTeam: homeKey, awayTeam: awayKey };

    // Use DraftKings or FanDuel as preferred bookmaker
    const preferredBooks = ['draftkings', 'fanduel', 'betmgm', 'bovada'];
    let book: OddsBookmaker | undefined;
    for (const pref of preferredBooks) {
      book = event.bookmakers.find(b => b.key === pref);
      if (book) break;
    }
    if (!book) book = event.bookmakers[0];
    if (!book) continue;

    for (const market of book.markets) {
      if (market.key === 'h2h') {
        const homeOut = market.outcomes.find(o => normalizeTeamName(o.name) === homeKey);
        const awayOut = market.outcomes.find(o => normalizeTeamName(o.name) === awayKey);
        if (homeOut && awayOut) {
          odds.homeMoneyLine = homeOut.price;
          odds.awayMoneyLine = awayOut.price;
          odds.vegasHomeProb = vigRemovedProb(homeOut.price, awayOut.price);
        }
      } else if (market.key === 'spreads') {
        const homeOut = market.outcomes.find(o => normalizeTeamName(o.name) === homeKey);
        if (homeOut?.point !== undefined) {
          odds.spread = -homeOut.point; // convention: positive = home favored
        }
      } else if (market.key === 'totals') {
        const overOut = market.outcomes.find(o => o.name === 'Over');
        if (overOut?.point !== undefined) {
          odds.total = overOut.point;
        }
      }
    }

    map.set(gameKey, odds);
  }

  logger.info({ count: map.size }, 'Built odds map');
  return map;
}

// ─── Parse CFBD line into GameOdds (fallback when Odds API unavailable) ───────

export function cfbdLineToOdds(line: {
  spread?: string;
  overUnder?: string;
  homeMoneyline?: number;
  awayMoneyline?: number;
}, homeTeam: string, awayTeam: string): GameOdds {
  const odds: GameOdds = {
    homeTeam: normalizeTeamName(homeTeam),
    awayTeam: normalizeTeamName(awayTeam),
  };

  if (line.spread) {
    const spread = parseFloat(line.spread);
    if (!isNaN(spread)) odds.spread = -spread; // CFBD: negative = home favored, we flip
  }
  if (line.overUnder) {
    const ou = parseFloat(line.overUnder);
    if (!isNaN(ou)) odds.total = ou;
  }
  if (line.homeMoneyline && line.awayMoneyline) {
    odds.homeMoneyLine = line.homeMoneyline;
    odds.awayMoneyLine = line.awayMoneyline;
    odds.vegasHomeProb = vigRemovedProb(line.homeMoneyline, line.awayMoneyline);
  } else if (odds.spread !== undefined) {
    // Estimate implied prob from spread: ~3 points ≈ 10% probability
    odds.vegasHomeProb = 0.5 + (odds.spread * 0.033);
    odds.vegasHomeProb = Math.max(0.1, Math.min(0.9, odds.vegasHomeProb));
  }

  return odds;
}
