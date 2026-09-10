/**
 * Selectors that turn raw league data into the view models the pages render.
 *
 * Keeping this separate from the components means the same enriched shape backs
 * the roster page, the optimal-lineup view, history and the player browser — so
 * a player's Value Score and boom/bust classification can never disagree
 * between two screens.
 */

import { hasPlayed } from '../lib/scoring';
import { classifyStatus } from '../lib/status';
import { computeOptimalLineup, lineupEfficiency, slotAccepts } from '../lib/optimal';
import { POSITION_GROUPS, type EnrichedPlayer, type PositionGroup, type StatLine } from '../lib/types';
import { isOut, playerName, type LeagueData, type TeamInfo } from './league';

export interface RosterWeek {
  team: TeamInfo;
  week: number;
  starters: EnrichedPlayer[];
  bench: EnrichedPlayer[];
  injured: EnrichedPlayer[];
  all: EnrichedPlayer[];
  projectedTotal: number;
  actualTotal: number;
  optimalTotal: number;
  efficiency: number;
  optimalLineup: ReturnType<typeof computeOptimalLineup>;
  /** True when the lineup shown is today's rather than the week's own. */
  lineupIsCurrent: boolean;
}

/**
 * LeagueData is immutable after loading, so a team/week result can be reused
 * across Teams, Optimal, History, heatmaps and Analytics. In particular this
 * avoids rerunning the lineup matcher on every visit.
 */
const rosterWeekCache = new WeakMap<LeagueData, Map<string, RosterWeek | null>>();

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Enriches one player for one week with everything the UI needs. */
export function enrichPlayer(
  data: LeagueData,
  pid: string,
  week: number,
  slot: string,
  isStarter: boolean,
): EnrichedPlayer {
  const weekData = data.weeks.get(week);
  const statLine: StatLine | undefined = weekData?.stats[pid];
  const projLine: StatLine | undefined = weekData?.projections[pid];

  const player = data.playersById.get(pid);
  const group = player?.group ?? null;
  const playerTeam = (weekData?.teams[pid] ?? player?.team ?? '').toUpperCase();

  /*
   * A bye is an absence, not a zero. ESPN publishes no game entry for a team on
   * its bye, so `opponents` has no key — which is how the app tells "resting"
   * apart from "played and did nothing", and why a bye never counts against a
   * player's per-week averages.
   */
  const hasGame = weekData ? pid in weekData.opponents : false;
  const opponent = weekData?.opponents[pid] ?? null;
  const onBye = Boolean(player?.team) && weekData !== undefined && !hasGame;

  const proj = data.score(projLine, group);
  const act = data.score(statLine, group);
  const played = hasPlayed(statLine);

  const matchupIndex = data.pregameMatchupIndexes.get(week) ?? data.matchupIndex;
  const matchupScore = matchupIndex.get(group, opponent)?.score ?? null;

  return {
    pid,
    player: player ?? {
      playerId: pid,
      name: `Player ${pid}`,
      firstName: '',
      lastName: '',
      group: null,
      team: null,
      proTeamId: 0,
      eligibleSlots: [],
      injuryStatus: null,
      injured: false,
      active: false,
      percentOwned: null,
      percentStarted: null,
      averageDraftPosition: null,
      auctionValueAverage: null,
      positionalRank: null,
      seasonOutlook: null,
      byeWeek: null,
    },
    name: playerName(player, pid),
    team: playerTeam,
    group,
    slot,
    isStarter,
    proj,
    act,
    hasPlayed: played,
    status: onBye
      ? { label: 'Not Played', tone: 'var(--tone-idle)' }
      : classifyStatus(proj, act, played, matchupScore),
    opponent,
    /*
     * ESPN reports a player's injury status as of *now*, not as of the week
     * being viewed. Applying it verbatim to a past week produces nonsense — a
     * player who scored 25 in week 12 listed under "Out" because he happens to
     * be on IR today. If he recorded stats that week, he plainly was not out.
     */
    isOut: isOut(player) && !played,
    onBye,
    seasonTotal: data.valueIndex.seasonTotals.get(pid) ?? 0,
    valueScore: data.combinedScores.get(pid) ?? null,
    matchupScore,
    ppgRank: data.ranks.ppg.get(pid) ?? null,
    totalRank: data.ranks.total.get(pid) ?? null,
    boomRateRank: data.ranks.boomRate.get(pid) ?? null,
    /*
     * The season the three ranks above describe, when it is not this one — the
     * chips report last season until this one has been played, and a "#4 PPG"
     * with no year on it is read as current by everybody.
     */
    rankSeason: data.ranks.fromPrior ? data.ranks.season : null,
  };
}

