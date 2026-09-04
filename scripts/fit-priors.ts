/**
 * Fits everything the app needs before its own season has produced anything.
 *
 * In week one there is no in-season football. Every distribution the app
 * reports, every defence rating on every matchup chip, and every seed the
 * projection model starts from is a *prior*, and until now each of those priors
 * came from one finished season — sometimes at the wrong granularity, because
 * the only route to a finished season carried game logs and no projections.
 *
 * `seasons/<year>.json` now carries both halves of every week for three
 * finished seasons. This script turns them into `priors.json`: a small set of
 * fitted objects the browser installs directly, rather than twenty thousand raw
 * pairs it would have to download and refit.
 *
 * Four things come out of it, and each is measured against a holdout rather
 * than asserted:
 *
 *   residual fit        the conditional distribution of a result given its
 *                       projection, from real weekly pairs
 *   bias correction     per-player projection bias, with the damping chosen by
 *                       whether it improves a season it was not fit on
 *   defence ratings     recency-weighted across seasons, for the early weeks
 *   matchup influence   how much an opponent moves each position, measured
 *                       against projection residuals
 *
 * The holdout is a season boundary: fit on the older seasons, score the newest.
 * That is the honest shape of the question the app actually asks, which is
 * always "what does last year tell me about this year".
 *
 *   npm run fit:priors
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import { fitInputsHash } from './fit-inputs';
import { fileURLToPath } from 'node:url';

import {
  fitResidualModel,
  scaleFor,
  scoreAtQuantile,
  type PriorResidualFit,
  type ResidualFit,
} from '../src/lib/forecast';
import {
  reshapeSeason,
  seasonLevels,
  seasonProduction,
  weeklyPairs,
  type RawSeasonFile,
  type SeasonHistory,
  type WeeklyPair,
} from '../src/lib/history';
import {
  blendMatchupIndexes,
  buildMatchupIndex,
  MATCHUP_INFLUENCE,
  type MatchupIndex,
} from '../src/lib/matchup';
import { compileScoring } from '../src/lib/scoring';
import { mean, round } from '../src/lib/stats';
import { DEFAULT_BOOM_BUST } from '../src/lib/value';
import { POSITION_GROUPS, type League, type Player, type PositionGroup } from '../src/lib/types';
import { DEFAULT_LEAGUE_KEY } from '../src/lib/leagues';
import { activeLeague, dataUrl, historyUrl } from './league-paths';

const LEAGUE = activeLeague();
const DATA = dataUrl(LEAGUE);
const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, DATA), 'utf8')) as T;

/** Raw finished seasons, which live outside `public/` — see `snapshot.ts`. */
const HISTORY = historyUrl(LEAGUE);
const readHistory = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, HISTORY), 'utf8')) as T;
const out = (msg: string) => process.stdout.write(`${msg}\n`);

/** Constants compiled into the app that a refit says are now wrong. */
const driftFailures: string[] = [];

const index = read<{ generatedAt: number; historySeasons?: number[] }>('index.json');
const leagueFile = read<{ league: League }>('league.json');
const playersFile = read<{ players: Player[] }>('players.json');

const scoringModel = compileScoring(
  leagueFile.league.scoringSettings,
  leagueFile.league.scoringOverrides,
);
const playersById = new Map(playersFile.players.map((p) => [p.playerId, p]));
const fallbackGroups = new Map(playersFile.players.map((p) => [p.playerId, p.group]));

const seasonYears = [...(index.historySeasons ?? [])].sort((a, b) => b - a);
if (seasonYears.length === 0) {
  process.stderr.write('no finished seasons in the snapshot — run npm run snapshot first\n');
  process.exit(1);
}

const histories = new Map<number, SeasonHistory>();
for (const year of seasonYears) {
  const path = new URL(`${year}.json`, HISTORY);
  if (!existsSync(fileURLToPath(path))) continue;
  histories.set(year, reshapeSeason(readHistory<RawSeasonFile>(`${year}.json`), fallbackGroups));
}

const years = [...histories.keys()].sort((a, b) => b - a);
out(`seasons: ${years.join(', ')}`);

const pairsBySeason = new Map<number, WeeklyPair[]>();
for (const year of years) {
  pairsBySeason.set(year, weeklyPairs(histories.get(year)!, scoringModel));
}
const allPairs = years.flatMap((y) => pairsBySeason.get(y)!);
out(`weekly pairs: ${allPairs.length}\n`);

// ---------------------------------------------------------------------------
// The residual fit
// ---------------------------------------------------------------------------

