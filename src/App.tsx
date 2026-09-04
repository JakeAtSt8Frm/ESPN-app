import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';

/*
 * Pages are loaded on demand.
 *
 * The landing route is Teams, but a static import graph makes every page's cost
 * part of the first paint — and the pages are not the same size. Analytics alone
 * pulls in the Monte Carlo simulator and the playoff bracket resolver, neither of
 * which a reader checking a lineup ever runs. Splitting at the route lets each
 * page arrive on demand. The production build preserves those chunks, keeping
 * the initial GitHub Pages download small.
 */
const TeamsPage = lazy(() => import('./pages/Teams').then((m) => ({ default: m.TeamsPage })));
const MatchupsPage = lazy(() =>
  import('./pages/Matchups').then((m) => ({ default: m.MatchupsPage })),
);
const OptimalPage = lazy(() =>
  import('./pages/Optimal').then((m) => ({ default: m.OptimalPage })),
);
const HistoryPage = lazy(() =>
  import('./pages/History').then((m) => ({ default: m.HistoryPage })),
);
const PlayersPage = lazy(() =>
  import('./pages/Players').then((m) => ({ default: m.PlayersPage })),
);
const SchedulePage = lazy(() =>
  import('./pages/Schedule').then((m) => ({ default: m.SchedulePage })),
);
const AnalyticsPage = lazy(() =>
  import('./pages/Analytics').then((m) => ({ default: m.AnalyticsPage })),
);
const DraftPage = lazy(() => import('./pages/Draft').then((m) => ({ default: m.DraftPage })));
const TradePage = lazy(() => import('./pages/Trade').then((m) => ({ default: m.TradePage })));

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<Navigate to="/teams" replace />} />
        <Route path="teams" element={<TeamsPage />} />
        <Route path="matchups" element={<MatchupsPage />} />
        <Route path="optimal" element={<OptimalPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="players" element={<PlayersPage />} />
        <Route path="schedule" element={<SchedulePage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="draft" element={<DraftPage />} />
        <Route path="trade" element={<TradePage />} />
        <Route path="*" element={<Navigate to="/teams" replace />} />
      </Route>
    </Routes>
  );
}
