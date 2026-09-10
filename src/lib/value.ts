/**
 * Player Value Score (0–1000).
 *
 * A season-long, in-season valuation built entirely from scored production.
 * The model blends 10 normalised signals, every one of which is a percentile
 * *within the player's own position group* — a 900-value kicker and a
 * 900-value receiver are both "top of their pool", not comparable in raw
 * points. Cross-position comparison is `trade.ts`, in points.
 *
 * Design rules carried over from the original model, and worth preserving:
 *  - On-field production and recency dominate.
 *  - Workload share captures the stability of the player's role. Snap share
 *    would be the better measure and is not available: ESPN publishes no snap
 *    count this app could verify (see `UNNAMED_IDS`), so the weight that
 *    signal would have carried is spread across the volume terms rather than
 *    filled with a number that looks like snaps and isn't.
 *  - Forecasts contribute without overriding demonstrated production.
 *  - Age is excluded: this is an in-season value model, not a dynasty ranking.
 *  - Small samples are blended toward neutral rather than crushed to zero.
 */

import {
  createScorer,
  efficiency,
  hasPlayed,
  hasValidProjection,
  opportunities,
  type ScoringModel,
} from './scoring';
import { clamp01, percentileRanks, quantile, round, stdev } from './stats';
import type { Player, PositionGroup, RankInfo, StatLine } from './types';

/** Weights applied to the normalised 0..1 signals. These sum to ~1.0. */
export const VALUE_WEIGHTS = {
  ppg: 0.24,
  scheduleAdjusted: 0.08,
  ewma: 0.18,
  last4: 0.09,
  forecast: 0.15,
  opportunityShare: 0.14,
  usage: 0.05,
  availability: 0.02,
  floor: 0.03,
  efficiency: 0.02,
} as const;

/** Boom/bust thresholds. Configurable in settings; these are the defaults. */
export interface BoomBustConfig {
  boomPct: number;
  bustPct: number;
}

export const DEFAULT_BOOM_BUST: BoomBustConfig = { boomPct: 1.2, bustPct: 0.8 };

export interface ValueBreakdown {
  group: PositionGroup;
  games: number;
  ppg: number;
  scheduleAdjustedPpg: number;
  total: number;
  last4: number;
  last8: number;
  ewma: number;
  forecastProjection: number | null;
  /** Games played / elapsed weeks excluding a known, completed bye. */
  availability: number;
  consistency: number;
  floor: number;
  ceiling: number;
  boomRate: number;
  bustRate: number;
  deltaAvg: number;
  deltaBeatRate: number;
  usagePerGame: number | null;
  opportunityShare: number | null;
  recentOpportunityShare: number | null;
  usageTrend: number;
  efficiency: number | null;
  ownedPct: number | null;
  startedPct: number | null;
  /** Confidence multiplier applied for small samples (0.45..1.0). */
  gamesConfidence: number;
  /** Per-term contributions, for the "why this score" panel. */
  contributions: Array<{ label: string; weight: number; normalized: number; points: number }>;
}

export interface PlayerValue {
  pid: string;
  score: number;
  group: PositionGroup;
  breakdown: ValueBreakdown;
}

export interface WeeklyPlayerScore {
  week: number;
  actual: number;
  projected: number | null;
  /** Opponent reported by the stat feed for this specific week. */
  opponent: string | null;
}

export interface ValueIndex {
  byPlayer: Map<string, PlayerValue>;
  ppgRanks: Map<string, RankInfo>;
  totalRanks: Map<string, RankInfo>;
  boomRateRanks: Map<string, RankInfo>;
  /** Per-player, per-week custom scores — reused by charts and history. */
  weeklyScores: Map<string, WeeklyPlayerScore[]>;
  seasonTotals: Map<string, number>;
}

