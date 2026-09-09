import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  loadLeague,
  withStatsSeason,
  type LeagueData,
  type LoadProgress,
  type StatsSeason,
} from './league';
import { cacheClear } from './cache';
import {
  DEFAULT_LEAGUE_KEY,
  LEAGUES,
  findLeague,
  leagueOrDefault,
  type LeagueConfig,
} from '../lib/leagues';
import { MATCHUP_INFLUENCE } from '../lib/matchup';
import type { PositionGroup } from '../lib/types';

type Status = 'idle' | 'loading' | 'ready' | 'error';

/**
 * What a Refresh is currently doing.
 *
 * `pulling` means a local server is fetching a genuinely new snapshot from
 * ESPN, which takes about a minute; `reloading` is the cheap path that only
 * drops the cache. They are distinguished because the first is worth a progress
 * message and the second is over before anyone reads one.
 */
export type RefreshState =
  | { phase: 'idle' }
  | { phase: 'pulling'; message: string }
  | { phase: 'reloading' }
  | { phase: 'error'; message: string };

interface LeagueContextValue {
  status: Status;
  data: LeagueData | null;
  error: string | null;
  progress: LoadProgress | null;
  /** Every league the app is configured to show, in switcher order. */
  leagues: readonly LeagueConfig[];
  /** The one being viewed. */
  league: LeagueConfig;
  /**
   * Switches leagues, and remembers the choice.
   *
   * Each league is a separate snapshot with its own scoring and its own fitted
   * models, so this discards the loaded `LeagueData` and loads the other one
   * from scratch rather than trying to swap parts of it. The cached payloads
   * survive — they are keyed by league — so switching back is immediate.
   */
  setLeagueKey: (key: string) => void;
  /** Week the user is currently viewing. */
  week: number;
  setWeek: (week: number) => void;
  /** Team the user has selected; defaults to the one they own. */
  selectedTeamId: number | null;
  setSelectedTeamId: (id: number) => void;
  /**
   * Which season's production the app reports, and whether that was chosen.
   *
   * `auto` — the default — hands the decision back to the rule in `league.ts`:
   * last season's finishes until this one has four weeks of its own. Pinning
   * `prior` is the case this exists for. Every number it moves is already in
   * memory, so the switch is immediate and `data` is the only thing that
   * changes; nothing reloads.
   */
  statsSeason: StatsSeason;
  setStatsSeason: (choice: StatsSeason) => void;
  /**
   * Pulls a new snapshot where that is possible, and reloads either way.
   *
   * `refit` also rebuilds the fitted models over every finished season. That
   * costs several minutes and cannot change until a season ends, so it is off
   * unless asked for.
   */
  refresh: (options?: { refit?: boolean }) => void;
  refreshState: RefreshState;
  /**
   * Whether a real snapshot pull is even available here.
   *
   * Null until the first local attempt tells us. The app is a static site and the
   * league is private, so the browser cannot reach ESPN itself — a live pull
   * needs a local server (`npm run dev` or `npm run serve`) running the
   * snapshot script with the credentials in `.env`. On GitHub Pages, Refresh
   * drops the cache and reads the latest snapshot deployed by GitHub Actions.
   */
  canPull: boolean | null;
}

const LeagueContext = createContext<LeagueContextValue | null>(null);

const LEAGUE_KEY = 'espn.league';

/**
 * Where the viewer's team is remembered, per league.
 *
 * Per league because a team id means nothing outside the league that issued it:
 * team 3 in one is a different person's roster in the other, and a single
 * shared key would silently open the wrong team on every switch.
 */
const teamKeyFor = (leagueKey: string) => `espn.teamId.${leagueKey}`;

/** The league last viewed, falling back to the default. */
function savedLeagueKey(): string {
  try {
    return leagueOrDefault(localStorage.getItem(LEAGUE_KEY)).key;
  } catch {
    return DEFAULT_LEAGUE_KEY;
  }
}

