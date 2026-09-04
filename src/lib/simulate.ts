/**
 * Monte Carlo over the forecast distributions in `forecast.ts`.
 *
 * Two questions, one engine:
 *
 *  - **Win probability**, for a week in progress. Players who have finished
 *    contribute their real score; everyone still to play is sampled. This is the
 *    number that actually changes how a Sunday feels, and it is only honest if
 *    the correlation structure is right — see the note on shared shocks below.
 *
 *  - **Playoff, seed and title odds**, from any week forward. The remaining
 *    schedule is replayed thousands of times and the bracket is resolved under
 *    the league's own playoff settings.
 *
 * ## Why the sampling is not independent
 *
 * The temptation is to draw each player independently. That is wrong in a way
 * that matters: two players in the same NFL game share a pace, a game script and
 * a weather report, so their outcomes move together. Independent draws make a
 * team total's variance far too small — sums of independent variables
 * concentrate — and a simulator with too little variance reports win
 * probabilities pushed toward 0% and 100%. It looks decisive and is wrong.
 *
 * So each NFL team gets one shared shock per iteration, and every player on it
 * mixes that shock with an idiosyncratic one in proportion to the correlation
 * measured for his position group. The mixing happens in Gaussian space and is
 * pushed back through each group's own empirical quantile function, which is a
 * Gaussian copula: the dependence is induced without disturbing any of the
 * skewed, heteroskedastic marginals that were fit from real data.
 *
 * This also correctly couples *opposing fantasy teams*. Two managers in the same
 * league frequently own players in the same NFL game, and the shared shock is
 * drawn once per NFL team per iteration across the whole league — so those
 * holdings move together, exactly as they do in reality.
 */

import {
  quantileOfZ,
  scaleFor,
  type PlayerForecast,
  type ResidualModel,
} from './forecast';
import { clamp, round } from './stats';

/**
 * Iterations for a single week's win probability.
 *
 * At 10k the Monte Carlo standard error on a probability is under half a point,
 * which is finer than the number is displayed to — and it keeps the run short
 * enough to happen inline on a page render.
 */
export const WEEK_ITERATIONS = 10000;
/** Iterations for a full rest-of-season run. */
export const SEASON_ITERATIONS = 10000;
/** Team-total draws pooled per team before the season run. */
const POOL_SIZE = 4000;

/* -------------------------------------------------------------------------- */
/* Randomness                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A small seeded PRNG.
 *
 * Seeded deliberately: an unseeded simulation would hand back slightly
 * different odds every time React re-rendered, which reads as a bug and makes
 * two numbers on the same screen disagree.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller, one draw per call. */
