/**
 * Which league a script run is about, and where its files live.
 *
 * Every Node script used to hardcode `public/data` and `history`. With more
 * than one league those two directories cannot mean one thing any more, so
 * each league gets its own subtree and this module is the single place that
 * decides which one a given run is pointed at:
 *
 *   npm run snapshot                    # every league
 *   npm run snapshot -- --league uk-bg  # just that one
 *   ESPN_LEAGUE=uk-bg npm run verify    # the fits and checks, one league
 *
 * The default is the first configured league rather than "all", because the
 * fits and the verifiers are single-league by nature — each one reads a
 * scoring table and produces a model for it. Only the snapshot loops.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findLeague, LEAGUES, type LeagueConfig } from '../src/lib/leagues';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `--league <key>` or `--league=<key>` from argv, else `ESPN_LEAGUE`, else null. */
function requestedKey(): string | null {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--league' && argv[i + 1]) return argv[i + 1];
    const inline = /^--league=(.+)$/.exec(argv[i]);
    if (inline) return inline[1];
  }
  return process.env.ESPN_LEAGUE || null;
}

/**
 * Fails loudly on an unknown key instead of quietly doing the default league.
 *
 * A typo in `--league` that fell back to the default would refit the wrong
 * league's model and report success, which is the kind of thing nobody catches
 * until the numbers look strange weeks later.
 */
function resolve(key: string | null): LeagueConfig {
  if (!key) return LEAGUES[0];
  const league = findLeague(key);
  if (!league) {
    throw new Error(
      `Unknown league "${key}". Configured: ${LEAGUES.map((l) => l.key).join(', ')}.`,
    );
  }
  return league;
}

/** The league this run is about. */
export function activeLeague(): LeagueConfig {
  return resolve(requestedKey());
}

/** Every league to pull: the named one, or all of them. */
export function requestedLeagues(): LeagueConfig[] {
  const key = requestedKey();
  return key ? [resolve(key)] : [...LEAGUES];
}

/** `public/data/<key>` — what the browser fetches. */
export function dataDir(league: LeagueConfig): string {
  return join(ROOT, 'public', 'data', league.key);
}

/**
 * `history/<key>` — the raw finished seasons, gitignored and Node-only.
 *
 * Per league, and this is worth stating because the obvious optimisation is
 * wrong. These seasons are pulled from ESPN's standard-scoring template league,
 * an endpoint that takes no league id, so it is tempting to hold one shared
 * copy and save pulling eight megabytes per league. `snapshot.ts` then compacts
 * every line down to the keys the *pulling* league scores — 46 for one of these
 * leagues, 50 for the other — so the file that lands is filtered by whoever
 * wrote it. Sharing it silently drops the stat keys the other league scores and
 * nothing fails; the fits just quietly measure the wrong thing. It was tried,
 * and `fit:priors` caught it only because a drift check happened to be looking.
 */
export function historyDir(league: LeagueConfig): string {
  return join(ROOT, 'history', league.key);
}

/** Trailing-slash URLs, for the scripts that read through `new URL(...)`. */
export function dataUrl(league: LeagueConfig): URL {
  return new URL(`../public/data/${league.key}/`, import.meta.url);
}

export function historyUrl(league: LeagueConfig): URL {
  return new URL(`../history/${league.key}/`, import.meta.url);
}
