/**
 * Loads the static snapshot written by `scripts/snapshot.ts`.
 *
 * There is no ESPN API call here and no credential. GitHub Actions pulls ESPN
 * into `public/data/<league>`, and the deployed app reads those JSON files
 * directly.
 *
 * Every loader takes the league key first. Each league is a self-contained
 * snapshot — its own scoring table, its own fitted models — so there is no
 * shared payload to hoist out, and threading the key explicitly is what keeps
 * a switch mid-load from mixing two leagues' files into one `LeagueData`.
 *
 * Caching is content-addressed by the index's `generatedAt` stamp *and* keyed
 * by league. Both halves matter: the stamp means a new deployment invalidates
 * exactly what changed without any TTL guessing, and the league key means two
 * leagues cannot collide in the one IndexedDB store they share — without it,
 * `league.json` would be whichever league was loaded last.
 */

import { cached, TTL } from './cache';
import type { PriorResidualFit } from '../lib/forecast';
import type { MatchupEntry } from '../lib/matchup';
import type { ProjectionModel } from '../lib/projection';
import type { League, Matchup, Member, Player, Team } from '../lib/types';

/** Resolves against the deployed base path, so a project page works. */
function dataUrl(leagueKey: string, path: string): string {
  return new URL(`data/${leagueKey}/${path}`, document.baseURI).toString();
}

