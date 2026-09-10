/**
 * Verifies the trade model's arithmetic and its stated invariants.
 *
 * The properties worth pinning are the ones a trade evaluator is wrong in
 * silence about: that a bye costs nothing, that positional scarcity is really
 * in the number, that uneven sides model the roster squeeze, and above all that
 * the currency is additive — two players worth 40 have to balance one worth 80,
 * or every multi-player verdict on the page is decoration.
 */

import {
  buildTradeValues,
  expectedExcess,
  measureDrift,
  rosterImpact,
  startingSlotsByGroup,
  summarizeTrade,
} from '../src/lib/trade';
import type { PriorPair } from '../src/lib/forecast';
import { compileScoring, createScorer } from '../src/lib/scoring';
import type { ReplacementCandidate } from '../src/lib/replacement';
import { POSITION_GROUPS, type Player, type PositionGroup } from '../src/lib/types';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures++;
}

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

function player(pid: string, group: PositionGroup, extra: Partial<Player> = {}): Player {
  return {
    playerId: pid,
    name: pid,
    firstName: pid,
    lastName: group,
    group,
    team: 'TST',
    proTeamId: 1,
    eligibleSlots: [group === 'DST' ? 'D/ST' : group],
    injuryStatus: null,
    injured: false,
    active: true,
    percentOwned: null,
    percentStarted: null,
    averageDraftPosition: null,
    auctionValueAverage: null,
    positionalRank: null,
    seasonOutlook: null,
    byeWeek: null,
    ...extra,
  };
}

const ROSTER_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];

// ---------------------------------------------------------- expectedExcess --

process.stdout.write('\nexpected excess\n');

check(
  'collapses to a plain max when there is no spread',
  near(expectedExcess(12, 0, 10), 2) && near(expectedExcess(8, 0, 10), 0),
);
check(
  'is symmetric about the strike at zero edge',
  near(expectedExcess(10, 4, 10), 4 * 0.3989422804, 1e-4),
  `got ${expectedExcess(10, 4, 10).toFixed(4)}`,
);
check(
  'is strictly positive below the strike — a bench player is not worthless',
  expectedExcess(8, 4, 10) > 0 && expectedExcess(8, 4, 10) < expectedExcess(10, 4, 10),
);
check(
  'increases monotonically in the projection',
  [6, 8, 10, 12, 14].every(
    (p, i, all) => i === 0 || expectedExcess(p, 3, 10) > expectedExcess(all[i - 1], 3, 10),
  ),
);
check(
  'exceeds the intrinsic value by the option premium',
  expectedExcess(14, 5, 10) > 4 && expectedExcess(14, 0, 10) === 4,
);

// -------------------------------------------------------------- drift fit --

process.stdout.write('\ndrift and reliability\n');

{
  // A group where realised level is exactly 0.5 x projection: reliability 0.5.
  const pairs = new Map<PositionGroup, PriorPair[]>();
  const rows: PriorPair[] = [];
  for (let i = 0; i < 40; i++) {
    const projection = 5 + i * 0.5;
    for (let week = 1; week <= 8; week++) {
      rows.push({ pid: `p${i}`, projection, actual: projection * 0.5, week, team: 'TST' });
    }
  }
  pairs.set('RB', rows);

  const fit = measureDrift(pairs).get('RB')!;
  check('recovers a planted reliability slope', near(fit.reliability, 0.5, 1e-6), `got ${fit.reliability.toFixed(4)}`);
  check('marks a measured group as measured', fit.measured && fit.samples === 40);
  check(
    'falls back, and says so, when a group has too few players',
    measureDrift(new Map()).get('WR')!.measured === false,
  );
}

// -------------------------------------------------------- replacement level --

process.stdout.write('\nreplacement level\n');

