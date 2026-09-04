/**
 * Validates the stat-id table against evidence outside the scoring identity.
 *
 * This is the check `verify-scoring.ts` cannot be. That one recomputes
 * `Σ settings[key] × stats[key]` and compares it to ESPN's own total — but both
 * of its factors are keyed through `STAT_IDS`, so **any consistent permutation
 * of the table cancels out and it still reports 100%**. Four D/ST ids were
 * mislabelled for a long time and it never registered.
 *
 * A label is only worth anything if something could refute it. Two things can:
 *
 *  - **Arithmetic against another reported field.** The yards-allowed ladder is
 *    a set of mutually exclusive flags sitting on the same stat line as the
 *    raw yardage they describe, so every game either agrees or does not. The
 *    kicking distance buckets are the same idea: they partition every field
 *    goal made, so they have to sum to the total on the same line.
 *
 *  - **Frequency and range.** A key called `def_sack` that fires in half a
 *    defence's games at 0.7 a time is not sacks, whatever the arithmetic says.
 *    NFL rates are stable enough between seasons to bracket every counting
 *    stat this league scores.
 *
 * These bounds are deliberately wide. The point is to catch a renumbering or a
 * mislabel, not to assert that 2025 rates repeat.
 */

import { readFileSync } from 'node:fs';
import { compileScoring, createScorer } from '../src/lib/scoring';
import type { League, Player, StatLine } from '../src/lib/types';
import { activeLeague, dataUrl } from './league-paths';

const ROOT = dataUrl(activeLeague());
const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, ROOT), 'utf8')) as T;

const leagueFile = read<{ league: League }>('league.json');
const playersFile = read<{ players: Player[] }>('players.json');
const history = read<{
  logs: Record<string, Record<string, StatLine>>;
  games: Record<string, Record<string, { team: string; opp: string }>>;
}>('history.json');

const scoringModel = compileScoring(
  leagueFile.league.scoringSettings,
  leagueFile.league.scoringOverrides,
);
const score = createScorer(scoringModel);
const playersById = new Map(playersFile.players.map((p) => [p.playerId, p]));

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures++;
}

// ---- D/ST game logs, the population every check below runs over -------------

interface Log {
  pid: string;
  week: number;
  team: string;
  opp: string;
  line: StatLine;
}

const dstIds = new Set(
  playersFile.players.filter((p) => p.group === 'DST').map((p) => p.playerId),
);
const dstLogs: Log[] = [];
for (const [pid, weeks] of Object.entries(history.logs)) {
  if (!dstIds.has(pid)) continue;
  for (const [week, line] of Object.entries(weeks)) {
    if (!Object.keys(line).length) continue;
    const game = history.games[pid]?.[week];
    dstLogs.push({
      pid,
      week: Number(week),
      team: game?.team ?? '',
      opp: game?.opp ?? '',
      line,
    });
  }
}

