/**
 * Players — searchable browser over everyone, rostered or free.
 *
 * Defaults to free agents because that's the actionable list, but the whole
 * league is searchable. Value and production rankings help with longer-term
 * choices; the selected week's projections help find a starter right now.
 */

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import {
  appProjectionFor,
  projectedPlayerScore,
  seasonAppTotals,
  weekForecasts,
  SEASON_TOTAL_WEEKS,
} from '../data/predictions';
import { enrichPlayer, rosterOwnerByPlayer } from '../data/selectors';
import { PlayerRow } from '../components/PlayerRow';
import { PlayerModal } from '../components/PlayerModal';
import { EmptyState } from '../components/primitives';
import { fmtLeagueFormat } from '../lib/labels';
import { POSITION_GROUPS, type PositionGroup } from '../lib/types';

type Availability = 'free' | 'rostered' | 'all';
const SORT_KEYS = [
  'value', 'waiverValue', 'positionValue', 'appProjection', 'espnProjection',
  'appSeasonTotal', 'ppg', 'total', 'last4', 'boomRate',
] as const;
type SortKey = (typeof SORT_KEYS)[number];
const PAGE_SIZE = 50;

interface PlayerFilters {
  group: PositionGroup | 'ALL';
  availability: Availability;
  teamId: number | 'ALL';
  sort: SortKey;
  query: string;
  shown: number;
}

const DEFAULT_FILTERS: PlayerFilters = {
  group: 'ALL',
  availability: 'free',
  teamId: 'ALL',
  sort: 'value',
  query: '',
  shown: PAGE_SIZE,
};

