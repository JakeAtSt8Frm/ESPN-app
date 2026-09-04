/**
 * ESPN Fantasy API client and normalisers.
 *
 * Two things about this API shape the whole app.
 *
 * **It is private and cookie-only.** This league is not public, and ESPN
 * accepts no other credential — a query-string `SWID`/`espn_s2` pair is
 * rejected outright. ESPN does reflect `Origin` and set
 * `Access-Control-Allow-Credentials: true`, so a browser request *would* be
 * allowed by CORS; what it would not survive is third-party cookie blocking,
 * which is on by default in Safari and arriving everywhere else. An app that
 * depended on the reader's own ESPN session would work on the developer's
 * machine and fail on half the league's phones.
 *
 * So the credentials live in `scripts/snapshot.ts`, which runs in Node with the
 * cookies in the environment and writes plain JSON into `public/data`. The
 * shipped bundle contains no key, no cookie and no ESPN request. Everything
 * below the fetch boundary is pure and isomorphic, so the same normalisers run
 * in the snapshot script and in the tests.
 *
 * **Nothing in it is self-describing.** Stats arrive as numeric ids, lineup
 * slots as numeric ids, positions as numeric ids, and pro teams as numeric ids,
 * with no accompanying dictionary. `espn-stats.ts` and `types.ts` carry those
 * tables; this file's job is to turn the payloads into the app's shapes.
 */

import { normalizeStatLine, STAT_IDS } from './espn-stats';
import {
  ESPN_POSITION_IDS,
  LINEUP_SLOTS,
  PRO_TEAMS,
  type League,
  type Matchup,
  type Member,
  type PositionGroup,
  type ScoringSettings,
  type StatLine,
  type Team,
  type Player,
} from './types';

export const ESPN_HOST = 'https://lm-api-reads.fantasy.espn.com';

export interface EspnCredentials {
  swid: string;
  espnS2: string;
}

export interface EspnRequest {
  season: number;
  leagueId: string;
  views: string[];
  scoringPeriodId?: number;
  filter?: unknown;
}

export function leagueUrl(req: EspnRequest): string {
  const params = new URLSearchParams();
  for (const view of req.views) params.append('view', view);
  if (req.scoringPeriodId !== undefined) {
    params.set('scoringPeriodId', String(req.scoringPeriodId));
  }
  return (
    `${ESPN_HOST}/apis/v3/games/ffl/seasons/${req.season}` +
    `/segments/0/leagues/${req.leagueId}?${params.toString()}`
  );
}

/**
 * One authenticated GET, with retry.
 *
 * ESPN rate-limits hard on Sunday afternoons, which is exactly when a refresh
 * is running. 429 and 5xx are retried with exponential backoff and jitter; a
 * 401 is not, because a stale `espn_s2` will never succeed and retrying it
 * three times only delays a clear error message.
 */
