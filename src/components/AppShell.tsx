/**
 * Application shell: header controls on every screen, plus navigation that
 * adapts to the viewport — a horizontal tab strip on desktop, a fixed bottom
 * tab bar on phones (thumb-reachable, matching platform convention on iOS).
 *
 * There is no season switcher. The league is in its first season, so there is
 * exactly one to show; a control offering one option is furniture. Its place in
 * the header went to the thing that actually varies — how old the snapshot is.
 */

import { Suspense, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useLeague } from '../data/LeagueProvider';
import { ErrorBoundary } from './ErrorBoundary';
import { Spinner } from './primitives';
import { SettingsMenu } from './SettingsMenu';
import { useHideOnScroll } from './useHideOnScroll';

interface NavItem {
  to: string;
  label: string;
  short: string;
  icon: string;
  /** Starts fetching the route's chunk before the reader commits to the tap. */
  prefetch: () => Promise<unknown>;
}

const NAV: NavItem[] = [
  { to: '/teams', label: 'Teams', short: 'Teams', icon: '▣', prefetch: () => import('../pages/Teams') },
  { to: '/matchups', label: 'Matchups', short: 'Vs', icon: '⟷', prefetch: () => import('../pages/Matchups') },
  { to: '/optimal', label: 'Optimal Lineup', short: 'Optimal', icon: '✦', prefetch: () => import('../pages/Optimal') },
  { to: '/players', label: 'Players', short: 'Players', icon: '⌕', prefetch: () => import('../pages/Players') },
  { to: '/schedule', label: 'Schedule', short: 'Sched', icon: '▦', prefetch: () => import('../pages/Schedule') },
  { to: '/analytics', label: 'Analytics', short: 'Stats', icon: '◨', prefetch: () => import('../pages/Analytics') },
  { to: '/history', label: 'History', short: 'History', icon: '◷', prefetch: () => import('../pages/History') },
  { to: '/trade', label: 'Trade', short: 'Trade', icon: '⇄', prefetch: () => import('../pages/Trade') },
  { to: '/draft', label: 'Draft', short: 'Draft', icon: '◈', prefetch: () => import('../pages/Draft') },
];

/*
 * Routes are code-split (see App.tsx), so the chunk for a page is not on the
 * device until it is visited. Warming it on hover or keyboard focus hides that
 * fetch behind the reader's own reaction time — by the time the tap lands the
 * module is usually parsed. Failure is deliberately ignored: this is an
 * optimisation, and the real navigation will surface any problem itself.
 */
function warm(item: NavItem) {
  void item.prefetch().catch(() => {});
}

