/**
 * Forecast and simulation selectors.
 *
 * The models live in `lib/forecast.ts` and `lib/simulate.ts`; this file is the
 * seam where they meet real league data — picking the right lineup, the right
 * week's projections and the right slice of schedule, and memoizing the result
 * so a Monte Carlo run happens once per season load rather than once per render.
 */

import { buildWeekForecast, type PlayerForecast } from '../lib/forecast';
import { computeOptimalLineup } from '../lib/optimal';
import {
  simulateSeason,
  simulateWeek,
  type SeasonSimulation,
  type SimTeam,
  type WeekSimulation,
} from '../lib/simulate';
import type { EnrichedPlayer, Matchup, PositionGroup } from '../lib/types';
import { buildRosterWeek } from './selectors';
import { isOut, type LeagueData } from './league';

/**
 * `live` lets results that already exist stand, and samples only what is left
 * to play. `pregame` ignores results entirely — the honest way to ask "what
 * were the odds before kickoff", which is the only interesting question about a
 * week that has already finished.
 */
export type ForecastMode = 'live' | 'pregame';

/** LeagueData is immutable once loaded, so every derived result is cacheable. */
const cache = new WeakMap<LeagueData, Map<string, unknown>>();

function memo<T>(data: LeagueData, key: string, build: () => T): T {
  let store = cache.get(data);
  if (!store) {
    store = new Map();
    cache.set(data, store);
  }
  if (store.has(key)) return store.get(key) as T;
  const value = build();
  store.set(key, value);
  return value;
}

export function weekForecasts(
  data: LeagueData,
  week: number,
  mode: ForecastMode = 'live',
): Map<string, PlayerForecast> {
  return memo(data, `forecast:${week}:${mode}`, () => {
    const weekData = data.weeks.get(week);

    /*
     * Injury status is reported as of *now*, not as of the week being viewed,
     * so applying it to a historical week would mark players out in weeks they
     * demonstrably played. It only carries information from the live week on.
     */
    const liveWeek = week >= data.liveWeek;
    const matchupIndex = data.pregameMatchupIndexes.get(week) ?? data.matchupIndex;
    const matchupFactors = new Map<string, number>();
    for (const pid of Object.keys(weekData?.projections ?? {})) {
      const group = data.playersById.get(pid)?.group ?? null;
      const opponent = weekData?.opponents[pid];
      matchupFactors.set(pid, matchupIndex.projectionFactor(group, opponent));
    }

    return buildWeekForecast({
      model: data.residualModel,
      scoringModel: data.scoringModel,
      playersById: data.playersById,
      projections: weekData?.projections ?? {},
      stats: mode === 'live' ? weekData?.stats : undefined,
      teams: weekData?.teams,
      isOut: liveWeek ? (pid) => isOut(data.playersById.get(pid)) : undefined,
      matchupFactors,
      /*
       * Only the week about to be played has had its inactive list published.
       * Every later week is forecast from a projection that cannot know who
       * will be fit, and carries the measured forward availability instead of
       * the near-certainty a same-week projection implies. A week already in
       * the past is `live` too — its results are known, so nothing is being
       * guessed about attendance.
       */
      horizon: week > data.liveWeek ? 'forward' : 'live',
      // Everyone projected, not just starters: the player sheet opens on free
      // agents too, and building the extra rows is a few milliseconds of
      // arithmetic against data already in memory.
    });
  });
}

/** Which point estimate should drive a forward-looking lineup decision. */
export type ProjectionSource = 'app' | 'espn';

/** A results view uses recorded scores even when this roster has not played yet. */
export function actualOptimalLineup(
  slots: string[],
  roster: readonly Pick<EnrichedPlayer, 'pid' | 'group' | 'slot' | 'act'>[],
) {
  return computeOptimalLineup(slots, roster
    .filter((player) => player.slot.toUpperCase() !== 'IR')
    .map((player) => ({ pid: player.pid, group: player.group, points: player.act })));
}

export interface ProjectedPlayer {
  pid: string;
  group: PositionGroup | null;
  slot: string;
  proj: number;
}

/**
 * The app's player-level projection when the learned forecast is available.
 *
 * This is the bias- and matchup-adjusted **median** used in the player sheet,
 * and the median is the right shape for a single player: absolute error is
 * minimised by it, and a weekly fantasy score is skewed far enough that its
 * mean sits well above the outcome you should actually expect to see.
 *
 * A known absence is zero for lineup purposes even though the sheet retains the
 * conditional "if he plays" median as useful player context.
 */
export function appProjectionFor(
  player: ProjectedPlayer,
  forecasts: ReadonlyMap<string, PlayerForecast>,
): number | null {
  const forecast = forecasts.get(player.pid);
  if (!forecast) return null;
  return forecast.playProb <= 0 ? 0 : forecast.median;
}

