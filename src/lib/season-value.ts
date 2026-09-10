/**
 * Season Value — the forward-looking half of the within-position rating.
 *
 * The app this one is modelled on runs a **dynasty** league, and its second
 * valuation asks "what is this player worth to hold for years": multi-year
 * production, an age curve, longevity, and a trade market. None of that
 * transfers. This league is an eight-team redraft with a snake draft, no
 * keepers and `keeperCount: 0` — every roster is dissolved in February, so a
 * 23-year-old and a 31-year-old with the same rest-of-season outlook are worth
 * exactly the same thing here. Carrying an age curve over would not have been
 * conservative, it would have been wrong.
 *
 * So this half asks the question redraft actually poses: **what is he worth
 * from here to the end of the season?** The lead leg is rest-of-season VORP —
 * remaining projected points over the production of the player who would
 * replace him — and the market leg is ESPN's own live draft market rather than
 * a dynasty trade index.
 *
 * Like the in-season half, every leg is a percentile *within the player's own
 * position group*, which is what lets the two halves be averaged and read the
 * same way: "top of his own pool", not comparable across positions. These two
 * ratings form the Position score; the headline Value Score uses the shared
 * cross-position points model in `trade.ts` instead.
 */

import { clamp01, percentileRanks, round } from './stats';
import { MATCHUP_INFLUENCE } from './matchup';
import { startingDepthByGroup } from './replacement';
import type { PositionGroup, Player } from './types';
import type { ValueIndex } from './value';

export { startingDepthByGroup } from './replacement';

/**
 * Leg weights, summing to 1.0.
 *
 * Rest-of-season projection dominates because in redraft it is nearly the whole
 * question. Market is a real but minority voice deliberately: the score has to
 * stay an *intrinsic* opinion, or measuring it against the market would just be
 * measuring the market against itself.
 */
export const SEASON_WEIGHTS = {
  vorp: 0.42,
  market: 0.18,
  role: 0.14,
  form: 0.1,
  availability: 0.08,
  schedule: 0.05,
  efficiency: 0.03,
} as const;

export type MarketVerdict = 'Buy' | 'Sell' | 'Fair' | 'Thin market' | 'No read' | 'No market';

/**
 * How far the intrinsic rank must sit from the market rank to call it.
 *
 * Both sides are percentiles over the same pool, so this reads directly: 0.15
 * is "the market has him fifteen percentiles lower than this model does".
 *
 * Ranking the two over *different* pools is the trap here, and it is a quiet
 * one. ESPN prices far fewer players than it lists — most of the universe sits
 * at an auction value of zero — so a market percentile taken over the priced
 * players while every other leg is a percentile over all of them puts the
 * market leg systematically below the intrinsic one by construction. The
 * verdict then stops meaning "the market disagrees" and starts meaning "this
 * player has a price at all". Both sides here are ranked over the priced pool.
 */
const VERDICT_GAP = 0.15;

/**
 * Below this market percentile a price is not worth comparing against.
 *
 * The bottom fifth of ESPN's auction values is rounding noise — a wall of $0
 * and $1 tags against a $60 top — so a percentile gap there measures where a
 * worthless player happened to land, not disagreement.
 */
const VERDICT_MIN_LIQUIDITY = 0.2;

export type RiskBand = 'Low' | 'Moderate' | 'High';

/**
 * Replacement level for a group: what the player at the startable cliff
 * produces. Averaged over a small band around the cliff so one outlier can't
 * set the baseline for a whole position.
 */
function replacementPoints(sortedDesc: number[], depth: number): number {
  if (!sortedDesc.length) return 0;

  const idx = Math.max(0, Math.round(depth) - 1);
  const lo = Math.max(0, idx - 1);
  const hi = Math.min(sortedDesc.length - 1, idx + 1);

  let sum = 0;
  let n = 0;
  for (let i = lo; i <= hi; i++) {
    sum += sortedDesc[i];
    n++;
  }
  return n ? sum / n : sortedDesc[sortedDesc.length - 1];
}

