/**
 * Settings popover.
 *
 * Four things live here, and each exists because the snapshot cannot know it.
 *
 * *Which league* — one ESPN account belongs to several, each pulled into its own
 * snapshot with its own scoring and its own fitted models. Switching reloads
 * from the other directory rather than re-deriving anything, so the two can
 * never be half-mixed.
 *
 * *Your team* — the snapshot is generated from one ESPN account, but anybody in
 * the league can open the page, so the app has no way to infer whose roster to
 * open on. It asks once and remembers.
 *
 * *Which season the production comes from* — the app switches from last
 * season's finishes to this season's after four weeks, which is the right
 * default and the wrong answer for a couple of real jobs. Somebody weighing a
 * trade in October, or reading a player who has missed a month, wants last
 * year's numbers back; by then the app has stopped offering them. Both indexes
 * are already in memory — the pull carries three finished seasons and the fit
 * distils them — so this is a view over loaded data, not a load.
 *
 * *Snapshot age, and doing something about it* — every number in the app is as
 * fresh as the last snapshot and no fresher. That is invisible unless it is
 * stated, and during games it is the difference between a live score and a
 * stale one. A local server can pull immediately; the hosted page reloads the
 * newest snapshot published by the scheduled GitHub Actions workflow, and links
 * out to that workflow so a stale snapshot has a way forward rather than just a
 * disclosure.
 */

/**
 * Where the hosted page sends someone who wants a pull *now*.
 *
 * The page cannot run one itself and should not be able to. A pull needs the
 * ESPN cookies, and the only safe place for those is a repository secret and a
 * Node process on a runner — putting a token in the bundle to trigger the
 * workflow directly would hand every visitor the ability to spend the account's
 * Actions minutes, and `fetch` cannot set `Cookie` for ESPN anyway.
 *
 * So it links. One click here, one click on `Run workflow` there. Deliberately
 * a quiet link rather than a button: it only does anything for someone with
 * write access to the repository, which is one person in an eight-team league.
 */
const RUN_WORKFLOW_URL =
  'https://github.com/JakeAtSt8Frm/ESPN-app/actions/workflows/deploy.yml';

import { useEffect, useRef } from 'react';
import { useLeague } from '../data/LeagueProvider';
import type { StatsSeason } from '../data/league';
import { fmtLeagueFormat } from '../lib/labels';

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
  const {
    data,
    leagues,
    league,
    setLeagueKey,
    selectedTeamId,
    setSelectedTeamId,
    statsSeason,
    setStatsSeason,
    refresh,
    refreshState,
    canPull,
  } = useLeague();
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

      {leagues.length > 1 && (
        <label className="settings__field">
          <span className="settings__label">League</span>
          <select
            className="select"
            value={league.key}
            onChange={(e) => setLeagueKey(e.target.value)}
            disabled={busy}
          >
            {leagues.map((option) => (
              <option key={option.key} value={option.key}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="settings__field">
        <span className="settings__label">My team</span>
        <select
          className="select"
          value={selectedTeamId ?? ''}
          onChange={(e) => setSelectedTeamId(Number(e.target.value))}
          disabled={!data}
        >
          {(data?.teams ?? []).map((team) => (
            <option key={team.teamId} value={team.teamId}>
              {team.name}
            </option>
          ))}
        </select>
      </label>

      <p className="settings__hint">
        {data ? (
          <>
            Every page opens on this team. Scoring, rosters and results are read
            from <strong>{data.league.name}</strong> ({data.season}).{' '}
            {fmtLeagueFormat(data.league)}.
          </>
        ) : (
          <>Loading {league.name}…</>
        )}
      </p>

      {/*
        Hidden rather than disabled when there is nothing to pin to. A snapshot
        that has never been through `npm run fit:priors` has no prior ranks, and
        a control whose only interesting option cannot be chosen is worse than
        no control.
      */}
      {data?.priorRanks && (
        <>
          <label className="settings__field">
            <span className="settings__label">Player stats</span>
            <select
              className="select"
              value={statsSeason}
              onChange={(e) => setStatsSeason(e.target.value as StatsSeason)}
            >
              <option value="auto">Automatic</option>
              <option value="prior">{data.priorRanks.season} season</option>
              <option value="current">{data.currentRanks.season} season</option>
            </select>
          </label>

          <p className="settings__hint">
            Which season PPG, Total and Boom Rate report — the three chips on
            every player row, and the sorts that use them.{' '}
            {statsSeason === 'auto' ? (
              <>
                Automatic reads {data.priorRanks.season} until{' '}
                {data.currentRanks.season} has four weeks in it, then switches.
                Currently showing{' '}
                <strong>{data.ranks.season}</strong>.
              </>
            ) : statsSeason === 'prior' ? (
              <>
                Pinned to <strong>{data.priorRanks.season}</strong> — last
                season's finished games, scored under this league's settings.
                Value, projections and matchup ratings are unaffected; those
                always use everything known today.
              </>
            ) : (
              <>
                Pinned to <strong>{data.currentRanks.season}</strong>. A season
                with few games behind it ranks a thin pool, and players who have
                not played show no rank at all.
              </>
            )}
          </p>
        </>
      )}

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
              Reloads the newest published snapshot. GitHub Actions handles the
              ESPN pull —{' '}
              <a
                href={RUN_WORKFLOW_URL}
                target="_blank"
                rel="noreferrer noopener"
                title="Opens the deploy workflow on GitHub. Run workflow pulls both leagues from ESPN and republishes, then Reload here picks it up. Needs write access to the repository."
              >
                run one now
              </a>
              , then Reload once it finishes.
            </div>
          )}
        </>
      )}
    </div>
  );
}