interface Accumulator {
  total: number;
  scheduleAdjustedTotal: number;
  games: number;
  weekScores: number[];
  weeklyDetail: WeeklyPlayerScore[];
  lastActs: number[];
  boom: number;
  bust: number;
  projGames: number;
  deltaSum: number;
  deltaBeat: number;
  deltaN: number;
  oppSum: number;
  oppN: number;
  oppSeries: number[];
  shareSum: number;
  shareN: number;
  shareSeries: number[];
  effSum: number;
  effN: number;
}

function newAccumulator(): Accumulator {
  return {
    total: 0,
    scheduleAdjustedTotal: 0,
    games: 0,
    weekScores: [],
    weeklyDetail: [],
    lastActs: [],
    boom: 0,
    bust: 0,
    projGames: 0,
    deltaSum: 0,
    deltaBeat: 0,
    deltaN: 0,
    oppSum: 0,
    oppN: 0,
    oppSeries: [],
    shareSum: 0,
    shareN: 0,
    shareSeries: [],
    effSum: 0,
    effN: 0,
  };
}

/** Exponentially weighted mean, newest week first, validated at 0.68 decay. */
function weightedRecent(values: number[], decay = 0.68): number {
  if (!values.length) return 0;
  let total = 0;
  let weights = 0;
  let weight = 1;
  for (let index = values.length - 1; index >= 0; index--) {
    total += values[index] * weight;
    weights += weight;
    weight *= decay;
  }
  return weights ? total / weights : 0;
}