/**
 * Runs the app's own residual fit over an arbitrary pair set.
 *
 * `fitResidualModel` reads week-keyed maps rather than a list, because in the
 * app that is the shape the data arrives in. Feeding it a set of pairs drawn
 * from several seasons means re-keying them so no two seasons collide on a week
 * number — otherwise week 3 of 2023 and week 3 of 2025 would be one week, and
 * every team-week correlation would be computed across a two-year gap.
 */
const PASSTHROUGH_PER_YARD = 0.04;
const passthroughScoring = compileScoring({ pass_yds: PASSTHROUGH_PER_YARD }, {});

function fitOver(pairs: WeeklyPair[]): ReturnType<typeof fitResidualModel> {
  const weekStats = new Map<number, Record<string, any>>();
  const weekProjections = new Map<number, Record<string, any>>();
  const weekTeams = new Map<number, Record<string, string>>();
  const groups = new Map<string, Player>();
  let maxKey = 0;

  /*
   * The synthetic line the fit reads back.
   *
   * `fitResidualModel` scores a stat line rather than taking a number, so each
   * pair is handed back a one-key line whose score is exactly the value already
   * computed here. `pass_yds` is a plain per-yard multiplier in every ESPN
   * league, which makes the inverse exact rather than a reconstruction.
   */
  const perYard = PASSTHROUGH_PER_YARD;
  const lineFor = (points: number, played: boolean) =>
    played ? { pass_yds: points / perYard, gp: 1 } : {};

  for (const pair of pairs) {
    const key = pair.season * 100 + pair.week;
    maxKey = Math.max(maxKey, key);
    if (!weekStats.has(key)) {
      weekStats.set(key, {});
      weekProjections.set(key, {});
      weekTeams.set(key, {});
    }
    weekProjections.get(key)![pair.pid] = lineFor(pair.projection, true);
    weekStats.get(key)![pair.pid] = lineFor(pair.actual, pair.played);
    weekTeams.get(key)![pair.pid] = pair.team;
    if (!groups.has(pair.pid)) {
      groups.set(pair.pid, { ...(playersById.get(pair.pid) ?? ({} as Player)), group: pair.group });
    }
  }

  return fitResidualModel({
    // A pass-yards-only table, so the synthetic lines above score back exactly.
    scoringModel: passthroughScoring,
    playersById: groups,
    weekStats,
    weekProjections,
    weekTeams,
    throughWeek: maxKey,
  });
}

/**
 * Coverage of the fitted bands, and point accuracy, on a held-out season.
 *
 * Coverage is the number that matters most: a band that claims 80% and delivers
 * 60% is worse than no band, because it is read as a floor somebody sets a
 * lineup against.
 */
function evaluate(
  fits: Map<PositionGroup, ResidualFit>,
  holdout: WeeklyPair[],
): { coverageMae: number; medianMae: number; sourceMae: number; n: number } {
  const nominal = [0.1, 0.25, 0.5, 0.75, 0.9];
  const hits = nominal.map(() => 0);
  let n = 0;
  let medianError = 0;
  let sourceError = 0;

  for (const pair of holdout) {
    const fit = fits.get(pair.group);
    if (!fit) continue;
    n++;
    for (let i = 0; i < nominal.length; i++) {
      if (pair.actual <= scoreAtQuantile(fit, pair.projection, nominal[i])) hits[i]++;
    }
    const median = scoreAtQuantile(fit, pair.projection, 0.5);
    medianError += Math.abs(pair.actual - median);
    sourceError += Math.abs(pair.actual - pair.projection);
  }

  if (n === 0) return { coverageMae: Number.NaN, medianMae: Number.NaN, sourceMae: Number.NaN, n };
  const coverageMae =
    (nominal.reduce((s, q, i) => s + Math.abs((hits[i] / n) * 100 - q * 100), 0) / nominal.length);
  return { coverageMae, medianMae: medianError / n, sourceMae: sourceError / n, n };
}

out('--- residual fit: does pooling seasons beat the most recent one? ---');
out('  holdout is the newest season; fits are built only from older ones.\n');

const holdoutYear = years[0];
const holdout = pairsBySeason.get(holdoutYear)!;
const olderYears = years.slice(1);

if (olderYears.length > 0) {
  const single = fitOver(pairsBySeason.get(olderYears[0])!);
  const pooled = fitOver(olderYears.flatMap((y) => pairsBySeason.get(y)!));

  const a = evaluate(single.byGroup, holdout);
  const b = evaluate(pooled.byGroup, holdout);

  out(`  fit on ${olderYears[0]} alone      coverage MAE ${a.coverageMae.toFixed(2)}pp   median MAE ${a.medianMae.toFixed(3)}`);
  out(`  fit on ${olderYears.join('+')}       coverage MAE ${b.coverageMae.toFixed(2)}pp   median MAE ${b.medianMae.toFixed(3)}`);
  out(`  the projection it starts from            source MAE ${a.sourceMae.toFixed(3)}   n = ${a.n}`);
  const better = b.coverageMae <= a.coverageMae;
  out(`  ${better ? 'pooling wins' : 'pooling does not help'} on coverage` +
      `${b.medianMae <= a.medianMae ? ' and on point accuracy' : ''}\n`);
}

