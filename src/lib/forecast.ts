/**
 * Weekly player forecasts — as distributions, not point estimates.
 *
 * Every other number in this app is a point estimate. That is fine for "how
 * good is this player", but it is the wrong shape for the two questions a
 * manager actually asks on a Sunday: *what is my floor* and *can I still win*.
 * Both need the spread, and the spread is not something we can assert — it has
 * to be measured against what projections have historically done.
 *
 * So this module fits, per position group, the conditional distribution of a
 * player's real scored result given his projection, using every
 * projected player-week the app has already loaded. Three properties of that
 * distribution matter and all three are measured rather than assumed:
 *
 *  - **It is biased.** Projections are not centred on the outcome. Correcting
 *    that median shift is the cheapest accuracy win available, and it is what
 *    makes our central estimate better than the raw projection we started from.
 *
 *  - **It is heteroskedastic.** A 20-point projection is wrong by more points
 *    than a 5-point projection, so a single leaguewide error bar would be far
 *    too wide at the bottom of a roster and far too narrow at the top. The
 *    scale is fit as a line in the projection level.
 *
 *  - **It is skewed.** Fantasy outcomes are not normal — the upside tail is
 *    much longer than the downside one, because a player's floor is bounded near
 *    zero while his ceiling is a three-touchdown game. Assuming normality would
 *    understate every ceiling and overstate every floor. Instead the shape is
 *    carried as the empirical quantiles of the standardised residual, so
 *    whatever skew and fat-tailedness the real data has survives into the
 *    forecast.
 *
 *  - **It is opponent-aware.** The central estimate is shifted by the player's
 *    position-specific opponent factor, built from schedule-adjusted points and
 *    opportunity allowed. The adjustment strength is measured separately for
 *    each position and capped so matchup noise cannot overwhelm player quality.
 *
 * A fifth property matters only once scores are added up into a team total:
 * players are **correlated**. Two players in the same NFL game share a game
 * script, a pace and a weather report. Treating them as independent is the
 * classic way to build a simulator that is confidently wrong — team-total
 * variance comes out far too low, and every win probability gets pushed toward
 * 0 or 1. The average within-team-week correlation is estimated here and
 * applied in `simulate.ts` through a Gaussian copula, which induces the
 * dependence without disturbing any of the marginal shapes fit above.
 */

import { createScorer, hasPlayed, hasValidProjection, type ScoringModel } from './scoring';
import { clamp, mean, round, stdev } from './stats';
import type { Player, PositionGroup, StatLine } from './types';
import { POSITION_GROUPS } from './types';
import { DEFAULT_BOOM_BUST } from './value';

/**
 * Projections below this are not evidence of anything — they are ESPN's way of
 * listing a player who is not expected to play. Including them would load the
 * fit with thousands of near-zero pairs and drag the fitted intercept down.
 */
const MIN_MEANINGFUL_PROJECTION = 1;

/** Number of quantile knots kept for the standardised-residual shape. */
const SHAPE_KNOTS = 257;

/** Target bin count and minimum bin population for the scale fit. */
const SCALE_BINS = 10;
const MIN_BIN_SAMPLES = 60;

/** Floor on the fitted scale, so a near-zero projection still carries spread. */
const MIN_SCALE = 0.75;

/** Strength of the prior pulling a player's own play rate toward his group's. */
const PLAY_RATE_PRIOR = 4;

/**
 * What a current absence does to a player's availability in a *later* week.
 *
 * Not measured, and said plainly: the snapshot records who is out today, not
 * how long each historical absence lasted, so there is nothing here to fit a
 * recovery curve on. What can be said is that "out this week" and "available in
 * week 12" are not independent, and treating them as independent — which is
 * what ignoring the flag does — is the larger error of the two. A half is a
 * deliberate midpoint between a one-week knock and a season-ending tear.
 */
const OUT_FORWARD_PENALTY = 0.5;

/** Weeks of neutral prior mixed into a player's own projection bias. */
const BIAS_PRIOR = 6;
/** How many recent weeks form the short-window half of the bias estimate. */
const RECENT_BIAS_WEEKS = 3;

/**
 * NFL team-weeks this season needs before it estimates its own correlation.
 *
 * A correlation over a handful of team-weeks is mostly sampling noise, and this
 * particular number is not a diagnostic — it sets the width of every simulated
 * team total, so getting it wrong pushes every win probability toward or away
 * from a coin flip. Thirty-two teams play each week, so this clears after
 * roughly four weeks of football.
 */
const MIN_TEAM_WEEKS_FOR_CORRELATION = 120;

/**
 * Per-player projection-bias correction, by position.
 *
 * Some players are persistently mis-projected, and correcting a player's own
 * gap against his projection is worth real accuracy where the source is crude.
 * Whether it is worth anything *here* is not yet knowable, and every damping
 * below is therefore zero: the correction is wired up and switched off.
 *
 * The reason is a hard limit on what ESPN serves. Fitting a per-player bias
 * needs (projection, actual) pairs, and ESPN publishes weekly projections only
 * for the season in progress — `kona_playercard` returns prior-season game
 * logs, but no prior-season projection to pair them with. There is no historical
 * pair set to fit on, and inventing damping constants without one would be
 * asserting a correction rather than measuring it.
 *
 * The snapshot captures each week's projections before kickoff and its actuals
 * afterwards, so the pairs accumulate from week one of this season onward.
 * `npm run research:forecast` refits these constants from whatever has
 * accumulated and prints the holdout MAE change per position; a group only
 * earns a non-zero damping by improving out of sample.
 *
 * `seasonWeight` splits the estimate between a season-long shrunk bias and a
 * recent-form one, and is inert while damping is zero.
 */
