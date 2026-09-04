/**
 * Positional heatmap: teams down the side, positions across the top.
 *
 * In the default `points` variant, colour encodes each cell's standing *within
 * its own column*, diverging around the league median — so a cell reads as
 * "strong / typical / weak at this position relative to the rest of the league".
 * Normalising per column matters because the columns aren't comparable in raw
 * points: in this league a starting LB corps routinely outscores the QB slot.
 *
 * In the `rank` variant the cell already *is* a rank (1 = best that week), so
 * colour maps straight from rank — first green, last red — and the cell prints
 * the ordinal. Either way the number carries the value, with colour reinforcing.
 */

import { useMemo, useState } from 'react';
import { useTheme } from './ThemeProvider';
import { divergingPosition, heatmapCell } from '../lib/colors';
import { HEATMAP_COLUMNS, type HeatmapColumn, type HeatmapRow } from '../data/selectors';

interface Props {
  title: string;
  rows: HeatmapRow[];
  /** 'points' shows scores; 'rank' shows each team's 1..N rank per column. */
  variant?: 'points' | 'rank';
  /** Highlights this team's row. */
  selectedTeamId?: number | null;
  onSelectTeam?: (teamId: number) => void;
}

/** 1 -> "1st", 2 -> "2nd", ... */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

export function Heatmap({
  title,
  rows,
  variant = 'points',
  selectedTeamId,
  onSelectTeam,
}: Props) {
  const { mode } = useTheme();
  const [showTable, setShowTable] = useState(false);
  const isRank = variant === 'rank';

  // Per-column value lists drive the points variant's diverging normalisation.
  const columns = useMemo(() => {
    const byGroup = new Map<HeatmapColumn, number[]>();
    for (const c of HEATMAP_COLUMNS) {
      byGroup.set(
        c,
        rows.map((r) => r.byGroup[c]),
      );
    }
    return { byGroup, totals: rows.map((r) => r.total) };
  }, [rows]);

  // Columns nobody scored in are hidden — with a 6-team league, an empty column
  // is noise rather than information.
  const activeColumns = useMemo(
    () => HEATMAP_COLUMNS.filter((c) => columns.byGroup.get(c)!.some((v) => v !== 0)),
    [columns],
  );

  if (!rows.length) return null;

  // Rank colour runs straight from the rank: 1 = best (green), N = worst (red).
  const colorFor = (value: number, column: number[], isSelected: boolean) => {
    if (showTable) return null;
    const t = isRank
      ? rows.length > 1
        ? (rows.length - value) / (rows.length - 1)
        : 0.5
      : divergingPosition(value, column);
    return heatmapCell(t, mode, isSelected);
  };

  const display = (value: number) => (isRank ? ordinal(value) : value.toFixed(1));

  return (
    <figure className="card" style={{ margin: 0, overflow: 'hidden' }}>
      <figcaption className="row-between heatmap__caption">
        <div className="bold heatmap__title">{title}</div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowTable((v) => !v)}
          aria-pressed={showTable}
        >
          {showTable ? 'Heatmap' : 'Table'}
        </button>
      </figcaption>

      <div
        className="scroll-x heatmap-scroll"
        role="region"
        aria-label={`${title} table`}
        tabIndex={0}
      >
        <table className="heatmap" aria-label={title}>
          <colgroup>
            <col className="heatmap__team-col" />
            <col span={activeColumns.length + 1} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="heatmap__team-head">
                Team
              </th>
              {activeColumns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isSelected = row.teamId === selectedTeamId;
              return (
                <tr key={row.teamId} className={isSelected ? 'is-selected' : undefined}>
                  <th scope="row" className="heatmap__team">
                    <button
                      type="button"
                      onClick={() => onSelectTeam?.(row.teamId)}
                      className="heatmap__team-btn"
                      title={row.name}
                    >
                      {row.name}
                    </button>
                  </th>

                  {activeColumns.map((c) => {
                    const v = row.byGroup[c];
                    const cell = colorFor(v, columns.byGroup.get(c)!, isSelected);
                    return (
                      <td
                        key={c}
                        className="mono"
                        data-label={c}
                        style={
                          cell ? { background: cell.background, color: cell.ink } : undefined
                        }
                        title={`${row.name} — ${c}: ${display(v)}`}
                      >
                        {display(v)}
                      </td>
                    );
                  })}

                  {(() => {
                    const cell = colorFor(row.total, columns.totals, isSelected);
                    return (
                      <td
                        className="mono bold"
                        data-label="Total"
                        style={
                          cell ? { background: cell.background, color: cell.ink } : undefined
                        }
                        title={`${row.name} — total: ${display(row.total)}`}
                      >
                        {display(row.total)}
                      </td>
                    );
                  })()}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!showTable && (
        <div className="heatmap__legend">
          <span className="tiny muted">{isRank ? 'Last' : 'Below league'}</span>
          <span className="heatmap__ramp" aria-hidden="true">
            {Array.from({ length: 9 }, (_, i) => {
              const { background } = heatmapCell(i / 8, mode);
              return <i key={i} style={{ background }} />;
            })}
          </span>
          <span className="tiny muted">{isRank ? '1st' : 'Above league'}</span>
        </div>
      )}
    </figure>
  );
}
