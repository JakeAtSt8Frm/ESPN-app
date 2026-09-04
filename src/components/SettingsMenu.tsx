/**
 * Settings popover.
 *
 * Two things live here, and both exist because the snapshot cannot know them.
 *
 * *Your team* — the snapshot is generated from one ESPN account, but anybody in
 * the league can open the page, so the app has no way to infer whose roster to
 * open on. It asks once and remembers.
 *
 * *Snapshot age, and doing something about it* — every number in the app is as
 * fresh as the last snapshot and no fresher. That is invisible unless it is
 * stated, and during games it is the difference between a live score and a
 * stale one. A local server can pull immediately; the hosted page reloads the
 * newest snapshot published by the scheduled GitHub Actions workflow.
 */

import { useEffect, useRef } from 'react';
import { useLeague } from '../data/LeagueProvider';

/** "3 minutes ago" — coarse on purpose; precision here would be false. */
function ago(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function SettingsMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, selectedTeamId, setSelectedTeamId, refresh, refreshState, canPull } =
    useLeague();
  const busy = refreshState.phase === 'pulling' || refreshState.phase === 'reloading';
  const ref = useRef<HTMLDivElement>(null);

  // Close on Escape or a click outside the panel.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };

    document.addEventListener('keydown', onKey);
    // Deferred so the click that opened the menu doesn't immediately close it.
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 0);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      clearTimeout(id);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="settings" ref={ref} role="dialog" aria-label="Settings">
      <div className="settings__title">Settings</div>

      <label className="settings__field">
        <span className="settings__label">My team</span>
        <select
          className="select"
          value={selectedTeamId ?? ''}
          onChange={(e) => setSelectedTeamId(Number(e.target.value))}
        >
          {(data?.teams ?? []).map((team) => (
            <option key={team.teamId} value={team.teamId}>
              {team.name}
            </option>
          ))}
        </select>
      </label>

      <p className="settings__hint">
        Every page opens on this team. Scoring, rosters and results are read from{' '}
        <strong>{data?.league.name}</strong> ({data?.season}).
      </p>

      {data && (
        <>
          <div className="settings__meta tiny muted">
            Snapshot taken {ago(data.generatedAt)} &middot; week {data.liveWeek} of{' '}
            {data.playoff.regularSeasonWeeks}
          </div>

          <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn btn-sm" onClick={() => refresh()} disabled={busy}>
              {busy ? 'Refreshing…' : canPull === false ? 'Reload' : 'Refresh from ESPN'}
            </button>
            {canPull !== false && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => refresh({ refit: true })}
                disabled={busy}
                title="Also rebuilds the fitted models over every finished season"
              >
                &amp; refit
              </button>
            )}
          </div>

          {refreshState.phase === 'pulling' && (
            <div className="tiny muted">{refreshState.message}</div>
          )}
          {refreshState.phase === 'error' && (
            <div className="tiny" style={{ color: 'var(--danger-text)' }}>
              {refreshState.message}
            </div>
          )}
          {canPull === false && refreshState.phase === 'idle' && (
            <div className="tiny muted">
              Reloads the newest published snapshot. GitHub Actions handles the ESPN pull.
            </div>
          )}
        </>
      )}
    </div>
  );
}
