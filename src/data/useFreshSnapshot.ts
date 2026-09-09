/**
 * Notices when a newer snapshot has been published, and says so.
 *
 * The app reads its snapshot exactly once, during page load. For a browser tab
 * that is the right amount of work. For an installed app it is the whole bug:
 * resuming a standalone PWA from the app switcher is not a page load — React is
 * still mounted, no effect re-runs, nothing refetches — so the numbers on screen
 * are from whenever the app was last *opened*, which on a phone is routinely
 * hours and across a Sunday afternoon is a whole slate out of date. Reopening
 * the app looked like it was refusing to pull a new snapshot; in fact there was
 * no load for the freshness logic to run on.
 *
 * So freshness is checked on the events that mean "the viewer is back" —
 * visibility, focus, reconnect, and a restore from the back/forward cache — and
 * on a slow interval while the app is actually on screen, which covers a laptop
 * left open through the games.
 *
 * The check reads `index.json` and nothing else. It is a few hundred bytes, it
 * is the one file deliberately left out of the payload cache, and every other
 * file is keyed by the stamp it carries — so a stamp that has moved is exactly
 * the signal to reload, and a stamp that has not is a guarantee there is nothing
 * to do.
 */

import { useEffect, useRef } from 'react';
import { loadIndex } from './snapshot';

/**
 * How often to check while the app is on screen.
 *
 * GitHub Pages serves the snapshot through a CDN that holds it for ten minutes,
 * so a much shorter poll mostly re-reads the same edge copy. Five minutes is
 * half that hold, which bounds the wait behind a new deployment at about a
 * quarter of an hour without asking the edge questions it cannot answer yet.
 */
const POLL_MS = 5 * 60 * 1000;

/**
 * The floor on how often the index is actually fetched.
 *
 * The wake-up events fire together far more often than they mean anything:
 * raising a desktop window produces `focus` and `visibilitychange` as a pair,
 * and iOS fires them again on every return through the app switcher. A second
 * check moments after the first also cannot learn anything, because that CDN
 * ignores both `Cache-Control: no-cache` on the request and a cache-busting
 * query string — within its window the edge returns the same bytes however many
 * times it is asked.
 */
const MIN_GAP_MS = 30 * 1000;

export interface FreshSnapshotOptions {
  /** The league on screen. */
  leagueKey: string;
  /** The `generatedAt` on screen, or null while nothing is loaded. */
  stamp: number | null;
  /** True while a load, a pull or a league switch is already under way. */
  busy: boolean;
  /** Called when the published snapshot is newer than the one on screen. */
  onNewer: () => void;
}

export function useFreshSnapshot({
  leagueKey,
  stamp,
  busy,
  onNewer,
}: FreshSnapshotOptions): void {
  /*
   * Held in a ref rather than in the dependency list. Every field here changes
   * on an ordinary render, and re-subscribing four listeners and an interval on
   * each one would both churn and reset the poll — the interval would never
   * reach five minutes, because something always re-renders first.
   *
   * Written after the commit rather than during the render, so a render React
   * discards cannot leave its values behind: what the listeners need is the
   * state that actually reached the screen.
   */
  const current = useRef({ leagueKey, stamp, busy, onNewer });
  useEffect(() => {
    current.current = { leagueKey, stamp, busy, onNewer };
  });

  const checkedAt = useRef(0);

  useEffect(() => {
    const controller = new AbortController();

    const check = async () => {
      const before = current.current;
      // Nothing to compare against, or a load is already on its way with a
      // better answer than this check could give.
      if (before.stamp === null || before.busy) return;
      if (document.visibilityState === 'hidden') return;

      const now = Date.now();
      if (now - checkedAt.current < MIN_GAP_MS) return;
      checkedAt.current = now;

      let published: number;
      try {
        published = (await loadIndex(before.leagueKey, controller.signal)).generatedAt;
      } catch {
        /*
         * Offline, or this raced the deployment that was writing the file. Not
         * worth reporting: the data on screen is still a true snapshot, just an
         * older one, and the next check settles it.
         */
        return;
      }

      const after = current.current;
      // The league may have been switched, or a load started, while this was in
      // flight — either way the comparison it set out to make no longer
      // describes what is on screen.
      if (after.leagueKey !== before.leagueKey || after.stamp === null) return;
      /*
       * Strictly newer. A snapshot's stamp only moves forward, so a lower one
       * means a CDN edge still serving the previous file, and treating that as
       * news would reload the app back onto data it had already replaced.
       */
      if (published > after.stamp) after.onNewer();
    };

    const onWake = () => {
      if (document.visibilityState === 'visible') void check();
    };

    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    /*
     * `pageshow` is the only one of these that fires when a page is restored
     * from the back/forward cache, which is how Safari returns to a tab it
     * froze — including the standalone app, where there is no reload gesture to
     * fall back on.
     */
    window.addEventListener('pageshow', onWake);

    const timer = setInterval(() => void check(), POLL_MS);

    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
      window.removeEventListener('pageshow', onWake);
      clearInterval(timer);
    };
    // Subscribes once. Everything it reads comes through `current`.
  }, []);
}