{
  const candidates: ReplacementCandidate[] = [];
  for (const group of ['RB', 'WR', 'TE'] as const) {
    for (let rank = 1; rank <= 40; rank++) {
      candidates.push({ group, points: (group === 'WR' ? 40 : 20) - rank * 0.5 });
    }
  }
  const slots = startingSlotsByGroup(ROSTER_SLOTS, 8, candidates);
  check('counts one starting QB per team', slots.get('QB') === 8, `got ${slots.get('QB')}`);
  check(
    'allocates each FLEX once using projections after reserving dedicated starters',
    slots.get('RB') === 16 && slots.get('WR') === 24 && slots.get('TE') === 8 &&
      [...slots.values()].reduce((sum, count) => sum + count, 0) === 72,
    `RB ${slots.get('RB')} WR ${slots.get('WR')} TE ${slots.get('TE')}`,
  );
  check('ignores bench and IR slots', startingSlotsByGroup(['QB', 'BN', 'BN', 'IR'], 4, []).get('QB') === 4);

  const twelveTeams = startingSlotsByGroup(ROSTER_SLOTS, 12, candidates);
  check(
    'larger leagues move the starter cliff deeper into the player pool',
    twelveTeams.get('QB') === 12 && twelveTeams.get('WR') === 36,
  );
  const tied = startingSlotsByGroup(['FLEX'], 1, [
    { group: 'RB', points: 10 },
    { group: 'WR', points: 10 },
    { group: 'TE', points: 9 },
  ]);
  check(
    'a tie at the FLEX cutoff shares demand without arbitrary positional preference',
    tied.get('RB') === 0.5 && tied.get('WR') === 0.5 && !tied.has('TE'),
  );
  const partial = startingSlotsByGroup(['RB', 'FLEX', 'FLEX'], 1, [
    { group: 'RB', points: 20 },
    { group: 'WR', points: 12 },
  ]);
  check(
    'a thin projection pool cannot start the same player in dedicated and FLEX seats',
    partial.get('RB') === 1 && partial.get('WR') === 1,
  );
}

// ------------------------------------------------------------ trade values --

process.stdout.write('\ntrade values\n');

{
  const allocate = (receptionPoints: number) => {
    const score = createScorer(compileScoring({ rec: receptionPoints, rec_yd: 0.1, rush_yd: 0.1 }));
    const candidates: ReplacementCandidate[] = [];
    for (let rank = 1; rank <= 32; rank++) {
      candidates.push({ group: 'RB', points: score({ rush_yd: 100 - rank }, 'RB') });
      candidates.push({ group: 'WR', points: score({ rec: 8, rec_yd: 40 - rank }, 'WR') });
    }
    return startingSlotsByGroup(ROSTER_SLOTS, 8, candidates);
  };
  const halfPpr = allocate(0.5);
  const fullPpr = allocate(1);
  check(
    'eight-team FLEX demand changes with half-PPR versus full-PPR scoring',
    halfPpr.get('RB') === 24 && halfPpr.get('WR') === 16 &&
      fullPpr.get('RB') === 16 && fullPpr.get('WR') === 24,
  );
}

{
  const values = buildTradeValues({
    playersById: new Map(['starter', 'bestFree', 'nextFree'].map((pid) => [pid, player(pid, 'QB')])),
    weeklyProjections: new Map([
      ['starter', new Map([[1, 20]])],
      ['bestFree', new Map([[1, 12]])],
      ['nextFree', new Map([[1, 6]])],
    ]),
    rosteredIds: new Set(['starter']),
    rosterSlots: ['QB'],
    numTeams: 8,
    fromWeek: 1,
    finalWeek: 1,
  });
  check(
    'waiver baseline uses the best available player without dilution by the next free agent',
    values.waiverPerWeek.get('QB') === 12,
    `got ${values.waiverPerWeek.get('QB')}`,
  );
  check(
    'value over waivers measures the edge over that actual available baseline',
    values.byPlayer.get('starter')?.pointsOverWaiver === 8 &&
      values.byPlayer.get('bestFree')?.pointsOverWaiver === 0,
  );
}

{
  const playersById = new Map<string, Player>();
  const weeklyProjections = new Map<string, Map<number, number>>();
  for (const group of ['RB', 'WR', 'TE'] as const) {
    for (let rank = 1; rank <= 40; rank++) {
      const pid = `${group}${rank}`;
      const points = (group === 'WR' ? 40 : 20) - rank * 0.5;
      playersById.set(pid, player(pid, group));
      weeklyProjections.set(pid, new Map([[1, points]]));
    }
  }
  const values = buildTradeValues({
    playersById,
    weeklyProjections,
    rosteredIds: new Set(),
    rosterSlots: ROSTER_SLOTS,
    numTeams: 8,
    fromWeek: 1,
    finalWeek: 1,
  });
  check(
    'all eight FLEX starters come from WR when its remaining projections are strongest',
    values.replacementPerWeek.get('WR') === 28 &&
      values.replacementPerWeek.get('RB') === 12 &&
      values.replacementPerWeek.get('TE') === 16,
    `RB ${values.replacementPerWeek.get('RB')}, WR ${values.replacementPerWeek.get('WR')}, TE ${values.replacementPerWeek.get('TE')}`,
  );
}

