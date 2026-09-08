import assert from 'node:assert/strict';
import { actualOptimalLineup } from '../src/data/predictions';
import {
  buildWeekForecast,
  cdfOfZ,
  mixtureCdf,
  type ResidualFit,
  type ResidualModel,
} from '../src/lib/forecast';
import { compareForecasts, probabilityAbove } from '../src/lib/forecast-decisions';
import {
  FORECAST_REPORT_VERSION,
  isForecastReport,
  type ForecastReport,
} from '../src/lib/forecast-report';
import { compileScoring } from '../src/lib/scoring';
import { sampleTeamTotals } from '../src/lib/simulate';
import type { Player } from '../src/lib/types';

const fit: ResidualFit = {
  group: 'RB',
  samples: 1000,
  scaleIntercept: 1,
  scaleSlope: 0,
  shape: [-2, 0, 2],
  medianZ: 0,
  meanZ: 0,
  sdZ: Math.sqrt(4 / 3),
  floor: 0,
  withinGroupCorrelation: 0,
  playRate: 1,
  bootstrapped: false,
};
const model: ResidualModel = {
  byGroup: new Map([['RB', fit]]),
  teamCorrelation: 0.2,
  playsByPlayer: new Map(),
  biasByPlayer: new Map(),
  forwardPlayRate: new Map(),
  forwardPlaysByPlayer: new Map(),
  throughWeek: 0,
  totalSamples: 1000,
};
const player: Player = {
  playerId: 'a',
  name: 'Player A',
  firstName: 'Player',
  lastName: 'A',
  group: 'RB',
  team: 'BUF',
  proTeamId: 2,
  eligibleSlots: ['RB', 'FLEX'],
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
const forecasts = buildWeekForecast({
  model,
  scoringModel: compileScoring({ rush_att: 1 }),
  playersById: new Map([['a', player]]),
  projections: { a: { rush_att: 1 } },
});
const a = forecasts.get('a');
assert.ok(a);

// A uniform [-1, 3] score floored at zero has an atom of 1/4 at zero.
// Its exact mean is 9/8; its second moment is 9/4.
assert.equal(a.mean, 1.13, 'expected points must include the simulation floor');
assert.ok(Math.abs(a.sd - Math.sqrt(2.25 - 1.125 ** 2)) < 0.01);
assert.equal(mixtureCdf(fit, 1, 1, -0.5, 0), 0, 'no results below the floor');
assert.equal(probabilityAbove(model, a, 0), 0.75, 'zero-point atom counts as a tie');
assert.equal(probabilityAbove(model, a, 2), 0.25);
assert.equal(probabilityAbove(model, a, NaN), null);
assert.equal(
  cdfOfZ({ ...fit, shape: [0, 0, 1] }, 0),
  0.5,
  'repeated minimum knots retain their probability mass',
);
assert.equal(
  cdfOfZ({ ...fit, shape: [0, 0, 0] }, 0),
  1,
  'a point distribution includes its only outcome',
);
assert.equal(probabilityAbove(model, { ...a, playProb: 0 }, 0), 0);
assert.ok(Math.abs((probabilityAbove(model, { ...a, playProb: 0.8 }, 0) ?? 0) - 0.6) < 1e-12);
assert.equal(probabilityAbove(model, { ...a, actual: 2 }, 2), 0);

// Half the played distribution lands exactly at the boom threshold (12).
// Recorded boom rates use >=, whereas the target tool deliberately uses >.
const boomModel = {
  ...model,
  byGroup: new Map([['RB' as const, { ...fit, shape: [2, 2, 4], playRate: 0.8 }]]),
};
const exactBoom = buildWeekForecast({
  model: boomModel,
  scoringModel: compileScoring({ rush_att: 1 }),
  playersById: new Map([['a', player]]),
  projections: { a: { rush_att: 10 } },
}).get('a');
assert.ok(exactBoom);
assert.equal(exactBoom.boomProb, 0.8, 'reaching exactly 120% counts as a boom');
assert.ok(Math.abs((probabilityAbove(boomModel, exactBoom, 12) ?? 0) - 0.4) < 1e-12);

assert.deepEqual(compareForecasts(model, a, a), { aWins: 0, bWins: 0, ties: 1, iterations: 20000 });

const b = { ...a, pid: 'b', nflTeam: 'KC' };
const comparison = compareForecasts(model, a, b);
assert.ok(
  Math.abs(comparison.aWins - comparison.bWins) < 0.02,
  'identical distributions are balanced',
);
assert.ok(Math.abs(comparison.aWins + comparison.bWins + comparison.ties - 1) < 1e-12);
assert.deepEqual(comparison, compareForecasts(model, a, b), 'comparisons are reproducible');
assert.throws(() => compareForecasts(model, a, b, 0));
assert.equal(
  actualOptimalLineup(['RB'], [{ pid: 'a', group: 'RB', slot: 'RB', act: 0 }]).total,
  0,
  'unplayed rosters contribute zero in a league-wide results view',
);
assert.equal(
  actualOptimalLineup(
    ['RB'],
    [
      { pid: 'a', group: 'RB', slot: 'RB', act: 3 },
      { pid: 'b', group: 'RB', slot: 'BN', act: 7 },
      { pid: 'ir', group: 'RB', slot: 'IR', act: 20 },
    ],
  ).total,
  7,
  'recorded optimal results exclude IR players',
);
const [draws] = sampleTeamTotals([{ teamId: 1, starters: [a] }], model, 30000);
const simulatedMean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
assert.ok(
  Math.abs(simulatedMean - a.mean) < 0.025,
  'displayed expected points agree with simulated outcomes',
);
const report: ForecastReport = {
  version: FORECAST_REPORT_VERSION,
  scoringKey: 'half-ppr',
  folds: [{ training: [2023], testing: 2024 }],
  rows: [{ group: 'ALL', samples: 120, modelMae: 4, espnMae: 5, coverage80: 0.8 }],
};
assert.ok(isForecastReport(report));
assert.equal(
  isForecastReport({ ...report, version: 1 }),
  false,
  'reports from before the conditional-play correction cannot validate the current model',
);
process.stdout.write(
  'Prediction Lab: distribution floors, target odds, ties, reproducibility and simulation parity pass.\n',
);