/**
 * The viewer's own team id in a league, if they have picked one.
 *
 * The snapshot knows which ESPN account it was generated from but not who is
 * reading, so the app cannot infer this. It remembers the choice instead.
 *
 * Falls back to the pre-multi-league key for the default league, so nobody's
 * saved team is lost by the move to per-league storage.
 */
function savedTeamId(leagueKey: string): number | null {
  try {
    const raw =
      localStorage.getItem(teamKeyFor(leagueKey)) ??
      (leagueKey === DEFAULT_LEAGUE_KEY ? localStorage.getItem('espn.teamId') : null);
    const id = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Where the production season is remembered.
 *
 * Not per league, unlike the team id. A season is an NFL season — both leagues
 * are playing the same one, and somebody who wants last year's finishes wants
 * them in whichever league they open next.
 */
const STATS_SEASON_KEY = 'espn.statsSeason';

function savedStatsSeason(): StatsSeason {
  try {
    const raw = localStorage.getItem(STATS_SEASON_KEY);
    return raw === 'prior' || raw === 'current' ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

/** Only a loopback server is allowed to expose the unauthenticated pull route. */
function isLocalServer(): boolean {
  return (
    location.protocol === 'http:' &&
    (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  );
}

export function LeagueProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('idle');
  const [data, setData] = useState<LeagueData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [week, setWeek] = useState(1);
  const [leagueKey, setLeagueKeyState] = useState<string>(savedLeagueKey);
  const [selectedTeamId, setTeamIdState] = useState<number | null>(() =>
    savedTeamId(savedLeagueKey()),
  );
  const [statsSeason, setStatsSeasonState] = useState<StatsSeason>(savedStatsSeason);
  const [reloadToken, setReloadToken] = useState(0);
  const [refreshState, setRefreshState] = useState<RefreshState>({ phase: 'idle' });
  const [canPull, setCanPull] = useState<boolean | null>(() =>
    isLocalServer() ? null : false,
  );

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setStatus('loading');
    setError(null);
    setProgress(null);

    loadLeague(
      leagueKey,
      (p) => {
        if (!cancelled) setProgress(p);
      },
      controller.signal,
    )
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setWeek(result.liveWeek);
        /*
         * Read from storage rather than kept from the previous render. On a
         * plain reload the two agree; on a league switch they do not, and
         * keeping the old value would open the new league on whichever team
         * happened to share that id.
         */
        const saved = savedTeamId(leagueKey);
        setTeamIdState(
          saved !== null && result.teamsById.has(saved)
            ? saved
            : (result.teams[0]?.teamId ?? null),
        );
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load league data');
        setStatus('error');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [leagueKey, reloadToken]);

  const setSelectedTeamId = useCallback(
    (id: number) => {
      setTeamIdState(id);
      try {
        localStorage.setItem(teamKeyFor(leagueKey), String(id));
      } catch {
        /* non-fatal */
      }
    },
    [leagueKey],
  );

  const setStatsSeason = useCallback((choice: StatsSeason) => {
    setStatsSeasonState(choice);
    try {
      localStorage.setItem(STATS_SEASON_KEY, choice);
    } catch {
      /* non-fatal */
    }
  }, []);

  const setLeagueKey = useCallback(
    (key: string) => {
      const next = findLeague(key);
      // An unknown key means a stale link or an edited storage value. Ignoring
      // it leaves the app on a league it can actually load.
      if (!next || next.key === leagueKey) return;

      // Cleared so the switch shows the loading state rather than the previous
      // league's numbers under the new league's name.
      setData(null);
      setStatus('loading');
      try {
        localStorage.setItem(LEAGUE_KEY, next.key);
      } catch {
        /* non-fatal */
      }
      setLeagueKeyState(next.key);
    },
    [leagueKey],
  );

  const refresh = useCallback(
    (options?: { refit?: boolean }) => {
      const reload = () => {
        setRefreshState({ phase: 'reloading' });
        void cacheClear().then(() => {
          setRefreshState({ phase: 'idle' });
          setReloadToken((n) => n + 1);
        });
      };

      // GitHub Pages has no server route. Its Actions workflow publishes the
      // fresh snapshot, and Reload only needs to bypass the local caches.
      if (!isLocalServer()) {
        setCanPull(false);
        reload();
        return;
      }

      setRefreshState({
        phase: 'pulling',
        message: options?.refit
          ? 'Pulling from ESPN and refitting — several minutes'
          : 'Pulling from ESPN — about a minute',
      });

      // Names the league to pull. The endpoint validates it against the same
      // config before it reaches a process — see `handleRefresh`.
      const url = new URL('api/refresh', document.baseURI);
      url.searchParams.set('league', leagueKey);
      if (options?.refit) url.searchParams.set('fit', '1');

      void fetch(url, { method: 'POST' })
        .then(async (res) => {
          /*
           * A 404 is the expected answer everywhere the app is merely hosted —
           * GitHub Pages has no such route — and it is not an error worth showing
           * anybody. It just means this copy cannot pull, which the button says
           * from then on.
           */
          if (res.status === 404 || res.status === 405) {
            setCanPull(false);
            reload();
            return;
          }
          setCanPull(true);
          const body = (await res.json()) as { ok?: boolean; error?: string };
          if (!body.ok) {
            setRefreshState({ phase: 'error', message: body.error ?? 'The snapshot failed' });
            return;
          }
          reload();
        })
        .catch(() => {
          // No local server listening at all: the fetch never resolved.
          setCanPull(false);
          reload();
        });
    },
    [leagueKey],
  );

  /*
   * The preference applied, once, at the point every consumer reads from.
   *
   * Doing it here rather than in each page is what makes the switch consistent:
   * a rank is an ordering over a pool, and a page that read the pinned index
   * while its neighbour read the automatic one would show two orderings under
   * one heading. `withStatsSeason` returns the same object when the preference
   * agrees with the automatic choice, so the common case allocates nothing and
   * leaves every downstream memo untouched.
   */
  const view = useMemo(
    () => (data ? withStatsSeason(data, statsSeason) : null),
    [data, statsSeason],
  );

  const value = useMemo<LeagueContextValue>(
    () => ({
      status,
      data: view,
      error,
      progress,
      leagues: LEAGUES,
      league: leagueOrDefault(leagueKey),
      setLeagueKey,
      week,
      setWeek,
      selectedTeamId,
      setSelectedTeamId,
      statsSeason,
      setStatsSeason,
      refresh,
      refreshState,
      canPull,
    }),
    [
      status,
      view,
      error,
      progress,
      leagueKey,
      setLeagueKey,
      week,
      selectedTeamId,
      setSelectedTeamId,
      statsSeason,
      setStatsSeason,
      refresh,
      refreshState,
      canPull,
    ],
  );

  return <LeagueContext.Provider value={value}>{children}</LeagueContext.Provider>;
}

export function useLeague(): LeagueContextValue {
  const ctx = useContext(LeagueContext);
  if (!ctx) throw new Error('useLeague must be used inside a LeagueProvider');
  return ctx;
}

/**
 * This league's opponent-influence table, with the compiled fallback.
 *
 * Separate from `useLeagueData` because the two callers are chips rendered deep
 * in lists, which must not throw while a league is switching and `data` is
 * briefly null. The fallback is the same one a never-fitted snapshot gets.
 */
export function useMatchupInfluence(): Record<PositionGroup, number> {
  return useContext(LeagueContext)?.data?.matchupInfluence ?? MATCHUP_INFLUENCE;
}

/**
 * Convenience hook for pages that only render once data is ready.
 * Throws if called before load completes, so callers can rely on non-null data.
 */
export function useLeagueData(): LeagueData {
  const { data } = useLeague();
  if (!data) throw new Error('League data is not loaded yet');
  return data;
}