function meanLast(values: number[], size: number): number {
  const recent = values.slice(-size);
  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

/**
 * How many games a player must have to be ranked.
 *
 * Dynamic, so early-season ranks are not dominated by one-week wonders without
 * being so strict that nobody qualifies in week 3. Shared with the prior-season
 * ranks below so a 2025 chip and a 2026 one mean the same thing by "ranked".
 */
function minGamesForRank(throughWeek: number): number {
  return Math.min(6, Math.max(3, Math.floor(throughWeek * 0.55)));
}

/** Orders one position group by one measure and writes the ranks into `into`. */
function rankPool(
  entries: Array<{ pid: string; value: number }>,
  group: PositionGroup,
  season: string,
  places: number,
  into: Map<string, RankInfo>,
): void {
  const sorted = [...entries].sort((a, b) => b.value - a.value);
  sorted.forEach((entry, i) => {
    into.set(entry.pid, {
      group,
      season,
      rank: i + 1,
      outOf: sorted.length,
      value: round(entry.value, places),
    });
  });
}

export interface BuildValueIndexInput {
  scoringModel: ScoringModel;
  playersById: Map<string, Player>;
  /** The season being valued, stamped onto every rank it produces. */
  season: string;
  /** week number -> pid -> stat line */
  weekStats: Map<number, Record<string, StatLine>>;
  weekProjections: Map<number, Record<string, StatLine>>;
  weekOpponents?: Map<number, Record<string, string>>;
  weekTeams?: Map<number, Record<string, string>>;
  forecastProjections?: Record<string, StatLine>;
  throughWeek: number;
  config?: BoomBustConfig;
}

/**
 * Builds the full value index for a season in a single pass over week stats.
 *
 * This is the most expensive computation in the app (roughly 2000 players x 18
 * weeks), so it runs once per season load and every page reads from the result.
 */
export function buildValueIndex(input: BuildValueIndexInput): ValueIndex {
  const {
    scoringModel,
    playersById,
    season,
    weekStats,
    weekProjections,
    weekOpponents,
    weekTeams,
    forecastProjections,
    throughWeek,
    config = DEFAULT_BOOM_BUST,
  } = input;

  const score = createScorer(scoringModel);
  const agg = new Map<string, Accumulator>();
  const teamOpportunityTotals = new Map<string, number>();
  const groupScoreTotals = new Map<PositionGroup, { sum: number; count: number }>();
  const defenseScoreTotals = new Map<string, { sum: number; count: number }>();

  // Precompute position-group workload totals so a player's role is measured
  // as a share of his own unit. The same pass measures opponent difficulty
  // from each unit's points per opponent game. Counting individual players
  // would make an opponent look harder whenever a zero-point backup played.
  for (let week = 1; week <= throughWeek; week++) {
    const stats = weekStats.get(week) ?? {};
    const teams = weekTeams?.get(week) ?? {};
    const opponents = weekOpponents?.get(week) ?? {};
    const defenseGames = new Set<string>();
    for (const [pid, line] of Object.entries(stats)) {
      if (!hasPlayed(line)) continue;
      const group = playersById.get(pid)?.group ?? null;
      if (!group) continue;

      const opponent = opponents[pid];
      if (opponent) {
        // Both means use the same population; an unknown opponent cannot
        // contribute only to the league baseline and skew every comparison.
        const actual = score(line, group);
        const defenseKey = `${group}:${opponent}`;
        const groupTotal = groupScoreTotals.get(group) ?? { sum: 0, count: 0 };
        const defenseTotal = defenseScoreTotals.get(defenseKey) ?? { sum: 0, count: 0 };
        groupTotal.sum += actual;
        defenseTotal.sum += actual;
        if (!defenseGames.has(defenseKey)) {
          groupTotal.count++;
          defenseTotal.count++;
          defenseGames.add(defenseKey);
        }
        groupScoreTotals.set(group, groupTotal);
        defenseScoreTotals.set(defenseKey, defenseTotal);
      }

      const team = teams[pid];
      if (team) {
        const volume = opportunities(group, line);
        if (volume !== null) {
          const totalKey = `${week}:${team}:${group}`;
          teamOpportunityTotals.set(
            totalKey,
            (teamOpportunityTotals.get(totalKey) ?? 0) + volume,
          );
        }
      }
    }
  }

  // ---- Pass 1: accumulate per-player season aggregates ---------------------
  for (let week = 1; week <= throughWeek; week++) {
    const stats = weekStats.get(week);
    if (!stats) continue;
    const projections = weekProjections.get(week) ?? {};
    const teams = weekTeams?.get(week) ?? {};
    const opponents = weekOpponents?.get(week) ?? {};

    for (const pid of Object.keys(stats)) {
      const line = stats[pid];
      if (!hasPlayed(line)) continue;

      const player = playersById.get(pid);
      const group = player?.group ?? null;
      if (!group) continue;

      let a = agg.get(pid);
      if (!a) {
        a = newAccumulator();
        agg.set(pid, a);
      }

      const actual = score(line, group);
      a.total += actual;
      const groupTotal = groupScoreTotals.get(group);
      const defenseTotal = defenseScoreTotals.get(`${group}:${opponents[pid]}`);
      const leagueMean =
        groupTotal && groupTotal.count > 0 ? groupTotal.sum / groupTotal.count : 0;
      const defenseMean =
        defenseTotal && defenseTotal.count > 0 ? defenseTotal.sum / defenseTotal.count : 0;
      const difficulty =
        leagueMean > 0 && defenseMean > 0
          ? Math.max(0.65, Math.min(1.35, defenseMean / leagueMean))
          : 1;
      a.scheduleAdjustedTotal += actual / difficulty;
      a.games += 1;
      a.weekScores.push(actual);

      // Keep a rolling last-8 window for recency weighting.
      a.lastActs.push(actual);
      if (a.lastActs.length > 8) a.lastActs.shift();

      // Projection-derived signals only count when a real projection exists,
      // otherwise every unprojected week would register as a boom.
      const projLine = projections[pid];
      const projected = hasValidProjection(projLine) ? score(projLine, group) : null;
      a.weeklyDetail.push({
        week,
        actual,
        projected,
        opponent: opponents[pid] ?? null,
      });

      if (projected !== null && projected > 0) {
        a.projGames += 1;
        a.deltaSum += actual - projected;
        a.deltaN += 1;
        if (actual > projected) a.deltaBeat += 1;
        if (actual >= projected * config.boomPct) a.boom += 1;
        else if (actual <= projected * config.bustPct) a.bust += 1;
      }


      const opps = opportunities(group, line);
      if (opps !== null) {
        a.oppSum += opps;
        a.oppN += 1;
        a.oppSeries.push(opps);

        const team = teams[pid];
        const teamTotal = team ? teamOpportunityTotals.get(`${week}:${team}:${group}`) : 0;
        if (teamTotal && teamTotal > 0) {
          const share = opps / teamTotal;
          a.shareSum += share;
          a.shareN += 1;
          a.shareSeries.push(share);
        }
      }

      const eff = efficiency(group, line, actual);
      if (eff !== null) {
        a.effSum += eff;
        a.effN += 1;
      }
    }
  }

  // ---- Pass 2: derive per-player metrics -----------------------------------
  interface Derived {
    pid: string;
    group: PositionGroup;
    games: number;
    total: number;
    ppg: number;
    scheduleAdjustedPpg: number;
    last4: number;
    last8: number;
    ewma: number;
    forecastRaw: number | null;
    availability: number;
    floor: number;
    ceiling: number;
    consistency: number;
    boomRate: number;
    bustRate: number;
    boomBustAdj: number;
    oppPerGame: number | null;
    shareRaw: number | null;
    recentShareRaw: number | null;
    oppTrend: number;
    effAvg: number | null;
    marketAdj: number;
    owned: number | null;
    started: number | null;
    deltaAvg: number;
    deltaBeatRate: number;
    deltaBeatAdj: number;
  }

  const derived = new Map<string, Derived>();
  const byGroup = new Map<PositionGroup, string[]>();

  for (const [pid, a] of agg) {
    if (!a.games) continue;
    const player = playersById.get(pid);
    const group = player?.group ?? null;
    if (!group) continue;

    const ppg = a.total / a.games;
    const scheduleAdjustedPpg = a.scheduleAdjustedTotal / a.games;

    const recent4 = a.lastActs.slice(-4);
    const last4 = recent4.length ? recent4.reduce((x, y) => x + y, 0) / recent4.length : ppg;
    const last8 = a.lastActs.length
      ? a.lastActs.reduce((x, y) => x + y, 0) / a.lastActs.length
      : ppg;
    const ewma = weightedRecent(a.weekScores);
    const forecastLine = forecastProjections?.[pid];
    // Historical PPG is the honest fallback when no live projection exists;
    // treating an unprojected player as neutral erased useful demonstrated form.
    const forecastRaw = hasValidProjection(forecastLine) ? score(forecastLine, group) : ppg;

    const byeWeek = player?.byeWeek;
    const completedBye =
      byeWeek != null && Number.isInteger(byeWeek) && byeWeek > 0 && byeWeek <= throughWeek &&
      !hasPlayed(weekStats.get(byeWeek)?.[pid]);
    const possibleGames = throughWeek - (completedBye ? 1 : 0);
    const availability = possibleGames > 0 ? clamp01(a.games / possibleGames) : 0;
    const floor = quantile(a.weekScores, 0.25);
    const ceiling = quantile(a.weekScores, 0.85);

    // Coefficient of variation -> consistency. cv >= 1 collapses to 0.
    const sd = stdev(a.weekScores);
    const cv = ppg > 0 ? sd / (ppg + 1e-6) : 0;
    const consistency = clamp01(1 - cv);

    const boomRate = a.projGames > 0 ? a.boom / a.projGames : 0;
    const bustRate = a.projGames > 0 ? a.bust / a.projGames : 0;
    const boomBustAdj = a.projGames > 0 ? clamp01((boomRate - bustRate + 1) / 2) : 0.5;

    const oppPerGame = a.oppN > 0 ? a.oppSum / a.oppN : null;
    const shareRaw = a.shareN > 0 ? a.shareSum / a.shareN : null;
    const recentShareRaw =
      a.shareSeries.length > 0
        ? meanLast(a.shareSeries, 2)
        : null;
    let oppTrend = 0;
    if (oppPerGame !== null && oppPerGame > 0 && a.oppSeries.length >= 2) {
      const last2 = a.oppSeries.slice(-2);
      const lastAvg = last2.reduce((x, y) => x + y, 0) / last2.length;
      oppTrend = (lastAvg - oppPerGame) / Math.max(1, oppPerGame);
    }

    const effAvg = a.effN > 0 ? a.effSum / a.effN : null;

    // Market context, carried on the player record. Start% is preferred over
    // ownership% because it reflects what managers did this week rather than
    // what they did on draft night and never revisited.
    const owned = player?.percentOwned ?? null;
    const started = player?.percentStarted ?? null;
    const marketAdj =
      started !== null ? clamp01(started / 100) : owned !== null ? clamp01(owned / 100) : 0.5;

    const deltaAvg = a.deltaN > 0 ? a.deltaSum / a.deltaN : 0;
    const deltaBeatRate = a.deltaN > 0 ? a.deltaBeat / a.deltaN : 0;
    // Bayesian shrinkage toward 50% damps small-sample beat rates.
    const DELTA_PRIOR = 6;
    const deltaBeatAdj =
      a.deltaN > 0 ? (a.deltaBeat + DELTA_PRIOR * 0.5) / (a.deltaN + DELTA_PRIOR) : 0.5;

    derived.set(pid, {
      pid,
      group,
      games: a.games,
      total: a.total,
      ppg,
      scheduleAdjustedPpg,
      last4,
      last8,
      ewma,
      forecastRaw,
      availability,
      floor,
      ceiling,
      consistency,
      boomRate,
      bustRate,
      boomBustAdj,
      oppPerGame,
      shareRaw,
      recentShareRaw,
      oppTrend,
      effAvg,
      marketAdj,
      owned,
      started,
      deltaAvg,
      deltaBeatRate,
      deltaBeatAdj,
    });

    const bucket = byGroup.get(group);
    if (bucket) bucket.push(pid);
    else byGroup.set(group, [pid]);
  }

  // ---- Pass 3: rank and percentile within each position group --------------

  const threshold = minGamesForRank(throughWeek);

  const ppgRanks = new Map<string, RankInfo>();
  const totalRanks = new Map<string, RankInfo>();
  const boomRateRanks = new Map<string, RankInfo>();

  for (const [group, pids] of byGroup) {
    const rows = pids.map((pid) => derived.get(pid)!);

    rankPool(
      rows.filter((d) => d.games >= threshold).map((d) => ({ pid: d.pid, value: d.ppg })),
      group,
      season,
      2,
      ppgRanks,
    );

    rankPool(
      rows.filter((d) => d.total > 0).map((d) => ({ pid: d.pid, value: d.total })),
      group,
      season,
      2,
      totalRanks,
    );

    rankPool(
      rows
        .filter((d) => (agg.get(d.pid)?.projGames ?? 0) >= threshold)
        .map((d) => ({ pid: d.pid, value: d.boomRate })),
      group,
      season,
      3,
      boomRateRanks,
    );
  }

  const byPlayer = new Map<string, PlayerValue>();

  for (const [group, pids] of byGroup) {
    const rows = pids.map((pid) => derived.get(pid)!);

    // Percentile every raw signal within this position group.
    const pct = (pick: (d: Derived) => number | null) => {
      const entries = rows
        .filter((d) => pick(d) !== null)
        .map((d) => ({ id: d.pid, value: pick(d) as number }));
      return percentileRanks(entries);
    };

    const pPpg = pct((d) => d.ppg);
    const pScheduleAdjusted = pct((d) => d.scheduleAdjustedPpg);
    const pLast4 = pct((d) => d.last4);
    const pEwma = pct((d) => d.ewma);
    const pForecast = pct((d) => d.forecastRaw);
    const pFloor = pct((d) => d.floor);
    const pAvail = pct((d) => d.availability);
    const pUsage = pct((d) => d.oppPerGame);
    const pShare = pct((d) => d.recentShareRaw);
    const pEff = pct((d) => d.effAvg);

    for (const d of rows) {
      // Each entry: [label, weight, normalised 0..1 signal]
      const terms: Array<[string, number, number]> = [
        ['PPG', VALUE_WEIGHTS.ppg, pPpg.get(d.pid) ?? 0.5],
        [
          'Schedule-adjusted PPG',
          VALUE_WEIGHTS.scheduleAdjusted,
          pScheduleAdjusted.get(d.pid) ?? 0.5,
        ],
        ['Weighted recent form', VALUE_WEIGHTS.ewma, pEwma.get(d.pid) ?? 0.5],
        ['Last 4', VALUE_WEIGHTS.last4, pLast4.get(d.pid) ?? 0.5],
        ['Current projection', VALUE_WEIGHTS.forecast, pForecast.get(d.pid) ?? 0.5],
        ['Team opportunity share', VALUE_WEIGHTS.opportunityShare, pShare.get(d.pid) ?? 0.5],
        ['Availability', VALUE_WEIGHTS.availability, pAvail.get(d.pid) ?? 0.5],
        ['Floor', VALUE_WEIGHTS.floor, pFloor.get(d.pid) ?? 0.5],
        ['Usage', VALUE_WEIGHTS.usage, pUsage.get(d.pid) ?? 0.5],
        ['Efficiency', VALUE_WEIGHTS.efficiency, pEff.get(d.pid) ?? 0.5],
      ];

      let raw = 0;
      const contributions = terms.map(([label, weight, normalized]) => {
        const points = weight * normalized;
        raw += points;
        return { label, weight, normalized, points };
      });

      /*
       * Small-sample handling: blend toward neutral instead of crushing the
       * score, so a player with 2 great games isn't ranked above a proven one
       * but also isn't buried.
       *
       * The window matters and used to be missing. `clamp01(games - 1)` reaches
       * 1.0 at two games, so the guard it looks like it is applying — a
       * confidence that grows with the sample — was in fact a one-game step
       * from 0.7 to 1.0, and a two-game wonder carried a full-confidence score.
       * Dividing by the window makes it fade in over six games, which is the
       * same threshold `minGamesForRank` settles on for ranking eligibility.
       */
      const CONFIDENCE_GAMES = 6;
      const gamesConfidence =
        0.7 + 0.3 * clamp01((d.games - 1) / (CONFIDENCE_GAMES - 1));
      raw = 0.5 + (raw - 0.5) * gamesConfidence;

      const finalScore = Math.round(clamp01(raw) * 1000);

      byPlayer.set(d.pid, {
        pid: d.pid,
        score: finalScore,
        group,
        breakdown: {
          group,
          games: d.games,
          ppg: round(d.ppg),
          scheduleAdjustedPpg: round(d.scheduleAdjustedPpg),
          total: round(d.total),
          last4: round(d.last4),
          last8: round(d.last8),
          ewma: round(d.ewma),
          forecastProjection: d.forecastRaw === null ? null : round(d.forecastRaw),
          availability: round(d.availability, 3),
          consistency: round(d.consistency, 3),
          floor: round(d.floor),
          ceiling: round(d.ceiling),
          boomRate: round(d.boomRate, 3),
          bustRate: round(d.bustRate, 3),
          deltaAvg: round(d.deltaAvg),
          deltaBeatRate: round(d.deltaBeatAdj, 3),
          usagePerGame: d.oppPerGame === null ? null : round(d.oppPerGame, 1),
          opportunityShare: d.shareRaw === null ? null : round(d.shareRaw, 3),
          recentOpportunityShare:
            d.recentShareRaw === null ? null : round(d.recentShareRaw, 3),
          usageTrend: round(d.oppTrend, 3),
          efficiency: d.effAvg === null ? null : round(d.effAvg, 2),
          ownedPct: d.owned,
          startedPct: d.started,
          gamesConfidence: round(gamesConfidence, 3),
          contributions,
        },
      });
    }
  }

  // Weekly detail + season totals, exposed for charts and history views.
  const weeklyScores = new Map<string, WeeklyPlayerScore[]>();
  const seasonTotals = new Map<string, number>();
  for (const [pid, a] of agg) {
    a.weeklyDetail.sort((x, y) => x.week - y.week);
    weeklyScores.set(pid, a.weeklyDetail);
    seasonTotals.set(pid, round(a.total));
  }

  return { byPlayer, ppgRanks, totalRanks, boomRateRanks, weeklyScores, seasonTotals };
}

// ---------------------------------------------------------------------------
// Last season's ranks
// ---------------------------------------------------------------------------

/**
 * One player's finished-season production, ranked the way this season's is.
 *
 * The three numbers are measured in Node by `seasonProduction` and shipped in
 * `priors.json`; this is the browser-side shape they arrive as, with the rates
 * already divided out.
 */
export interface PriorProduction {
  pid: string;
  /** The finished season these numbers are from. Travels with them, as `RankInfo.season` does. */
  season: string;
  /**
   * The group he is listed at **today**, not last season.
   *
   * His points were scored under last season's listing, which is correct — a
   * receiver's wildcat year belongs in the receiver pool. But the chip reads
   * "RB #4", and the RB it names is the position he is being drafted at now.
   * Ranking him against the players he is being compared to today is the whole
   * question the chip answers, and a player who changed position is rare enough
   * that carrying two pools to serve him would cost more than it buys.
   */
  group: PositionGroup;
  total: number;
  games: number;
  ppg: number;
  boom: number;
  projectedGames: number;
  boomRate: number;
}

/** Just the rank half of a `ValueIndex`, over a season that is already over. */
export interface PriorRankIndex {
  season: string;
  ppgRanks: Map<string, RankInfo>;
  totalRanks: Map<string, RankInfo>;
  boomRateRanks: Map<string, RankInfo>;
}

/**
 * Ranks a finished season, for the chips to report until this one has been played.
 *
 * In week one `buildValueIndex` has nothing to rank — no games, so no PPG, no
 * total and no boom rate — and every row reads "Total — | PPG — | BR —". That is
 * a true statement about a season that has not started and a useless one to a
 * manager setting a week-one lineup, who is working from exactly this: what these
 * players did last year.
 *
 * Ranked here rather than shipped pre-ranked because a rank is a statement about
 * a *pool*, and the pool is today's universe: a player who retired, or who this
 * league's snapshot no longer lists, must not sit between two players who did
 * play. Only the per-player production is fitted offline; who it is ranked
 * against is decided against the roster that exists now.
 *
 * The eligibility rules are `buildValueIndex`'s, at a finished season's week
 * count — six games — so "ranked" means the same thing in both, and a chip does
 * not silently change what it is claiming when the app switches source in week
 * four.
 */
export function buildPriorRanks(
  season: string,
  production: Iterable<PriorProduction>,
  seasonWeeks: number,
): PriorRankIndex {
  const threshold = minGamesForRank(seasonWeeks);

  const byGroup = new Map<PositionGroup, PriorProduction[]>();
  for (const row of production) {
    const bucket = byGroup.get(row.group);
    if (bucket) bucket.push(row);
    else byGroup.set(row.group, [row]);
  }

  const ppgRanks = new Map<string, RankInfo>();
  const totalRanks = new Map<string, RankInfo>();
  const boomRateRanks = new Map<string, RankInfo>();

  for (const [group, rows] of byGroup) {
    rankPool(
      rows.filter((r) => r.games >= threshold).map((r) => ({ pid: r.pid, value: r.ppg })),
      group,
      season,
      2,
      ppgRanks,
    );

    rankPool(
      rows.filter((r) => r.total > 0).map((r) => ({ pid: r.pid, value: r.total })),
      group,
      season,
      2,
      totalRanks,
    );

    rankPool(
      rows
        .filter((r) => r.projectedGames >= threshold)
        .map((r) => ({ pid: r.pid, value: r.boomRate })),
      group,
      season,
      3,
      boomRateRanks,
    );
  }

  return { season, ppgRanks, totalRanks, boomRateRanks };
}