export const BIAS_CORRECTION: Record<
  PositionGroup,
  { seasonWeight: number; damping: number }
> = {
  QB: { seasonWeight: 1, damping: 0 },
  RB: { seasonWeight: 0.5, damping: 0 },
  WR: { seasonWeight: 1, damping: 0 },
  TE: { seasonWeight: 0.75, damping: 0 },
  K: { seasonWeight: 0.5, damping: 0 },
  DST: { seasonWeight: 0.75, damping: 0 },
};

export interface ResidualFit {
  group: PositionGroup;
  /** Projected player-weeks the fit is built from. */
  samples: number;
  /** sd(actual − projected) ≈ scaleIntercept + scaleSlope × projected. */
  scaleIntercept: number;
  scaleSlope: number;
  /**
   * Empirical quantiles of the standardised residual at evenly spaced
   * probabilities, index 0 = minimum, last = maximum. This *is* the shape:
   * skew, kurtosis and all.
   */
  shape: number[];
  /** Median standardised residual — the projection's bias, in scale units. */
  medianZ: number;
  meanZ: number;
  sdZ: number;
  /** Lowest custom score the group has actually recorded; the sampling floor. */
  floor: number;
  /**
   * Mean pairwise correlation among players of *this group* on the same NFL
   * team — two linebackers competing for the same tackles, say. Reported as a
   * diagnostic; the simulator uses the model-level figure instead, for the
   * reason given there.
   */
  withinGroupCorrelation: number;
  /** P(records a stat line | carried a meaningful projection). */
  playRate: number;
  /**
   * True when this fit came from the prior season rather than this one, because
   * this one has not produced enough pairs yet. Surfaced so the app can say so
   * rather than present a borrowed spread as a measured one.
   */
  bootstrapped: boolean;
}

export interface ResidualModel {
  byGroup: Map<PositionGroup, ResidualFit>;
  /**
   * Mean pairwise correlation of standardised residuals among *all* players
   * sharing an NFL team-week, pooled across position groups.
   *
   * Pooled deliberately. Measuring correlation inside a single position group
   * mostly measures nothing: an NFL team fields one quarterback and one kicker,
   * so those groups contain no pairs at all and the estimate collapses to zero.
   * The dependence that actually drives a fantasy team's variance is the shared
   * game environment — pace, script, weather — and that is cross-positional by
   * nature, linking a quarterback to his receivers and to the defence on the
   * other sideline. This is the number the simulator loads onto its shared shock.
   */
  teamCorrelation: number;
  /**
   * Per-player attendance, counted only over weeks the player was actually
   * projected for: `played / projected`.
   *
   * Conditioning on the projection is the whole point. A raw share of season
   * weeks would count every bye as an absence, capping even a player who never
   * misses a snap at about 16/17 — and since a forecast is only ever built for
   * a player who *has* a projection this week, a bye is already excluded by
   * that. Using the unconditional rate would apply the bye haircut a second
   * time and quietly shave every team total by about a tenth.
   */
  playsByPlayer: Map<string, { played: number; projected: number }>;
  /**
   * Each player's own history against his projection, in points: a running sum
   * for the season-long view and the last few weeks for the recent one.
   */
  biasByPlayer: Map<string, { sum: number; n: number; recent: number[] }>;
  /**
   * How often a player is available in a week that was projected before it.
   *
   * `ResidualFit.playRate` is conditioned on carrying a meaningful projection
   * *for that week*, and against real weekly pairs it comes out near 1 — as it
   * should, because a week's final projection is published after the inactive
   * list, so being projected at all already means being active.
   *
   * That is the right number for the live week and the wrong one for every week
   * after it. The rest-of-season simulator projects December in September, from
   * a projection that cannot know about a November hamstring, and giving every
   * player a 99% chance of still being there inflates every remaining-schedule
   * total. Measured over three finished seasons the honest figures are 78% at
   * quarterback and 84–91% across the skill positions; a team defence, which
   * cannot be injured, is 100%.
   *
   * Empty when the snapshot carries no offline fit, in which case the app falls
   * back to the conditional rate exactly as it always did.
   */
  forwardPlayRate: Map<PositionGroup, number>;
  /** pid -> his own record of being there for a week projected in advance. */
  forwardPlaysByPlayer: Map<string, { played: number; projected: number }>;
  /** Weeks the fit was built over. */
  throughWeek: number;
  totalSamples: number;
}

/**
 * A residual model fitted offline over finished seasons.
 *
 * Shipped as a fitted object rather than as the pairs it came from, because the
 * pairs are two orders of magnitude larger: twenty-one thousand weekly
 * observations against six sets of quantile knots. The fit is deterministic and
 * changes only when the snapshot does, so doing it once in Node beats doing it
 * on every phone that opens a lineup.
 *
 * `granularity` is the field that decides how far this can be trusted, and it
 * exists because the answer used to be "not very". A **prorated** fit stood a
 * season projection divided by games in for a weekly one — a real ESPN number
 * at the wrong granularity — which is sound for the *shape* of the spread and
 * unsound for its centre, so a prorated fit teaches no per-player bias. A
 * **weekly** fit is built from the projection ESPN actually published before
 * each kickoff, and carries both.
 */