export async function espnFetch<T>(
  url: string,
  creds: EspnCredentials,
  options: { filter?: unknown; signal?: AbortSignal; retries?: number } = {},
): Promise<T> {
  const { filter, signal, retries = 3 } = options;

  const headers: Record<string, string> = {
    Cookie: `SWID=${creds.swid}; espn_s2=${creds.espnS2}`,
    Accept: 'application/json',
    // ESPN serves a different, smaller payload to clients it doesn't recognise.
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  };
  if (filter !== undefined) headers['X-Fantasy-Filter'] = JSON.stringify(filter);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal });

      if (res.ok) return (await res.json()) as T;

      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `ESPN rejected the credentials (${res.status}). The espn_s2 cookie ` +
            'expires every few months; refresh it from a logged-in browser.',
        );
      }
      // A 404 is a real answer — a week that doesn't exist yet, a season the
      // league didn't play. Retrying cannot change it.
      if (res.status === 404) throw new Error(`ESPN 404: ${url}`);
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`ESPN ${res.status}: ${url}`);
      }

      lastError = new Error(`ESPN ${res.status}`);
    } catch (err) {
      if (signal?.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      // Credential and 404 failures are final; only transport errors retry.
      if (message.includes('rejected the credentials') || message.includes('404')) throw err;
      lastError = err instanceof Error ? err : new Error(message);
    }

    if (attempt < retries) {
      const backoff = 400 * 2 ** attempt + Math.random() * 250;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw lastError ?? new Error(`ESPN request failed: ${url}`);
}

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

interface RawScoringItem {
  statId: number;
  points: number;
  pointsOverrides?: Record<string, number>;
  isReverseItem?: boolean;
}

/**
 * Splits ESPN's scoring items into a base table plus per-group overrides.
 *
 * `pointsOverrides` is keyed by lineup slot id, and every override this league
 * declares is on slot 16 — the D/ST slot. That is how ESPN expresses "these
 * same stat ids mean something else for a defence": id 93 is a blocked-kick
 * touchdown worth 6 either way, but ids 89-92 are the points-allowed ladder,
 * which is scored only in the D/ST slot and is meaningless for a running back.
 */
export function parseScoringSettings(items: RawScoringItem[]): {
  base: ScoringSettings;
  overrides: Partial<Record<PositionGroup, ScoringSettings>>;
} {
  const base: ScoringSettings = {};
  const dst: ScoringSettings = {};

  for (const item of items ?? []) {
    const key = STAT_IDS[item.statId] ?? String(item.statId);
    // A "reverse" item scores the inverse of the stat. None are declared here,
    // but silently dropping the flag would score such a league backwards.
    const sign = item.isReverseItem ? -1 : 1;

    base[key] = (item.points ?? 0) * sign;

    const override = item.pointsOverrides?.['16'];
    if (typeof override === 'number') dst[key] = override * sign;
  }

  return {
    base,
    overrides: Object.keys(dst).length > 0 ? { DST: dst } : {},
  };
}

interface RawLeague {
  id: number;
  seasonId: number;
  scoringPeriodId: number;
  status?: {
    currentMatchupPeriod?: number;
    latestScoringPeriod?: number;
    finalScoringPeriod?: number;
    firstScoringPeriod?: number;
  };
  settings: {
    name: string;
    size: number;
    rosterSettings: { lineupSlotCounts: Record<string, number> };
    scheduleSettings: {
      matchupPeriodCount: number;
      playoffTeamCount: number;
      playoffSeedingRule?: string;
    };
    scoringSettings: { scoringItems: RawScoringItem[]; scoringType?: string };
    draftSettings?: { type?: string };
  };
}

/** Turns the league settings payload into the app's `League`. */
export function parseLeague(raw: RawLeague, completedWeek: number): League {
  const counts = raw.settings.rosterSettings.lineupSlotCounts ?? {};

  // Starting slots, expanded one entry per slot and ordered the way a lineup
  // card reads rather than by ESPN's slot numbering.
  const ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];
  const rosterSlots: string[] = [];
  for (const label of ORDER) {
    const slotId = Object.entries(LINEUP_SLOTS).find(([, l]) => l === label)?.[0];
    const n = slotId ? (counts[slotId] ?? 0) : 0;
    for (let i = 0; i < n; i++) rosterSlots.push(label);
  }

  const scoring = parseScoringSettings(raw.settings.scoringSettings.scoringItems);

  return {
    leagueId: String(raw.id),
    name: raw.settings.name,
    season: String(raw.seasonId),
    size: raw.settings.size,
    rosterSlots,
    benchSlots: counts['20'] ?? 0,
    irSlots: counts['21'] ?? 0,
    scoringSettings: scoring.base,
    scoringOverrides: scoring.overrides,
    regularSeasonWeeks: raw.settings.scheduleSettings.matchupPeriodCount,
    playoffTeams: raw.settings.scheduleSettings.playoffTeamCount,
    playoffSeedingRule: raw.settings.scheduleSettings.playoffSeedingRule ?? 'TOTAL_POINTS_SCORED',
    currentWeek: raw.status?.currentMatchupPeriod ?? raw.scoringPeriodId ?? 1,
    latestCompletedWeek: completedWeek,
    finalWeek: raw.status?.finalScoringPeriod ?? 17,
    draftType: raw.settings.draftSettings?.type ?? 'SNAKE',
    scoringType: raw.settings.scoringSettings.scoringType ?? 'H2H_POINTS',
  };
}

