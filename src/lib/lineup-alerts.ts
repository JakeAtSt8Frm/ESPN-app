import type { EnrichedPlayer } from './types';

type Starter = Pick<EnrichedPlayer, 'pid' | 'name' | 'slot' | 'hasPlayed' | 'onBye' | 'isOut'> & {
  player: Pick<EnrichedPlayer['player'], 'injuryStatus'>;
};

export type LineupAlert =
  | { kind: 'empty'; slot: string; count: number }
  | {
      kind: 'player';
      pid: string;
      name: string;
      slot: string;
      reason: 'Bye' | 'Out' | 'Questionable' | 'Doubtful' | 'Suspended' | 'Injured reserve';
    };

/** Snapshot checks, never a statement that a player can still be moved. */
export function lineupAlerts({
  starterSlots,
  starters,
  hasRoster,
  week,
  liveWeek,
}: {
  starterSlots: readonly string[];
  starters: readonly Starter[];
  hasRoster: boolean;
  week: number;
  liveWeek: number;
}): LineupAlert[] {
  if (!hasRoster) return [];

  const openSlots = new Map<string, number>();
  for (const slot of starterSlots) {
    const upper = slot.toUpperCase();
    openSlots.set(upper, (openSlots.get(upper) ?? 0) + 1);
  }
  for (const starter of starters) {
    const slot = starter.slot.toUpperCase();
    openSlots.set(slot, Math.max(0, (openSlots.get(slot) ?? 0) - 1));
  }

  const alerts: LineupAlert[] = [];
  for (const [slot, count] of openSlots) {
    if (count > 0) alerts.push({ kind: 'empty', slot, count });
  }

  for (const starter of starters) {
    if (starter.hasPlayed) continue;
    const injury = (starter.player.injuryStatus ?? '').toUpperCase();
    let reason: Extract<LineupAlert, { kind: 'player' }>['reason'] | null = null;
    if (starter.onBye) reason = 'Bye';
    // Injury labels belong to the snapshot, not to a historical week's roster.
    else if (week >= liveWeek) {
      if (starter.isOut) {
        reason = injury === 'SUSPENSION'
          ? 'Suspended'
          : injury === 'INJURY_RESERVE'
            ? 'Injured reserve'
            : 'Out';
      } else if (injury === 'QUESTIONABLE') reason = 'Questionable';
      else if (injury === 'DOUBTFUL') reason = 'Doubtful';
    }
    if (reason) {
      alerts.push({ kind: 'player', pid: starter.pid, name: starter.name, slot: starter.slot, reason });
    }
  }
  return alerts;
}
