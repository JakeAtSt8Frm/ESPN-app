/**
 * Out-of-sample calibration of the forecast distributions.
 *
 * `verify:forecast` proves the fitter recovers parameters it was given. That is
 * necessary and not sufficient: a fitter can be perfectly correct and still be
 * fit on data that does not describe the season it is asked about. This asks
 * the harder question — when the model says "80% of results land in this band",
 * do 80% of results land in that band, on weeks the fit never saw?
 *
 * The split is by week. The fit is built on the first half of the prior season
 * and scored on the second, so no evaluation week contributes to the
 * distribution it is judged against.
 *
 * **The known weakness, stated up front.** ESPN publishes weekly projections
 * only for the season in progress, so the projection side here is the player's
 * prior-season projection prorated per game — the same stand-in the app
 * bootstraps on, for the same reason. The numbers below therefore measure the
 * shape of the spread honestly and the calibration of the *centre* only as well
 * as a season-average projection allows. Once this season has weeks of its own,
 * rerun it: it prefers real pairs whenever it has enough of them, and the
 * comparison between the two runs is the interesting output.
 *
 * Run with `npm run research:forecast`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compileScoring, createScorer, hasPlayed } from '../src/lib/scoring';
import { fitResidualModel, mixtureQuantile, scaleFor, type PriorPair } from '../src/lib/forecast';
import { POSITION_GROUPS, type League, type PositionGroup, type Player, type StatLine } from '../src/lib/types';
import { activeLeague, dataDir } from './league-paths';

const DATA = dataDir(activeLeague());

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(DATA, name), 'utf8')) as T;
}

const NOMINAL = [0.1, 0.25, 0.5, 0.75, 0.9];

async function main(): Promise<void> {
  const { league } = await readJson<{ league: League }>('league.json');
  const playersFile = await readJson<{
    players: Player[];
    seasonProjectionPrior: Record<string, StatLine>;
  }>('players.json');
  const history = await readJson<{
    season: string;
    logs: Record<string, Record<string, StatLine>>;
    games: Record<string, Record<string, { team: string; opp: string }>>;
  }>('history.json');

  const model = compileScoring(league.scoringSettings, league.scoringOverrides);
  const score = createScorer(model);
  const playersById = new Map(playersFile.players.map((p) => [p.playerId, p]));

  // ---- Build every (projection, actual) pair the prior season offers ------
  let maxWeek = 0;
  for (const byWeek of Object.values(history.logs)) {
    for (const rawWeek of Object.keys(byWeek)) maxWeek = Math.max(maxWeek, Number(rawWeek));
  }
  const priorGames = Math.max(1, maxWeek - 1);
  const all: Array<PriorPair & { group: PositionGroup }> = [];

  for (const [pid, byWeek] of Object.entries(history.logs)) {
    const player = playersById.get(pid);
    const group = player?.group;
    if (!group) continue;

    const seasonLine = playersFile.seasonProjectionPrior[pid];
    if (!seasonLine) continue;

    const perWeek = score(seasonLine, group) / priorGames;
    if (perWeek < 1) continue;

    for (const [rawWeek, line] of Object.entries(byWeek)) {
      const week = Number(rawWeek);
      maxWeek = Math.max(maxWeek, week);
      all.push({
        pid,
        group,
        projection: perWeek,
        actual: score(line, group),
        played: hasPlayed(line),
        week,
        team: history.games?.[pid]?.[rawWeek]?.team ?? player.team ?? '',
      });
    }
  }

  const splitWeek = Math.floor(maxWeek / 2);
  const train = all.filter((p) => p.week <= splitWeek);
  const test = all.filter((p) => p.week > splitWeek);

  process.stdout.write(
    `${history.season}: fit on weeks 1-${splitWeek} (${train.length} pairs), ` +
      `scored on ${splitWeek + 1}-${maxWeek} (${test.length} pairs)\n\n`,
  );

  const byGroup = new Map<PositionGroup, PriorPair[]>();
  for (const group of POSITION_GROUPS) byGroup.set(group, []);
  for (const pair of train) byGroup.get(pair.group)!.push(pair);

  const fitted = fitResidualModel({
    scoringModel: model,
    playersById,
    weekStats: new Map(),
    weekProjections: new Map(),
    throughWeek: 0,
    priorPairs: byGroup,
  });

  // ---- Coverage: does a nominal p-quantile contain p of the outcomes? -----
  const hits = NOMINAL.map(() => 0);
  let scored = 0;
  let sourceAbsError = 0;
  let correctedAbsError = 0;

  for (const pair of test) {
    const fit = fitted.byGroup.get(pair.group);
    if (!fit) continue;

    /*
     * Scored against the band the app actually shows — the mixture of the
     * played distribution with the point mass at zero — rather than against the
     * conditional shape. A player who did not appear is a real outcome at the
     * bottom of the interval, and testing only the played distribution would
     * quietly grade the model on the weeks it finds easy.
     */
    NOMINAL.forEach((nominal, i) => {
      const bound = mixtureQuantile(fit, pair.projection, fit.playRate, nominal, 0);
      if (pair.actual <= bound) hits[i]++;
    });

    // The corrected central estimate is the projection plus the fitted median
    // shift — the one thing the model claims to add to the source projection.
    const corrected = pair.projection + scaleFor(fit, pair.projection) * fit.medianZ;
    sourceAbsError += Math.abs(pair.actual - pair.projection);
    correctedAbsError += Math.abs(pair.actual - corrected);
    scored++;
  }

  process.stdout.write('calibration — an interval claiming p should contain p\n\n');
  process.stdout.write(`${'nominal'.padEnd(10)}${NOMINAL.map((n) => `${(n * 100).toFixed(0)}%`.padStart(9)).join('')}\n`);
  process.stdout.write(
    `${'actual'.padEnd(10)}` +
      hits.map((h) => `${((h / scored) * 100).toFixed(1)}%`.padStart(9)).join('') +
      `    n = ${scored.toLocaleString()}\n`,
  );

  const meanAbsCoverageError =
    hits.reduce((sum, h, i) => sum + Math.abs(h / scored - NOMINAL[i]), 0) / NOMINAL.length;
  process.stdout.write(
    `\nmean absolute coverage error  ${(meanAbsCoverageError * 100).toFixed(2)} points\n`,
  );

  process.stdout.write(
    `\npoint accuracy over the same held-out weeks\n` +
      `  source projection MAE   ${(sourceAbsError / scored).toFixed(3)}\n` +
      `  bias-corrected MAE      ${(correctedAbsError / scored).toFixed(3)}` +
      `  (${(((sourceAbsError - correctedAbsError) / sourceAbsError) * 100).toFixed(1)}%)\n`,
  );

  process.stdout.write('\nper-group fits\n');
  process.stdout.write(
    `${'group'.padEnd(7)}${'n'.padStart(7)}${'scale'.padStart(18)}${'median z'.padStart(11)}` +
      `${'playRate'.padStart(10)}\n`,
  );
  for (const group of POSITION_GROUPS) {
    const fit = fitted.byGroup.get(group);
    if (!fit) {
      process.stdout.write(`${group.padEnd(7)}${'—'.padStart(7)}  (too few pairs to fit)\n`);
      continue;
    }
    process.stdout.write(
      `${group.padEnd(7)}${String(fit.samples).padStart(7)}` +
        `${`${fit.scaleIntercept.toFixed(2)} + ${fit.scaleSlope.toFixed(3)}·p`.padStart(18)}` +
        `${fit.medianZ.toFixed(3).padStart(11)}${fit.playRate.toFixed(3).padStart(10)}\n`,
    );
  }

  process.stdout.write(
    `\nteam correlation (pooled across positions)  ${fitted.teamCorrelation.toFixed(4)}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
