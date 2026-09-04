/**
 * Fits the app's own weekly projection and writes it into the snapshot.
 *
 * Runs offline rather than at load. The fit is a few seconds of tree growing
 * over ten thousand player-weeks, which is fine in Node and is not fine on a
 * phone opening a lineup — and unlike the residual model, nothing about it
 * changes between page loads, so there is no reason to redo it on each one.
 *
 * Two numbers come out of every run and both are printed:
 *
 *  - **A rolling-origin holdout.** Fit on everything up to a cut, score the two
 *    weeks after it, move the cut, repeat. No week is ever scored by a model
 *    that has seen it, and the evaluation spans several points in the season
 *    rather than one lucky split.
 *  - **The baseline it has to beat**, which is the exponentially weighted mean
 *    of the player's recent scores. That is the best forecast the app could
 *    make from the same history without a model, so beating it is the whole
 *    claim.
 *
 * A third number is now printed beside them: **ESPN's own weekly projection**
 * for the same week. That comparison was previously impossible — a finished
 * season served its game logs and not the numbers that preceded them — and it
 * is possible now because the snapshot reads each finished season through the
 * template league, which retains both. It is not a gate, because the model is
 * not trying to beat ESPN: ESPN knows about depth charts, trades and press
 * conferences that no history-only model can see. It is printed because a
 * history-only challenger sitting far below the source it is displayed next to
 * is worth knowing about, and until now nobody could know it.
 *
 * The fit spans every finished season in the snapshot rather than one, which
 * changes the model rather than just enlarging it: `priorLevel` — what a player
 * scored the season *before* the row being fit — is a real feature for the
 * first time. A single-season fit had no season behind it to fill that column,
 * so it sat at zero in training and non-zero at serve time, a train/serve
 * mismatch on exactly the feature the app leans on hardest in September.
 *
 * The shipped model is then refit on every week available, because a model that
 * will forecast week 5 should have seen week 18.
 *
 *   npm run fit:projection
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { fitInputsHash } from './fit-inputs';
import { fileURLToPath } from 'node:url';
import {
  reshapeSeason,
  seasonLevels,
  type RawSeasonFile,
  type SeasonHistory,
} from '../src/lib/history';
import { buildPregameMatchupIndexes } from '../src/lib/matchup';
import {
  advance,
  featuresFrom,
  fitGroupModel,
  meanAbsoluteError,
  newRollingState,
  predictWith,
  PROJECTION_FEATURES,
  weightedMean,
  type GroupModel,
  type ProjectionModel,
} from '../src/lib/projection';
import { round } from '../src/lib/stats';
import {
  compileScoring,
  createScorer,
  hasPlayed,
  hasValidProjection,
  opportunities,
} from '../src/lib/scoring';
import { POSITION_GROUPS, type League, type Player, type PositionGroup, type StatLine } from '../src/lib/types';
import { activeLeague, dataUrl, historyUrl } from './league-paths';

const LEAGUE = activeLeague();
const DATA = dataUrl(LEAGUE);
const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, DATA), 'utf8')) as T;

/** Raw finished seasons, which live outside `public/` — see `snapshot.ts`. */
const HISTORY = historyUrl(LEAGUE);
const readHistory = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, HISTORY), 'utf8')) as T;

const index = read<{ generatedAt: number; historySeasons?: number[]; priorSeason: string }>(
  'index.json',
);
const leagueFile = read<{ league: League }>('league.json');
const playersFile = read<{ players: Player[]; seasonActualPrior: Record<string, StatLine> }>(
  'players.json',
);

const scoringModel = compileScoring(
  leagueFile.league.scoringSettings,
  leagueFile.league.scoringOverrides,
);
const score = createScorer(scoringModel);
const playersById = new Map(playersFile.players.map((p) => [p.playerId, p]));
const fallbackGroups = new Map(playersFile.players.map((p) => [p.playerId, p.group]));

// ---- Every finished season, oldest first ------------------------------------

const MAX_WEEK = 18;

