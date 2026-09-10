/** Exercise the headline scale through the same snapshot loader the UI uses. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadLeague } from '../src/data/league';
import { enrichPlayer, freeAgents } from '../src/data/selectors';
import { POSITION_GROUPS } from '../src/lib/types';
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

try {
  for (const league of requestedLeagues()) {
    const data = await loadLeague(league.key);
    const projected = [...data.tradeValues.byPlayer.values()].filter((value) => !value.unprojected);
    const unprojected = [...data.tradeValues.byPlayer.values()].filter((value) => value.unprojected);
    process.stdout.write(`\n${league.key} — ${projected.length} projected, ${unprojected.length} unprojected\n`);
    check('headline values use the same proportional scale at every position', projected.every((value) =>
      data.combinedScores.get(value.pid) === Math.round(value.index * 10)));
    check('the league leader is 1000 and every score stays within 0–1000',
      Math.max(...data.combinedScores.values()) === 1000 &&
      [...data.combinedScores.values()].every((score) => Number.isInteger(score) && score >= 0 && score <= 1000));
    check('missing projections are unavailable, including in player rows', unprojected.every((value) =>
      !data.combinedScores.has(value.pid) &&
      enrichPlayer(data, value.pid, data.liveWeek, '', false).valueScore === null));
    check('positional ratings also abstain without production or projections', unprojected.every((value) =>
      data.valueIndex.byPlayer.has(value.pid) || !data.positionScores.has(value.pid)));
    check('all displayed player values agree with the headline scale', projected.every((value) =>
      enrichPlayer(data, value.pid, data.liveWeek, '', false).valueScore === data.combinedScores.get(value.pid)));
    check('free-agent ordering never reverses displayed values when rounded points tie',
      freeAgents(data, 'ALL').every((player, i, sorted) => i === 0 ||
        (player.valueScore ?? -1) <= (sorted[i - 1].valueScore ?? -1)));
    check('more value above replacement never produces a lower headline score',
      [...projected].sort((a, b) => a.points - b.points).every((value, i, sorted) => i === 0 ||
        value.points === sorted[i - 1].points ||
        (data.combinedScores.get(value.pid) ?? -1) >= (data.combinedScores.get(sorted[i - 1].pid) ?? -1)));
    check('starter demand accounts for every lineup seat', Math.abs(
      [...data.tradeValues.startingDepthByGroup.values()].reduce((sum, depth) => sum + depth, 0) -
      data.league.size * data.starterSlots.length) < 1e-9);
    process.stdout.write('  Position | Players | Starter depth | Replacement/game | Leader | Value\n');
    for (const group of POSITION_GROUPS) {
      const rows = projected.filter((value) => value.group === group).sort((a, b) => b.points - a.points);
      const best = rows[0];
      process.stdout.write(`  ${group} | ${rows.length} | ${data.tradeValues.startingDepthByGroup.get(group)?.toFixed(2)} | ${data.tradeValues.replacementPerWeek.get(group)?.toFixed(2)} | ${best ? data.playersById.get(best.pid)?.name : '—'} | ${best ? data.combinedScores.get(best.pid) : '—'}\n`);
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
}

process.stdout.write(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
if (failures) process.exitCode = 1;
