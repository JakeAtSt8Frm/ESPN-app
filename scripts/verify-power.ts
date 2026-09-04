/**
 * Checks the power index against hand-computed answers.
 *
 * Power rankings are the easiest thing in the app to get quietly wrong: the
 * number always looks plausible, nobody can check it by eye, and an off-by-one
 * in how many players a position counts changes the whole board. So this builds
 * rosters whose correct answer is known by construction and asserts the index
 * reproduces it.
 *
 * Run with `npm run verify:power`.
 */

import {
  buildPowerIndex,
  POSITION_BENCH_WEIGHT,
  POSITION_POWER_COUNTS,
  POSITION_STARTER_WEIGHT,
  positionRoomScore,
} from '../src/lib/power';
import { POSITION_GROUPS, type PositionGroup } from '../src/lib/types';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures++;
}

function near(label: string, actual: number, expected: number, tolerance = 0.5): void {
  check(
    label,
    Math.abs(actual - expected) <= tolerance,
    `got ${actual.toFixed(2)}, expected ${expected.toFixed(2)}`,
  );
}

process.stdout.write('weights and counts\n');

near('starter and bench weights sum to 1', POSITION_STARTER_WEIGHT + POSITION_BENCH_WEIGHT, 1, 1e-9);
check(
  'every position group has a configured count',
  POSITION_GROUPS.every((g) => POSITION_POWER_COUNTS[g] !== undefined),
);
check(
  'kicker and defence carry no bench',
  POSITION_POWER_COUNTS.K.bench === 0 && POSITION_POWER_COUNTS.DST.bench === 0,
);

process.stdout.write('\npositionRoomScore\n');

{
  // Three starters at 900 and two bench at 400, with RB configured 3 + 2.
  const values = [900, 900, 900, 400, 400];
  const expected = 900 * POSITION_STARTER_WEIGHT + 400 * POSITION_BENCH_WEIGHT;
  near('a full RB room scores starters·0.85 + bench·0.15', positionRoomScore(values, 'RB').score, expected);
}

{
  // Players past the configured depth must not count at all. They have to be
  // *worse* than the ones already in the window, or sorting promotes them into
  // it and the room legitimately changes.
  const short = positionRoomScore([900, 900, 900, 400, 400], 'RB').score;
  const long = positionRoomScore([900, 900, 900, 400, 400, 50, 50], 'RB').score;
  near('players beyond the configured depth are ignored', long, short, 1e-9);
}

{
  // A bench-less position is scored on its starters alone, not 85% of them.
  near('a position with no bench is not docked for it', positionRoomScore([900], 'K').score, 900);
  near('nor is defence', positionRoomScore([700], 'DST').score, 700);
}

{
  // A missing slot counts as zero rather than being skipped, so a thin room
  // cannot masquerade as a complete one.
  const full = positionRoomScore([900, 900, 900], 'RB').score;
  const thin = positionRoomScore([900], 'RB').score;
  check('a thin room scores below a full one', thin < full, `${thin.toFixed(1)} < ${full.toFixed(1)}`);
  near('one starter of three counts the other two as zero', positionRoomScore([900], 'RB').score, 900 / 3 * POSITION_STARTER_WEIGHT);
}

near('an empty room scores zero', positionRoomScore([], 'RB').score, 0, 1e-9);

process.stdout.write('\nbuildPowerIndex\n');

{
  const players = new Map<string, { group: PositionGroup; value: number | null }>();
  const roster = (teamId: number, value: number) => {
    const ids: string[] = [];
    for (const group of POSITION_GROUPS) {
      const { starters, bench } = POSITION_POWER_COUNTS[group];
      for (let i = 0; i < starters + bench; i++) {
        const pid = `t${teamId}-${group}-${i}`;
        players.set(pid, { group, value });
        ids.push(pid);
      }
    }
    return { teamId, playerIds: ids };
  };

  const index = buildPowerIndex({
    rosters: [roster(1, 900), roster(2, 500), roster(3, 100)],
    players,
  });

  check('every team is scored', index.byTeam.size === 3);

  const overall = (id: number) => index.byTeam.get(id)!.overall;
  check(
    'teams order by the value they hold',
    overall(1) > overall(2) && overall(2) > overall(3),
    `${overall(1).toFixed(0)} > ${overall(2).toFixed(0)} > ${overall(3).toFixed(0)}`,
  );
  near('a roster entirely of 900s scores 900 overall', overall(1), 900, 1);
  near('a roster entirely of 100s scores 100 overall', overall(3), 100, 1);

  check(
    'the ladder holds every rostered player at each position',
    POSITION_GROUPS.every(
      (g) =>
        (index.ladderByGroup.get(g)?.length ?? 0) ===
        3 * (POSITION_POWER_COUNTS[g].starters + POSITION_POWER_COUNTS[g].bench),
    ),
  );
}

{
  // A duplicated id must be counted once: ESPN can list the same player twice.
  const players = new Map<string, { group: PositionGroup; value: number | null }>([
    ['a', { group: 'QB', value: 900 }],
  ]);
  const once = buildPowerIndex({ rosters: [{ teamId: 1, playerIds: ['a'] }], players });
  const twice = buildPowerIndex({ rosters: [{ teamId: 1, playerIds: ['a', 'a'] }], players });
  near(
    'a duplicated player is counted once',
    twice.byTeam.get(1)!.overall,
    once.byTeam.get(1)!.overall,
    1e-9,
  );
}

{
  // A player with no Value Score must not be scored as a zero-value starter.
  const players = new Map<string, { group: PositionGroup; value: number | null }>([
    ['known', { group: 'QB', value: 800 }],
    ['unknown', { group: 'QB', value: null }],
  ]);
  const index = buildPowerIndex({
    rosters: [{ teamId: 1, playerIds: ['known', 'unknown'] }],
    players,
  });
  check(
    'a player with no Value Score is excluded, not zeroed',
    (index.byTeam.get(1)?.byGroup.QB.starters.length ?? 0) === 1,
  );
}

process.stdout.write(
  `\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`,
);
if (failures > 0) process.exitCode = 1;
