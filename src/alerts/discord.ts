// NCAAF Oracle v4.1 — Discord Embed Delivery
// Rich embedded messages via Discord webhooks.
// Colors: Gold = predictions, Green = winning recap, Red = losing recap, Blue = info
// Splits into multiple embeds when > 25 fields (Discord limit).

import fetch from 'node-fetch';
import { logger } from '../logger.js';
import { classifyConfidence, detectEdge, formatEdge, formatProb, formatSpread } from '../models/marketEdge.js';
import type { Prediction, SeasonAccuracy, WeekInfo } from '../types.js';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? '';

// ─── Discord colors ────────────────────────────────────────────────────────────

const COLORS = {
  gold: 0xC5960C,
  green: 0x2ECC71,
  red: 0xE74C3C,
  blue: 0x3498DB,
  purple: 0x9B59B6,
} as const;

// ─── Discord embed types ───────────────────────────────────────────────────────

interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: DiscordField[];
  footer?: { text: string };
  timestamp?: string;
  thumbnail?: { url: string };
}

interface DiscordPayload {
  username?: string;
  avatar_url?: string;
  embeds: DiscordEmbed[];
}

// ─── Send webhook ─────────────────────────────────────────────────────────────

async function sendWebhook(payload: DiscordPayload): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) {
    logger.error('DISCORD_WEBHOOK_URL not set');
    throw new Error('DISCORD_WEBHOOK_URL not set');
  }

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord webhook failed: ${res.status} — ${body.slice(0, 200)}`);
  }
  logger.info('Discord embed sent successfully');
}

// Split fields into chunks of 25 (Discord limit) and send as multiple embeds
async function sendEmbedWithFields(
  baseEmbed: Omit<DiscordEmbed, 'fields'>,
  fields: DiscordField[],
  footerText: string,
): Promise<void> {
  const CHUNK = 25;
  const chunks: DiscordField[][] = [];
  for (let i = 0; i < fields.length; i += CHUNK) {
    chunks.push(fields.slice(i, i + CHUNK));
  }

  // Discord allows up to 10 embeds per message; split into messages if needed
  const EMBEDS_PER_MSG = 4;
  for (let msgI = 0; msgI < chunks.length; msgI += EMBEDS_PER_MSG) {
    const msgChunks = chunks.slice(msgI, msgI + EMBEDS_PER_MSG);
    const embeds: DiscordEmbed[] = msgChunks.map((chunk, i) => ({
      ...baseEmbed,
      title: i === 0 && msgI === 0 ? baseEmbed.title : `${baseEmbed.title} (cont.)`,
      fields: chunk,
      footer: { text: footerText },
      timestamp: new Date().toISOString(),
    }));
    await sendWebhook({ username: 'NCAAF Oracle', embeds });
    if (msgI + EMBEDS_PER_MSG < chunks.length) {
      await new Promise(r => setTimeout(r, 1000)); // rate limit pause
    }
  }
}

// ─── Weekly Predictions Embed ─────────────────────────────────────────────────

export async function sendPredictionsEmbed(
  weekInfo: WeekInfo,
  predictions: Prediction[],
  accuracy: SeasonAccuracy | null,
): Promise<void> {
  const { week, weekLabel, earlySeasonLabel, isPriorYearMode } = weekInfo;

  // Sort: extreme conviction first, then high conviction, then strong, then lean
  const tierOrder = { extreme_conviction: 0, high_conviction: 1, strong: 2, lean: 3, coin_flip: 4 };
  const sorted = [...predictions].sort((a, b) =>
    (tierOrder[a.confidence_tier] ?? 4) - (tierOrder[b.confidence_tier] ?? 4)
  );

  const extremePicks = sorted.filter(p => p.confidence_tier === 'extreme_conviction');
  const highPicks = sorted.filter(p => p.confidence_tier === 'high_conviction');
  const strongPicks = sorted.filter(p => p.confidence_tier === 'strong');
  const leanPicks = sorted.filter(p => p.confidence_tier === 'lean');
  const coinFlips = sorted.filter(p => p.confidence_tier === 'coin_flip');

  // Build description
  let description = `**${predictions.length}** AP Top 25 games this week.`;
  description += ` Model confidence: **${extremePicks.length + highPicks.length}** High+Extreme, **${strongPicks.length}** Strong, **${leanPicks.length}** Lean.`;
  if (earlySeasonLabel) description += `\n\n${earlySeasonLabel}`;

  const fields: DiscordField[] = [];

  // ── Running season record ─────────────────────────────────────────────────
  if (accuracy && accuracy.totalPicks > 0) {
    fields.push({
      name: '🏆 Season Record',
      value: `**${accuracy.correctPicks}-${accuracy.totalPicks - accuracy.correctPicks}** (${(accuracy.accuracy * 100).toFixed(1)}%) | Brier: ${accuracy.brierScore.toFixed(3)}`,
      inline: true,
    });
    fields.push({
      name: '📈 High-Conviction',
      value: `**${accuracy.highConvCorrect}-${accuracy.highConvPicks - accuracy.highConvCorrect}** (${(accuracy.highConvAccuracy * 100).toFixed(1)}%)`,
      inline: true,
    });
    fields.push({
      name: '🎰 vs Vegas ATS',
      value: `**${accuracy.atsWins}-${accuracy.atsLosses}** (${accuracy.atsWins + accuracy.atsLosses > 0 ? (accuracy.atsAccuracy * 100).toFixed(1) : 'N/A'}%)`,
      inline: true,
    });
  }

  // ── Week-by-week trend ────────────────────────────────────────────────────
  if (accuracy && accuracy.weeklyRecord.length > 0) {
    const trendStr = accuracy.weeklyRecord
      .slice(-8)
      .map(w => `W${w.week}: ${w.wins}-${w.losses}`)
      .join(' | ');
    fields.push({
      name: '📊 Recent Trend',
      value: trendStr,
      inline: false,
    });
  }

  // ── Extreme conviction picks ──────────────────────────────────────────────
  for (const pred of extremePicks) {
    fields.push(buildGameField(pred, '🚀'));
  }

  // ── High conviction picks ─────────────────────────────────────────────────
  for (const pred of highPicks) {
    fields.push(buildGameField(pred, '🟢'));
  }

  // ── Strong picks (condensed) ──────────────────────────────────────────────
  if (strongPicks.length > 0) {
    const strongLines = strongPicks.map(pred => {
      const pick = pred.calibrated_prob >= 0.5 ? pred.home_team : pred.away_team;
      const prob = Math.max(pred.calibrated_prob, 1 - pred.calibrated_prob);
      return `• **${pick}** (${formatProb(prob)})`;
    });
    fields.push({
      name: `🔵 Strong Picks (${strongPicks.length})`,
      value: strongLines.slice(0, 15).join('\n'),
      inline: false,
    });
  }

  // ── Lean picks (condensed) ────────────────────────────────────────────────
  if (leanPicks.length > 0) {
    const leanLines = leanPicks.map(pred => {
      const pick = pred.calibrated_prob >= 0.5 ? pred.home_team : pred.away_team;
      const prob = Math.max(pred.calibrated_prob, 1 - pred.calibrated_prob);
      return `• **${pick}** (${formatProb(prob)})`;
    });
    fields.push({
      name: `⚪ Leans (${leanPicks.length})`,
      value: leanLines.slice(0, 10).join('\n'),
      inline: false,
    });
  }

  const modeLabel = isPriorYearMode ? ' | Prior-Year Mode (Weeks 1–2)' : '';
  const footerText = `NCAAF Oracle v4.1${modeLabel} | Season ${weekInfo.season}`;

  await sendEmbedWithFields(
    {
      title: `🏈 NCAAF Oracle — ${weekLabel} Predictions`,
      description,
      color: COLORS.gold,
    },
    fields,
    footerText,
  );
}

// ─── Weekend Recap Embed ──────────────────────────────────────────────────────

export async function sendRecapEmbed(
  weekInfo: WeekInfo,
  gradedPredictions: Prediction[],
  accuracy: SeasonAccuracy,
): Promise<void> {
  const { week, weekLabel } = weekInfo;

  const weekResults = gradedPredictions.filter(p => p.week === week);
  const weekWins = weekResults.filter(p => p.correct).length;
  const weekLosses = weekResults.filter(p => !p.correct).length;
  const weekAcc = weekResults.length > 0 ? weekWins / weekResults.length : 0;

  const isWinningWeek = weekAcc >= 0.5;
  const color = weekAcc >= 0.62 ? COLORS.green : weekAcc >= 0.5 ? COLORS.blue : COLORS.red;

  const description = `This week: **${weekWins}-${weekLosses}** (${(weekAcc * 100).toFixed(1)}%). Season: **${accuracy.correctPicks}-${accuracy.totalPicks - accuracy.correctPicks}** (${(accuracy.accuracy * 100).toFixed(1)}%).`;

  const fields: DiscordField[] = [
    {
      name: '🏆 Season Record',
      value: `**${accuracy.correctPicks}-${accuracy.totalPicks - accuracy.correctPicks}** (${(accuracy.accuracy * 100).toFixed(1)}%)`,
      inline: true,
    },
    {
      name: '🎯 This Week',
      value: `**${weekWins}-${weekLosses}** (${(weekAcc * 100).toFixed(1)}%)`,
      inline: true,
    },
    {
      name: '📉 Season Brier',
      value: `${accuracy.brierScore.toFixed(3)}`,
      inline: true,
    },
    {
      name: '📈 High-Conviction Record',
      value: `**${accuracy.highConvCorrect}-${accuracy.highConvPicks - accuracy.highConvCorrect}** (${accuracy.highConvPicks > 0 ? (accuracy.highConvAccuracy * 100).toFixed(1) : 'N/A'}%)`,
      inline: true,
    },
    {
      name: '🚀 Extreme Conviction',
      value: `**${accuracy.extremeConvCorrect}-${accuracy.extremeConvPicks - accuracy.extremeConvCorrect}** (${accuracy.extremeConvPicks > 0 ? (accuracy.extremeConvAccuracy * 100).toFixed(1) : 'N/A'}%)`,
      inline: true,
    },
    {
      name: '🎰 vs Vegas ATS',
      value: `**${accuracy.atsWins}-${accuracy.atsLosses}**`,
      inline: true,
    },
  ];

  // Individual high/extreme conviction results
  const highConvResults = weekResults.filter(p =>
    p.confidence_tier === 'high_conviction' || p.confidence_tier === 'extreme_conviction'
  );

  for (const pred of highConvResults) {
    const pick = pred.calibrated_prob >= 0.5 ? pred.home_team : pred.away_team;
    const prob = Math.max(pred.calibrated_prob, 1 - pred.calibrated_prob);
    const resultIcon = pred.correct ? '✅' : '❌';
    const scoreStr = pred.home_score !== undefined
      ? `${pred.away_team} ${pred.away_score} @ ${pred.home_team} ${pred.home_score}`
      : 'Score N/A';
    fields.push({
      name: `${resultIcon} ${pred.away_team} @ ${pred.home_team}`,
      value: `Picked **${pick}** (${formatProb(prob)}) — ${scoreStr}`,
      inline: false,
    });
  }

  // Week-by-week trend
  if (accuracy.weeklyRecord.length > 0) {
    const trendStr = accuracy.weeklyRecord
      .slice(-10)
      .map(w => `W${w.week}: ${w.wins}-${w.losses}`)
      .join(' | ');
    fields.push({
      name: '📊 Season Trend',
      value: trendStr,
      inline: false,
    });
  }

  const footerText = `NCAAF Oracle v4.1 | Week ${week} Recap | Season ${weekInfo.season}`;

  await sendEmbedWithFields(
    {
      title: `📊 NCAAF Oracle — ${weekLabel} Recap`,
      description,
      color,
    },
    fields,
    footerText,
  );
}

// ─── Preseason "Online" Embed ─────────────────────────────────────────────────

export async function sendPreseasonEmbed(season: number, teamCount: number): Promise<void> {
  const embed: DiscordEmbed = {
    title: `🏈 NCAAF Oracle is Online — ${season} Season`,
    description: `The ${season} NCAAF Oracle has been initialized and is ready to predict.\n\n**${teamCount}** FBS teams loaded | Preseason Elo computed | Model trained | Database initialized.`,
    color: COLORS.gold,
    fields: [
      {
        name: '🔧 System Status',
        value: '✅ Preseason SP+ loaded\n✅ Recruiting composites loaded\n✅ Transfer portal data loaded\n✅ Elo ratings computed\n✅ Model trained and calibrated',
        inline: false,
      },
      {
        name: '📅 First Prediction',
        value: 'Weekly predictions begin Week 0/1 (late August). Cron: Tuesday 10 AM ET.',
        inline: false,
      },
      {
        name: '🎯 Accuracy Targets',
        value: '62–66% all games | 70–74% at 67%+ conviction | 74–77% at 72%+',
        inline: false,
      },
    ],
    footer: { text: `NCAAF Oracle v4.1 | Season ${season}` },
    timestamp: new Date().toISOString(),
  };

  await sendWebhook({ username: 'NCAAF Oracle', embeds: [embed] });
}

// ─── Season Summary Embed (post-CFP) ─────────────────────────────────────────

export async function sendSeasonSummaryEmbed(season: number, accuracy: SeasonAccuracy): Promise<void> {
  const embed: DiscordEmbed = {
    title: `🏆 NCAAF Oracle — ${season} Season Final Report`,
    description: `The ${season} NCAAF Oracle season is complete. Here's the full report.`,
    color: COLORS.gold,
    fields: [
      {
        name: '🏆 Final Record',
        value: `**${accuracy.correctPicks}-${accuracy.totalPicks - accuracy.correctPicks}** (${(accuracy.accuracy * 100).toFixed(1)}%)`,
        inline: true,
      },
      {
        name: '🟢 High-Conviction (67%+)',
        value: `**${accuracy.highConvCorrect}-${accuracy.highConvPicks - accuracy.highConvCorrect}** (${accuracy.highConvPicks > 0 ? (accuracy.highConvAccuracy * 100).toFixed(1) : 'N/A'}%)`,
        inline: true,
      },
      {
        name: '🚀 Extreme Conviction (72%+)',
        value: `**${accuracy.extremeConvCorrect}-${accuracy.extremeConvPicks - accuracy.extremeConvCorrect}** (${accuracy.extremeConvPicks > 0 ? (accuracy.extremeConvAccuracy * 100).toFixed(1) : 'N/A'}%)`,
        inline: true,
      },
      {
        name: '🎰 vs Vegas ATS',
        value: `**${accuracy.atsWins}-${accuracy.atsLosses}** (${accuracy.atsWins + accuracy.atsLosses > 0 ? (accuracy.atsAccuracy * 100).toFixed(1) : 'N/A'}%)`,
        inline: true,
      },
      {
        name: '📉 Brier Score',
        value: `${accuracy.brierScore.toFixed(3)} (target: < 0.195)`,
        inline: true,
      },
      {
        name: '📊 Total Games',
        value: `${accuracy.totalPicks} predicted`,
        inline: true,
      },
      {
        name: '📈 Full Season Trend',
        value: accuracy.weeklyRecord.map(w => `W${w.week}: ${w.wins}-${w.losses}`).join(' | ') || 'N/A',
        inline: false,
      },
    ],
    footer: { text: `NCAAF Oracle v4.1 | Season complete. See you in August! | Season ${season}` },
    timestamp: new Date().toISOString(),
  };

  await sendWebhook({ username: 'NCAAF Oracle', embeds: [embed] });
}