// ---------------------------------------------------------------------------
// Per-player bias, chosen out of sample
// ---------------------------------------------------------------------------

/**
 * Shrinkage on a player's own measured bias, in weeks of neutral prior.
 *
 * A player with three projected weeks behind him has a bias estimate that is
 * mostly noise; one with forty has an estimate worth acting on. Six weeks of
 * prior pulls the first most of the way back to his group and leaves the second
 * largely alone.
 */
const BIAS_PRIOR_WEEKS = 6;

/** Damping levels tried; the one that wins out of sample ships. */
const DAMPING_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1];

out('--- per-player projection bias: is it worth correcting? ---');
out('  bias measured on the older seasons, scored on the newest.\n');

const biasFitPairs = olderYears.flatMap((y) => pairsBySeason.get(y)!);
const biasFit = fitOver(biasFitPairs);

/** pid -> mean standardised residual over the fitting seasons. */
const priorBias = new Map<string, { sum: number; n: number }>();
for (const [pid, entry] of biasFit.biasByPlayer) {
  priorBias.set(pid, { sum: entry.sum, n: entry.n });
}

const chosenDamping = new Map<PositionGroup, number>();
out('  group   n     damping   MAE at 0     best MAE   improvement');

for (const group of POSITION_GROUPS) {
  const fit = biasFit.byGroup.get(group);
  if (!fit) {
    chosenDamping.set(group, 0);
    continue;
  }
  const rows = holdout.filter((p) => p.group === group && priorBias.has(p.pid));
  if (rows.length < 200) {
    chosenDamping.set(group, 0);
    out(`  ${group.padEnd(6)} ${String(rows.length).padStart(5)}   too few rows to choose on`);
    continue;
  }

  const errors = DAMPING_GRID.map((damping) => {
    let total = 0;
    for (const pair of rows) {
      const own = priorBias.get(pair.pid)!;
      const shrunk = own.sum / (own.n + BIAS_PRIOR_WEEKS);
      const scale = scaleFor(fit, pair.projection);
      const median = scoreAtQuantile(fit, pair.projection, 0.5) + damping * shrunk * scale;
      total += Math.abs(pair.actual - Math.max(fit.floor, median));
    }
    return total / rows.length;
  });

  let best = 0;
  for (let i = 1; i < errors.length; i++) if (errors[i] < errors[best]) best = i;

  /*
   * A correction only ships if it clears a real margin, not a rounding one.
   * Half a percent of MAE on one holdout season is inside the noise of which
   * season happened to be held out, and shipping it would be reading a coin
   * flip as a finding.
   */
  const improvement = (errors[0] - errors[best]) / errors[0];
  const damping = improvement > 0.005 ? DAMPING_GRID[best] : 0;
  chosenDamping.set(group, damping);

  out(
    `  ${group.padEnd(6)} ${String(rows.length).padStart(5)}   ${damping.toFixed(2)}      ` +
      `${errors[0].toFixed(4)}     ${errors[best].toFixed(4)}     ` +
      `${(improvement * 100).toFixed(2)}%${damping === 0 && improvement > 0 ? '  (under the floor)' : ''}`,
  );
}
out('');

// ---------------------------------------------------------------------------
// Availability, now and later
// ---------------------------------------------------------------------------

/**
 * Two different play rates, because the app asks two different questions.
 *
 * `playRate` on the residual fit answers "he is projected for this week — does
 * he turn up?", and against real weekly pairs that comes out near 1. It should:
 * a finished season's projections are the *final* pregame ones, published after
 * the inactive list, so ESPN has already zeroed out everybody who is not
 * playing. Conditioning on a meaningful projection conditions on being active.
 *
 * That is the right number for the live week and the wrong one for every week
 * after it. The rest-of-season simulator projects week 14 in September, from a
 * projection that cannot know about a week 11 hamstring — and giving every
 * player a 99% chance of being available in December quietly inflates every
 * remaining-schedule total and pulls every playoff probability toward whoever
 * currently has the better roster on paper.
 *
 * So the forward rate is measured separately and directly: over each finished
 * season, for a player who carried a meaningful projection in some week, how
 * often did he actually record a line in a *later* week his team played. That
 * is the quantity the simulator needs, and it is far below the conditional one.
 */
out('--- availability: this week against a later one ---');

/** A player needs this many later weeks measured before his own rate is used. */
const MIN_FORWARD_WEEKS = 4;