async function fetchJson<T>(
  leagueKey: string,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  // IndexedDB handles the large payload cache. Bypassing the HTTP cache here
  // ensures Reload sees the newest GitHub Pages deployment immediately.
  const res = await fetch(dataUrl(leagueKey, path), { signal, cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Snapshot ${leagueKey}/${path} unavailable (${res.status})`);
  }
  return (await res.json()) as T;
}

export interface SnapshotIndex {
  generatedAt: number;
  /** The league this directory holds. Absent on a snapshot taken before
   * the app supported more than one. */
  leagueKey?: string;
  leagueId?: string;
  season: string;
  priorSeason: string;
  leagueName: string;
  currentWeek: number;
  latestCompletedWeek: number;
  finalWeek: number;
  weeks: number[];
}

export interface DraftPick {
  pickNumber: number;
  round: number;
  roundPick: number;
  teamId: number;
  playerId: string;
  bidAmount: number;
  keeper: boolean;
  autoDraft: boolean;
}

export interface TransactionItem {
  playerId: string;
  type: string;
  fromTeamId: number;
  toTeamId: number;
}

export interface Transaction {
  id: string;
  type: string;
  status: string;
  teamId: number;
  date: number;
  scoringPeriodId: number;
  bidAmount: number;
  items: TransactionItem[];
}

export interface ProGame {
  opponent: string;
  home: boolean;
  kickoff: number;
  gameId: number;
}

export interface LeagueFile {
  generatedAt: number;
  season: string;
  league: League;
  members: Member[];
  teams: Team[];
  schedule: Matchup[];
  draft: DraftPick[];
  transactions: Transaction[];
  proSchedule: Record<string, Record<string, ProGame>>;
  byeWeeks: Record<string, number>;
}

export interface PlayersFile {
  generatedAt: number;
  players: Player[];
  seasonProjection: Record<string, Record<string, number>>;
  seasonActualPrior: Record<string, Record<string, number>>;
  seasonProjectionPrior: Record<string, Record<string, number>>;
  appliedTotals: Record<string, Record<string, number>>;
  priorSeason: string;
}

export interface WeekFile {
  generatedAt: number;
  week: number;
  projections: Record<string, Record<string, number>>;
  actuals: Record<string, Record<string, number>>;
  appliedProjected: Record<string, number>;
  appliedActual: Record<string, number>;
  /** teamId -> pid -> the slot that player occupied this week. */
  lineups: Record<string, Record<string, string>>;
}

export type { ProjectionModel };

/**
 * Everything fitted offline over finished seasons.
 *
 * Written by `npm run fit:priors` from the multi-season weekly history the
 * snapshot pulls, and loaded here as fitted objects rather than as the ~19,000
 * pairs behind them. The raw seasons stay in `history/` for the Node-side
 * scripts, outside `public/`, so they never reach a client.
 *
 * Optional throughout, because a snapshot taken before the fit has ever run is
 * still a usable snapshot — the app falls back to the single prior season it
 * always used, and says so.
 */
export interface PriorsFile {
  generatedAt: number;
  /** Hash of the fit's own inputs — see `ProjectionModel.inputsHash`. */
  inputsHash?: string;
  seasons: number[];
  /** The season `players[pid].recent` describes. Absent on a pre-rank-chip fit. */
  recentSeason?: number;
  residual: PriorResidualFit;
  /**
   * group -> defence -> the blended entry, in the app's own index shape.
   *
   * Stored as full entries rather than as a score and a factor so the player
   * sheet's matchup panel — allowed per game, generosity rank, ceiling and
   * floor rates — reads the same fields whether the rating came from three
   * finished seasons or from four weeks of this one.
   */
  defense: Record<string, Record<string, MatchupEntry>>;
  /** Measured opponent influence per position, normalised so the peak is 1. */
  influence: Record<string, number>;
  biasCorrection: Record<string, { seasonWeight: number; damping: number }>;
  /** Availability in a week projected before it, per position. */
  forwardPlayRate: Record<string, number>;
  /**
   * How much of a gap projected in September survives the season, per position.
   *
   * Measured forward rather than contemporaneously — see
   * `BuildTradeValuesInput.driftByGroup` for why that distinction is the whole
   * point rather than a detail.
   */
  drift: Record<
    string,
    { drift: number; reliability: number; correlation: number; samples: number }
  >;
  players: Record<
    string,
    {
      /** season -> [per-week level, games played, weeks rostered]. */
      seasons: Record<string, [number, number, number]>;
      forward?: [number, number];
      /**
       * `recentSeason` as the rank chips report it:
       * [total points, games played, booms, weeks with a real projection].
       *
       * Boom rate cannot be recovered in the browser — it needs the weekly
       * projection that preceded each game, and `HistoryFile` carries actuals
       * alone. See `seasonProduction`.
       */
      recent?: [number, number, number, number];
    }
  >;
}

export interface HistoryFile {
  generatedAt: number;
  season: string;
  logs: Record<string, Record<string, Record<string, number>>>;
  applied: Record<string, Record<string, number>>;
  /** pid -> week -> the player's NFL team and who he faced. */
  games: Record<string, Record<string, { team: string; opp: string }>>;
}

/** The index is never cached — it is what decides whether the rest is stale. */
export function loadIndex(
  leagueKey: string,
  signal?: AbortSignal,
): Promise<SnapshotIndex> {
  return fetchJson<SnapshotIndex>(leagueKey, 'index.json', signal);
}

const stamped = <T>(
  leagueKey: string,
  name: string,
  stamp: number,
  signal?: AbortSignal,
) =>
  cached(`snapshot:${leagueKey}:${name}:${stamp}`, TTL.SNAPSHOT, () =>
    fetchJson<T>(leagueKey, name, signal),
  );

export const loadLeagueFile = (key: string, stamp: number, signal?: AbortSignal) =>
  stamped<LeagueFile>(key, 'league.json', stamp, signal);

export const loadPlayersFile = (key: string, stamp: number, signal?: AbortSignal) =>
  stamped<PlayersFile>(key, 'players.json', stamp, signal);

export const loadHistoryFile = (key: string, stamp: number, signal?: AbortSignal) =>
  stamped<HistoryFile>(key, 'history.json', stamp, signal);

export const loadWeekFile = (
  key: string,
  week: number,
  stamp: number,
  signal?: AbortSignal,
) => stamped<WeekFile>(key, `weeks/${week}.json`, stamp, signal);

/**
 * The fitted weekly projection model.
 *
 * Resolves to null rather than throwing when the file is absent: a snapshot
 * taken before `npm run fit:projection` has run is a perfectly usable snapshot,
 * and the app simply shows ESPN's projection on its own.
 *
 * Deliberately **not** cached like the rest of the snapshot. Everything else is
 * keyed on the snapshot's `generatedAt`, which is exactly right for data that
 * only changes when a snapshot is taken — and exactly wrong for this, which is
 * refit independently by `npm run fit:projection` against the same data. A
 * refitted model kept the old stamp, so every cached client went on serving the
 * previous one; during development that silently showed a model two revisions
 * old and cost an hour of chasing a bug that was not in the code. It is 23KB
 * gzipped against a 380KB load, which is not worth a staleness class.
 */
export const loadProjectionModel = (
  key: string,
  _stamp: number,
  signal?: AbortSignal,
) => fetchJson<ProjectionModel>(key, 'projection.json', signal).catch(() => null);

/**
 * The offline multi-season priors.
 *
 * Uncached for the same reason as the projection model: it is refit by
 * `npm run fit:priors` against a snapshot that already exists, so keying it on
 * the snapshot stamp would serve a stale fit to every client that had already
 * loaded that snapshot. Resolves to null when absent, which the app treats as
 * "fall back to the single prior season".
 */
export const loadPriorsFile = (key: string, _stamp: number, signal?: AbortSignal) =>
  fetchJson<PriorsFile>(key, 'priors.json', signal).catch(() => null);
