/**
 * Checks the forecast machinery against ground truth it cannot see.
 *
 * The residual model claims to measure three things about the gap between a
 * projection and a result — a bias, a spread that grows with the projection
 * level, and a skew. Those claims are only worth anything if the fit can
 * recover values that were planted in the data on purpose, so that is what this
 * does: generate player-weeks from a distribution with a known shift, a known
 * scale line and a known asymmetry, run the real fitter over them, and assert
 * it finds what was put there.
 *
 * The quantile machinery is checked the same way, against the analytic answer
 * rather than against itself.
 *
 * Run with `npm run verify:forecast`.
 */

import { compileScoring } from '../src/lib/scoring';
import {
  buildWeekForecast,
  cdfOfZ,
  fitResidualModel,
  quantileOfZ,
  scaleFor,
  scoreAtQuantile,
  type PlayerForecast,
  type ResidualFit,
} from '../src/lib/forecast';
import { simulateSeason, simulateWeek, type SimTeam } from '../src/lib/simulate';
import type { Player, PositionGroup, StatLine } from '../src/lib/types';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures++;
}

function near(label: string, actual: number, expected: number, tolerance: number): void {
  check(
    label,
    Math.abs(actual - expected) <= tolerance,
    `got ${actual.toFixed(3)}, expected ${expected.toFixed(3)} ±${tolerance}`,
  );
}

/** Deterministic PRNG, so a failure is always reproducible. */
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