export function AppShell() {
  const { status, data, error, progress, week, setWeek, refresh, refreshState, canPull } =
    useLeague();
  const pulling = refreshState.phase === 'pulling' || refreshState.phase === 'reloading';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const headerHidden = useHideOnScroll();
  const location = useLocation();

  const weeks = data ? Array.from({ length: data.maxWeek }, (_, i) => i + 1) : [];
  /*
   * Every number in the app is as fresh as the last snapshot. Six hours is the
   * point at which that stops being a detail — a roster move, an injury or a
   * finished game may have happened since, and the page cannot know.
   */
  const stale = data ? Date.now() - data.generatedAt > 6 * 60 * 60 * 1000 : false;

  return (
    <div className="app">
      {/* Six tab stops separate a keyboard or switch user from the content on
          every single navigation. This is the standard escape hatch: hidden
          until focused, first in the tab order.

          The jump is done in JS rather than left to the `#main` href, because
          this app routes on the hash — letting the fragment navigation through
          would hand "main" to the router as a route and move focus nowhere. The
          href stays so the control is a real link to assistive technology. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          const main = document.getElementById('main');
          main?.focus();
          main?.scrollIntoView();
        }}
      >
        Skip to content
      </a>

      {/* The settings panel hangs off the header, so letting the header slide
          away on scroll would take an open panel with it. */}
      <header className={`topbar${headerHidden && !settingsOpen ? ' is-hidden' : ''}`}>
        <div className="topbar__inner">
          <div className="row" style={{ gap: 10, minWidth: 0 }}>
            <span className="brand">UK-BG</span>
            <span className="topbar__league">
              {data ? data.league.name : 'Loading…'}
            </span>
          </div>

          <div className="row" style={{ gap: 8 }}>
            {weeks.length > 0 && (
              <>
                <label className="sr-only" htmlFor="week-select">
                  Week
                </label>
                <select
                  id="week-select"
                  className="select"
                  value={week}
                  onChange={(e) => setWeek(Number(e.target.value))}
                >
                  {weeks.map((w) => (
                    <option key={w} value={w}>
                      Week {w}
                    </option>
                  ))}
                </select>
              </>
            )}

            <button
              className={`btn btn-ghost btn-sm topbar__icon topbar__icon--refresh${
                pulling ? ' is-busy' : ''
              }`}
              onClick={() => refresh()}
              disabled={pulling}
              aria-label="Refresh data"
              aria-busy={pulling}
              title={
                pulling
                  ? refreshState.phase === 'pulling'
                    ? refreshState.message
                    : 'Reloading'
                  : canPull === false
                    ? 'Reload the latest ESPN snapshot published by GitHub Actions'
                    : 'Pull a new snapshot from ESPN'
              }
            >
              ⟳
            </button>

            <div className="topbar__settings">
              <button
                className={`btn btn-ghost btn-sm topbar__icon${stale ? ' is-active' : ''}`}
                onClick={() => setSettingsOpen((v) => !v)}
                aria-label="Settings"
                aria-expanded={settingsOpen}
                title={stale ? 'Snapshot is more than six hours old' : 'Settings'}
              >
                ⚙
              </button>
              <SettingsMenu open={settingsOpen} onClose={() => setSettingsOpen(false)} />
            </div>
          </div>
        </div>

        {stale && data && (
          <div className="topbar__notice">
            Snapshot is {Math.round((Date.now() - data.generatedAt) / 3600000)} hours old.
            Scores and rosters may have moved since.
          </div>
        )}

        <nav className="tabs" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `tabs__link${isActive ? ' is-active' : ''}`}
              onMouseEnter={() => warm(item)}
              onFocus={() => warm(item)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      {/* tabIndex lets the skip link move focus here, not just the scroll
          position — otherwise the next Tab returns to the top of the header. */}
      <main className="page" id="main" tabIndex={-1}>
        {status === 'loading' && (
          <div style={{ paddingTop: 48 }}>
            <Spinner label={progress ? `${progress.phase}…` : 'Loading league…'} />
            {progress && progress.total > 1 && (
              <div className="progress" role="progressbar" aria-valuenow={progress.loaded} aria-valuemin={0} aria-valuemax={progress.total}>
                <span style={{ width: `${(progress.loaded / progress.total) * 100}%` }} />
              </div>
            )}
            <p className="small muted" style={{ textAlign: 'center', marginTop: 12 }}>
              First load pulls the season snapshot. It's cached after this.
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="card card-pad" style={{ marginTop: 32 }}>
            <h2 className="bold">Couldn't load the league</h2>
            <p className="small muted" style={{ marginTop: 6 }}>
              {error}
            </p>
            <button className="btn" style={{ marginTop: 12 }} onClick={() => refresh()}>
              Try again
            </button>
          </div>
        )}

        {status === 'ready' && data && (
          /* Scoped to the page: a page that throws leaves the header and tabs
             standing, so the reader can navigate out of it. The path resets the
             boundary, which is what makes that recovery work. */
          <ErrorBoundary resetKey={location.pathname} scope="This page">
            <Suspense fallback={<Spinner label="Loading page…" />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>

      <nav className="bottom-nav" aria-label="Main">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `bottom-nav__link${isActive ? ' is-active' : ''}`}
            onTouchStart={() => warm(item)}
            onMouseEnter={() => warm(item)}
            onFocus={() => warm(item)}
          >
            <span className="bottom-nav__icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="bottom-nav__label">{item.short}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
