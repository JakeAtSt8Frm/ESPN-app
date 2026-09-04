/**
 * Matchup Score (0–100) — how good a defence is to face, by position group.
 *
 * For every (position group, defensive team) pair we measure how many custom
 * points that defence has surrendered to that group, then convert it into a
 * 0–100 defence-only rating where 100 means "the softest possible matchup".
 *
 * How much this matters varies enormously by position, and the variation is
 * measured rather than assumed — see `MATCHUP_INFLUENCE` below. A team defence
 * is three times more matchup-dependent than anything else this league starts;
 * a running back is barely dependent on it at all.
 *
 * The rating blends six components:
 *   base          rank of generosity among all 32 defences (0–100)
 *   trend         recent 4-week direction vs season average, IQR-normalised
 *   ceiling bonus how often this defence allows a top-quartile week
 *   floor penalty how often it holds opponents to a bottom-quartile week
 *   consistency   inverse volatility — predictable defences are easier to trust
 *   top-10 bonus  how often it yields a leaguewide top-10 week at the position
 *
 * A player-facing lookup uses the two opponent-controlled signals that held up
 * against player projection residuals across 2023–2025: schedule-adjusted
 * concessions and opportunity volume allowed. Player/team strength is
 * deliberately excluded because it describes the player, not the matchup.
 */

import {
  createScorer,
  hasPlayed,
  opportunities,
  type ScoringModel,
} from './scoring';
import { clamp, mean, percentileRanks, quantile, round, stdev } from './stats';
import type { Player, PositionGroup, StatLine } from './types';
import { POSITION_GROUPS } from './types';

export interface MatchupBreakdown {
  base: number;
  trend: number;
  ceilingBonus: number;
  floorPenalty: number;
  consistencyBonus: number;
  top10Bonus: number;
}

export interface MatchupEntry {
  defense: string;
  group: PositionGroup;
  /** 0–100. Higher = more opportunity and adjusted production allowed. */
  score: number;
  /** Full defence-generosity composite used by the Analytics table. */
  baseScore: number;
  /** Percentile of schedule-adjusted points allowed. */
  opponentAdjustedScore: number;
  /** Percentile of opportunity volume allowed. */
  opportunityScore: number;
  /**
   * The unnormalised component sum, before rescaling.
   *
   * Exposed for transparency: `score` is this value's rank-percentile across
   * the league, not the sum itself. See the note on rescaling below.
   */
  rawComposite: number;
  /** Custom points per game allowed to this position group. */
  pointsPerGame: number;
  opponentAdjustedPpg: number;
  opportunitiesPerGame: number;
  efficiencyAllowed: number;
  last4: number;
  volatility: number;
  games: number;
  /** 1 = most generous defence in the league. */
  rankMostGenerous: number;
  ceilingRate: number;
  floorRate: number;
  top10Rate: number;
  breakdown: MatchupBreakdown;
}

export interface MatchupIndex {
  /** group -> defensive team -> entry */
  byGroup: Map<PositionGroup, Map<string, MatchupEntry>>;
  throughWeek: number;
  defenses: string[];
  get(
    group: PositionGroup | null,
    defense: string | null | undefined,
  ): MatchupEntry | null;
  /** Multiplier for a custom-score projection after positional difficulty. */
  projectionFactor(
    group: PositionGroup | null,
    defense: string | null | undefined,
  ): number;
}

export interface BuildMatchupIndexInput {
  scoringModel: ScoringModel;
  playersById: Map<string, Player>;
  /** week -> pid -> stat line. */
  weekStats: Map<number, Record<string, StatLine>>;
  /** week -> pid -> opponent team abbreviation. */
  weekOpponents: Map<number, Record<string, string>>;
  /** week -> pid -> player's team abbreviation. */
  weekTeams?: Map<number, Record<string, string>>;
  throughWeek: number;
}

export type MatchupHistoryInput = Omit<BuildMatchupIndexInput, 'throughWeek'>;

/** How many weekly performances count as "top N" for the top-10 bonus. */
const TOP_N = 10;
/** Player-facing matchup weights selected on leakage-safe player-week residuals. */
export const PLAYER_MATCHUP_WEIGHTS = {
  opponentAdjusted: 0.6,
  opportunity: 0.4,
} as const;

