/**
 * Checks the optimal-lineup solver against brute force.
 *
 * `computeOptimalLineup` runs a maximum-weight bipartite matching, which is the
 * right algorithm and also the kind of code that can be subtly wrong for years
 * without anyone noticing — it always returns *a* lineup, and a lineup that is
 * merely good looks exactly like a lineup that is optimal.
 *
 * So this enumerates every legal assignment for randomly generated rosters and
 * asserts the solver's total equals the true maximum. Brute force is factorial,
 * which is why the cases are small; the property being checked does not depend
 * on size, and the shapes here include the ones that break a greedy filler.
 *
 * The league's own nine-slot lineup is checked too, against a greedy filler.
 * In *this* format greedy happens to be optimal — one flex over a superset of
 * three single-position slots — so the two must agree on every roster, and a
 * disagreement means the matcher is broken rather than that greedy is.
 *
 * Run with `npm run verify:lineup`.
 */

import { computeOptimalLineup, slotAccepts, type LineupCandidate } from '../src/lib/optimal';
import {
  appExpectedFor,
  appProjectionFor,
  projectedLineupTotal,
  projectedOptimalLineup,
  projectedPlayerScore,
  type ProjectedPlayer,
} from '../src/data/predictions';
import type { PlayerForecast } from '../src/lib/forecast';
import { POSITION_GROUPS, type PositionGroup } from '../src/lib/types';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures++;
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True maximum, by enumerating every way to fill the slots. */
function bruteForce(slots: string[], pool: LineupCandidate[]): number {
  const used = new Array<boolean>(pool.length).fill(false);

  const walk = (slotIndex: number): number => {
    if (slotIndex >= slots.length) return 0;

    // Leaving a slot empty is legal, and sometimes forced.
    let best = walk(slotIndex + 1);

    for (let i = 0; i < pool.length; i++) {
      if (used[i]) continue;
      if (!slotAccepts(slots[slotIndex], pool[i].group)) continue;
      used[i] = true;
      best = Math.max(best, pool[i].points + walk(slotIndex + 1));
      used[i] = false;
    }

    return best;
  };

  return walk(0);
}

/** What a greedy filler produces: fixed slots first, flex from what is left. */
function greedy(slots: string[], pool: LineupCandidate[]): number {
  const taken = new Set<string>();
  let total = 0;

  // Flex last, so it only ever sees leftovers — the classic implementation.
  const order = [...slots.keys()].sort(
    (a, b) => Number(slots[a] === 'FLEX') - Number(slots[b] === 'FLEX'),
  );

  for (const slotIndex of order) {
    let bestIdx = -1;
    for (let i = 0; i < pool.length; i++) {
      if (taken.has(pool[i].pid)) continue;
      if (!slotAccepts(slots[slotIndex], pool[i].group)) continue;
      if (bestIdx === -1 || pool[i].points > pool[bestIdx].points) bestIdx = i;
    }
    if (bestIdx >= 0) {
      taken.add(pool[bestIdx].pid);
      total += pool[bestIdx].points;
    }
  }

  return Math.round((total + Number.EPSILON) * 100) / 100;
}

function randomPool(random: () => number, size: number): LineupCandidate[] {
  return Array.from({ length: size }, (_, i) => ({
    pid: `p${i}`,
    group: POSITION_GROUPS[Math.floor(random() * POSITION_GROUPS.length)] as PositionGroup,
    points: Math.round(random() * 300) / 10,
  }));
}

// ---------------------------------------------------------------------------

process.stdout.write('solver matches brute force on small random rosters\n');

const SHAPES: Array<{ name: string; slots: string[] }> = [
  { name: 'league lineup, trimmed', slots: ['QB', 'RB', 'WR', 'TE', 'FLEX'] },
  { name: 'flex-heavy', slots: ['RB', 'WR', 'FLEX', 'FLEX'] },
  { name: 'all flex', slots: ['FLEX', 'FLEX', 'FLEX'] },
  { name: 'single position, contested', slots: ['RB', 'RB', 'FLEX'] },
  { name: 'unfillable slots', slots: ['QB', 'K', 'D/ST', 'FLEX'] },
];

for (const shape of SHAPES) {
  let mismatches = 0;
  let worst = 0;

  for (let trial = 0; trial < 300; trial++) {
    const random = rng(0xa11 + trial * 7919);
    const pool = randomPool(random, 6);
    const solved = computeOptimalLineup(shape.slots, pool).total;
    const truth = Math.round((bruteForce(shape.slots, pool) + Number.EPSILON) * 100) / 100;

    if (Math.abs(solved - truth) > 1e-6) {
      mismatches++;
      worst = Math.max(worst, truth - solved);
    }
  }

  check(
    shape.name,
    mismatches === 0,
    mismatches ? `${mismatches}/300 short by up to ${worst.toFixed(1)}` : '300/300 optimal',
  );
}

// ---------------------------------------------------------------------------

process.stdout.write('\nno player is ever assigned to two slots\n');

