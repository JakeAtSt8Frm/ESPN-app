/**
 * Forward-looking roster power derived from the app's headline Value Score.
 *
 * Each position is starter-led, with a small contribution from a fixed number
 * of backups. Overall power weights those position scores by starter slots so
 * the league's larger position groups matter proportionally more.
 */

import { mean } from './stats';
import { POSITION_GROUPS, type PositionGroup } from './types';

export const POSITION_BENCH_WEIGHT = 0.15;
export const POSITION_STARTER_WEIGHT = 1 - POSITION_BENCH_WEIGHT;

/**
 * How deep a room has to be at each position before extra bodies stop counting.
 *
 * Starters follow the league's own lineup card, with one adjustment: RB and WR
 * each carry a third starter rather than their nominal two, because the single
 * FLEX is filled from those two groups virtually every week and a team that
 * cannot field a third of either is genuinely thin. Counting the flex once for
 * each is deliberate — it measures whether the room *can* fill the slot, which
 * is the question a power ranking is asking.
 *
 * Kicker and defence carry no bench at all. Nobody rosters two, and pretending
 * a spare kicker is depth would reward a wasted roster spot.
 */
export const POSITION_POWER_COUNTS = {
  QB: { starters: 1, bench: 1 },
  RB: { starters: 3, bench: 2 },
  WR: { starters: 3, bench: 2 },
  TE: { starters: 1, bench: 1 },
  K: { starters: 1, bench: 0 },
  DST: { starters: 1, bench: 0 },
} as const satisfies Record<PositionGroup, { starters: number; bench: number }>;

const TOTAL_STARTER_SLOTS = POSITION_GROUPS.reduce(
  (total, group) => total + POSITION_POWER_COUNTS[group].starters,
  0,
);

export interface PowerPlayer {
  pid: string;
  /** Headline Value Score on the app's 0–1000 scale. */
  value: number;
  /** Rank by Value Score within the position, 1 = best. */
  rank: number;
}

export interface PowerGroup {
  group: PositionGroup;
  /** Number of players that form the starter core for this position. */
  slots: number;
  starters: PowerPlayer[];
  depth: PowerPlayer[];
  /** Configured starter places without a rated player. */
  unfilledSlots: number;
  /** Average Value of the configured starters, with missing places at zero. */
  coreAverage: number;
  /** Average Value of the configured backups, with missing places at zero. */
  benchAverage: number;
  /** 85% starter Value and 15% backup Value. */
  score: number;
}

export interface TeamPower {
  teamId: number;
  /** Value-based position scores weighted by the number of starter slots. */
  overall: number;
  byGroup: Record<PositionGroup, PowerGroup>;
}

export interface PowerRosterInput {
  teamId: number;
  /**
   * Every player the team holds — starters, bench, taxi and reserve.
   *
   * ESPN may list an injured player in both `players` and `reserve`, so ids
   * are de-duplicated before power is calculated.
   */
  playerIds: Iterable<string>;
}

export interface PowerPlayerInput {
  group: PositionGroup;
  /** Null when the app cannot calculate a headline Value Score. */
  value: number | null;
}

export interface BuildPowerIndexInput {
  rosters: PowerRosterInput[];
  players: Map<string, PowerPlayerInput>;
}

export interface PowerIndex {
  byTeam: Map<number, TeamPower>;
  /** Configured starter count for each position. */
  slotsByGroup: Map<PositionGroup, number>;
  /** Rostered players at each position, best Value Score first. */
  ladderByGroup: Map<PositionGroup, PowerPlayer[]>;
}

function fixedSizeMean(values: number[], count: number): number {
  if (count <= 0) return 0;
  const selected = values.slice(0, count);
  while (selected.length < count) selected.push(0);
  return mean(selected);
}