const seasonYears = [...(index.historySeasons ?? [Number(index.priorSeason)])]
  .filter((year) => existsSync(fileURLToPath(new URL(`${year}.json`, HISTORY))))
  .sort((a, b) => a - b);

if (seasonYears.length === 0) {
  process.stderr.write('no finished seasons in the snapshot — run npm run snapshot first\n');
  process.exit(1);
}

const histories = new Map<number, SeasonHistory>(
  seasonYears.map((year) => [
    year,
    reshapeSeason(readHistory<RawSeasonFile>(`${year}.json`), fallbackGroups),
  ]),
);

process.stdout.write(`seasons: ${seasonYears.join(', ')}\n`);
process.stdout.write('rebuilding leak-free pregame matchup ratings…\n');

/** season -> week -> the rating that was knowable before that week. */
const pregameBySeason = new Map<number, ReturnType<typeof buildPregameMatchupIndexes>>();
/** season -> "week:team:group" -> the unit's total opportunity volume. */
const teamTotalsBySeason = new Map<number, Map<string, number>>();
/** season -> pid -> his per-week level over the weeks he played. */
const levelsBySeason = new Map<number, Map<string, number>>();

for (const year of seasonYears) {
  const history = histories.get(year)!;
  const playersOfSeason = new Map<string, Player>(
    [...history.groups].map(([pid, group]) => [
      pid,
      { ...(playersById.get(pid) ?? ({} as Player)), group },
    ]),
  );

  pregameBySeason.set(
    year,
    buildPregameMatchupIndexes(
      {
        scoringModel,
        playersById: playersOfSeason,
        weekStats: history.weekStats,
        weekOpponents: history.weekOpponents,
        weekTeams: history.weekTeams,
      },
      MAX_WEEK,
    ),
  );

  const totals = new Map<string, number>();
  for (const [week, lines] of history.weekStats) {
    for (const [pid, line] of Object.entries(lines)) {
      if (!hasPlayed(line)) continue;
      const group = history.groups.get(pid);
      const team = history.weekTeams.get(week)?.[pid];
      if (!group || !team) continue;
      const volume = opportunities(group, line);
      if (volume === null) continue;
      const key = `${week}:${team}:${group}`;
      totals.set(key, (totals.get(key) ?? 0) + volume);
    }
  }
  teamTotalsBySeason.set(year, totals);

  levelsBySeason.set(
    year,
    new Map([...seasonLevels(history, scoringModel)].map(([pid, e]) => [pid, e.level])),
  );
}

/**
 * The form level above which a player is somebody you would actually start.
 *
 * The calibration gate below has to run over the population the app *shows*,
 * not the one the model was fit on. Every played week goes into the fit, which
 * is right — a fringe receiver's quiet afternoon is real data. But nobody reads
 * a projection for him, and including those rows drags the holdout median far
 * below the level of the players whose rows a manager is looking at. Measuring
 * calibration over the full population flagged three healthy groups.
 */
const STARTABLE: Record<PositionGroup, number> = {
  QB: 12,
  RB: 8,
  WR: 8,
  TE: 6,
  K: 6,
  DST: 4,
};

// ---- Build the training table -----------------------------------------------

interface Row {
  group: PositionGroup;
  season: number;
  week: number;
  features: number[];
  target: number;
  /** The baseline forecast for this row, carried so it can be scored too. */
  baseline: number;
  /**
   * ESPN's own projection for the same week, where it published one.
   *
   * Reported rather than gated on. The model is not competing with ESPN — it
   * cannot see a depth chart or a Wednesday practice report — but a challenger
   * shown beside ESPN's number should have its distance from it measured rather
   * than left to the reader to guess.
   */
  espn: number | null;
}

const rows: Row[] = [];

/**
 * Every player's season-long level and usage, in the exact shape the app uses
 * to seed a player who has not played yet.
 *
 * This exists to test that path, because nothing did and it was broken. In week
 * one the app has no current-season history, so it seeds each player from his
 * prior-season level and asks the model — a state that appears nowhere in the
 * training set, where every row has real in-season history behind it. The first
 * version projected Lamar Jackson at 5.0 against ESPN's 19.1 and a set of
 * kickers at 6.2 against their own prior-season average of 10.1, and both the
 * accuracy and calibration gates passed it, because both measure the in-season
 * path only.
 */
