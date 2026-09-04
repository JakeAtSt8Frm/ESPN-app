/**
 * Render-error containment.
 *
 * Everything downstream of `loadLeague` is derived data — value indexes, fitted
 * distributions, matchup matrices — and a single unexpected shape from Sleeper
 * can surface as a throw deep inside a page rather than as a failed fetch. Without
 * a boundary React unmounts the whole tree on the way out, so one bad chart takes
 * the navigation with it and the only recovery is a manual reload.
 *
 * Two are mounted. The inner one wraps the routed page, so the header and tabs
 * survive and the reader can simply walk to another page; it resets on
 * navigation, since the next route is a different render entirely. The outer one
 * wraps the app itself and only catches what the inner one cannot — a failure in
 * the shell or the provider.
 *
 * The cache is the other likely culprit: a persisted payload written by an older
 * build can deserialize into a shape this build doesn't expect, and it would be
 * re-read on every reload. So "clear cached data" is offered alongside the retry
 * rather than left for the reader to find in the settings menu.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { cacheClear } from '../data/cache';

/*
 * Stale-deployment recovery.
 *
 * Routes are code-split, so the loaded entry chunk holds the *filenames* of the
 * page chunks that existed when the tab was opened. Those names are content
 * hashed and the Pages workflow redeploys on a daily cron, so a tab left open
 * overnight is holding names the server no longer has: the next tab tapped in
 * the morning fails to import, not because anything is wrong but because the app
 * moved underneath it.
 *
 * A reload fixes it completely — it refetches index.html and with it the current
 * chunk names. Doing that automatically is right here because there is nothing
 * for the reader to decide and no work to lose; this is a static, read-only app.
 * The timestamp guard is what keeps a genuinely broken deploy from reloading in
 * a loop: after one attempt the error card is shown instead.
 */
const RELOAD_KEY = 'espn.chunkReload';
const RELOAD_COOLDOWN_MS = 10_000;

function isStaleChunk(error: Error): boolean {
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(
    error.message,
  );
}

/** True when the reload was actually started. */
function reloadForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Private browsing blocks sessionStorage. Without somewhere to record the
    // attempt there is no loop guard, so don't start one.
    return false;
  }
  window.location.reload();
  return true;
}

interface Props {
  children: ReactNode;
  /**
   * Remounting value — when it changes, a caught error is cleared. Pages pass
   * the current path so navigating away from a broken page recovers on its own.
   */
  resetKey?: string;
  /** Shown above the message, e.g. "This page". */
  scope?: string;
}

interface State {
  error: Error | null;
  /** The resetKey the current state was derived from. */
  resetKey: string | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Pick<State, 'error'> {
    return { error };
  }

  /*
   * Derived rather than done in componentDidUpdate: clearing the error there
   * would render the fallback once with the new key before replacing it, and
   * the reader would see the error card flash on a navigation that already
   * worked.
   */
  static getDerivedStateFromProps(props: Props, state: State): State | null {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isStaleChunk(error) && reloadForStaleChunk()) return;

    // No telemetry backend by design — this is a static site with no server to
    // report to. The console is the only place a stack can go, and it is where
    // anyone debugging a report from the league would look first.
    console.error('Render failed', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null, resetKey: this.props.resetKey });

  private hardReload = () => window.location.reload();

  private clearAndReload = () => {
    void cacheClear().finally(() => window.location.reload());
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // A stale chunk is not a fault the reader can act on and its browser-level
    // message means nothing to them, so it gets its own wording. Reaching this
    // at all means the automatic reload was on cooldown and did not fire.
    const stale = isStaleChunk(error);

    return (
      <div className="card card-pad" style={{ marginTop: 32 }} role="alert">
        <h2 className="bold">
          {stale ? 'A new version was deployed' : `${this.props.scope ?? 'Something'} stopped working`}
        </h2>
        <p className="small muted" style={{ marginTop: 6 }}>
          {stale
            ? 'This tab is running an older build than the server has. Reloading picks up the current one.'
            : error.message || 'An unexpected error occurred while rendering.'}
        </p>
        <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn" onClick={stale ? this.hardReload : this.reset}>
            {stale ? 'Reload' : 'Try again'}
          </button>
          <button className="btn" onClick={this.clearAndReload}>
            Clear cached data and reload
          </button>
        </div>
        {!stale && (
          <p className="tiny muted" style={{ marginTop: 10 }}>
            If it comes back straight away, the cached copy of a payload is the
            likeliest cause — the second button drops it and refetches.
          </p>
        )}
      </div>
    );
  }
}
