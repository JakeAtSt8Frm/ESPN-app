import { useEffect, useState } from 'react';

/**
 * Hides a sticky header while scrolling down and reveals it on scroll up.
 *
 * Only active below `maxWidth` — on desktop there's room to keep the header
 * permanently, and hiding it there would just be twitchy.
 *
 * The threshold matters: without one, the tiny scroll jitter from momentum
 * scrolling on iOS makes the header flicker. `revealAt` keeps the header pinned
 * near the top of the page so it never hides content you haven't scrolled past.
 */
export function useHideOnScroll({
  threshold = 8,
  revealAt = 80,
  maxWidth = 760,
}: { threshold?: number; revealAt?: number; maxWidth?: number } = {}): boolean {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${maxWidth}px)`);
    let lastY = window.scrollY;
    let frame = 0;

    const update = () => {
      frame = 0;
      const y = window.scrollY;
      const delta = y - lastY;

      if (!query.matches) {
        setHidden(false);
        lastY = y;
        return;
      }

      // Always visible near the top, and never hide on a rubber-band bounce.
      if (y < revealAt) {
        setHidden(false);
        lastY = y;
        return;
      }

      if (Math.abs(delta) < threshold) return;

      setHidden(delta > 0);
      lastY = y;
    };

    const onScroll = () => {
      // Coalesce to one update per frame; scroll fires far more often than that.
      if (!frame) frame = requestAnimationFrame(update);
    };

    const onChange = () => setHidden(false);

    window.addEventListener('scroll', onScroll, { passive: true });
    query.addEventListener('change', onChange);

    return () => {
      window.removeEventListener('scroll', onScroll);
      query.removeEventListener('change', onChange);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [threshold, revealAt, maxWidth]);

  return hidden;
}
