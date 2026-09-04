/**
 * Prints every configured league key, space separated.
 *
 * Exists so CI can loop over the leagues without duplicating the list into the
 * workflow — the ids and keys live in `src/lib/leagues.ts`, and adding a league
 * should be one edit there rather than one there and one in YAML.
 *
 *   for league in $(npm run --silent leagues); do ... done
 */

import { LEAGUES } from '../src/lib/leagues';

process.stdout.write(`${LEAGUES.map((league) => league.key).join(' ')}\n`);