export interface PriorResidualFit {
  /** Seasons the fit was built over, newest first. */
  seasons: number[];
  granularity: 'weekly' | 'prorated';
  groups: ResidualFit[];
  teamCorrelation: number;
  /** pid -> [weeks he recorded a line, weeks he was projected for]. */
  plays: Record<string, [number, number]>;
  /** pid -> [sum of standardised residuals, weeks], in scale units. */
  bias: Record<string, [number, number]>;
  /**
   * Availability in a week projected *before* it, per group and per player.
   *
   * A separate number from `playRate`, and much lower, because it answers a
   * different question. See `forwardPlayProbability`.
   */
  forwardPlayRate?: Record<string, number>;
  /** pid -> [weeks he was available, later weeks measured]. */
  forwardPlays?: Record<string, [number, number]>;
}

export interface FitResidualModelInput {
  scoringModel: ScoringModel;
  playersById: Map<string, Player>;
  weekStats: Map<number, Record<string, StatLine>>;
  weekProjections: Map<number, Record<string, StatLine>>;
  weekTeams?: Map<number, Record<string, string>>;
  throughWeek: number;
  /**
   * Prior-season (projection, actual) pairs, used only where this season has
   * too few of its own. See `MIN_OWN_SAMPLES` for what they are and are not.
   */
  priorPairs?: Map<PositionGroup, PriorPair[]>;
  /**
   * Each player's prior-season attendance: weeks he recorded a stat line, over
   * weeks he was on a roster to record one.
   *
   * Without this, a bootstrapped fit has no per-player attendance at all and
   * every player falls back to his group's rate — which is pulled down by the
   * hundreds of marginal players who carry a projection and rarely appear. A
   * receiver rostered in every league came out at a 68% chance of playing,
   * which is not a small error: play probability multiplies straight into the
   * mean, so it shaved a fifth off the top of every projected team total and
   * widened every band to match.
   */
  priorPlays?: Map<string, { played: number; projected: number }>;
  /**
   * A fit computed offline over finished seasons, preferred over `priorPairs`
   * wherever both are present. See `PriorResidualFit`.
   */
  priorFit?: PriorResidualFit | null;
}

/** One prior-season observation: what was expected, and what happened. */
export interface PriorPair {
  pid: string;
  projection: number;
  actual: number;
  /** Whether the player recorded real participation, even if he scored zero. */
  played?: boolean;
  week: number;
  team: string;
}

/**
 * Samples a group needs from the season in progress before it stops borrowing.
 *
 * A distribution cannot be asserted, it has to be measured, and in week one
 * there is nothing of this season to measure. Without a fallback the model
 * would carry no fit at all, every forecast would collapse onto its point
 * estimate, and every win probability would come out 0% or 100% — a simulator
 * with no variance reports certainty rather than odds.
 *
 * So the fit bootstraps on last season, with one caveat worth stating plainly.
 * ESPN publishes weekly projections only for the season in progress; for a
 * season that has ended it serves the game logs but not the projections that
 * preceded them, so there is no way to recover what a player was projected for
 * in a given week of it. The stand-in is his prior-season projection spread
 * across the games he was expected to play — a real ESPN projection, at the
 * wrong granularity.
 *
 * That is sound for the two properties the simulator most needs, because both
 * are properties of the *spread*: how the error grows with the projection
 * level, and how asymmetric it is. It is weakest exactly where a season
 * projection differs most from a weekly one — the median shift — which is why
 * the per-player bias correction stays switched off on a borrowed fit.
 *
 * Once a group has this many of its own pairs the borrowed ones are dropped
 * entirely rather than blended: mixing two projection granularities into one
 * scale line would fit neither. Roughly 400 players are projected each week, so
 * every group clears the threshold within the first few weeks of real football.
 */
const MIN_OWN_SAMPLES = 250;

interface Pair {
  pid: string;
  projection: number;
  actual: number;
  week: number;
  team: string;
}

/**
 * Weighted least squares of `y = a + b·x` over binned points.
 *
 * Bins rather than raw pairs because the quantity being regressed is a standard
 * deviation, which only exists for a group of observations.
 */
function fitScaleLine(
  bins: Array<{ x: number; y: number; w: number }>,
): { intercept: number; slope: number } {
  const totalWeight = bins.reduce((sum, bin) => sum + bin.w, 0);
  if (bins.length < 2 || totalWeight <= 0) {
    const flat = bins.length ? mean(bins.map((bin) => bin.y)) : MIN_SCALE;
    return { intercept: Math.max(MIN_SCALE, flat), slope: 0 };
  }

  const meanX = bins.reduce((sum, bin) => sum + bin.w * bin.x, 0) / totalWeight;
  const meanY = bins.reduce((sum, bin) => sum + bin.w * bin.y, 0) / totalWeight;

  let covariance = 0;
  let variance = 0;
  for (const bin of bins) {
    covariance += bin.w * (bin.x - meanX) * (bin.y - meanY);
    variance += bin.w * (bin.x - meanX) ** 2;
  }

  // A negative slope would say big projections are *more* certain in absolute
  // points, which is not a thing that happens; treat it as a flat fit.
  const slope = variance > 0 ? Math.max(0, covariance / variance) : 0;
  const intercept = Math.max(MIN_SCALE, meanY - slope * meanX);
  return { intercept, slope };
}

