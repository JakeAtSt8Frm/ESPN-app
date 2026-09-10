/**
 * Exercise the headline Value Score through the same snapshot loader the UI uses.
 *
 * The check that matters most here is that the headline stays *normalized within
 * each position*. A cross-position points scale passes almost every other test
 * in this file — it is proportional, monotone in value, and correctly ordered —
 * while being unusable as a ranking, because everyone below a position's
 * startable cliff is worth nothing to a lineup. Measured on the shipped
 * snapshot it put 130 players at exactly zero and the second-best quarterback
 * alive at 261. So the per-position leader and median are asserted directly.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadLeague } from '../src/data/league';
import { enrichPlayer, freeAgents } from '../src/data/selectors';
import { POSITION_GROUPS, type PositionGroup } from '../src/lib/types';
import { requestedLeagues, ROOT } from './league-paths';

let failures = 0;
function check(label: string, ok: boolean): void {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}\n`);
  if (!ok) failures++;
}

// Only the file transport is substituted. Scoring, replacement, model fits,
// normalization and the displayed player selector are the production code.
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { baseURI: pathToFileURL(`${ROOT}/public/`).href },
});
globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== 'file:') throw new Error(`Unexpected snapshot URL: ${url}`);
  return new Response(await readFile(url, 'utf8'), { status: 200 });
};

const median = (sorted: number[]) => sorted[Math.floor(sorted.length / 2)] ?? 0;

try {
  for (const league of requestedLeagues()) {
    const data = await loadLeague(league.key);
    const headline = [...data.combinedScores.values()];
    process.stdout.write(`\n${league.key} — ${headline.length} rated of ${data.playersById.size}\n`);

    const byGroup = new Map<PositionGroup, number[]>();
    for (const [pid, score] of data.combinedScores) {
      const group = data.playersById.get(pid)?.group;
      if (!group) continue;
      byGroup.set(group, [...(byGroup.get(group) ?? []), score]);
    }
    for (const scores of byGroup.values()) scores.sort((a, b) => b - a);
    const pools = [...byGroup.entries()].filter(([, scores]) => scores.length >= 10);

    check('every headline score is an integer inside 0–1000',
      headline.every((s) => Number.isInteger(s) && s >= 0 && s <= 1000));

    // The regression this file exists for.
    check('every position is rated on its own scale — each pool has a leader at 900+',
      pools.every(([, scores]) => scores[0] >= 900));
    check('and a median near the middle of the range, not crushed against zero',
      pools.every(([, scores]) => median(scores) >= 350 && median(scores) <= 650));
    check('so the best player at any position is comparable to the best at any other',
      Math.max(...pools.map(([, s]) => s[0])) - Math.min(...pools.map(([, s]) => s[0])) <= 100);
    check('no rated player is scored zero — a rating is a rank, not a lineup surplus',
      headline.every((s) => s > 0));

    check('the headline averages the two within-position ratings where both exist',
      [...data.combinedScores].every(([pid, score]) => {
        const inSeason = data.valueIndex.byPlayer.get(pid)?.score ?? null;
        const rest = data.seasonValueIndex.byPlayer.get(pid)?.score ?? null;
        if (inSeason !== null && rest !== null) return score === Math.round((inSeason + rest) / 2);
        return score === (inSeason ?? rest);
      }));

    check('a player with neither production nor a projection is unrated, not scored from priors',
      [...data.playersById.keys()].every((pid) => {
        const inSeason = data.valueIndex.byPlayer.get(pid)?.score ?? null;
        const ros = data.seasonValueIndex.byPlayer.get(pid)?.breakdown.restOfSeasonPoints ?? null;
        return (inSeason !== null || ros !== null) === data.combinedScores.has(pid);
      }));
    check('every displayed player row shows exactly the headline score',
      [...data.playersById.keys()].every((pid) =>
        enrichPlayer(data, pid, data.liveWeek, '', false).valueScore ===
        (data.combinedScores.get(pid) ?? null)));

    // The separate cross-position scale, which trades and Analytics add up.
    const cross = [...data.leagueValueScores.values()];
    check('the cross-position scale is proportional, with the league leader at 1000',
      Math.max(...cross) === 1000 && cross.every((s) => Number.isInteger(s) && s >= 0 && s <= 1000) &&
      [...data.leagueValueScores].every(([pid, s]) =>
        s === Math.round((data.tradeValues.byPlayer.get(pid)?.index ?? 0) * 10)));
    check('it abstains wherever there is no remaining projection',
      [...data.tradeValues.byPlayer].every(([pid, value]) =>
        value.unprojected !== data.leagueValueScores.has(pid)));
    check('more value above replacement never produces a lower cross-position score',
      [...data.tradeValues.byPlayer.values()].filter((v) => !v.unprojected)
        .sort((a, b) => a.points - b.points).every((value, i, sorted) => i === 0 ||
          value.points === sorted[i - 1].points ||
          (data.leagueValueScores.get(value.pid) ?? -1) >= (data.leagueValueScores.get(sorted[i - 1].pid) ?? -1)));

    const points = (pid: string) => data.tradeValues.byPlayer.get(pid)?.points ?? 0;
    check('free agents rank on trade points, so the best kicker cannot head the pool',
      freeAgents(data, 'ALL').every((p, i, sorted) => i === 0 || points(p.pid) <= points(sorted[i - 1].pid)));
    check('starter demand accounts for every lineup seat', Math.abs(
      [...data.tradeValues.startingDepthByGroup.values()].reduce((sum, d) => sum + d, 0) -
      data.league.size * data.starterSlots.length) < 1e-9);

    process.stdout.write('  Position | Rated | Value Score: leader / median / low | Cross-position leader\n');
    for (const group of POSITION_GROUPS) {
      const scores = byGroup.get(group) ?? [];
      const best = [...data.tradeValues.byPlayer.values()]
        .filter((v) => v.group === group && !v.unprojected).sort((a, b) => b.points - a.points)[0];
      process.stdout.write(`  ${group} | ${scores.length} | ${scores[0] ?? '—'} / ${median(scores) || '—'} / ${scores[scores.length - 1] ?? '—'} | ${best ? `${data.playersById.get(best.pid)?.name} ${data.leagueValueScores.get(best.pid)}` : '—'}\n`);
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
}

process.stdout.write(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
if (failures) process.exitCode = 1;
