import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { Mode } from '../lib/colors';

interface ThemeContextValue {
  /** The mode being rendered. The app is dark-only, so this is always 'dark'. */
  mode: Mode;
}

const ThemeContext = createContext<ThemeContextValue>({ mode: 'dark' });

/**
 * Dark-only theme.
 *
 * The rendered mode is still exposed to JS because the heatmap and chip fills
 * are computed at runtime — CSS custom properties alone can't drive them, since
 * the colours depend on data values as well as on the theme.
 *
 * `data-theme="dark"` is set on the document in index.html so the dark tokens
 * apply on the very first paint; this effect just guarantees it stays put.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  }, []);

  return <ThemeContext.Provider value={{ mode: 'dark' }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