/** Empirical quantiles at `knots` evenly spaced probabilities. */
function quantileKnots(sorted: number[], knots: number): number[] {
  const out = new Array<number>(knots);
  const last = sorted.length - 1;
  for (let i = 0; i < knots; i++) {
    const pos = (i / (knots - 1)) * last;
    const base = Math.floor(pos);
    const rest = pos - base;
    const next = sorted[base + 1];
    out[i] = next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
  }
  return out;
}

/**
 * Mean pairwise correlation of standardised residuals inside an NFL team-week.
 *
 * A method-of-moments estimator: across every team-week group, the sum of
 * centred pairwise products divided by the number of pairs estimates the average
 * covariance, which divided by the variance is the correlation. Doing it this
 * way avoids ever materialising a player-by-player matrix.
 *
 * Centring is not optional here. The residuals carry a real bias — that is the
 * whole reason the median correction exists — and an uncentred estimator would
 * report that squared bias as if it were correlation, which is exactly the size
 * of the effect being measured.
 */
function estimateTeamCorrelation(groups: number[][]): number {
  let count = 0;
  let sum = 0;
  for (const values of groups) {
    for (const v of values) {
      sum += v;
      count++;
    }
  }
  if (count < 2) return 0;

  const centre = sum / count;
  let variance = 0;
  for (const values of groups) {
    for (const v of values) variance += (v - centre) ** 2;
  }
  variance /= count;
  if (variance <= 0) return 0;

  let pairSum = 0;
  let pairCount = 0;

  for (const values of groups) {
    const n = values.length;
    if (n < 2) continue;
    let total = 0;
    let totalSquares = 0;
    for (const v of values) {
      const centred = v - centre;
      total += centred;
      totalSquares += centred * centred;
    }
    // (Σz)² − Σz² = 2·Σ_{i<j} z_i z_j, i.e. twice the sum over unordered pairs.
    pairSum += (total * total - totalSquares) / 2;
    pairCount += (n * (n - 1)) / 2;
  }

  if (!pairCount) return 0;
  /*
   * Clamped to [0, 0.9): a single-factor copula loads on sqrt(rho) and cannot
   * represent a negative shared factor, and a correlation near 1 would collapse
   * every player on a team onto one draw.
   */
  return clamp(pairSum / pairCount / variance, 0, 0.9);
}

/**
 * Fits the residual model from loaded season data.
 *
 * Only weeks that are complete contribute: a partially played week would pair
 * full projections against partial results and manufacture a huge downside tail.
 */