/**
 * Builds the full view of one team's week.
 *
 * The lineup comes from that week's own boxscore rather than from the team's
 * current roster. The distinction is the entire point of the History and
 * Optimal pages: the roster reflects today, and reading it back over week 3
 * would silently rewrite what was started every time somebody makes a move.
 * Weeks that have not been played have no boxscore lineup of their own, and
 * fall back to today's — which for an upcoming week is the right answer.
 */
export function buildRosterWeek(
  data: LeagueData,
  teamId: number,
  week: number,
): RosterWeek | null {
  let dataCache = rosterWeekCache.get(data);
  if (!dataCache) {
    dataCache = new Map();
    rosterWeekCache.set(data, dataCache);
  }

  const cacheKey = `${teamId}:${week}`;
  if (dataCache.has(cacheKey)) return dataCache.get(cacheKey) ?? null;

  const team = data.teamsById.get(teamId);
  if (!team) {
    dataCache.set(cacheKey, null);
    return null;
  }

  const weekLineup = data.weeks.get(week)?.lineups[String(teamId)];
  const lineupIsCurrent = !weekLineup || Object.keys(weekLineup).length === 0;
  const slots = lineupIsCurrent ? team.slots : weekLineup;

  const starters: EnrichedPlayer[] = [];
  const benchAll: EnrichedPlayer[] = [];

  for (const [pid, slot] of Object.entries(slots)) {
    const upper = slot.toUpperCase();
    const isBench = upper === 'BN' || upper === 'IR';
    const enriched = enrichPlayer(data, pid, week, slot, !isBench);
    if (isBench) benchAll.push(enriched);
    else starters.push(enriched);
  }

  // Starters read in lineup-card order rather than roster order.
  const slotOrder = new Map(data.starterSlots.map((s, i) => [s, i]));
  starters.sort(
    (a, b) =>
      (slotOrder.get(a.slot) ?? 99) - (slotOrder.get(b.slot) ?? 99) || b.proj - a.proj,
  );

  const injured = benchAll.filter((p) => p.slot.toUpperCase() === 'IR');
  const bench = benchAll.filter((p) => p.slot.toUpperCase() !== 'IR').sort(sortByImpact);

  const projectedTotal = round2(starters.reduce((s, p) => s + p.proj, 0));
  const actualTotal = round2(starters.reduce((s, p) => s + p.act, 0));

  /*
   * The optimal lineup is measured against what actually happened, so it is
   * scored on actuals for a week that has been played and on projections for
   * one that has not — asking "what was the best I could have done" of a week
   * with no results would rank everyone at zero.
   */
  const played = starters.some((p) => p.hasPlayed) || benchAll.some((p) => p.hasPlayed);
  const pool = [...starters, ...benchAll]
    // A player on IR cannot be started, so he is not a missed opportunity.
    .filter((p) => p.slot.toUpperCase() !== 'IR')
    .map((p) => ({ pid: p.pid, group: p.group, points: played ? p.act : p.proj }));
  const optimalLineup = computeOptimalLineup(data.starterSlots, pool);

  const result: RosterWeek = {
    team,
    week,
    starters,
    bench,
    injured: injured.sort(sortByImpact),
    all: [...starters, ...benchAll],
    projectedTotal,
    actualTotal,
    optimalTotal: optimalLineup.total,
    efficiency: lineupEfficiency(played ? actualTotal : projectedTotal, optimalLineup.total),
    optimalLineup,
    lineupIsCurrent,
  };

  dataCache.set(cacheKey, result);
  return result;
}