/**
 * Ridge strength for the two-way fit, in units of games.
 *
 * Doubles as small-sample shrinkage: a defence seen three times is pulled most
 * of the way back to average, one seen twelve times is largely trusted.
 */
const TWO_WAY_RIDGE = 3;

/**
 * How much a matchup actually moves a player's result, by position.
 *
 * Measured, not assumed, and now measured with the right instrument.
 *
 * The earlier figures correlated the rating against a player's deviation from
 * his own season mean, because that was all the data allowed: the sharper
 * question is how far he landed from *his projection*, which already prices in
 * his form and role, and that needs the weekly projection that preceded each
 * finished game. ESPN was thought not to publish those. It does — through the
 * template league every season can be read against — so `npm run fit:priors`
 * now measures the sharper quantity over 19,000 weekly pairs across three
 * seasons, with every rating rebuilt from weeks strictly before the one it is
 * scored on.
 *
 *                    QB     RB     WR     TE      K    DST
 *   against own mean  .25    .10    .16    .17    .33   1.00
 *   against projection .28   .01    .17    .19    .31   1.00
 *
 * The two agree almost everywhere, which is the useful result: the blunt
 * instrument was not lying, and the ordering it produced survives. The one real
 * change is running back, which falls from a tenth to essentially nothing —
 * a correlation of .002 over 3,103 pairs. A player's own mean absorbs part of
 * the schedule, so the old figure was carrying schedule the rating had not
 * earned; against a projection, which already knows his workload, the opponent
 * adds nothing measurable to a running back at all.
 *
 * The spread is the finding, and **the order is not the one you would guess**.
 * A team defence is three times more matchup-dependent than anything else on
 * the roster, which on reflection is nearly a tautology: a D/ST's entire score
 * is the offence it faces, so "who are they playing" is not context for the
 * projection, it *is* the projection. Running backs sit at the other end —
 * volume is assigned during the week and a bad matchup takes carries away far
 * more slowly than it takes away sacks and turnovers.
 *
 * `fit:priors` re-measures these every run and fails if the shipped table has
 * drifted from what the data says, so these constants cannot quietly rot.
 *
 * This deliberately does **not** rescale the score. Rescaling by influence was
 * tried in the model this one descends from and could not be justified — it
 * helped on one holdout and hurt on another, both near zero. It is used for
 * presentation only: a chip this weak should not be dressed up as advice.
 */
export const MATCHUP_INFLUENCE: Record<PositionGroup, number> = {
  DST: 1,
  K: 0.31,
  QB: 0.28,
  TE: 0.19,
  WR: 0.17,
  RB: 0.01,
};

/** Below this, the rating carries no information worth acting on. */
export const MATCHUP_INFLUENCE_FLOOR = 0.15;

/**
 * Maximum opponent-driven move to an ESPN projection.
 *
 * The underlying concession ratios can be extreme in small samples. Capping
 * the location shift keeps the opponent as a correction to the source forecast
 * rather than letting one season of defensive history replace it.
 */
export const MAX_MATCHUP_PROJECTION_ADJUSTMENT = 0.2;

/**
 * Two-way additive fit: points conceded = league mean + offence + defence.
 *
 * The obvious way to schedule-adjust a defence is to subtract the producing
 * team's own average from each week's concession, which is what this model used
 * to do. It has a hole: the offences themselves played different schedules, so
 * an offence inflated by a soft run of opponents drags its victims down with it,
 * and a defence that happened to face good offences stays overrated.
 *
 * Alternating ridge least squares solves both sides at once — each pass
 * re-estimates offences given the current defence estimates and vice versa,
 * converging on effects that are mutually consistent. Worth about a 29% lift in
 * holdout rank correlation over the single-pass version it replaces.
 */