export function fitResidualModel(input: FitResidualModelInput): ResidualModel {
  const {
    scoringModel,
    playersById,
    weekStats,
    weekProjections,
    weekTeams,
    throughWeek,
    priorPairs,
    priorPlays,
    priorFit,
  } = input;
  const score = createScorer(scoringModel);

  /** Groups the offline fit can supply, and the fit for each. */
  const priorByGroup = new Map<PositionGroup, ResidualFit>(
    (priorFit?.groups ?? []).map((fit) => [fit.group, fit]),
  );

  const pairsByGroup = new Map<PositionGroup, Pair[]>();
  const playCounts = new Map<PositionGroup, { played: number; projected: number }>();
  const playsByPlayer = new Map<string, { played: number; projected: number }>();
  const biasByPlayer = new Map<string, { sum: number; n: number; recent: number[] }>();
  for (const group of POSITION_GROUPS) {
    pairsByGroup.set(group, []);
    playCounts.set(group, { played: 0, projected: 0 });
  }

  for (let week = 1; week <= throughWeek; week++) {
    const stats = weekStats.get(week);
    const projections = weekProjections.get(week);
    if (!stats || !projections) continue;
    const teams = weekTeams?.get(week) ?? {};

    for (const pid of Object.keys(projections)) {
      const projLine = projections[pid];
      if (!hasValidProjection(projLine)) continue;

      const group = playersById.get(pid)?.group ?? null;
      if (!group) continue;

      const projection = score(projLine, group);
      if (projection < MIN_MEANINGFUL_PROJECTION) continue;

      const counts = playCounts.get(group)!;
      counts.projected++;

      let own = playsByPlayer.get(pid);
      if (!own) {
        own = { played: 0, projected: 0 };
        playsByPlayer.set(pid, own);
      }
      own.projected++;

      const statLine = stats[pid];
      if (!hasPlayed(statLine)) continue;
      counts.played++;
      own.played++;

      pairsByGroup.get(group)!.push({
        pid,
        projection,
        actual: score(statLine, group),
        week,
        team: teams[pid] ?? '',
      });
    }
  }

  const byGroup = new Map<PositionGroup, ResidualFit>();
  let totalSamples = 0;
  /** Standardised residuals keyed by NFL team-week, pooled across positions. */
  const pooledTeamWeeks = new Map<string, number[]>();

  const bootstrapped = new Set<PositionGroup>();

  for (const group of POSITION_GROUPS) {
    let pairs = pairsByGroup.get(group)!;
    const counts = playCounts.get(group)!;

    if (pairs.length < MIN_OWN_SAMPLES && priorByGroup.has(group)) {
      /*
       * The offline fit, installed rather than refitted.
       *
       * It was built in Node over every finished season in the snapshot —
       * twenty thousand real weekly pairs against the few hundred a borrowed
       * prorated season could offer — so there is nothing for the client to
       * improve by fitting again, and a 257-knot shape is not something to
       * rebuild on a phone.
       *
       * Per-player attendance and bias come across only where this season has
       * nothing of its own to say about that player, so a real week always
       * outranks a borrowed one.
       */
      const fit = priorByGroup.get(group)!;
      byGroup.set(group, { ...fit, bootstrapped: true });
      totalSamples += fit.samples;

      for (const [pid, [played, projected]] of Object.entries(priorFit!.plays)) {
        if ((playersById.get(pid)?.group ?? null) !== group) continue;
        if (playsByPlayer.has(pid)) continue;
        playsByPlayer.set(pid, { played, projected });
      }

      /*
       * A prorated fit teaches no bias, for the reason given on
       * `PriorResidualFit.granularity`: its residuals are measured against a
       * season projection divided by games, so their centre is an artefact of
       * that division rather than a tendency of the player.
       */
      if (priorFit!.granularity === 'weekly') {
        for (const [pid, [sum, n]] of Object.entries(priorFit!.bias)) {
          if ((playersById.get(pid)?.group ?? null) !== group) continue;
          if (biasByPlayer.has(pid) || n <= 0) continue;
          biasByPlayer.set(pid, { sum, n, recent: [] });
        }
      }

      continue;
    }

    if (pairs.length < MIN_OWN_SAMPLES) {
      const borrowed = priorPairs?.get(group);
      if (borrowed && borrowed.length > 0) {
        pairs = borrowed;
        bootstrapped.add(group);

        /*
         * Play rate has to come from the borrowed pairs too, and it is not a
         * detail. `playRate` is the probability a projected player records
         * anything at all, and it is the only thing that puts mass at exactly
         * zero — which is where a bye-week fill-in, a healthy scratch and a
         * receiver who saw one target all land.
         *
         * Left at the default of 1, a borrowed fit says every projected player
         * always produces. That has a visible cost: it lifts the bottom of
         * every band off the floor, so a 10% interval covered 15% of outcomes
         * and every team's downside came out too optimistic.
         *
         * Participation is carried separately from points because a player —
         * especially a D/ST — can take the field and legitimately score zero.
         * Older pair sources without that flag retain the score-based fallback.
         */
        const played = borrowed.reduce(
          (n, pair) => n + ((pair.played ?? (pair.actual > 0)) ? 1 : 0),
          0,
        );
        counts.played = played;
        counts.projected = borrowed.length;

        // Per-player attendance for this group, so a player with his own record
        // is not judged by the group's. Only filled where the season in
        // progress has nothing of its own to say.
        for (const [pid, own] of priorPlays ?? []) {
          if ((playersById.get(pid)?.group ?? null) !== group) continue;
          if (playsByPlayer.has(pid)) continue;
          playsByPlayer.set(pid, { ...own });
        }
      }
    }

    if (pairs.length < MIN_BIN_SAMPLES) continue;

    // ---- Scale: sd of the residual as a line in the projection level --------
    const byProjection = [...pairs].sort((a, b) => a.projection - b.projection);
    const binCount = Math.max(
      1,
      Math.min(SCALE_BINS, Math.floor(byProjection.length / MIN_BIN_SAMPLES)),
    );
    const binSize = Math.ceil(byProjection.length / binCount);

    const bins: Array<{ x: number; y: number; w: number }> = [];
    for (let start = 0; start < byProjection.length; start += binSize) {
      const slice = byProjection.slice(start, start + binSize);
      if (slice.length < 2) continue;
      bins.push({
        x: mean(slice.map((p) => p.projection)),
        y: stdev(slice.map((p) => p.actual - p.projection)),
        w: slice.length,
      });
    }

    const { intercept, slope } = fitScaleLine(bins);

    // ---- Shape: the standardised residual, kept as empirical quantiles ------
    const standardised = pairs.map((pair) => ({
      ...pair,
      z: (pair.actual - pair.projection) / Math.max(MIN_SCALE, intercept + slope * pair.projection),
    }));
    const sortedZ = standardised.map((pair) => pair.z).sort((a, b) => a - b);

    /*
     * Per-player bias is carried in standardised units, not points, for two
     * reasons. It makes a linebacker projected for 4 and one projected for 14
     * directly comparable, and it lets the shift be re-scaled to whatever this
     * week's projection is rather than assuming the miss is a fixed number of
     * points regardless of workload.
     */
    // A borrowed fit's residuals belong to last season's players measured
    // against a prorated projection. Feeding them to the per-player bias
    // correction would carry one season's luck into the next as a tendency.
    if (!bootstrapped.has(group))
      for (const pair of standardised) {
        let bias = biasByPlayer.get(pair.pid);
        if (!bias) {
          bias = { sum: 0, n: 0, recent: [] };
          biasByPlayer.set(pair.pid, bias);
        }
        bias.sum += pair.z;
        bias.n++;
        bias.recent.push(pair.z);
        if (bias.recent.length > RECENT_BIAS_WEEKS) bias.recent.shift();
      }

    // ---- Correlation: standardised residuals grouped by NFL team-week -------
    const teamWeeks = new Map<string, number[]>();
    for (const pair of standardised) {
      if (!pair.team) continue;
      const key = `${pair.week}:${pair.team}`;
      const bucket = teamWeeks.get(key);
      if (bucket) bucket.push(pair.z);
      else teamWeeks.set(key, [pair.z]);

      const pooled = pooledTeamWeeks.get(key);
      if (pooled) pooled.push(pair.z);
      else pooledTeamWeeks.set(key, [pair.z]);
    }

    const shape = quantileKnots(sortedZ, Math.min(SHAPE_KNOTS, sortedZ.length));

    byGroup.set(group, {
      group,
      samples: pairs.length,
      scaleIntercept: round(intercept, 4),
      scaleSlope: round(slope, 4),
      shape,
      medianZ: shape[(shape.length - 1) >> 1],
      meanZ: mean(sortedZ),
      sdZ: stdev(sortedZ),
      floor: Math.min(...pairs.map((pair) => pair.actual)),
      withinGroupCorrelation: estimateTeamCorrelation([...teamWeeks.values()]),
      playRate: counts.projected ? counts.played / counts.projected : 1,
      bootstrapped: bootstrapped.has(group),
    });
    totalSamples += pairs.length;
  }

  /*
   * The correlation the simulator loads onto its shared shock.
   *
   * Estimated from this season once it has team-weeks to estimate from, and
   * from the offline multi-season fit before that. A pooled estimate over three
   * finished seasons is a far steadier number than one over the two or three
   * team-weeks a September snapshot contains, and this figure sets how wide
   * every team total comes out.
   */
  const ownTeamWeeks = [...pooledTeamWeeks.values()].filter((bucket) => bucket.length > 1);
  const teamCorrelation =
    ownTeamWeeks.length >= MIN_TEAM_WEEKS_FOR_CORRELATION || !priorFit
      ? estimateTeamCorrelation([...pooledTeamWeeks.values()])
      : priorFit.teamCorrelation;

  const forwardPlayRate = new Map<PositionGroup, number>();
  for (const [group, rate] of Object.entries(priorFit?.forwardPlayRate ?? {})) {
    if (POSITION_GROUPS.includes(group as PositionGroup) && Number.isFinite(rate)) {
      forwardPlayRate.set(group as PositionGroup, clamp(rate, 0, 1));
    }
  }
  const forwardPlaysByPlayer = new Map<string, { played: number; projected: number }>();
  for (const [pid, entry] of Object.entries(priorFit?.forwardPlays ?? {})) {
    forwardPlaysByPlayer.set(pid, { played: entry[0], projected: entry[1] });
  }

  return {
    byGroup,
    forwardPlayRate,
    forwardPlaysByPlayer,
    teamCorrelation,
    playsByPlayer,
    biasByPlayer,
    throughWeek,
    totalSamples,
  };
}