/** Projected weeks in a season that make a player part of his group's rotation. */
const MIN_ROTATION_WEEKS = 4;

const forwardByGroup = new Map<PositionGroup, { played: number; total: number }>();
const forwardByPlayer = new Map<string, { played: number; total: number }>();

for (const year of years) {
  const history = histories.get(year)!;
  const pairs = pairsBySeason.get(year)!;

  /** pid -> weeks he carried a meaningful projection. */
  const projectedWeeks = new Map<string, number[]>();
  for (const pair of pairs) {
    const list = projectedWeeks.get(pair.pid);
    if (list) list.push(pair.week);
    else projectedWeeks.set(pair.pid, [pair.week]);
  }

  for (const [pid, weeks] of projectedWeeks) {
    const group = history.groups.get(pid);
    if (!group) continue;
    const first = Math.min(...weeks);

    /*
     * Only players who were genuinely in a rotation set the group's rate.
     *
     * A third-string quarterback picks up one meaningful projection the week
     * his starter is ruled out and then never appears again. Counting him tells
     * you nothing about whether Josh Allen will be there in December, and there
     * are enough of him to drag a quarterback's group rate down by ten points.
     * His own weeks still go into his own per-player rate below, where they are
     * the correct answer about him.
     */
    const inRotation = weeks.length >= MIN_ROTATION_WEEKS;

    /*
     * Every later week his team actually played. A bye is excluded rather than
     * counted as an absence: the roster spot fields a replacement that week, so
     * a bye is a scheduling fact the lineup solver already knows about and not
     * a durability signal.
     */
    let played = 0;
    let total = 0;
    for (let week = first + 1; week <= history.finalWeek; week++) {
      const line = history.weekStats.get(week)?.[pid];
      if (line === undefined) continue;
      total++;
      if (Object.keys(line).length > 0 && history.weekOpponents.get(week)?.[pid]) {
        // A logged, non-empty week with a resolved fixture is a week he played.
        played++;
      }
    }
    if (total === 0) continue;

    if (inRotation) {
      const g = forwardByGroup.get(group) ?? { played: 0, total: 0 };
      g.played += played;
      g.total += total;
      forwardByGroup.set(group, g);
    }

    const own = forwardByPlayer.get(pid) ?? { played: 0, total: 0 };
    own.played += played;
    own.total += total;
    forwardByPlayer.set(pid, own);
  }
}

const forwardPlayRate: Record<string, number> = {};
out('  group   later weeks   available');
for (const group of POSITION_GROUPS) {
  const entry = forwardByGroup.get(group);
  const rate = entry && entry.total > 0 ? entry.played / entry.total : 1;
  forwardPlayRate[group] = round(rate, 4);
  out(
    `  ${group.padEnd(6)} ${String(entry?.total ?? 0).padStart(8)}      ${(rate * 100).toFixed(1)}%`,
  );
}
out('');

// ---------------------------------------------------------------------------
// Matchup influence, against projection residuals
// ---------------------------------------------------------------------------

/**
 * How much the opponent actually moves a result, per position.
 *
 * The app's shipped figures were measured against a player's deviation from his
 * own season mean, because that was the only instrument available: a sharper
 * one needs the projection that preceded each game, and none was thought to
 * exist for a finished season. Deviation from a mean is a blunt substitute,
 * because a player's own mean quietly absorbs part of the schedule the rating
 * is trying to explain — every figure it produces is biased toward zero.
 *
 * With real weekly projections the sharper measurement is available: correlate
 * the pregame matchup rating against the *projection residual*, which already
 * has the player's own form and role priced into it. Every rating is rebuilt
 * from weeks strictly before the one it is scored on, so no week contributes to
 * its own feature.
 */
out('--- matchup influence, measured against projection residuals ---');

/** Weeks of a season that must precede a rating before it is worth scoring on. */
const INFLUENCE_MIN_WEEK = 5;

const influenceRows = new Map<PositionGroup, Array<{ rating: number; residual: number }>>();
for (const group of POSITION_GROUPS) influenceRows.set(group, []);

for (const year of years) {
  const history = histories.get(year)!;
  const pairs = pairsBySeason.get(year)!;
  const byWeek = new Map<number, WeeklyPair[]>();
  for (const pair of pairs) {
    const list = byWeek.get(pair.week);
    if (list) list.push(pair);
    else byWeek.set(pair.week, [pair]);
  }

  for (let week = INFLUENCE_MIN_WEEK; week <= history.finalWeek; week++) {
    const rows = byWeek.get(week);
    if (!rows) continue;

    const priorIndex = buildMatchupIndex({
      scoringModel,
      playersById: new Map(
        [...history.groups].map(([pid, group]) => [
          pid,
          { ...(playersById.get(pid) ?? ({} as Player)), group },
        ]),
      ),
      weekStats: history.weekStats,
      weekOpponents: history.weekOpponents,
      weekTeams: history.weekTeams,
      throughWeek: week - 1,
    });

    for (const row of rows) {
      if (!row.opponent) continue;
      const entry = priorIndex.get(row.group, row.opponent);
      if (!entry) continue;
      influenceRows.get(row.group)!.push({
        rating: (entry.score - 50) / 50,
        residual: row.actual - row.projection,
      });
    }
  }
}