{
  /*
   * Two positions with identical point ladders but different depth: 40 running
   * backs against 12 kickers. The startable cliff sits deep into the RB pool
   * and near the bottom of the K pool, so an identically-producing kicker must
   * be worth less. Scarcity, with everything else held equal.
   */
  const playersById = new Map<string, Player>();
  const weeklyProjections = new Map<string, Map<number, number>>();
  const weeks = (ppw: number) => {
    const m = new Map<number, number>();
    for (let w = 1; w <= 10; w++) m.set(w, ppw);
    return m;
  };

  for (let i = 0; i < 40; i++) {
    const pid = `rb${i}`;
    playersById.set(pid, player(pid, 'RB'));
    weeklyProjections.set(pid, weeks(25 - i * 0.5));
  }
  for (let i = 0; i < 12; i++) {
    const pid = `k${i}`;
    playersById.set(pid, player(pid, 'K'));
    weeklyProjections.set(pid, weeks(25 - i * 0.5));
  }

  /*
   * Rosters matter to the model, so the fixture has to have them. Thirty of the
   * forty backs are held, which is a surplus over the 24 the league starts —
   * sixteen dedicated plus all eight FLEX seats, there being no receivers or
   * tight ends here to take them — and therefore a real weekly start decision;
   * all twelve kickers are held against eight starting slots, which is not.
   * That difference is the point of the two monotonicity checks below.
   */
  const rostered = new Set<string>([
    ...Array.from({ length: 30 }, (_, i) => `rb${i}`),
    ...Array.from({ length: 8 }, (_, i) => `k${i}`),
  ]);

  const values = buildTradeValues({
    playersById,
    weeklyProjections,
    rosteredIds: rostered,
    rosterSlots: ROSTER_SLOTS,
    numTeams: 8,
    fromWeek: 1,
    finalWeek: 10,
  });

  const topRb = values.byPlayer.get('rb0')!;
  const topK = values.byPlayer.get('k0')!;
  check(
    'a scarce position is worth more than an abundant one at identical output',
    topRb.points > topK.points,
    `RB ${topRb.points} vs K ${topK.points}`,
  );
  check('the best player indexes at 100', near(topRb.index, 100, 0.05), `got ${topRb.index}`);
  check(
    'the index is linear in points, not a percentile',
    near(values.byPlayer.get('rb10')!.index, (values.byPlayer.get('rb10')!.points / topRb.points) * 100, 0.05),
  );
  check(
    'value falls monotonically all the way down a ladder with a bench',
    [0, 5, 10, 20, 30, 39].every(
      (i, k, all) =>
        k === 0 || values.byPlayer.get(`rb${i}`)!.points < values.byPlayer.get(`rb${all[k - 1]}`)!.points,
    ),
    'no ties below the startable cliff, which is what the option term is for',
  );
  check(
    'and ties at zero below the cliff where there is no bench to rotate',
    values.byPlayer.get('k10')!.points === 0 && values.byPlayer.get('k11')!.points === 0,
    'a kicker you would never start is worth nothing, because you cannot stream him in',
  );

  /*
   * The bye. Same player, one fewer projected week — he must lose exactly that
   * week's contribution and no more, because a roster spot fields the
   * replacement while he rests.
   */
  const withBye = new Map(weeklyProjections);
  const byeWeeks = new Map(weeks(25));
  byeWeeks.delete(5);
  withBye.set('rb0', byeWeeks);
  const byeValues = buildTradeValues({
    playersById,
    weeklyProjections: withBye,
    rosteredIds: rostered,
    rosterSlots: ROSTER_SLOTS,
    numTeams: 8,
    fromWeek: 1,
    finalWeek: 10,
  });
  const perWeek = topRb.points / 10;
  check(
    'a bye costs exactly one week and never more',
    near(byeValues.byPlayer.get('rb0')!.points, topRb.points - perWeek, 0.15),
    `${byeValues.byPlayer.get('rb0')!.points} vs ${(topRb.points - perWeek).toFixed(1)}`,
  );

  // Injury.
  const hurt = new Map(playersById);
  hurt.set('rb0', player('rb0', 'RB', { injuryStatus: 'OUT' }));
  const hurtValues = buildTradeValues({
    playersById: hurt,
    weeklyProjections,
    rosteredIds: rostered,
    rosterSlots: ROSTER_SLOTS,
    numTeams: 8,
    fromWeek: 1,
    finalWeek: 10,
  });
  check(
    'an injury discounts value without erasing it',
    hurtValues.byPlayer.get('rb0')!.points < topRb.points &&
      hurtValues.byPlayer.get('rb0')!.points > 0,
  );

  // Additivity — the property the whole page rests on.
  const a = values.byPlayer.get('rb3')!.points;
  const b = values.byPlayer.get('rb9')!.points;
  const summary = summarizeTrade(['rb3', 'rb9'], [], values);
  check(
    'sides add up exactly, so 2-for-1 arithmetic is real',
    near(summary.bReceives.points, a + b, 0.05),
    `${summary.bReceives.points} vs ${(a + b).toFixed(1)}`,
  );
  check(
    'an empty trade is even and favours nobody',
    summarizeTrade([], [], values).verdict === 'Even' && summarizeTrade([], [], values).favors === null,
  );
  check(
    'the verdict names the side receiving more',
    summarizeTrade(['rb0'], ['rb30'], values).favors === 'B' &&
      summarizeTrade(['rb30'], ['rb0'], values).favors === 'A',
  );
  /*
   * Presence and absence, not a particular number.
   *
   * This asserted `RB === 1` while starter demand was a fixed positional split
   * of the FLEX seats. Allocating them by projection instead — see
   * `startingDepthByGroup` — correctly gives all eight to running backs here,
   * because the fixture contains no receivers or tight ends to compete for
   * them, so RB starter demand is 24 rather than 19.2 and the surplus is a
   * genuine 0.75 rather than a clamped 1. The premium being *on* is the claim;
   * the exact weight is the model's to decide.
   */
  check(
    'the option premium is on where there is a bench and off where there is not',
    values.optionWeightByGroup.get('RB')! > 0 && values.optionWeightByGroup.get('K') === 0,
    `RB ${values.optionWeightByGroup.get('RB')}, K ${values.optionWeightByGroup.get('K')}`,
  );
}