export function PlayersPage() {
  const data = useLeagueData();
  // Follows the week picker in the header, like every other page. Reading
  // `currentWeek` here showed a projection column of zeroes before week one,
  // because `currentWeek` is the last *completed* week and there isn't one.
  const { week } = useLeague();
  const [searchParams, setSearchParams] = useSearchParams();
  const [openPid, setOpenPid] = useState<string | null>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const firstAddedRow = useRef<number | null>(null);

  // The URL keeps a player's search intact when Back returns from another page.
  // Only accept positions, teams and sorts that exist in the loaded league.
  const group = POSITION_GROUPS.find((g) => g === searchParams.get('position')) ?? 'ALL';
  const requestedTeam = Number(searchParams.get('team'));
  const teamId = searchParams.has('team') && Number.isSafeInteger(requestedTeam) &&
    data.teamsById.has(requestedTeam) ? requestedTeam : 'ALL';
  const requestedAvailability = searchParams.get('availability');
  const availability: Availability = teamId !== 'ALL' ? 'rostered'
    : requestedAvailability === 'all' || requestedAvailability === 'rostered'
      ? requestedAvailability : 'free';
  const requestedSort = SORT_KEYS.find((key) => key === searchParams.get('sort')) ?? 'value';
  const hasRosterAssignments = data.teams.some((team) => team.players.length > 0);
  /*
   * "Last 4" is a measure of *this* season and has nothing to fall back on, so
   * it is offered only once this season has scored a week.
   *
   * That is the condition rather than "the chips are reporting last season",
   * which it used to be and which now says the wrong thing in both directions:
   * Settings can pin the chips to last season in October, where the last four
   * weeks are perfectly real, and can pin them to this one in week one, where
   * they are four zeroes.
   */
  const hasPlayedWeeks = data.currentWeek > 0;
  const sort = (requestedSort === 'last4' && !hasPlayedWeeks) ||
    (requestedSort === 'waiverValue' && !hasRosterAssignments) ? 'value' : requestedSort;
  const query = (searchParams.get('q') ?? '').slice(0, 120);
  const requestedShown = Number(searchParams.get('shown') ?? PAGE_SIZE);
  const shown = Number.isSafeInteger(requestedShown) && requestedShown >= PAGE_SIZE
    ? Math.min(requestedShown, Math.max(PAGE_SIZE, data.combinedScores.size)) : PAGE_SIZE;
  const filters: PlayerFilters = { group, availability, teamId, sort, query, shown };

  function updateFilters(updates: Partial<PlayerFilters>, replace = false) {
    const next = { ...filters, shown: PAGE_SIZE, ...updates };
    const params = new URLSearchParams(searchParams);
    const values = {
      position: next.group === 'ALL' ? null : next.group,
      availability: next.availability === 'free' ? null : next.availability,
      team: next.teamId === 'ALL' ? null : String(next.teamId),
      sort: next.sort === 'value' ? null : next.sort,
      q: next.query || null,
      shown: next.shown === PAGE_SIZE ? null : String(next.shown),
    };
    for (const [key, value] of Object.entries(values)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    setSearchParams(params, { replace, preventScrollReset: true });
  }

  const resetFilters = () => updateFilters(DEFAULT_FILTERS);
  const hasFilters = group !== 'ALL' || availability !== 'free' || teamId !== 'ALL' ||
    sort !== 'value' || query !== '' || shown > PAGE_SIZE;

  // Keeps typing responsive while the list re-filters.
  const deferredQuery = useDeferredValue(query);

  const ownerByPid = useMemo(() => rosterOwnerByPlayer(data.teams), [data]);
  const forecasts = useMemo(() => weekForecasts(data, week, 'pregame'), [data, week]);

  /*
   * Built only when the sort asks for it. It is fifteen weeks of forecasts —
   * cheap once and memoized on the snapshot from then on, but not work to do on
   * every visit to a page whose default sort never reads it.
   */
  const seasonTotals = useMemo(
    () => (sort === 'appSeasonTotal' ? seasonAppTotals(data) : null),
    [data, sort],
  );
  /** The range actually summed, which a short snapshot can cut short. */
  const seasonTotalWeeks = Math.min(SEASON_TOTAL_WEEKS, data.maxWeek);

  const results = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const rows: Array<{ pid: string; sortValue: number }> = [];

    for (const [pid, combinedScore] of data.combinedScores) {
      const player = data.playersById.get(pid);
      const value = data.valueIndex.byPlayer.get(pid) ?? null;
      const season = data.seasonValueIndex.byPlayer.get(pid) ?? null;
      const playerGroup = value?.group ?? season?.group ?? null;
      if (!playerGroup || (group !== 'ALL' && playerGroup !== group)) continue;

      const owner = ownerByPid.get(pid) ?? null;
      const isOwned = owner !== null;
      if (availability === 'free' && isOwned) continue;
      if (availability === 'rostered' && !isOwned) continue;
      if (teamId !== 'ALL' && owner?.teamId !== teamId) continue;

      if (needle) {
        const name = (player?.name ?? '').toLowerCase();
        const team = (player?.team ?? '').toLowerCase();
        if (!name.includes(needle) && !team.includes(needle)) continue;
      }

      /*
       * Sorting by value across positions has to use points, not the Value
       * Score — that one is a percentile inside a position group, so an "All
       * positions" list ordered by it is led by whoever is most dominant
       * *relative to his own pool*, which is usually a kicker. Keep the same
       * points-based ordering when narrowing to a position; the position score
       * is a separate sort with a different purpose.
       */
      /*
       * The three production sorts fall back to last season, on the same switch
       * the rank chips use, so the list is ordered by the numbers it is showing.
       * Without it "sort by PPG" before week one is a stable sort over a column
       * of zeroes — a button that visibly does nothing.
       */
      const production = data.ranks.fromPrior
        ? data.priorProduction.get(pid) : value?.breakdown;
      const projection = sort === 'appProjection' || sort === 'espnProjection'
        ? projectedPlayerScore({
          pid,
          group: player?.group ?? null,
          slot: '',
          proj: data.score(data.weeks.get(week)?.projections[pid], player?.group ?? null),
        }, forecasts, sort === 'appProjection' ? 'app' : 'espn')
        : null;

      const sortValue =
        projection !== null ? projection : sort === 'value'
          ? (data.tradeValues.byPlayer.get(pid)?.points ?? 0)
          : sort === 'waiverValue'
            ? (data.tradeValues.byPlayer.get(pid)?.pointsOverWaiver ?? 0)
            : sort === 'positionValue' ? combinedScore
              : sort === 'appSeasonTotal' ? (seasonTotals?.get(pid) ?? 0)
                : sort === 'ppg' ? (production?.ppg ?? 0)
                  : sort === 'total' ? (production?.total ?? 0)
                    : sort === 'last4' ? (value?.breakdown.last4 ?? 0)
                      : (production?.boomRate ?? 0);

      rows.push({ pid, sortValue });
    }

    rows.sort((a, b) => b.sortValue - a.sortValue);
    return rows;
  }, [data, group, availability, teamId, sort, deferredQuery, ownerByPid, week, forecasts, seasonTotals]);

  // Enrich only the visible rows while keeping the whole player pool reachable.
  const visibleResults = useMemo(
    () => results.slice(0, shown).map((r) => ({
      player: enrichPlayer(data, r.pid, week, '', false),
      owner: ownerByPid.get(r.pid)?.name ?? null,
    })),
    [data, results, shown, week, ownerByPid],
  );

  const sortLabels: Record<SortKey, string> = {
    value: 'League value',
    waiverValue: 'Value over waivers',
    positionValue: 'Position score',
    appProjection: `App projection · Week ${week}`,
    espnProjection: `ESPN projection · Week ${week}`,
    appSeasonTotal: `Total Predicted App Score · Weeks 1–${seasonTotalWeeks}`,
    ppg: 'PPG',
    total: 'Total',
    last4: 'Last 4',
    boomRate: 'Boom Rate',
  };

  // More rows appear before the button; keep keyboard readers at the first new
  // result instead of stranding them beneath the entire added batch.
  useEffect(() => {
    if (firstAddedRow.current === null) return;
    resultsRef.current?.querySelectorAll<HTMLButtonElement>('.player-row')[firstAddedRow.current]?.focus();
    firstAddedRow.current = null;
  }, [visibleResults.length]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Players</h1>
          <p className="small secondary">{fmtLeagueFormat(data.league)}</p>
        </div>
        {hasFilters && <button className="btn btn-sm" onClick={resetFilters}>Reset filters</button>}
      </div>

      <div className="filters">
        <input
          className="input"
          style={{ maxWidth: 280 }}
          type="search"
          placeholder="Search name or team…"
          value={query}
          maxLength={120}
          onChange={(e) => updateFilters({ query: e.target.value }, true)}
          aria-label="Search players"
        />

        <div className="segmented" role="group" aria-label="Availability">
          <button
            aria-pressed={availability === 'free'}
            onClick={() => updateFilters({ availability: 'free', teamId: 'ALL' })}
          >
            Free agents
          </button>
          <button
            aria-pressed={availability === 'rostered'}
            onClick={() => updateFilters({ availability: 'rostered', teamId: 'ALL' })}
          >
            Rostered
          </button>
          <button
            aria-pressed={availability === 'all'}
            onClick={() => updateFilters({ availability: 'all', teamId: 'ALL' })}
          >
            All
          </button>
        </div>

        <label className="row small muted" style={{ gap: 8 }}>
          Sort by
          <select
            className="select"
            style={{ minWidth: 0, maxWidth: '100%' }}
            value={sort}
            onChange={(e) => {
              const next = SORT_KEYS.find((key) => key === e.target.value);
              if (next) updateFilters({ sort: next });
            }}
          >
            {SORT_KEYS.filter((key) => key !== 'last4' || hasPlayedWeeks).map((key) => (
              <option key={key} value={key} disabled={key === 'waiverValue' && !hasRosterAssignments}>
                {sortLabels[key]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="filters">
        <div className="segmented" role="group" aria-label="Position group">
          <button aria-pressed={group === 'ALL'} onClick={() => updateFilters({ group: 'ALL' })}>
            All
          </button>
          {POSITION_GROUPS.map((g) => (
            <button key={g} aria-pressed={group === g} onClick={() => updateFilters({ group: g })}>
              {g}
            </button>
          ))}
        </div>
      </div>

      <div className="filters">
        <label className="row small muted" style={{ gap: 8, maxWidth: '100%' }}>
          Fantasy team
          <select
            className="select"
            style={{ minWidth: 0, maxWidth: '100%' }}
            value={teamId}
            onChange={(e) => {
              const id = Number(e.target.value);
              updateFilters(e.target.value === 'ALL' ? { teamId: 'ALL' }
                : { availability: 'rostered', teamId: id });
            }}
          >
            <option value="ALL">All fantasy teams</option>
            {data.teams.map((team) => (
              <option key={team.teamId} value={team.teamId}>{team.name}</option>
            ))}
          </select>
        </label>
      </div>

      <p className="small muted" style={{ marginBottom: 14 }}>
        {sort === 'value'
          ? `Expected rest-of-season points above starter replacement in this ${data.league.size}-team league, through Week ${data.playoff.finalWeek}. Comparable across positions.`
          : sort === 'waiverValue'
            ? `Expected rest-of-season points above the best available waiver option at each position, through Week ${data.playoff.finalWeek}. This measures player value; roster fit determines which pickups help your team.`
          : sort === 'positionValue'
            ? 'Value Score (0–1000) compares players within their own position. It blends current production with rest-of-season outlook.'
          : sort === 'appProjection'
          ? `Week ${week} app projections are pregame medians, with ESPN used when an app estimate is unavailable.`
          : sort === 'espnProjection'
            ? `Week ${week} ESPN projections use this league's scoring settings.`
          : sort === 'appSeasonTotal'
            ? `Every week from 1 to ${seasonTotalWeeks} added up, using the app's expected points rather than the median a row displays — medians do not add. Availability is priced in, byes count as zero, and ESPN's projection stands in where the app has no fit. Comparable across positions.`
            : data.ranks.fromPrior ? `PPG, Total and Boom Rate are ${data.ranks.season} finishes.`
              : 'Ranked using this league’s scoring settings.'}
      </p>

      {!hasRosterAssignments && (
        <p className="small secondary" style={{ marginBottom: 14 }}>
          This snapshot has no roster assignments. Every player appears in the free-agent pool;
          waiver values will become available when rosters are recorded.
        </p>
      )}

      {results.length === 0 ? (
        <div className="stack" style={{ gap: 10 }}>
          <EmptyState
            title="No players match"
            hint="Try a different fantasy team, position group, or clear the search."
          />
          <button className="btn" onClick={resetFilters}>Reset filters</button>
        </div>
      ) : (
        <section
          id="player-results"
          className="card"
          style={{ overflow: 'hidden' }}
          ref={resultsRef}
          aria-busy={query !== deferredQuery}
        >
          <div className="group-head group-head--primary" style={{ flexWrap: 'wrap' }}>
            <span role="status" aria-live="polite">
              Showing {visibleResults.length} of {results.length} players
            </span>
            <span className="small">{sortLabels[sort]}</span>
          </div>
          {visibleResults.map(({ player, owner }, index) => (
            <PlayerRow
              key={player.pid}
              player={player}
              listRank={index + 1}
              appProjection={appProjectionFor(player, forecasts)}
              primaryProjection={sort === 'appProjection' ? 'app' : sort === 'espnProjection' ? 'espn' : undefined}
              onSelect={setOpenPid}
              note={owner}
              valueMetric={sort === 'value' || sort === 'waiverValue' ? {
                label: sort === 'value' ? 'Value' : 'Waiver',
                value: data.tradeValues.byPlayer.get(player.pid)?.[
                  sort === 'value' ? 'points' : 'pointsOverWaiver'
                ] ?? null,
                description: sort === 'value'
                  ? 'Expected rest-of-season points above starter replacement'
                  : 'Expected rest-of-season points above the best available waiver option',
              } : undefined}
              /*
                On the right, in the column the actual score would occupy —
                which before a played week is a column of dashes. It is the
                number the list is ordered by, so it belongs where the eye runs
                down rather than beside the name.
              */
              totalMetric={sort === 'appSeasonTotal' ? {
                value: seasonTotals?.get(player.pid) ?? null,
                description: `Total app-projected points over weeks 1–${seasonTotalWeeks}`,
              } : undefined}
            />
          ))}
          {visibleResults.length < results.length && (
            <div className="card-pad" style={{ textAlign: 'center' }}>
              <button
                className="btn"
                aria-controls="player-results"
                onClick={() => {
                  firstAddedRow.current = visibleResults.length;
                  updateFilters({ shown: shown + PAGE_SIZE }, true);
                }}
              >
                Show {Math.min(PAGE_SIZE, results.length - visibleResults.length)} more players
              </button>
              <div className="tiny muted" style={{ marginTop: 6 }}>
                {results.length - visibleResults.length} more match your filters
              </div>
            </div>
          )}
        </section>
      )}

      <PlayerModal pid={openPid} week={week} onClose={() => setOpenPid(null)} />
    </>
  );
}