function pearson(rows: Array<{ rating: number; residual: number }>): number {
  if (rows.length < 30) return 0;
  const mr = mean(rows.map((r) => r.rating));
  const md = mean(rows.map((r) => r.residual));
  let cov = 0;
  let vr = 0;
  let vd = 0;
  for (const r of rows) {
    cov += (r.rating - mr) * (r.residual - md);
    vr += (r.rating - mr) ** 2;
    vd += (r.residual - md) ** 2;
  }
  return vr > 0 && vd > 0 ? cov / Math.sqrt(vr * vd) : 0;
}

const rawInfluence = new Map<PositionGroup, number>();
out('  group     n    corr(rating, projection residual)');
for (const group of POSITION_GROUPS) {
  const rows = influenceRows.get(group)!;
  const r = pearson(rows);
  rawInfluence.set(group, Math.max(0, r));
  out(`  ${group.padEnd(6)} ${String(rows.length).padStart(5)}    ${r >= 0 ? ' ' : ''}${r.toFixed(3)}`);
}

/*
 * Normalised so the strongest position reads 1, which is how the app consumes
 * it — as a relative weight on the matchup leg, never as an absolute effect.
 */
const peak = Math.max(...rawInfluence.values(), 1e-9);
const influence: Record<string, number> = {};
for (const group of POSITION_GROUPS) {
  influence[group] = round(rawInfluence.get(group)! / peak, 3);
}
out(`\n  normalised: ${POSITION_GROUPS.map((g) => `${g} ${influence[g].toFixed(2)}`).join('   ')}`);

/*
 * The shipped constants have to keep agreeing with the measurement.
 *
 * `MATCHUP_INFLUENCE` is compiled into the app — it scales the schedule leg of
 * the rest-of-season score and decides which chips are dimmed — so it cannot be
 * read from `priors.json` without threading it through half the codebase. What
 * it can do is fail loudly when a refit disagrees with it, which is the same
 * bargain `verify:stat-ids` makes: the constant stays a constant, and it stops
 * being allowed to quietly rot.
 *
 * The tolerance is absolute rather than relative because these are already
 * normalised onto 0..1, and a tenth is the difference between a chip the app
 * dims and one it does not.
 */
const INFLUENCE_TOLERANCE = 0.1;
const drifted = POSITION_GROUPS.filter(
  (g) => Math.abs(influence[g] - MATCHUP_INFLUENCE[g]) > INFLUENCE_TOLERANCE,
);

/*
 * Only the default league is held to the constant.
 *
 * The measurement is a property of the league's scoring table — six points a
 * passing touchdown makes the opponent matter about twice as much to a
 * quarterback as four does — so a second league differing from the constant is
 * the expected result, not a regression. What each league actually uses is its
 * own `influence` block a few lines below, which is written either way; the
 * constant is only the fallback for a snapshot that has never been fit, and
 * that fallback can only be right about one league.
 */
const guardsTheConstant = LEAGUE.key === DEFAULT_LEAGUE_KEY;

if (drifted.length > 0) {
  out('');
  for (const g of drifted) {
    out(
      `  ${guardsTheConstant ? 'DRIFT' : 'differs'}  ${g}: ` +
        `shipped ${MATCHUP_INFLUENCE[g].toFixed(2)}, measured ${influence[g].toFixed(2)}` +
        (guardsTheConstant ? ' — update MATCHUP_INFLUENCE in lib/matchup.ts' : ''),
    );
  }
  if (guardsTheConstant) {
    driftFailures.push(...drifted.map((g) => `MATCHUP_INFLUENCE.${g}`));
  } else {
    out(
      `  ${LEAGUE.key} scores differently from the fallback constant, which ` +
        `tracks ${DEFAULT_LEAGUE_KEY}. This league ships its own measurement.`,
    );
  }
} else {
  out('  shipped constants agree with the measurement');
}
out('');

// ---------------------------------------------------------------------------
// Defence ratings, recency-weighted across seasons
// ---------------------------------------------------------------------------

/**
 * How much each season back counts toward the early-season defence ratings.
 *
 * A defence is not a stable object across an offseason — coordinators move,
 * secondaries are rebuilt, and a unit that was generous last December often is
 * not in September. So the most recent season dominates and the older ones act
 * as a regulariser: they pull a defence rated off twelve noisy weeks back
 * toward what it has looked like over three years, without letting 2023 argue
 * with 2025 about who is good now.
 */
