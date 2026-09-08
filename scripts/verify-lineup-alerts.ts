/** Snapshot lineup flags must not carry today's injuries into past weeks.
 * Run with `npx tsx scripts/verify-lineup-alerts.ts`.
 */
import { lineupAlerts } from '../src/lib/lineup-alerts';

let failures = 0;
function check(label: string, ok: boolean): void {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}\n`);
  if (!ok) failures++;
}

const starter = {
  pid: 'rb',
  name: 'Running Back',
  slot: 'RB',
  hasPlayed: false,
  onBye: false,
  isOut: false,
  player: { injuryStatus: null as string | null },
};
const options = {
  starterSlots: ['RB', 'RB', 'FLEX'],
  starters: [starter],
  hasRoster: true,
  week: 5,
  liveWeek: 5,
};

const openings = lineupAlerts(options);
check('repeated starting slots keep their own vacancies',
  openings.length === 2 && openings.some((alert) => alert.kind === 'empty' && alert.slot === 'RB' && alert.count === 1));
check('a missing flex slot stays separate from a missing running back',
  openings.some((alert) => alert.kind === 'empty' && alert.slot === 'FLEX' && alert.count === 1));
check('a team without a roster has no actionable empty-slot alerts',
  lineupAlerts({ ...options, hasRoster: false, starters: [] }).length === 0);
check('a roster with everyone on the bench still has open starting slots',
  lineupAlerts({ ...options, starters: [] }).some((alert) => alert.kind === 'empty' && alert.slot === 'RB' && alert.count === 2));
check('slot matching ignores letter case',
  lineupAlerts({ ...options, starterSlots: ['rb'], starters: [starter] }).length === 0);

const out = { ...starter, isOut: true, player: { injuryStatus: 'OUT' } };
const questionable = { ...starter, pid: 'q', player: { injuryStatus: 'QUESTIONABLE' } };
const availableSlots = { ...options, starterSlots: ['RB'] };
check('current out and questionable starters are flagged',
  lineupAlerts({ ...options, starterSlots: ['RB', 'RB'], starters: [out, questionable] }).filter((alert) => alert.kind === 'player').length === 2);
check('today’s injuries do not rewrite an unplayed historical week',
  lineupAlerts({ ...availableSlots, starters: [out], week: 4 }).length === 0 &&
  lineupAlerts({ ...availableSlots, starters: [questionable], week: 4 }).length === 0);
check('a player with recorded results does not retain a current injury flag',
  lineupAlerts({ ...availableSlots, starters: [{ ...out, hasPlayed: true }] }).length === 0);
check('a scheduled bye is visible in a historical lineup',
  lineupAlerts({ ...availableSlots, starters: [{ ...starter, onBye: true }], week: 4 })[0]?.kind === 'player');
const overlapping = lineupAlerts({ ...availableSlots, starters: [{ ...out, onBye: true }] });
check('a bye and injury produce one clear player flag',
  overlapping.length === 1 && overlapping[0].kind === 'player' && overlapping[0].reason === 'Bye');

process.stdout.write(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`);
if (failures > 0) process.exitCode = 1;