/** Bench ordering: whoever most deserved a start appears first. */
function sortByImpact(a: EnrichedPlayer, b: EnrichedPlayer): number {
  return b.act - a.act || b.proj - a.proj || (b.valueScore ?? 0) - (a.valueScore ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Heatmap data                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Heatmap columns.
 *
 * `FLEX` is a slot rather than a position group, pulled out so a team's
 * dedicated running backs and receivers read separately from whoever they chose
 * to flex — which in a league with one flex and no superflex is the only
 * lineup decision with any freedom in it. It therefore only carries points in
 * the starters view; in the full-roster view there are no slots, so it stays
 * empty and the column hides itself.
 */
export type HeatmapColumn = PositionGroup | 'FLEX';
export const HEATMAP_COLUMNS: HeatmapColumn[] = [...POSITION_GROUPS, 'FLEX'];

export interface HeatmapRow {
  teamId: number;
  name: string;
  byGroup: Record<HeatmapColumn, number>;
  total: number;
}

export type HeatmapScope = 'starters' | 'all';
export type HeatmapMetric = 'projected' | 'actual';

function emptyColumns(): Record<HeatmapColumn, number> {
  return Object.fromEntries(HEATMAP_COLUMNS.map((c) => [c, 0])) as Record<
    HeatmapColumn,
    number
  >;
}

/** Builds one heatmap: a team x position grid of scored points. */
export function buildHeatmap(
  data: LeagueData,
  week: number,
  scope: HeatmapScope,
  metric: HeatmapMetric,
): HeatmapRow[] {
  const weekData = data.weeks.get(week);

  const scoreOf = (pid: string) => {
    const line = metric === 'actual' ? weekData?.stats[pid] : weekData?.projections[pid];
    return data.score(line, data.playersById.get(pid)?.group ?? null);
  };

  return data.teams.map((team) => {
    const weekLineup = weekData?.lineups[String(team.teamId)];
    const slots = weekLineup && Object.keys(weekLineup).length > 0 ? weekLineup : team.slots;
    const byGroup = emptyColumns();

    for (const [pid, rawSlot] of Object.entries(slots)) {
      const slot = rawSlot.toUpperCase();
      const isBench = slot === 'BN' || slot === 'IR';

      if (scope === 'starters') {
        if (isBench) continue;
        if (slot === 'FLEX') {
          byGroup.FLEX += scoreOf(pid);
          continue;
        }
      }

      const group = data.playersById.get(pid)?.group;
      if (group) byGroup[group] += scoreOf(pid);
    }

    let total = 0;
    for (const c of HEATMAP_COLUMNS) {
      byGroup[c] = round2(byGroup[c]);
      total += byGroup[c];
    }

    return { teamId: team.teamId, name: team.name, byGroup, total: round2(total) };
  });
}

/**
 * Turns a points heatmap into a rank heatmap: each cell becomes the team's rank
 * in that column for the week (1 = highest). Ties share a rank. Columns where
 * nobody scored stay at 0 so they hide, exactly as in the points grid, keeping
 * the two heatmaps the same shape and size.
 */
export function buildRankHeatmap(rows: HeatmapRow[]): HeatmapRow[] {
  const rankOf = (value: number, values: number[]) =>
    1 + values.filter((v) => v > value).length;

  const columnActive = HEATMAP_COLUMNS.map(
    (c) => [c, rows.some((r) => r.byGroup[c] !== 0)] as const,
  );
  const totalActive = rows.some((r) => r.total !== 0);

  return rows.map((row) => {
    const byGroup = emptyColumns();
    for (const [c, active] of columnActive) {
      if (!active) continue;
      byGroup[c] = rankOf(
        row.byGroup[c],
        rows.map((r) => r.byGroup[c]),
      );
    }
    const total = totalActive
      ? rankOf(
          row.total,
          rows.map((r) => r.total),
        )
      : 0;
    return { teamId: row.teamId, name: row.name, byGroup, total };
  });
}

/* -------------------------------------------------------------------------- */
/* Ownership                                                                   */
/* -------------------------------------------------------------------------- */

export interface RosterOwner {
  teamId: number;
  name: string;
}

/** Current fantasy-roster owner for every rostered player. */
export function rosterOwnerByPlayer(teams: readonly TeamInfo[]): Map<string, RosterOwner> {
  const owners = new Map<string, RosterOwner>();

  for (const team of teams) {
    const owner = { teamId: team.teamId, name: team.name };
    for (const pid of team.players) owners.set(pid, owner);
  }

  return owners;
}

/** Every player id currently rostered by anybody in the league. */
export function rosteredIds(data: LeagueData): Set<string> {
  return new Set(rosterOwnerByPlayer(data.teams).keys());
}

/**
 * Available free agents, best first.
 *
 * Ranked by Trade Points rather than the Value Score. This list is unfiltered
 * across positions by default, and the Value Score is a within-position
 * percentile — sorting the whole pool by it puts the best available kicker
 * above most startable receivers, because 971 of 1000 is what "best kicker
 * alive" looks like in that currency.
 */
export function freeAgents(data: LeagueData, group: PositionGroup | 'ALL'): EnrichedPlayer[] {
  const owned = rosteredIds(data);
  const out: EnrichedPlayer[] = [];

  for (const [pid] of data.playersById) {
    if (owned.has(pid)) continue;
    const playerGroup = data.playersById.get(pid)?.group ?? null;
    if (!playerGroup || (group !== 'ALL' && playerGroup !== group)) continue;
    out.push(enrichPlayer(data, pid, data.liveWeek, playerGroup, false));
  }

  const points = (p: EnrichedPlayer) => data.tradeValues.byPlayer.get(p.pid)?.points ?? 0;
  return out.sort((a, b) => points(b) - points(a));
}

/** Players on a roster that are eligible for a given slot. */
export function eligibleFor(players: EnrichedPlayer[], slot: string): EnrichedPlayer[] {
  return players.filter((p) => slotAccepts(slot, p.group));
}