const SEASON_DECAY = 0.45;

out('--- defence ratings across seasons ---');

const defenseIndexes = new Map<number, MatchupIndex>();
for (const year of years) {
  const history = histories.get(year)!;
  defenseIndexes.set(
    year,
    buildMatchupIndex({
      scoringModel,
      playersById: new Map(
        [...history.groups].map(([pid, group]) => [
          pid,
          { ...(playersById.get(pid) ?? ({} as Player)), group },
        ]),
      ),
      weekStats: history.weekStats,
      weekOpponents: history.weekOpponents,
      weekTeams: history.weekTeams,
      throughWeek: history.finalWeek,
    }),
  );
}

const blendedDefense = blendMatchupIndexes(
  years.map((year) => defenseIndexes.get(year)!),
  SEASON_DECAY,
);

/** group -> defence -> the full blended entry, as the app's own index shape. */
const defense: Record<string, Record<string, unknown>> = {};
for (const group of POSITION_GROUPS) {
  const entries = blendedDefense.byGroup.get(group);
  if (!entries?.size) continue;
  defense[group] = Object.fromEntries(entries);

  const factors = [...entries.keys()].map((team) =>
    blendedDefense.projectionFactor(group, team),
  );
  const scores = [...entries.keys()].map((team) => blendedDefense.get(group, team)!.score);
  out(
    `  ${group.padEnd(4)} ${entries.size} defences   rating ` +
      `${Math.min(...scores).toFixed(0)}–${Math.max(...scores).toFixed(0)}   factor ` +
      `${Math.min(...factors).toFixed(3)}–${Math.max(...factors).toFixed(3)}`,
  );
}

/*
 * Does blending beat the single most recent season?
 *
 * Measured the only way it can be: build both from the older seasons, and see
 * which better orders what a position actually scored in the newest one. A
 * blended rating that ordered no better than last year's alone would be extra
 * machinery for nothing.
 */
{
  const olderIndexes = olderYears.map((year) => defenseIndexes.get(year)!);
  if (olderIndexes.length > 1) {
    const single = olderIndexes[0];
    const blend = blendMatchupIndexes(olderIndexes, SEASON_DECAY);
    out('\n  ordering the held-out season, by |correlation| with its residuals');
    out('  group    last season only     blended');

    for (const group of POSITION_GROUPS) {
      const rows = holdout.filter((p) => p.group === group && p.opponent);
      if (rows.length < 200) continue;
      const scoreWith = (index: MatchupIndex) =>
        pearson(
          rows.map((row) => ({
            rating: ((index.get(group, row.opponent)?.score ?? 50) - 50) / 50,
            residual: row.actual - row.projection,
          })),
        );
      const a = scoreWith(single);
      const b = scoreWith(blend);
      out(
        `  ${group.padEnd(6)}   ${a.toFixed(4).padStart(8)}          ${b.toFixed(4).padStart(8)}` +
          `   ${Math.abs(b) > Math.abs(a) ? 'blend' : 'single'}`,
      );
    }
  }
}
out('');

// ---------------------------------------------------------------------------
// Projection reliability, which the Trade page prices against
// ---------------------------------------------------------------------------

/**
 * How much of a projected gap between two players survives into results.
 *
 * The Trade page prices a player at the value of the start decision he creates,
 * and that pricing is only worth anything if a projected gap predicts a real
 * one. It measured that on the prorated stand-in — one season, one projection
 * per player — and found a kicker correlation of .25 on 34 players, about 1.4
 * standard errors from zero: the right conclusion from a sample too small to
 * draw it from confidently.
 *
 * Three seasons of real weekly projections triple the sample. They also invite
 * a mistake worth spelling out, because the obvious way to use them is wrong.
 *
 * Averaging a player's *whole season* of weekly projections and regressing his
 * season's actuals on it produces correlations of .93–.95 at every skill
 * position, which looks like a wonderful result and is very nearly a tautology:
 * week 10's projection has already seen weeks 1 through 9. It measures whether
 * ESPN's in-season projections track results, which they do, and not the thing
 * the Trade page needs to know.
 *
 * The page prices weeks that have not happened from projections made before
 * them, so the honest measurement uses only projections made before the season
 * had anything to say. `PRESEASON_WEEKS` of them per player, against the level
 * he went on to score across the whole year.
 */
const PRESEASON_WEEKS = 3;

out('--- projection reliability, by position ---');
out('  how much of a gap projected in September survives the season\n');

const drift: Record<string, { drift: number; reliability: number; correlation: number; samples: number }> = {};