const n = (line: StatLine, key: string): number => {
  const v = line[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

process.stdout.write(`\nD/ST rate bounds  (${dstLogs.length} game logs)\n`);

/**
 * Per-game mean and how often the stat appears at all.
 *
 * Both matter, and they fail differently: a mislabel that swaps two rare events
 * moves the rate, one that swaps a rare event for a common one moves presence.
 */
function rate(key: string): { mean: number; present: number } {
  let sum = 0;
  let seen = 0;
  for (const log of dstLogs) {
    const v = n(log.line, key);
    sum += v;
    if (v > 0) seen++;
  }
  return { mean: sum / dstLogs.length, present: seen / dstLogs.length };
}

/** NFL per-team-game rates, bracketed generously. */
const BOUNDS: Array<[string, number, number, number, number]> = [
  // key,                meanLo, meanHi, presentLo, presentHi
  ['def_sack', 1.6, 3.4, 0.7, 0.98],
  ['def_int', 0.4, 1.1, 0.32, 0.68],
  ['def_fum_rec', 0.25, 0.85, 0.22, 0.55],
  ['def_blk_kick', 0.01, 0.2, 0.01, 0.2],
  ['def_safe', 0.002, 0.07, 0.002, 0.07],
];

for (const [key, lo, hi, plo, phi] of BOUNDS) {
  const r = rate(key);
  check(
    key.padEnd(14),
    r.mean >= lo && r.mean <= hi && r.present >= plo && r.present <= phi,
    `${r.mean.toFixed(2)}/game in ${(r.present * 100).toFixed(0)}% of games ` +
      `(expect ${lo}-${hi} in ${(plo * 100).toFixed(0)}-${(phi * 100).toFixed(0)}%)`,
  );
}

// ---- Yards allowed: the flags must agree with the yardage beside them -------

process.stdout.write('\nyards-allowed ladder against def_yds_allowed\n');

const YA: Array<[string, number, number]> = [
  ['def_ya_0_99', 0, 99],
  ['def_ya_100_199', 100, 199],
  ['def_ya_200_299', 200, 299],
  ['def_ya_300_349', 300, 349],
  ['def_ya_350_399', 350, 399],
  ['def_ya_400_449', 400, 449],
  ['def_ya_450_499', 450, 499],
  ['def_ya_500_549', 500, 549],
  ['def_ya_550p', 550, Infinity],
];

let yaOk = 0;
let yaBad = 0;
const yaExamples: string[] = [];
for (const log of dstLogs) {
  const yards = log.line.def_yds_allowed;
  if (typeof yards !== 'number') continue;
  const fired = YA.filter(([key]) => n(log.line, key) > 0);

  if (fired.length === 0) {
    /*
     * A bucket this league scores at zero is never returned by ESPN, so no flag
     * is the right answer whenever the yardage falls in an unscored band.
     */
    const scored = YA.filter(([key]) => (leagueFile.league.scoringOverrides?.DST?.[key] ?? 0) !== 0);
    const inScoredBand = scored.some(([, lo, hi]) => yards >= lo && yards <= hi);
    if (inScoredBand) {
      yaBad++;
      if (yaExamples.length < 4) yaExamples.push(`${yards} yds, no flag`);
    } else yaOk++;
    continue;
  }
  if (fired.length > 1) {
    yaBad++;
    if (yaExamples.length < 4) yaExamples.push(`${yards} yds, ${fired.length} flags`);
    continue;
  }
  const [key, lo, hi] = fired[0];
  if (yards >= lo && yards <= hi) yaOk++;
  else {
    yaBad++;
    if (yaExamples.length < 4) yaExamples.push(`${yards} yds flagged ${key}`);
  }
}
check(
  'every flag matches the yardage on its own line',
  yaBad === 0,
  `${yaOk} agree, ${yaBad} disagree${yaExamples.length ? ` — ${yaExamples.join('; ')}` : ''}`,
);

// ---- Points allowed: reconstructed from the opposing offence ----------------

process.stdout.write('\npoints-allowed ladder against reconstructed scoring\n');

/*
 * Points scored by each (week, NFL team), rebuilt from its own players' lines.
 * Passing touchdowns are deliberately excluded: they are the same play as the
 * receiving touchdown already counted, and adding both would double every one.
 */
const scored = new Map<string, number>();
for (const [pid, weeks] of Object.entries(history.logs)) {
  const games = history.games[pid] ?? {};
  for (const [week, line] of Object.entries(weeks)) {
    const team = games[week]?.team;
    if (!team) continue;
    const points =
      (n(line, 'rush_td') + n(line, 'rec_td') + n(line, 'fum_rec_td')) * 6 +
      n(line, 'xpm') +
      // `fgm` is the total on the line; the distance buckets are a partition of
      // it and the weekly payload does not carry all of them, so use the total.
      n(line, 'fgm') * 3 +
      (n(line, 'rush_2pt') + n(line, 'rec_2pt')) * 2 +
      (n(line, 'def_int_td') +
        n(line, 'def_fum_ret_td') +
        n(line, 'def_st_td') +
        n(line, 'def_blk_kick_ret_td') +
        n(line, 'def_blk_kick_td')) *
        6 +
      n(line, 'def_safe') * 2;
    const key = `${week}:${team}`;
    scored.set(key, (scored.get(key) ?? 0) + points);
  }
}

const PA: Array<[string, number, number]> = [
  ['def_pa_0', 0, 0],
  ['def_pa_1_6', 1, 6],
  ['def_pa_7_13', 7, 13],
  ['def_pa_14_17', 14, 17],
  ['def_pa_28_34', 28, 34],
  ['def_pa_35_45', 35, 45],
  ['def_pa_46p', 46, Infinity],
];

/*
 * A two-point tolerance, because the reconstruction cannot see everything: a
 * defensive two-point return, or a score by a player who never appears in this
 * league's universe, lands outside it. The mislabel this catches shifted a
 * whole bucket — seven points and more — so the tolerance costs nothing.
 */
const TOLERANCE = 2;

for (const [key, lo, hi] of PA) {
  const observed: number[] = [];
  for (const log of dstLogs) {
    if (n(log.line, key) <= 0) continue;
    const pa = scored.get(`${log.week}:${log.opp}`);
    if (pa !== undefined) observed.push(pa);
  }
  if (!observed.length) {
    check(key.padEnd(14), true, 'never flagged in this season');
    continue;
  }
  observed.sort((a, b) => a - b);
  const median = observed[observed.length >> 1];
  const p10 = observed[Math.floor(observed.length * 0.1)];
  const p90 = observed[Math.floor(observed.length * 0.9)];
  check(
    key.padEnd(14),
    p10 >= lo - TOLERANCE && p90 <= hi + TOLERANCE,
    `n=${observed.length} median ${median}, 10th-90th ${p10}-${p90} (expect ${lo}-${
      hi === Infinity ? '∞' : hi
    })`,
  );
}

// ---- Kicking: the distance ladder against the totals beside it -------------

/*
 * The weekly logs cannot answer this — the snapshot keeps only the keys that
 * score, and attempts by distance are not among them. Season totals are, and
 * they carry the invariant that matters: the four distance buckets are a
 * partition of every field goal made, so they have to sum to `fgm`.
 */

process.stdout.write('\nkicking distance buckets, against season totals\n');

const seasonPrior = read<{ seasonActualPrior: Record<string, StatLine> }>(
  'players.json',
).seasonActualPrior;

let kickChecked = 0;
let kickBad = 0;
const kickExamples: string[] = [];
const bucketTotals = { short: 0, mid: 0, long: 0, xlong: 0 };

for (const [pid, line] of Object.entries(seasonPrior ?? {})) {
  if (playersById.get(pid)?.group !== 'K') continue;
  const total = n(line, 'fgm');
  if (total <= 0) continue;

  const short = n(line, 'fgm_0_39');
  const mid = n(line, 'fgm_40_49');
  const long = n(line, 'fgm_50_59');
  const xlong = n(line, 'fgm_60p');

  kickChecked++;
  bucketTotals.short += short;
  bucketTotals.mid += mid;
  bucketTotals.long += long;
  bucketTotals.xlong += xlong;

  if (short + mid + long + xlong !== total) {
    kickBad++;
    if (kickExamples.length < 3) {
      kickExamples.push(
        `${playersById.get(pid)?.name}: ${short}+${mid}+${long}+${xlong} != ${total}`,
      );
    }
  }
}

check(
  'the four distance buckets partition every field goal made',
  kickChecked > 0 && kickBad === 0,
  `${kickChecked} kickers, ${kickBad} disagree${
    kickExamples.length ? ` — ${kickExamples.join('; ')}` : ''
  }`,
);

/*
 * And they are the right way round, which is the mistake this block exists to
 * prevent. ESPN orders its coarse buckets longest-first, so a table that reads
 * them in the obvious order labels the 50+ bucket as 0-39 — and every kicker in
 * the league scores wrong while still looking plausible. Kickers attempt and
 * make far more short field goals than long ones, so if the labels were
 * reversed the "0-39" bucket would be the smallest rather than the largest.
 */
check(
  'makes fall away with distance, so the buckets are not reversed',
  bucketTotals.short > bucketTotals.mid &&
    bucketTotals.mid > bucketTotals.long &&
    bucketTotals.long > bucketTotals.xlong,
  `0-39 ${bucketTotals.short}, 40-49 ${bucketTotals.mid}, ` +
    `50-59 ${bucketTotals.long}, 60+ ${bucketTotals.xlong}`,
);

// ---- Every scored key has to actually appear ---------------------------------

process.stdout.write('\ncoverage\n');

const dstScored = Object.entries(leagueFile.league.scoringOverrides?.DST ?? {})
  .filter(([, v]) => v !== 0)
  .map(([k]) => k);
const numeric = dstScored.filter((k) => /^\d+$/.test(k));
check(
  'no D/ST scoring key is an unmapped numeric id',
  numeric.length === 0,
  numeric.length ? numeric.join(', ') : `${dstScored.length} keys, all named`,
);

const offenceKeys = Object.entries(leagueFile.league.scoringSettings ?? {})
  .filter(([, v]) => v !== 0)
  .map(([k]) => k)
  .filter((k) => /^\d+$/.test(k));
check(
  'no base scoring key is an unmapped numeric id',
  offenceKeys.length === 0,
  offenceKeys.length ? offenceKeys.join(', ') : 'all named',
);

/*
 * A key the league pays for that never once appears is either a genuinely rare
 * event or a dead id. Reported rather than failed — a one-point safety really
 * can go a season without happening.
 */
const neverSeen = dstScored.filter((key) => !dstLogs.some((log) => n(log.line, key) > 0));
process.stdout.write(
  `  note  scored D/ST keys never observed in ${dstLogs.length} games: ` +
    `${neverSeen.length ? neverSeen.join(', ') : 'none'}\n`,
);

// Sanity: the scorer still agrees with itself on a known line.
const anyDst = dstLogs.find((log) => n(log.line, 'def_sack') > 0);
if (anyDst) {
  check(
    'a D/ST line still scores through the override',
    Number.isFinite(score(anyDst.line, 'DST')),
    `${score(anyDst.line, 'DST')} pts`,
  );
}

process.stdout.write(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