{
  let violations = 0;
  for (let trial = 0; trial < 500; trial++) {
    const random = rng(0xbeef + trial * 104729);
    const pool = randomPool(random, 16);
    const lineup = computeOptimalLineup(
      ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K'],
      pool,
    );

    const filled = lineup.assignments.map((a) => a.pid).filter((p): p is string => p !== null);
    if (new Set(filled).size !== filled.length) violations++;

    // Every assignment must also be legal for the slot it landed in.
    for (const assignment of lineup.assignments) {
      if (assignment.pid === null) continue;
      const player = pool.find((c) => c.pid === assignment.pid)!;
      if (!slotAccepts(assignment.slot, player.group)) violations++;
    }

    // Benched players must be exactly the ones not assigned.
    const benched = new Set(lineup.benched.map((c) => c.pid));
    if (benched.size + filled.length !== pool.length) violations++;
  }
  check('500 full-size rosters', violations === 0, `${violations} violations`);
}

// ---------------------------------------------------------------------------

process.stdout.write("\nmatcher agrees with greedy on this league's own lineup\n");

{
  const slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];
  let disagreements = 0;
  let greedyAhead = 0;

  for (let trial = 0; trial < 500; trial++) {
    const random = rng(0xfeed + trial * 15485863);
    const pool = randomPool(random, 16);
    const solved = computeOptimalLineup(slots, pool).total;
    const naive = greedy(slots, pool);

    if (Math.abs(solved - naive) > 1e-6) {
      disagreements++;
      // Greedy beating an exact matcher would mean the matcher is broken.
      if (naive > solved) greedyAhead++;
    }
  }

  check(
    'greedy is optimal in this format, so the two must agree',
    disagreements === 0,
    `${disagreements} disagreements, ${greedyAhead} of them greedy-ahead`,
  );
}

// ---------------------------------------------------------------------------

process.stdout.write('\nedge cases\n');

check(
  'an empty pool yields an empty lineup',
  computeOptimalLineup(['QB', 'FLEX'], []).total === 0,
);
check('no slots yields zero', computeOptimalLineup([], randomPool(rng(1), 5)).total === 0);
check(
  'a player with no position is never started',
  computeOptimalLineup(['FLEX'], [{ pid: 'x', group: null, points: 99 }]).total === 0,
);
check(
  'an unfillable slot stays empty rather than taking someone ineligible',
  computeOptimalLineup(['K'], [{ pid: 'x', group: 'WR', points: 99 }]).assignments[0].pid ===
    null,
);

// ---------------------------------------------------------------------------

process.stdout.write('\nprojection source changes forward-looking lineup decisions\n');

const projectedPlayers: ProjectedPlayer[] = [
  { pid: 'steady', group: 'RB', slot: 'RB', proj: 14 },
  { pid: 'matchup', group: 'RB', slot: 'BN', proj: 11 },
];

/*
 * `mean` is deliberately given a value of its own rather than echoing the
 * median. The two are different quantities in the real fit — a skewed weekly
 * score has a mean above its median — and the app now uses them for different
 * things: the median on a player's row, the mean anywhere scores are summed or
 * compared to build a lineup. A stub that set them equal could not tell a
 * correct implementation from one that had them the wrong way round.
 */
const playerForecast = (pid: string, median: number, mean = median + 1): PlayerForecast => ({
  pid,
  group: 'RB',
  projection: projectedPlayers.find((player) => player.pid === pid)?.proj ?? 0,
  median,
  biasShift: 0,
  matchupShift: 0,
  mean,
  sd: 0,
  p10: median,
  p25: median,
  p75: median,
  p90: median,
  playProb: 1,
  boomProb: null,
  bustProb: null,
  actual: null,
  nflTeam: 'T',
});

const appForecasts = new Map([
  ['steady', playerForecast('steady', 10)],
  ['matchup', playerForecast('matchup', 16)],
]);

check(
  'the app source uses the adjusted median shown on the player sheet',
  appProjectionFor(projectedPlayers[0], appForecasts) === 10 &&
    projectedPlayerScore(projectedPlayers[0], appForecasts, 'app') === 10,
);
/*
 * Totals and lineup choices use the mean instead, because medians do not add:
 * the median of a sum is not the sum of the medians, and stacking nine skewed
 * players understated a lineup by about a tenth.
 */
check(
  'anything that adds players up uses expected points, not the median',
  appExpectedFor(projectedPlayers[0], appForecasts) === 11 &&
    projectedPlayerScore(projectedPlayers[0], appForecasts, 'app', 'expected') === 11,
);
check(
  'the ESPN source keeps the custom-scored ESPN projection',
  projectedPlayerScore(projectedPlayers[0], appForecasts, 'espn') === 14,
);
check(
  'the current-lineup total follows the selected source',
  projectedLineupTotal([projectedPlayers[0]], appForecasts, 'app') === 11 &&
    projectedLineupTotal([projectedPlayers[0]], appForecasts, 'espn') === 14,
);
/*
 * The case the sum-of-medians bug could not distinguish: a player who is out
 * has a median that says nothing about it, and a mean that is zero. A total
 * built from medians would count him.
 */
check(
  'a player who will not appear adds nothing to a total',
  projectedLineupTotal(
    [projectedPlayers[0]],
    new Map([['steady', { ...playerForecast('steady', 10), playProb: 0, mean: 0 }]]),
    'app',
  ) === 0,
);
check(
  'the app and ESPN sources can select different optimal starters',
  projectedOptimalLineup(['RB'], projectedPlayers, appForecasts, 'app').assignments[0].pid ===
    'matchup' &&
    projectedOptimalLineup(['RB'], projectedPlayers, appForecasts, 'espn').assignments[0].pid ===
      'steady',
);

process.stdout.write(
  `\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`,
);
if (failures > 0) process.exitCode = 1;
