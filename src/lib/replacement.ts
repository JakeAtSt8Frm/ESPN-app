import { SLOT_ELIGIBILITY, type PositionGroup } from './types';

export interface ReplacementCandidate {
  group: PositionGroup;
  /** Already scored using this league's settings; comparable across positions. */
  points: number;
}

/**
 * League-wide starter demand, reserving dedicated starters before filling FLEX
 * with the strongest remaining projections. This makes the cliff respond to
 * scoring (including half PPR) instead of assuming a fixed positional split.
 * A tie at the FLEX cutoff shares those seats among every tied candidate, so
 * input order cannot manufacture positional scarcity.
 */
export function startingDepthByGroup(
  rosterSlots: string[],
  numTeams: number,
  candidates: readonly ReplacementCandidate[],
): Map<PositionGroup, number> {
  const depth = new Map<PositionGroup, number>();
  const teams = Math.max(0, Math.floor(numTeams));
  let flexSeats = 0;
  for (const raw of rosterSlots) {
    const slot = String(raw).toUpperCase();
    const allowed = SLOT_ELIGIBILITY[slot];
    if (allowed?.length === 1) {
      const group = allowed[0];
      depth.set(group, (depth.get(group) ?? 0) + teams);
    } else if (slot === 'FLEX') {
      flexSeats += teams;
    }
  }
  if (!flexSeats) return depth;

  const flexPool: ReplacementCandidate[] = [];
  for (const group of SLOT_ELIGIBILITY.FLEX) {
    const ladder = candidates
      .filter((candidate) => candidate.group === group && Number.isFinite(candidate.points))
      .sort((a, b) => b.points - a.points);
    flexPool.push(...ladder.slice(depth.get(group) ?? 0));
  }
  flexPool.sort((a, b) => b.points - a.points);
  const filled = Math.min(flexSeats, flexPool.length);
  if (!filled) return depth;

  const cutoff = flexPool[filled - 1].points;
  const above = flexPool.filter((candidate) => candidate.points > cutoff).length;
  const tied = flexPool.filter((candidate) => candidate.points === cutoff).length;
  const tiedShare = (filled - above) / tied;
  for (const candidate of flexPool) {
    if (candidate.points < cutoff) break;
    const seats = candidate.points === cutoff ? tiedShare : 1;
    depth.set(candidate.group, (depth.get(candidate.group) ?? 0) + seats);
  }
  return depth;
}
