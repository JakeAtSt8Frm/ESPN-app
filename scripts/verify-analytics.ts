/**
 * Regression checks for position-aware scoring in the analytical models.
 *
 * ESPN supplies D/ST scoring as a position override. Passing a stat line to
 * the scorer without its position silently applies the base table instead,
 * which can make an otherwise valid defence projection look nearly empty.
 * These checks keep every consumer honest at that boundary.
 *
 * Run with `npm run verify:analytics`.
 */

import {
  buildWeekForecast,
  type ResidualFit,
  type ResidualModel,
} from '../src/lib/forecast';
import { buildMatchupIndex } from '../src/lib/matchup';
import { compileScoring } from '../src/lib/scoring';
import type { Player, StatLine } from '../src/lib/types';
import { reshapeSeason, seasonProduction } from '../src/lib/history';
import { buildPriorRanks, buildValueIndex, type PriorProduction } from '../src/lib/value';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures++;
}

function near(label: string, actual: number | null | undefined, expected: number): void {
  check(label, actual === expected, `got ${String(actual)}, expected ${expected}`);
}

const player: Player = {
  playerId: 'dst',
  name: 'Test Defence',
  firstName: 'Test',
  lastName: 'Defence',
  group: 'DST',
  team: 'DEF',
  proTeamId: 1,
  eligibleSlots: ['D/ST'],
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
const playersById = new Map([['dst', player]]);

// The base table deliberately awards nothing for sacks; only the D/ST
// override does. Omitting the position group therefore produces an exact zero.
const scoringModel = compileScoring({ def_sack: 0 }, { DST: { def_sack: 1 } });
const projection: StatLine = { def_sack: 7 };
const actual: StatLine = { def_sack: 6 };

const fit: ResidualFit = {
  group: 'DST',
  samples: 100,
  scaleIntercept: 1,
  scaleSlope: 0,
  shape: [0, 0],
  medianZ: 0,
  meanZ: 0,
  sdZ: 1,
  floor: 0,
  withinGroupCorrelation: 0,
  playRate: 1,
  bootstrapped: false,
};
const residualModel: ResidualModel = {
  byGroup: new Map([['DST', fit]]),
  teamCorrelation: 0,
  playsByPlayer: new Map([['dst', { played: 1, projected: 1 }]]),
  forwardPlayRate: new Map([['DST', 1]]),
  forwardPlaysByPlayer: new Map(),
  biasByPlayer: new Map(),
  throughWeek: 1,
  totalSamples: 100,
};

process.stdout.write('weekly forecast respects D/ST scoring overrides\n');
const forecast = buildWeekForecast({
  model: residualModel,
  scoringModel,
  playersById,
  projections: { dst: projection },
  stats: { dst: actual },
}).get('dst');
near('source projection', forecast?.projection, 7);
near('actual result', forecast?.actual, 6);
near('central forecast', forecast?.median, 7);

process.stdout.write('\nvalue model respects D/ST scoring overrides\n');
const values = buildValueIndex({
  scoringModel,
  playersById,
  season: '2025',
  weekStats: new Map([[1, { dst: actual }]]),
  weekProjections: new Map([[1, { dst: projection }]]),
  weekOpponents: new Map([[1, { dst: 'OFF' }]]),
  weekTeams: new Map([[1, { dst: 'DEF' }]]),
  forecastProjections: { dst: projection },
  throughWeek: 1,
});
near('season total', values.seasonTotals.get('dst'), 6);
near('weekly actual', values.weeklyScores.get('dst')?.[0]?.actual, 6);
near('weekly projection', values.weeklyScores.get('dst')?.[0]?.projected, 7);
near('forecast input', values.byPlayer.get('dst')?.breakdown.forecastProjection, 7);

process.stdout.write('\nhalf-PPR value uses opponent games and distinguishes byes from absences\n');
const halfPprScoring = compileScoring({ rec: 0.5, rec_yd: 0.1 });
const receiver = (pid: string, byeWeek: number | null = null): Player => ({
  ...player,
  playerId: pid,
  name: pid,
  group: 'WR',
  eligibleSlots: ['WR', 'FLEX'],
  byeWeek,
});
const receiverStats: StatLine = { gp: 1, rec: 4, rec_tgt: 8, rec_yd: 180 };
function scheduleValue(extraPlayers: Record<string, StatLine> = {}) {
  const stats = { star: receiverStats, peer: receiverStats, ...extraPlayers };
  return buildValueIndex({
    scoringModel: halfPprScoring,
    playersById: new Map(Object.keys(stats).map((pid) => [pid, receiver(pid)])),
    season: '2026',
    weekStats: new Map([[1, stats]]),
    weekProjections: new Map(),
    weekOpponents: new Map([[1, { star: 'A', peer: 'B', backup: 'A' }]]),
    throughWeek: 1,
  }).byPlayer.get('star')?.breakdown;
}
near('four receptions add two half-PPR points', scheduleValue()?.ppg, 20);
near('equal unit production gives a neutral schedule adjustment', scheduleValue()?.scheduleAdjustedPpg, 20);
near(
  'a harder opponent still raises schedule-adjusted production',
  scheduleValue({ peer: { gp: 1, rec_yd: 300 } })?.scheduleAdjustedPpg,
  25,
);
near(
  'a zero-point backup does not make the same defense look harder',
  scheduleValue({ backup: { gp: 1 } })?.scheduleAdjustedPpg,
  20,
);
near(
  'unknown opponents do not distort the known-opponent baseline',
  scheduleValue({ unknown: { gp: 1, rec_yd: 1000 } })?.scheduleAdjustedPpg,
  20,
);

const availabilityPlayers = new Map([
  ['healthy', receiver('healthy', 3)],
  ['injured', receiver('injured', 3)],
  ['futureBye', receiver('futureBye', 7)],
  ['unknownBye', receiver('unknownBye')],
  ['playedOnListedBye', receiver('playedOnListedBye', 3)],
]);
const availabilityStats = new Map<number, Record<string, StatLine>>();
for (let week = 1; week <= 6; week++) {
  const stats: Record<string, StatLine> = {};
  if (week !== 4) {
    stats.futureBye = receiverStats;
    stats.playedOnListedBye = receiverStats;
  }
  if (week !== 3) {
    stats.healthy = receiverStats;
    stats.unknownBye = receiverStats;
    if (week !== 4) stats.injured = receiverStats;
  }
  availabilityStats.set(week, stats);
}
const availabilityValues = buildValueIndex({
  scoringModel: halfPprScoring,
  playersById: availabilityPlayers,
  season: '2026',
  weekStats: availabilityStats,
  weekProjections: new Map(),
  throughWeek: 6,
});
const availability = (pid: string) => availabilityValues.byPlayer.get(pid)?.breakdown.availability;
near('a healthy player is fully available across a known bye', availability('healthy'), 1);
near('a missed game still reduces availability after removing the bye', availability('injured'), 0.8);
near('a future bye is not removed early', availability('futureBye'), 0.833);
near('an unknown bye is not inferred from missing stats', availability('unknownBye'), 0.833);
near('recorded participation takes precedence over bye metadata', availability('playedOnListedBye'), 0.833);

process.stdout.write('\nboom rate is ranked within position\n');
const boomPlayersById = new Map<string, Player>([
  ['boom', { ...player, playerId: 'boom', name: 'Boom Player' }],
  ['steady', { ...player, playerId: 'steady', name: 'Steady Player' }],
]);
const boomStats = new Map<number, Record<string, StatLine>>(
  [1, 2, 3].map((week) => [
    week,
    { boom: { def_sack: 10 }, steady: { def_sack: 4 } },
  ]),
);
const boomProjections = new Map<number, Record<string, StatLine>>(
  [1, 2, 3].map((week) => [
    week,
    { boom: { def_sack: 5 }, steady: { def_sack: 5 } },
  ]),
);
const boomValues = buildValueIndex({
  scoringModel,
  playersById: boomPlayersById,
  season: '2025',
  weekStats: boomStats,
  weekProjections: boomProjections,
  throughWeek: 3,
});
near('frequent boom rank', boomValues.boomRateRanks.get('boom')?.rank, 1);
near('steady player boom rank', boomValues.boomRateRanks.get('steady')?.rank, 2);
near('boom rank pool size', boomValues.boomRateRanks.get('boom')?.outOf, 2);

/*
 * The rank chips before the season starts.
 *
 * Two claims worth holding down. `seasonProduction` must gate exactly as
 * `buildValueIndex` does — a week with no participation is not a game, and a
 * week with no projection cannot boom — because the chips switch between the two
 * in week four and must not change what they are claiming when they do. And
 * `buildPriorRanks` must apply a finished season's six-game threshold, so a
 * two-game cameo does not appear at the top of a per-game ranking.
 */
process.stdout.write('\nprior-season ranks gate like the in-season ones\n');

const week = (n: number) => String(n);

const history = reshapeSeason({
  season: 2025,
  positions: { star: 1, cameo: 1, unprojected: 1 },
  actuals: {
    star: {
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((w) => [week(w), { pass_yds: 500, gp: 1 }])),
      // Rostered, did not play: not a game, and not a boom.
      7: {},
    },
    cameo: Object.fromEntries([1, 2].map((w) => [week(w), { pass_yds: 1000, gp: 1 }])),
    unprojected: Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map((w) => [week(w), { pass_yds: 500, gp: 1 }]),
    ),
  },
  projections: {
    star: Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7].map((w) => [week(w), { pass_yds: 250, gp: 1 }]),
    ),
    cameo: Object.fromEntries([1, 2].map((w) => [week(w), { pass_yds: 250, gp: 1 }])),
  },
  games: {},
});