// ─── Test embed ───────────────────────────────────────────────────────────────

export async function sendTestEmbed(): Promise<void> {
  const embed: DiscordEmbed = {
    title: '🏈 NCAAF Oracle v4.1 — Connection Test',
    description: 'Discord webhook is configured and working correctly. The NCAAF Oracle prediction engine is ready.',
    color: COLORS.gold,
    fields: [
      { name: '✅ Status', value: 'Webhook connected', inline: true },
      { name: '🔧 Version', value: 'v4.1', inline: true },
      { name: '📅 Test Time', value: new Date().toLocaleString(), inline: true },
      {
        name: '🎯 System',
        value: '• Logistic Regression Meta-Model\n• Monte Carlo (10,000 sims)\n• Platt Scaling Calibration\n• SP+ & EPA Features\n• Prior-Year Bootstrap (Weeks 1–2)\n• GitHub Actions Hosted',
        inline: false,
      },
    ],
    footer: { text: 'NCAAF Oracle v4.1 | collegefootballdata.com + GitHub Actions' },
    timestamp: new Date().toISOString(),
  };

  await sendWebhook({ username: 'NCAAF Oracle', embeds: [embed] });
}

// ─── Game field builder ───────────────────────────────────────────────────────

function buildGameField(pred: Prediction, emoji: string): DiscordField {
  const homeWin = pred.calibrated_prob >= 0.5;
  const pick = homeWin ? pred.home_team : pred.away_team;
  const prob = Math.max(pred.calibrated_prob, 1 - pred.calibrated_prob);
  const spreadStr = pred.spread !== undefined ? ` | Spread: ${formatSpread(pred.spread)}` : '';
  const totalStr = pred.total_points ? ` | O/U: ${pred.total_points.toFixed(1)}` : '';
  const scoreStr = pred.most_likely_score ? ` | ML Score: ${pred.most_likely_score}` : '';
  const edgeStr = pred.edge && Math.abs(pred.edge) >= 0.03
    ? ` | Edge: ${formatEdge(pred.edge)} ${pred.edge > 0 ? '💡' : ''}`
    : '';

  const gameDate = new Date(pred.game_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  return {
    name: `${emoji} ${pred.away_team} @ ${pred.home_team} | ${gameDate}`,
    value: `Pick: **${pick}** (${formatProb(prob)})${spreadStr}${totalStr}${scoreStr}${edgeStr}`,
    inline: false,
  };
}