function twoWayDefenseEffects(
  games: Array<{ defense: string; offense: string; points: number }>,
  leagueMean: number,
): Map<string, number> {
  const offense = new Map<string, number>();
  const defense = new Map<string, number>();
  if (!games.length) return defense;

  for (let iteration = 0; iteration < 25; iteration++) {
    const offSums = new Map<string, { sum: number; n: number }>();
    for (const game of games) {
      const entry = offSums.get(game.offense) ?? { sum: 0, n: 0 };
      entry.sum += game.points - leagueMean - (defense.get(game.defense) ?? 0);
      entry.n++;
      offSums.set(game.offense, entry);
    }
    for (const [team, { sum, n }] of offSums) offense.set(team, sum / (n + TWO_WAY_RIDGE));

    const defSums = new Map<string, { sum: number; n: number }>();
    for (const game of games) {
      const entry = defSums.get(game.defense) ?? { sum: 0, n: 0 };
      entry.sum += game.points - leagueMean - (offense.get(game.offense) ?? 0);
      entry.n++;
      defSums.set(game.defense, entry);
    }
    for (const [team, { sum, n }] of defSums) defense.set(team, sum / (n + TWO_WAY_RIDGE));
  }

  return defense;
}

export function buildMatchupIndex(input: BuildMatchupIndexInput): MatchupIndex {
  const { scoringModel, playersById, weekStats, weekOpponents, weekTeams, throughWeek } = input;
  const score = createScorer(scoringModel);

  // group -> defense -> list of per-player-week scores conceded
  const conceded = new Map<PositionGroup, Map<string, number[]>>();
  // group -> defense -> Set of weeks faced (a defence plays once a week)
  const gamesFaced = new Map<PositionGroup, Map<string, Set<number>>>();
  // group -> defense -> count of top-N weekly performances allowed
  const top10 = new Map<PositionGroup, Map<string, number>>();
  // group -> defense -> per-week totals conceded, for trend/volatility
  const weeklyTotals = new Map<PositionGroup, Map<string, Map<number, number>>>();
  // group -> opponent -> per-week opportunity volume allowed
  const weeklyOpportunities = new Map<PositionGroup, Map<string, Map<number, number>>>();
  // group -> opponent -> week -> team producing the points
  const weeklySourceTeams = new Map<PositionGroup, Map<string, Map<number, string>>>();

  for (const group of POSITION_GROUPS) {
    conceded.set(group, new Map());
    gamesFaced.set(group, new Map());
    top10.set(group, new Map());
    weeklyTotals.set(group, new Map());
    weeklyOpportunities.set(group, new Map());
    weeklySourceTeams.set(group, new Map());
  }

  const nested = <T>(m: Map<PositionGroup, Map<string, T>>, g: PositionGroup, d: string, init: () => T): T => {
    const inner = m.get(g)!;
    let v = inner.get(d);
    if (v === undefined) {
      v = init();
      inner.set(d, v);
    }
    return v;
  };

  for (let week = 1; week <= throughWeek; week++) {
    const stats = weekStats.get(week);
    if (!stats) continue;
    const opponents = weekOpponents.get(week) ?? {};
    const teams = weekTeams?.get(week) ?? {};

    // Collect this week's performances so we can find the top-N per group.
    const weekRows: Array<{
      group: PositionGroup;
      defense: string;
      sourceTeam: string;
      points: number;
      opportunities: number;
    }> = [];

    for (const pid of Object.keys(stats)) {
      const line = stats[pid];
      if (!hasPlayed(line)) continue;

      const group = playersById.get(pid)?.group ?? null;
      if (!group) continue;

      const defense = opponents[pid];
      if (!defense) continue;
      const sourceTeam = teams[pid] ?? '';
      const points = score(line, group);
      const volume = opportunities(group, line) ?? 0;

      weekRows.push({ group, defense, sourceTeam, points, opportunities: volume });
    }

    // Per-group top-N for this week.
    const byGroupRows = new Map<PositionGroup, typeof weekRows>();
    for (const row of weekRows) {
      const arr = byGroupRows.get(row.group);
      if (arr) arr.push(row);
      else byGroupRows.set(row.group, [row]);
    }

    for (const [group, rows] of byGroupRows) {
      const ranked = [...rows].sort((a, b) => b.points - a.points).slice(0, TOP_N);
      for (const row of ranked) {
        const counter = top10.get(group)!;
        counter.set(row.defense, (counter.get(row.defense) ?? 0) + 1);
      }
    }

    for (const row of weekRows) {
      nested(conceded, row.group, row.defense, () => [] as number[]).push(row.points);
      nested(gamesFaced, row.group, row.defense, () => new Set<number>()).add(week);

      const wk = nested(weeklyTotals, row.group, row.defense, () => new Map<number, number>());
      wk.set(week, (wk.get(week) ?? 0) + row.points);

      const volume = nested(
        weeklyOpportunities,
        row.group,
        row.defense,
        () => new Map<number, number>(),
      );
      volume.set(week, (volume.get(week) ?? 0) + row.opportunities);

      if (row.sourceTeam) {
        const sources = nested(
          weeklySourceTeams,
          row.group,
          row.defense,
          () => new Map<number, string>(),
        );
        sources.set(week, row.sourceTeam);
      }
    }
  }

  // ---- Convert raw concessions into 0–100 ratings --------------------------

  const byGroup = new Map<PositionGroup, Map<string, MatchupEntry>>();
  const defenseSet = new Set<string>();

  for (const group of POSITION_GROUPS) {
    const perDefense = weeklyTotals.get(group)!;
    if (!perDefense.size) {
      byGroup.set(group, new Map());
      continue;
    }

    const allWeeklyTotals = [...perDefense.values()].flatMap((weekMap) => [
      ...weekMap.values(),
    ]);
    const leagueWeeklyMean = mean(allWeeklyTotals);

    // One row per defence-week, carrying the offence that produced the points.
    const groupSources = weeklySourceTeams.get(group)!;
    const games: Array<{ defense: string; offense: string; points: number }> = [];
    for (const [defense, weekMap] of perDefense) {
      const sources = groupSources.get(defense);
      for (const [week, points] of weekMap) {
        const offense = sources?.get(week);
        if (offense) games.push({ defense, offense, points });
      }
    }
    const defenseEffects = twoWayDefenseEffects(games, leagueWeeklyMean);

    // League-wide distribution of individual performances against this group,
    // used to define what counts as a ceiling or floor week.
    const allPerformances: number[] = [];
    for (const list of conceded.get(group)!.values()) allPerformances.push(...list);
    /*
     * The bar for "was in the game plan", set from the group's own distribution
     * rather than as a fixed number of points — a kicker's tenth percentile and
     * a quarterback's are different quantities of football.
     */
    const usageFloor = quantile(allPerformances, 0.1);
    const inPlan = allPerformances.filter((p) => p >= usageFloor);
    const p25 = quantile(inPlan, 0.25);
    const p75 = quantile(inPlan, 0.75);
    const iqr = Math.max(p75 - p25, 1e-6);

    interface Row {
      defense: string;
      ppg: number;
      last4: number;
      volatility: number;
      games: number;
      ceilingRate: number;
      floorRate: number;
      top10Rate: number;
      opponentAdjustedPpg: number;
      opportunitiesPerGame: number;
      efficiencyAllowed: number;
    }

    const rows: Row[] = [];

    for (const [defense, weekMap] of perDefense) {
      defenseSet.add(defense);
      const weeks = [...weekMap.keys()].sort((a, b) => a - b);
      const totals = weeks.map((w) => weekMap.get(w)!);
      const games = weeks.length;
      if (!games) continue;

      const ppg = mean(totals);
      const last4Weeks = totals.slice(-4);
      const last4 = last4Weeks.length ? mean(last4Weeks) : ppg;
      const volatility = stdev(totals);
      const volumeMap = weeklyOpportunities.get(group)!.get(defense) ?? new Map();
      const opportunitiesPerGame = mean(weeks.map((week) => volumeMap.get(week) ?? 0));
      // The defence's own effect, purged of the offences it happened to face.
      const opponentAdjustedPpg = leagueWeeklyMean + (defenseEffects.get(defense) ?? 0);

      /*
       * Ceiling/floor rates over the individual performances allowed — but only
       * over players who were actually in the game plan.
       *
       * Counting every performance makes the floor rate a measure of how many
       * bodies the opposing offences dressed rather than of the defence: a unit
       * that happens to face teams rotating eight receivers accumulates
       * bottom-quartile weeks it did nothing to earn, and every one of them
       * reads as a defence holding somebody down. The floor is what a defence
       * does to players who were going to play.
       */
      const performances = (conceded.get(group)!.get(defense) ?? []).filter(
        (p) => p >= usageFloor,
      );

      let ceilCount = 0;
      let floorCount = 0;
      for (const p of performances) {
        if (p >= p75) ceilCount++;
        if (p <= p25) floorCount++;
      }

      rows.push({
        defense,
        ppg,
        last4,
        volatility,
        games,
        ceilingRate: performances.length ? ceilCount / performances.length : 0,
        floorRate: performances.length ? floorCount / performances.length : 0,
        top10Rate: games ? (top10.get(group)!.get(defense) ?? 0) / games : 0,
        opponentAdjustedPpg,
        opportunitiesPerGame,
        efficiencyAllowed: ppg / Math.max(opportunitiesPerGame, 1),
      });
    }

    // Rank 1 = most generous (concedes the most points to this group).
    const ranked = [...rows].sort((a, b) => b.ppg - a.ppg);
    const rankOf = new Map<string, number>();
    ranked.forEach((r, i) => rankOf.set(r.defense, i + 1));

    const n = rows.length;
    const entries = new Map<string, MatchupEntry>();
    const adjustedRanks = percentileRanks(
      rows.map((row) => ({ id: row.defense, value: row.opponentAdjustedPpg })),
    );
    const opportunityRanks = percentileRanks(
      rows.map((row) => ({ id: row.defense, value: row.opportunitiesPerGame })),
    );

    // First compute the raw composite for every defence in this group.
    const composites: Array<{ id: string; value: number; parts: MatchupBreakdown }> = [];

    for (const r of rows) {
      const rank = rankOf.get(r.defense)!;

      // Base: linear over rank so the most generous defence starts at 100.
      const base = n > 1 ? (100 * (n - rank)) / (n - 1) : 50;

      // Trend: positive means the defence has been getting softer lately.
      const trend = ((r.last4 - r.ppg) / iqr) * 10;

      const ceilingBonus = r.ceilingRate * 15;
      const floorPenalty = r.floorRate * 10;
      // Lower volatility relative to output = more predictable = slight bonus.
      const consistencyBonus = (1 - Math.min(r.volatility / (r.ppg || 1), 1)) * 10;
      const top10Bonus = r.top10Rate * 20;

      composites.push({
        id: r.defense,
        value: base + trend + ceilingBonus - floorPenalty + consistencyBonus + top10Bonus,
        parts: {
          base: round(base, 1),
          trend: round(trend, 1),
          ceilingBonus: round(ceilingBonus, 1),
          floorPenalty: round(floorPenalty, 1),
          consistencyBonus: round(consistencyBonus, 1),
          top10Bonus: round(top10Bonus, 1),
        },
      });
    }

    /*
     * Rescale rather than clamp.
     *
     * The component sum ranges roughly -10..155: base alone reaches 100 for the
     * most generous defence, and the bonuses can add another 55 on top. Clamping
     * that into 0..100 flattened the extremes — in 2025 three different defences
     * tied at exactly 100.0 against QBs and two sat at 0.0, which destroyed the
     * ordering precisely where it matters most, at the softest and toughest
     * matchups a manager is actually choosing between.
     *
     * Mapping the composite onto its own rank-percentile keeps every component's
     * influence on the ordering, guarantees a full 0..100 spread, and makes the
     * number mean something concrete for the defence-only baseline:
     * "softer than X% of the league".
     */
    const rescaled = percentileRanks(composites.map(({ id, value }) => ({ id, value })));
    const compositeById = new Map(composites.map((c) => [c.id, c]));

    for (const r of rows) {
      const composite = compositeById.get(r.defense)!;
      const total = clamp((rescaled.get(r.defense) ?? 0.5) * 100, 0, 100);
      const opponentAdjustedScore = (adjustedRanks.get(r.defense) ?? 0.5) * 100;
      const opportunityScore = (opportunityRanks.get(r.defense) ?? 0.5) * 100;

      entries.set(r.defense, {
        defense: r.defense,
        group,
        score: round(total, 1),
        baseScore: round(total, 1),
        opponentAdjustedScore: round(opponentAdjustedScore, 1),
        opportunityScore: round(opportunityScore, 1),
        rawComposite: round(composite.value, 1),
        pointsPerGame: round(r.ppg),
        opponentAdjustedPpg: round(r.opponentAdjustedPpg),
        opportunitiesPerGame: round(r.opportunitiesPerGame),
        efficiencyAllowed: round(r.efficiencyAllowed, 3),
        last4: round(r.last4),
        volatility: round(r.volatility),
        games: r.games,
        rankMostGenerous: rankOf.get(r.defense)!,
        ceilingRate: round(r.ceilingRate, 3),
        floorRate: round(r.floorRate, 3),
        top10Rate: round(r.top10Rate, 3),
        breakdown: composite.parts,
      });
    }

    byGroup.set(group, entries);
  }

  return matchupIndexFrom(byGroup, throughWeek);
}