/** Fitted residual scale at a given projection level. */
export function scaleFor(fit: ResidualFit, projection: number): number {
  return Math.max(MIN_SCALE, fit.scaleIntercept + fit.scaleSlope * Math.max(0, projection));
}

/**
 * Inverse CDF of the standardised residual, linearly interpolated between knots.
 *
 * This is what turns a uniform draw into a residual with the right shape, and
 * what makes the copula in `simulate.ts` preserve these marginals exactly.
 */
export function quantileOfZ(fit: ResidualFit, u: number): number {
  const knots = fit.shape;
  const last = knots.length - 1;
  const pos = clamp(u, 0, 1) * last;
  const base = Math.floor(pos);
  if (base >= last) return knots[last];
  return knots[base] + (pos - base) * (knots[base + 1] - knots[base]);
}

/**
 * How many points to shift a player's forecast for his own projection bias.
 *
 * Zero for any position where the correction did not earn its place out of
 * sample — see `BIAS_CORRECTION`. The season-long estimate is shrunk toward no
 * bias by `BIAS_PRIOR` weeks, so three good games cannot assert a large one.
 */
export function biasShiftFor(
  model: ResidualModel,
  pid: string,
  group: PositionGroup,
  projection: number,
): number {
  const { seasonWeight, damping } = BIAS_CORRECTION[group];
  if (damping <= 0) return 0;

  const fit = model.byGroup.get(group);
  const bias = model.biasByPlayer.get(pid);
  if (!fit || !bias || !bias.n) return 0;

  /*
   * Measured as an excess over the player's own position, never as an absolute
   * bias. The forecast has already moved the whole group, so adding a player's
   * raw bias on top would count the group's share of it a second time — which
   * is what the first attempt did, pulling every simulated team total about nine
   * percent low.
   *
   * The reference is the group *mean*, not its median, and the distinction is
   * not pedantic. The statistic being compared is a player's average residual,
   * and residuals are right-skewed, so the group mean sits above the group
   * median. Differencing a mean against a median hands every single player a
   * small positive excess and inflates the league by about five percent — the
   * same bug in the opposite direction. Like against like keeps the average
   * correction at zero, which is what makes this a redistribution between
   * players rather than a thumb on the scale.
   */
  const season = (bias.sum - bias.n * fit.meanZ) / (bias.n + BIAS_PRIOR);
  const recent = bias.recent.length
    ? bias.recent.reduce((sum, v) => sum + v, 0) / bias.recent.length - fit.meanZ
    : season;

  const excessZ = seasonWeight * season + (1 - seasonWeight) * recent;
  return damping * scaleFor(fit, projection) * excessZ;
}

