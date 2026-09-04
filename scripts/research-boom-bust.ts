/**
 * Rolling-origin calibration research for the displayed boom/bust chances.
 *
 * Each forecast is fit only on earlier weeks, then scored on the next three.
 * Brier score is the primary metric because it rewards both calibration and
 * discrimination; log loss is included to expose unjustified certainty.
 *
 * Run with `npm run research:boom-bust`.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fitResidualModel,
  mixtureCdf,
  type PriorPair,
  type ResidualFit,
  type ResidualModel,
} from '../src/lib/forecast';
import { buildPregameMatchupIndexes } from '../src/lib/matchup';
import { compileScoring, createScorer, hasPlayed } from '../src/lib/scoring';
import { clamp, quantile } from '../src/lib/stats';
import type { League, Player, PositionGroup, StatLine } from '../src/lib/types';
import { POSITION_GROUPS } from '../src/lib/types';
import { DEFAULT_BOOM_BUST } from '../src/lib/value';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const PLAY_RATE_PRIOR = 4;
const EPSILON = 1e-6;

interface Row extends PriorPair {
  group: PositionGroup;
  opponent: string;
}

interface Prediction {
  group: PositionGroup;
  boom: number;
  bust: number;
  boomActual: number;
  bustActual: number;
}

interface PlayFit {
  mean: number;
  sd: number;
  intercept: number;
  slope: number;
}

interface TierFit {
  cuts: [number, number];
  fits: Array<ResidualFit | null>;
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(DATA, name), 'utf8')) as T;
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

/** Penalised logistic fit of participation against log projection. */
function fitPlayRate(rows: Row[]): PlayFit {
  const xs = rows.map((row) => Math.log1p(row.projection));
  const mean = xs.reduce((sum, value) => sum + value, 0) / Math.max(1, xs.length);
  const variance = xs.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, xs.length);
  const sd = Math.max(Math.sqrt(variance), 1e-6);
  const rate = rows.reduce((sum, row) => sum + Number(row.played), 0) /
    Math.max(1, rows.length);

  let intercept = Math.log(clamp(rate, 0.01, 0.99) / (1 - clamp(rate, 0.01, 0.99)));
  let slope = 0;
  const ridge = 8;

  for (let iteration = 0; iteration < 30; iteration++) {
    let gradient0 = 0;
    let gradient1 = -ridge * slope;
    let hessian00 = 0;
    let hessian01 = 0;
    let hessian11 = ridge;

    for (let i = 0; i < rows.length; i++) {
      const x = (xs[i] - mean) / sd;
      const probability = sigmoid(intercept + slope * x);
      const weight = Math.max(probability * (1 - probability), 1e-6);
      const error = Number(rows[i].played) - probability;
      gradient0 += error;
      gradient1 += error * x;
      hessian00 += weight;
      hessian01 += weight * x;
      hessian11 += weight * x * x;
    }

    const determinant = hessian00 * hessian11 - hessian01 ** 2;
    if (determinant <= 1e-9) break;
    const delta0 = (gradient0 * hessian11 - gradient1 * hessian01) / determinant;
    const delta1 = (gradient1 * hessian00 - gradient0 * hessian01) / determinant;
    intercept += delta0;
    slope += delta1;
    if (Math.max(Math.abs(delta0), Math.abs(delta1)) < 1e-7) break;
  }

  return { mean, sd, intercept, slope };
}

function predictedPlayRate(fit: PlayFit, projection: number): number {
  return sigmoid(fit.intercept + fit.slope * ((Math.log1p(projection) - fit.mean) / fit.sd));
}

function playerPlayRate(
  model: ResidualModel,
  fit: ResidualFit,
  pid: string,
  prior: number,
): number {
  const own = model.playsByPlayer.get(pid);
  return own
    ? (own.played + prior * PLAY_RATE_PRIOR) / (own.projected + PLAY_RATE_PRIOR)
    : prior || fit.playRate;
}

function fitModel(
  train: Row[],
  playersById: Map<string, Player>,
  scoringModel: ReturnType<typeof compileScoring>,
): ResidualModel {
  const priorPairs = new Map<PositionGroup, PriorPair[]>();
  const priorPlays = new Map<string, { played: number; projected: number }>();
  for (const group of POSITION_GROUPS) priorPairs.set(group, []);

  for (const row of train) {
    priorPairs.get(row.group)!.push(row);
    const own = priorPlays.get(row.pid) ?? { played: 0, projected: 0 };
    own.projected++;
    if (row.played) own.played++;
    priorPlays.set(row.pid, own);
  }

  return fitResidualModel({
    scoringModel,
    playersById,
    weekStats: new Map(),
    weekProjections: new Map(),
    throughWeek: 0,
    priorPairs,
    priorPlays,
  });
}