export interface SeasonBreakdown {
  group: PositionGroup;
  /** Projected points over the weeks that remain, byes excluded. */
  restOfSeasonPoints: number | null;
  restOfSeasonPpg: number | null;
  weeksRemaining: number;
  replacementPoints: number;
  vorp: number | null;
  /** Observed points per game so far, null before the player has played. */
  currentPpg: number | null;
  games: number;
  projectedOpportunities: number | null;
  /** ESPN auction value, in dollars of a $200 budget. */
  auctionValue: number | null;
  averageDraftPosition: number | null;
  marketPositionRank: number | null;
  verdict: MarketVerdict;
  injuryRisk: RiskBand;
  injuryStatus: string | null;
  /** Mean matchup score over the remaining league weeks, including the playoffs. */
  scheduleAhead: number | null;
  efficiency: number | null;
  tier: string;
  contributions: Array<{ label: string; weight: number; normalized: number; points: number }>;
}

export interface SeasonValue {
  pid: string;
  score: number;
  group: PositionGroup;
  breakdown: SeasonBreakdown;
}

export interface SeasonValueIndex {
  byPlayer: Map<string, SeasonValue>;
  replacementByGroup: Map<PositionGroup, number>;
  /** Projected league-wide starters by position, including allocated FLEX seats. */
  startingDepthByGroup: Map<PositionGroup, number>;
}

export interface BuildSeasonValueInput {
  valueIndex: ValueIndex;
  playersById: Map<string, Player>;
  /** pid -> week -> scored projection for that week. */
  weeklyProjections: Map<string, Map<number, number>>;
  /** pid -> week -> projected opportunity volume. */
  weeklyOpportunities: Map<string, Map<number, number>>;
  /** pid -> mean matchup score over remaining weeks (0..100). */
  scheduleAhead?: Map<string, number>;
  rosterSlots: string[];
  numTeams: number;
  /** First week that has not been played. */
  fromWeek: number;
  finalWeek: number;
  /**
   * pid -> how often he has actually been available, over finished seasons.
   *
   * Optional: without it every player is judged on today's injury label alone,
   * which is what the app did before the snapshot carried more than one season.
   */
  durability?: ReadonlyMap<string, number>;
  /**
   * How much the opponent actually moves each position, normalised so the peak
   * is 1 — the league's own measurement, from `priors.json`.
   *
   * Optional, falling back to the compiled `MATCHUP_INFLUENCE`. It has to be an
   * input rather than a constant because it is a property of the *scoring
   * table*, not of football: a league that awards six points a passing
   * touchdown makes the opponent matter roughly twice as much to a quarterback
   * as a four-point league does. Two leagues measured through the same finished
   * seasons come out at QB 0.28 and 0.46, and a shared constant would price one
   * of them wrong.
   */
  influenceByGroup?: Readonly<Record<PositionGroup, number>>;
}

/**
 * How much a player's own durability record is allowed to move his availability.
 *
 * Two things are being combined and they answer different questions. ESPN's
 * injury label describes his condition *today*; a three-season availability
 * record describes how often he is fit *at all*. Over fourteen remaining weeks
 * the second matters and the label alone cannot see it — a back who has missed
 * a third of three seasons and a back who has never missed a snap both read
 * ACTIVE in September, and pricing them identically is a real error the
 * snapshot previously had no data to correct.
 *
 * A third of the weight, because the record is the weaker of the two signals
 * for the *next* game and the stronger one for the fourteen after it, and
 * because a durability figure is itself a small sample: forty-odd weeks is
 * enough to separate a chronic absentee from an iron man and not enough to
 * separate two players a few points apart.
 */
const DURABILITY_WEIGHT = 1 / 3;