/**
 * Score at probability `u`, conditional on the player actually playing.
 *
 * `shift` moves the location without touching the spread: the scale was fit
 * against the raw projection level, so a corrected player keeps the error bar
 * that a projection of his size has historically earned.
 */
export function scoreAtQuantile(
  fit: ResidualFit,
  projection: number,
  u: number,
  shift = 0,
): number {
  return Math.max(
    fit.floor,
    projection + shift + scaleFor(fit, projection) * quantileOfZ(fit, u),
  );
}

/** CDF of the standardised residual — the inverse of `quantileOfZ`. */
export function cdfOfZ(fit: ResidualFit, z: number): number {
  const knots = fit.shape;
  const last = knots.length - 1;
  if (z <= knots[0]) return 0;
  if (z >= knots[last]) return 1;

  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (knots[mid] <= z) low = mid;
    else high = mid;
  }

  const span = knots[high] - knots[low];
  const within = span > 0 ? (z - knots[low]) / span : 0;
  return (low + within) / last;
}

export interface PlayerForecast {
  pid: string;
  group: PositionGroup;
  /** The scored source projection, exactly as the app scores it today. */
  projection: number;
  /** Bias-corrected central estimate — our number, not the source's. */
  median: number;
  /** Points added for this player's own history against his projection. */
  biasShift: number;
  /** Points added for the positional difficulty of this week's opponent. */
  matchupShift: number;
  mean: number;
  sd: number;
  /** Unconditional quantiles: the DNP mass is folded in, so a floor can be 0. */
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  /** Probability the player records a stat line at all. */
  playProb: number;
  /** Chance of reaching 120% of the source projection. Null without a projection. */
  boomProb: number | null;
  /** Chance of finishing at or below 80% of the source projection. */
  bustProb: number | null;
  /** The player's real result, when the week has already been played. */
  actual: number | null;
  /** NFL team, used to group correlated players when simulating. */
  nflTeam: string;
}

export interface BuildWeekForecastInput {
  model: ResidualModel;
  scoringModel: ScoringModel;
  playersById: Map<string, Player>;
  /** Projections for the target week. */
  projections: Record<string, StatLine>;
  /** Results for the target week, where they exist. */
  stats?: Record<string, StatLine>;
  teams?: Record<string, string>;
  /** Players known to be unavailable this week. */
  isOut?: (pid: string) => boolean;
  /** Per-player multiplier derived from opponent-adjusted positional history. */
  matchupFactors?: ReadonlyMap<string, number>;
  /** Restrict the build to these players. Omit to forecast everyone projected. */
  only?: Set<string>;
  /**
   * Whether this week's projection has had its inactive list published.
   *
   * `live` is the week about to be played or already under way: ESPN's
   * projection for it reflects who is actually dressing, so a player who
   * carries one is very nearly certain to appear. `forward` is any later week,
   * where the projection is months of football away from knowing whether he
   * will be fit — and where the honest play probability is 78–91%, not 99%.
   *
   * Defaults to `live`, which is what a caller that has not thought about it
   * usually means, and which is the behaviour the app had before this existed.
   */
  horizon?: 'live' | 'forward';
}

/**
 * Unconditional quantile of the score, mixing the DNP mass in at zero.
 *
 * A player who misses 15% of weeks genuinely has a 10th-percentile outcome of
 * zero, and a floor that quietly assumed he suits up would be dishonest in
 * exactly the situation the floor exists to warn about.
 *
 * Not simply "shift by the DNP mass": a played game can itself score at or
 * below zero — a quarterback throwing two interceptions, a receiver losing a
 * fumble — so the distribution has real mass on both sides of the atom at zero.
 * The three branches below are that atom and its two tails.
 */
/**
 * Quantile of the *unconditional* outcome: the played distribution and the
 * point mass at zero, mixed by `playProb`. This is the band the app displays
 * and the one `research:forecast` is scored against.
 */
export function mixtureQuantile(
  fit: ResidualFit,
  projection: number,
  playProb: number,
  q: number,
  shift: number,
): number {
  if (playProb <= 0) return 0;
  if (playProb >= 1) return scoreAtQuantile(fit, projection, q, shift);

  // Probability a played game finishes at or below zero.
  const belowZero = cdfOfZ(fit, (0 - projection - shift) / scaleFor(fit, projection));
  const negativeMass = playProb * belowZero;

  if (q < negativeMass) return scoreAtQuantile(fit, projection, q / playProb, shift);
  if (q <= negativeMass + (1 - playProb)) return 0;
  return scoreAtQuantile(fit, projection, (q - (1 - playProb)) / playProb, shift);
}