function normal(rng: () => number): number {
  const u = Math.max(rng(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * Standard normal CDF.
 *
 * Abramowitz & Stegun 7.1.26 applied to erf; absolute error below 1.5e-7, which
 * is far finer than the Monte Carlo noise it feeds.
 */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/* -------------------------------------------------------------------------- */
/* Team-week sampling                                                          */
/* -------------------------------------------------------------------------- */

export interface SimTeam {
  teamId: number;
  /** The lineup being simulated — starters only. */
  starters: PlayerForecast[];
}

/**
 * Samples one week for every team at once, sharing NFL-team shocks across the
 * whole league so that co-owned games move together.
 */
function sampleLeagueWeek(
  teams: SimTeam[],
  model: ResidualModel,
  rng: () => number,
  out: Float64Array,
): void {
  // One shared shock per NFL team, redrawn each iteration.
  const shocks = new Map<string, number>();

  for (let t = 0; t < teams.length; t++) {
    let total = 0;

    for (const player of teams[t].starters) {
      if (player.actual !== null) {
        total += player.actual;
        continue;
      }
      if (player.playProb <= 0 || player.projection <= 0) continue;

      const fit = model.byGroup.get(player.group);
      if (!fit) continue;

      if (rng() >= player.playProb) continue; // did not play: contributes zero

      /*
       * A player whose NFL team we don't know has nothing to correlate with, so
       * he is drawn purely idiosyncratically. Mixing him against a zero shock
       * instead would quietly scale his variance down to (1 − rho) and make him
       * look far more predictable than the model says he is.
       */
      let rho = 0;
      let shared = 0;
      if (player.nflTeam) {
        rho = model.teamCorrelation;
        const existing = shocks.get(player.nflTeam);
        if (existing === undefined) {
          shared = normal(rng);
          shocks.set(player.nflTeam, shared);
        } else {
          shared = existing;
        }
      }

      const gaussian = Math.sqrt(rho) * shared + Math.sqrt(1 - rho) * normal(rng);
      const z = quantileOfZ(fit, normalCdf(gaussian));
      /*
       * The location is the projection plus the player and matchup shifts —
       * deliberately *not* the displayed median. The group's share of source
       * bias already lives inside `z`; using the median as the centre would
       * apply that group correction twice.
       */
      total += Math.max(
        fit.floor,
        player.projection +
          player.biasShift +
          player.matchupShift +
          scaleFor(fit, player.projection) * z,
      );
    }

    out[t] = total;
  }
}

/**
 * Raw simulated weekly totals, one array per team.
 *
 * Exported so the model can be checked against reality rather than only against
 * itself: `research:forecast` drops each team's real total into its simulated
 * distribution and asks whether those percentiles come out uniform, which is
 * the test that catches a variance assumption being wrong.
 */
export function sampleTeamTotals(
  teams: SimTeam[],
  model: ResidualModel,
  iterations: number,
  seed = 0x51a1,
): Float64Array[] {
  const rng = mulberry32(seed);
  const out = teams.map(() => new Float64Array(iterations));
  const totals = new Float64Array(teams.length);

  for (let i = 0; i < iterations; i++) {
    sampleLeagueWeek(teams, model, rng, totals);
    for (let t = 0; t < teams.length; t++) out[t][i] = totals[t];
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Single week: win probability                                                */
/* -------------------------------------------------------------------------- */

export interface MatchupOdds {
  matchupId: number;
  /** Roster ids, in the order the probabilities are reported. */
  home: number;
  away: number;
  homeWinProb: number;
  awayWinProb: number;
  tieProb: number;
  homeMean: number;
  awayMean: number;
  homeMedian: number;
  awayMedian: number;
  /** Points still to come, summed over players yet to play. */
  homeRemaining: number;
  awayRemaining: number;
}

export interface WeekSimulation {
  matchups: MatchupOdds[];
  /** teamId -> projected final total, averaged over iterations. */
  meanScores: Map<number, number>;
  /** teamId -> median simulated final total. */
  medianScores: Map<number, number>;
  /** teamId -> [p10, p90] of the final total. */
  intervals: Map<number, [number, number]>;
  iterations: number;
}

export interface SimulateWeekInput {
  teams: SimTeam[];
  model: ResidualModel;
  /** matchup_id -> the two roster ids in it. */
  pairings: Array<{ matchupId: number; teamIds: [number, number] }>;
  iterations?: number;
  seed?: number;
}

export function simulateWeek(input: SimulateWeekInput): WeekSimulation {
  const { teams, model, pairings, iterations = WEEK_ITERATIONS, seed = 0x5c1a } = input;
  const rng = mulberry32(seed);
  const indexOf = new Map(teams.map((team, i) => [team.teamId, i]));

  const totals = new Float64Array(teams.length);
  const sums = new Float64Array(teams.length);
  const samples = teams.map(() => new Float64Array(iterations));
  const wins = pairings.map(() => ({ home: 0, away: 0, tie: 0 }));

  for (let iteration = 0; iteration < iterations; iteration++) {
    sampleLeagueWeek(teams, model, rng, totals);

    for (let t = 0; t < teams.length; t++) {
      sums[t] += totals[t];
      samples[t][iteration] = totals[t];
    }

    for (let p = 0; p < pairings.length; p++) {
      const [a, b] = pairings[p].teamIds;
      const ai = indexOf.get(a);
      const bi = indexOf.get(b);
      if (ai === undefined || bi === undefined) continue;
      if (totals[ai] > totals[bi]) wins[p].home++;
      else if (totals[ai] < totals[bi]) wins[p].away++;
      else wins[p].tie++;
    }
  }

  const meanScores = new Map<number, number>();
  const medianScores = new Map<number, number>();
  const intervals = new Map<number, [number, number]>();
  for (let t = 0; t < teams.length; t++) {
    meanScores.set(teams[t].teamId, round(sums[t] / iterations));
    const sorted = Array.from(samples[t]).sort((x, y) => x - y);
    medianScores.set(teams[t].teamId, round(sorted[Math.floor(iterations * 0.5)]));
    intervals.set(teams[t].teamId, [
      round(sorted[Math.floor(iterations * 0.1)]),
      round(sorted[Math.floor(iterations * 0.9)]),
    ]);
  }

  const remainingOf = (teamId: number) => {
    const team = teams[indexOf.get(teamId) ?? -1];
    if (!team) return 0;
    return round(
      team.starters.reduce(
        (sum, player) => sum + (player.actual === null ? player.mean : 0),
        0,
      ),
    );
  };

  return {
    matchups: pairings.map((pairing, p) => {
      const [home, away] = pairing.teamIds;
      const record = wins[p];
      return {
        matchupId: pairing.matchupId,
        home,
        away,
        homeWinProb: round(record.home / iterations, 4),
        awayWinProb: round(record.away / iterations, 4),
        tieProb: round(record.tie / iterations, 4),
        homeMean: meanScores.get(home) ?? 0,
        awayMean: meanScores.get(away) ?? 0,
        homeMedian: medianScores.get(home) ?? 0,
        awayMedian: medianScores.get(away) ?? 0,
        homeRemaining: remainingOf(home),
        awayRemaining: remainingOf(away),
      };
    }),
    meanScores,
    medianScores,
    intervals,
    iterations,
  };
}

/* -------------------------------------------------------------------------- */
/* Rest of season: playoff, seed and title odds                                */
/* -------------------------------------------------------------------------- */

export interface SeasonOdds {
  teamId: number;
  /** Reaches the playoff field. */
  playoffProb: number;
  /** Finishes the regular season as the top seed. */
  topSeedProb: number;
  /** Wins the championship game. */
  titleProb: number;
  /** Reaches the championship game. */
  finalProb: number;
  /** Mean projected final regular-season record. */
  expectedWins: number;
  /** Probability of each final seed, index 0 = seed 1. */
  seedProbs: number[];
}

export interface SeasonSimulation {
  byTeam: Map<number, SeasonOdds>;
  iterations: number;
  /** Regular-season weeks that were simulated rather than observed. */
  simulatedWeeks: number[];
  /** True when the regular season is already complete. */
  regularSeasonComplete: boolean;
}

export interface SimulateSeasonInput {
  teams: SimTeam[];
  /** Week-specific forecast lineups; falls back to `teams` when absent. */
  weeklyTeams?: ReadonlyMap<number, SimTeam[]>;
  model: ResidualModel;
  /** Record already banked, before the simulated weeks. */
  standing: Map<number, { wins: number; losses: number; ties: number; pointsFor: number }>;
  /** Remaining regular-season pairings, keyed by week. */
  remaining: Array<{ week: number; pairings: Array<[number, number]> }>;
  /** Teams that make the playoff field. */
  playoffTeams: number;
  /** Weeks each playoff round spans — ESPN's `playoff_round_type` 2 means 2. */
  weeksPerRound?: number;
  /** NFL weeks used by successive playoff rounds. */
  playoffWeeks?: number[];
  iterations?: number;
  seed?: number;
}

/**
 * Builds a pool of plausible totals for one projected week.
 *
 * The season run draws from one precomputed pool per week rather than
 * resampling every player inside every season iteration. This retains weekly
 * byes, ESPN projections, opponent difficulty and lineup changes without
 * repeating the expensive forecast build 10,000 times.
 */
function buildPools(
  teams: SimTeam[],
  model: ResidualModel,
  rng: () => number,
): Float64Array[] {
  const pools = teams.map(() => new Float64Array(POOL_SIZE));
  const totals = new Float64Array(teams.length);

  for (let draw = 0; draw < POOL_SIZE; draw++) {
    sampleLeagueWeek(teams, model, rng, totals);
    for (let t = 0; t < teams.length; t++) pools[t][draw] = totals[t];
  }

  return pools;
}

/**
 * Resolves a single-elimination bracket by seed, giving byes to the top seeds
 * whenever the field is not a power of two.
 */
function simulateBracket(
  seeded: number[],
  drawScore: (teamId: number, week: number | undefined) => number,
  weeksPerRound: number,
  playoffWeeks: number[],
): { champion: number; finalists: number[] } {
  let alive = [...seeded];
  let finalists = [...seeded];
  let round = 0;

  while (alive.length > 1) {
    finalists = [...alive];
    const isPowerOfTwo = (alive.length & (alive.length - 1)) === 0;
    const largestPowerOfTwo = 1 << (31 - Math.clz32(alive.length));
    const games = isPowerOfTwo ? alive.length / 2 : alive.length - largestPowerOfTwo;

    const byes = alive.slice(0, alive.length - games * 2);
    const playing = alive.slice(alive.length - games * 2);
    const winners: number[] = [];

    for (let g = 0; g < games; g++) {
      // Highest remaining seed plays the lowest.
      const high = playing[g];
      const low = playing[playing.length - 1 - g];
      let highScore = 0;
      let lowScore = 0;
      for (let w = 0; w < weeksPerRound; w++) {
        const week = playoffWeeks[round * weeksPerRound + w];
        highScore += drawScore(high, week);
        lowScore += drawScore(low, week);
      }
      winners.push(highScore >= lowScore ? high : low);
    }

    // Reseed so the best surviving seed keeps the easiest path.
    alive = [...byes, ...winners].sort(
      (a, b) => seeded.indexOf(a) - seeded.indexOf(b),
    );
    round++;
  }

  return { champion: alive[0], finalists };
}

export function simulateSeason(input: SimulateSeasonInput): SeasonSimulation {
  const {
    teams,
    weeklyTeams,
    model,
    standing,
    remaining,
    playoffTeams,
    weeksPerRound = 1,
    playoffWeeks = [],
    iterations = SEASON_ITERATIONS,
    seed = 0x9e37,
  } = input;

  const rng = mulberry32(seed);
  const fallbackPools = buildPools(teams, model, rng);
  const fallbackIndex = new Map(teams.map((team, i) => [team.teamId, i]));
  const poolsByWeek = new Map<
    number,
    { pools: Float64Array[]; indexOf: Map<number, number> }
  >();
  for (const [week, weekTeams] of weeklyTeams ?? []) {
    poolsByWeek.set(week, {
      pools: buildPools(weekTeams, model, rng),
      indexOf: new Map(weekTeams.map((team, index) => [team.teamId, index])),
    });
  }
  const field = clamp(playoffTeams, 2, teams.length);

  const draw = (teamId: number, week: number | undefined): number => {
    const weekly = week === undefined ? undefined : poolsByWeek.get(week);
    const pools = weekly?.pools ?? fallbackPools;
    const indexOf = weekly?.indexOf ?? fallbackIndex;
    const i = indexOf.get(teamId);
    if (i === undefined) return 0;
    return pools[i][Math.floor(rng() * POOL_SIZE)];
  };

  const tally = new Map(
    teams.map((team) => [
      team.teamId,
      {
        playoff: 0,
        topSeed: 0,
        title: 0,
        final: 0,
        winSum: 0,
        seeds: new Array<number>(teams.length).fill(0),
      },
    ]),
  );

  for (let iteration = 0; iteration < iterations; iteration++) {
    const records = new Map(
      teams.map((team) => {
        const base = standing.get(team.teamId);
        return [
          team.teamId,
          {
            wins: base?.wins ?? 0,
            ties: base?.ties ?? 0,
            pointsFor: base?.pointsFor ?? 0,
          },
        ];
      }),
    );

    for (const { week, pairings } of remaining) {
      for (const [a, b] of pairings) {
        const scoreA = draw(a, week);
        const scoreB = draw(b, week);
        const recordA = records.get(a);
        const recordB = records.get(b);
        if (!recordA || !recordB) continue;

        recordA.pointsFor += scoreA;
        recordB.pointsFor += scoreB;
        if (scoreA > scoreB) recordA.wins++;
        else if (scoreB > scoreA) recordB.wins++;
        else {
          recordA.ties++;
          recordB.ties++;
        }
      }
    }

    // Seed on wins, then points for — ESPN's default tiebreak.
    const seeded = [...records.entries()]
      .sort((a, b) => {
        const aWins = a[1].wins + a[1].ties * 0.5;
        const bWins = b[1].wins + b[1].ties * 0.5;
        return bWins - aWins || b[1].pointsFor - a[1].pointsFor;
      })
      .map(([teamId]) => teamId);

    for (let s = 0; s < seeded.length; s++) {
      const entry = tally.get(seeded[s])!;
      entry.seeds[s]++;
      entry.winSum += records.get(seeded[s])!.wins + records.get(seeded[s])!.ties * 0.5;
      if (s === 0) entry.topSeed++;
      if (s < field) entry.playoff++;
    }

    const { champion, finalists } = simulateBracket(
      seeded.slice(0, field),
      draw,
      weeksPerRound,
      playoffWeeks,
    );
    tally.get(champion)!.title++;
    for (const teamId of finalists) tally.get(teamId)!.final++;
  }

  const byTeam = new Map<number, SeasonOdds>();
  for (const [teamId, entry] of tally) {
    byTeam.set(teamId, {
      teamId,
      playoffProb: round(entry.playoff / iterations, 4),
      topSeedProb: round(entry.topSeed / iterations, 4),
      titleProb: round(entry.title / iterations, 4),
      finalProb: round(entry.final / iterations, 4),
      expectedWins: round(entry.winSum / iterations, 2),
      seedProbs: entry.seeds.map((count) => round(count / iterations, 4)),
    });
  }

  return {
    byTeam,
    iterations,
    simulatedWeeks: remaining.map((entry) => entry.week),
    regularSeasonComplete: remaining.length === 0,
  };
}