/**
 * Wraps a table of per-defence entries in the lookups the app reads.
 *
 * Split out from `buildMatchupIndex` so an index can also be assembled from
 * entries that were computed somewhere else — in particular the multi-season
 * blend in `blendMatchupIndexes`, which the app installs for the opening weeks
 * of a season before it has football of its own. Both routes then answer
 * `get` and `projectionFactor` through exactly this code, so a chip built from
 * three years of history means the same thing as one built from four weeks.
 */
export function matchupIndexFrom(
  byGroup: Map<PositionGroup, Map<string, MatchupEntry>>,
  throughWeek: number,
): MatchupIndex {
  const defenseSet = new Set<string>();
  for (const entries of byGroup.values()) {
    for (const defense of entries.keys()) defenseSet.add(defense);
  }

  return {
    byGroup,
    throughWeek,
    defenses: [...defenseSet].sort(),
    get(group, defense) {
      if (!group || !defense) return null;
      const entry = byGroup.get(group)?.get(String(defense).toUpperCase()) ?? null;
      if (!entry) return null;
      const playerScore =
        entry.opponentAdjustedScore * PLAYER_MATCHUP_WEIGHTS.opponentAdjusted +
        entry.opportunityScore * PLAYER_MATCHUP_WEIGHTS.opportunity;

      return {
        ...entry,
        score: round(clamp(playerScore, 0, 100), 1),
      };
    },
    projectionFactor(group, defense) {
      if (!group || !defense) return 1;
      const groupEntries = byGroup.get(group);
      const entry = groupEntries?.get(String(defense).toUpperCase());
      if (!entry || !groupEntries?.size) return 1;

      const peers = [...groupEntries.values()];
      const adjustedMean = mean(peers.map((peer) => peer.opponentAdjustedPpg));
      const opportunityMean = mean(peers.map((peer) => peer.opportunitiesPerGame));
      if (adjustedMean <= 0) return 1;

      // Both signals are ratios, so the adjustment keeps its meaning across
      // positions whose raw custom-score scales are very different.
      const adjustedPointsDelta = entry.opponentAdjustedPpg / adjustedMean - 1;
      const opportunityDelta =
        opportunityMean > 0 ? entry.opportunitiesPerGame / opportunityMean - 1 : 0;
      const opportunityReliability = entry.games / (entry.games + TWO_WAY_RIDGE);
      const historicalDelta =
        adjustedPointsDelta * PLAYER_MATCHUP_WEIGHTS.opponentAdjusted +
        opportunityDelta * opportunityReliability * PLAYER_MATCHUP_WEIGHTS.opportunity;
      const positionAdjusted = historicalDelta * MATCHUP_INFLUENCE[group];

      return round(
        1 +
          clamp(
            positionAdjusted,
            -MAX_MATCHUP_PROJECTION_ADJUSTMENT,
            MAX_MATCHUP_PROJECTION_ADJUSTMENT,
          ),
        4,
      );
    },
  };
}