/**
 * The app's expected points for a player — the mean, not the median.
 *
 * Used wherever player scores are **added up**, which is a different question
 * from what to print on his row.
 *
 * Medians do not add. The median of a sum is not the sum of the medians, and
 * for nine right-skewed variables the difference is not academic: every one of
 * those medians sits below its own mean, and stacking nine of them produced a
 * lineup total roughly a tenth under ESPN's for a team where no individual
 * player was being called low. Expectation *does* add, exactly, whatever the
 * shape and however correlated the players are — so a total built from means is
 * unbiased where one built from medians is guaranteed not to be.
 *
 * It is also the right quantity for choosing a lineup, because the thing being
 * maximised is the total, and the lineup that maximises an expected total is
 * the one that ranks its candidates by expected points.
 *
 * `mean` already prices in the chance he does not appear, so a player who is
 * out contributes zero here without any special case.
 */
export function appExpectedFor(
  player: ProjectedPlayer,
  forecasts: ReadonlyMap<string, PlayerForecast>,
): number | null {
  const forecast = forecasts.get(player.pid);
  if (!forecast) return null;
  return forecast.playProb <= 0 ? 0 : forecast.mean;
}

/**
 * One player's score under the selected projection source. ESPN is the
 * fallback when the app has no usable fit, so an unavailable model can never
 * make a legal lineup look artificially empty.
 *
 * `statistic` picks between the two above: `median` for what a row displays,
 * `expected` for anything that sums or ranks. ESPN publishes one number and it
 * is used for both.
 */
export function projectedPlayerScore(
  player: ProjectedPlayer,
  forecasts: ReadonlyMap<string, PlayerForecast>,
  source: ProjectionSource,
  statistic: 'median' | 'expected' = 'median',
): number {
  if (source !== 'app') return player.proj;
  const value =
    statistic === 'expected'
      ? appExpectedFor(player, forecasts)
      : appProjectionFor(player, forecasts);
  return value ?? player.proj;
}

/**
 * Expected points over a submitted lineup.
 *
 * Sums expectations rather than medians — see `appExpectedFor` for why that is
 * a correctness fix and not a preference.
 */