// ----------------------------------------------------------- roster impact --

process.stdout.write('\nroster impact\n');

{
  const playersById = new Map<string, Player>();
  const weeklyProjections = new Map<string, Map<number, number>>();
  const put = (pid: string, group: PositionGroup, ppw: number) => {
    playersById.set(pid, player(pid, group));
    const m = new Map<number, number>();
    for (let w = 1; w <= 4; w++) m.set(w, ppw);
    weeklyProjections.set(pid, m);
    return pid;
  };

  // A legal 16-man roster, plus two free agents on the wire.
  const roster: string[] = [
    put('qb1', 'QB', 20),
    put('rb1', 'RB', 18),
    put('rb2', 'RB', 14),
    put('rb3', 'RB', 9),
    put('wr1', 'WR', 17),
    put('wr2', 'WR', 15),
    put('wr3', 'WR', 13),
    put('wr4', 'WR', 12),
    put('te1', 'TE', 11),
    put('k1', 'K', 9),
    put('ds1', 'DST', 7),
    put('rb4', 'RB', 6),
    put('wr5', 'WR', 6),
    put('qb2', 'QB', 5),
    put('te2', 'TE', 4),
    put('wr6', 'WR', 3),
  ];
  put('fa1', 'WR', 8);
  put('fa2', 'RB', 7);
  // A free agent kicker who is better than the one on the roster. He rates far
  // below the receiver on trade points — every kicker does — but he is the only
  // one of the two who would actually crack this lineup.
  put('faK', 'K', 14);
  const star = put('star', 'RB', 24);
  put('spare', 'WR', 2);

  const values = buildTradeValues({
    playersById,
    weeklyProjections,
    rosteredIds: new Set(roster),
    rosterSlots: ROSTER_SLOTS,
    numTeams: 8,
    fromWeek: 1,
    finalWeek: 4,
  });

  const base = {
    playersById,
    weeklyProjections,
    values,
    freeAgentPool: ['fa1', 'fa2'],
    rosterSlots: ROSTER_SLOTS,
    rosterLimit: 16,
    fromWeek: 1,
    finalWeek: 4,
  };

  const oneForOne = rosterImpact({ ...base, teamId: 1, playerIds: roster, sends: ['rb3'], receives: [star] });
  check(
    'a straight upgrade raises projected starting points',
    oneForOne.delta > 0,
    `${oneForOne.delta} over 4 weeks`,
  );
  check('a 1-for-1 keeps the roster the same size', oneForOne.rosterSizeAfter === 16);
  check(
    'the weekly figure is the total divided by the window',
    near(oneForOne.deltaPerWeek, oneForOne.delta / 4, 0.02),
  );

  const twoForOne = rosterImpact({
    ...base,
    teamId: 1,
    playerIds: roster,
    sends: ['rb3', 'wr6'],
    receives: [star],
  });
  check(
    'sending two for one opens a spot and the wire fills it',
    twoForOne.added.length === 1 && twoForOne.rosterSizeAfter === 16,
    `added ${twoForOne.added.join(',') || 'nothing'}`,
  );

  const oneForTwo = rosterImpact({
    ...base,
    teamId: 1,
    playerIds: roster,
    sends: ['rb3'],
    receives: [star, 'spare'],
  });
  check(
    'receiving two for one forces a cut back to the limit',
    oneForTwo.dropped.length === 1 && oneForTwo.rosterSizeAfter === 16,
    `dropped ${oneForTwo.dropped.join(',') || 'nothing'}`,
  );
  check(
    'the player just acquired is never the one cut to make room for himself',
    !oneForTwo.dropped.includes('star') && !oneForTwo.dropped.includes('spare'),
  );
  /*
   * The bug this pins: cutting by trade value alone always reaches for the
   * kicker, because a kicker is the least valuable player on every roster. Doing
   * that empties the K slot for the rest of the season and turns a trade the
   * team won into an eighty-point loss. The cut has to be scored on the lineup.
   */
  check(
    'the cut is scored on the lineup, so the only kicker survives it',
    !oneForTwo.dropped.includes('k1') && !oneForTwo.shortAt.includes('K'),
    `dropped ${oneForTwo.dropped.join(',')}`,
  );
  check(
    'and a trade that wins on market value wins on the lineup too',
    oneForTwo.delta > 0,
    `${oneForTwo.delta} over 4 weeks`,
  );
  /*
   * The same error in reverse: filling an opened spot from a globally ranked
   * wire signs the best free agent regardless of position, which on a full
   * roster is a player who will never start.
   */
  /*
   * Neither `fa1` nor `fa2` would ever crack this lineup, so which one signs is
   * a tie the wire order settles — and the delta has to be identical either way,
   * which is the actual claim.
   */
  const swapped = rosterImpact({
    ...base,
    teamId: 1,
    playerIds: roster,
    sends: ['rb3', 'wr6'],
    receives: [star],
    freeAgentPool: ['fa2', 'fa1'],
  });
  check(
    'a pickup nobody starts leaves the result unchanged whichever way the wire is ordered',
    near(twoForOne.delta, swapped.delta, 0.01),
    `${twoForOne.delta} vs ${swapped.delta}`,
  );

  /*
   * And when one free agent genuinely helps, he is the one signed — even though
   * he is a kicker sitting near the bottom of the wire on trade points. Picking
   * the highest-rated available body instead would take the receiver and leave
   * fourteen points a week on the wire.
   */
  const needsKicker = rosterImpact({
    ...base,
    teamId: 1,
    playerIds: roster,
    sends: ['rb3', 'wr6'],
    receives: [star],
    freeAgentPool: ['fa1', 'fa2', 'faK'],
  });
  check(
    'and the pickup that helps is taken over the one that merely rates higher',
    needsKicker.added.join() === 'faK' && needsKicker.delta > twoForOne.delta,
    `added ${needsKicker.added.join(',')}, delta ${needsKicker.delta} vs ${twoForOne.delta}`,
  );

  /*
   * Surplus. A team already starting two good running backs plus a flex gains
   * far less from a fourth than the market price of one, and this is the only
   * half of the page that can see it.
   */
  const surplus = rosterImpact({ ...base, teamId: 1, playerIds: roster, sends: [], receives: [star] });
  const marketPrice = values.byPlayer.get(star)!.points;
  check(
    'roster impact prices surplus below market value',
    surplus.delta < marketPrice,
    `lineup gain ${surplus.delta} vs market ${marketPrice}`,
  );

  const gutted = rosterImpact({
    ...base,
    teamId: 1,
    playerIds: roster,
    sends: ['k1'],
    receives: [],
  });
  check(
    'a roster that cannot fill its lineup card says which slot is empty',
    gutted.shortAt.includes('K'),
    `short at ${gutted.shortAt.join(',') || 'nothing'}`,
  );

  check(
    'a null trade moves nothing',
    near(rosterImpact({ ...base, teamId: 1, playerIds: roster, sends: [], receives: [] }).delta, 0),
  );
}