/**
 * Availability over the rest of the season, from today's label and his record.
 *
 * ESPN's labels are coarse and the app treats them as such. `OUT` and `IR` are
 * near-total for the coming week but not for the season, which is why neither
 * lands at zero: a player out for one week of fourteen has lost a fourteenth of
 * his remaining value, not all of it.
 *
 * `durability` is his measured share of weeks available across every finished
 * season the snapshot carries, and it is folded in at `DURABILITY_WEIGHT`. The
 * band still comes from the label alone — a chronically fragile player who is
 * fit today is not "High risk" this week, and saying so would misread the chip.
 */
function availabilityFor(
  player: Player | undefined,
  durability?: number,
): { score: number; band: RiskBand } {
  const status = (player?.injuryStatus ?? 'ACTIVE').toUpperCase();

  const fromLabel = ((): { score: number; band: RiskBand } => {
    switch (status) {
      case 'ACTIVE':
      case 'NORMAL':
        return { score: 1, band: 'Low' };
      case 'QUESTIONABLE':
        return { score: 0.85, band: 'Moderate' };
      case 'DOUBTFUL':
        return { score: 0.55, band: 'High' };
      case 'OUT':
        return { score: 0.35, band: 'High' };
      case 'INJURY_RESERVE':
      case 'IR':
      case 'SUSPENSION':
        return { score: 0.15, band: 'High' };
      default:
        return { score: 0.9, band: 'Low' };
    }
  })();

  if (durability === undefined || !Number.isFinite(durability)) return fromLabel;

  return {
    score: clamp01(
      fromLabel.score * (1 - DURABILITY_WEIGHT) + durability * DURABILITY_WEIGHT,
    ),
    band: fromLabel.band,
  };
}

function tierFor(score: number): string {
  if (score >= 850) return 'League winner';
  if (score >= 700) return 'Every-week starter';
  if (score >= 550) return 'Solid starter';
  if (score >= 400) return 'Flex / matchup play';
  if (score >= 250) return 'Bench depth';
  return 'Waiver fodder';
}

/**
 * Buy / Sell / Fair, from two ranks over the same population.
 *
 * `intrinsicRank` is where this model puts the player among the priced players
 * at his position; `marketRank` is where ESPN's drafters put him among the very
 * same set. A gap between two percentiles built the same way over the same pool
 * is a real disagreement, which is the only thing the verdict claims.
 */
export function verdictFor(
  auctionValue: number | null,
  intrinsicRank: number | null,
  marketRank: number | null,
  hasRead: boolean,
): MarketVerdict {
  if (auctionValue === null || intrinsicRank === null || marketRank === null) {
    return 'No market';
  }
  if (marketRank < VERDICT_MIN_LIQUIDITY) return 'Thin market';
  /*
   * Without either production or a projection the intrinsic side is a fixed low
   * prior rather than an opinion, and a prior can only ever open a gap in one
   * direction. Calling that a sell dresses an absence of evidence up as
   * disagreement, so it abstains instead.
   */
  if (!hasRead) return 'No read';

  const gap = intrinsicRank - marketRank;
  if (gap > VERDICT_GAP) return 'Buy';
  if (gap < -VERDICT_GAP) return 'Sell';
  return 'Fair';
}