export function projectedLineupTotal(
  starters: readonly ProjectedPlayer[],
  forecasts: ReadonlyMap<string, PlayerForecast>,
  source: ProjectionSource,
): number {
  const total = starters.reduce(
    (sum, player) => sum + projectedPlayerScore(player, forecasts, source, 'expected'),
    0,
  );
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

/**
 * Best legal lineup under either the app or ESPN point estimate.
 *
 * Ranked on expected points, because what the lineup maximises is a *total* and
 * the lineup that maximises an expected total is the one that ranks its
 * candidates by expectation. Ranking on medians is not merely a different
 * convention: a player with a 15% chance of not appearing has a median that
 * ignores that risk entirely, so the solver would happily start him over a
 * durable player of equal median.
 */
export function projectedOptimalLineup(
  slots: string[],
  roster: readonly ProjectedPlayer[],
  forecasts: ReadonlyMap<string, PlayerForecast>,
  source: ProjectionSource,
): ReturnType<typeof computeOptimalLineup> {
  return computeOptimalLineup(
    slots,
    roster
      .filter((player) => player.slot.toUpperCase() !== 'IR')
      .map((player) => ({
        pid: player.pid,
        group: player.group,
        points: projectedPlayerScore(player, forecasts, source, 'expected'),
      })),
  );
}

/**
 * A week's head-to-head pairs.
 *
 * ESPN already publishes the schedule paired, so unlike a feed that emits one
 * row per team this only has to drop the byes — a matchup with no away side,
 * which happens in a bracket with an odd number of teams left.
 */
function pairingsOf(matchups: Matchup[]): Array<{ matchupId: number; teamIds: [number, number] }> {
  return matchups
    .filter((m) => m.awayTeamId !== null)
    .map((m) => ({
      matchupId: m.matchupId,
      teamIds: [m.homeTeamId, m.awayTeamId as number] as [number, number],
    }));
}

function simTeams(
  data: LeagueData,
  week: number,
  mode: ForecastMode,
  optimizeLineup = false,
): SimTeam[] {
  const forecasts = weekForecasts(data, week, mode);
  return data.teams.map((team) => {
    const rosterWeek = buildRosterWeek(data, team.teamId, week);
    const roster = rosterWeek?.all ?? [];
    const starterIds = optimizeLineup
      ? new Set(
          computeOptimalLineup(
            data.starterSlots,
            roster
              .filter((player) => player.slot.toUpperCase() !== 'IR')
              .flatMap((player) => {
                const forecast = forecasts.get(player.pid);
                return forecast
                  ? [{ pid: player.pid, group: player.group, points: forecast.mean }]
                  : [];
              }),
          ).assignments.flatMap((assignment) =>
            assignment.pid === null ? [] : [assignment.pid],
          ),
        )
      : null;
    const selected = optimizeLineup
      ? roster.filter((player) => starterIds?.has(player.pid))
      : (rosterWeek?.starters ?? []);

    return {
      teamId: team.teamId,
      starters: selected.flatMap((player) => {
        const forecast = forecasts.get(player.pid);
        return forecast ? [forecast] : [];
      }),
    };
  });
}

/**
 * Win probability for one week's head-to-head games.
 *
 * Returns null when the week has no paired matchups — a playoff bye week, or a
 * season that hasn't been scheduled yet.
 */
export function weekOdds(
  data: LeagueData,
  week: number,
  mode: ForecastMode = 'live',
): WeekSimulation | null {
  return memo(data, `weekOdds:${week}:${mode}`, () => {
    const pairings = pairingsOf(data.scheduleByWeek.get(week) ?? []);
    if (!pairings.length) return null;

    return simulateWeek({
      teams: simTeams(data, week, mode),
      model: data.residualModel,
      pairings,
      // Seeded off the week so two weeks don't share a sample path, but a given
      // week always returns the same numbers.
      seed: 0x5c1a + week,
    });
  });
}

/**
 * Whether a week's games are all finished.
 *
 * Scoped to the players this league actually started. Asking the question of
 * every projected player in the NFL would never answer yes: a few hundred carry
 * a projection and are then inactive on any given Sunday, so the week would look
 * permanently in progress and every finished game would render as a 100%/0%
 * "live" probability, which is a result, not a forecast.
 */
export function weekIsComplete(data: LeagueData, week: number): boolean {
  let started = 0;

  for (const team of data.teams) {
    const rosterWeek = buildRosterWeek(data, team.teamId, week);
    for (const player of rosterWeek?.starters ?? []) {
      started++;
      // Still to play: on the field, projected, and no stat line yet.
      if (!player.hasPlayed && !player.isOut && player.proj > 0) return false;
    }
  }

  return started > 0;
}

/**
 * Playoff, seed and title odds as of the start of `fromWeek`.
 *
 * Record and points carried in are the real ones through `fromWeek - 1`; every
 * week from there to the end of the regular season is simulated, then the
 * bracket is resolved under the league's own playoff format.
 */
export function seasonOdds(data: LeagueData, fromWeek: number): SeasonSimulation | null {
  return memo(data, `seasonOdds:${fromWeek}`, () => {
    const { regularSeasonWeeks, teams: playoffTeams } = data.playoff;

    // Banked record: replay every completed week before the starting point.
    const standing = new Map(
      data.teams.map((team) => [
        team.teamId,
        { wins: 0, losses: 0, ties: 0, pointsFor: 0 },
      ]),
    );

    for (let week = 1; week < Math.min(fromWeek, regularSeasonWeeks + 1); week++) {
      const matchups = (data.scheduleByWeek.get(week) ?? []).filter((m) => m.complete);
      for (const matchup of matchups) {
        if (matchup.awayTeamId === null) continue;
        const a = matchup.homeTeamId;
        const b = matchup.awayTeamId;
        const scoreA = matchup.homeScore;
        const scoreB = matchup.awayScore;
        const recordA = standing.get(a);
        const recordB = standing.get(b);
        if (!recordA || !recordB) continue;

        recordA.pointsFor += scoreA;
        recordB.pointsFor += scoreB;
        if (scoreA > scoreB) {
          recordA.wins++;
          recordB.losses++;
        } else if (scoreB > scoreA) {
          recordB.wins++;
          recordA.losses++;
        } else {
          recordA.ties++;
          recordB.ties++;
        }
      }
    }

    const remaining: Array<{ week: number; pairings: Array<[number, number]> }> = [];
    for (let week = fromWeek; week <= regularSeasonWeeks; week++) {
      const pairings = pairingsOf(data.scheduleByWeek.get(week) ?? []).map(
        ({ teamIds }) => teamIds,
      );
      if (pairings.length) remaining.push({ week, pairings });
    }

    /* Future weeks use that week's ESPN projection and NFL opponent, with the
     * best legal projected lineup from the roster available in the snapshot.
     * That prevents a bye-week starter from being treated as an intentional
     * zero months before the manager can submit the real lineup. */
    const referenceWeek = Math.max(1, Math.min(fromWeek, data.liveWeek));
    const teams = simTeams(data, referenceWeek, 'pregame', true);
    if (teams.every((team) => team.starters.length === 0)) return null;

    const playoffWeeks = Array.from(
      { length: Math.max(0, data.maxWeek - regularSeasonWeeks) },
      (_, index) => regularSeasonWeeks + index + 1,
    );
    const forecastWeeks = new Set([
      ...remaining.map(({ week }) => week),
      ...playoffWeeks,
    ]);
    const weeklyTeams = new Map<number, SimTeam[]>();
    for (const forecastWeek of forecastWeeks) {
      const projected = simTeams(data, forecastWeek, 'pregame', true);
      if (projected.some((team) => team.starters.length > 0)) {
        weeklyTeams.set(forecastWeek, projected);
      }
    }

    return simulateSeason({
      teams,
      weeklyTeams,
      model: data.residualModel,
      standing,
      remaining,
      playoffTeams,
      // ESPN's playoff rounds are one week each in this league.
      weeksPerRound: 1,
      playoffWeeks,
      seed: 0x9e37 + fromWeek,
    });
  });
}
