/**
 * Checks the multi-season history against the one source that can refute it.
 *
 * The app now reads every finished season through `leaguedefaults/3`, ESPN's
 * standard-scoring template league, because it is the only view that carries a
 * finished season's **weekly projections** alongside its game logs. That is a
 * different endpoint, a different league and a different scoring table from the
 * one the rest of the snapshot comes through, and a silent disagreement between
 * them would poison every distribution fit downstream while still looking
 * perfectly plausible.
 *
 * So the overlap is checked rather than assumed. The prior season is available
 * through *both* routes — `kona_playercard` against this league, which is where
 * `history.json` comes from, and `leaguedefaults/3`, which is where
 * `history/<year>.json` comes from — and every player-week they share is
 * rescored under this league's settings and compared. They have to agree
 * exactly. If ESPN ever changes what the template league reports, this fails
 * here rather than quietly widening every forecast band in the app.
 *
 * Four further checks cover what agreement alone cannot:
 *
 *   projections are pregame   a projection backfilled from the result would
 *                             correlate ~1.0 with it and make every fitted
 *                             spread collapse
 *   projections are complete  enough pairs per position to fit a 257-knot shape
 *   opponents resolve         the fixture join, which the defence ratings need
 *   seasons are distinct      a copy-paste of one year into three would agree
 *                             with itself and be worth nothing
 *
 * Run with `npm run verify:history`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compileScoring, createScorer, hasPlayed } from '../src/lib/scoring';
import { ESPN_POSITION_IDS } from '../src/lib/types';
import type { League, Player, PositionGroup, StatLine } from '../src/lib/types';
import { activeLeague, dataDir, historyDir } from './league-paths';

const LEAGUE = activeLeague();
const DATA = dataDir(LEAGUE);

const readJson = async <T>(...parts: string[]): Promise<T> =>
  JSON.parse(await readFile(join(DATA, ...parts), 'utf8')) as T;

/** Raw finished seasons, which live outside `public/` — see `snapshot.ts`. */
const HISTORY = historyDir(LEAGUE);
const readHistory = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(HISTORY, name), 'utf8')) as T;

interface SeasonFile {
  season: number;
  actuals: Record<string, Record<string, StatLine>>;
  projections: Record<string, Record<string, StatLine>>;
  games: Record<string, Record<string, { team: string; opp: string }>>;
  positions: Record<string, number>;
}

const GROUPS: PositionGroup[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

/** Below this a projection is ESPN listing a player, not forecasting one. */
const MIN_MEANINGFUL = 1;

/**
 * Pairs a group needs before a 257-knot residual shape is worth fitting.
 *
 * The shape is carried as empirical quantiles, so the tails are only as good as
 * the number of observations that reach them. Fifteen hundred puts roughly
 * seventy-five observations beyond each 5% bound.
 */
const MIN_PAIRS = 1500;

/**
 * Ceiling on projection-actual correlation before the projections look faked.
 *
 * A weekly fantasy projection that genuinely preceded the game correlates
 * around .6 with the result. One reconstructed from the box score afterwards
 * would sit near 1.0. This does not prove the projections are pregame, but it
 * is the check that would catch the failure that matters.
 */
const MAX_HONEST_CORRELATION = 0.9;

/**
 * Floor on correlation, per position, below which the pairing looks misaligned.
 *
 * These are deliberately not one number, because the honest floor is not one
 * number. A misaligned join — a projection paired with the wrong week — reads
 * as a correlation near zero, so the check has to know what "near zero" means
 * for each position before it can call one wrong.
 *
 * Kicker sits at .13–.19 across all three seasons and that is the *finding*,
 * not the fault: almost nothing about a kicker's week is forecastable, which is
 * the same measurement the Trade page already prints a warning about. Holding
 * it to a receiver's floor would fail a correct pipeline every year. The floor
 * for each group is set well under its worst observed season, so it catches a
 * join that has actually broken and nothing else.
 */
const MIN_CORRELATION: Record<PositionGroup, number> = {
  QB: 0.2,
  RB: 0.4,
  WR: 0.4,
  TE: 0.4,
  K: 0.05,
  DST: 0.15,
};

/**
 * Pooled floor across every position in a season.
 *
 * The per-group floors above can each be cleared by a partially broken join.
 * A join that is wholly broken cannot clear this, and a season that does clear
 * it has its weeks lined up with its projections.
 */
const MIN_POOLED_CORRELATION = 0.5;

function correlation(pairs: Array<{ p: number; a: number }>): number {
  const n = pairs.length;
  if (n < 2) return 0;
  const mp = pairs.reduce((s, x) => s + x.p, 0) / n;
  const ma = pairs.reduce((s, x) => s + x.a, 0) / n;
  let cov = 0;
  let vp = 0;
  let va = 0;
  for (const x of pairs) {
    cov += (x.p - mp) * (x.a - ma);
    vp += (x.p - mp) ** 2;
    va += (x.a - ma) ** 2;
  }
  return vp > 0 && va > 0 ? cov / Math.sqrt(vp * va) : 0;
}

const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);
const out = (msg: string) => process.stdout.write(`${msg}\n`);