const fitLine = (rows: Array<{ p: number; a: number }>) => {
  const n = rows.length;
  const mp = rows.reduce((s, r) => s + r.p, 0) / n;
  const ma = rows.reduce((s, r) => s + r.a, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const r of rows) {
    sxy += (r.p - mp) * (r.a - ma);
    sxx += (r.p - mp) ** 2;
    syy += (r.a - ma) ** 2;
  }
  return {
    slope: sxx > 0 ? sxy / sxx : 1,
    corr: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 1,
    spread: Math.sqrt(rows.reduce((s, r) => s + (r.a - r.p) ** 2, 0) / n),
  };
};

out('  group  players   slope   corr    drift      whole-season corr');

for (const group of POSITION_GROUPS) {
  /** One row per player-season: September's projected level, then the year. */
  const forward: Array<{ p: number; a: number }> = [];
  /** The same rows built from every week's projection — the tautological one. */
  const contemporaneous: Array<{ p: number; a: number }> = [];

  for (const year of years) {
    const early = new Map<string, { proj: number; n: number }>();
    const whole = new Map<string, { proj: number; act: number; n: number }>();

    for (const pair of pairsBySeason.get(year)!) {
      if (pair.group !== group) continue;
      if (pair.week <= PRESEASON_WEEKS) {
        const row = early.get(pair.pid) ?? { proj: 0, n: 0 };
        row.proj += pair.projection;
        row.n++;
        early.set(pair.pid, row);
      }
      const row = whole.get(pair.pid) ?? { proj: 0, act: 0, n: 0 };
      row.proj += pair.projection;
      row.act += pair.actual;
      row.n++;
      whole.set(pair.pid, row);
    }

    for (const [pid, season] of whole) {
      // Six projected weeks before a player's realised level means anything.
      if (season.n < 6) continue;
      const level = season.act / season.n;
      contemporaneous.push({ p: season.proj / season.n, a: level });

      const opening = early.get(pid);
      if (opening && opening.n >= 2) forward.push({ p: opening.proj / opening.n, a: level });
    }
  }

  if (forward.length < 8) {
    out(`  ${group.padEnd(6)}   too few players to measure`);
    continue;
  }

  const fit = fitLine(forward);
  const naive = fitLine(contemporaneous);

  drift[group] = {
    drift: round(fit.spread, 3),
    reliability: round(fit.slope, 3),
    correlation: round(fit.corr, 3),
    samples: forward.length,
  };

  out(
    `  ${group.padEnd(6)} ${String(forward.length).padStart(6)}   ` +
      `${fit.slope.toFixed(3).padStart(6)}  ${fit.corr.toFixed(3).padStart(6)}   ` +
      `${fit.spread.toFixed(2).padStart(5)}            ${naive.corr.toFixed(3)}`,
  );
}
out('');

// ---------------------------------------------------------------------------
// Per-player multi-season priors
// ---------------------------------------------------------------------------

/**
 * What each player looked like in each finished season.
 *
 * Two things the app cannot get anywhere else in week one: the level he scored
 * at, and how often he was available to score at all. Both are carried per
 * season rather than blended, because the consumers want different blends — the
 * projection model reads last season as one feature and the season before it as
 * another, while the value score wants a durability rate over everything
 * available.
 */
out('--- per-player priors ---');

interface PlayerPrior {
  /** season -> [level, games played, weeks rostered]. */
  seasons: Record<string, [number, number, number]>;
  /**
   * [weeks available, later weeks measured] across every finished season —
   * how often he was there for a week projected before it, not on the day.
   */
  forward?: [number, number];
  /**
   * The most recent finished season as the rank chips report it:
   * [total points, games played, booms, weeks with a real projection].
   *
   * Deliberately separate from `seasons` rather than folded into it. That map is
   * a *rate* per season, read as a feature by the projection model and as a
   * durability record by the value score; this is the raw production of one
   * specific season, read by the UI and ranked against the other players in it.
   * Rounding a total to two decimals to share a tuple with a per-week level
   * would trade an exact number for nothing.
   */
  recent?: [number, number, number, number];
}

const playerPriors: Record<string, PlayerPrior> = {};
for (const year of years) {
  const levels = seasonLevels(histories.get(year)!, scoringModel);
  for (const [pid, entry] of levels) {
    if (!playersById.has(pid)) continue;
    const prior = (playerPriors[pid] ??= { seasons: {} });
    prior.seasons[String(year)] = [round(entry.level, 2), entry.games, entry.rostered];
  }
}

for (const [pid, entry] of forwardByPlayer) {
  if (!playersById.has(pid) || entry.total < MIN_FORWARD_WEEKS) continue;
  (playerPriors[pid] ??= { seasons: {} }).forward = [entry.played, entry.total];
}

