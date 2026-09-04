/**
 * Image URLs for players and NFL teams.
 *
 * ESPN's CDN is public and unauthenticated, so these are the one class of
 * request the browser still makes to espn.com — images, with no cookies and no
 * league data attached. Every one has a fallback chain ending in "hide it",
 * because a broken image is worse than none.
 */

const CDN = 'https://a.espncdn.com/i';

/** A player's headshot. Team defences have no headshot; callers get the logo. */
export function playerHeadshot(playerId: string, team?: string | null): string | null {
  // D/ST entities carry a negative id, which has no headshot behind it.
  if (Number(playerId) < 0) return team ? teamLogo(team) : null;
  return `${CDN}/headshots/nfl/players/full/${playerId}.png`;
}

/** An NFL team's logo, by abbreviation. */
export function teamLogo(team: string | null | undefined): string | null {
  if (!team || team === 'FA') return null;
  return `${CDN}/teamlogos/nfl/500/${team.toLowerCase()}.png`;
}
