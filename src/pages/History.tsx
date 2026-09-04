/**
 * History — season-long trends and any past week's detail.
 *
 * The season chart is the one place where "did I actually manage this team
 * well" is answerable: actual against optimal, week by week. A team can score
 * well and still be leaving 60 points a week on the bench.
 */

import { useMemo, useState } from 'react';
import { LazyWeeklyBarChart, LazyWeeklyScoreChart } from '../components/LazyChart';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { appProjectionFor, weekForecasts } from '../data/predictions';
import { buildHeatmap, buildRosterWeek } from '../data/selectors';
import { PlayerRow } from '../components/PlayerRow';
import { PlayerModal } from '../components/PlayerModal';
import { Heatmap } from '../components/Heatmap';
import { EmptyState, StatTile, StatTileRow, fmt1, fmtPct } from '../components/primitives';
import type { HeatmapMetric } from '../data/selectors';

export function HistoryPage() {
  const data = useLeagueData();
  const { selectedTeamId, setSelectedTeamId } = useLeague();
  // Never week 0: before the season starts there is no completed week, and a
  // zero would index a week that does not exist.
  const [historyWeek, setHistoryWeek] = useState(Math.max(1, data.currentWeek));
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [metric, setMetric] = useState<HeatmapMetric>(
    data.currentWeek > 0 ? 'actual' : 'projected',
  );

  const teamId = selectedTeamId ?? data.teams[0]?.teamId ?? null;

  /** Actual / projected / optimal for every week of the season. */
  const season = useMemo(() => {
    if (teamId === null) return [];
    const rows = [];
    for (let w = 1; w <= data.currentWeek; w++) {
      const rw = buildRosterWeek(data, teamId, w);
      if (!rw) continue;
      // A week with no lineup recorded would plot as a misleading zero.
      if (rw.starters.length === 0) continue;
      rows.push({
        week: `W${w}`,
        weekNum: w,
        actual: rw.actualTotal,
        projected: rw.projectedTotal,
        optimal: rw.optimalTotal,
        efficiency: rw.efficiency,
        left: Math.round((rw.optimalTotal - rw.actualTotal) * 100) / 100,
      });
    }
    return rows;
  }, [data, teamId]);

  const totals = useMemo(() => {
    if (!season.length) return null;
    const actual = season.reduce((s, r) => s + r.actual, 0);
    const optimal = season.reduce((s, r) => s + r.optimal, 0);
    const projected = season.reduce((s, r) => s + r.projected, 0);
    return {
      actual,
      optimal,
      projected,
      left: optimal - actual,
      efficiency: optimal > 0 ? actual / optimal : 0,
      avg: actual / season.length,
      best: Math.max(...season.map((r) => r.actual)),
      worst: Math.min(...season.map((r) => r.actual)),
    };
  }, [season]);

  const weekDetail = useMemo(
    () => (teamId === null ? null : buildRosterWeek(data, teamId, historyWeek)),
    [data, teamId, historyWeek],
  );

  const weekForecast = useMemo(
    () => weekForecasts(data, historyWeek, 'pregame'),
    [data, historyWeek],
  );

  const heatmapRows = useMemo(
    () => buildHeatmap(data, historyWeek, 'starters', metric),
    [data, historyWeek, metric],
  );

  if (teamId === null || !totals) {
    return <EmptyState title="No history yet" hint="Play a week first." />;
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">History</h1>
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
      </div>

      <StatTileRow>
        <StatTile label="Season total" value={fmt1(totals.actual)} />
        <StatTile label="Weekly average" value={fmt1(totals.avg)} />
        <StatTile label="Optimal total" value={fmt1(totals.optimal)} />
        <StatTile
          label="Left on bench"
          value={fmt1(totals.left)}
          tone={totals.left > 200 ? 'var(--danger-text)' : undefined}
        />
        <StatTile
          label="Season efficiency"
          value={fmtPct(totals.efficiency, 1)}
          tone={totals.efficiency >= 0.9 ? 'var(--success-text)' : undefined}
        />
        <StatTile label="Best week" value={fmt1(totals.best)} />
        <StatTile label="Worst week" value={fmt1(totals.worst)} />
      </StatTileRow>

      <div style={{ height: 16 }} />

      <div className="stack">
        {/* ---- Season trend ---- */}
        <section className="card card-pad">
          <div className="section-title">Projected Score vs Actual Score vs Optimal, by week</div>
          <LazyWeeklyScoreChart data={season} height={280} showOptimal />
        </section>

        {/* ---- Points left on the bench ---- */}
        <section className="card card-pad">
          <div className="section-title">Points left on the bench, by week</div>
          <LazyWeeklyBarChart data={season} dataKey="left" label="Left on bench" height={200} />
        </section>

        {/* ---- Week detail ---- */}
        <div className="filters" style={{ marginBottom: 0 }}>
          <label className="small bold" htmlFor="history-week">
            Week detail
          </label>
          <select
            id="history-week"
            className="select"
            value={historyWeek}
            onChange={(e) => setHistoryWeek(Number(e.target.value))}
          >
            {season.map((r) => (
              <option key={r.weekNum} value={r.weekNum}>
                Week {r.weekNum} — {fmt1(r.actual)} pts
              </option>
            ))}
          </select>
          <div className="segmented" role="group" aria-label="Heatmap metric">
            <button aria-pressed={metric === 'actual'} onClick={() => setMetric('actual')}>
              Actual
            </button>
            <button aria-pressed={metric === 'projected'} onClick={() => setMetric('projected')}>
              Projected
            </button>
          </div>
        </div>

        {/* Roster runs full width — a player line needs the room for its name
            plus the Value and positional ranks. The heatmap sits below it. */}
        {weekDetail && (
          <section className="card" style={{ overflow: 'hidden' }}>
            <div className="group-head group-head--primary">
              <span>Week {historyWeek} starters</span>
              <span className="mono">{fmt1(weekDetail.actualTotal)}</span>
            </div>
            {weekDetail.starters.map((p) => (
              <PlayerRow
                key={p.pid}
                player={p}
                appProjection={appProjectionFor(p, weekForecast)}
                onSelect={setOpenPid}
              />
            ))}
          </section>
        )}

        <Heatmap
          title={`${metric === 'actual' ? 'Actual' : 'Projected'} points by position — week ${historyWeek}`}
          rows={heatmapRows}
          selectedTeamId={teamId}
          onSelectTeam={setSelectedTeamId}
        />
      </div>

      <PlayerModal pid={openPid} week={historyWeek} onClose={() => setOpenPid(null)} />
    </>
  );
}