function fitTiers(
  train: Row[],
  playersById: Map<string, Player>,
  scoringModel: ReturnType<typeof compileScoring>,
): Map<PositionGroup, TierFit> {
  const out = new Map<PositionGroup, TierFit>();
  for (const group of POSITION_GROUPS) {
    const groupRows = train.filter((row) => row.group === group);
    if (groupRows.length < 180) continue;
    const levels = groupRows.map((row) => row.projection);
    const cuts: [number, number] = [quantile(levels, 1 / 3), quantile(levels, 2 / 3)];
    const fits = [0, 1, 2].map((tier) => {
      const rows = groupRows.filter((row) => tierOf(row.projection, cuts) === tier);
      return fitModel(rows, playersById, scoringModel).byGroup.get(group) ?? null;
    });
    out.set(group, { cuts, fits });
  }
  return out;
}

function tierOf(projection: number, cuts: [number, number]): number {
  return projection <= cuts[0] ? 0 : projection <= cuts[1] ? 1 : 2;
}

function probability(
  fit: ResidualFit,
  row: Row,
  playProb: number,
  matchupFactor: number,
): { boom: number; bust: number } {
  const shift = row.projection * (matchupFactor - 1);
  const boomThreshold = row.projection * DEFAULT_BOOM_BUST.boomPct;
  const bustThreshold = row.projection * DEFAULT_BOOM_BUST.bustPct;
  return {
    boom: 1 - mixtureCdf(fit, row.projection, playProb, boomThreshold, shift),
    bust: mixtureCdf(fit, row.projection, playProb, bustThreshold, shift),
  };
}

function metrics(predictions: Prediction[], event: 'boom' | 'bust') {
  let brier = 0;
  let logLoss = 0;
  const bins = Array.from({ length: 10 }, () => ({ count: 0, predicted: 0, actual: 0 }));

  for (const row of predictions) {
    const probability = clamp(row[event], EPSILON, 1 - EPSILON);
    const actual = row[`${event}Actual`];
    brier += (probability - actual) ** 2;
    logLoss -= actual * Math.log(probability) + (1 - actual) * Math.log(1 - probability);
    const bin = bins[Math.min(9, Math.floor(probability * 10))];
    bin.count++;
    bin.predicted += probability;
    bin.actual += actual;
  }

  const count = Math.max(1, predictions.length);
  const calibrationError = bins.reduce((sum, bin) => {
    if (!bin.count) return sum;
    return sum + (bin.count / count) * Math.abs(bin.predicted / bin.count - bin.actual / bin.count);
  }, 0);
  return { brier: brier / count, logLoss: logLoss / count, calibrationError, bins };
}

