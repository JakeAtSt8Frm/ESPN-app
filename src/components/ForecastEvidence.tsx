import { useEffect, useState } from 'react';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { forecastScoringKey, isForecastReport, type ForecastReport } from '../lib/forecast-report';
import { fmtPct } from './primitives';

export function ForecastEvidence() {
  const { league } = useLeague();
  const data = useLeagueData();
  const [result, setResult] = useState<ForecastReport | 'loading' | 'unavailable'>('loading');
  const scoringKey = forecastScoringKey(data.league);

  useEffect(() => {
    const controller = new AbortController();
    const url = new URL(`data/${league.key}/forecast-report.json`, document.baseURI);
    void fetch(url, { signal: controller.signal, cache: 'no-cache' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Report unavailable');
        const report: unknown = await response.json();
        if (!isForecastReport(report) || report.scoringKey !== scoringKey) {
          throw new Error('Report does not match league scoring');
        }
        if (!controller.signal.aborted) setResult(report);
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult('unavailable');
      });
    return () => controller.abort();
  }, [league.key, scoringKey]);

  const total =
    typeof result === 'object' ? result.rows.find((row) => row.group === 'ALL') : undefined;
  return (
    <section className="card card-pad forecast-evidence" aria-labelledby="forecast-evidence-title">
      <div className="row-between wrap">
        <h2 id="forecast-evidence-title" className="lab-section-title">
          Prediction track record
        </h2>
        <span className="lab-eyebrow">Season holdouts</span>
      </div>
      {typeof result === 'string' ? (
        <p className="small secondary" role="status">
          {result === 'loading'
            ? 'Loading historical validation…'
            : 'Historical validation is unavailable for this scoring setup. Current forecasts remain estimates.'}
        </p>
      ) : (
        total && (
          <>
            <p className="small secondary">
              Trained on earlier seasons, tested on the following season’s recorded weekly
              projections. {total.samples.toLocaleString()} player-weeks, scored with this league’s
              rules.
            </p>
            <div className="lab-evidence-stats">
              <div>
                <span>Model median error</span>
                <strong>
                  {total.modelMae.toFixed(2)} <small>pts</small>
                </strong>
              </div>
              <div>
                <span>ESPN projection error</span>
                <strong>
                  {total.espnMae.toFixed(2)} <small>pts</small>
                </strong>
              </div>
              <div>
                <span>80% range coverage</span>
                <strong>{fmtPct(total.coverage80, 1)}</strong>
              </div>
            </div>
            <details>
              <summary>Results by position and test method</summary>
              <div className="scroll-x">
                <table className="table">
                  <caption className="sr-only">Historical forecast validation by position</caption>
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th className="num">Weeks</th>
                      <th className="num">Model error</th>
                      <th className="num">ESPN error</th>
                      <th className="num">80% coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows
                      .filter((row) => row.group !== 'ALL')
                      .map((row) => (
                        <tr key={row.group}>
                          <th scope="row">{row.group}</th>
                          <td className="num">{row.samples.toLocaleString()}</td>
                          <td className="num">{row.modelMae.toFixed(2)}</td>
                          <td className="num">{row.espnMae.toFixed(2)}</td>
                          <td className="num">{fmtPct(row.coverage80, 1)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <p className="small secondary">
                {result.folds
                  .map((fold) => `Train ${fold.training.join(' + ')} → test ${fold.testing}`)
                  .join(' · ')}
              </p>
            </details>
            <p className="tiny secondary">
              Error is mean absolute error; lower is better. Coverage is how often results fell in
              the predicted range. These checks evaluate the base scoring distribution, including
              non-appearances with a recorded projection and game log. They exclude opponent and
              player-specific adjustments, and do not validate head-to-head odds or future accuracy.
            </p>
          </>
        )
      )}
    </section>
  );
}
