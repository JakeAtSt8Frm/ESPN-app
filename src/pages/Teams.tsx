/**
 * Teams — the roster view.
 *
 * Starters are grouped by slot type rather than listed in raw roster order,
 * because with 21 starting slots (four LB, three DL, three DB) a flat list is
 * unreadable. Each group shows its own projected/actual subtotal so positional
 * strengths and holes are visible without leaving the page.
 */

import { useMemo, useState } from 'react';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { buildHeatmap, buildRankHeatmap, buildRosterWeek } from '../data/selectors';
import {
  appProjectionFor,
  projectedLineupTotal,
  weekForecasts,
} from '../data/predictions';
import { PlayerRow } from '../components/PlayerRow';
import { PlayerModal } from '../components/PlayerModal';
import { Heatmap } from '../components/Heatmap';
import {
  EmptyState,
  PlacementBadge,
  StatTile,
  StatTileRow,
  fmt1,
  fmtPct,
} from '../components/primitives';
import { fmtSlot } from '../lib/labels';
import type { EnrichedPlayer } from '../lib/types';
import type { HeatmapMetric, HeatmapScope } from '../data/selectors';

/**
 * Display labels for starter slots, and which slots share a heading.
 *
 * This is a label table, not the render order — the order comes from the
 * league's own lineup card, and any slot missing from here still renders under
 * its raw name. That indirection is the fix for the bug this replaced: the list
 * used to be the render order itself, hand-maintained, and it had been carried
 * over from the IDP dynasty league this app descends from. It carried
 * Defensive Line, Linebackers, Defensive Backs and an IDP flex, none of which
 * this league starts — and no entry at all for D/ST, which it does. The result
 * was a Teams page that counted nine starters and drew eight, silently, with
 * the team defence missing from every roster.
 */
const SLOT_LABELS: Array<{ key: string; label: string; slots: string[] }> = [
  { key: 'QB', label: 'Quarterback', slots: ['QB'] },
  { key: 'RB', label: 'Running Backs', slots: ['RB'] },
  { key: 'WR', label: 'Wide Receivers', slots: ['WR'] },
  { key: 'TE', label: 'Tight End', slots: ['TE'] },
  {
    key: 'FLEX',
    label: 'Flex',
    slots: ['SUPER_FLEX', 'OP', 'FLEX', 'WRRB_FLEX', 'RBWR_FLEX', 'REC_FLEX', 'WRTE_FLEX', 'RBWRTE'],
  },
  { key: 'DST', label: 'Defense / Special Teams', slots: ['D/ST', 'DST'] },
  { key: 'K', label: 'Kicker', slots: ['K'] },
  { key: 'DL', label: 'Defensive Line', slots: ['DL'] },
  { key: 'LB', label: 'Linebackers', slots: ['LB'] },
  { key: 'DB', label: 'Defensive Backs', slots: ['DB'] },
  { key: 'IDP', label: 'IDP Flex', slots: ['IDP_FLEX', 'DP'] },
];

/** Slot -> the heading it belongs under. */
const GROUP_BY_SLOT = new Map<string, { key: string; label: string }>();
for (const group of SLOT_LABELS) {
  for (const slot of group.slots) {
    GROUP_BY_SLOT.set(slot.toUpperCase(), { key: group.key, label: group.label });
  }
}

