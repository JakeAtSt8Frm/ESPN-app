/** Verifies that rest-of-season value respects measured positional matchup influence. */

import { MATCHUP_INFLUENCE } from '../src/lib/matchup';
import {
  buildSeasonValueIndex,
  SEASON_WEIGHTS,
} from '../src/lib/season-value';
import { playoffFormat } from '../src/data/league';
import type { Player, PositionGroup } from '../src/lib/types';
import type { ValueIndex } from '../src/lib/value';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures++;
}

function player(pid: string, group: PositionGroup): Player {
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
  };
}

const valueIndex: ValueIndex = {
  byPlayer: new Map(),
  ppgRanks: new Map(),
  totalRanks: new Map(),
  boomRateRanks: new Map(),
  weeklyScores: new Map(),
  seasonTotals: new Map(),
};

const playersById = new Map<string, Player>([
  ['rb', player('rb', 'RB')],
  ['dst', player('dst', 'DST')],
]);
const weeklyProjections = new Map([
  ['rb', new Map([[1, 12]])],
  ['dst', new Map([[1, 8]])],
]);
const weeklyOpportunities = new Map([
  ['rb', new Map([[1, 18]])],
  ['dst', new Map([[1, 6]])],
]);

const index = buildSeasonValueIndex({
  valueIndex,
  playersById,
  weeklyProjections,
  weeklyOpportunities,
  scheduleAhead: new Map([
    ['rb', 80],
    ['dst', 80],
  ]),
  rosterSlots: ['RB', 'D/ST'],
  numTeams: 1,
  fromWeek: 1,
  finalWeek: 1,
});

const scheduleWeight = (pid: string): number =>
  index.byPlayer
    .get(pid)
    ?.breakdown.contributions.find(({ label }) => label === 'Schedule ahead')?.weight ?? -1;
const totalWeight = (pid: string): number =>
  index.byPlayer
    .get(pid)
    ?.breakdown.contributions.reduce((sum, contribution) => sum + contribution.weight, 0) ?? -1;

process.stdout.write('position-aware rest-of-season weights\n');
const redraftFormat = playoffFormat({
  regularSeasonWeeks: 14,
  playoffTeams: 6,
  finalWeek: 17,
});
check(
  'redraft value horizon includes the fantasy playoffs',
  redraftFormat.finalWeek === 17,
  `Week ${redraftFormat.finalWeek}`,
);
check(
  'D/ST keeps the full schedule weight measured for the most matchup-sensitive group',
  Math.abs(scheduleWeight('dst') - SEASON_WEIGHTS.schedule) < 1e-9,
  `${scheduleWeight('dst')}`,
);
check(
  'RB schedule weight is damped by its historical matchup influence',
  Math.abs(scheduleWeight('rb') - SEASON_WEIGHTS.schedule * MATCHUP_INFLUENCE.RB) < 1e-9,
  `${scheduleWeight('rb')}`,
);
check(
  'unused schedule weight returns to projection so every player still sums to 1',
  ['rb', 'dst'].every((pid) => Math.abs(totalWeight(pid) - 1) < 1e-9),
  `RB ${totalWeight('rb')}, DST ${totalWeight('dst')}`,
);

{
  const playersById = new Map<string, Player>();
  const weeklyProjections = new Map<string, Map<number, number>>();
  for (const group of ['RB', 'WR', 'TE'] as const) {
    for (let rank = 1; rank <= 40; rank++) {
      const pid = `${group}${rank}`;
      playersById.set(pid, player(pid, group));
      weeklyProjections.set(pid, new Map([[1, (group === 'WR' ? 40 : 20) - rank * 0.5]]));
    }
  }
  const index = buildSeasonValueIndex({
    valueIndex,
    playersById,
    weeklyProjections,
    weeklyOpportunities: new Map(),
    rosterSlots: ['RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'],
    numTeams: 8,
    fromWeek: 1,
    finalWeek: 1,
  });
  check(
    'season replacement reserves fixed starters before allocating FLEX by scored projections',
    index.replacementByGroup.get('WR') === 28 &&
      index.replacementByGroup.get('RB') === 12 &&
      index.replacementByGroup.get('TE') === 16,
    `RB ${index.replacementByGroup.get('RB')}, WR ${index.replacementByGroup.get('WR')}, TE ${index.replacementByGroup.get('TE')}`,
  );
}

process.stdout.write(
  `\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`,
);
if (failures > 0) process.exitCode = 1;
