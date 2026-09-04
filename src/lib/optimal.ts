/**
 * Optimal lineup solver.
 *
 * Given a pool of rostered players and the league's starting slots, find the
 * assignment that maximises total points.
 *
 * A note on why this is a matching problem rather than a sort. In *this*
 * league's format it needn't be: the seven fixed slots each take exactly one
 * position and the single FLEX takes a superset of three of them, so filling
 * every fixed slot with its best available player and handing FLEX whatever is
 * left over happens to be optimal, by a straightforward exchange argument.
 *
 * Greedy stops being optimal the moment a player is eligible for both a scarce
 * fixed slot and a flex — a superflex, an OP slot, a second flex with narrower
 * eligibility. ESPN offers all of those and a league can turn one on between
 * seasons, at which point a greedy filler quietly starts reporting an
 * "optimal" lineup that isn't one. The exact solver costs nothing here (nine
 * slots, at most sixteen players) and cannot be wrong, so it is what runs.
 */

import { SLOT_ELIGIBILITY, type PositionGroup } from './types';

/** Slots that never hold a starter. */
const BENCH_SLOTS = new Set(['BN', 'IR']);

export function isStarterSlot(slot: string): boolean {
  return !BENCH_SLOTS.has(String(slot).toUpperCase());
}

export function slotAccepts(slot: string, group: PositionGroup | null): boolean {
  if (!group) return false;
  const allowed = SLOT_ELIGIBILITY[String(slot).toUpperCase()];
  return allowed ? allowed.includes(group) : false;
}

/** Extracts just the starting slots from a league's ordered slot list. */
export function starterSlots(rosterSlots: string[] | undefined | null): string[] {
  return (rosterSlots ?? []).filter(isStarterSlot);
}

export interface LineupCandidate {
  pid: string;
  group: PositionGroup | null;
  points: number;
}

export interface LineupAssignment {
  slot: string;
  slotIndex: number;
  pid: string | null;
  points: number;
}

export interface OptimalLineup {
  assignments: LineupAssignment[];
  total: number;
  /** Players who scored but didn't make the optimal lineup. */
  benched: LineupCandidate[];
}

/**
 * Maximum-weight bipartite matching between slots and players.
 *
 * Uses the Hungarian algorithm's shortest-augmenting-path formulation (JV
 * style) over a slots x players cost matrix, where cost = -points. Ineligible
 * pairings get a large positive cost so they're never selected unless a slot
 * would otherwise go empty.
 */
function maxWeightAssignment(
  slots: string[],
  candidates: LineupCandidate[],
): Array<number | null> {
  const nSlots = slots.length;
  const nPlayers = candidates.length;
  if (!nSlots || !nPlayers) return new Array(nSlots).fill(null);

  const INELIGIBLE = 1e9;

  // cost[i][j] for slot i, player j. Negative points = maximise points.
  const cost: number[][] = [];
  for (let i = 0; i < nSlots; i++) {
    const row = new Array<number>(nPlayers);
    for (let j = 0; j < nPlayers; j++) {
      row[j] = slotAccepts(slots[i], candidates[j].group)
        ? -candidates[j].points
        : INELIGIBLE;
    }
    cost.push(row);
  }

  // Standard O(n^2 m) Hungarian with potentials. 1-indexed internal arrays.
  const u = new Array<number>(nSlots + 1).fill(0);
  const v = new Array<number>(nPlayers + 1).fill(0);
  const p = new Array<number>(nPlayers + 1).fill(0); // player -> slot
  const way = new Array<number>(nPlayers + 1).fill(0);

  for (let i = 1; i <= nSlots; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(nPlayers + 1).fill(Infinity);
    const used = new Array<boolean>(nPlayers + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;

      for (let j = 1; j <= nPlayers; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }

      for (let j = 0; j <= nPlayers; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }

      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const result = new Array<number | null>(nSlots).fill(null);
  for (let j = 1; j <= nPlayers; j++) {
    const slotIdx = p[j] - 1;
    if (slotIdx >= 0 && slotIdx < nSlots) {
      // Reject assignments that were only made because a slot needed filling.
      if (cost[slotIdx][j - 1] < INELIGIBLE) result[slotIdx] = j - 1;
    }
  }

  return result;
}

/**
 * Computes the highest-scoring legal lineup from a pool of players.
 *
 * `points` is whatever metric the caller wants to optimise for — the actual
 * score when looking backwards ("what was the best I could have done"), or the
 * projection when looking forwards.
 */
export function computeOptimalLineup(
  slots: string[],
  candidates: LineupCandidate[],
): OptimalLineup {
  const pool = candidates.filter((c) => c.group !== null);
  const matched = maxWeightAssignment(slots, pool);

  const assignments: LineupAssignment[] = [];
  const used = new Set<string>();
  let total = 0;

  for (let i = 0; i < slots.length; i++) {
    const idx = matched[i];
    if (idx === null || idx === undefined) {
      assignments.push({ slot: slots[i], slotIndex: i, pid: null, points: 0 });
      continue;
    }
    const chosen = pool[idx];
    used.add(chosen.pid);
    total += chosen.points;
    assignments.push({
      slot: slots[i],
      slotIndex: i,
      pid: chosen.pid,
      points: chosen.points,
    });
  }

  const benched = pool
    .filter((c) => !used.has(c.pid))
    .sort((a, b) => b.points - a.points);

  return {
    assignments,
    total: Math.round((total + Number.EPSILON) * 100) / 100,
    benched,
  };
}

/**
 * Lineup efficiency: what fraction of the optimal score a manager actually got.
 *
 * This is the single most useful "did you manage well" number in the app —
 * it separates bad luck from bad decisions.
 */
export function lineupEfficiency(actual: number, optimal: number): number {
  if (!optimal || optimal <= 0) return 0;
  return Math.round((actual / optimal) * 1000) / 1000;
}