export function TeamsPage() {
  const data = useLeagueData();
  const { week, selectedTeamId, setSelectedTeamId } = useLeague();
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [scope, setScope] = useState<HeatmapScope>('starters');
  /*
   * Before a game is played, "actual" is a grid of zeroes and the projections
   * are the only thing on the page worth looking at. The toggle still works
   * either way; this only picks the side that has numbers on it.
   */
  const [metric, setMetric] = useState<HeatmapMetric>(
    data.currentWeek > 0 ? 'actual' : 'projected',
  );

  const teamId = selectedTeamId ?? data.teams[0]?.teamId ?? null;

  const rosterWeek = useMemo(
    () => (teamId === null ? null : buildRosterWeek(data, teamId, week)),
    [data, teamId, week],
  );

  /* Pregame keeps the displayed projection stable after kickoff; live results
     belong in the actual column, not inside a number still labelled projected. */
  const forecasts = useMemo(() => weekForecasts(data, week, 'pregame'), [data, week]);

  const appProjectedTotal = useMemo(
    () =>
      rosterWeek
        ? projectedLineupTotal(rosterWeek.starters, forecasts, 'app')
        : 0,
    [forecasts, rosterWeek],
  );

  const heatmapRows = useMemo(
    () => buildHeatmap(data, week, scope, metric),
    [data, week, scope, metric],
  );

  // The rank grid is derived from the points grid, so it follows the same
  // scope/metric and always agrees with the numbers above it.
  const rankRows = useMemo(() => buildRankHeatmap(heatmapRows), [heatmapRows]);

  /*
   * Headings come from the league's own starting lineup, in its own order, so a
   * slot it starts cannot be left out of the page. Anything the label table
   * doesn't recognise still gets a heading, under the slot's own name — a
   * missing label is a cosmetic problem and a missing starter is not.
   */
  const grouped = useMemo(() => {
    if (!rosterWeek) return [];

    const order: Array<{ key: string; label: string }> = [];
    const seen = new Set<string>();
    for (const slot of data.starterSlots) {
      const upper = slot.toUpperCase();
      const group = GROUP_BY_SLOT.get(upper) ?? { key: upper, label: fmtSlot(slot) };
      if (seen.has(group.key)) continue;
      seen.add(group.key);
      order.push(group);
    }

    const assigned = new Set<string>();
    const groups = order.map((group) => {
      const players = rosterWeek.starters.filter((p) => {
        const upper = p.slot.toUpperCase();
        const match = (GROUP_BY_SLOT.get(upper)?.key ?? upper) === group.key;
        if (match) assigned.add(p.pid);
        return match;
      });
      return { ...group, players };
    });

    // Nothing on the field goes unrendered, whatever the lineup card says.
    const orphans = rosterWeek.starters.filter((p) => !assigned.has(p.pid));
    if (orphans.length) {
      groups.push({ key: 'OTHER', label: 'Other starters', players: orphans });
    }

    return groups.filter((g) => g.players.length > 0);
  }, [rosterWeek, data.starterSlots]);

  if (!rosterWeek) {
    return <EmptyState title="No team selected" />;
  }

  const { team, starters, bench, injured, projectedTotal, actualTotal, optimalTotal, efficiency } =
    rosterWeek;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">
          {team.name} <PlacementBadge placement={team.placement} />
        </h1>
      </div>

      {/* Team switcher */}
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
        <StatTile label="Actual Score" value={fmt1(actualTotal)} />
        <StatTile
          label="App Projection"
          value={fmt1(appProjectedTotal)}
          sub="historical bias + matchup adjusted"
        />
        <StatTile label="ESPN Projection" value={fmt1(projectedTotal)} />
        <StatTile label="Optimal" value={fmt1(optimalTotal)} />
        <StatTile
          label="Efficiency"
          value={fmtPct(efficiency, 1)}
          tone={
            efficiency >= 0.95
              ? 'var(--success-text)'
              : efficiency < 0.8
                ? 'var(--danger-text)'
                : undefined
          }
        />
      </StatTileRow>

      <div style={{ height: 16 }} />

      {/*
        Roster and heatmap sit side by side on a wide screen so the heatmap is
        visible without scrolling; below 1080px they stack. The split is gated on
        page width because a player line needs ~560px for the name plus its Value
        and positional ranks before the name starts truncating.
      */}
      <div className="split-roster">
        <div className="stack">
          {/* ---- Starters, grouped by slot ---- */}
          <section className="card" style={{ overflow: 'hidden' }}>
            <div className="group-head group-head--primary">
              <span>Starters ({starters.length})</span>
              <span className="mono">
                <span className="projection-app">{fmt1(appProjectedTotal)} app</span>
                {' · '}{fmt1(projectedTotal)} ESPN · {fmt1(actualTotal)} act
              </span>
            </div>

            {grouped.map((group) => (
              <div key={group.key}>
                <div className="group-head">
                  <span>{group.label}</span>
                  <span className="mono">{fmt1(sum(group.players, (p) => p.act))}</span>
                </div>
                {group.players.map((p) => (
                  <PlayerRow
                    key={p.pid}
                    player={p}
                    appProjection={appProjectionFor(p, forecasts)}
                    onSelect={setOpenPid}
                  />
                ))}
              </div>
            ))}
          </section>

          {/* ---- Bench ---- */}
          {bench.length > 0 && (
            <section className="card" style={{ overflow: 'hidden' }}>
              <div className="group-head group-head--primary">
                <span>Bench ({bench.length})</span>
                <span className="mono">{fmt1(sum(bench, (p) => p.act))}</span>
              </div>
              {bench.map((p) => (
                <PlayerRow
                  key={p.pid}
                  player={p}
                  appProjection={appProjectionFor(p, forecasts)}
                  onSelect={setOpenPid}
                />
              ))}
            </section>
          )}

          {/* ---- Injured reserve ---- */}
          {injured.length > 0 && (
            <section className="card" style={{ overflow: 'hidden' }}>
              <div className="group-head group-head--primary">
                <span>IR ({injured.length})</span>
              </div>
              {injured.map((p) => (
                <PlayerRow
                  key={p.pid}
                  player={p}
                  appProjection={appProjectionFor(p, forecasts)}
                  onSelect={setOpenPid}
                />
              ))}
            </section>
          )}
        </div>

        {/* ---- Heatmap + status ---- */}
        <div className="stack split-roster__aside">
          <div className="filters" style={{ marginBottom: 0 }}>
            <div className="segmented" role="group" aria-label="Heatmap scope">
              <button aria-pressed={scope === 'starters'} onClick={() => setScope('starters')}>
                Starters
              </button>
              <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
                Full roster
              </button>
            </div>
            <div className="segmented" role="group" aria-label="Heatmap metric">
              <button aria-pressed={metric === 'actual'} onClick={() => setMetric('actual')}>
                Actual
              </button>
              <button aria-pressed={metric === 'projected'} onClick={() => setMetric('projected')}>
                Projected
              </button>
            </div>
          </div>

          <Heatmap
            title="Weekly Points Per Position"
            rows={heatmapRows}
            selectedTeamId={teamId}
            onSelectTeam={setSelectedTeamId}
          />

          <Heatmap
            title="Weekly Rank Per Position"
            variant="rank"
            rows={rankRows}
            selectedTeamId={teamId}
            onSelectTeam={setSelectedTeamId}
          />

          <div className="card card-pad">
            <div className="section-title">Status breakdown</div>
            <StatusSummary players={starters} />
          </div>
        </div>
      </div>

      <PlayerModal pid={openPid} week={week} onClose={() => setOpenPid(null)} />
    </>
  );
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return Math.round(items.reduce((s, i) => s + pick(i), 0) * 100) / 100;
}

/** Counts of each boom/bust classification across a lineup. */
function StatusSummary({ players }: { players: EnrichedPlayer[] }) {
  const counts = new Map<string, number>();
  for (const p of players) {
    counts.set(p.status.label, (counts.get(p.status.label) ?? 0) + 1);
  }

  const order = ['Major Boom', 'Boom', 'In Range', 'Bust', 'Major Bust', 'Not Played'];
  const rows = order.filter((label) => counts.has(label));

  if (!rows.length) return <div className="small muted">No results yet this week.</div>;

  const total = players.length;

  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((label) => {
        const n = counts.get(label)!;
        return (
          <div key={label} className="row" style={{ gap: 8 }}>
            <span className="small" style={{ minWidth: 92 }}>
              {label}
            </span>
            <span
              style={{
                flex: 1,
                height: 8,
                borderRadius: 999,
                background: 'var(--surface-sunken)',
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${(n / total) * 100}%`,
                  background: 'var(--accent)',
                }}
              />
            </span>
            <span className="mono small" style={{ minWidth: 20, textAlign: 'right' }}>
              {n}
            </span>
          </div>
        );
      })}
    </div>
  );
}
