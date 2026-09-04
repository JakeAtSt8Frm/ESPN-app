/**
 * Optimal Lineup — what the best legal lineup was, and what it cost to miss it.
 *
 * The solver runs a true maximum-weight matching rather than filling slots
 * greedily, which matters in a superflex league: the QB that belongs in the
 * SUPER_FLEX slot depends on who else is eligible for it.
 */

import { useMemo, useState } from 'react';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import {
  projectedLineupTotal,
  projectedOptimalLineup,
  weekForecasts,
  type ProjectionSource,
} from '../data/predictions';
import { buildHeatmap, buildRosterWeek } from '../data/selectors';
import { PlayerModal } from '../components/PlayerModal';
import { Heatmap } from '../components/Heatmap';
import {
  EmptyState,
  StatTile,
  StatTileRow,
  fmt1,
  fmtPct,
} from '../components/primitives';
import { playerHeadshot, teamLogo } from '../lib/assets';
import { fmtSlot } from '../lib/labels';
import { playerName } from '../data/league';
import { lineupEfficiency } from '../lib/optimal';

export function OptimalPage() {
  const data = useLeagueData();
  const { week, selectedTeamId, setSelectedTeamId } = useLeague();
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [projectionSource, setProjectionSource] = useState<ProjectionSource>('app');

  const teamId = selectedTeamId ?? data.teams[0]?.teamId ?? null;

  const rosterWeek = useMemo(
    () => (teamId === null ? null : buildRosterWeek(data, teamId, week)),
    [data, teamId, week],
  );

  const forecasts = useMemo(() => weekForecasts(data, week, 'pregame'), [data, week]);

  const selectedView = useMemo(() => {
    if (!rosterWeek) return null;
    const played = rosterWeek.all.some((player) => player.hasPlayed);
    if (played) {
      return {
        played,
        fielded: rosterWeek.actualTotal,
        optimalLineup: rosterWeek.optimalLineup,
        efficiency: rosterWeek.efficiency,
      };
    }

    const fielded = projectedLineupTotal(
      rosterWeek.starters,
      forecasts,
      projectionSource,
    );
    const optimalLineup = projectedOptimalLineup(
      data.starterSlots,
      rosterWeek.all,
      forecasts,
      projectionSource,
    );
    return {
      played,
      fielded,
      optimalLineup,
      efficiency: lineupEfficiency(fielded, optimalLineup.total),
    };
  }, [data.starterSlots, forecasts, projectionSource, rosterWeek]);

  /** Optimal-lineup efficiency for every team this week, for the comparison table. */
  const leagueEfficiency = useMemo(
    () =>
      data.teams
        .map((team) => {
          const rw = buildRosterWeek(data, team.teamId, week);
          if (!rw) {
            return { teamId: team.teamId, name: team.name, actual: 0, optimal: 0, efficiency: 0 };
          }
          const played = rw.all.some((player) => player.hasPlayed);
          if (played) {
            return {
              teamId: team.teamId,
              name: team.name,
              actual: rw.actualTotal,
              optimal: rw.optimalTotal,
              efficiency: rw.efficiency,
            };
          }

          const actual = projectedLineupTotal(rw.starters, forecasts, projectionSource);
          const optimal = projectedOptimalLineup(
            data.starterSlots,
            rw.all,
            forecasts,
            projectionSource,
          ).total;
          return {
            teamId: team.teamId,
            name: team.name,
            actual,
            optimal,
            efficiency: lineupEfficiency(actual, optimal),
          };
        })
        .sort((a, b) => b.efficiency - a.efficiency),
    [data, forecasts, projectionSource, week],
  );

  const heatmapRows = useMemo(
    () => buildHeatmap(data, week, 'starters', 'projected'),
    [data, week],
  );

  if (!rosterWeek || !selectedView) return <EmptyState title="No team selected" />;

  const { optimalLineup, fielded, efficiency, played } = selectedView;
  const optimalTotal = optimalLineup.total;
  const { starters } = rosterWeek;
  const startedIds = new Set(starters.map((p) => p.pid));

  // Which optimal picks were actually benched — the actionable part.
  const missed = optimalLineup.assignments.filter(
    (a) => a.pid && !startedIds.has(a.pid),
  );

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Optimal Lineup</h1>
      </div>

      <div className="filters">
        <div className="segmented" role="group" aria-label="Select team">
          {data.teams.map((t) => (
            <button
              key={t.teamId}
              aria-pressed={t.teamId === teamId}
              onClick={() => setSelectedTeamId(t.teamId)}
            >
              {t.name}
              {t.placement === 1 ? ' 🏆' : ''}
            </button>
          ))}
        </div>
        {!played && (
          <div className="segmented" role="group" aria-label="Optimize projections using">
            <button
              aria-pressed={projectionSource === 'app'}
              onClick={() => setProjectionSource('app')}
            >
              App projection
            </button>
            <button
              aria-pressed={projectionSource === 'espn'}
              onClick={() => setProjectionSource('espn')}
            >
              ESPN projection
            </button>
          </div>
        )}
      </div>

      <StatTileRow>
        <StatTile label={played ? 'Actual Score' : 'Current Lineup'} value={fmt1(fielded)} />
        <StatTile
          label={played ? 'Optimal' : 'Best Available'}
          value={fmt1(optimalTotal)}
        />
        <StatTile
          label={played ? 'Left on bench' : 'On the bench'}
          value={fmt1(Math.max(0, optimalTotal - fielded))}
          tone={optimalTotal - fielded > 20 ? 'var(--danger-text)' : undefined}
        />
        <StatTile
          label="Efficiency"
          value={fmtPct(efficiency, 1)}
          tone={efficiency >= 0.95 ? 'var(--success-text)' : undefined}
        />
      </StatTileRow>

      <div style={{ height: 16 }} />

      <div className="grid-2">
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Optimal lineup</span>
            <span className="mono">{fmt1(optimalTotal)}</span>
          </div>

          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Player</th>
                  <th className="num">Points</th>
                  <th>Started?</th>
                </tr>
              </thead>
              <tbody>
                {optimalLineup.assignments.map((a) => {
                  const player = a.pid ? data.playersById.get(a.pid) : undefined;
                  const wasStarted = a.pid ? startedIds.has(a.pid) : false;
                  return (
                    <tr key={`${a.slot}-${a.slotIndex}`}>
                      <td className="tiny bold muted">{fmtSlot(a.slot)}</td>
                      <td>
                        {a.pid ? (
                          <button
                            className="row"
                            style={{ gap: 8, textAlign: 'left' }}
                            onClick={() => setOpenPid(a.pid)}
                          >
                            <img
                              src={playerHeadshot(a.pid) ?? undefined}
                              alt=""
                              width={26}
                              height={26}
                              loading="lazy"
                              style={{ borderRadius: '50%', background: 'var(--surface-sunken)' }}
                              onError={(e) => {
                                const img = e.currentTarget;
                                const fb = teamLogo(player?.team);
                                if (fb && img.src !== fb) img.src = fb;
                                else img.style.visibility = 'hidden';
                              }}
                            />
                            <span style={{ fontWeight: 600 }}>{playerName(player, a.pid)}</span>
                          </button>
                        ) : (
                          <span className="muted">— empty —</span>
                        )}
                      </td>
                      <td className="num bold">{fmt1(a.points)}</td>
                      <td>
                        {a.pid ? (
                          wasStarted ? (
                            <span className="chip" style={{ color: 'var(--success-text)' }}>
                              ▲ yes
                            </span>
                          ) : (
                            <span className="chip" style={{ color: 'var(--danger-text)' }}>
                              ▼ benched
                            </span>
                          )
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="stack">
          {missed.length > 0 && (
            <section className="card card-pad">
              <div className="section-title">Misses this week</div>
              <div className="stack" style={{ gap: 6 }}>
                {missed.map((a) => {
                  const player = a.pid ? data.playersById.get(a.pid) : undefined;
                  return (
                    <button
                      key={a.pid}
                      className="row-between"
                      style={{ width: '100%', padding: '6px 0' }}
                      onClick={() => a.pid && setOpenPid(a.pid)}
                    >
                      <span className="row" style={{ gap: 8, minWidth: 0 }}>
                        <span className="chip chip-outline">{fmtSlot(a.slot)}</span>
                        <span style={{ fontWeight: 600 }}>{playerName(player, a.pid!)}</span>
                      </span>
                      <span className="mono bold">{fmt1(a.points)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <section className="card" style={{ overflow: 'hidden' }}>
            <div className="group-head group-head--primary">
              <span>League lineup efficiency — week {week}</span>
            </div>
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th className="num">{played ? 'Actual' : 'Lineup'}</th>
                    <th className="num">Optimal</th>
                    <th className="num">Eff.</th>
                  </tr>
                </thead>
                <tbody>
                  {leagueEfficiency.map((row) => (
                    <tr
                      key={row.teamId}
                      style={
                        row.teamId === teamId
                          ? { background: 'var(--accent-wash)' }
                          : undefined
                      }
                    >
                      <td>
                        <button onClick={() => setSelectedTeamId(row.teamId)}>
                          {row.name}
                        </button>
                      </td>
                      <td className="num">{fmt1(row.actual)}</td>
                      <td className="num muted">{fmt1(row.optimal)}</td>
                      <td className="num bold">{fmtPct(row.efficiency, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <Heatmap
            title={`ESPN projected points by position — week ${week}`}
            rows={heatmapRows}
            selectedTeamId={teamId}
            onSelectTeam={setSelectedTeamId}
          />
        </div>
      </div>

      <PlayerModal pid={openPid} week={week} onClose={() => setOpenPid(null)} />
    </>
  );
}