export function buildSeasonValueIndex(input: BuildSeasonValueInput): SeasonValueIndex {
  const {
    valueIndex,
    playersById,
    weeklyProjections,
    weeklyOpportunities,
    scheduleAhead,
    rosterSlots,
    numTeams,
    fromWeek,
    finalWeek,
    influenceByGroup = MATCHUP_INFLUENCE,
  } = input;

  interface Row {
    pid: string;
    group: PositionGroup;
    restPoints: number | null;
    restPpg: number | null;
    weeksRemaining: number;
    vorp: number | null;
    currentPpg: number | null;
    games: number;
    opportunities: number | null;
    auction: number | null;
    adp: number | null;
    availability: number;
    band: RiskBand;
    schedule: number | null;
    efficiency: number | null;
    hasRead: boolean;
  }

  const rows: Row[] = [];

  for (const [pid, player] of playersById) {
    const group = player.group;
    if (!group) continue;

    // Rest-of-season projection: the weeks that remain, summed. A bye week has
    // no projection block at all, so it contributes nothing and is not counted
    // against the player's per-week rate either.
    const weekly = weeklyProjections.get(pid);
    let restPoints: number | null = null;
    let weeksRemaining = 0;

    if (weekly) {
      let sum = 0;
      for (let week = fromWeek; week <= finalWeek; week++) {
        const value = weekly.get(week);
        if (value === undefined) continue;
        sum += value;
        weeksRemaining++;
      }
      if (weeksRemaining > 0) restPoints = sum;
    }

    const opportunities = (() => {
      const byWeek = weeklyOpportunities.get(pid);
      if (!byWeek) return null;
      let sum = 0;
      let n = 0;
      for (let week = fromWeek; week <= finalWeek; week++) {
        const value = byWeek.get(week);
        if (value === undefined) continue;
        sum += value;
        n++;
      }
      return n > 0 ? sum / n : null;
    })();

    const value = valueIndex.byPlayer.get(pid);
    const games = value?.breakdown.games ?? 0;
    const { score: availability, band } = availabilityFor(player, input.durability?.get(pid));

    rows.push({
      pid,
      group,
      restPoints,
      restPpg: restPoints !== null && weeksRemaining > 0 ? restPoints / weeksRemaining : null,
      weeksRemaining,
      vorp: null,
      currentPpg: value?.breakdown.ppg ?? null,
      games,
      opportunities,
      auction:
        typeof player.auctionValueAverage === 'number' && player.auctionValueAverage > 0
          ? player.auctionValueAverage
          : null,
      adp: player.averageDraftPosition ?? null,
      availability,
      band,
      schedule: scheduleAhead?.get(pid) ?? null,
      efficiency: value?.breakdown.efficiency ?? null,
      // A read means the model has something of its own to say: either observed
      // production or a real projection. Without one it is quoting a prior.
      hasRead: games > 0 || restPoints !== null,
    });
  }

  // --- Replacement level, per group ---------------------------------------
  // Measured against rest-of-season points so it moves with the same clock the
  // valuation does: in week 12 replacement level is what a waiver pickup gives
  // you over six weeks, not over a season.
  const byGroup = new Map<PositionGroup, Row[]>();
  for (const row of rows) {
    const list = byGroup.get(row.group);
    if (list) list.push(row);
    else byGroup.set(row.group, [row]);
  }

  const depth = startingDepthByGroup(
    rosterSlots,
    numTeams,
    rows.flatMap((row) => row.restPoints === null ? [] : [{ group: row.group, points: row.restPoints }]),
  );
  const replacementByGroup = new Map<PositionGroup, number>();
  for (const [group, list] of byGroup) {
    const sorted = list
      .map((r) => r.restPoints)
      .filter((p): p is number => p !== null)
      .sort((a, b) => b - a);
    const level = replacementPoints(sorted, depth.get(group) ?? list.length);
    replacementByGroup.set(group, level);

    for (const row of list) {
      row.vorp = row.restPoints === null ? null : row.restPoints - level;
    }
  }

  // --- Score ---------------------------------------------------------------
  const byPlayer = new Map<string, SeasonValue>();

  for (const [group, list] of byGroup) {
    const pct = (pick: (r: Row) => number | null) =>
      percentileRanks(
        list
          .filter((r) => pick(r) !== null)
          .map((r) => ({ id: r.pid, value: pick(r) as number })),
      );

    const pVorp = pct((r) => r.vorp);
    const pRole = pct((r) => r.opportunities);
    const pForm = pct((r) => r.currentPpg);
    const pSchedule = pct((r) => r.schedule);
    const pEff = pct((r) => r.efficiency);

    // The market leg, and the pool the verdict is judged over, are the priced
    // players only — see the note on VERDICT_GAP.
    const priced = list.filter((r) => r.auction !== null);
    const pMarketPriced = percentileRanks(
      priced.map((r) => ({ id: r.pid, value: r.auction as number })),
    );
    const pIntrinsicPriced = percentileRanks(
      priced
        .filter((r) => r.vorp !== null)
        .map((r) => ({ id: r.pid, value: r.vorp as number })),
    );
    // Unpriced players still need a market leg for the score itself; a neutral
    // 0.5 says "no information", which is what an absent price is.
    const pMarketAll = pct((r) => r.auction);

    for (const row of list) {
      /*
       * Form only enters once there is form. Before week one every player would
       * otherwise carry the same neutral 0.5, which is harmless, but through
       * the first few weeks a two-game sample would swing a season-long
       * valuation far more than two games deserve. The leg fades in over four
       * games and its unused weight goes to the projection, which is the better
       * estimate of the rest of the season precisely while the sample is thin.
       */
      const formConfidence = clamp01(row.games / 4);
      const formWeight = SEASON_WEIGHTS.form * formConfidence;
      // Historical holdouts show schedule matters far more for D/ST than RB.
      // Scale that leg by the measured positional influence and return unused
      // weight to the projection instead of pretending every position is equal.
      const scheduleWeight = SEASON_WEIGHTS.schedule * influenceByGroup[group];
      const vorpWeight =
        SEASON_WEIGHTS.vorp +
        (SEASON_WEIGHTS.form - formWeight) +
        (SEASON_WEIGHTS.schedule - scheduleWeight);

      const terms: Array<[string, number, number]> = [
        ['Rest-of-season VORP', vorpWeight, pVorp.get(row.pid) ?? 0.5],
        ['Draft market', SEASON_WEIGHTS.market, pMarketAll.get(row.pid) ?? 0.5],
        ['Projected role', SEASON_WEIGHTS.role, pRole.get(row.pid) ?? 0.5],
        ['Current form', formWeight, pForm.get(row.pid) ?? 0.5],
        ['Availability', SEASON_WEIGHTS.availability, row.availability],
        ['Schedule ahead', scheduleWeight, pSchedule.get(row.pid) ?? 0.5],
        ['Efficiency', SEASON_WEIGHTS.efficiency, pEff.get(row.pid) ?? 0.5],
      ];

      let raw = 0;
      const contributions = terms.map(([label, weight, normalized]) => {
        const points = weight * normalized;
        raw += points;
        return { label, weight, normalized, points };
      });

      const score = Math.round(clamp01(raw) * 1000);
      const marketRank = pMarketPriced.get(row.pid) ?? null;
      const intrinsicRank = pIntrinsicPriced.get(row.pid) ?? null;

      byPlayer.set(row.pid, {
        pid: row.pid,
        score,
        group,
        breakdown: {
          group,
          restOfSeasonPoints: row.restPoints === null ? null : round(row.restPoints, 1),
          restOfSeasonPpg: row.restPpg === null ? null : round(row.restPpg, 2),
          weeksRemaining: row.weeksRemaining,
          replacementPoints: round(replacementByGroup.get(group) ?? 0, 1),
          vorp: row.vorp === null ? null : round(row.vorp, 1),
          currentPpg: row.currentPpg === null ? null : round(row.currentPpg, 2),
          games: row.games,
          projectedOpportunities:
            row.opportunities === null ? null : round(row.opportunities, 1),
          auctionValue: row.auction,
          averageDraftPosition: row.adp,
          marketPositionRank: marketRank === null ? null : round(marketRank, 3),
          verdict: verdictFor(row.auction, intrinsicRank, marketRank, row.hasRead),
          injuryRisk: row.band,
          injuryStatus: playersById.get(row.pid)?.injuryStatus ?? null,
          scheduleAhead: row.schedule === null ? null : round(row.schedule, 1),
          efficiency: row.efficiency === null ? null : round(row.efficiency, 3),
          tier: tierFor(score),
          contributions,
        },
      });
    }
  }

  return { byPlayer, replacementByGroup, startingDepthByGroup: depth };
}
