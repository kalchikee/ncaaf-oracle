// Writes today's NCAAF predictions to predictions/YYYY-MM-DD.json.
// The kalshi-safety service fetches this file via GitHub raw URL to
// decide which picks to back on Kalshi.

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { Prediction } from '../types.js';

interface Pick {
  gameId: string;
  home: string;
  away: string;
  startTime?: string;
  pickedTeam: string;
  pickedSide: 'home' | 'away';
  modelProb: number;
  vegasProb?: number;
  edge?: number;
  confidenceTier?: string;
  extra?: Record<string, unknown>;
}

interface PredictionsFile {
  sport: 'NCAAF';
  date: string;
  generatedAt: string;
  picks: Pick[];
}

const MIN_PROB = parseFloat(process.env.KALSHI_MIN_PROB ?? '0.58');

export function writePredictionsFile(date: string, predictions: Prediction[]): string {
  const dir = resolve(process.cwd(), 'predictions');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${date}.json`);

  const picks: Pick[] = [];
  for (const p of predictions) {
    const homeProb = p.calibrated_prob;
    const awayProb = 1 - homeProb;
    const favored = homeProb >= awayProb;
    const modelProb = Math.max(homeProb, awayProb);
    if (modelProb < MIN_PROB) continue;
    picks.push({
      gameId: `ncaaf-${date}-${p.away_team}-${p.home_team}`,
      home: p.home_team,
      away: p.away_team,
      pickedTeam: favored ? p.home_team : p.away_team,
      pickedSide: favored ? 'home' : 'away',
      modelProb,
      vegasProb: p.vegas_prob,
      edge: p.edge,
      confidenceTier: p.confidence_tier,
      extra: {
        cfbdGameId: p.game_id,
        season: p.season,
        week: p.week,
        seasonType: p.season_type,
        venue: p.venue,
        gameDate: p.game_date,
        spread: p.spread,
        totalPoints: p.total_points,
      },
    });
  }

  const file: PredictionsFile = {
    sport: 'NCAAF',
    date,
    generatedAt: new Date().toISOString(),
    picks,
  };
  writeFileSync(path, JSON.stringify(file, null, 2));
  return path;
}
