/**
 * Trade value — the one place in this app where players are compared *across*
 * positions.
 *
 * Everything else here is deliberately within-position. The headline Value
 * Score is an average of percentiles inside a player's own group, which is the
 * right shape for "is he a good tight end" and the wrong shape for every
 * question a trade asks. On the shipped snapshot the top tight end scores 980
 * and the top kicker 971, against 978 for the best running back in the league —
 * a currency in which a $5 kicker and a $70 running back are the same asset.
 * Summing that across a two-for-one would not be approximately right, it would
 * be meaningless.
 *
 * So trades are priced in **points**, and only in points.
 *
 *   Trade Points (TP) = Σ over the weeks that remain of
 *                       E[max(0, score_w − replacement_w)] × availability
 *
 * Three properties come out of that shape rather than being asserted:
 *
 *  - **Positional scarcity is already inside it.** Replacement level is set
 *    from the league's own lineup card, so the baseline a quarterback is
 *    measured against is QB8-ish in an eight-team league and the baseline a
 *    receiver is measured against is WR20-ish. The reason an elite kicker is
 *    worth a fraction of an elite running back is that the kicker you can have
 *    for nothing is nearly as good, and that fact is in the number.
 *
 *  - **A bye costs nothing.** A week with no projection contributes zero, not a
 *    negative, because a roster spot always fields *somebody* — the replacement
 *    player, who is exactly what the baseline is made of.
 *
 *  - **A bad week costs nothing either.** The floor at zero is the same
 *    argument: you bench him. Subtracting a season-level replacement from a
 *    season-level total, which is what `season-value.ts` does for its own
 *    purposes, quietly charges a player for weeks he would never be started in.
 *
 * ## Why the floor is an expectation and not a `max`
 *
 * Flooring the *projection* — `max(0, p − r)` — was the first version and it is
 * wrong in a way that matters here. It prices every player whose point estimate
 * sits below the cliff at exactly zero, and on the shipped snapshot that was
 * 371 of 498 projected players, tied. Among them: DJ Moore at $12 of ESPN's
 * auction market, Bucky Irving at $15, David Montgomery at $12. Real, tradeable
 * players, all indistinguishable from a deactivated third-string kicker. It
 * showed up as rank correlation against ESPN's own cross-positional market
 * falling to 0.70, against 0.75 for the season model it was meant to improve on.
 *
 * What those players are worth is the chance the picture changes. A receiver
 * projected 10.5 against a 13.1 cliff is not startable *today*; he is startable
 * in the weeks when a target ahead of him goes down, or the offence turns over,
 * or he simply gets re-projected. Over fourteen weeks that happens often enough
 * to be most of what a bench player is. So the weekly term is the expected
 * value of the start decision — the option to start him, priced.
 *
 * ## The spread that belongs in it is not the outcome spread
 *
 * The first instinct is to use the app's fitted weekly scale from
 * `forecast.ts`, and it is the wrong distribution. That measures how far a
 * *result* lands from its projection, and the lineup decision is made before
 * the result. Using it credits a player for variance nobody can act on, and it
 * shows: kickers priced out at 30% of the best running back against a market
 * that pays 7%, because kicker scores are noisy even though kicker *forecasts*
 * barely move.
 *
 * The uncertainty a manager can act on is how much the projection itself will
 * move between now and that week. Measured on the prior season, as the spread
 * of a player's realised weekly level around what he was projected for
 * preseason: QB 5.4, WR 4.1, RB 4.1, K 2.8, TE 2.7, DST 2.2 points a week. Both
 * the player and the alternative drift, and the decision compares them, so the
 * spread entering the option is `drift × √2`.
 *
 * ## And the option only exists where there is a bench to rotate
 *
 * A start decision needs two players to choose between. This league rosters
 * about 4.6 running backs and 5.5 receivers a team against 1.1 kickers and 1.1
 * defences — nobody carries a backup kicker, so the kicker you drafted is the
 * kicker you start, every week, and there is no option to price. That ratio is
 * read off the real rosters rather than assumed, and it scales the spread.
 *
 * Together those two put the model at 0.93 rank agreement with ESPN's auction
 * market across positions, against 0.75 for the season value model and 0.74 for
 * the headline Value Score, and put its positional ratios within a few points
 * of the market's at RB, WR and TE.
 *
 * ## What it still gets wrong, and does not hide
 *
 * Kickers and defences come out at roughly twice what the market pays — 17% and
 * 13% of the best running back against the 7% and 6% ESPN's auction charges.
 *
 * The reason is measured alongside the drift. Regress a realised weekly level on
 * the projection that preceded it and the slope says how much of a projected gap
 * survives; the correlation says whether the projection was telling you anything
 * in the first place. On 2025 those come out:
 *
 *     RB  .75 / r .77     TE  .72 / r .76     WR  .58 / r .68
 *     DST .58 / r .38     QB  .54 / r .54     K   .43 / r .25
 *
 * A kicker's r of .25 on 34 players is about 1.4 standard errors from zero —
 * ESPN's kicker projections cannot be shown to forecast anything, and a defence
 * at .38 is barely better. So the gap this model prices between the best kicker
 * and a replacement one is a gap in a number that does not predict.
 *
 * Shrinking every position by its slope was tried, and it is the obvious fix:
 * it pulls kicker from 17% to 10% of a running back and defence from 13% to
 * 10%, both much closer to the market. It is not applied, because it costs more
 * elsewhere than it returns there — overall rank agreement against the market
 * falls from 0.93 to 0.89, and receivers, whose slope is the noisiest of the
 * three big groups, get cut to 80% of a running back against a market that pays
 * 89%. Trading a defensible number at four positions for a better one at two is
 * the wrong trade.
 *
 * So the reliability is reported instead, and the page prints the warning on the
 * positions that earn it. That is the same choice the matchup chip already
 * makes: dim the number and say why, rather than quietly rescale everything on
 * an estimate too noisy to carry the weight.
 *
 * TP is additive and proportional. Two players worth 40 TP are worth the same
 * as one worth 80, *as points* — which is the claim a trade evaluator has to be
 * able to make and the claim a percentile cannot.
 *
 * ## Why that is still not the whole answer
 *
 * Additive points assume every point lands in a starting lineup, and nine of
 * sixteen roster spots score. A third elite receiver on a roster that already
 * has two is worth his TP to the *league* and much less to that *team*.
 *
 * That is not something to correct with a multiplier. `rosterImpact` answers it
 * exactly instead: it replays the remaining schedule for both rosters, before
 * and after, filling each week with the best legal lineup via the app's own
 * matching solver, and reports the difference in projected points. Surplus,
 * bye-week collisions and the two-for-one roster squeeze all fall out of it
 * without a single tuned constant.
 *
 * The market view answers "who won the trade". The roster view answers "should
 * I do it". They are different questions and the page shows both.
 */

