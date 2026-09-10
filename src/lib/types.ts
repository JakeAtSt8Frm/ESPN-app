/**
 * Core domain types.
 *
 * Stat lines are kept as open records keyed by the readable names in
 * `espn-stats.ts` rather than ESPN's numeric ids, so scoring settings, real
 * stat lines and projections all speak the same language and ESPN adding an id
 * next season doesn't break the shape.
 */

/** A raw stat line: stat key -> value. Keys match `ScoringSettings` keys. */
export type StatLine = Record<string, number | undefined>;

/** League scoring: stat key -> points multiplier. */
export type ScoringSettings = Record<string, number>;

/**
 * Position groups used for ranking and comparison.
 *
 * Every valuation in the app is a percentile *within* one of these, which is
 * what makes a kicker's score and a receiver's score readable on one scale.
 */
export type PositionGroup = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST';

export const POSITION_GROUPS: PositionGroup[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

/** ESPN `defaultPositionId` -> position group. */
export const ESPN_POSITION_IDS: Record<number, PositionGroup> = {
  1: 'QB',
  2: 'RB',
  3: 'WR',
  4: 'TE',
  5: 'K',
  16: 'DST',
};

/**
 * ESPN lineup slot id -> the label the app shows.
 *
 * Only the slots this league uses are named; the rest exist because ESPN's
 * numbering is global across every format it supports.
 */
export const LINEUP_SLOTS: Record<number, string> = {
  0: 'QB',
  2: 'RB',
  4: 'WR',
  6: 'TE',
  16: 'D/ST',
  17: 'K',
  20: 'BN',
  21: 'IR',
  23: 'FLEX',
};

/** Which position groups each lineup slot will accept. */
export const SLOT_ELIGIBILITY: Record<string, PositionGroup[]> = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  'D/ST': ['DST'],
  K: ['K'],
  FLEX: ['RB', 'WR', 'TE'],
};

export interface League {
  leagueId: string;
  name: string;
  season: string;
  size: number;
  /** Ordered starting slots, one entry per slot: ['QB','RB','RB','WR',...]. */
  rosterSlots: string[];
  benchSlots: number;
  irSlots: number;
  scoringSettings: ScoringSettings;
  /**
   * Overrides that apply only to one position group, keyed group -> key ->
   * multiplier. ESPN expresses D/ST scoring this way.
   */
  scoringOverrides: Partial<Record<PositionGroup, ScoringSettings>>;
  regularSeasonWeeks: number;
  playoffTeams: number;
  playoffSeedingRule: string;
  currentWeek: number;
  /** Highest week with completed games. 0 before the season starts. */
  latestCompletedWeek: number;
  finalWeek: number;
  draftType: string;
  scoringType: string;
}

export interface Member {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
}

export interface Team {
  teamId: number;
  name: string;
  abbrev: string;
  owners: string[];
  ownerName: string;
  logo: string | null;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  standing: number;
  playoffSeed: number;
  /** Player ids currently rostered. */
  players: string[];
  /** Player id -> lineup slot label as currently set. */
  slots: Record<string, string>;
  acquisitions: Record<string, { type: string; date: number }>;
  waiverRank: number;
  budgetRemaining: number;
}

export interface Player {
  playerId: string;
  name: string;
  firstName: string;
  lastName: string;
  group: PositionGroup | null;
  /** NFL team abbreviation, or null for free agents. */
  team: string | null;
  proTeamId: number;
  eligibleSlots: string[];
  injuryStatus: string | null;
  injured: boolean;
  active: boolean;
  /** Percent of ESPN leagues rostering this player. */
  percentOwned: number | null;
  percentStarted: number | null;
  /** ESPN's live draft market, the app's only external price signal. */
  averageDraftPosition: number | null;
  auctionValueAverage: number | null;
  /** ESPN's positional rank under this league's scoring type. */
  positionalRank: number | null;
  seasonOutlook: string | null;
  byeWeek: number | null;
}

/** One matchup in the league schedule. */
export interface Matchup {
  week: number;
  matchupId: number;
  homeTeamId: number;
  awayTeamId: number | null;
  homeScore: number;
  awayScore: number;
  /** True once the week's games are all final. */
  complete: boolean;
  playoffTier: string | null;
}

/** Boom/bust classification for a single player-week. */
export type StatusLabel =
  | 'Major Boom'
  | 'Boom'
  | 'In Range'
  | 'Bust'
  | 'Major Bust'
  | 'Not Played'
  | 'No Proj';

export interface PlayerStatus {
  label: StatusLabel;
  /** CSS custom property name carrying this status's colour. */
  tone: string;
}

export interface RankInfo {
  group: PositionGroup;
  rank: number;
  outOf: number;
  value: number;
  /**
   * The season this rank was measured over.
   *
   * Carried on the rank rather than passed alongside it because before this
   * season has been played the chips report the last finished one, and a rank
   * that has travelled to a tooltip without its year is a number a reader will
   * assume is current. The two can never separate if they are the same object.
   */
  season: string;
}

/** Fully derived per-player-week view model used across every page. */
export interface EnrichedPlayer {
  pid: string;
  player: Player;
  name: string;
  team: string;
  group: PositionGroup | null;
  /** The roster slot this player occupies (QB, FLEX, BN, IR...). */
  slot: string;
  isStarter: boolean;
  /** ESPN's projection for the week, custom-scored. */
  proj: number;
  /** Custom-scored actual for the week. */
  act: number;
  hasPlayed: boolean;
  status: PlayerStatus;
  opponent: string | null;
  isOut: boolean;
  onBye: boolean;
  seasonTotal: number;
  /** Headline Value Score (0-1000). */
  valueScore: number | null;
  matchupScore: number | null;
  ppgRank: RankInfo | null;
  totalRank: RankInfo | null;
  boomRateRank: RankInfo | null;
  /**
   * The finished season the three ranks describe, or null when they are this
   * season's own.
   *
   * Set even when every rank is null, which is the case it exists for: a player
   * with no 2025 games shows three dashes, and the reader still needs to know
   * that the dashes are about 2025.
   */
  rankSeason: string | null;
}

/** NFL team id -> abbreviation. ESPN's own numbering, stable across seasons. */
export const PRO_TEAMS: Record<number, string> = {
  0: 'FA',
  1: 'ATL',
  2: 'BUF',
  3: 'CHI',
  4: 'CIN',
  5: 'CLE',
  6: 'DAL',
  7: 'DEN',
  8: 'DET',
  9: 'GB',
  10: 'TEN',
  11: 'IND',
  12: 'KC',
  13: 'LV',
  14: 'LAR',
  15: 'MIA',
  16: 'MIN',
  17: 'NE',
  18: 'NO',
  19: 'NYG',
  20: 'NYJ',
  21: 'PHI',
  22: 'ARI',
  23: 'PIT',
  24: 'LAC',
  25: 'SF',
  26: 'SEA',
  27: 'TB',
  28: 'WSH',
  29: 'CAR',
  30: 'JAX',
  33: 'BAL',
  34: 'HOU',
};