function printMetrics(label: string, predictions: Prediction[]): void {
  process.stdout.write(`\n${label} (${predictions.length.toLocaleString()} forecasts)\n`);
  process.stdout.write(
    `${'event'.padEnd(7)}${'Brier'.padStart(10)}${'log loss'.padStart(12)}` +
      `${'cal error'.padStart(12)}${'rate'.padStart(9)}${'mean p'.padStart(10)}\n`,
  );
  for (const event of ['boom', 'bust'] as const) {
    const result = metrics(predictions, event);
    const rate = predictions.reduce((sum, row) => sum + row[`${event}Actual`], 0) /
      Math.max(1, predictions.length);
    const meanProbability = predictions.reduce((sum, row) => sum + row[event], 0) /
      Math.max(1, predictions.length);
    process.stdout.write(
      `${event.padEnd(7)}${result.brier.toFixed(4).padStart(10)}` +
        `${result.logLoss.toFixed(4).padStart(12)}` +
        `${(result.calibrationError * 100).toFixed(2).padStart(11)}%` +
        `${(rate * 100).toFixed(1).padStart(8)}%` +
        `${(meanProbability * 100).toFixed(1).padStart(9)}%\n`,
    );
  }
}

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

  const scoringModel = compileScoring(league.scoringSettings, league.scoringOverrides);
  const score = createScorer(scoringModel);
  const playersById = new Map(playersFile.players.map((player) => [player.playerId, player]));
  const maxWeek = Math.max(
    ...Object.values(history.logs).flatMap((weeks) => Object.keys(weeks).map(Number)),
  );
  const priorGames = Math.max(1, maxWeek - 1);
  const rows: Row[] = [];
  const weekStats = new Map<number, Record<string, StatLine>>();
  const weekOpponents = new Map<number, Record<string, string>>();
  const weekTeams = new Map<number, Record<string, string>>();

  for (let week = 1; week <= maxWeek; week++) {
    weekStats.set(week, {});
    weekOpponents.set(week, {});
    weekTeams.set(week, {});
  }

  for (const [pid, weeks] of Object.entries(history.logs)) {
    const player = playersById.get(pid);
    const group = player?.group;
    const seasonProjection = playersFile.seasonProjectionPrior[pid];
    if (!group || !seasonProjection) continue;
    const projection = score(seasonProjection, group) / priorGames;
    if (projection < 1) continue;

    for (const [rawWeek, line] of Object.entries(weeks)) {
      const week = Number(rawWeek);
      const game = history.games?.[pid]?.[rawWeek];
      const actual = score(line, group);
      const played = hasPlayed(line);
      rows.push({
        pid,
        group,
        projection,
        actual,
        played,
        week,
        team: game?.team ?? '',
        opponent: game?.opp ?? '',
      });
      weekStats.get(week)![pid] = line;
      if (game) {
        weekTeams.get(week)![pid] = game.team;
        weekOpponents.get(week)![pid] = game.opp;
      }
    }
  }

  const pregameMatchups = buildPregameMatchupIndexes(
    { scoringModel, playersById, weekStats, weekOpponents, weekTeams },
    maxWeek,
  );
  const variants = new Map<string, Prediction[]>([
    ['current', []],
    ['projection-conditioned availability', []],
    ['projection-tier distributions', []],
    ['both candidates', []],
  ]);

  for (const cutoff of [6, 9, 12, 15]) {
    const train = rows.filter((row) => row.week <= cutoff);
    const test = rows.filter((row) => row.week > cutoff && row.week <= cutoff + 3);
    const model = fitModel(train, playersById, scoringModel);
    const tierFits = fitTiers(train, playersById, scoringModel);
    const playFits = new Map<PositionGroup, PlayFit>();
    for (const group of POSITION_GROUPS) {
      const groupRows = train.filter((row) => row.group === group);
      if (groupRows.length) playFits.set(group, fitPlayRate(groupRows));
    }

    for (const row of test) {
      const groupFit = model.byGroup.get(row.group);
      if (!groupFit) continue;
      const conditionalFit = playFits.get(row.group);
      const tier = tierFits.get(row.group);
      const tierFit = tier?.fits[tierOf(row.projection, tier.cuts)] ?? groupFit;
      const currentPlay = playerPlayRate(model, groupFit, row.pid, groupFit.playRate);
      const conditionalBase = conditionalFit
        ? predictedPlayRate(conditionalFit, row.projection)
        : groupFit.playRate;
      const conditionalPlay = playerPlayRate(model, groupFit, row.pid, conditionalBase);
      const matchupFactor = pregameMatchups.get(row.week)?.projectionFactor(
        row.group,
        row.opponent,
      ) ?? 1;
      const labels = {
        group: row.group,
        boomActual: Number(row.actual >= row.projection * DEFAULT_BOOM_BUST.boomPct),
        bustActual: Number(row.actual <= row.projection * DEFAULT_BOOM_BUST.bustPct),
      };

      variants.get('current')!.push({
        ...labels,
        ...probability(groupFit, row, currentPlay, matchupFactor),
      });
      variants.get('projection-conditioned availability')!.push({
        ...labels,
        ...probability(groupFit, row, conditionalPlay, matchupFactor),
      });
      variants.get('projection-tier distributions')!.push({
        ...labels,
        ...probability(tierFit, row, currentPlay, matchupFactor),
      });
      variants.get('both candidates')!.push({
        ...labels,
        ...probability(tierFit, row, conditionalPlay, matchupFactor),
      });
    }
  }

  process.stdout.write(
    `${history.season} rolling origin: fit through weeks 6/9/12/15, score the next three\n`,
  );
  for (const [label, predictions] of variants) printMetrics(label, predictions);

  process.stdout.write('\ncurrent model by position\n');
  const current = variants.get('current')!;
  for (const group of POSITION_GROUPS) {
    printMetrics(group, current.filter((row) => row.group === group));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