const seeds = new Map<PositionGroup, Array<{ level: number; features: number[] }>>(
  POSITION_GROUPS.map((g) => [g, []]),
);

for (const year of seasonYears) {
  const history = histories.get(year)!;
  const pregame = pregameBySeason.get(year)!;
  const teamTotals = teamTotalsBySeason.get(year)!;

  /*
   * What each player scored the season *before* this one.
   *
   * This is the whole reason for fitting across seasons rather than merely
   * pooling them. `priorLevel` used to be structurally zero in training — a
   * single-season fit has no season behind it — while the app filled it with a
   * real number at serve time. The trees therefore never split on it, and the
   * one feature that carries information in September was inert exactly when
   * every other feature is empty. Here it is populated for every season after
   * the first, so the model can learn what last year is worth.
   */
  const priorLevels = levelsBySeason.get(year - 1) ?? new Map<string, number>();

  /** pid -> week -> the actual line, ordered. */
  const byPlayer = new Map<string, Map<number, StatLine>>();
  for (const [week, lines] of history.weekStats) {
    for (const [pid, line] of Object.entries(lines)) {
      let weeks = byPlayer.get(pid);
      if (!weeks) byPlayer.set(pid, (weeks = new Map()));
      weeks.set(week, line);
    }
  }

  for (const [pid, weeks] of byPlayer) {
    const group = history.groups.get(pid);
    if (!group) continue;

    const state = newRollingState(round(priorLevels.get(pid) ?? 0, 2));
    const ordered = [...weeks.keys()].sort((a, b) => a - b);

    for (const week of ordered) {
      const line = weeks.get(week)!;
      const opponent = history.weekOpponents.get(week)?.[pid] ?? null;
      const played = hasPlayed(line);

      /*
       * Only weeks he actually played become training rows.
       *
       * This is the difference between a model that works and one that does
       * not, and getting it wrong the first time produced a projection of 5.0
       * for Lamar Jackson against ESPN's 19.1. Over half of every position's
       * rostered weeks are weeks the player did not appear, so the median
       * weekly score across all of them is 0.0, and a model fit to the median
       * of that population is correctly telling you about a distribution
       * dominated by backups sitting on a bench.
       *
       * The app shows this number next to ESPN's, for players about to be
       * started. So the question it has to answer is ESPN's question: what does
       * he score *when he plays*. Whether he plays is a separate question, and
       * one the app already answers separately — the residual model carries a
       * point mass at zero and the Expected Score tile prices it in.
       *
       * The history behind the features still includes his missed weeks. A
       * player who misses time has that in `playRate` and carries the zeros in
       * his form. It is only the target that is conditioned.
       */
      if (state.played >= 2 && opponent && played) {
        const rating = pregame.get(week)?.get(group, opponent)?.score ?? null;
        const espnLine = history.weekProjections.get(week)?.[pid];
        rows.push({
          group,
          season: year,
          week,
          features: featuresFrom(state, rating),
          target: score(line, group),
          baseline: weightedMean(state.scores),
          espn: espnLine && hasValidProjection(espnLine) ? score(espnLine, group) : null,
        });
      }

      const volume = played ? opportunities(group, line) : null;
      const team = history.weekTeams.get(week)?.[pid];
      const total = team ? teamTotals.get(`${week}:${team}:${group}`) : undefined;
      advance(
        state,
        played,
        played ? score(line, group) : 0,
        volume,
        volume !== null && total ? volume / total : null,
      );
    }

    // The seeded state for this player, built the way `league.ts` builds it.
    const playedWeeks = ordered.filter((week) => week <= 17 && hasPlayed(weeks.get(week)!));
    if (playedWeeks.length >= 2) {
      let points = 0;
      let volumeTotal = 0;
      let volumeCount = 0;
      let shareTotal = 0;
      let shareCount = 0;
      for (const week of playedWeeks) {
        const line = weeks.get(week)!;
        points += score(line, group);
        const volume = opportunities(group, line);
        if (volume !== null) {
          volumeTotal += volume;
          volumeCount++;
          const team = history.weekTeams.get(week)?.[pid];
          const unit = team ? teamTotals.get(`${week}:${team}:${group}`) : undefined;
          if (unit) {
            shareTotal += volume / unit;
            shareCount++;
          }
        }
      }
      const level = points / playedWeeks.length;
      const seedState = newRollingState(level);
      for (let i = 0; i < 5; i++) {
        advance(
          seedState,
          true,
          level,
          volumeCount ? volumeTotal / volumeCount : null,
          shareCount ? shareTotal / shareCount : null,
        );
      }
      seedState.rostered = Math.round(
        seedState.played / Math.max(playedWeeks.length / ordered.length, 0.05),
      );
      seeds.get(group)!.push({ level, features: featuresFrom(seedState, 50) });
    }
  }
}

