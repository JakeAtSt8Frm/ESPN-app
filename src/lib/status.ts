/**
 * Boom/bust classification.
 *
 * A player is a boom at >=120% of projection and a bust at <=80%. The
 * "Major" variants add matchup context: beating a projection against a brutal
 * defence (matchup score < 30) is a genuinely different event from beating it
 * against a soft one, and busting against a soft defence (matchup score > 80)
 * is a worse signal than busting against a good one.
 */

import type { BoomBustConfig } from './value';
import { DEFAULT_BOOM_BUST } from './value';
import type { PlayerStatus, StatusLabel } from './types';

const TONES: Record<StatusLabel, string> = {
  'Major Boom': 'var(--tone-major-boom)',
  Boom: 'var(--tone-boom)',
  'In Range': 'var(--tone-mid)',
  Bust: 'var(--tone-bust)',
  'Major Bust': 'var(--tone-major-bust)',
  'Not Played': 'var(--tone-idle)',
  'No Proj': 'var(--tone-idle)',
};

/** Matchup score below which a boom is upgraded to a Major Boom. */
const HARD_MATCHUP = 30;
/** Matchup score above which a bust is downgraded to a Major Bust. */
const SOFT_MATCHUP = 80;

export function classifyStatus(
  projected: number,
  actual: number,
  played: boolean,
  matchupScore: number | null,
  config: BoomBustConfig = DEFAULT_BOOM_BUST,
): PlayerStatus {
  const make = (label: StatusLabel): PlayerStatus => ({ label, tone: TONES[label] });

  if (!played) return make('Not Played');
  if (projected <= 0) return make('No Proj');

  const mu = matchupScore !== null && Number.isFinite(matchupScore) ? matchupScore : null;

  if (actual >= projected * config.boomPct) {
    return make(mu !== null && mu < HARD_MATCHUP ? 'Major Boom' : 'Boom');
  }

  if (actual <= projected * config.bustPct) {
    return make(mu !== null && mu > SOFT_MATCHUP ? 'Major Bust' : 'Bust');
  }

  return make('In Range');
}

export const STATUS_ORDER: StatusLabel[] = [
  'Major Boom',
  'Boom',
  'In Range',
  'Bust',
  'Major Bust',
];

export type StatusCounts = Record<StatusLabel, number>;

export function emptyStatusCounts(): StatusCounts {
  return {
    'Major Boom': 0,
    Boom: 0,
    'In Range': 0,
    Bust: 0,
    'Major Bust': 0,
    'Not Played': 0,
    'No Proj': 0,
  };
}

export function statusTone(label: StatusLabel): string {
  return TONES[label];
}
