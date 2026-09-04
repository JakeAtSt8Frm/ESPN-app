import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { loadLeague, type LeagueData, type LoadProgress } from './league';
import { cacheClear } from './cache';

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
  /** Week the user is currently viewing. */
  week: number;
  setWeek: (week: number) => void;
  /** Team the user has selected; defaults to the one they own. */
  selectedTeamId: number | null;
  setSelectedTeamId: (id: number) => void;
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

const TEAM_KEY = 'espn.teamId';

/**
 * The viewer's own team id, if they have picked one.
 *
 * The snapshot knows which ESPN account it was generated from but not who is
 * reading, so the app cannot infer this. It remembers the choice instead.
 */
function savedTeamId(): number | null {
  try {
    const raw = localStorage.getItem(TEAM_KEY);
    const id = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
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
  const [selectedTeamId, setTeamIdState] = useState<number | null>(savedTeamId);
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

    loadLeague((p) => {
      if (!cancelled) setProgress(p);
    }, controller.signal)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setWeek(result.liveWeek);
        setTeamIdState((prev) =>
          prev !== null && result.teamsById.has(prev)
            ? prev
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
  }, [reloadToken]);

  const setSelectedTeamId = useCallback((id: number) => {
    setTeamIdState(id);
    try {
      localStorage.setItem(TEAM_KEY, String(id));
    } catch {
      /* non-fatal */
    }
  }, []);

  const refresh = useCallback((options?: { refit?: boolean }) => {
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

    const url = new URL('api/refresh', document.baseURI);
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
  }, []);

  const value = useMemo<LeagueContextValue>(
    () => ({
      status,
      data,
      error,
      progress,
      week,
      setWeek,
      selectedTeamId,
      setSelectedTeamId,
      refresh,
      refreshState,
      canPull,
    }),
    [
      status,
      data,
      error,
      progress,
      week,
      selectedTeamId,
      setSelectedTeamId,
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
 * Convenience hook for pages that only render once data is ready.
 * Throws if called before load completes, so callers can rely on non-null data.
 */
export function useLeagueData(): LeagueData {
  const { data } = useLeague();
  if (!data) throw new Error('League data is not loaded yet');
  return data;
}