/** Box–Muller, for a clean standard normal. */
function normal(random: () => number): number {
  const u = Math.max(1e-9, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Synthetic season with planted parameters
// ---------------------------------------------------------------------------

const TRUE_SHIFT = -0.35; // median z: projections run this much high
const TRUE_INTERCEPT = 1.5;
const TRUE_SLOPE = 0.15;
/*
 * Projections are drawn from a band well clear of zero. A real score cannot go
 * negative, so a small projection against a wide scale truncates its own left
 * tail and drags the fitted median up — a genuine property of the data, and a
 * confound in a test whose whole job is to recover a planted median. Keeping
 * the floor non-binding (it bites on well under 1% of rows here) isolates what
 * this is checking.
 */
const MIN_PROJECTION = 8;
const MAX_PROJECTION = 30;
const WEEKS = 17;
const PLAYERS = 260;

/**
 * One scoring key with a multiplier of 1, so a "stat line" is just its points.
 * The engine is verified separately against ESPN's own totals; here the point
 * is the distribution, and going through several real stat keys would only put
 * noise between the planted value and the fitted one.
 *
 * `rush_att` specifically, because it is one of the keys `hasPlayed` reads. A
 * stat line built from a key that only scores — rushing *yards*, say — would be
 * worth points and still look like a player who never took the field, and the
 * fitter would correctly discard every row.
 */
const scoringModel = compileScoring({ rush_att: 1 });
const line = (points: number): StatLine => ({ rush_att: points });

function syntheticSeason(seed: number, skew: number) {
  const random = rng(seed);
  const playersById = new Map<string, Player>();
  const weekStats = new Map<number, Record<string, StatLine>>();
  const weekProjections = new Map<number, Record<string, StatLine>>();
  const weekTeams = new Map<number, Record<string, string>>();

  for (let i = 0; i < PLAYERS; i++) {
    playersById.set(`p${i}`, {
      playerId: `p${i}`,
      name: `Player ${i}`,
      firstName: 'P',
      lastName: String(i),
      group: 'RB' as PositionGroup,
      team: `T${i % 32}`,
      proTeamId: (i % 32) + 1,
      eligibleSlots: ['RB'],
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
    });
  }

  for (let week = 1; week <= WEEKS; week++) {
    const stats: Record<string, StatLine> = {};
    const projections: Record<string, StatLine> = {};
    const teams: Record<string, string> = {};

    for (let i = 0; i < PLAYERS; i++) {
      const pid = `p${i}`;
      // Spread projections across the range so the scale line is identifiable.
      const projection = MIN_PROJECTION + (i / PLAYERS) * (MAX_PROJECTION - MIN_PROJECTION);
      const scale = TRUE_INTERCEPT + TRUE_SLOPE * projection;

      let z = normal(random);
      // Exponential-tilt the upside so the shape carries a known right skew.
      if (skew > 0 && z > 0) z *= 1 + skew * z;

      projections[pid] = line(projection);
      stats[pid] = line(Math.max(0, projection + scale * (z + TRUE_SHIFT)));
      teams[pid] = `T${i % 32}`;
    }

    weekStats.set(week, stats);
    weekProjections.set(week, projections);
    weekTeams.set(week, teams);
  }

  return { playersById, weekStats, weekProjections, weekTeams };
}

// ---------------------------------------------------------------------------

process.stdout.write('fit recovers planted parameters\n');

const season = syntheticSeason(0x5eed, 0.35);
const model = fitResidualModel({
  scoringModel,
  playersById: season.playersById,
  weekStats: season.weekStats,
  weekProjections: season.weekProjections,
  weekTeams: season.weekTeams,
  throughWeek: WEEKS,
});

const fit = model.byGroup.get('RB');
check('a fit was produced for the populated group', fit !== undefined);

if (fit) {
  near('scale intercept', fit.scaleIntercept, TRUE_INTERCEPT, 1.2);
  near('scale slope', fit.scaleSlope, TRUE_SLOPE, 0.1);
  near('median z (the planted bias)', fit.medianZ, TRUE_SHIFT, 0.1);
  check(
    'skew survives into the shape',
    fit.shape[fit.shape.length - 1] > Math.abs(fit.shape[0]),
    `upper knot ${fit.shape[fit.shape.length - 1].toFixed(2)} vs lower ` +
      `${fit.shape[0].toFixed(2)}`,
  );
  check(
    'playRate is ~1, since every row carries a stat line',
    fit.playRate > 0.98,
    `playRate ${fit.playRate.toFixed(4)}`,
  );
  check(
    'the fit is this season\'s, not borrowed',
    fit.bootstrapped === false,
    `bootstrapped=${fit.bootstrapped}`,
  );

  // scaleFor must reproduce the line it was fit with.
  near('scaleFor at p=10', scaleFor(fit, 10), fit.scaleIntercept + fit.scaleSlope * 10, 1e-9);

  process.stdout.write('\nquantile machinery is self-consistent\n');
  for (const u of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const z = quantileOfZ(fit, u);
    near(`cdf(quantile(${u})) round-trips`, cdfOfZ(fit, z), u, 0.02);
  }

  check(
    'quantiles are monotone in u',
    [0.05, 0.25, 0.5, 0.75, 0.95]
      .map((u) => quantileOfZ(fit, u))
      .every((z, i, all) => i === 0 || z >= all[i - 1]),
  );

  const low = scoreAtQuantile(fit, 12, 0.1);
  const mid = scoreAtQuantile(fit, 12, 0.5);
  const high = scoreAtQuantile(fit, 12, 0.9);
  check('scoreAtQuantile is ordered', low <= mid && mid <= high, `${low} ≤ ${mid} ≤ ${high}`);
  check('scores never go negative', low >= 0, `floor came out ${low}`);
}

// ---------------------------------------------------------------------------

process.stdout.write('\nthe fit borrows from prior pairs only when it must\n');

const empty = fitResidualModel({
  scoringModel,
  playersById: season.playersById,
  weekStats: new Map(),
  weekProjections: new Map(),
  weekTeams: new Map(),
  throughWeek: 0,
  priorPairs: new Map([
    [
      'RB' as PositionGroup,
      Array.from({ length: 800 }, (_, i) => ({
        pid: `p${i % PLAYERS}`,
        projection: 2 + (i % 20),
        actual: Math.max(0, 2 + (i % 20) + normal(rng(i + 1)) * 4),
        played: true,
        week: (i % WEEKS) + 1,
        team: `T${i % 32}`,
      })),
    ],
  ]),
});

const borrowed = empty.byGroup.get('RB');
check('a borrowed fit exists with zero weeks of this season', borrowed !== undefined);
check('it is flagged as borrowed', borrowed?.bootstrapped === true);
check(
  'zero points still count as an appearance when participation is recorded',
  (borrowed?.playRate ?? 0) > 0.99,
  `playRate ${borrowed?.playRate.toFixed(4)}`,
);
check(
  'no per-player bias is learned from a borrowed fit',
  empty.biasByPlayer.size === 0,
  `${empty.biasByPlayer.size} players carried a bias`,
);

const own = fitResidualModel({
  scoringModel,
  playersById: season.playersById,
  weekStats: season.weekStats,
  weekProjections: season.weekProjections,
  weekTeams: season.weekTeams,
  throughWeek: WEEKS,
  priorPairs: new Map([['RB' as PositionGroup, []]]),
});
check(
  'a season with its own data does not borrow',
  own.byGroup.get('RB')?.bootstrapped === false,
);

// ---------------------------------------------------------------------------

process.stdout.write('\nan offline multi-season fit is installed rather than refitted\n');

/*
 * The fit that ships in `priors.json`, built in Node over every finished
 * season. It arrives already fitted, so the client installs it — there is
 * nothing a phone can improve by rebuilding a 257-knot shape from pairs it
 * would have to download first.
 *
 * The three properties checked here are the ones that would fail silently:
 * that the shipped shape is used verbatim, that a *weekly* fit is allowed to
 * teach per-player bias where the old prorated stand-in was not, and that the
 * separate forward availability comes across.
 */
const offlineFit = {
  seasons: [2025, 2024, 2023],
  granularity: 'weekly' as const,
  groups: [
    {
      ...(borrowed as ResidualFit),
      group: 'RB' as PositionGroup,
      samples: 4321,
      scaleIntercept: 3.25,
      scaleSlope: 0.5,
      bootstrapped: false,
    },
  ],
  teamCorrelation: 0.0777,
  plays: { p1: [9, 10] as [number, number] },
  bias: { p1: [-1.5, 12] as [number, number] },
  forwardPlayRate: { RB: 0.84 },
  forwardPlays: { p1: [30, 40] as [number, number] },
};

const installed = fitResidualModel({
  scoringModel,
  playersById: season.playersById,
  weekStats: new Map(),
  weekProjections: new Map(),
  weekTeams: new Map(),
  throughWeek: 0,
  priorFit: offlineFit,
});

const installedRb = installed.byGroup.get('RB');
check(
  'the shipped fit is used as-is, not refitted',
  installedRb?.samples === 4321 && installedRb.scaleIntercept === 3.25,
  `samples ${installedRb?.samples}, intercept ${installedRb?.scaleIntercept}`,
);
check('and is still flagged as borrowed', installedRb?.bootstrapped === true);
check(
  'a weekly-granularity fit does teach per-player bias',
  installed.biasByPlayer.get('p1')?.n === 12,
);
check(
  "the offline team correlation stands in until this season has team-weeks",
  installed.teamCorrelation === 0.0777,
  `got ${installed.teamCorrelation}`,
);
check(
  'forward availability is carried separately from the same-week play rate',
  installed.forwardPlayRate.get('RB') === 0.84 &&
    installed.forwardPlaysByPlayer.get('p1')?.played === 30,
);

/*
 * The prorated stand-in must still teach nothing. Its residuals are measured
 * against a season projection divided by games, so their centre is an artefact
 * of that division rather than a tendency of the player.
 */
const prorated = fitResidualModel({
  scoringModel,
  playersById: season.playersById,
  weekStats: new Map(),
  weekProjections: new Map(),
  weekTeams: new Map(),
  throughWeek: 0,
  priorFit: { ...offlineFit, granularity: 'prorated' as const },
});
check(
  'a prorated fit still teaches no per-player bias',
  prorated.biasByPlayer.size === 0,
  `${prorated.biasByPlayer.size} players carried a bias`,
);

// ---------------------------------------------------------------------------

process.stdout.write('\na later week is not as certain about attendance as this one\n');

/*
 * The distinction the multi-season pairs made measurable. A finished season's
 * projections are published after the inactive list, so being projected at all
 * means being active and the same-week play rate comes out near 1. That is the
 * wrong number for December: the projection for week 14 cannot know about a
 * week 11 hamstring, and the measured forward rate is 78-91%.
 */
const liveWeekForecast = buildWeekForecast({
  model: installed,
  scoringModel,
  playersById: season.playersById,
  projections: { p1: season.weekProjections.get(1)!.p1 },
  horizon: 'live',
});
const laterWeekForecast = buildWeekForecast({
  model: installed,
  scoringModel,
  playersById: season.playersById,
  projections: { p1: season.weekProjections.get(1)!.p1 },
  horizon: 'forward',
});

const livePlay = liveWeekForecast.get('p1')?.playProb ?? 0;
const laterPlay = laterWeekForecast.get('p1')?.playProb ?? 0;
check(
  'a week months away carries a lower play probability than this one',
  laterPlay < livePlay,
  `live ${livePlay.toFixed(3)} vs forward ${laterPlay.toFixed(3)}`,
);
check(
  'and a lower expected contribution follows from it',
  (laterWeekForecast.get('p1')?.mean ?? 0) < (liveWeekForecast.get('p1')?.mean ?? 0),
);
check(
  'a player ruled out today is out this week and merely doubtful later',
  (buildWeekForecast({
    model: installed,
    scoringModel,
    playersById: season.playersById,
    projections: { p1: season.weekProjections.get(1)!.p1 },
    isOut: () => true,
    horizon: 'live',
  }).get('p1')?.playProb ?? 1) === 0 &&
    (buildWeekForecast({
      model: installed,
      scoringModel,
      playersById: season.playersById,
      projections: { p1: season.weekProjections.get(1)!.p1 },
      isOut: () => true,
      horizon: 'forward',
    }).get('p1')?.playProb ?? 0) > 0,
);

// ---------------------------------------------------------------------------

process.stdout.write('\nweek forecasts respect the inputs\n');

const forecasts = buildWeekForecast({
  model,
  scoringModel,
  playersById: season.playersById,
  projections: season.weekProjections.get(1)!,
  teams: season.weekTeams.get(1),
});

check('a forecast is built for every projected player', forecasts.size === PLAYERS);

const sample = forecasts.get('p200');
if (sample) {
  check(
    'the band is ordered p10 ≤ p25 ≤ p75 ≤ p90',
    sample.p10 <= sample.p25 && sample.p25 <= sample.p75 && sample.p75 <= sample.p90,
    `${sample.p10} ≤ ${sample.p25} ≤ ${sample.p75} ≤ ${sample.p90}`,
  );
  check(
    'the median is shifted below the projection, as planted',
    sample.median < sample.projection,
    `median ${sample.median} vs projection ${sample.projection}`,
  );
  check('quantiles never go negative', sample.p10 >= 0, `p10 ${sample.p10}`);
}

const matchupAdjusted = buildWeekForecast({
  model,
  scoringModel,
  playersById: season.playersById,
  projections: season.weekProjections.get(1)!,
  teams: season.weekTeams.get(1),
  matchupFactors: new Map([['p200', 1.1]]),
});

const adjustedSample = matchupAdjusted.get('p200');
if (sample && adjustedSample) {
  check(
    'a favorable positional matchup raises the model forecast without rewriting ESPN',
    adjustedSample.projection === sample.projection && adjustedSample.median > sample.median,
    `source ${adjustedSample.projection}, median ${sample.median} → ${adjustedSample.median}`,
  );
  near(
    'the matchup shift is the fitted factor applied to the custom-score projection',
    adjustedSample.matchupShift,
    sample.projection * 0.1,
    0.02,
  );
  check(
    'a favorable matchup raises boom chance and lowers bust risk',
    adjustedSample.boomProb !== null &&
      sample.boomProb !== null &&
      adjustedSample.bustProb !== null &&
      sample.bustProb !== null &&
      adjustedSample.boomProb > sample.boomProb &&
      adjustedSample.bustProb < sample.bustProb,
    `boom ${sample.boomProb} → ${adjustedSample.boomProb}, bust ${sample.bustProb} → ${adjustedSample.bustProb}`,
  );
}

const withOut = buildWeekForecast({
  model,
  scoringModel,
  playersById: season.playersById,
  projections: season.weekProjections.get(1)!,
  teams: season.weekTeams.get(1),
  isOut: (pid) => pid === 'p200',
});

/*
 * `median` stays conditional on playing — it answers "what would he do if he
 * suited up". The unconditional numbers are `mean` and the quantiles, and those
 * are what a team total is summed from, so those are what must go to zero.
 */
const out = withOut.get('p200');
check('a player marked out has zero play probability', out?.playProb === 0);
check('his contribution to a team total is zero', out?.mean === 0, `mean ${out?.mean}`);
check('his whole band collapses to zero', out?.p90 === 0, `p90 ${out?.p90}`);
check('an unavailable projected player is a certain bust', out?.bustProb === 1);
check('an unavailable projected player cannot boom', out?.boomProb === 0);

// ---------------------------------------------------------------------------

process.stdout.write('\nseason simulation uses each week\'s own forecast\n');

const forecast = (pid: string, projection: number): PlayerForecast => ({
  pid,
  group: 'RB',
  projection,
  median: projection,
  biasShift: 0,
  matchupShift: 0,
  mean: projection,
  sd: 0,
  p10: projection,
  p25: projection,
  p75: projection,
  p90: projection,
  playProb: 1,
  boomProb: 0,
  bustProb: 0,
  actual: null,
  nflTeam: pid,
});

const teamsFor = (a: number, b: number): SimTeam[] => [
  { teamId: 1, starters: [forecast(`a-${a}`, a)] },
  { teamId: 2, starters: [forecast(`b-${b}`, b)] },
];

const fixedWeek = simulateWeek({
  teams: [
    { teamId: 1, starters: [{ ...forecast('fixed-a', 12), actual: 12 }] },
    { teamId: 2, starters: [{ ...forecast('fixed-b', 8), actual: 8 }] },
  ],
  model,
  pairings: [{ matchupId: 1, teamIds: [1, 2] }],
  iterations: 101,
  seed: 0x5050,
});

check(
  'weekly simulation exposes the actual simulated median used to centre its range',
  fixedWeek.medianScores.get(1) === 12 && fixedWeek.matchups[0].homeMedian === 12,
);

const weeklySeason = simulateSeason({
  // The fallback deliberately favors team 1 in both games. If weeklyTeams is
  // ignored, this test produces 2.0 expected wins for team 1 instead of 1.0.
  teams: teamsFor(40, 5),
  weeklyTeams: new Map([
    [1, teamsFor(40, 5)],
    [2, teamsFor(5, 40)],
  ]),
  model,
  standing: new Map([
    [1, { wins: 0, losses: 0, ties: 0, pointsFor: 0 }],
    [2, { wins: 0, losses: 0, ties: 0, pointsFor: 0 }],
  ]),
  remaining: [
    { week: 1, pairings: [[1, 2]] },
    { week: 2, pairings: [[1, 2]] },
  ],
  playoffTeams: 2,
  iterations: 500,
  seed: 0x2026,
});

near(
  'opposite weekly advantages split the two expected wins',
  weeklySeason.byTeam.get(1)?.expectedWins ?? -1,
  1,
  0.08,
);

// ---------------------------------------------------------------------------

process.stdout.write(
  `\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`,
);
if (failures > 0) process.exitCode = 1;