/*
 * Each position's median-to-mean ratio over startable players.
 *
 * This is what a median-targeting model is *supposed* to return when it is
 * handed a mean, and it is the reference the cold-start gate measures against.
 * Measured rather than assumed, because it varies a lot — a quarterback's week
 * is near-symmetric at 1.02, a running back's is skewed to 0.86.
 */
const skewByGroup = new Map<PositionGroup, number>();
for (const group of POSITION_GROUPS) {
  const startableRows = rows.filter(
    (r) => r.group === group && r.baseline >= STARTABLE[group],
  );
  if (startableRows.length < 100) continue;
  const values = startableRows.map((r) => r.target).sort((a, b) => a - b);
  const median = values[values.length >> 1];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean > 0) skewByGroup.set(group, median / mean);
}

process.stdout.write(`training rows: ${rows.length}\n\n`);

// ---- Rolling-origin holdout --------------------------------------------------

const CUTS = [9, 11, 13, 15];

/**
 * How far a group's level may sit from the median it claims to report.
 *
 * Deliberately loose. A median estimated on a few hundred holdout weeks is
 * itself noisy, so this is a check for a column that is plainly in the wrong
 * place, not a demand for precision.
 */
const LEVEL_TOLERANCE = 0.12;

/**
 * How far the cold-start path may sit from where it *should* sit.
 *
 * Not from 1.0 — that would be the wrong target. The seed hands the model a
 * player's mean over the weeks he played, and the model returns a median week,
 * so on a right-skewed position the ratio is supposed to come back below one.
 * How far below is measurable: it is the position's own median-to-mean ratio
 * over startable players, which runs from 0.86 at running back to 1.02 at
 * quarterback. Comparing against a flat 1.0 would pass a broken kicker and fail
 * a healthy running back.
 */
const SEED_TOLERANCE = 0.12;

/** Cold-start level by group, reported alongside the fit. */
const seedLevelByGroup = new Map<PositionGroup, number>();
const holdout: Record<
  PositionGroup,
  {
    y: number[];
    model: number[];
    base: number[];
    /** The subset of holdout rows ESPN also projected, and its own numbers. */
    espnY: number[];
    espn: number[];
    espnModel: number[];
  }
> = Object.fromEntries(
  POSITION_GROUPS.map((g) => [
    g,
    { y: [], model: [], base: [], espnY: [], espn: [], espnModel: [] },
  ]),
) as never;

/** Per-cut improvement over the baseline, for the stability gate below. */
const liftByCut = new Map<PositionGroup, number[]>(POSITION_GROUPS.map((g) => [g, []]));



