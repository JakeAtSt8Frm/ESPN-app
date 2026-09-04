/**
 * Finished seasons, reshaped into the week-keyed maps every model here reads.
 *
 * The snapshot writes one file per finished season under `history/` at the repo
 * root, each carrying that year's weekly actuals, the weekly projections that
 * preceded them, and the fixtures needed to name an opponent. They sit outside
 * `public/` because nothing in the browser reads them — see `snapshot.ts`.
 *
 * This module turns those into the same `Map<week, Record<pid, …>>` shapes the
 * in-season code already uses, so a matchup index, a residual fit or a
 * projection model can be built over a past season with exactly the code that
 * builds it over this one.
 *
 * Nothing here reads a file. The reshaping is pure so that the fit scripts, the
 * verification scripts and the browser all agree about what a season *is*, and
 * so the joins below can be tested without a network or a disk.
 *
 * ## Why a season carries its own positions
 *
 * A player's position group is a property of the season, not of the player. Taysom
 * Hill has been listed at three of them; a receiver who takes wildcat snaps gets
 * reclassified; a rookie's listing can change between his draft year and his
 * second season. Scoring a 2023 week under a player's 2026 group would put his
 * points in the wrong pool, quietly biasing both the distribution fit for that
 * pool and the defence ratings built from it. So each season file carries the
 * position ESPN listed that year, and today's universe is only the fallback for
 * a player the file does not name.
 */

import { createScorer, hasPlayed, hasValidProjection, type ScoringModel } from './scoring';
import { ESPN_POSITION_IDS, type PositionGroup, type StatLine } from './types';

/** One finished season, exactly as `history/<year>.json` stores it. */
export interface RawSeasonFile {
  season: number;
  /** pid -> week -> the line he actually recorded. Empty means "played, nothing". */
  actuals: Record<string, Record<string, StatLine>>;
  /** pid -> week -> the line ESPN projected before kickoff. */
  projections: Record<string, Record<string, StatLine>>;
  /** pid -> week -> his NFL team and the defence he faced. */
  games: Record<string, Record<string, { team: string; opp: string }>>;
  /** pid -> ESPN's position id *for that season*. */
  positions: Record<string, number>;
  /** pid -> that season's full-year actual totals. */
  seasonTotals?: Record<string, StatLine>;
}

/** A finished season in the shapes the in-season models already consume. */
export interface SeasonHistory {
  season: number;
  /** week -> pid -> line. */
  weekStats: Map<number, Record<string, StatLine>>;
  weekProjections: Map<number, Record<string, StatLine>>;
  /** week -> pid -> the defence he faced. */
  weekOpponents: Map<number, Record<string, string>>;
  /** week -> pid -> his own NFL team. */
  weekTeams: Map<number, Record<string, string>>;
  /** pid -> the group he was listed at *this* season. */
  groups: Map<string, PositionGroup>;
  /** Highest week with any game log. */
  finalWeek: number;
}

/** One weekly observation: what was expected, and what happened. */
export interface WeeklyPair {
  pid: string;
  group: PositionGroup;
  season: number;
  week: number;
  team: string;
  opponent: string;
  projection: number;
  actual: number;
  /** True when he recorded real participation, even if he scored zero. */
  played: boolean;
}

/**
 * Turns a season file into week-keyed maps.
 *
 * `fallbackGroups` supplies a position for any player the file does not list,
 * and is normally today's universe.
 */
export function reshapeSeason(
  file: RawSeasonFile,
  fallbackGroups?: Map<string, PositionGroup | null>,
): SeasonHistory {
  const weekStats = new Map<number, Record<string, StatLine>>();
  const weekProjections = new Map<number, Record<string, StatLine>>();
  const weekOpponents = new Map<number, Record<string, string>>();
  const weekTeams = new Map<number, Record<string, string>>();
  const groups = new Map<string, PositionGroup>();
  let finalWeek = 0;

  for (const [pid, id] of Object.entries(file.positions ?? {})) {
    const group = ESPN_POSITION_IDS[id];
    if (group) groups.set(pid, group);
  }

  const put = <T>(map: Map<number, Record<string, T>>, week: number, pid: string, value: T) => {
    let bucket = map.get(week);
    if (!bucket) map.set(week, (bucket = {}));
    bucket[pid] = value;
  };

  for (const [pid, byWeek] of Object.entries(file.actuals ?? {})) {
    if (!groups.has(pid)) {
      const fallback = fallbackGroups?.get(pid);
      if (fallback) groups.set(pid, fallback);
    }
    for (const [rawWeek, line] of Object.entries(byWeek)) {
      const week = Number(rawWeek);
      if (!Number.isFinite(week)) continue;
      put(weekStats, week, pid, line);
      if (week > finalWeek) finalWeek = week;

      const game = file.games?.[pid]?.[rawWeek];
      if (!game) continue;
      put(weekOpponents, week, pid, game.opp);
      put(weekTeams, week, pid, game.team);
    }
  }

  for (const [pid, byWeek] of Object.entries(file.projections ?? {})) {
    for (const [rawWeek, line] of Object.entries(byWeek)) {
      const week = Number(rawWeek);
      if (Number.isFinite(week)) put(weekProjections, week, pid, line);
    }
  }

  return { season: file.season, weekStats, weekProjections, weekOpponents, weekTeams, groups, finalWeek };
}

