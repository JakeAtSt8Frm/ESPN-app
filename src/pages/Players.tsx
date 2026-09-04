/**
 * Players — searchable browser over everyone, rostered or free.
 *
 * Defaults to free agents because that's the actionable list, but the whole
 * league is searchable. Ranking is by Value Score, which is computed within
 * position group, so the DB list is ranked against other DBs rather than
 * against quarterbacks.
 */

import { useDeferredValue, useMemo, useState } from 'react';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { appProjectionFor, weekForecasts } from '../data/predictions';
import { enrichPlayer, rosterOwnerByPlayer } from '../data/selectors';
import { PlayerRow } from '../components/PlayerRow';
import { PlayerModal } from '../components/PlayerModal';
import { EmptyState } from '../components/primitives';
import { POSITION_GROUPS, type PositionGroup } from '../lib/types';

type Availability = 'free' | 'rostered' | 'all';
type SortKey = 'value' | 'ppg' | 'total' | 'last4' | 'boomRate';

export function PlayersPage() {
  const data = useLeagueData();
  // Follows the week picker in the header, like every other page. Reading
  // `currentWeek` here showed a projection column of zeroes before week one,
  // because `currentWeek` is the last *completed* week and there isn't one.
  const { week } = useLeague();
  const [group, setGroup] = useState<PositionGroup | 'ALL'>('ALL');
  const [availability, setAvailability] = useState<Availability>('free');
  const [teamId, setTeamId] = useState<number | 'ALL'>('ALL');
  const [sort, setSort] = useState<SortKey>('value');
  const [query, setQuery] = useState('');
  const [openPid, setOpenPid] = useState<string | null>(null);

  // Keeps typing responsive while the list re-filters.
  const deferredQuery = useDeferredValue(query);

  const ownerByPid = useMemo(() => rosterOwnerByPlayer(data.teams), [data]);
  const forecasts = useMemo(() => weekForecasts(data, week, 'pregame'), [data, week]);

  const results = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const rows: Array<{ pid: string; sortValue: number }> = [];

    for (const [pid, combinedScore] of data.combinedScores) {
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
        const player = data.playersById.get(pid);
        const name = (
          player?.name ?? ''
        ).toLowerCase();
        const team = (player?.team ?? '').toLowerCase();
        if (!name.includes(needle) && !team.includes(needle)) continue;
      }

      /*
       * Sorting by value across positions has to use points, not the Value
       * Score — that one is a percentile inside a position group, so an "All
       * positions" list ordered by it is led by whoever is most dominant
       * *relative to his own pool*, which is usually a kicker. Inside a single
       * position the two agree on the ordering and the Value Score is the more
       * informative number, so it keeps the column.
       */
      /*
       * The three production sorts fall back to last season, on the same switch
       * the rank chips use, so the list is ordered by the numbers it is showing.
       * Without it "sort by PPG" before week one is a stable sort over a column
       * of zeroes — a button that visibly does nothing.
       */
      const prior = data.ranks.fromPrior ? data.priorProduction.get(pid) : undefined;

      const sortValue =
        sort === 'value'
          ? group === 'ALL'
            ? (data.tradeValues.byPlayer.get(pid)?.points ?? 0)
            : combinedScore
          : sort === 'ppg'
            ? (value?.breakdown.ppg ??
              prior?.ppg ??
              season?.breakdown.restOfSeasonPpg ??
              0)
            : sort === 'total'
              ? (value?.breakdown.total ??
                prior?.total ??
                season?.breakdown.restOfSeasonPoints ??
                0)
              : sort === 'last4'
                ? (value?.breakdown.last4 ?? 0)
                : (value?.breakdown.boomRate ?? prior?.boomRate ?? 0);

      rows.push({ pid, sortValue });
    }

    rows.sort((a, b) => b.sortValue - a.sortValue);
    // Cap the render — a full unfiltered list is ~1800 rows and nobody scrolls
    // past the first hundred.
    return rows.slice(0, 150).map((r) => ({
      player: enrichPlayer(data, r.pid, week, '', false),
      owner: ownerByPid.get(r.pid)?.name ?? null,
    }));
  }, [data, group, availability, teamId, sort, deferredQuery, ownerByPid, week]);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Available Players</h1>
      </div>

      <div className="filters">
        <input
          className="input"
          style={{ maxWidth: 280 }}
          type="search"
          placeholder="Search name or team…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search players"
        />

        <div className="segmented" role="group" aria-label="Availability">
          <button
            aria-pressed={availability === 'free'}
            onClick={() => {
              setAvailability('free');
              setTeamId('ALL');
            }}
          >
            Free agents
          </button>
          <button
            aria-pressed={availability === 'rostered'}
            onClick={() => {
              setAvailability('rostered');
              setTeamId('ALL');
            }}
          >
            Rostered
          </button>
          <button
            aria-pressed={availability === 'all'}
            onClick={() => {
              setAvailability('all');
              setTeamId('ALL');
            }}
          >
            All
          </button>
        </div>

        <div className="segmented" role="group" aria-label="Sort by">
          <button aria-pressed={sort === 'value'} onClick={() => setSort('value')}>
            Value
          </button>
          <button aria-pressed={sort === 'ppg'} onClick={() => setSort('ppg')}>
            PPG
          </button>
          <button aria-pressed={sort === 'total'} onClick={() => setSort('total')}>
            Total
          </button>
          {/*
            Last 4 is the one sort with no prior-season answer: last season's
            closing four weeks are not this player's recent form, they are a
            different roster's. It is dropped rather than filled in with
            something else under its own label.
          */}
          {!data.ranks.fromPrior && (
            <button aria-pressed={sort === 'last4'} onClick={() => setSort('last4')}>
              Last 4
            </button>
          )}
          <button aria-pressed={sort === 'boomRate'} onClick={() => setSort('boomRate')}>
            Boom Rate
          </button>
        </div>

        {data.ranks.fromPrior && (
          <span className="small muted" style={{ alignSelf: 'center' }}>
            PPG, Total and Boom Rate are {data.ranks.season} finishes
          </span>
        )}
      </div>

      <div className="filters">
        <div className="segmented" role="group" aria-label="Position group">
          <button aria-pressed={group === 'ALL'} onClick={() => setGroup('ALL')}>
            All
          </button>
          {POSITION_GROUPS.map((g) => (
            <button key={g} aria-pressed={group === g} onClick={() => setGroup(g)}>
              {g}
            </button>
          ))}
        </div>
      </div>

      <div className="filters">
        <div className="segmented" role="group" aria-label="Fantasy team">
          <button aria-pressed={teamId === 'ALL'} onClick={() => setTeamId('ALL')}>
            All fantasy teams
          </button>
          {data.teams.map((team) => (
            <button
              key={team.teamId}
              aria-pressed={teamId === team.teamId}
              onClick={() => {
                setAvailability('rostered');
                setTeamId(team.teamId);
              }}
            >
              {team.name}
            </button>
          ))}
        </div>
      </div>

      {results.length === 0 ? (
        <EmptyState
          title="No players match"
          hint="Try a different fantasy team, position group, or clear the search."
        />
      ) : (
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>
              {results.length} shown
              {results.length === 150 ? ' (top 150)' : ''}
            </span>
          </div>
          {results.map(({ player, owner }, index) => (
            <PlayerRow
              key={player.pid}
              player={player}
              listRank={index + 1}
              appProjection={appProjectionFor(player, forecasts)}
              onSelect={setOpenPid}
              note={owner}
            />
          ))}
        </section>
      )}

      <PlayerModal pid={openPid} week={week} onClose={() => setOpenPid(null)} />
    </>
  );
}