export function positionRoomScore(
  values: number[],
  group: PositionGroup,
): { coreAverage: number; benchAverage: number; score: number } {
  const ranked = values
    .filter(Number.isFinite)
    .map((value) => Math.max(0, value))
    .sort((a, b) => b - a);
  const counts = POSITION_POWER_COUNTS[group];
  const coreAverage = fixedSizeMean(ranked, counts.starters);
  const benchAverage = fixedSizeMean(
    ranked.slice(counts.starters),
    counts.bench,
  );

  /*
   * A position with no configured bench is scored on its starters alone.
   *
   * Kicker and defence are that case: nobody rosters a backup, so counting one
   * would score an empty bench as a zero and cap both positions at 85% of
   * whatever they are actually worth — permanently, for every team, which then
   * drags Overall down by the same amount for everyone while quietly
   * under-weighting the two positions against the rest of the roster.
   */
  const score =
    counts.bench > 0
      ? coreAverage * POSITION_STARTER_WEIGHT + benchAverage * POSITION_BENCH_WEIGHT
      : coreAverage;

  return { coreAverage, benchAverage, score };
}

export function buildPowerIndex(input: BuildPowerIndexInput): PowerIndex {
  const rosters = input.rosters.map((roster) => ({
    teamId: roster.teamId,
    playerIds: [...new Set(roster.playerIds)],
  }));
  const slotsByGroup = new Map(
    POSITION_GROUPS.map((group) => [
      group,
      POSITION_POWER_COUNTS[group].starters,
    ]),
  );

  const rostered = new Map<PositionGroup, Array<{ pid: string; value: number }>>();
  for (const roster of rosters) {
    for (const pid of roster.playerIds) {
      const player = input.players.get(pid);
      if (!player || player.value === null || !Number.isFinite(player.value)) {
        continue;
      }
      const bucket = rostered.get(player.group) ?? [];
      bucket.push({ pid, value: Math.max(0, player.value) });
      rostered.set(player.group, bucket);
    }
  }

  const ladderByGroup = new Map<PositionGroup, PowerPlayer[]>();
  const rankByPid = new Map<string, number>();
  for (const group of POSITION_GROUPS) {
    const ladder = (rostered.get(group) ?? [])
      .sort((a, b) => b.value - a.value || a.pid.localeCompare(b.pid))
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
    for (const entry of ladder) rankByPid.set(entry.pid, entry.rank);
    ladderByGroup.set(group, ladder);
  }

  const byTeam = new Map<number, TeamPower>();
  for (const roster of rosters) {
    const heldByGroup = new Map<PositionGroup, PowerPlayer[]>();
    for (const pid of roster.playerIds) {
      const player = input.players.get(pid);
      if (!player || player.value === null || !Number.isFinite(player.value)) {
        continue;
      }
      const bucket = heldByGroup.get(player.group) ?? [];
      bucket.push({
        pid,
        value: Math.max(0, player.value),
        rank: rankByPid.get(pid) ?? 0,
      });
      heldByGroup.set(player.group, bucket);
    }

    const byGroup = {} as Record<PositionGroup, PowerGroup>;
    for (const group of POSITION_GROUPS) {
      const counts = POSITION_POWER_COUNTS[group];
      const ranked = (heldByGroup.get(group) ?? []).sort(
        (a, b) => b.value - a.value || a.pid.localeCompare(b.pid),
      );
      const starters = ranked.slice(0, counts.starters);
      const depth = ranked.slice(
        counts.starters,
        counts.starters + counts.bench,
      );
      const room = positionRoomScore(
        [...starters, ...depth].map((player) => player.value),
        group,
      );

      byGroup[group] = {
        group,
        slots: counts.starters,
        starters,
        depth,
        unfilledSlots: counts.starters - starters.length,
        ...room,
      };
    }

    const overall = POSITION_GROUPS.reduce(
      (total, group) =>
        total + byGroup[group].score * POSITION_POWER_COUNTS[group].starters,
      0,
    ) / TOTAL_STARTER_SLOTS;

    byTeam.set(roster.teamId, { teamId: roster.teamId, overall, byGroup });
  }

  return { byTeam, slotsByGroup, ladderByGroup };
}

/** Scales scores so the strongest roster reads 100. */
export function powerIndexOf(score: number, best: number): number {
  if (!Number.isFinite(score) || best <= 0) return score > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (score / best) * 100));
}
