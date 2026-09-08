/** Rolling season holdouts using recorded weekly projections, never prorated season totals. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildWeekForecast, fitResidualModel, type PriorPair } from '../src/lib/forecast';
import {
  FORECAST_REPORT_VERSION,
  forecastScoringKey,
  type ForecastReport,
  type ForecastReportRow,
} from '../src/lib/forecast-report';
import { reshapeSeason, weeklyPairs, type RawSeasonFile } from '../src/lib/history';
import { compileScoring } from '../src/lib/scoring';
import type { League, Player, PositionGroup, StatLine } from '../src/lib/types';
import { activeLeague, dataDir, historyDir } from './league-paths';

const leagueConfig = activeLeague();
const directory = dataDir(leagueConfig);
const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')) as {
  historySeasons: number[];
};
const { league } = JSON.parse(await readFile(join(directory, 'league.json'), 'utf8')) as {
  league: League;
};
const { players } = JSON.parse(await readFile(join(directory, 'players.json'), 'utf8')) as {
  players: Player[];
};
const scoring = compileScoring(league.scoringSettings, league.scoringOverrides);
const years = [...new Set(index.historySeasons)].sort((a, b) => a - b);
if (years.length < 2)
  throw new Error('Forecast validation needs at least two complete historical seasons');
const pairsByYear = new Map(
  await Promise.all(
    years.map(async (year) => {
      const raw = JSON.parse(
        await readFile(join(historyDir(leagueConfig), `${year}.json`), 'utf8'),
      ) as RawSeasonFile;
      if (raw.season !== year) throw new Error(`History season mismatch for ${year}`);
      return [year, weeklyPairs(reshapeSeason(raw), scoring)] as const;
    }),
  ),
);

// The pairs have already been scored using this league's full rules. A single
// identity stat lets the production forecast builder read those exact points.
const identityScoring = compileScoring({ rush_att: 1 });
const byId = new Map(players.map((player) => [player.playerId, player]));
const accumulators = new Map<string, ForecastReportRow>();
const folds: ForecastReport['folds'] = [];
for (let i = 1; i < years.length; i++) {
  const training = years.slice(0, i);
  const testing = years[i];
  const priorPairs = new Map<PositionGroup, PriorPair[]>();
  for (const year of training) {
    for (const pair of pairsByYear.get(year) ?? []) {
      const group = priorPairs.get(pair.group) ?? [];
      // Keep NFL team-week correlations inside a single season.
      group.push({ ...pair, week: pair.season * 100 + pair.week });
      priorPairs.set(pair.group, group);
    }
  }
  const model = fitResidualModel({
    scoringModel: identityScoring,
    playersById: byId,
    weekStats: new Map(),
    weekProjections: new Map(),
    throughWeek: 0,
    priorPairs,
  });
  folds.push({ training, testing });
  for (const pair of pairsByYear.get(testing) ?? []) {
    if (!priorPairs.has(pair.group)) continue;
    const fallback: Player = {
      playerId: pair.pid,
      name: pair.pid,
      firstName: '',
      lastName: '',
      group: pair.group,
      team: pair.team,
      proTeamId: 0,
      eligibleSlots: [],
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
    const player = { ...(byId.get(pair.pid) ?? fallback), group: pair.group };
    const projections: Record<string, StatLine> = { [pair.pid]: { rush_att: pair.projection } };
    const forecast = buildWeekForecast({
      model,
      scoringModel: identityScoring,
      playersById: new Map([[pair.pid, player]]),
      projections,
    }).get(pair.pid);
    if (!forecast) continue;
    for (const group of ['ALL', pair.group] as const) {
      const row = accumulators.get(group) ?? {
        group,
        samples: 0,
        modelMae: 0,
        espnMae: 0,
        coverage80: 0,
      };
      row.samples++;
      row.modelMae += Math.abs(pair.actual - forecast.median);
      row.espnMae += Math.abs(pair.actual - pair.projection);
      row.coverage80 += Number(pair.actual >= forecast.p10 && pair.actual <= forecast.p90);
      accumulators.set(group, row);
    }
  }
}
const rows = [...accumulators.values()].map((row) => ({
  ...row,
  modelMae: row.modelMae / row.samples,
  espnMae: row.espnMae / row.samples,
  coverage80: row.coverage80 / row.samples,
}));
if (rows.length === 0) throw new Error('No recorded weekly pairs were available for validation');
const report: ForecastReport = {
  version: FORECAST_REPORT_VERSION,
  scoringKey: forecastScoringKey(league),
  folds,
  rows,
};
await writeFile(join(directory, 'forecast-report.json'), `${JSON.stringify(report, null, 2)}\n`);
for (const row of rows)
  process.stdout.write(
    `${leagueConfig.key} ${row.group}: n=${row.samples}, model MAE ${row.modelMae.toFixed(2)}, ESPN MAE ${row.espnMae.toFixed(2)}, 80% coverage ${(row.coverage80 * 100).toFixed(1)}%\n`,
  );