for (const group of POSITION_GROUPS) {
  const groupRows = rows.filter((r) => r.group === group);

  for (const year of seasonYears) {
    /*
     * The cut walks through one season at a time, and everything from an
     * *earlier* season is always training.
     *
     * That is the only arrangement that is both leak-free and honest about what
     * the app knows. Pooling all seasons and cutting on week alone would train
     * on week 9 of 2025 to predict week 10 of 2023, which is not a forecast.
     * Holding out whole seasons instead would never test the in-season path at
     * all. This tests exactly the question the app asks in week 11: everything
     * before now, including previous years, against the fortnight ahead.
     */
    const earlier = groupRows.filter((r) => r.season < year);
    const thisSeason = groupRows.filter((r) => r.season === year);

    for (const cut of CUTS) {
      const train = [...earlier, ...thisSeason.filter((r) => r.week <= cut)];
      const test = thisSeason.filter((r) => r.week > cut && r.week <= cut + 2);
      if (train.length < 120 || test.length < 20) continue;

      const fit = fitGroupModel(
        train.map((r) => r.features),
        train.map((r) => r.target),
      );
      const model: GroupModel = {
        group,
        base: fit.base,
        learningRate: fit.learningRate,
        trees: fit.trees,
        samples: train.length,
        mae: 0,
        baselineMae: 0,
        level: 1,
        coldStartOk: true,
      };

      const cutActual: number[] = [];
      const cutModel: number[] = [];
      const cutBase: number[] = [];
      for (const row of test) {
        const predicted = predictWith(model, row.features);
        holdout[group].y.push(row.target);
        holdout[group].model.push(predicted);
        holdout[group].base.push(row.baseline);
        if (row.espn !== null) {
          holdout[group].espnY.push(row.target);
          holdout[group].espn.push(row.espn);
          holdout[group].espnModel.push(predicted);
        }
        cutActual.push(row.target);
        cutModel.push(predicted);
        cutBase.push(row.baseline);
      }
      const cutBaseMae = meanAbsoluteError(cutActual, cutBase);
      liftByCut
        .get(group)!
        .push(cutBaseMae > 0 ? 1 - meanAbsoluteError(cutActual, cutModel) / cutBaseMae : 0);
    }
  }
}

process.stdout.write(
  `rolling-origin holdout — fit up to week C, score C+1 and C+2, for C in ${CUTS.join(', ')}\n\n`,
);
process.stdout.write(
  'group     n   baseline MAE   model MAE   improvement   level vs median   per-window\n',
);

const pooled = { y: [] as number[], model: [] as number[], base: [] as number[] };
const scoreByGroup = new Map<
  PositionGroup,
  { mae: number; baselineMae: number; level: number }
>();

for (const group of POSITION_GROUPS) {
  const h = holdout[group];
  if (!h.y.length) {
    process.stdout.write(`${group.padEnd(6)}    — too few rows to hold out\n`);
    continue;
  }
  const modelMae = meanAbsoluteError(h.y, h.model);
  const baseMae = meanAbsoluteError(h.y, h.base);

  /*
   * A second gate, on level rather than error.
   *
   * MAE says the ordering and the spacing are right; it says very little about
   * whether the whole column sits where it should. A model can beat the
   * baseline and still be biased low everywhere, and one did — kicker cleared
   * the accuracy gate at +4.5% while projecting 33% under ESPN, against a
   * median-to-mean gap of only 5% that could explain it. Somebody reading that
   * column next to ESPN's would conclude every kicker in the league was
   * overrated.
   *
   * Two things have to be right about the comparison. Both sides are medians —
   * predicted *mean* against actual *median* is guaranteed to exceed 1 on a
   * right-skewed target, which is the very skew the median was chosen to
   * sidestep. And both are taken over startable players only, because that is
   * who the column is read for.
   */
  const mid = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };

  const startable = h.y
    .map((actual, i) => ({ actual, predicted: h.model[i], form: h.base[i] }))
    .filter((row) => row.form >= STARTABLE[group]);

  const actualMedian = mid(startable.map((r) => r.actual));
  const predictedMedian = mid(startable.map((r) => r.predicted));
  const level = startable.length >= 40 && actualMedian > 0 ? predictedMedian / actualMedian : 1;

  scoreByGroup.set(group, { mae: modelMae, baselineMae: baseMae, level });

  const lift = (1 - modelMae / baseMae) * 100;
  process.stdout.write(
    `${group.padEnd(6)} ${String(h.y.length).padStart(4)}   ${baseMae.toFixed(3).padStart(10)}   ` +
      `${modelMae.toFixed(3).padStart(9)}   ${((lift >= 0 ? '+' : '') + lift.toFixed(1) + '%').padStart(11)}   ` +
      `${level.toFixed(2).padStart(15)}   ` +
      `${(liftByCut.get(group) ?? []).map((l) => (l > 0 ? '+' : '-')).join('')}\n`,
  );

  pooled.y.push(...h.y);
  pooled.model.push(...h.model);
  pooled.base.push(...h.base);
}