/** CDF of the played distribution mixed with the probability of not playing. */
export function mixtureCdf(
  fit: ResidualFit,
  projection: number,
  playProb: number,
  score: number,
  shift: number,
): number {
  const playedCdf = cdfOfZ(
    fit,
    (score - projection - shift) / scaleFor(fit, projection),
  );
  const didNotPlayMass = score >= 0 ? 1 - playProb : 0;
  return clamp(didNotPlayMass + playProb * playedCdf, 0, 1);
}

export function buildWeekForecast(input: BuildWeekForecastInput): Map<string, PlayerForecast> {
  const {
    model,
    scoringModel,
    playersById,
    projections,
    stats,
    teams,
    isOut,
    matchupFactors,
    only,
    horizon = 'live',
  } = input;
  const score = createScorer(scoringModel);
  const out = new Map<string, PlayerForecast>();

  const pids = only ? [...only] : Object.keys(projections);

  for (const pid of pids) {
    const group = playersById.get(pid)?.group ?? null;
    if (!group) continue;
    const fit = model.byGroup.get(group);
    if (!fit) continue;

    const projLine = projections[pid];
    const projection = hasValidProjection(projLine) ? score(projLine, group) : 0;

    const statLine = stats?.[pid];
    const played = hasPlayed(statLine);
    const actual = played ? score(statLine, group) : null;

    /*
     * Play probability. A player ESPN does not project for this week is on a
     * bye or inactive, and a player flagged out is out — both are certainties,
     * not estimates. Otherwise the player's own record of turning up is shrunk
     * toward his position's base rate, because six healthy weeks is weak
     * evidence of a 100% floor.
     *
     * Which record and which base rate depends on how far away the week is, and
     * the two differ by twenty points. For the live week the question is "he is
     * projected today — does he play", and the answer is nearly always yes,
     * because a projection published after the inactive list already encodes
     * the answer. For a later week the projection knows nothing about the
     * injury that has not happened yet, and the measured rate is 78% at
     * quarterback. Using the live figure for December is what made every
     * rest-of-season total read as though nobody ever gets hurt.
     *
     * A player ruled out today is still out today and unknown in December, so
     * `isOut` only decides the live week.
     */
    const forward = horizon === 'forward';
    let playProb: number;
    if (played) {
      playProb = 1;
    } else if (projection < MIN_MEANINGFUL_PROJECTION || (!forward && isOut?.(pid))) {
      playProb = 0;
    } else {
      const base = forward
        ? (model.forwardPlayRate.get(group) ?? fit.playRate)
        : fit.playRate;
      const own = forward ? model.forwardPlaysByPlayer.get(pid) : model.playsByPlayer.get(pid);
      playProb = own
        ? (own.played + base * PLAY_RATE_PRIOR) / (own.projected + PLAY_RATE_PRIOR)
        : base;
      /*
       * A player who is out *now* is not simply a normal player in December.
       * The injury that keeps him out this week is evidence about the next few,
       * so a known absence halves his forward availability rather than being
       * ignored — an assertion, but a conservative one, and far closer than
       * treating a torn ACL as irrelevant to week 12.
       */
      if (forward && isOut?.(pid)) playProb *= OUT_FORWARD_PENALTY;
      playProb = clamp(playProb, 0, 1);
    }

    const scale = scaleFor(fit, projection);
    const biasShift = biasShiftFor(model, pid, group, projection);
    const matchupFactor = clamp(matchupFactors?.get(pid) ?? 1, 0.5, 1.5);
    const matchupShift = projection * (matchupFactor - 1);
    const totalShift = biasShift + matchupShift;
    const conditionalMean = projection + totalShift + scale * fit.meanZ;
    const conditionalSd = scale * fit.sdZ;
    const boomProb =
      projection >= MIN_MEANINGFUL_PROJECTION
        ? 1 -
          mixtureCdf(
            fit,
            projection,
            playProb,
            projection * DEFAULT_BOOM_BUST.boomPct,
            totalShift,
          )
        : null;
    const bustProb =
      projection >= MIN_MEANINGFUL_PROJECTION
        ? mixtureCdf(
            fit,
            projection,
            playProb,
            projection * DEFAULT_BOOM_BUST.bustPct,
            totalShift,
          )
        : null;

    out.set(pid, {
      pid,
      group,
      projection: round(projection),
      biasShift: round(biasShift),
      matchupShift: round(matchupShift),
      median: round(projection + totalShift + scale * fit.medianZ),
      mean: round(conditionalMean * playProb),
      // Variance of the DNP mixture: within-branch variance plus the spread
      // between a zero and a played outcome.
      sd: round(
        Math.sqrt(
          playProb * conditionalSd ** 2 + playProb * (1 - playProb) * conditionalMean ** 2,
        ),
      ),
      p10: round(mixtureQuantile(fit, projection, playProb, 0.1, totalShift)),
      p25: round(mixtureQuantile(fit, projection, playProb, 0.25, totalShift)),
      p75: round(mixtureQuantile(fit, projection, playProb, 0.75, totalShift)),
      p90: round(mixtureQuantile(fit, projection, playProb, 0.9, totalShift)),
      playProb: round(playProb, 3),
      boomProb: boomProb === null ? null : round(boomProb, 3),
      bustProb: bustProb === null ? null : round(bustProb, 3),
      actual: actual === null ? null : round(actual),
      nflTeam: (teams?.[pid] ?? playersById.get(pid)?.team ?? '').toUpperCase(),
    });
  }

  return out;
}