process.stdout.write('\ncross-position normalization\n');
{
  const playersById = new Map<string, Player>();
  const weeklyProjections = new Map<string, Map<number, number>>();
  for (const [index, group] of POSITION_GROUPS.entries()) {
    // Very different scoring levels, identical advantages above replacement.
    const baseline = 30 - index * 4;
    for (const [rank, edge] of [2, 0, 0, 0, -2].entries()) {
      const pid = `${group}${rank}`;
      playersById.set(pid, player(pid, group));
      weeklyProjections.set(pid, new Map([[1, baseline + edge], [2, baseline + edge]]));
    }
  }
  const input = {
    playersById, weeklyProjections, rosteredIds: new Set<string>(),
    rosterSlots: ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST'], numTeams: 3, fromWeek: 1, finalWeek: 2,
  };
  const equal = buildTradeValues(input);
  check('equal replacement advantages have equal value across all six positions',
    POSITION_GROUPS.every((group) => equal.byPlayer.get(`${group}0`)?.points === 4 &&
      equal.byPlayer.get(`${group}0`)?.index === 100));

  weeklyProjections.set('RB0', new Map([[1, 30], [2, 30]]));
  const doubled = buildTradeValues(input);
  check('twice the replacement advantage earns twice the normalized value',
    doubled.byPlayer.get('RB0')?.index === 100 &&
    POSITION_GROUPS.filter((group) => group !== 'RB').every((group) =>
      doubled.byPlayer.get(`${group}0`)?.index === 50));
  weeklyProjections.set('RB0', new Map([[1, 30]]));
  check('a bye removes just its own value without a replacement penalty',
    buildTradeValues(input).byPlayer.get('RB0')?.points === 4);

  playersById.set('unknown', player('unknown', 'WR'));
  const padded = buildTradeValues(input);
  check('unprojected players cannot change the scale or replacement level',
    padded.byPlayer.get('unknown')?.unprojected === true &&
    padded.replacementPerWeek.get('WR') === equal.replacementPerWeek.get('WR') &&
    padded.byPlayer.get('WR0')?.index === 100);
  weeklyProjections.set('unknown', new Map([[1, NaN], [2, Infinity]]));
  const invalid = buildTradeValues(input);
  check('nonfinite projections are missing evidence, never a poisoned position pool',
    invalid.byPlayer.get('unknown')?.unprojected === true &&
    invalid.byPlayer.get('WR0')?.index === 100);
  weeklyProjections.delete('unknown');

  const noKicker = buildTradeValues({ ...input, rosterSlots: ['QB', 'RB', 'WR', 'TE', 'D/ST'] });
  check('a position with no eligible starting slot has no lineup value',
    noKicker.byPlayer.get('K0')?.points === 0 && noKicker.byPlayer.get('K0')?.index === 0);
  const flexOnly = buildTradeValues({
    ...input, rosterSlots: ['FLEX'],
    rosteredIds: new Set([...playersById.keys()].filter((pid) => pid.startsWith('WR'))),
  });
  check('FLEX eligibility retains bench value even without a dedicated or allocated seat',
    !flexOnly.startingDepthByGroup.has('WR') &&
    flexOnly.replacementPerWeek.get('WR') === flexOnly.replacementPerWeek.get('RB') &&
    (flexOnly.byPlayer.get('WR0')?.points ?? 0) > 0 &&
    flexOnly.byPlayer.get('K0')?.points === 0);

  for (const [pid, weeks] of weeklyProjections) {
    weeklyProjections.set(pid, new Map([...weeks].map(([week, points]) => [week, points * 0.003])));
  }
  const tiny = buildTradeValues(input);
  check('rounding small point margins cannot erase or overflow the normalized leader',
    Math.max(...[...tiny.byPlayer.values()].map((value) => value.index)) === 100 &&
    POSITION_GROUPS.every((group) => tiny.byPlayer.get(`${group}0`)?.index === 100));
  const ended = buildTradeValues({ ...input, fromWeek: 3 });
  check('an ended season has no fabricated positive value',
    [...ended.byPlayer.values()].every((value) => value.unprojected && value.points === 0 && value.index === 0));
}

process.stdout.write(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
