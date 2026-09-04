/**
 * Measures how much a matchup actually moves a player's result, by position.
 *
 * `MATCHUP_INFLUENCE` in `src/lib/matchup.ts` decides which chips the app
 * presents with confidence and which it dims. That table has to be measured or
 * it is decoration, and this is what measures it.
 *
 * **The measurement.** For every prior-season player-week, take the shipped
 * `get()` rating for the defence he faced and the amount his score landed above
 * or below his own season mean, then take the Spearman rank correlation between
 * the two within each position group. A defence rating that carries information
 * should rank a player's good weeks above his bad ones.
 *
 * **Leakage.** The rating for week *w* is built only from weeks before *w*, so
 * a defence is never rated using the game it is being tested on. Without that
 * the correlation is a self-fulfilling measurement of the same points twice.
 *
 * **What this is not.** The app this is modelled on measures the chip against a
 * player's miss *against his projection*, which is the sharper instrument: a
 * projection already prices in the player's own form, so what is left is closer
 * to the matchup alone. That needs a historical weekly projection, and ESPN
 * publishes none for a season that has ended. Deviation from a player's own
 * season mean is the available stand-in and it is noisier in a specific
 * direction — a player's mean absorbs part of the schedule the chip is trying
 * to explain, which biases every correlation here *toward zero*. Read these as
 * a lower bound on influence, not an estimate of it.
 *
 * Run with `npm run research:matchup`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compileScoring, createScorer } from '../src/lib/scoring';
import { buildMatchupIndex } from '../src/lib/matchup';
import { POSITION_GROUPS, type League, type PositionGroup, type Player, type StatLine } from '../src/lib/types';
import { activeLeague, dataDir } from './league-paths';

const DATA = dataDir(activeLeague());

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(DATA, name), 'utf8')) as T;
}

/** Spearman rank correlation. Ties share their average rank. */
function spearman(pairs: Array<[number, number]>): number {
  if (pairs.length < 3) return 0;

  const rank = (values: number[]): number[] => {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const ranks = new Array<number>(values.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      const shared = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[order[k][1]] = shared;
      i = j + 1;
    }
    return ranks;
  };

  const xs = rank(pairs.map((p) => p[0]));
  const ys = rank(pairs.map((p) => p[1]));
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

async function main(): Promise<void> {
  const { league } = await readJson<{ league: League }>('league.json');
  const { players } = await readJson<{ players: Player[] }>('players.json');
  const history = await readJson<{
    season: string;
    logs: Record<string, Record<string, StatLine>>;
    games: Record<string, Record<string, { team: string; opp: string }>>;
  }>('history.json');

  const model = compileScoring(league.scoringSettings, league.scoringOverrides);
  const score = createScorer(model);
  const playersById = new Map(players.map((p) => [p.playerId, p]));

  // ---- Reshape the prior season into week-keyed maps ----------------------
  const weekStats = new Map<number, Record<string, StatLine>>();
  const weekOpponents = new Map<number, Record<string, string>>();
  const weekTeams = new Map<number, Record<string, string>>();
  let maxWeek = 0;

  for (const [pid, byWeek] of Object.entries(history.logs)) {
    for (const [rawWeek, line] of Object.entries(byWeek)) {
      const week = Number(rawWeek);
      maxWeek = Math.max(maxWeek, week);

      let stats = weekStats.get(week);
      if (!stats) weekStats.set(week, (stats = {}));
      stats[pid] = line;

      const game = history.games?.[pid]?.[rawWeek];
      if (!game) continue;

      let opps = weekOpponents.get(week);
      if (!opps) weekOpponents.set(week, (opps = {}));
      opps[pid] = game.opp;

      let teams = weekTeams.get(week);
      if (!teams) weekTeams.set(week, (teams = {}));
      teams[pid] = game.team;
    }
  }

  // ---- Each player's own season mean, over the weeks he recorded a line ---
  const playerMean = new Map<string, number>();
  for (const [pid, byWeek] of Object.entries(history.logs)) {
    const group = playersById.get(pid)?.group ?? null;
    const scores = Object.values(byWeek).map((line) => score(line, group));
    if (scores.length >= 4) {
      playerMean.set(pid, scores.reduce((s, v) => s + v, 0) / scores.length);
    }
  }

  // ---- Leakage-safe ratings: week w sees only weeks < w -------------------
  const pairsByGroup = new Map<PositionGroup, Array<[number, number]>>();
  for (const group of POSITION_GROUPS) pairsByGroup.set(group, []);

  // A rating needs a few weeks behind it before it says anything.
  const FIRST_TESTABLE_WEEK = 5;

  for (let week = FIRST_TESTABLE_WEEK; week <= maxWeek; week++) {
    const index = buildMatchupIndex({
      scoringModel: model,
      playersById,
      weekStats,
      weekOpponents,
      weekTeams,
      throughWeek: week - 1,
    });

    const stats = weekStats.get(week) ?? {};
    const opponents = weekOpponents.get(week) ?? {};

    for (const [pid, line] of Object.entries(stats)) {
      const group = playersById.get(pid)?.group;
      const mean = playerMean.get(pid);
      const opponent = opponents[pid];
      if (!group || mean === undefined || !opponent) continue;

      const rating = index.get(group, opponent);
      if (!rating) continue;

      pairsByGroup.get(group)!.push([rating.score, score(line, group) - mean]);
    }
  }

  // ---- Report -------------------------------------------------------------
  process.stdout.write(
    `matchup influence, ${history.season} holdout weeks ${FIRST_TESTABLE_WEEK}-${maxWeek}\n` +
      'rank correlation between the pregame defence rating and a player\'s\n' +
      'deviation from his own season mean.\n\n',
  );

  const results = POSITION_GROUPS.map((group) => {
    const pairs = pairsByGroup.get(group)!;
    return { group, n: pairs.length, rho: spearman(pairs) };
  }).sort((a, b) => b.rho - a.rho);

  const best = Math.max(...results.map((r) => r.rho), 0);

  process.stdout.write(
    `${'group'.padEnd(7)}${'n'.padStart(8)}${'rho'.padStart(10)}${'normalised'.padStart(12)}\n`,
  );
  for (const r of results) {
    const normalised = best > 0 ? Math.max(0, r.rho / best) : 0;
    process.stdout.write(
      `${r.group.padEnd(7)}${String(r.n).padStart(8)}${r.rho.toFixed(4).padStart(10)}` +
        `${normalised.toFixed(2).padStart(12)}\n`,
    );
  }

  process.stdout.write('\nMATCHUP_INFLUENCE, ready to paste into src/lib/matchup.ts:\n\n');
  process.stdout.write('export const MATCHUP_INFLUENCE: Record<PositionGroup, number> = {\n');
  for (const r of results) {
    const normalised = best > 0 ? Math.max(0, r.rho / best) : 0;
    process.stdout.write(`  ${r.group}: ${Number(normalised.toFixed(2))},\n`);
  }
  process.stdout.write('};\n');

  const finalIndex = buildMatchupIndex({
    scoringModel: model,
    playersById,
    weekStats,
    weekOpponents,
    weekTeams,
    throughWeek: maxWeek,
  });
  process.stdout.write('\nprojection factor range from the shipped historical baseline\n\n');
  process.stdout.write(
    `${'group'.padEnd(7)}${'tough'.padStart(10)}${'soft'.padStart(10)}${'defenses'.padStart(12)}\n`,
  );
  for (const group of POSITION_GROUPS) {
    const defenses = finalIndex.byGroup.get(group);
    const factors = defenses
      ? [...defenses.keys()].map((defense) => finalIndex.projectionFactor(group, defense))
      : [];
    const tough = factors.length ? Math.min(...factors) : 1;
    const soft = factors.length ? Math.max(...factors) : 1;
    process.stdout.write(
      `${group.padEnd(7)}${tough.toFixed(3).padStart(10)}${soft.toFixed(3).padStart(10)}` +
        `${String(factors.length).padStart(12)}\n`,
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