const pooledModel = meanAbsoluteError(pooled.y, pooled.model);
const pooledBase = meanAbsoluteError(pooled.y, pooled.base);
process.stdout.write(
  `\npooled  ${String(pooled.y.length).padStart(4)}   ${pooledBase.toFixed(3).padStart(10)}   ` +
    `${pooledModel.toFixed(3).padStart(9)}   ` +
    `${((1 - pooledModel / pooledBase) * 100).toFixed(1)}%\n`,
);

/*
 * The comparison that used to be impossible.
 *
 * ESPN publishes weekly projections only for a season in progress — or so this
 * project assumed, because the endpoint it read a finished season through
 * carries game logs and nothing else. Reading finished seasons through the
 * template league instead recovers the projection that preceded each one, which
 * makes the honest question askable for the first time: how does a history-only
 * challenger do against the source it is displayed beside.
 *
 * It is not a gate and it should not be. ESPN's projection knows about a depth
 * chart, a trade and a Wednesday practice report; this model sees only what a
 * player has already scored. A history-only model that beat it every week would
 * be evidence of a leak, not of skill. What the numbers below are for is
 * knowing how far behind the app's second opinion actually is, per position,
 * instead of guessing.
 */
process.stdout.write('\nagainst ESPN, on the same held-out weeks\n\n');
process.stdout.write('group     n    ESPN MAE   model MAE   gap\n');

const espnPooled = { y: [] as number[], espn: [] as number[], model: [] as number[] };
for (const group of POSITION_GROUPS) {
  const h = holdout[group];
  if (h.espnY.length < 50) continue;
  const espnMae = meanAbsoluteError(h.espnY, h.espn);
  const modelMae = meanAbsoluteError(h.espnY, h.espnModel);
  espnPooled.y.push(...h.espnY);
  espnPooled.espn.push(...h.espn);
  espnPooled.model.push(...h.espnModel);
  const gap = (modelMae / espnMae - 1) * 100;
  process.stdout.write(
    `${group.padEnd(6)} ${String(h.espnY.length).padStart(4)}   ${espnMae.toFixed(3).padStart(8)}   ` +
      `${modelMae.toFixed(3).padStart(9)}   ${(gap >= 0 ? '+' : '') + gap.toFixed(1)}%\n`,
  );
}
if (espnPooled.y.length > 0) {
  const espnMae = meanAbsoluteError(espnPooled.y, espnPooled.espn);
  const modelMae = meanAbsoluteError(espnPooled.y, espnPooled.model);
  process.stdout.write(
    `\npooled ${String(espnPooled.y.length).padStart(5)}   ${espnMae.toFixed(3).padStart(8)}   ` +
      `${modelMae.toFixed(3).padStart(9)}   ` +
      `${((modelMae / espnMae - 1) * 100).toFixed(1)}%\n`,
  );
}

if (pooledModel >= pooledBase) {
  process.stdout.write(
    '\nthe model does not beat the baseline on this data — not writing it\n',
  );
  process.exit(1);
}

// ---- Refit on everything and write ------------------------------------------

