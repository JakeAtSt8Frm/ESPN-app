/**
 * Small shared display primitives.
 *
 * The one rule these all follow: a colour never carries meaning by itself.
 * Every status ships an icon and a text label, and every coloured chip prints
 * its own number, so the display stays readable under colour-vision deficiency,
 * greyscale printing and forced-colours mode.
 */

import { useTheme } from './ThemeProvider';
import { matchupScoreFill, valueScoreFill } from '../lib/colors';
import { MATCHUP_INFLUENCE_FLOOR } from '../lib/matchup';
import { useMatchupInfluence } from '../data/LeagueProvider';
import { fmtSlot } from '../lib/labels';
import { statusTone } from '../lib/status';
import type { PlayerStatus, PositionGroup, StatusLabel } from '../lib/types';

/** Icon per status — the secondary channel that makes colour non-essential. */
const STATUS_ICON: Record<StatusLabel, string> = {
  'Major Boom': '▲▲',
  Boom: '▲',
  'In Range': '—',
  Bust: '▼',
  'Major Bust': '▼▼',
  'Not Played': '·',
  'No Proj': '·',
};

export function StatusBadge({ status, compact }: { status: PlayerStatus; compact?: boolean }) {
  const tone = statusTone(status.label);
  return (
    <span
      className="chip"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
      title={status.label}
    >
      <span aria-hidden="true">{STATUS_ICON[status.label]}</span>
      {!compact && status.label}
    </span>
  );
}

/**
 * Value Score chip (0–1000).
 *
 * Sequential single-hue fill for magnitude; the number itself sits in whichever
 * ink contrasts against the generated fill rather than being colour-coded.
 */
export function ValueChip({ score }: { score: number | null }) {
  const { mode } = useTheme();
  const { background, ink } = valueScoreFill(score, mode);

  return (
    <span
      className="chip mono"
      style={{ background, color: ink }}
      title={score === null
        ? 'Value unavailable — no scored production and no rest-of-season projection'
        : `Value Score ${score} of 1000 — rated against others at the same position`}
      aria-label={`Value Score ${score ?? 'unavailable'} of 1000, within position`}
    >
      {score === null ? '—' : score}
    </span>
  );
}

/**
 * Matchup Score chip (0–100). Higher means a more favorable matchup.
 *
 * The number is shown as measured, never rescaled. But how much a matchup moves
 * a result varies enormously by position — it is worth real points to a
 * quarterback and nothing measurable to a linebacker — and a column of
 * identical-looking chips down a 21-man lineup invites reading them as equally
 * meaningful. Where the rating has no demonstrated predictive power, the chip is
 * dimmed and says so, rather than presenting noise with the same confidence as
 * signal.
 */
export function MatchupChip({
  score,
  group,
}: {
  score: number | null;
  group?: PositionGroup | null;
}) {
  const { mode } = useTheme();
  const { background, ink } = matchupScoreFill(score, mode);
  const influenceByGroup = useMatchupInfluence();
  const influence = group ? influenceByGroup[group] : 1;
  const weak = influence < MATCHUP_INFLUENCE_FLOOR;

  return (
    <span
      className={`chip mono${weak ? ' chip--weak' : ''}`}
      style={{ background, color: ink }}
      title={
        score === null
          ? 'No matchup data'
          : weak
            ? `Matchup rating ${Math.round(score)} of 100 — but the opponent barely moves ${group} scoring, so this is close to noise`
            : `Matchup rating ${Math.round(score)} of 100`
      }
    >
      {score === null ? '—' : Math.round(score)}
    </span>
  );
}

/** A single headline number with its label. */
export function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="card card-pad" style={{ minWidth: 0 }}>
      <div className="tiny muted bold" style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div
        className="mono"
        style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.15, color: tone ?? 'var(--text-primary)' }}
      >
        {value}
      </div>
      {sub && <div className="tiny muted">{sub}</div>}
    </div>
  );
}

export function StatTileRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 10,
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Placement marker for a finished season.
 *
 * Only rendered when the playoff bracket has resolved, so it never appears
 * mid-season or on a league that hasn't played its final.
 */
export function PlacementBadge({ placement }: { placement: number | null }) {
  if (placement === null || placement > 3) return null;

  const marks: Record<number, { icon: string; label: string }> = {
    1: { icon: '🏆', label: 'League champion' },
    2: { icon: '🥈', label: 'Runner-up' },
    3: { icon: '🥉', label: 'Third place' },
  };

  const mark = marks[placement];
  if (!mark) return null;

  return (
    <span title={mark.label} aria-label={mark.label} role="img">
      {mark.icon}
    </span>
  );
}

/** Position group badge. */
export function PosBadge({ group, slot }: { group: string | null; slot?: string }) {
  const text = slot && slot !== group ? fmtSlot(slot) : (group ?? '—');
  return (
    <span className="chip chip-outline" style={{ minWidth: 34, justifyContent: 'center' }}>
      {text}
    </span>
  );
}

/**
 * Head-to-head win probability as a two-sided bar.
 *
 * Both percentages are printed and each side carries its team's own colour, so
 * the bar is reinforcement rather than the only channel — the same rule the
 * rest of this file follows.
 */
export function WinProbBar({
  homeProb,
  awayProb,
  homeColor,
  awayColor,
  label,
}: {
  homeProb: number;
  awayProb: number;
  homeColor: string;
  awayColor: string;
  label: string;
}) {
  const home = Math.round(homeProb * 100);
  const away = Math.round(awayProb * 100);

  return (
    <div
      className="winprob"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={home}
      aria-valuetext={`${home}% to ${away}%`}
    >
      <span className="winprob__fill" style={{ width: `${homeProb * 100}%`, background: homeColor }} />
      <span
        className="winprob__fill winprob__fill--away"
        style={{ width: `${awayProb * 100}%`, background: awayColor }}
      />
    </div>
  );
}

/**
 * A projected range: the central estimate with its 10th–90th percentile band.
 *
 * The interval is the point of the forecast model, so it is shown wherever the
 * central number is — quoting a single number would throw away the part that
 * was actually measured.
 */
export function RangeReadout({
  median,
  low,
  high,
  size = 15,
}: {
  median: number;
  low: number;
  high: number;
  size?: number;
}) {
  return (
    <span className="mono" title={`Projected ${median.toFixed(1)}, 80% of outcomes between ${low.toFixed(1)} and ${high.toFixed(1)}`}>
      <span style={{ fontSize: size, fontWeight: 700 }}>{median.toFixed(1)}</span>{' '}
      <span className="tiny muted">
        {low.toFixed(0)}–{high.toFixed(0)}
      </span>
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row" style={{ gap: 10, padding: 24, justifyContent: 'center' }}>
      <span
        aria-hidden="true"
        style={{
          width: 18,
          height: 18,
          border: '2px solid var(--border-strong)',
          borderTopColor: 'var(--accent)',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }}
      />
      <span className="muted small">{label ?? 'Loading…'}</span>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card card-pad" style={{ textAlign: 'center', padding: 32 }}>
      <div className="bold">{title}</div>
      {hint && (
        <div className="small muted" style={{ marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** Formats a score to one decimal place, or an em dash when absent. */
export function fmt1(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(1);
}

export function fmtSigned(n: number): string {
  const s = n.toFixed(1);
  return n > 0 ? `+${s}` : s;
}

export function fmtPct(n: number | null | undefined, digits = 0): string {
  return n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : `${(n * 100).toFixed(digits)}%`;
}
