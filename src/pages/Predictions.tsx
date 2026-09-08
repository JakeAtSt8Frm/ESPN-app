import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ForecastEvidence } from '../components/ForecastEvidence';
import { PlayerModal } from '../components/PlayerModal';
import { EmptyState, fmt1, fmtPct } from '../components/primitives';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { weekForecasts } from '../data/predictions';
import { rosterOwnerByPlayer } from '../data/selectors';
import { compareForecasts, probabilityAbove } from '../lib/forecast-decisions';
import { slotAccepts } from '../lib/optimal';
import { fmtLeagueFormat } from '../lib/labels';
import { POSITION_GROUPS, type PositionGroup } from '../lib/types';
import type { PlayerForecast } from '../lib/forecast';
import './Predictions.css';

type Pool = 'roster' | 'free' | 'all';
type Group = PositionGroup | 'FLEX' | 'ALL';
const BOUNDS = [0, 5, 10, 15, 20, 25, 30, 35, 40];

function chanceLabel(chance: number | null): string {
  if (chance === null) return '—';
  if (chance > 0 && chance < 0.01) return '<1%';
  if (chance > 0.99 && chance < 1) return '>99%';
  return fmtPct(chance, 0);
}

export function PredictionsPage() {
  const data = useLeagueData();
  const { week, league, selectedTeamId } = useLeague();
  const [pool, setPool] = useState<Pool>('roster');
  const [group, setGroup] = useState<Group>('FLEX');
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');
  const [targetInput, setTargetInput] = useState('15');
  const [openPid, setOpenPid] = useState<string | null>(null);
  const teamId = selectedTeamId ?? data.teams[0]?.teamId;
  const team = teamId === undefined ? null : data.teamsById.get(teamId);
  const forecasts = useMemo(() => weekForecasts(data, week, 'pregame'), [data, week]);
  const owners = useMemo(() => rosterOwnerByPlayer(data.teams), [data.teams]);
  const candidates = useMemo(
    () =>
      [...forecasts.values()]
        .filter((forecast) => {
          if (forecast.projection < 1) return false;
          if (
            group === 'FLEX'
              ? !slotAccepts('FLEX', forecast.group)
              : group !== 'ALL' && forecast.group !== group
          )
            return false;
          const owner = owners.get(forecast.pid);
          return pool === 'roster' ? owner?.teamId === teamId : pool === 'free' ? !owner : true;
        })
        .sort((a, b) => b.mean - a.mean),
    [forecasts, group, owners, pool, teamId],
  );
  const a = candidates.find((forecast) => forecast.pid === aId) ?? candidates[0];
  const b =
    candidates.find((forecast) => forecast.pid === bId && forecast.pid !== a?.pid) ??
    candidates.find((forecast) => forecast.pid !== a?.pid);
  const selectA = (pid: string) => {
    setAId(pid);
    if (b) setBId(b.pid);
  };
  const selectB = (pid: string) => {
    if (a) setAId(a.pid);
    setBId(pid);
  };
  const comparison = useMemo(
    () => (a && b ? compareForecasts(data.residualModel, a, b) : null),
    [data.residualModel, a, b],
  );
  const target = targetInput.trim() !== '' ? Number(targetInput) : NaN;
  const validTarget = Number.isFinite(target) && target >= 0 && target <= 100;
  const targetProbability = (forecast: PlayerForecast) =>
    validTarget ? probabilityAbove(data.residualModel, forecast, target) : null;
  const name = (forecast: PlayerForecast) =>
    data.playersById.get(forecast.pid)?.name ?? forecast.pid;
  const commonSlots =
    a && b
      ? [
          ...new Set(
            data.starterSlots.filter(
              (slot) => slotAccepts(slot, a.group) && slotAccepts(slot, b.group),
            ),
          ),
        ]
      : [];
  const expectedLeader = a && b ? (a.mean >= b.mean ? a : b) : null;
  const expectedGap = a && b ? Math.abs(a.mean - b.mean) : 0;

  const distribution =
    a && b
      ? [...BOUNDS, Infinity].map((upper, i) => {
          const lower = i === 0 ? -Infinity : BOUNDS[i - 1];
          const mass = (forecast: PlayerForecast) => {
            const aboveLower =
              lower === -Infinity
                ? 1
                : (probabilityAbove(data.residualModel, forecast, lower) ?? 0);
            const aboveUpper =
              upper === Infinity ? 0 : (probabilityAbove(data.residualModel, forecast, upper) ?? 0);
            return Math.max(0, aboveLower - aboveUpper);
          };
          return {
            label: i === 0 ? '≤0' : upper === Infinity ? '>40' : `${lower}–${upper}`,
            a: mass(a),
            b: mass(b),
          };
        })
      : [];
  const peak = Math.max(0.01, ...distribution.flatMap((bin) => [bin.a, bin.b]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Prediction Lab</h1>
          <p className="small secondary">
            Week {week} · {week < data.liveWeek ? 'Current-model replay' : 'Pregame forecasts'} ·{' '}
            {data.league.name} · {fmtLeagueFormat(data.league)}
          </p>
        </div>
        <Link className="btn btn-sm" to="/optimal">
          Full lineup →
        </Link>
      </div>
      <section className="card card-pad lab-intro">
        <div>
          <span className="lab-eyebrow">Make the close call</span>
          <h2>Two players. Every outcome.</h2>
          <p className="secondary small">
            Compare expected points, downside and the chance of clearing the score you need.
          </p>
        </div>
        <div className="lab-filters">
          <label>
            Player pool
            <select
              className="select"
              value={pool}
              onChange={(event) => setPool(event.target.value as Pool)}
            >
              <option value="roster">{team?.name ?? 'Selected team'}</option>
              <option value="free">Free agents</option>
              <option value="all">All players</option>
            </select>
          </label>
          <label>
            Position
            <select
              className="select"
              value={group}
              onChange={(event) => setGroup(event.target.value as Group)}
            >
              <option value="FLEX">FLEX · RB / WR / TE</option>
              <option value="ALL">All positions</option>
              {POSITION_GROUPS.map((position) => (
                <option key={position}>{position}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {!a || !b || !comparison ? (
        <EmptyState
          title="Choose a broader player pool"
          hint="This comparison needs two players with a weekly projection. Try All players or another position."
        />
      ) : (
        <>
          <div className="lab-player-grid">
            {[
              { forecast: a, letter: 'A', change: selectA, other: b.pid },
              { forecast: b, letter: 'B', change: selectB, other: a.pid },
            ].map(({ forecast, letter, change, other }) => (
              <section
                key={letter}
                className={`card card-pad lab-player lab-player--${letter.toLowerCase()}`}
              >
                <label className="lab-picker-label">
                  Player {letter}
                  <select
                    className="select"
                    aria-label={`Player ${letter}`}
                    value={forecast.pid}
                    onChange={(event) => change(event.target.value)}
                  >
                    {candidates
                      .filter((candidate) => candidate.pid !== other)
                      .map((candidate) => (
                        <option key={candidate.pid} value={candidate.pid}>
                          {name(candidate)} · {candidate.group} · {fmt1(candidate.mean)} expected
                        </option>
                      ))}
                  </select>
                </label>
                <div className="row-between wrap">
                  <h2>{name(forecast)}</h2>
                  <button className="btn btn-ghost btn-sm" onClick={() => setOpenPid(forecast.pid)}>
                    Player details
                  </button>
                </div>
                <p className="small secondary">
                  {forecast.group} · {forecast.nflTeam || 'No NFL team'} ·{' '}
                  {owners.get(forecast.pid)?.name ?? 'Free agent'}
                </p>
                {week >= data.liveWeek &&
                  data.playersById.get(forecast.pid)?.injuryStatus &&
                  data.playersById.get(forecast.pid)?.injuryStatus !== 'ACTIVE' && (
                    <p className="small lab-injury">
                      {data.playersById.get(forecast.pid)?.injuryStatus?.replaceAll('_', ' ')} in
                      the latest snapshot · check availability before starting.
                    </p>
                  )}
                <div className="lab-points">
                  <strong>{fmt1(forecast.mean)}</strong>
                  <span>expected points</span>
                </div>
                <dl className="lab-metrics">
                  <div>
                    <dt>80% outcome range</dt>
                    <dd>
                      {fmt1(forecast.p10)}–{fmt1(forecast.p90)}
                    </dd>
                  </div>
                  <div>
                    <dt>Median if active</dt>
                    <dd>{fmt1(forecast.median)}</dd>
                  </div>
                  <div>
                    <dt>ESPN projection</dt>
                    <dd>{fmt1(forecast.projection)}</dd>
                  </div>
                  <div>
                    <dt>Model availability</dt>
                    <dd>{fmtPct(forecast.playProb, 1)}</dd>
                  </div>
                </dl>
                <div className="lab-target-result">
                  <span>Over {validTarget ? fmt1(target) : '—'} points</span>
                  <strong>{chanceLabel(targetProbability(forecast))}</strong>
                </div>
                <p className="tiny secondary">
                  {(data.residualModel.byGroup.get(forecast.group)?.samples ?? 0).toLocaleString()}{' '}
                  historical {forecast.group} player-weeks in the scoring fit.
                </p>
                <details className="lab-explanation">
                  <summary>Why this projection?</summary>
                  <p className="small secondary">
                    Starts with ESPN’s {fmt1(forecast.projection)} points, then uses the position’s
                    historical scoring distribution. Player history shifts it by{' '}
                    {fmt1(forecast.biasShift)} points; the opponent shifts it by{' '}
                    {fmt1(forecast.matchupShift)}. Expected points include the model’s availability
                    estimate. The median describes a game where the player is active.
                  </p>
                </details>
              </section>
            ))}
          </div>

          <section className="card card-pad lab-verdict" aria-labelledby="lab-verdict-title">
            <div className="row-between wrap">
              <div>
                <span className="lab-eyebrow">Start / sit comparison</span>
                <h2 id="lab-verdict-title" className="lab-section-title">
                  {expectedGap < 0.5
                    ? 'A close call on expected points'
                    : `${expectedLeader ? name(expectedLeader) : ''} has the points edge`}
                </h2>
                <p className="small secondary">
                  {expectedGap < 0.5
                    ? 'Less than half a point separates their expected scores.'
                    : `A ${fmt1(expectedGap)}-point expected advantage. Check the downside and target odds before deciding.`}
                </p>
              </div>
              <label className="lab-target-label">
                Points target
                <input
                  className="input"
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={targetInput}
                  aria-invalid={!validTarget}
                  aria-describedby={!validTarget ? 'target-error' : undefined}
                  onChange={(event) => setTargetInput(event.target.value)}
                />
              </label>
            </div>
            {!validTarget && (
              <p id="target-error" className="small" role="alert">
                Enter a target between 0 and 100 points.
              </p>
            )}
            <div className="row-between lab-odds-labels">
              <span>
                {name(a)}
                <strong>{fmtPct(comparison.aWins, 0)}</strong>
              </span>
              <span>
                {name(b)}
                <strong>{fmtPct(comparison.bWins, 0)}</strong>
              </span>
            </div>
            <div
              className="lab-odds-bar"
              role="img"
              aria-label={`${name(a)} outscores ${name(b)} ${fmtPct(comparison.aWins, 0)} of simulations; ${name(b)} wins ${fmtPct(comparison.bWins, 0)}; ties ${fmtPct(comparison.ties, 1)}`}
            >
              <span style={{ width: `${comparison.aWins * 100}%` }} />
              <span className="lab-odds-ties" style={{ width: `${comparison.ties * 100}%` }} />
              <span style={{ width: `${comparison.bWins * 100}%` }} />
            </div>
            <p className="tiny secondary">
              Chance of outscoring the other player · {fmtPct(comparison.ties, 1)} ties ·{' '}
              {comparison.iterations.toLocaleString()} simulations with shared NFL-team effects.
            </p>
            <p className="small secondary lab-eligibility">
              {commonSlots.length
                ? `Both fit: ${commonSlots.join(', ')}. Roster ownership and game locks still determine whether you can make the move.`
                : 'These players do not share a starting slot in this league. This comparison is not a legal lineup substitution.'}
            </p>
          </section>

          <section
            className="card card-pad lab-distribution"
            aria-labelledby="lab-distribution-title"
          >
            <div className="row-between wrap">
              <h2 id="lab-distribution-title" className="lab-section-title">
                Where the points could land
              </h2>
              <div className="lab-legend">
                <span>{name(a)}</span>
                <span>{name(b)}</span>
              </div>
            </div>
            <div className="lab-histogram" aria-hidden="true">
              {distribution.map((bin) => (
                <div key={bin.label}>
                  <div className="lab-histogram__bars">
                    <i style={{ height: `${(bin.a / peak) * 100}%` }} />
                    <i style={{ height: `${(bin.b / peak) * 100}%` }} />
                  </div>
                  <span>{bin.label}</span>
                </div>
              ))}
            </div>
            <p className="tiny secondary">
              Fantasy points · taller bars mean more likely outcomes. Ranges include their upper
              endpoint.
            </p>
            <details>
              <summary>Show probability table</summary>
              <div className="scroll-x">
                <table className="table">
                  <caption className="sr-only">Score distribution probabilities</caption>
                  <thead>
                    <tr>
                      <th>Points</th>
                      <th className="num">{name(a)}</th>
                      <th className="num">{name(b)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {distribution.map((bin) => (
                      <tr key={bin.label}>
                        <th scope="row">{bin.label}</th>
                        <td className="num">{fmtPct(bin.a, 1)}</td>
                        <td className="num">{fmtPct(bin.b, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <p className="small secondary">
              These are pregame estimates from the saved snapshot. A wider range means more
              uncertainty; an 80% range still leaves one outcome in five outside it. Current game
              scores are excluded.
            </p>
            {week < data.liveWeek && (
              <p className="small secondary">
                Past weeks use today’s fitted model, not an archived forecast from that week.
              </p>
            )}
          </section>
        </>
      )}
      <ForecastEvidence key={league.key} />
      {openPid && <PlayerModal pid={openPid} week={week} onClose={() => setOpenPid(null)} />}
    </>
  );
}