import type { PriorPair } from './forecast';
import { computeOptimalLineup, starterSlots, type LineupCandidate } from './optimal';
import { round, stdev } from './stats';
import { POSITION_GROUPS, type Player, type PositionGroup } from './types';

/** Standard normal density. */
function phi(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF, via Abramowitz & Stegun 7.1.26 on `erf`.
 *
 * Accurate to about 1.5e-7, which is several orders of magnitude finer than the
 * projections going into it.
 */
function Phi(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * `E[max(0, X − strike)]` for `X ~ Normal(mean, sd)`.
 *
 * The expected points a player adds in a week he is only started when he beats
 * the alternative. Degenerates to `max(0, mean − strike)` when `sd` is zero.
 */
export function expectedExcess(mean: number, sd: number, strike: number): number {
  const edge = mean - strike;
  if (!(sd > 0)) return Math.max(0, edge);
  const z = edge / sd;
  return edge * Phi(z) + sd * phi(z);
}

/**
 * How a FLEX slot divides across the groups eligible for it.
 *
 * Mirrors `season-value.ts` deliberately: the two replacement levels should not
 * disagree about where the startable cliff is just because they were written in
 * different files.
 */
const FLEX_SPLIT: Record<string, Partial<Record<PositionGroup, number>>> = {
  FLEX: { RB: 0.4, WR: 0.45, TE: 0.15 },
};

const SLOT_TO_GROUP: Record<string, PositionGroup> = {
  QB: 'QB',
  RB: 'RB',
  WR: 'WR',
  TE: 'TE',
  K: 'K',
  'D/ST': 'DST',
};

/**
 * Injury status → the share of the remaining season the player is expected to
 * be available for.
 *
 * Same ladder as `season-value.ts`. `OUT` is not zero because it is a statement
 * about one week out of the fourteen this number covers.
 */
function availabilityFor(player: Player | undefined): number {
  switch ((player?.injuryStatus ?? 'ACTIVE').toUpperCase()) {
    case 'ACTIVE':
    case 'NORMAL':
      return 1;
    case 'QUESTIONABLE':
      return 0.92;
    case 'DOUBTFUL':
      return 0.7;
    case 'OUT':
      return 0.6;
    case 'INJURY_RESERVE':
    case 'IR':
    case 'SUSPENSION':
      return 0.25;
    default:
      return 0.95;
  }
}

/**
 * Fallback drift, in points per week, when there is no prior season to measure.
 *
 * These are the 2025 figures the model was developed against. They are a
 * starting point and nothing more — `measureDrift` replaces them wholesale the
 * moment it has pairs of its own.
 */
const DEFAULT_DRIFT: Record<PositionGroup, number> = {
  QB: 5.4,
  RB: 4.1,
  WR: 4.1,
  TE: 2.7,
  K: 2.8,
  DST: 2.2,
};

export interface DriftFit {
  group: PositionGroup;
  /** Players the fit is built from. */
  samples: number;
  /** sd of (realised weekly level − preseason per-week projection). */
  drift: number;
  /**
   * Slope of realised level regressed on projected level.
   *
   * 1.0 means a projected gap shows up in full; 0 means the projection carries
   * no information about where a player actually lands. Reported, never
   * applied — see the note in the module header.
   */
  reliability: number;
  /**
   * Correlation between projected and realised level.
   *
   * The slope says how big the relationship is, this says whether there is one.
   * They come apart exactly where it matters: a kicker's slope of .43 looks
   * usable until the correlation of .25 on 34 players says it is a slope
   * through noise.
   */
  correlation: number;
  measured: boolean;
}

/**
 * How far a player's realised weekly level lands from what he was projected for,
 * and how much of a projected gap survives into results.
 *
 * Built from the same prior-season pairs `forecast.ts` bootstraps its spread
 * from, grouped back up to one row per player: a player's *level* is the thing
 * a projection is trying to call, and a single week is not one.
 */
export function measureDrift(
  priorPairs: Map<PositionGroup, PriorPair[]> | undefined,
  minSamples = 8,
): Map<PositionGroup, DriftFit> {
  const out = new Map<PositionGroup, DriftFit>();

  for (const group of POSITION_GROUPS) {
    const pairs = priorPairs?.get(group) ?? [];

    // One row per player: his projected per-week level against what he did.
    const byPlayer = new Map<string, { projection: number; sum: number; n: number }>();
    for (const pair of pairs) {
      const row = byPlayer.get(pair.pid) ?? { projection: pair.projection, sum: 0, n: 0 };
      row.sum += pair.actual;
      row.n++;
      byPlayer.set(pair.pid, row);
    }

    const rows = [...byPlayer.values()]
      .filter((r) => r.n >= 6 && r.projection >= 1)
      .map((r) => ({ p: r.projection, a: r.sum / r.n }));

    if (rows.length < minSamples) {
      out.set(group, {
        group,
        samples: rows.length,
        drift: DEFAULT_DRIFT[group],
        reliability: 1,
        correlation: 1,
        measured: false,
      });
      continue;
    }

    const drift = stdev(rows.map((r) => r.a - r.p));

    const n = rows.length;
    const mp = rows.reduce((s, r) => s + r.p, 0) / n;
    const ma = rows.reduce((s, r) => s + r.a, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const r of rows) {
      sxy += (r.p - mp) * (r.a - ma);
      sxx += (r.p - mp) ** 2;
      syy += (r.a - ma) ** 2;
    }

    out.set(group, {
      group,
      samples: n,
      drift: drift > 0 ? drift : DEFAULT_DRIFT[group],
      reliability: sxx > 0 ? sxy / sxx : 1,
      correlation: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 1,
      measured: true,
    });
  }

  return out;
}

/** How many of each group the whole league starts in a week. */
export function startingSlotsByGroup(
  rosterSlots: string[],
  numTeams: number,
): Map<PositionGroup, number> {
  const perTeam = new Map<PositionGroup, number>();
  const add = (group: PositionGroup, n: number) =>
    perTeam.set(group, (perTeam.get(group) ?? 0) + n);

  for (const raw of rosterSlots) {
    const slot = String(raw).toUpperCase();
    if (slot === 'BN' || slot === 'IR') continue;
    const direct = SLOT_TO_GROUP[slot];
    if (direct) {
      add(direct, 1);
      continue;
    }
    for (const [group, share] of Object.entries(FLEX_SPLIT[slot] ?? {})) {
      add(group as PositionGroup, share ?? 0);
    }
  }

  const out = new Map<PositionGroup, number>();
  for (const [group, n] of perTeam) out.set(group, n * numTeams);
  return out;
}

export interface TradeValue {
  pid: string;
  group: PositionGroup;
  /** Points above the startable replacement over the weeks that remain. */
  points: number;
  /** Points above the best player actually available on waivers. */
  pointsOverWaiver: number;
  /** `points` on a 0–100 scale where the league's most valuable player is 100. */
  index: number;
  /** Raw projected points over the same weeks, before any baseline. */
  projectedPoints: number;
  /** Weeks in the window that carry a projection — the player's bye is not one. */
  weeksProjected: number;
  /** Per-week points of the startable replacement at this position. */
  replacementPerWeek: number;
  availability: number;
  injuryStatus: string | null;
  /** ESPN auction value, kept for a sanity column, never fed into `points`. */
  auctionValue: number | null;
  /** True when nothing but a prior stands behind the number. */
  unprojected: boolean;
}

export interface TradeValueIndex {
  byPlayer: Map<string, TradeValue>;
  /** Startable-cliff replacement, per week, by position. */
  replacementPerWeek: Map<PositionGroup, number>;
  /** Best freely available player's per-week points, by position. */
  waiverPerWeek: Map<PositionGroup, number>;
  /** Measured projection drift and reliability, by position. */
  driftByGroup: ReadonlyMap<PositionGroup, DriftFit>;
  /**
   * How much of a real start decision exists at each position, 0..1.
   *
   * Read off the league's own rosters as surplus bodies per team over the slots
   * it starts. Near 1 for running backs and receivers, near 0 for kicker and
   * defence, which is why the option term does nothing for those two.
   */
  optionWeightByGroup: Map<PositionGroup, number>;
  /** Points behind an index of 100. */
  pointsAtIndex100: number;
  fromWeek: number;
  finalWeek: number;
}

export interface BuildTradeValuesInput {
  playersById: Map<string, Player>;
  /** pid → week → scored projection. */
  weeklyProjections: Map<string, Map<number, number>>;
  /** Every player id currently on somebody's roster. */
  rosteredIds: Set<string>;
  rosterSlots: string[];
  numTeams: number;
  /** First week that has not been played. */
  fromWeek: number;
  finalWeek: number;
  /**
   * Prior-season (projection, actual) pairs — the same ones `forecast.ts`
   * bootstraps on. Drift and reliability are measured from these; without them
   * the model falls back to the 2025 figures it was developed against.
   */
  priorPairs?: Map<PositionGroup, PriorPair[]>;
  /**
   * Drift and reliability measured offline over every finished season, which
   * takes precedence over `priorPairs` wherever it exists.
   *
   * Two things make it better than measuring here. It has three seasons of real
   * weekly projections rather than one prorated season — roughly three times
   * the players at each position, which matters most at kicker and D/ST where
   * the whole question is whether a near-zero correlation is real. And it is
   * measured **forward**: only projections published in the season's opening
   * weeks count, against the level the player went on to score.
   *
   * That second point is not a refinement. Regressing a season's actuals on the
   * average of that same season's weekly projections returns .93–.95 at every
   * skill position, which is close to a tautology — week 10's projection has
   * already seen weeks 1 through 9 — and would tell the Trade page that every
   * projected gap is real when the page's whole job is pricing weeks that have
   * not happened yet.
   */
  driftByGroup?: ReadonlyMap<PositionGroup, DriftFit>;
}

/**
 * The per-week rate of the player sitting at a given depth on the ladder.
 *
 * Averaged over a three-deep band so one outlier cannot set the baseline for a
 * whole position, and expressed per active week rather than per season week so
 * that a replacement's own bye does not deflate the line everybody else is
 * measured against.
 */
function rateAtDepth(
  ladder: Array<{ pointsPerWeek: number }>,
  depth: number,
): number {
  if (!ladder.length) return 0;
  const idx = Math.max(0, Math.min(ladder.length - 1, Math.round(depth) - 1));
  const lo = Math.max(0, idx - 1);
  const hi = Math.min(ladder.length - 1, idx + 1);

  let sum = 0;
  let n = 0;
  for (let i = lo; i <= hi; i++) {
    sum += ladder[i].pointsPerWeek;
    n++;
  }
  return n ? sum / n : 0;
}

export function buildTradeValues(input: BuildTradeValuesInput): TradeValueIndex {
  const {
    playersById,
    weeklyProjections,
    rosteredIds,
    rosterSlots,
    numTeams,
    fromWeek,
    finalWeek,
    priorPairs,
  } = input;

  const slots = startingSlotsByGroup(rosterSlots, numTeams);
  const driftByGroup = input.driftByGroup ?? measureDrift(priorPairs);

  /*
   * How much of a start decision each position actually offers, measured off
   * the real rosters: bodies held per team beyond the slots the league starts.
   * Kicker and defence land near zero because nobody carries a second one, and
   * a position you start unconditionally has no option to price.
   */
  const rosteredByGroup = new Map<PositionGroup, number>();
  for (const pid of rosteredIds) {
    const group = playersById.get(pid)?.group;
    if (group) rosteredByGroup.set(group, (rosteredByGroup.get(group) ?? 0) + 1);
  }

  const optionWeightByGroup = new Map<PositionGroup, number>();
  for (const group of POSITION_GROUPS) {
    const surplus = (rosteredByGroup.get(group) ?? 0) - (slots.get(group) ?? 0);
    optionWeightByGroup.set(group, Math.max(0, Math.min(1, surplus / Math.max(1, numTeams))));
  }

  /**
   * Spread of the start decision at this position.
   *
   * Both the player and the alternative drift between now and the week in
   * question, and the decision compares the two, so their independent drifts
   * combine as `√2 × drift`. Scaled by how much of a decision there is at all.
   */
  const decisionSpread = (group: PositionGroup): number =>
    (optionWeightByGroup.get(group) ?? 0) *
    (driftByGroup.get(group)?.drift ?? 0) *
    Math.SQRT2;

  interface Row {
    pid: string;
    group: PositionGroup;
    weeks: Map<number, number>;
    projectedPoints: number;
    weeksProjected: number;
    pointsPerWeek: number;
    availability: number;
  }

  const rows: Row[] = [];
  for (const [pid, player] of playersById) {
    const group = player.group;
    if (!group) continue;

    const weekly = weeklyProjections.get(pid);
    const weeks = new Map<number, number>();
    let sum = 0;
    if (weekly) {
      for (let week = fromWeek; week <= finalWeek; week++) {
        const value = weekly.get(week);
        if (value === undefined) continue;
        weeks.set(week, value);
        sum += value;
      }
    }

    rows.push({
      pid,
      group,
      weeks,
      projectedPoints: sum,
      weeksProjected: weeks.size,
      pointsPerWeek: weeks.size ? sum / weeks.size : 0,
      availability: availabilityFor(player),
    });
  }

  // ---- Two baselines per position -----------------------------------------
  const byGroup = new Map<PositionGroup, Row[]>();
  for (const row of rows) {
    const list = byGroup.get(row.group);
    if (list) list.push(row);
    else byGroup.set(row.group, [row]);
  }

  const replacementPerWeek = new Map<PositionGroup, number>();
  const waiverPerWeek = new Map<PositionGroup, number>();

  for (const group of POSITION_GROUPS) {
    const list = (byGroup.get(group) ?? []).filter((r) => r.weeksProjected > 0);
    const ladder = [...list].sort((a, b) => b.pointsPerWeek - a.pointsPerWeek);
    replacementPerWeek.set(group, rateAtDepth(ladder, slots.get(group) ?? ladder.length));

    /*
     * The waiver line is the honest answer to "what do I actually field if I
     * lose him", and in an eight-team league it sits a long way below the
     * startable cliff — 128 rostered players against a universe of a thousand.
     * It is reported rather than used as the primary baseline, because a trade
     * is a question about starting lineups and the cliff is where the starting
     * lineup ends.
     */
    const free = ladder.filter((r) => !rosteredIds.has(r.pid));
    waiverPerWeek.set(group, free.length ? rateAtDepth(free, 1) : 0);
  }

  // ---- Price every player against both -------------------------------------
  const byPlayer = new Map<string, TradeValue>();
  let peak = 0;

  for (const row of rows) {
    const repl = replacementPerWeek.get(row.group) ?? 0;
    const waiver = waiverPerWeek.get(row.group) ?? 0;

    const sd = decisionSpread(row.group);
    let above = 0;
    let aboveWaiver = 0;
    for (const value of row.weeks.values()) {
      above += expectedExcess(value, sd, repl);
      aboveWaiver += expectedExcess(value, sd, waiver);
    }

    const points = above * row.availability;
    if (points > peak) peak = points;

    const player = playersById.get(row.pid);
    byPlayer.set(row.pid, {
      pid: row.pid,
      group: row.group,
      points: round(points, 1),
      pointsOverWaiver: round(aboveWaiver * row.availability, 1),
      index: 0,
      projectedPoints: round(row.projectedPoints, 1),
      weeksProjected: row.weeksProjected,
      replacementPerWeek: round(repl, 2),
      availability: row.availability,
      injuryStatus: player?.injuryStatus ?? null,
      auctionValue:
        typeof player?.auctionValueAverage === 'number' && player.auctionValueAverage > 0
          ? player.auctionValueAverage
          : null,
      unprojected: row.weeksProjected === 0,
    });
  }

  /*
   * A linear index, not a percentile.
   *
   * The whole point of this module is a currency you can add up, and a
   * percentile is not one: the gap between the 99th and 95th percentile player
   * is worth many times the gap between the 55th and 51st. Dividing by the
   * league's most valuable player keeps 50 meaning "half of the best player",
   * which is the only reading under which two 40s balance an 80.
   */
  for (const value of byPlayer.values()) {
    value.index = peak > 0 ? round((value.points / peak) * 100, 1) : 0;
  }

  return {
    byPlayer,
    replacementPerWeek,
    waiverPerWeek,
    driftByGroup,
    optionWeightByGroup,
    pointsAtIndex100: round(peak, 1),
    fromWeek,
    finalWeek,
  };
}

// ---------------------------------------------------------------- verdict --

export type TradeVerdict = 'Even' | 'Slight edge' | 'Clear win' | 'Lopsided';

export interface TradeSide {
  /** Players leaving this side of the table. */
  pids: string[];
  points: number;
  index: number;
  count: number;
}

export interface TradeSummary {
  /** What team A receives (i.e. what B sends). */
  aReceives: TradeSide;
  bReceives: TradeSide;
  /** Positive means A gains points. */
  netPoints: number;
  netPerWeek: number;
  /** Share of the larger side's value that the gap represents, 0..1. */
  gapShare: number;
  verdict: TradeVerdict;
  favors: 'A' | 'B' | null;
  /** The best single player in the deal, and which side receives him. */
  bestPlayer: { pid: string; points: number; to: 'A' | 'B' } | null;
  weeksRemaining: number;
}

/**
 * Where a gap stops being noise.
 *
 * Expressed per week rather than per season, because that is the scale a
 * fantasy manager can actually calibrate against: a fifth of a point a week is
 * indistinguishable from projection error, two points a week is a starter.
 */
const EVEN_PER_WEEK = 0.75;
const SLIGHT_PER_WEEK = 2;
const CLEAR_PER_WEEK = 5;

function sideOf(pids: string[], values: TradeValueIndex): TradeSide {
  let points = 0;
  let index = 0;
  for (const pid of pids) {
    const v = values.byPlayer.get(pid);
    if (!v) continue;
    points += v.points;
    index += v.index;
  }
  return { pids, points: round(points, 1), index: round(index, 1), count: pids.length };
}

/**
 * Market value of a trade: who gets more points, ignoring both rosters.
 *
 * `aSends` and `bSends` are the players each side gives up, so team A receives
 * `bSends`. Sides may be any size, including uneven.
 */
export function summarizeTrade(
  aSends: string[],
  bSends: string[],
  values: TradeValueIndex,
): TradeSummary {
  const aReceives = sideOf(bSends, values);
  const bReceives = sideOf(aSends, values);

  const netPoints = round(aReceives.points - bReceives.points, 1);
  const weeks = Math.max(1, values.finalWeek - values.fromWeek + 1);
  const netPerWeek = Math.abs(netPoints) / weeks;

  const larger = Math.max(aReceives.points, bReceives.points);
  const gapShare = larger > 0 ? Math.abs(netPoints) / larger : 0;

  let verdict: TradeVerdict = 'Even';
  if (netPerWeek >= CLEAR_PER_WEEK) verdict = 'Lopsided';
  else if (netPerWeek >= SLIGHT_PER_WEEK) verdict = 'Clear win';
  else if (netPerWeek >= EVEN_PER_WEEK) verdict = 'Slight edge';

  let bestPlayer: TradeSummary['bestPlayer'] = null;
  for (const [pids, to] of [
    [bSends, 'A'],
    [aSends, 'B'],
  ] as Array<[string[], 'A' | 'B']>) {
    for (const pid of pids) {
      const v = values.byPlayer.get(pid);
      if (!v) continue;
      if (!bestPlayer || v.points > bestPlayer.points) {
        bestPlayer = { pid, points: v.points, to };
      }
    }
  }

  return {
    aReceives,
    bReceives,
    netPoints,
    netPerWeek: round(netPerWeek, 2),
    gapShare: round(gapShare, 3),
    verdict,
    favors: verdict === 'Even' ? null : netPoints > 0 ? 'A' : 'B',
    bestPlayer,
    weeksRemaining: weeks,
  };
}

// ----------------------------------------------------------- roster impact --

export interface WeekLineupDelta {
  week: number;
  before: number;
  after: number;
}

export interface RosterImpact {
  teamId: number;
  /** Best legal lineup, summed over the remaining weeks, as the roster stands. */
  before: number;
  after: number;
  delta: number;
  deltaPerWeek: number;
  byWeek: WeekLineupDelta[];
  /** Players cut to get back to the roster limit, worst first. */
  dropped: string[];
  /** Free agents added to fill spots the trade opened up. */
  added: string[];
  /** Positions left without enough bodies to fill the lineup card. */
  shortAt: PositionGroup[];
  rosterSizeAfter: number;
}

export interface RosterImpactInput {
  teamId: number;
  playerIds: string[];
  sends: string[];
  receives: string[];
  playersById: Map<string, Player>;
  weeklyProjections: Map<string, Map<number, number>>;
  values: TradeValueIndex;
  /** Unrostered players, best trade value first — the waiver wire. */
  freeAgentPool: string[];
  rosterSlots: string[];
  rosterLimit: number;
  fromWeek: number;
  finalWeek: number;
}

/**
 * The exact effect of a trade on one team's scoring, week by week.
 *
 * Every remaining week is solved independently with the app's own maximum-
 * weight matching, on the projections for that week. That is what makes surplus
 * visible without a surplus term: a third elite receiver simply never gets
 * assigned a slot, so the points he would add to a market valuation do not
 * appear here.
 *
 * Roster mechanics are modelled rather than assumed. A two-for-one leaves the
 * receiving side a body short, so the best free agent joins; the side sending
 * one and receiving two goes over the limit, so its least valuable player is
 * cut. Both are what the league would actually force.
 */
export function rosterImpact(input: RosterImpactInput): RosterImpact {
  const {
    teamId,
    playerIds,
    sends,
    receives,
    playersById,
    weeklyProjections,
    values,
    freeAgentPool,
    rosterSlots,
    rosterLimit,
    fromWeek,
    finalWeek,
  } = input;

  const slots = starterSlots(rosterSlots);
  const sent = new Set(sends);

  const before = [...new Set(playerIds)];
  const kept = before.filter((pid) => !sent.has(pid));
  let after = [...new Set([...kept, ...receives])];

  const pointsFor = (pid: string, week: number): number =>
    weeklyProjections.get(pid)?.get(week) ?? 0;

  const candidates = (pids: string[], week: number): LineupCandidate[] =>
    pids.map((pid) => ({
      pid,
      group: playersById.get(pid)?.group ?? null,
      points: pointsFor(pid, week),
    }));

  /** Best legal lineup for this roster, summed over the weeks that remain. */
  const seasonPoints = (pids: string[]): number => {
    let total = 0;
    for (let week = fromWeek; week <= finalWeek; week++) {
      total += computeOptimalLineup(slots, candidates(pids, week)).total;
    }
    return total;
  };

  /*
   * Roster moves are scored, not guessed.
   *
   * Cutting by trade value alone gets this badly wrong, and the way it fails is
   * instructive: the least valuable player on a roster is almost always the
   * kicker, so a team receiving two players for one would cut its only kicker,
   * leave the K slot empty for fourteen weeks and come out of a trade it won
   * looking like it had lost by eighty points. The same mistake in reverse fills
   * an opened spot with the best free agent in the league regardless of position
   * — a fourth quarterback, who will never start.
   *
   * Both are the same error: a roster move is worth what it does to the lineup,
   * which is the quantity this function already computes. So each candidate move
   * is evaluated by actually making it. The shortlists keep that honest and
   * cheap — six plausible cuts, and the three best free agents at each position
   * — because a nine-slot match over sixteen players costs almost nothing and
   * there is no reason to approximate it.
   */
  const incoming = new Set(receives);

  const dropped: string[] = [];
  while (after.length > rosterLimit) {
    const shortlist = after
      .filter((pid) => !incoming.has(pid))
      .sort(
        (x, y) => (values.byPlayer.get(x)?.points ?? 0) - (values.byPlayer.get(y)?.points ?? 0),
      )
      .slice(0, 6);
    if (!shortlist.length) break;

    let best: string | null = null;
    let bestTotal = -Infinity;
    for (const pid of shortlist) {
      const total = seasonPoints(after.filter((other) => other !== pid));
      if (total > bestTotal) {
        bestTotal = total;
        best = pid;
      }
    }
    if (best === null) break;
    dropped.push(best);
    after = after.filter((pid) => pid !== best);
  }

  const added: string[] = [];
  while (after.length < rosterLimit) {
    const held = new Set(after);
    const perGroup = new Map<PositionGroup, number>();
    const shortlist: string[] = [];
    for (const pid of freeAgentPool) {
      if (held.has(pid)) continue;
      const group = playersById.get(pid)?.group;
      if (!group) continue;
      const seen = perGroup.get(group) ?? 0;
      if (seen >= 3) continue;
      perGroup.set(group, seen + 1);
      shortlist.push(pid);
    }
    if (!shortlist.length) break;

    let best: string | null = null;
    let bestTotal = -Infinity;
    for (const pid of shortlist) {
      const total = seasonPoints([...after, pid]);
      if (total > bestTotal) {
        bestTotal = total;
        best = pid;
      }
    }
    if (best === null) break;
    added.push(best);
    after.push(best);
  }

  let beforeTotal = 0;
  let afterTotal = 0;
  const byWeek: WeekLineupDelta[] = [];

  for (let week = fromWeek; week <= finalWeek; week++) {
    const b = computeOptimalLineup(slots, candidates(before, week)).total;
    const a = computeOptimalLineup(slots, candidates(after, week)).total;
    beforeTotal += b;
    afterTotal += a;
    byWeek.push({ week, before: round(b, 1), after: round(a, 1) });
  }

  // A position is short when the roster cannot fill its dedicated slots.
  const heldByGroup = new Map<PositionGroup, number>();
  for (const pid of after) {
    const group = playersById.get(pid)?.group;
    if (!group) continue;
    heldByGroup.set(group, (heldByGroup.get(group) ?? 0) + 1);
  }
  const required = new Map<PositionGroup, number>();
  for (const raw of slots) {
    const group = SLOT_TO_GROUP[String(raw).toUpperCase()];
    if (group) required.set(group, (required.get(group) ?? 0) + 1);
  }
  const shortAt = [...required]
    .filter(([group, need]) => (heldByGroup.get(group) ?? 0) < need)
    .map(([group]) => group);

  const weeks = Math.max(1, finalWeek - fromWeek + 1);
  const delta = afterTotal - beforeTotal;

  return {
    teamId,
    before: round(beforeTotal, 1),
    after: round(afterTotal, 1),
    delta: round(delta, 1),
    deltaPerWeek: round(delta / weeks, 2),
    byWeek,
    dropped,
    added,
    shortAt,
    rosterSizeAfter: after.length,
  };
}