process.stdout.write('\ncold-start path (what the app runs before any games)\n');
const byGroup: ProjectionModel['byGroup'] = {};
for (const group of POSITION_GROUPS) {
  const groupRows = rows.filter((r) => r.group === group);
  if (groupRows.length < 150) {
    process.stdout.write(`skipping ${group}: only ${groupRows.length} rows\n`);
    continue;
  }

  /*
   * A group only ships if it earned the right to on its own holdout.
   *
   * Kicker fails this and should: nothing in a kicker's history forecasts his
   * next week, which is the same finding the trade model ran into from the
   * other direction — the correlation between a kicker's projected level and
   * his realised one is 0.25 on 34 players, indistinguishable from zero. A
   * model fit to structure that is not there finds noise and repeats it, and
   * here it lands 3.9% *worse* than simply carrying his recent average forward.
   *
   * Shipping it anyway and letting the page show a worse number in a confident
   * colour is the failure mode this guard exists to prevent. Where the model
   * cannot beat the baseline the app shows ESPN's projection alone.
   */
  const measuredHoldout = scoreByGroup.get(group);
  if (measuredHoldout && measuredHoldout.mae >= measuredHoldout.baselineMae) {
    process.stdout.write(
      `skipping ${group}: ${measuredHoldout.mae.toFixed(3)} MAE against a ` +
        `${measuredHoldout.baselineMae.toFixed(3)} baseline — the model loses\n`,
    );
    continue;
  }
  /*
   * A third gate: the improvement has to hold up across the season, not just in
   * aggregate.
   *
   * Kicker is why. It came out 3.9% *worse* than the baseline on one fit and
   * 4.5% better on the next, off a change to which rows were eligible — and a
   * lift that flips sign on a detail like that is not skill, it is a small
   * sample finding whatever it happens to find. It agrees with what the trade
   * model measured from the other direction: the correlation between a kicker's
   * projected level and his realised one is 0.25 on 34 players, which cannot be
   * distinguished from zero. There is nothing there to learn.
   *
   * So a group has to beat the baseline on most of the individual holdout
   * windows, not merely on their pooled total, where one good window can carry
   * three bad ones.
   */
  const cuts = liftByCut.get(group) ?? [];
  const winning = cuts.filter((lift) => lift > 0).length;
  if (cuts.length >= 3 && winning * 2 <= cuts.length) {
    process.stdout.write(
      `skipping ${group}: beat the baseline in only ${winning} of ${cuts.length} holdout ` +
        `windows (${cuts.map((l) => `${(l * 100).toFixed(0)}%`).join(', ')}) — not a stable edge\n`,
    );
    continue;
  }
  if (measuredHoldout && Math.abs(measuredHoldout.level - 1) > LEVEL_TOLERANCE) {
    process.stdout.write(
      `skipping ${group}: predictions sit at ${measuredHoldout.level.toFixed(2)} of the ` +
        'holdout median — accurate in ordering, miscalibrated in level\n',
    );
    continue;
  }

  const fit = fitGroupModel(
    groupRows.map((r) => r.features),
    groupRows.map((r) => r.target),
  );
  const model = {
    ...fit,
    group,
    samples: groupRows.length,
    mae: 0,
    baselineMae: 0,
    level: 1,
    coldStartOk: true,
  };

  /*
   * The seeded path, which is what the app runs in week one and which the two
   * gates above cannot see. Fed a player's own prior-season level, the model
   * has to give back something close to it — it has no other information, so
   * anything else is the seed landing somewhere the trees were never fit.
   */
  let coldStartOk = true;
  const groupSeeds = (seeds.get(group) ?? []).filter(
    (seed) => seed.level >= STARTABLE[group],
  );
  if (groupSeeds.length >= 20) {
    const mid = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[sorted.length >> 1];
    };
    const seededLevel =
      mid(groupSeeds.map((seed) => predictWith(model, seed.features))) /
      mid(groupSeeds.map((seed) => seed.level));

    // What a correctly behaving median model should return on a mean-shaped seed.
    const expected = skewByGroup.get(group) ?? 1;
    const drift = seededLevel - expected;

    process.stdout.write(
      `  ${group.padEnd(5)} cold start returns ${seededLevel.toFixed(2)} of a player's own ` +
        `prior level; the median-to-mean ratio says it should be ${expected.toFixed(2)} ` +
        `(${groupSeeds.length} players)\n`,
    );

    /*
     * A failure here suppresses the *cold start*, not the model.
     *
     * The two paths are different questions and a group can be sound on one and
     * not the other. Discarding a model that works from week three onward
     * because it cannot be trusted in week one throws away most of its value —
     * so it ships either way, and the app declines to print a number for the
     * group until this season has given it real weeks to work from.
     */
    if (Math.abs(drift) > SEED_TOLERANCE) {
      coldStartOk = false;
      process.stdout.write(
        `  ${group.padEnd(5)} cold start suppressed: ${(drift * 100).toFixed(0)} points off ` +
          'the skew — this group stays blank until the season has weeks of its own\n',
      );
    }
    seedLevelByGroup.set(group, seededLevel);
  } else {
    process.stdout.write(
      `  ${group.padEnd(5)} cold start: only ${groupSeeds.length} startable players — untested\n`,
    );
  }
  const measured = measuredHoldout;
  byGroup[group] = {
    group,
    base: Number(fit.base.toFixed(4)),
    learningRate: fit.learningRate,
    // Rounded before serialising: four decimals is far finer than a projection
    // and it takes about a third off the shipped size.
    trees: fit.trees.map((tree) => ({
      feature: tree.feature,
      threshold: tree.threshold.map((v) => Number(v.toFixed(4))),
      left: tree.left,
      right: tree.right,
      value: tree.value.map((v) => Number(v.toFixed(4))),
    })),
    samples: groupRows.length,
    mae: Number((measured?.mae ?? 0).toFixed(4)),
    baselineMae: Number((measured?.baselineMae ?? 0).toFixed(4)),
    level: Number((measured?.level ?? 1).toFixed(3)),
    coldStartOk,
  };
}