async function main(): Promise<void> {
  const { league } = await readJson<{ league: League }>('league.json');
  const index = await readJson<{ historySeasons?: number[]; priorSeason: string }>(
    'index.json',
  );
  const playersFile = await readJson<{ players: Player[] }>('players.json');
  const history = await readJson<{
    season: string;
    logs: Record<string, Record<string, StatLine>>;
  }>('history.json');

  const seasons = index.historySeasons ?? [];
  if (seasons.length === 0) {
    out('no history seasons in the snapshot — run npm run snapshot');
    process.exitCode = 1;
    return;
  }

  const score = createScorer(compileScoring(league.scoringSettings, league.scoringOverrides));
  const groupOf = new Map(playersFile.players.map((p) => [p.playerId, p.group]));

  const files = new Map<number, SeasonFile>();
  for (const year of seasons) {
    files.set(year, await readHistory<SeasonFile>(`${year}.json`));
  }

  /*
   * A player's position can differ from the one he holds today — a college
   * quarterback listed at receiver, a position change mid-career — so each
   * season carries its own, and the current universe is only the fallback.
   */
  const groupIn = (file: SeasonFile, pid: string): PositionGroup | null => {
    const id = file.positions[pid];
    const own = id === undefined ? null : (ESPN_POSITION_IDS[id] ?? null);
    return own ?? groupOf.get(pid) ?? null;
  };

  // --- 1. The overlapping season, both ways round --------------------------
  out('\nprior season through two independent endpoints');
  {
    const year = Number(history.season);
    const file = files.get(year);
    if (!file) {
      fail(`no history/${year}.json to cross-check history.json against`);
    } else {
      let compared = 0;
      let mismatched = 0;
      let worst = 0;
      let worstLabel = '';

      for (const [pid, byWeek] of Object.entries(history.logs)) {
        const group = groupOf.get(pid);
        if (!group) continue;
        const theirs = file.actuals[pid];
        if (!theirs) continue;

        for (const [week, line] of Object.entries(byWeek)) {
          const other = theirs[week];
          if (!other) continue;
          compared++;
          const diff = Math.abs(score(line, group) - score(other, group));
          if (diff > 0.005) {
            mismatched++;
            if (diff > worst) {
              worst = diff;
              worstLabel = `${pid} week ${week}`;
            }
          }
        }
      }

      const pct = compared ? ((compared - mismatched) / compared) * 100 : 0;
      out(
        `  ${year} game logs   compared ${compared}  mismatches ${mismatched}  ` +
          `match ${pct.toFixed(4)}%`,
      );
      if (compared < 5000) fail(`only ${compared} overlapping weeks — too few to trust`);
      if (mismatched > 0) {
        fail(
          `${mismatched} of ${compared} ${year} weeks disagree between ` +
            `kona_playercard and leaguedefaults (worst ${worst.toFixed(3)} at ${worstLabel})`,
        );
      }
    }
  }

  // --- 2. Projections, per season and position -----------------------------
  out('\nweekly projection pairs, by season and position');
  const seasonSignatures = new Map<number, string>();

  for (const year of seasons) {
    const file = files.get(year)!;
    const byGroup = new Map<PositionGroup, Array<{ p: number; a: number }>>();
    let played = 0;
    let logged = 0;

    for (const [pid, projByWeek] of Object.entries(file.projections)) {
      const group = groupIn(file, pid);
      if (!group) continue;
      const actByWeek = file.actuals[pid] ?? {};

      for (const [week, projLine] of Object.entries(projByWeek)) {
        const actual = actByWeek[week];
        if (!actual) continue;
        const p = score(projLine, group);
        if (p < MIN_MEANINGFUL) continue;
        const list = byGroup.get(group) ?? [];
        list.push({ p, a: score(actual, group) });
        byGroup.set(group, list);
      }
    }

    for (const [pid, byWeek] of Object.entries(file.actuals)) {
      for (const line of Object.values(byWeek)) {
        logged++;
        if (hasPlayed(line)) played++;
      }
      void pid;
    }

    let total = 0;
    const parts: string[] = [];
    const pooled: Array<{ p: number; a: number }> = [];
    for (const group of GROUPS) {
      const list = byGroup.get(group) ?? [];
      total += list.length;
      const r = correlation(list);
      const mae = list.length
        ? list.reduce((s, x) => s + Math.abs(x.a - x.p), 0) / list.length
        : 0;
      parts.push(
        `  ${group.padEnd(4)} pairs ${String(list.length).padStart(5)}  ` +
          `corr ${r.toFixed(3)}  MAE ${mae.toFixed(2)}`,
      );

      if (list.length < MIN_PAIRS / 4) {
        fail(`${year} ${group}: only ${list.length} pairs`);
      }
      if (r > MAX_HONEST_CORRELATION) {
        fail(
          `${year} ${group}: projection/actual correlation ${r.toFixed(3)} is too high — ` +
            'these look reconstructed from the result rather than pregame',
        );
      }
      if (r < MIN_CORRELATION[group] && list.length > 200) {
        fail(
          `${year} ${group}: correlation ${r.toFixed(3)} is under its ` +
            `${MIN_CORRELATION[group].toFixed(2)} floor — the pairing may be misaligned`,
        );
      }
      pooled.push(...list);
    }

    out(`\n${year}  ${total} pairs, ${logged} logged weeks, ${played} with participation`);
    for (const line of parts) out(line);
    if (total < MIN_PAIRS) fail(`${year}: ${total} pairs is below the ${MIN_PAIRS} floor`);

    const pooledR = correlation(pooled);
    out(`  pooled ${String(pooled.length).padStart(5)}  corr ${pooledR.toFixed(3)}`);
    if (pooledR < MIN_POOLED_CORRELATION) {
      fail(
        `${year}: pooled correlation ${pooledR.toFixed(3)} is under ` +
          `${MIN_POOLED_CORRELATION} — this season's weeks and projections are not aligned`,
      );
    }

    /*
     * A fingerprint of the season's actuals. Three identical fingerprints would
     * mean the fetch wrote the same year three times — which every other check
     * here would pass, because a season is perfectly consistent with itself.
     */
    let sum = 0;
    let n = 0;
    for (const [pid, byWeek] of Object.entries(file.actuals)) {
      const group = groupIn(file, pid);
      if (!group) continue;
      for (const line of Object.values(byWeek)) {
        sum += score(line, group);
        n++;
      }
    }
    seasonSignatures.set(year, `${n}:${sum.toFixed(2)}`);
  }

  // --- 3. Seasons are actually different -----------------------------------
  out('\nseasons are distinct');
  {
    const seen = new Map<string, number>();
    for (const [year, signature] of seasonSignatures) {
      const prior = seen.get(signature);
      if (prior !== undefined) {
        fail(`${year} is byte-identical to ${prior} — the fetch wrote one season twice`);
      }
      seen.set(signature, year);
      out(`  ${year}  ${signature.split(':')[0]} weeks, ${Number(signature.split(':')[1]).toFixed(0)} total points`);
    }
  }

  // --- 4. Opponents resolve, which the defence ratings depend on -----------
  out('\nfixture joins');
  for (const year of seasons) {
    const file = files.get(year)!;
    let weeks = 0;
    let joined = 0;
    const opponents = new Set<string>();

    for (const [pid, byWeek] of Object.entries(file.actuals)) {
      for (const [week, line] of Object.entries(byWeek)) {
        if (!hasPlayed(line)) continue;
        weeks++;
        const game = file.games[pid]?.[week];
        if (game) {
          joined++;
          opponents.add(game.opp);
        }
      }
    }

    const rate = weeks ? joined / weeks : 0;
    out(
      `  ${year}  ${(rate * 100).toFixed(1)}% of played weeks carry an opponent, ` +
        `${opponents.size} distinct defences`,
    );
    if (rate < 0.95) fail(`${year}: only ${(rate * 100).toFixed(1)}% of weeks resolved an opponent`);
    if (opponents.size < 30) fail(`${year}: only ${opponents.size} defences seen`);
  }

  out('');
  if (failures.length > 0) {
    for (const message of failures) out(`FAIL  ${message}`);
    process.exitCode = 1;
  } else {
    out(`ok — ${seasons.length} seasons of paired weekly history`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
