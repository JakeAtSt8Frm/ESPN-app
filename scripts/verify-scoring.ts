/**
 * Checks the scoring engine against ESPN's own arithmetic.
 *
 * ESPN computes `appliedTotal` server-side using this league's real settings,
 * and publishes it alongside most stat blocks. The app never reads that number
 * — it recomputes every score from the raw stat line — which means the two can
 * be compared, and any disagreement is a bug in the stat id table, the scoring
 * compiler, or the D/ST override handling.
 *
 * Three independent populations are checked, because they fail differently:
 *
 *   prior-season totals   catches a wrong multiplier on a common stat
 *   prior-season weeks    catches ids that only appear in single games
 *   weekly projections    catches the projection path, which normalises a
 *                         different set of fields than a real game log
 *
 * Run with `npm run verify`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compileScoring, scoreStatLine } from '../src/lib/scoring';
import type { League, PositionGroup, Player, StatLine } from '../src/lib/types';
import { activeLeague, dataDir } from './league-paths';

const DATA = dataDir(activeLeague());

/** ESPN rounds its published totals; anything under a cent is display noise. */
const TOLERANCE = 0.005;

async function readJson<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(join(DATA, ...parts), 'utf8')) as T;
}

interface Case {
  pid: string;
  label: string;
  expected: number;
  actual: number;
}

function compare(
  cases: Case[],
  name: string,
): { name: string; total: number; mismatches: Case[] } {
  const mismatches = cases.filter((c) => Math.abs(c.expected - c.actual) > TOLERANCE);
  return { name, total: cases.length, mismatches };
}

async function main(): Promise<void> {
  const { league } = await readJson<{ league: League }>('league.json');
  const players = await readJson<{
    players: Player[];
    seasonActualPrior: Record<string, StatLine>;
    appliedTotals: Record<string, Record<string, number>>;
    priorSeason: string;
  }>('players.json');
  const history = await readJson<{
    logs: Record<string, Record<string, StatLine>>;
    applied: Record<string, Record<string, number>>;
  }>('history.json');
  const index = await readJson<{ weeks: number[] }>('index.json');

  const model = compileScoring(league.scoringSettings, league.scoringOverrides);
  const groupOf = new Map<string, PositionGroup | null>(
    players.players.map((p) => [p.playerId, p.group]),
  );
  const nameOf = new Map(players.players.map((p) => [p.playerId, p.name]));

  const results: Array<ReturnType<typeof compare>> = [];

  // --- Prior-season totals -------------------------------------------------
  {
    const cases: Case[] = [];
    for (const [pid, line] of Object.entries(players.seasonActualPrior)) {
      const expected = players.appliedTotals[pid]?.[`00${players.priorSeason}`];
      if (typeof expected !== 'number') continue;
      cases.push({
        pid,
        label: `${nameOf.get(pid) ?? pid} ${players.priorSeason} season`,
        expected,
        actual: scoreStatLine(model, line, groupOf.get(pid) ?? null),
      });
    }
    results.push(compare(cases, `${players.priorSeason} season totals`));
  }

  // --- Prior-season game logs ---------------------------------------------
  {
    const cases: Case[] = [];
    for (const [pid, weeks] of Object.entries(history.logs)) {
      for (const [week, line] of Object.entries(weeks)) {
        const expected = history.applied[pid]?.[week];
        if (typeof expected !== 'number') continue;
        cases.push({
          pid,
          label: `${nameOf.get(pid) ?? pid} wk ${week}`,
          expected,
          actual: scoreStatLine(model, line, groupOf.get(pid) ?? null),
        });
      }
    }
    results.push(compare(cases, `${players.priorSeason} game logs`));
  }

  // --- Weekly projections and actuals -------------------------------------
  {
    const projCases: Case[] = [];
    const actCases: Case[] = [];

    for (const week of index.weeks) {
      const payload = await readJson<{
        projections: Record<string, StatLine>;
        actuals: Record<string, StatLine>;
        appliedProjected: Record<string, number>;
        appliedActual: Record<string, number>;
      }>('weeks', `${week}.json`);

      for (const [pid, line] of Object.entries(payload.projections)) {
        const expected = payload.appliedProjected[pid];
        if (typeof expected !== 'number') continue;
        projCases.push({
          pid,
          label: `${nameOf.get(pid) ?? pid} wk ${week} proj`,
          expected,
          actual: scoreStatLine(model, line, groupOf.get(pid) ?? null),
        });
      }

      for (const [pid, line] of Object.entries(payload.actuals)) {
        const expected = payload.appliedActual[pid];
        if (typeof expected !== 'number') continue;
        actCases.push({
          pid,
          label: `${nameOf.get(pid) ?? pid} wk ${week}`,
          expected,
          actual: scoreStatLine(model, line, groupOf.get(pid) ?? null),
        });
      }
    }

    results.push(compare(projCases, `${league.season} weekly projections`));
    if (actCases.length > 0) {
      results.push(compare(actCases, `${league.season} weekly actuals`));
    }
  }

  // --- Report --------------------------------------------------------------
  let failed = false;
  let grandTotal = 0;
  let grandMismatch = 0;

  for (const r of results) {
    grandTotal += r.total;
    grandMismatch += r.mismatches.length;
    const rate = r.total ? ((1 - r.mismatches.length / r.total) * 100).toFixed(4) : '—';
    process.stdout.write(
      `${r.name.padEnd(28)} compared ${String(r.total).padStart(6)}  ` +
        `mismatches ${String(r.mismatches.length).padStart(5)}  match ${rate}%\n`,
    );

    for (const m of r.mismatches.slice(0, 8)) {
      failed = true;
      process.stdout.write(
        `    ${m.label}: espn ${m.expected.toFixed(2)} vs ours ${m.actual.toFixed(2)} ` +
          `(delta ${(m.actual - m.expected).toFixed(2)})\n`,
      );
    }
    if (r.mismatches.length > 8) {
      process.stdout.write(`    ...and ${r.mismatches.length - 8} more\n`);
      failed = true;
    }
  }

  process.stdout.write(
    `\n${'total'.padEnd(28)} compared ${String(grandTotal).padStart(6)}  ` +
      `mismatches ${String(grandMismatch).padStart(5)}  ` +
      `match ${grandTotal ? ((1 - grandMismatch / grandTotal) * 100).toFixed(4) : '—'}%\n`,
  );

  if (failed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
