import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeProvider } from './components/ThemeProvider';
import { LeagueProvider } from './data/LeagueProvider';
import './styles/global.css';
import './styles/components.css';

/*
 * HashRouter rather than BrowserRouter: this deploys to GitHub Pages, which
 * serves static files with no rewrite rules, so a deep link like /history would
 * 404 on refresh under a browser router.
 */
/*
 * The outer boundary is the last resort. AppShell has its own around the routed
 * page, which catches almost everything and keeps the navigation usable; this
 * one exists for the rest — a throw in the shell itself or in the provider —
 * where the alternative is a blank document with no way back.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary scope="The app">
      <ThemeProvider>
        <LeagueProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </LeagueProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