/**
 * One index from several seasons of them, weighted toward the recent.
 *
 * A defence is not a stable object across an offseason. Coordinators move,
 * secondaries are rebuilt, and a unit that was generous last December often is
 * not in September — so this is emphatically not an equal-weight average. The
 * most recent season dominates and the older ones act as a regulariser: they
 * pull a defence rated off twelve noisy weeks back toward what it has looked
 * like over three years, without letting 2023 argue with 2025 about who is good
 * now.
 *
 * The alternative the app used to run is a single prior season, and it is worse
 * in a specific way rather than in general: a one-season rating is unbiased and
 * very noisy, and the first month of a season is exactly when a noisy defensive
 * rating gets applied to every row on every page.
 *
 * `rankMostGenerous` is recomputed from the blended concessions rather than
 * averaged, because an average of ranks is not a rank.
 */
export function blendMatchupIndexes(
  indexes: MatchupIndex[],
  decay = 0.45,
): MatchupIndex {
  const blended = new Map<PositionGroup, Map<string, MatchupEntry>>();
  if (indexes.length === 0) return matchupIndexFrom(blended, 0);

  /** Numeric fields that are means over games and blend directly. */
  const MEANS = [
    'score',
    'baseScore',
    'opponentAdjustedScore',
    'opportunityScore',
    'rawComposite',
    'pointsPerGame',
    'opponentAdjustedPpg',
    'opportunitiesPerGame',
    'efficiencyAllowed',
    'last4',
    'volatility',
    'ceilingRate',
    'floorRate',
    'top10Rate',
  ] as const;

  for (const group of POSITION_GROUPS) {
    const defenses = new Set<string>();
    for (const index of indexes) {
      for (const defense of index.byGroup.get(group)?.keys() ?? []) defenses.add(defense);
    }

    const entries = new Map<string, MatchupEntry>();
    for (const defense of defenses) {
      let weightSum = 0;
      const sums: Record<string, number> = {};
      const breakdown: MatchupBreakdown = {
        base: 0,
        trend: 0,
        ceilingBonus: 0,
        floorPenalty: 0,
        consistencyBonus: 0,
        top10Bonus: 0,
      };
      let games = 0;
      let template: MatchupEntry | undefined;

      indexes.forEach((index, i) => {
        const entry = index.byGroup.get(group)?.get(defense);
        if (!entry) return;
        const weight = decay ** i;
        weightSum += weight;
        if (!template) template = entry;
        for (const key of MEANS) sums[key] = (sums[key] ?? 0) + weight * entry[key];
        for (const key of Object.keys(breakdown) as Array<keyof MatchupBreakdown>) {
          breakdown[key] += weight * entry.breakdown[key];
        }
        /*
         * Games accumulate rather than blend. They are the sample size behind
         * the rating, and the shrinkage in `projectionFactor` reads them as
         * exactly that — a defence seen across three seasons genuinely is
         * better evidenced than one seen across twelve weeks.
         */
        games += entry.games;
      });

      if (!template || weightSum === 0) continue;
      const blend = (key: (typeof MEANS)[number]) => round(sums[key] / weightSum, 3);

      entries.set(defense, {
        ...template,
        defense,
        group,
        score: blend('score'),
        baseScore: blend('baseScore'),
        opponentAdjustedScore: blend('opponentAdjustedScore'),
        opportunityScore: blend('opportunityScore'),
        rawComposite: blend('rawComposite'),
        pointsPerGame: blend('pointsPerGame'),
        opponentAdjustedPpg: blend('opponentAdjustedPpg'),
        opportunitiesPerGame: blend('opportunitiesPerGame'),
        efficiencyAllowed: blend('efficiencyAllowed'),
        last4: blend('last4'),
        volatility: blend('volatility'),
        ceilingRate: blend('ceilingRate'),
        floorRate: blend('floorRate'),
        top10Rate: blend('top10Rate'),
        games,
        rankMostGenerous: 0,
        breakdown: {
          base: round(breakdown.base / weightSum, 1),
          trend: round(breakdown.trend / weightSum, 1),
          ceilingBonus: round(breakdown.ceilingBonus / weightSum, 1),
          floorPenalty: round(breakdown.floorPenalty / weightSum, 1),
          consistencyBonus: round(breakdown.consistencyBonus / weightSum, 1),
          top10Bonus: round(breakdown.top10Bonus / weightSum, 1),
        },
      });
    }

    // Rank 1 = most generous, recomputed over the blended concessions.
    [...entries.values()]
      .sort((a, b) => b.pointsPerGame - a.pointsPerGame)
      .forEach((entry, i) => {
        entry.rankMostGenerous = i + 1;
      });

    blended.set(group, entries);
  }

  return matchupIndexFrom(blended, Math.max(...indexes.map((i) => i.throughWeek)));
}

/**
 * Builds the rating that was knowable before each historical week.
 *
 * A season-wide index is appropriate for today's Analytics table, but using it
 * on Week 4 would leak Week 4 and all later results into that player's chip.
 */
export function buildPregameMatchupIndexes(
  input: MatchupHistoryInput,
  maxWeek: number,
): Map<number, MatchupIndex> {
  const indexes = new Map<number, MatchupIndex>();
  for (let week = 1; week <= maxWeek; week++) {
    indexes.set(
      week,
      buildMatchupIndex({
        ...input,
        throughWeek: week - 1,
      }),
    );
  }
  return indexes;
}