interface RawMember {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

export function parseMembers(raw: RawMember[]): Member[] {
  return (raw ?? []).map((m) => ({
    id: m.id,
    displayName: m.displayName ?? '',
    firstName: m.firstName ?? '',
    lastName: m.lastName ?? '',
  }));
}

interface RawTeam {
  id: number;
  name?: string;
  location?: string;
  nickname?: string;
  abbrev?: string;
  logo?: string;
  owners?: string[];
  playoffSeed?: number;
  waiverRank?: number;
  record?: {
    overall?: { wins?: number; losses?: number; ties?: number; pointsFor?: number; pointsAgainst?: number };
  };
  transactionCounter?: { acquisitionBudgetSpent?: number };
  roster?: {
    entries?: Array<{
      playerId: number;
      lineupSlotId: number;
      acquisitionType?: string;
      acquisitionDate?: number;
    }>;
  };
}

export function parseTeams(raw: RawTeam[], members: Member[]): Team[] {
  const memberName = new Map(
    members.map((m) => [
      m.id,
      [m.firstName, m.lastName].filter(Boolean).join(' ').trim() || m.displayName,
    ]),
  );

  return (raw ?? []).map((t) => {
    const overall = t.record?.overall ?? {};
    const players: string[] = [];
    const slots: Record<string, string> = {};
    const acquisitions: Record<string, { type: string; date: number }> = {};

    for (const entry of t.roster?.entries ?? []) {
      const pid = String(entry.playerId);
      players.push(pid);
      slots[pid] = LINEUP_SLOTS[entry.lineupSlotId] ?? String(entry.lineupSlotId);
      acquisitions[pid] = {
        type: entry.acquisitionType ?? 'UNKNOWN',
        date: entry.acquisitionDate ?? 0,
      };
    }

    return {
      teamId: t.id,
      // ESPN moved team names from location+nickname to a single `name` field
      // and still returns both; joining the old pair is the fallback.
      name: t.name?.trim() || [t.location, t.nickname].filter(Boolean).join(' ').trim() || `Team ${t.id}`,
      abbrev: t.abbrev ?? String(t.id),
      owners: t.owners ?? [],
      ownerName: (t.owners ?? []).map((o) => memberName.get(o)).filter(Boolean).join(', ') || 'Unknown',
      logo: t.logo ?? null,
      wins: overall.wins ?? 0,
      losses: overall.losses ?? 0,
      ties: overall.ties ?? 0,
      pointsFor: overall.pointsFor ?? 0,
      pointsAgainst: overall.pointsAgainst ?? 0,
      standing: t.playoffSeed ?? 0,
      playoffSeed: t.playoffSeed ?? 0,
      players,
      slots,
      acquisitions,
      waiverRank: t.waiverRank ?? 0,
      budgetRemaining: 100 - (t.transactionCounter?.acquisitionBudgetSpent ?? 0),
    };
  });
}

interface RawMatchup {
  id: number;
  matchupPeriodId: number;
  playoffTierType?: string;
  winner?: string;
  home?: { teamId: number; totalPoints?: number };
  away?: { teamId: number; totalPoints?: number };
}

export function parseSchedule(raw: RawMatchup[]): Matchup[] {
  return (raw ?? [])
    .filter((m) => m.home)
    .map((m) => ({
      week: m.matchupPeriodId,
      matchupId: m.id,
      homeTeamId: m.home!.teamId,
      // A bye in an odd-sized bracket has no away side.
      awayTeamId: m.away?.teamId ?? null,
      homeScore: m.home?.totalPoints ?? 0,
      awayScore: m.away?.totalPoints ?? 0,
      complete: m.winner !== undefined && m.winner !== 'UNDECIDED',
      playoffTier:
        m.playoffTierType && m.playoffTierType !== 'NONE' ? m.playoffTierType : null,
    }));
}

interface RawPlayer {
  id: number;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  defaultPositionId?: number;
  proTeamId?: number;
  eligibleSlots?: number[];
  injuryStatus?: string;
  injured?: boolean;
  active?: boolean;
  seasonOutlook?: string;
  ownership?: {
    percentOwned?: number;
    percentStarted?: number;
    averageDraftPosition?: number;
    auctionValueAverage?: number;
  };
  rankings?: Record<string, Array<{ rank: number; rankType: string; slotId: number }>>;
  stats?: RawStatBlock[];
}

export interface RawStatBlock {
  id: string;
  seasonId: number;
  scoringPeriodId: number;
  statSourceId: number;
  statSplitTypeId: number;
  appliedTotal?: number;
  appliedAverage?: number;
  appliedStats?: Record<string, number>;
  stats?: Record<string, number>;
  externalId?: string;
  proTeamId?: number;
}

/** Turns one raw player into the app's `Player`, minus stats. */
export function parsePlayer(
  raw: RawPlayer,
  byeWeeks: Map<number, number>,
  rankType = 'PPR',
): Player {
  const group = ESPN_POSITION_IDS[raw.defaultPositionId ?? -1] ?? null;
  const proTeamId = raw.proTeamId ?? 0;

  // ESPN publishes several ranking sources per player; the one that matches the
  // league's scoring type is the only one worth showing.
  let positionalRank: number | null = null;
  for (const list of Object.values(raw.rankings ?? {})) {
    const hit = list.find((r) => r.rankType === rankType);
    if (hit) {
      positionalRank = hit.rank;
      break;
    }
  }

  return {
    playerId: String(raw.id),
    name: raw.fullName ?? [raw.firstName, raw.lastName].filter(Boolean).join(' '),
    firstName: raw.firstName ?? '',
    lastName: raw.lastName ?? '',
    group,
    team: proTeamId > 0 ? (PRO_TEAMS[proTeamId] ?? null) : null,
    proTeamId,
    eligibleSlots: (raw.eligibleSlots ?? [])
      .map((s) => LINEUP_SLOTS[s])
      .filter((s): s is string => Boolean(s)),
    injuryStatus: raw.injuryStatus ?? null,
    injured: raw.injured ?? false,
    active: raw.active ?? true,
    percentOwned: raw.ownership?.percentOwned ?? null,
    percentStarted: raw.ownership?.percentStarted ?? null,
    averageDraftPosition: raw.ownership?.averageDraftPosition ?? null,
    auctionValueAverage: raw.ownership?.auctionValueAverage ?? null,
    positionalRank,
    seasonOutlook: raw.seasonOutlook ?? null,
    byeWeek: byeWeeks.get(proTeamId) ?? null,
  };
}

/**
 * Picks stat blocks out of a player payload.
 *
 * ESPN packs actuals, projections, season totals and weekly splits into one
 * flat array distinguished only by `statSourceId` (0 actual, 1 projected) and
 * `statSplitTypeId` (0 season, 1 week). Weekly *actual* blocks are keyed by NFL
 * event id rather than by week, so `scoringPeriodId` is the only reliable way
 * to place them.
 */
export function selectStats(
  blocks: RawStatBlock[] | undefined,
  opts: { season: number; source: 0 | 1; split: 0 | 1; week?: number },
): RawStatBlock | null {
  for (const b of blocks ?? []) {
    if (b.seasonId !== opts.season) continue;
    if (b.statSourceId !== opts.source) continue;
    if (b.statSplitTypeId !== opts.split) continue;
    if (opts.week !== undefined && b.scoringPeriodId !== opts.week) continue;
    return b;
  }
  return null;
}

/** Normalises a stat block's raw id-keyed stats into keyed form. */
export function statLineOf(block: RawStatBlock | null | undefined): StatLine {
  return normalizeStatLine(block?.stats);
}
