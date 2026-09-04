/**
 * Chart components, isolated so Recharts can be code-split out of the initial
 * bundle. It is ~114KB gzipped — larger than the rest of the app combined —
 * and nothing on first paint needs it, so it loads only when a chart is about
 * to render.
 *
 * Score charts use the validated series palette; the standings-rank chart uses
 * the same stable team colours as the rest of the app. Every mark is paired
 * with its series or team name so data is never available by colour alone.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const AXIS = {
  stroke: 'var(--text-muted)',
  tick: { fontSize: 11 },
  tickLine: false,
} as const;

const TOOLTIP_STYLE = {
  background: 'var(--surface-raised)',
  border: '1px solid var(--border-strong)',
  borderRadius: 8,
  fontSize: 12,
} as const;

export interface WeekPoint {
  week: string;
  projected: number | null;
  actual: number;
  optimal?: number;
}

export interface TeamRankSeries {
  teamId: number;
  dataKey: string;
  name: string;
  color: string;
}

export type TeamRankPoint = {
  week: string;
} & Record<string, string | number | null>;

/** Weekly projected vs actual (and optionally optimal) custom score. */
export function WeeklyScoreChart({
  data,
  height = 240,
  showOptimal = false,
}: {
  data: WeekPoint[];
  height?: number;
  showOptimal?: boolean;
}) {
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="week" {...AXIS} axisLine={{ stroke: 'var(--border-strong)' }} />
          <YAxis {...AXIS} axisLine={false} width={44} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: 'var(--text-primary)', fontWeight: 700 }}
            formatter={(v, name) => [
              typeof v === 'number' ? v.toFixed(2) : 'no projection',
              String(name),
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            type="monotone"
            dataKey="projected"
            name="Projected"
            stroke="var(--series-1)"
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={{ r: 3 }}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="actual"
            name="Actual"
            stroke="var(--series-2)"
            strokeWidth={2}
            dot={{ r: 4 }}
          />
          {showOptimal && (
            <Line
              type="monotone"
              dataKey="optimal"
              name="Optimal"
              stroke="var(--series-3)"
              strokeWidth={2}
              strokeDasharray="2 3"
              dot={{ r: 3 }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Each team's cumulative W/L rank for every week, with first place at the top. */
export function WeeklyTeamRankChart({
  data,
  teams,
  height = 280,
}: {
  data: TeamRankPoint[];
  teams: TeamRankSeries[];
  height?: number;
}) {
  const ticks = Array.from({ length: teams.length }, (_, index) => index + 1);

  return (
    <div className="rank-chart">
      <div className="rank-chart__legend" aria-label="Team colors">
        {teams.map((team) => (
          <span key={team.teamId} className="rank-chart__legend-item">
            <i
              className="rank-chart__legend-dot"
              style={{ background: team.color }}
              aria-hidden="true"
            />
            {team.name}
          </span>
        ))}
      </div>
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 10, left: -12, bottom: 0 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis
              dataKey="week"
              {...AXIS}
              axisLine={{ stroke: 'var(--border-strong)' }}
              minTickGap={18}
            />
            <YAxis
              {...AXIS}
              axisLine={false}
              width={42}
              domain={[1, Math.max(1, teams.length)]}
              ticks={ticks}
              reversed
              allowDecimals={false}
              tickFormatter={(value) => `#${value}`}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelStyle={{ color: 'var(--text-primary)', fontWeight: 700 }}
              formatter={(value, name) => [
                typeof value === 'number' ? `#${value}` : '—',
                String(name),
              ]}
              itemSorter={(item) =>
                typeof item.value === 'number' ? item.value : Number.MAX_SAFE_INTEGER
              }
            />
            {teams.map((team) => (
              <Line
                key={team.teamId}
                type="monotone"
                dataKey={team.dataKey}
                name={team.name}
                stroke={team.color}
                strokeWidth={2}
                dot={{ r: 3, fill: team.color }}
                activeDot={{ r: 5 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Single-measure weekly bar chart, e.g. points left on the bench. */
export function WeeklyBarChart({
  data,
  dataKey,
  label,
  height = 200,
}: {
  data: Array<Record<string, unknown>>;
  dataKey: string;
  label: string;
  height?: number;
}) {
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="week" {...AXIS} axisLine={{ stroke: 'var(--border-strong)' }} />
          <YAxis {...AXIS} axisLine={false} width={44} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v) => [typeof v === 'number' ? v.toFixed(2) : '—', label]}
          />
          <Bar dataKey={dataKey} fill="var(--series-2)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
