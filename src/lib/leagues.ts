/**
 * The leagues this app can show, and the only place their ids live.
 *
 * Imported by both halves of the project, which is why it sits in `lib/`
 * alongside `espn.ts` rather than in `scripts/` or `data/`. The Node scripts
 * read it to know what to pull and where to write it; the browser reads it to
 * know what to offer in the switcher and which directory to fetch from.
 *
 * There is no credential here and there never should be. Every league below is
 * read with the same `ESPN_SWID`/`ESPN_S2` pair, because they are leagues the
 * same ESPN account belongs to — one login, several leagues, which is the
 * normal shape of this. A league belonging to a *different* account would need
 * its own cookie pair and a per-league credential lookup; that is deliberately
 * not built until something actually needs it.
 */

export interface LeagueConfig {
  /**
   * Directory name under `public/data/` and `history/`, and the value persisted
   * in localStorage. Stable forever once shipped: changing it silently orphans
   * every cached payload and every reader's saved choice.
   */
  key: string;
  /** Short label for the switcher. The full ESPN name is shown once loaded. */
  name: string;
  leagueId: string;
}

/**
 * Order matters: the first entry is what a first-time visitor opens on, and
 * what every Node script defaults to when no league is named.
 */
export const LEAGUES: readonly LeagueConfig[] = [
  { key: 'uk-bg', name: 'UK-BG', leagueId: '390483100' },
  { key: 'oj-invitational', name: 'O.J. Invitational', leagueId: '1159035309' },
] as const;

export const DEFAULT_LEAGUE_KEY = LEAGUES[0].key;

/**
 * Resolves a key to its league, or null.
 *
 * Null rather than a throw or a silent fallback because every caller has a
 * different right answer: the client falls back to the default when a saved key
 * no longer exists, and the refresh endpoint rejects the request outright. That
 * endpoint is the reason this returns null at all — it is the validation step
 * that keeps a caller-supplied string from ever reaching a spawned process.
 */
export function findLeague(key: string | null | undefined): LeagueConfig | null {
  if (!key) return null;
  return LEAGUES.find((league) => league.key === key) ?? null;
}

/** The named league, or the default. Never throws — used on the render path. */
export function leagueOrDefault(key: string | null | undefined): LeagueConfig {
  return findLeague(key) ?? LEAGUES[0];
}