const model: ProjectionModel = {
  // Stamped with the snapshot's own timestamp so a stale model cannot be used
  // alongside fresh data. The hash beside it lets `npm run
  // restamp` carry this model onto a fresher snapshot when none of the inputs
  // it actually read have changed — which is every in-season refresh.
  generatedAt: index.generatedAt,
  inputsHash: fitInputsHash(),
  season: seasonYears.map(String).join('+'),
  fittedAt: Date.now(),
  features: PROJECTION_FEATURES,
  byGroup,
};

/*
 * Which features the trees actually split on.
 *
 * Printed because the multi-season fit was justified by one specific claim —
 * that `priorLevel` stops being structurally zero and starts carrying weight —
 * and a claim like that should be checkable from the output rather than taken
 * on trust. A feature that never appears here is inert, whatever the interface
 * says about it, and `priorLevel` sat at exactly zero splits for as long as the
 * fit had one season to work with.
 */
process.stdout.write('\nfeature usage — share of splits, per group\n\n');
process.stdout.write(`feature      ${POSITION_GROUPS.map((g) => g.padStart(6)).join('')}\n`);

const splitShare = new Map<PositionGroup, number[]>();
for (const group of POSITION_GROUPS) {
  const shipped = byGroup[group];
  if (!shipped) continue;
  const counts = new Array<number>(PROJECTION_FEATURES.length).fill(0);
  let total = 0;
  for (const tree of shipped.trees) {
    for (const feature of tree.feature) {
      if (feature < 0) continue;
      counts[feature]++;
      total++;
    }
  }
  splitShare.set(group, total ? counts.map((c) => c / total) : counts);
}

PROJECTION_FEATURES.forEach((name, i) => {
  const cells = POSITION_GROUPS.map((group) => {
    const share = splitShare.get(group)?.[i];
    return share === undefined ? '     —' : `${(share * 100).toFixed(1).padStart(5)}%`;
  }).join('');
  process.stdout.write(`${name.padEnd(12)}${cells}\n`);
});

const out = new URL('projection.json', DATA);
const json = JSON.stringify(model);
writeFileSync(out, json);
process.stdout.write(
  `\nwrote projection.json — ${POSITION_GROUPS.filter((g) => byGroup[g]).length} groups, ` +
    `${(json.length / 1024).toFixed(0)}KB\n`,
);
