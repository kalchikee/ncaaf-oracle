// NCAAF Oracle v4.1 — Market Edge Detection
// edge = model_probability - vegas_implied_probability
// Categorizes divergences and flags high-value opportunities.

import type { EdgeCategory, EdgeResult, ConfidenceTier, ConfidenceResult } from '../types.js';

// ─── Edge detection ───────────────────────────────────────────────────────────

export function detectEdge(modelProb: number, vegasProb: number | undefined): EdgeResult {
  if (!vegasProb || vegasProb === 0) {
    return {
      modelProb,
      vegasProb: 0,
      edge: 0,
      edgeCategory: 'none',
      edgeEmoji: '',
      homeFavorite: modelProb > 0.5,
    };
  }

  const edge = modelProb - vegasProb;
  const absEdge = Math.abs(edge);

  let edgeCategory: EdgeCategory;
  let edgeEmoji: string;

  if (absEdge < 0.03) {
    edgeCategory = 'none';
    edgeEmoji = '';
  } else if (absEdge < 0.06) {
    edgeCategory = 'small';
    edgeEmoji = '';
  } else if (absEdge < 0.10) {
    edgeCategory = 'meaningful';
    edgeEmoji = '💡';
  } else if (absEdge < 0.15) {
    edgeCategory = 'large';
    edgeEmoji = '🚀';
  } else {
    edgeCategory = 'extreme';
    edgeEmoji = '🚀🚀';
  }

  return {
    modelProb,
    vegasProb,
    edge,
    edgeCategory,
    edgeEmoji,
    homeFavorite: modelProb > 0.5,
  };
}

// ─── Confidence tier classification ───────────────────────────────────────────

export function classifyConfidence(calibratedProb: number): ConfidenceResult {
  const prob = Math.max(calibratedProb, 1 - calibratedProb); // use the winning side's probability

  if (prob >= 0.72) {
    return {
      tier: 'extreme_conviction',
      label: 'Extreme Conviction',
      emoji: '🚀',
      probability: prob,
      historicalAccuracy: '74–77%',
      showInEmbed: true,
    };
  } else if (prob >= 0.67) {
    return {
      tier: 'high_conviction',
      label: 'High Conviction',
      emoji: '🟢',
      probability: prob,
      historicalAccuracy: '70–74%',
      showInEmbed: true,
    };
  } else if (prob >= 0.62) {
    return {
      tier: 'strong',
      label: 'Strong',
      emoji: '🔵',
      probability: prob,
      historicalAccuracy: '65–68%',
      showInEmbed: true,
    };
  } else if (prob >= 0.55) {
    return {
      tier: 'lean',
      label: 'Lean',
      emoji: '⚪',
      probability: prob,
      historicalAccuracy: '~58%',
      showInEmbed: true,
    };
  } else {
    return {
      tier: 'coin_flip',
      label: 'Coin Flip',
      emoji: '🪙',
      probability: prob,
      historicalAccuracy: '~53%',
      showInEmbed: false,
    };
  }
}

// ─── Brier score ──────────────────────────────────────────────────────────────

export function brierScore(probability: number, outcome: number): number {
  return Math.pow(probability - outcome, 2);
}

// ─── Log loss ────────────────────────────────────────────────────────────────

export function logLoss(probability: number, outcome: number): number {
  const p = Math.max(0.001, Math.min(0.999, probability));
  return -(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p));
}

// ─── Format edge for display ──────────────────────────────────────────────────

export function formatEdge(edge: number): string {
  const sign = edge > 0 ? '+' : '';
  return `${sign}${(edge * 100).toFixed(1)}%`;
}

export function formatProb(prob: number): string {
  return `${Math.round(prob * 100)}%`;
}

export function formatSpread(spread: number): string {
  if (spread === 0) return 'PK';
  const side = spread > 0 ? 'Home' : 'Away';
  return `${side} -${Math.abs(spread).toFixed(1)}`;
}