/**
 * Every week in a season where a real projection met a real game log.
 *
 * `minProjection` drops the rows that are ESPN listing a player rather than
 * forecasting one — a projection under a point carries no information and
 * thousands of them would drag every fitted intercept toward zero.
 *
 * A week the player was rostered for and did not appear in is **kept**, with
 * `played: false` and an actual of zero. That zero is most of what a floor is,
 * and a spread fit only over the weeks somebody showed up is not the spread the
 * app needs to report.
 */
export function weeklyPairs(
  history: SeasonHistory,
  scoringModel: ScoringModel,
  minProjection = 1,
): WeeklyPair[] {
  const score = createScorer(scoringModel);
  const pairs: WeeklyPair[] = [];

  for (const [week, projections] of history.weekProjections) {
    const stats = history.weekStats.get(week);
    if (!stats) continue;
    const opponents = history.weekOpponents.get(week) ?? {};
    const teams = history.weekTeams.get(week) ?? {};

    for (const [pid, projLine] of Object.entries(projections)) {
      const group = history.groups.get(pid);
      if (!group) continue;
      if (!hasValidProjection(projLine)) continue;

      const projection = score(projLine, group);
      if (projection < minProjection) continue;

      const statLine = stats[pid];
      if (!statLine) continue;

      pairs.push({
        pid,
        group,
        season: history.season,
        week,
        team: teams[pid] ?? '',
        opponent: opponents[pid] ?? '',
        projection,
        actual: score(statLine, group),
        played: hasPlayed(statLine),
      });
    }
  }

  return pairs;
}

/**
 * A player's per-week scoring level in a season, over the weeks he played.
 *
 * The mean rather than a decayed average, deliberately. This is read across a
 * season boundary containing a draft, free agency and a training camp, and
 * there is no case for week 17 counting five times week 13 when the roster in
 * between was rebuilt. Worse, a decay leans hardest on the most recent week,
 * and the most recent week of an NFL regular season is the one every
 * playoff-bound starter sits out.
 */
export function seasonLevels(
  history: SeasonHistory,
  scoringModel: ScoringModel,
): Map<string, { level: number; games: number; rostered: number; group: PositionGroup }> {
  const score = createScorer(scoringModel);
  const totals = new Map<
    string,
    { points: number; games: number; rostered: number; group: PositionGroup }
  >();

  for (const [, stats] of history.weekStats) {
    for (const [pid, line] of Object.entries(stats)) {
      const group = history.groups.get(pid);
      if (!group) continue;
      let entry = totals.get(pid);
      if (!entry) totals.set(pid, (entry = { points: 0, games: 0, rostered: 0, group }));
      entry.rostered++;
      if (!hasPlayed(line)) continue;
      entry.points += score(line, group);
      entry.games++;
    }
  }

  const out = new Map<
    string,
    { level: number; games: number; rostered: number; group: PositionGroup }
  >();
  for (const [pid, entry] of totals) {
    if (entry.games === 0) continue;
    out.set(pid, {
      level: entry.points / entry.games,
      games: entry.games,
      rostered: entry.rostered,
      group: entry.group,
    });
  }
  return out;
}

/**
 * A finished season's headline production, in exactly the terms the rank chips
 * report: total points, points per game, and boom rate.
 *
 * This exists so the chips have something to say in September. `buildValueIndex`
 * computes the same three numbers over the season in progress, and in week one
 * that season is empty — every row reads "Total — | PPG — | BR —", which is the
 * correct answer to a question nobody asked. The last finished season is the
 * honest stand-in, and it is the one number a manager is actually drafting on.
 *
 * It is computed *here*, in Node, rather than in the browser, because boom rate
 * needs the weekly projection that preceded each game and only `history/` carries
 * it. `history.json` ships the actuals alone; adding a season of projections to
 * it would roughly double a 930KB payload to serve one chip. See `fit-priors.ts`,
 * which distils this into `priors.json` at a few bytes per player.
 *
 * Every gate matches `buildValueIndex` exactly — an unplayed week is not a game,
 * and a week without a real projection cannot boom — so the two sources of the
 * same three numbers can never disagree about what they mean.
 */
export interface SeasonProduction {
  /** The group he was listed at *this* season, which is what scored his weeks. */
  group: PositionGroup;
  total: number;
  /** Weeks he recorded real participation. */
  games: number;
  /** Weeks he cleared the boom threshold. */
  boom: number;
  /** Weeks a real projection preceded — the denominator boom rate is over. */
  projectedGames: number;
}

export function seasonProduction(
  history: SeasonHistory,
  scoringModel: ScoringModel,
  boomPct: number,
): Map<string, SeasonProduction> {
  const score = createScorer(scoringModel);
  const out = new Map<string, SeasonProduction>();

  for (const [week, stats] of history.weekStats) {
    const projections = history.weekProjections.get(week) ?? {};

    for (const [pid, line] of Object.entries(stats)) {
      const group = history.groups.get(pid);
      if (!group) continue;
      if (!hasPlayed(line)) continue;

      let entry = out.get(pid);
      if (!entry) {
        out.set(pid, (entry = { group, total: 0, games: 0, boom: 0, projectedGames: 0 }));
      }

      const actual = score(line, group);
      entry.total += actual;
      entry.games += 1;

      // Projection-derived signals only count where a real projection exists,
      // otherwise every unprojected week would register as a boom.
      const projLine = projections[pid];
      if (!hasValidProjection(projLine)) continue;
      const projected = score(projLine, group);
      if (projected <= 0) continue;

      entry.projectedGames += 1;
      if (actual >= projected * boomPct) entry.boom += 1;
    }
  }

  return out;
}