/*
 * Last season's Total, PPG and boom rate — what the rank chips report until this
 * season has weeks of its own. See `seasonProduction` for why boom rate can only
 * be measured here: it needs the weekly projection that preceded each game, and
 * `history.json` ships the actuals alone.
 *
 * The most recent season only. A blend across three would be a better estimate of
 * a player's *level* and a worse answer to the question the chip asks, which is
 * "where did he finish last year" — a number the reader can check against any
 * end-of-season table.
 */
const recentSeason = years[0];
const production = seasonProduction(
  histories.get(recentSeason)!,
  scoringModel,
  DEFAULT_BOOM_BUST.boomPct,
);
let recentCount = 0;
for (const [pid, entry] of production) {
  if (!playersById.has(pid) || entry.games === 0) continue;
  (playerPriors[pid] ??= { seasons: {} }).recent = [
    round(entry.total, 1),
    entry.games,
    entry.boom,
    entry.projectedGames,
  ];
  recentCount++;
}
out(`  ${recentCount} carry ${recentSeason} production for the rank chips`);

const counts = years.map(
  (year) => Object.values(playerPriors).filter((p) => String(year) in p.seasons).length,
);
out(`  ${Object.keys(playerPriors).length} of today's players have history`);
years.forEach((year, i) => out(`    ${year}: ${counts[i]}`));

const withTwo = Object.values(playerPriors).filter((p) => Object.keys(p.seasons).length >= 2).length;
out(`  ${withTwo} carry two or more seasons — the population priorLevel can be fit on\n`);

// ---------------------------------------------------------------------------
// The shipped fit
// ---------------------------------------------------------------------------

const shipped = fitOver(allPairs);

const groups: ResidualFit[] = [];
for (const group of POSITION_GROUPS) {
  const fit = shipped.byGroup.get(group);
  if (fit) groups.push({ ...fit, bootstrapped: true });
}

const plays: Record<string, [number, number]> = {};
for (const [pid, entry] of shipped.playsByPlayer) {
  if (!playersById.has(pid)) continue;
  plays[pid] = [entry.played, entry.projected];
}

const bias: Record<string, [number, number]> = {};
for (const [pid, entry] of shipped.biasByPlayer) {
  if (!playersById.has(pid)) continue;
  bias[pid] = [round(entry.sum, 4), entry.n];
}

const residual: PriorResidualFit = {
  seasons: years,
  granularity: 'weekly',
  groups,
  teamCorrelation: round(shipped.teamCorrelation, 4),
  plays,
  bias,
};

out('--- shipped residual fit ---');
out('  group  samples   scale               playRate   medianZ');
for (const fit of groups) {
  out(
    `  ${fit.group.padEnd(5)}  ${String(fit.samples).padStart(6)}   ` +
      `${fit.scaleIntercept.toFixed(2)} + ${fit.scaleSlope.toFixed(3)}·p`.padEnd(20) +
      `${fit.playRate.toFixed(3)}      ${fit.medianZ.toFixed(3)}`,
  );
}
out(`  team correlation ${residual.teamCorrelation.toFixed(4)}\n`);

const biasCorrection: Record<string, { seasonWeight: number; damping: number }> = {};
for (const group of POSITION_GROUPS) {
  biasCorrection[group] = {
    // With a multi-season prior behind every player, the season-long estimate
    // is the one carrying the samples; the recent window only matters once this
    // season has weeks of its own.
    seasonWeight: 1,
    damping: chosenDamping.get(group) ?? 0,
  };
}

const payload = {
  generatedAt: index.generatedAt,
  /*
   * A fingerprint of what this fit read. `npm run restamp` uses it to carry the
   * model onto a fresher snapshot when — and only when — none of its inputs
   * moved, which is what makes an ordinary in-season refresh cheap without
   * weakening the check that stops a stale model shipping.
   */
  inputsHash: fitInputsHash(),
  seasons: years,
  /** The season `PlayerPrior.recent` describes, and the chips are labelled with. */
  recentSeason,
  residual,
  defense,
  influence,
  biasCorrection,
  forwardPlayRate,
  drift,
  players: playerPriors,
};

const text = JSON.stringify(payload);
writeFileSync(new URL('priors.json', DATA), text);
out(`wrote priors.json (${(text.length / 1024).toFixed(0)}KB)`);

/*
 * Written first, then failed. A drifted constant does not make the priors
 * wrong — every fitted object above is measured from the data and is the best
 * available regardless — it makes one hand-carried number stale, and the app
 * should ship with the new fit while somebody goes and updates it.
 */
if (driftFailures.length > 0) {
  out(`\nFAIL  shipped constants have drifted: ${driftFailures.join(', ')}`);
  process.exitCode = 1;
}
