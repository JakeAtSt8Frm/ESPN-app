/**
 * Player detail sheet.
 *
 * The centrepiece is the projected-vs-actual chart: two series, both recomputed
 * from raw stat lines against the league's own scoring, so the gap between them
 * is the honest answer to "is this player beating expectations".
 *
 * On mobile this presents as a bottom sheet; on desktop, a centred dialog.
 */

import { useEffect, useMemo, useRef } from 'react';
import { LazyWeeklyScoreChart } from './LazyChart';
import { useLeagueData } from '../data/LeagueProvider';
import { weekForecasts } from '../data/predictions';
import { playerHeadshot, teamLogo } from '../lib/assets';
import { fmt1, fmtPct, fmtSigned, MatchupChip, StatusBadge, ValueChip } from './primitives';
import { MATCHUP_INFLUENCE_FLOOR } from '../lib/matchup';
import { enrichPlayer } from '../data/selectors';
import { VALUE_WEIGHTS } from '../lib/value';
import { SEASON_WEIGHTS } from '../lib/season-value';
import { hasPlayed } from '../lib/scoring';
import type { RankInfo } from '../lib/types';

interface Props {
  pid: string | null;
  week: number;
  onClose: () => void;
}

export function PlayerModal({ pid, week, onClose }: Props) {
  const data = useLeagueData();
  const dialogRef = useRef<HTMLDivElement>(null);

  /*
   * Modal keyboard contract.
   *
   * `aria-modal` tells assistive technology the rest of the page is inert, but it
   * does nothing to the tab order — so without a trap, Tab walks straight out of
   * the sheet and into the roster behind it, where the reader is still told they
   * are in a dialog. Cycling focus inside the sheet is what makes the attribute
   * true.
   *
   * Focus is also put back where it came from on close. Every sheet is opened
   * from a player row, and dropping focus on `<body>` means a keyboard reader
   * restarts at the top of the page each time they look a player up — which in a
   * 21-row lineup is the whole interaction.
   */
  useEffect(() => {
    if (!pid) return;

    const opener = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] => {
      const root = dialogRef.current;
      if (!root) return [];
      return [
        ...root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetParent !== null || el === document.activeElement);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = focusable();
      if (items.length === 0) {
        // Nothing to land on but the sheet itself — hold focus there rather than
        // letting it escape to the page behind.
        e.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || active === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (active instanceof Node && !dialogRef.current?.contains(active)) {
        // Focus was already outside — pull it back in on the next Tab.
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();

    // Prevent the page behind the sheet from scrolling on touch devices.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      // `isConnected` guards the case where the opener itself was unmounted —
      // a filter change behind the sheet, say — where refocusing it would throw
      // focus to the top of the document instead of leaving it where it is.
      if (opener?.isConnected) opener.focus();
    };
  }, [pid, onClose]);

  const detail = useMemo(() => {
    if (!pid) return null;

    const player = enrichPlayer(data, pid, week, '', false);
    const value = data.valueIndex.byPlayer.get(pid) ?? null;
    // Last season's production, which is the only production there is until this
    // one has been played. See `LeagueData.priorProduction`.
    const prior = data.priorProduction.get(pid) ?? null;
    const season = data.seasonValueIndex.byPlayer.get(pid) ?? null;
    const weekly = data.valueIndex.weeklyScores.get(pid) ?? [];
    const matchupIndex = data.pregameMatchupIndexes.get(week) ?? data.matchupIndex;
    const matchup = matchupIndex.get(player.group, player.opponent);

    const chart = weekly.map((w) => ({
      week: `W${w.week}`,
      projected: w.projected,
      actual: w.actual,
    }));

    /*
     * Built pregame so the band describes what was knowable before kickoff. In
     * live mode a finished player collapses to his own result, which is true but
     * not a forecast — and it would make the section vanish exactly when the
     * reader wants to compare the projection against what happened.
     */
    const forecast = weekForecasts(data, week, 'pregame').get(pid) ?? null;
    const actual = weekForecasts(data, week, 'live').get(pid)?.actual ?? null;

    /*
     * The whole season ahead, one row a week: who he plays, how good that
     * matchup is for his position, and both projections for it.
     *
     * A bye is a row rather than a gap. Leaving it out makes a fourteen-week
     * schedule look like fifteen weeks of football, and the week a player is
     * missing is one of the few things about a schedule that changes a decision.
     */
    const schedule: Array<{
      week: number;
      opponent: string | null;
      home: boolean | null;
      matchupScore: number | null;
      espn: number | null;
      app: number | null;
      played: boolean;
      actual: number | null;
    }> = [];

    const proTeamId = player.player.proTeamId;
    for (let w = 1; w <= data.playoff.finalWeek; w++) {
      const game = data.proSchedule[String(proTeamId)]?.[String(w)] ?? null;
      const weekData = data.weeks.get(w);
      const line = weekData?.stats[pid];
      const didPlay = hasPlayed(line);
      const appForecast = weekForecasts(data, w, 'pregame').get(pid);

      schedule.push({
        week: w,
        opponent: game?.opponent ?? null,
        home: game ? game.home : null,
        // Historical weeks get the rating that was knowable before them; future
        // weeks get today's, which is the only one that exists.
        matchupScore: game
          ? ((w < data.liveWeek ? data.pregameMatchupIndexes.get(w) : data.matchupIndex) ??
              data.matchupIndex
            ).get(player.group, game.opponent)?.score ?? null
          : null,
        espn: weekData ? data.score(weekData.projections[pid], player.group) : null,
        app: appForecast
          ? appForecast.playProb <= 0
            ? 0
            : appForecast.median
          : null,
        played: didPlay,
        actual: didPlay ? data.score(line, player.group) : null,
      });
    }

    return {
      player,
      value,
      prior,
      season,
      weekly,
      matchup,
      chart,
      schedule,
      forecast: forecast ? { ...forecast, actual } : null,
    };
  }, [data, pid, week]);

  if (!pid || !detail) return null;

  const { player: p, value, prior, season, weekly, matchup, chart, schedule, forecast } = detail;

  const played = weekly.length;
  const beats = weekly.filter((w) => w.projected !== null && w.actual > w.projected).length;
  const projectedWeeks = weekly.filter((w) => w.projected !== null).length;

  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`${p.name} details`}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="sheet__grabber" aria-hidden="true" />

        <header className="sheet__header">
          <img
            src={playerHeadshot(p.pid, p.team) ?? undefined}
            alt=""
            className="sheet__avatar"
            onError={(e) => {
              const img = e.currentTarget;
              const fallback = teamLogo(p.team);
              if (fallback && img.src !== fallback) img.src = fallback;
              else img.style.visibility = 'hidden';
            }}
          />
          <div className="grow" style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.25 }}>{p.name}</h2>
            <div className="small muted">
              {p.group} · {p.team || 'Free agent'}
              {p.player.byeWeek ? ` · bye W${p.player.byeWeek}` : ''}
              {p.player.percentOwned !== null
                ? ` · ${p.player.percentOwned.toFixed(0)}% rostered`
                : ''}
            </div>
            {/*
              The same three ranks the row carries, in the same three colours, so
              opening a player does not re-describe what was just tapped. The
              season leads them whenever it is not this one — see `PositionRanks`.
            */}
            <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
              <ValueChip score={p.valueScore} />
              {p.rankSeason && <span className="chip chip-outline">{p.rankSeason}</span>}
              <RankChip rank={p.totalRank} kind="total" label="total" />
              <RankChip rank={p.ppgRank} kind="ppg" label="PPG" />
              <RankChip rank={p.boomRateRank} kind="boom" label="boom" />
              {p.isOut && (
                <span className="chip" style={{ color: 'var(--danger-text)' }}>
                  {p.player.injuryStatus ?? 'OUT'}
                </span>
              )}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="sheet__body">
          {/* ---- This week's forecast distribution ---- */}
          {forecast && (
            <section>
              <h3 className="section-title">
                Week {week} forecast
                {forecast.actual !== null && ' — how it looked beforehand'}
              </h3>
              <div className="metric-grid">
                <Metric
                  label="Expected"
                  value={fmt1(forecast.median)}
                  sub={`source says ${fmt1(forecast.projection)}`}
                />
                {forecast.boomProb !== null && (
                  <Metric
                    label="Likely boom"
                    value={fmtPct(forecast.boomProb)}
                    sub={`at least ${fmt1(forecast.projection * 1.2)} pts`}
                    tone="var(--success-text)"
                  />
                )}
                {forecast.bustProb !== null && (
                  <Metric
                    label="Likely bust"
                    value={fmtPct(forecast.bustProb)}
                    sub={`at most ${fmt1(forecast.projection * 0.8)} pts`}
                    tone="var(--danger-text)"
                  />
                )}
                {Math.abs(forecast.matchupShift) >= 0.05 && (
                  <Metric
                    label="Opponent adj."
                    value={`${fmtSigned(forecast.matchupShift)} pts`}
                    sub={p.opponent ? `vs ${p.opponent} positional history` : 'positional history'}
                  />
                )}
                <Metric label="Floor" value={fmt1(forecast.p10)} sub="10th pct" />
                <Metric label="Likely" value={`${fmt1(forecast.p25)}–${fmt1(forecast.p75)}`} sub="middle half" />
                <Metric label="Ceiling" value={fmt1(forecast.p90)} sub="90th pct" />
                {/*
                  * Only when the number would actually read below certainty.
                  * With the fit built from real weekly pairs a projected player
                  * turns up 99.8% of the time, and a tile announcing "Plays
                  * 100%" on every row is noise dressed as information.
                  */}
                {forecast.playProb < 0.995 && (
                  <Metric
                    label="Plays"
                    value={fmtPct(forecast.playProb)}
                    sub={week > data.liveWeek ? 'available that week' : 'when projected'}
                  />
                )}
                {forecast.actual !== null && (
                  <Metric label="Actual" value={fmt1(forecast.actual)} />
                )}
              </div>
            </section>
          )}

          {/* ---- Weekly projected vs actual ---- */}
          <section>
            <h3 className="section-title">
              Projected Score vs Actual Score, by week
            </h3>

            {chart.length === 0 ? (
              <div className="card card-pad muted small">
                No scoring weeks recorded this season.
              </div>
            ) : (
              <>
                <LazyWeeklyScoreChart data={chart} height={240} />

                <div className="small muted" style={{ marginTop: 4 }}>
                  Beat projection in {beats} of {projectedWeeks} projected weeks
                  {played !== projectedWeeks && ` (${played} played)`}.
                </div>
              </>
            )}
          </section>

          {/*
            ---- Last season, when there is no season yet ----

            The profile below is built from the season in progress, so before
            week one it renders nothing at all and the sheet opens on a player
            with no production on it anywhere. These four are what `priors.json`
            carries — see `seasonProduction` — and they are the four the rank
            chips at the top of this sheet are reporting, so the reader can see
            the numbers behind the ranks rather than only their order.
          */}
          {!value && prior && (
            <section>
              <h3 className="section-title">{p.rankSeason ?? prior.season} season</h3>
              <div className="metric-grid">
                <Metric label="Games" value={String(prior.games)} />
                <Metric label="Total" value={fmt1(prior.total)} />
                <Metric label="PPG" value={fmt1(prior.ppg)} tone="var(--rank-ppg)" />
                <Metric
                  label="Boom rate"
                  value={prior.projectedGames > 0 ? fmtPct(prior.boomRate) : '—'}
                  sub={
                    prior.projectedGames > 0
                      ? `${prior.boom} of ${prior.projectedGames} projected weeks`
                      : 'no projected weeks'
                  }
                  tone="var(--success-text)"
                />
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>
                This season has not been played. These are last season's finishes,
                scored under this league's settings.
              </div>
            </section>
          )}

          {/* ---- Season profile ---- */}
          {value && (
            <section>
              <h3 className="section-title">Season profile</h3>
              <div className="metric-grid">
                <Metric label="Games" value={String(value.breakdown.games)} />
                <Metric label="Total" value={fmt1(value.breakdown.total)} />
                <Metric label="PPG" value={fmt1(value.breakdown.ppg)} />
                <Metric
                  label="Adjusted PPG"
                  value={fmt1(value.breakdown.scheduleAdjustedPpg)}
                />
                <Metric label="Last 4" value={fmt1(value.breakdown.last4)} />
                <Metric label="Last 8" value={fmt1(value.breakdown.last8)} />
                <Metric label="Weighted form" value={fmt1(value.breakdown.ewma)} />
                {value.breakdown.forecastProjection !== null && (
                  <Metric label="Current projection" value={fmt1(value.breakdown.forecastProjection)} />
                )}
                <Metric label="Floor" value={fmt1(value.breakdown.floor)} sub="25th pct week" />
                <Metric label="Ceiling" value={fmt1(value.breakdown.ceiling)} sub="85th pct week" />
                <Metric
                  label="Consistency"
                  value={fmtPct(value.breakdown.consistency)}
                  sub="inverse volatility"
                />
                <Metric label="Availability" value={fmtPct(value.breakdown.availability)} />
                <Metric
                  label="Boom rate"
                  value={fmtPct(value.breakdown.boomRate)}
                  tone="var(--success-text)"
                />
                <Metric
                  label="Bust rate"
                  value={fmtPct(value.breakdown.bustRate)}
                  tone="var(--danger-text)"
                />
                <Metric
                  label="Avg vs proj"
                  value={
                    value.breakdown.deltaAvg >= 0
                      ? `+${value.breakdown.deltaAvg.toFixed(1)}`
                      : value.breakdown.deltaAvg.toFixed(1)
                  }
                />
                {value.breakdown.usagePerGame !== null && (
                  <Metric
                    label="Usage / game"
                    value={value.breakdown.usagePerGame.toFixed(1)}
                    sub="opportunities"
                  />
                )}
                {value.breakdown.recentOpportunityShare !== null && (
                  <Metric
                    label="Team opportunity share"
                    value={fmtPct(value.breakdown.recentOpportunityShare)}
                  />
                )}
                {value.breakdown.ownedPct !== null && (
                  <Metric
                    label="Rostered"
                    value={`${value.breakdown.ownedPct.toFixed(0)}%`}
                    sub="of ESPN leagues"
                  />
                )}
                {value.breakdown.startedPct !== null && (
                  <Metric label="Start rate" value={`${value.breakdown.startedPct.toFixed(0)}%`} />
                )}
              </div>
            </section>
          )}


          {/* ---- Rest-of-season profile ---- */}
          {season && (
            <section>
              <h3 className="section-title">Redraft outlook · Rest of season {season.score}</h3>
              <div
                className="row wrap"
                style={{ gap: 6, marginBottom: 8, alignItems: 'center' }}
              >
                <span className="chip chip-outline">{season.breakdown.tier}</span>
                <VerdictChip verdict={season.breakdown.verdict} />
                <span className="chip chip-outline">
                  Injury: {season.breakdown.injuryRisk}
                </span>
                {season.breakdown.injuryStatus &&
                  season.breakdown.injuryStatus !== 'ACTIVE' && (
                    <span className="chip chip-outline">
                      {season.breakdown.injuryStatus.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  )}
              </div>

              <div className="metric-grid">
                {season.breakdown.restOfSeasonPoints !== null && (
                  <Metric
                    label="Projected rest of season"
                    value={fmt1(season.breakdown.restOfSeasonPoints)}
                    sub={`${season.breakdown.weeksRemaining} games, byes excluded`}
                  />
                )}
                {season.breakdown.restOfSeasonPpg !== null && (
                  <Metric
                    label="Projected PPG"
                    value={fmt1(season.breakdown.restOfSeasonPpg)}
                    sub="per remaining game"
                  />
                )}
                {season.breakdown.vorp !== null && (
                  <Metric
                    label="VORP"
                    value={fmtSigned(season.breakdown.vorp)}
                    sub="pts over replacement"
                  />
                )}
                <Metric
                  label="Replacement level"
                  value={fmt1(season.breakdown.replacementPoints)}
                  sub={`${season.group} starter cliff`}
                />
                {season.breakdown.currentPpg !== null && (
                  <Metric
                    label="Actual PPG"
                    value={fmt1(season.breakdown.currentPpg)}
                    sub={`${season.breakdown.games} game${season.breakdown.games === 1 ? '' : 's'}`}
                  />
                )}
                {season.breakdown.projectedOpportunities !== null && (
                  <Metric
                    label="Projected touches"
                    value={fmt1(season.breakdown.projectedOpportunities)}
                    sub="per game"
                  />
                )}
                {season.breakdown.auctionValue !== null && (
                  <Metric
                    label="Auction value"
                    value={`$${season.breakdown.auctionValue.toFixed(0)}`}
                    sub="ESPN average, $200 budget"
                  />
                )}
                {season.breakdown.averageDraftPosition !== null && (
                  <Metric
                    label="ADP"
                    value={season.breakdown.averageDraftPosition.toFixed(1)}
                    sub="ESPN average draft position"
                  />
                )}
                {season.breakdown.marketPositionRank !== null && (
                  <Metric
                    label="Market percentile"
                    value={fmtPct(season.breakdown.marketPositionRank)}
                    sub={`among priced ${season.group}s`}
                  />
                )}
                {season.breakdown.scheduleAhead !== null && (
                  <Metric
                    label="Schedule ahead"
                    value={fmt1(season.breakdown.scheduleAhead)}
                    sub="mean matchup score remaining"
                  />
                )}
              </div>

              <h3 className="section-title" style={{ marginTop: 14 }}>
                Why rest-of-season score {season.score}
              </h3>
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Signal</th>
                      <th className="num">Weight</th>
                      <th className="num">Percentile</th>
                      <th className="num">Contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...season.breakdown.contributions]
                      .sort((a, b) => b.points - a.points)
                      .map((c) => (
                        <tr key={c.label}>
                          <td>{c.label}</td>
                          <td className="num muted">
                            {((c.weight / seasonTotalWeight) * 100).toFixed(0)}%
                          </td>
                          <td className="num">{fmtPct(c.normalized)}</td>
                          <td className="num bold">{(c.points * 1000).toFixed(0)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ---- This week's matchup ---- */}
          {matchup && (
            <section>
              <h3 className="section-title">
                Matchup vs {matchup.defense}
              </h3>
              <div className="metric-grid">
                <Metric
                  label="Matchup score"
                  value={String(matchup.score)}
                />
                <Metric label="Defence baseline" value={String(matchup.baseScore)} />
                <Metric
                  label="Adjusted-allowed score"
                  value={String(matchup.opponentAdjustedScore)}
                />
                <Metric
                  label="Opportunity score"
                  value={String(matchup.opportunityScore)}
                />
                <Metric
                  label="Allowed / game"
                  value={fmt1(matchup.pointsPerGame)}
                  sub={`to ${matchup.group}s`}
                />
                <Metric
                  label="Adjusted allowed"
                  value={fmt1(matchup.opponentAdjustedPpg)}
                />
                <Metric
                  label="Opportunities allowed"
                  value={fmt1(matchup.opportunitiesPerGame)}
                />
                <Metric label="Last 4" value={fmt1(matchup.last4)} />
                <Metric
                  label="Generosity rank"
                  value={`#${matchup.rankMostGenerous}`}
                  sub="1 = most generous"
                />
                <Metric label="Ceiling rate" value={fmtPct(matchup.ceilingRate)} />
                <Metric label="Floor rate" value={fmtPct(matchup.floorRate)} />
              </div>
            </section>
          )}

          {/* ---- The schedule ahead, with the matchup for each week ---- */}
          {schedule.length > 0 && (
            <section>
              <h3 className="section-title">Schedule &amp; matchups</h3>
              <p className="tiny muted" style={{ marginTop: -4, marginBottom: 8 }}>
                Matchup 0&ndash;100, higher is softer.
                {p.group && data.matchupInfluence[p.group] < MATCHUP_INFLUENCE_FLOOR
                  ? ' Dimmed: the opponent barely moves this position.'
                  : ''}
              </p>
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Wk</th>
                      <th>Opponent</th>
                      <th className="num">Matchup</th>
                      <th className="num">App</th>
                      <th className="num">ESPN</th>
                      <th className="num">Actual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map((row) => {
                      const isLive = row.week === week;
                      return (
                        <tr
                          key={row.week}
                          style={
                            isLive
                              ? { background: 'var(--accent-wash)', fontWeight: 600 }
                              : undefined
                          }
                        >
                          <td className="mono">{row.week}</td>
                          <td className="mono">
                            {row.opponent === null ? (
                              <span className="muted">Bye</span>
                            ) : (
                              <>
                                <span className="muted">{row.home ? 'vs' : '@'}</span>{' '}
                                {row.opponent}
                              </>
                            )}
                          </td>
                          <td className="num">
                            {row.opponent === null ? (
                              <span className="muted">&mdash;</span>
                            ) : (
                              <MatchupChip score={row.matchupScore} group={p.group} />
                            )}
                          </td>
                          <td className="num muted">
                            {row.app === null ? '—' : row.app.toFixed(1)}
                          </td>
                          <td className="num">{row.espn ? row.espn.toFixed(1) : '—'}</td>
                          <td className="num bold">
                            {row.actual === null ? (
                              <span className="muted">&mdash;</span>
                            ) : (
                              row.actual.toFixed(1)
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ---- Week-by-week table (the non-visual view of the chart) ---- */}
          {weekly.length > 0 && (
            <section>
              <h3 className="section-title">Week by week</h3>
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Week</th>
                      <th>Opponent</th>
                      <th className="num">Projected</th>
                      <th className="num">Actual</th>
                      <th className="num">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weekly.map((w) => {
                      const delta = w.projected === null ? null : w.actual - w.projected;
                      return (
                        <tr key={w.week}>
                          <td>Week {w.week}</td>
                          <td className="mono">{w.opponent ?? '—'}</td>
                          <td className="num muted">
                            {w.projected === null ? '—' : w.projected.toFixed(1)}
                          </td>
                          <td className="num bold">{w.actual.toFixed(1)}</td>
                          <td
                            className="num"
                            style={{
                              color:
                                delta === null
                                  ? 'var(--text-muted)'
                                  : delta >= 0
                                    ? 'var(--success-text)'
                                    : 'var(--danger-text)',
                            }}
                          >
                            {delta === null
                              ? '—'
                              : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ---- Why this Value Score ---- */}
          {value && (
            <section>
              <h3 className="section-title">
                Why in-season score {value.score}
              </h3>
              {value.breakdown.gamesConfidence < 1 && (
                <div className="small muted" style={{ marginBottom: 8 }}>
                  Small sample: blended {fmtPct(1 - value.breakdown.gamesConfidence)} toward
                  neutral.
                </div>
              )}
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Signal</th>
                      <th className="num">Weight</th>
                      <th className="num">Percentile</th>
                      <th className="num">Contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...value.breakdown.contributions]
                      .sort((a, b) => b.points - a.points)
                      .map((c) => (
                        <tr key={c.label}>
                          <td>{c.label}</td>
                          <td className="num muted">
                            {((c.weight / totalWeight) * 100).toFixed(1)}%
                          </td>
                          <td className="num">{fmtPct(c.normalized)}</td>
                          <td className="num bold">{(c.points * 1000).toFixed(0)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <div className="row" style={{ gap: 8, paddingBottom: 8 }}>
            <StatusBadge status={p.status} />
            <span className="tiny muted">
              Week {week} classification, using this league's scoring.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

const totalWeight = Object.values(VALUE_WEIGHTS).reduce((a, b) => a + b, 0);
const seasonTotalWeight = Object.values(SEASON_WEIGHTS).reduce((a, b) => a + b, 0);

/** Buy/Sell/Fair marker for the gap between intrinsic value and market price. */
function VerdictChip({ verdict }: { verdict: string }) {
  const tone =
    verdict === 'Buy'
      ? 'var(--success-text)'
      : verdict === 'Sell'
        ? 'var(--danger-text)'
        : 'var(--text-muted)';
  const label =
    verdict === 'Buy'
      ? 'Buy low'
      : verdict === 'Sell'
        ? 'Sell high'
        : verdict === 'Fair'
          ? 'Fairly valued'
          : verdict;
  // The three abstentions mean different things and shouldn't read alike.
  const why =
    verdict === 'Thin market'
      ? "Priced near the bottom of his position, where the market's numbers are too coarse to disagree with"
      : verdict === 'No read'
        ? 'Priced, but with no production for this model to weigh it against — the market is paying for draft capital or prospect status, which this model has no source for'
        : verdict === 'No market'
          ? 'FantasyCalc does not price this position'
          : 'This model’s rank among priced players at his position, against the market’s rank over the same group';
  return (
    <span
      className="chip"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
      title={why}
    >
      {label}
    </span>
  );
}

/**
 * One positional rank, in the colour the row uses for it.
 *
 * Renders nothing when the rank is missing. The row shows a dash there because
 * its three ranks are a fixed-width unit that would jump around otherwise; the
 * sheet has no such constraint, and an absent rank is better said by absence
 * than by a dash the reader has to decode.
 */
function RankChip({
  rank,
  kind,
  label,
}: {
  rank: RankInfo | null;
  kind: 'total' | 'ppg' | 'boom';
  label: string;
}) {
  if (!rank) return null;

  return (
    <span
      className="chip chip-outline"
      style={{ color: `var(--rank-${kind})` }}
      title={`${rank.group} rank ${rank.rank} of ${rank.outOf} by ${label} in ${rank.season}`}
    >
      {rank.group} #{rank.rank} {label}
    </span>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="metric">
      <div className="tiny muted">{label}</div>
      <div className="mono bold" style={{ fontSize: 16, color: tone }}>
        {value}
      </div>
      {sub && <div className="tiny muted">{sub}</div>}
    </div>
  );
}
