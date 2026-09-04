/**
 * A fingerprint of everything the offline fits actually read.
 *
 * The build refuses to ship a fitted model whose `generatedAt` disagrees with
 * the snapshot's, because a model fitted against different data than it ships
 * beside is worse than none. That rule is right and it has an awkward
 * consequence: pulling a fresh snapshot on a Sunday afternoon changes the stamp
 * on *every* file, including ones whose inputs did not move an inch. Three
 * finished seasons do not change because this week's scores came in.
 *
 * Restamping unconditionally would defeat the check. Refitting on every refresh
 * costs several minutes to reproduce a byte-identical model. So instead the fits
 * record a hash of their own inputs, and `restamp-fits.ts` moves a stamp forward
 * only when that hash still matches — which is a measurement rather than an
 * assumption about what a snapshot can change.
 *
 * What goes into it is deliberately narrow: the fits read the league's scoring
 * table, each player's position group, and the finished-season history. They do
 * not read this week's projections, rosters, injuries or ownership, all of which
 * move constantly and none of which can alter a fitted model.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { League, Player } from '../src/lib/types';
import { activeLeague, dataDir, historyDir } from './league-paths';

const LEAGUE = activeLeague();
const DATA = dataDir(LEAGUE);
const HISTORY = historyDir(LEAGUE);

export function fitInputsHash(): string {
  const hash = createHash('sha256');

  const { league } = JSON.parse(readFileSync(join(DATA, 'league.json'), 'utf8')) as {
    league: League;
  };
  // Sorted, so a reordered but identical scoring table hashes the same.
  hash.update(JSON.stringify(Object.entries(league.scoringSettings).sort()));
  hash.update(
    JSON.stringify(
      Object.entries(league.scoringOverrides ?? {})
        .sort()
        .map(([group, table]) => [group, Object.entries(table ?? {}).sort()]),
    ),
  );

  /*
   * The finished seasons, hashed by content. These are the bulk of what the
   * fits consume and the thing that genuinely cannot change mid-season — which
   * is what makes carrying a stamp forward safe rather than merely convenient.
   *
   * They carry no timestamp of their own for exactly this reason: see the note
   * where `snapshot.ts` writes them.
   */
  let files: string[] = [];
  try {
    files = readdirSync(HISTORY).filter((name) => name.endsWith('.json')).sort();
  } catch {
    /* no history yet — the hash then reflects a fit with none, which is true */
  }

  const withHistory = new Set<string>();
  for (const name of files) {
    hash.update(name);
    const raw = readFileSync(join(HISTORY, name));
    hash.update(raw);
    for (const pid of Object.keys(
      (JSON.parse(raw.toString()) as { actuals?: Record<string, unknown> }).actuals ?? {},
    )) {
      withHistory.add(pid);
    }
  }

  /*
   * Each player's position group — but only for players the finished seasons
   * actually contain.
   *
   * Hashing the whole universe would be wrong in a way that quietly defeats the
   * mechanism. ESPN's player list is sorted by current ownership and truncated,
   * so its tail churns between pulls as free agents trade places, and a hash
   * over all of it would report "the inputs changed" on every refresh whether
   * or not anything the fits read had moved. These are the players the fits
   * produce output for, and a genuine reclassification here — a receiver listed
   * at tight end, say — really does mean the fits need rerunning.
   */
  const { players } = JSON.parse(readFileSync(join(DATA, 'players.json'), 'utf8')) as {
    players: Player[];
  };
  hash.update(
    JSON.stringify(
      players
        .filter((p) => withHistory.has(p.playerId))
        .map((p) => `${p.playerId}:${p.group ?? ''}`)
        .sort(),
    ),
  );

  return hash.digest('hex').slice(0, 32);
}