const production = seasonProduction(history, compileScoring({ pass_yds: 0.04 }, {}), 1.2);
near('games exclude the week he did not play', production.get('star')?.games, 6);
near('total over played weeks only', production.get('star')?.total, 120);
near('booms counted where a projection existed', production.get('star')?.boom, 6);
near('boom denominator excludes the missed week', production.get('star')?.projectedGames, 6);
near('unprojected weeks cannot boom', production.get('unprojected')?.projectedGames, 0);
near('unprojected weeks still count as games', production.get('unprojected')?.games, 6);

const priorRows: PriorProduction[] = [...production].map(([pid, entry]) => ({
  pid,
  season: '2025',
  group: 'QB' as const,
  total: entry.total,
  games: entry.games,
  ppg: entry.total / entry.games,
  boom: entry.boom,
  projectedGames: entry.projectedGames,
  boomRate: entry.projectedGames > 0 ? entry.boom / entry.projectedGames : 0,
}));
const priorRanks = buildPriorRanks('2025', priorRows, 18);

check(
  'a two-game cameo is not ranked by points per game',
  priorRanks.ppgRanks.get('cameo') === undefined,
  `got ${JSON.stringify(priorRanks.ppgRanks.get('cameo'))}`,
);
near('a full season is ranked by points per game', priorRanks.ppgRanks.get('star')?.rank, 1);
near('the cameo still has a points total to rank', priorRanks.totalRanks.get('cameo')?.rank, 3);
check(
  'a player with no projected weeks has no boom rank',
  priorRanks.boomRateRanks.get('unprojected') === undefined,
);
check(
  'ranks carry the season they were measured over',
  priorRanks.ppgRanks.get('star')?.season === '2025',
  `got ${String(priorRanks.ppgRanks.get('star')?.season)}`,
);

process.stdout.write('\nmatchup model respects D/ST scoring overrides\n');
const matchups = buildMatchupIndex({
  scoringModel,
  playersById,
  weekStats: new Map([[1, { dst: actual }]]),
  weekOpponents: new Map([[1, { dst: 'OFF' }]]),
  weekTeams: new Map([[1, { dst: 'DEF' }]]),
  throughWeek: 1,
});
near('points allowed per game', matchups.get('DST', 'OFF')?.pointsPerGame, 6);

process.stdout.write(
  `\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`,
);
if (failures > 0) process.exitCode = 1;
