/**
 * Analytics — league-wide standings, schedule-independent team strength and
 * matchup research, all computed with this league's custom scoring.
 */

import { useMemo, useState } from 'react';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { buildRosterWeek } from '../data/selectors';
import { seasonOdds } from '../data/predictions';
import {
  EmptyState,
  MatchupChip,
  PlacementBadge,
  StatTile,
  StatTileRow,
  fmt1,
  fmtPct,
  fmtSigned,
} from '../components/primitives';
import { LazyWeeklyTeamRankChart } from '../components/LazyChart';
import { useTheme } from '../components/ThemeProvider';
import { teamColor } from '../lib/colors';
import {
  buildPowerIndex,
  POSITION_POWER_COUNTS,
  powerIndexOf,
} from '../lib/power';
import { mean, quantile, round, stdev } from '../lib/stats';
import { POSITION_GROUPS, type PositionGroup } from '../lib/types';

interface AllPlayRecord {
  wins: number;
  losses: number;
  ties: number;
}

type PowerScope = 'ALL' | PositionGroup;

export function AnalyticsPage() {
  const data = useLeagueData();
  const { setSelectedTeamId, week } = useLeague();
  const { mode } = useTheme();
  const [muGroup, setMuGroup] = useState<PositionGroup>('WR');
  const [powerScope, setPowerScope] = useState<PowerScope>('ALL');

  const playoffOdds = useMemo(() => seasonOdds(data, week), [data, week]);

  /**
   * Build every team-week once. buildRosterWeek is memoized, so this also warms
   * the selector cache for Teams, Optimal and History.
   */
  const standings = useMemo(() => {
    const base = data.teams.map((team) => {
      const weekly = [];

      for (let week = 1; week <= data.currentWeek; week++) {
        const rosterWeek = buildRosterWeek(data, team.teamId, week);
        if (!rosterWeek || rosterWeek.starters.length === 0) continue;
        weekly.push({
          week,
          actual: rosterWeek.actualTotal,
          optimal: rosterWeek.optimalTotal,
        });
      }

      const scores = weekly.map((row) => row.actual);
      const actual = scores.reduce((sum, score) => sum + score, 0);
      const optimal = weekly.reduce((sum, row) => sum + row.optimal, 0);
      const recentScores = scores.slice(-4);

      return {
        ...team,
        weekly,
        actual: round(actual),
        optimal: round(optimal),
        avg: round(mean(scores)),
        recentAvg: round(mean(recentScores)),
        median: round(quantile(scores, 0.5)),
        best: scores.length ? round(Math.max(...scores)) : 0,
        volatility: round(stdev(scores)),
        efficiency: optimal > 0 ? actual / optimal : 0,
      };
    });

    // All-play asks how each team would fare against every other team each
    // regular-season week, removing the noise of the actual head-to-head draw.
    const allPlay = new Map<number, AllPlayRecord>(
      base.map((team) => [team.teamId, { wins: 0, losses: 0, ties: 0 }]),
    );
    const regularSeasonWeeks = Math.max(
      0,
      ...base.map((team) => team.wins + team.losses + team.ties),
    );

    for (let week = 1; week <= Math.min(regularSeasonWeeks, data.currentWeek); week++) {
      const weekScores = base
        .map((team) => ({
          teamId: team.teamId,
          score: team.weekly.find((row) => row.week === week)?.actual,
        }))
        .filter((row): row is { teamId: number; score: number } => row.score !== undefined);

      for (let i = 0; i < weekScores.length; i++) {
        for (let j = i + 1; j < weekScores.length; j++) {
          const a = weekScores[i];
          const b = weekScores[j];
          const aRecord = allPlay.get(a.teamId)!;
          const bRecord = allPlay.get(b.teamId)!;

          if (a.score === b.score) {
            aRecord.ties++;
            bRecord.ties++;
          } else if (a.score > b.score) {
            aRecord.wins++;
            bRecord.losses++;
          } else {
            bRecord.wins++;
            aRecord.losses++;
          }
        }
      }
    }

    return base
      .map((team) => {
        const record = allPlay.get(team.teamId)!;
        const comparisons = record.wins + record.losses + record.ties;
        const allPlayPct = comparisons
          ? (record.wins + record.ties * 0.5) / comparisons
          : 0;
        const games = team.wins + team.losses + team.ties;
        const expectedWins = allPlayPct * games;
        const actualWins = team.wins + team.ties * 0.5;

        return {
          ...team,
          winPct: games ? actualWins / games : 0,
          allPlay: record,
          allPlayPct,
          expectedWins,
          scheduleLuck: actualWins - expectedWins,
        };
      })
      .sort((a, b) => b.wins - a.wins || b.actual - a.actual);
  }, [data]);

  /**
   * Forward-looking roster power from the app's headline Value Scores.
   *
   * Every held player is considered, including taxi and reserve. Each position
   * uses its configured starter core plus a lightly weighted group of backups.
   */
  const powerIndex = useMemo(
    () =>
      buildPowerIndex({
        rosters: data.teams.map((team) => ({
          teamId: team.teamId,
          playerIds: team.players,
        })),
        /*
         * Trade Points, not the Value Score.
         *
         * The Value Score is a percentile inside a position group, so averaging
         * it across positions weights every starting slot equally *in percentile
         * space*: an elite kicker moved this index as much as an elite
         * quarterback, while being worth a fifth as many real points. Measured
         * on these rosters it compressed seven of the eight teams into a
         * six-point band and reordered two of them. Points over replacement are
         * cross-positionally comparable, which is the only property this
         * average ever needed. See `lib/trade.ts`.
         */
        players: new Map(
          [...data.tradeValues.byPlayer].map(
            ([pid, value]) => [pid, { group: value.group, value: value.points }] as const,
          ),
        ),
      }),
    [data],
  );

  const power = useMemo(() => {
    const rows = standings.map((team) => {
      const teamPower = powerIndex.byTeam.get(team.teamId);
      const group = teamPower && powerScope !== 'ALL' ? teamPower.byGroup[powerScope] : null;
      return {
        team,
        value: powerScope === 'ALL' ? (teamPower?.overall ?? 0) : (group?.score ?? 0),
      };
    });
    const best = Math.max(0, ...rows.map((row) => row.value));

    // Sorted on the raw score, not the rounded one: two teams a hundredth of a
    // point apart round to the same tenth and would otherwise be listed in an
    // order that contradicts the index shown beside them.
    return rows
      .map(({ team, value }) => ({
        ...team,
        score: value,
        powerIndex: round(powerIndexOf(value, best), 1),
        powerPoints: round(value, 1),
      }))
      .sort((a, b) => b.score - a.score || a.teamId - b.teamId);
  }, [powerScope, standings, powerIndex]);

  const weeklyRanks = useMemo(() => {
    const teams = power.map((team) => ({
      teamId: team.teamId,
      dataKey: `team_${team.teamId}`,
      name: team.name,
      color: teamColor(team.teamId, mode),
    }));

    const records = new Map(
      teams.map((team) => [
        team.teamId,
        { wins: 0, losses: 0, ties: 0, pointsFor: 0 },
      ]),
    );
    const regularSeasonWeeks = Math.max(
      0,
      ...data.teams.map((team) => team.wins + team.losses + team.ties),
    );

    const points = Array.from({ length: data.currentWeek }, (_, index) => {
      const week = index + 1;
      const games = week <= regularSeasonWeeks ? (data.scheduleByWeek.get(week) ?? []) : [];

      for (const game of games) {
        if (game.awayTeamId === null || !game.complete) continue;
        const aRecord = records.get(game.homeTeamId);
        const bRecord = records.get(game.awayTeamId);
        if (!aRecord || !bRecord) continue;

        aRecord.pointsFor += game.homeScore;
        bRecord.pointsFor += game.awayScore;

        if (game.homeScore === game.awayScore) {
          aRecord.ties++;
          bRecord.ties++;
        } else if (game.homeScore > game.awayScore) {
          aRecord.wins++;
          bRecord.losses++;
        } else {
          bRecord.wins++;
          aRecord.losses++;
        }
      }

      const point: { week: string } & Record<string, string | number | null> = {
        week: `W${week}`,
      };
      for (const team of teams) {
        const record = records.get(team.teamId)!;
        const standingWins = record.wins + record.ties * 0.5;
        point[team.dataKey] =
          1 +
          [...records.values()].filter((other) => {
            const otherWins = other.wins + other.ties * 0.5;
            return (
              otherWins > standingWins ||
              (otherWins === standingWins && other.pointsFor > record.pointsFor)
            );
          }).length;
      }
      return point;
    });

    return { teams, points };
  }, [data, mode, power]);

  const defenses = useMemo(() => {
    const entries = data.matchupIndex.byGroup.get(muGroup);
    return entries
      ? [...entries.keys()]
          .flatMap((defense) => {
            const entry = data.matchupIndex.get(muGroup, defense);
            return entry ? [entry] : [];
          })
          .sort((a, b) => b.score - a.score)
      : [];
  }, [data, muGroup]);

  const activeGroups = useMemo(
    () => POSITION_GROUPS.filter((group) => (data.matchupIndex.byGroup.get(group)?.size ?? 0) > 0),
    [data],
  );

  if (!standings.length) return <EmptyState title="No data yet" />;

  const leagueAvg = mean(standings.map((team) => team.avg));
  const totalLeft = standings.reduce((sum, team) => sum + (team.optimal - team.actual), 0);
  const bestWeekTeam = standings.reduce((best, team) => (team.best > best.best ? team : best));
  const efficientTeam = standings.reduce((best, team) =>
    team.efficiency > best.efficiency ? team : best,
  );
  const unluckiestTeam = standings.reduce((lowest, team) =>
    team.scheduleLuck < lowest.scheduleLuck ? team : lowest,
  );

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Analytics</h1>
      </div>

      {data.currentWeek === 0 ? (
        /*
         * Every tile here summarises results, and there are none yet. A row of
         * zeroes reads as "your league scores nothing", which is worse than
         * saying the season hasn't started — the odds and power sections below
         * run entirely off projections and are the live part of this page.
         */
        <section className="card card-pad">
          <h2 className="bold">No games played yet</h2>
          <p className="small muted" style={{ marginTop: 6 }}>
            Season summaries fill in from week 1. Playoff odds and power rankings
            below are built from projections and work now.
          </p>
        </section>
      ) : (
      <StatTileRow>
        <StatTile label="League avg / week" value={fmt1(leagueAvg)} />
        <StatTile label={`Best week · ${bestWeekTeam.name}`} value={fmt1(bestWeekTeam.best)} />
        <StatTile
          label={`Top efficiency · ${efficientTeam.name}`}
          value={fmtPct(efficientTeam.efficiency, 1)}
        />
        <StatTile
          label={`Unluckiest · ${unluckiestTeam.name}`}
          value={`${fmtSigned(unluckiestTeam.scheduleLuck)} W`}
        />
        <StatTile label="Points left on benches" value={fmt1(totalLeft)} />
      </StatTileRow>
      )}

      <div style={{ height: 16 }} />

      <div className="stack">
        {playoffOdds && (
          <section className="card" style={{ overflow: 'hidden' }}>
            <div className="group-head group-head--primary">
              <span>Playoff odds entering Week {week}</span>
              <span className="mono">
                top {data.playoff.teams} of {data.teams.length}
              </span>
            </div>
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th className="num" title="Mean simulated regular-season wins">
                      Proj. W
                    </th>
                    <th className="num">Playoff</th>
                    <th className="num">Top seed</th>
                    <th className="num">Final</th>
                    <th className="num">Title</th>
                  </tr>
                </thead>
                <tbody>
                  {[...playoffOdds.byTeam.values()]
                    .sort((a, b) => b.titleProb - a.titleProb || b.playoffProb - a.playoffProb)
                    .map((row) => {
                      const team = data.teamsById.get(row.teamId);
                      if (!team) return null;
                      const color = teamColor(row.teamId, mode);
                      return (
                        <tr key={row.teamId}>
                          <td>
                            <button
                              className="team-name"
                              style={{ color }}
                              onClick={() => setSelectedTeamId(row.teamId)}
                            >
                              <span
                                className="team-name__dot"
                                style={{ background: color }}
                                aria-hidden="true"
                              />
                              {team.name}
                            </button>
                          </td>
                          <td className="num">{row.expectedWins.toFixed(1)}</td>
                          <td className="num bold odds-cell">
                            {fmtPct(row.playoffProb)}
                            <span className="odds-cell__track">
                              <span
                                className="odds-cell__fill"
                                style={{ width: `${row.playoffProb * 100}%`, background: color }}
                              />
                            </span>
                          </td>
                          <td className="num muted">{fmtPct(row.topSeedProb)}</td>
                          <td className="num muted">{fmtPct(row.finalProb)}</td>
                          <td className="num bold odds-cell">
                            {fmtPct(row.titleProb)}
                            <span className="odds-cell__track">
                              <span
                                className="odds-cell__fill"
                                style={{ width: `${row.titleProb * 100}%`, background: color }}
                              />
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            <p className="card-pad tiny muted" style={{ paddingTop: 0 }}>
              {playoffOdds.regularSeasonComplete
                ? `The regular season is already settled, so seeding is fixed and only the bracket is simulated.`
                : `Weeks ${playoffOdds.simulatedWeeks[0]}–${
                    playoffOdds.simulatedWeeks[playoffOdds.simulatedWeeks.length - 1]
                  } replayed ${playoffOdds.iterations.toLocaleString()} times, carrying in the real record through Week ${week - 1}, then the bracket resolved under the league's own format.`}{' '}
              Every simulated week uses its own ESPN projection, bye schedule,
              opponent-adjusted positional difficulty and best legal projected lineup.
            </p>
          </section>
        )}

        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Standings &amp; team metrics</span>
          </div>
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Team</th>
                  <th className="num">W-L</th>
                  <th className="num">Total</th>
                  <th className="num">Avg</th>
                  <th className="num">Last 4</th>
                  <th className="num">Median</th>
                  <th className="num">High</th>
                  <th className="num" title="Weekly scoring standard deviation; lower is steadier">
                    Vol.
                  </th>
                  <th className="num" title="Record against every other team each regular-season week">
                    All-play
                  </th>
                  <th className="num" title="Actual wins minus wins expected from all-play performance">
                    Luck
                  </th>
                  <th className="num">Eff.</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((team) => {
                  const color = teamColor(team.teamId, mode);
                  return (
                    <tr key={team.teamId}>
                      <td>
                        <button
                          className="team-name"
                          style={{ color }}
                          onClick={() => setSelectedTeamId(team.teamId)}
                        >
                          <span
                            className="team-name__dot"
                            style={{ background: color }}
                            aria-hidden="true"
                          />
                          {team.name} <PlacementBadge placement={team.placement} />
                        </button>
                      </td>
                      <td className="num">
                        {team.wins}-{team.losses}
                        {team.ties ? `-${team.ties}` : ''}
                      </td>
                      <td className="num bold">{fmt1(team.actual)}</td>
                      <td className="num">{fmt1(team.avg)}</td>
                      <td className="num">{fmt1(team.recentAvg)}</td>
                      <td className="num muted">{fmt1(team.median)}</td>
                      <td className="num muted">{fmt1(team.best)}</td>
                      <td className="num muted">{fmt1(team.volatility)}</td>
                      <td className="num">
                        {team.allPlay.wins}-{team.allPlay.losses}
                        {team.allPlay.ties ? `-${team.allPlay.ties}` : ''}
                      </td>
                      <td
                        className="num bold"
                        style={{
                          color:
                            team.scheduleLuck > 0.05
                              ? 'var(--success-text)'
                              : team.scheduleLuck < -0.05
                                ? 'var(--danger-text)'
                                : undefined,
                        }}
                      >
                        {fmtSigned(team.scheduleLuck)}
                      </td>
                      <td className="num">{fmtPct(team.efficiency, 1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section
          className="card"
          style={{ overflow: 'hidden' }}
          aria-describedby="power-formula"
        >
          <div className="group-head group-head--primary">
            <span>Power rankings</span>
            <span className="mono">
              {powerScope === 'ALL'
                ? 'Overall · pts over replacement'
                : `${powerScope} · ${POSITION_POWER_COUNTS[powerScope].starters} + ${POSITION_POWER_COUNTS[powerScope].bench} depth`}
            </span>
          </div>
          <p id="power-formula" className="sr-only">
            {powerScope === 'ALL'
              ? 'Overall power combines each roster’s position ratings, weighted by starter count. Every rating is in projected points over replacement, so positions are on one scale. The bar is scaled so the strongest roster reads 100.'
              : `${powerScope} power gives 85 percent of its weight to the top ${POSITION_POWER_COUNTS[powerScope].starters} ${powerScope} by projected points over replacement, and 15 percent to the next ${POSITION_POWER_COUNTS[powerScope].bench}. The bar is scaled so the strongest reads 100.`}
          </p>
          <div className="card-pad power-controls">
            <div className="segmented" role="group" aria-label="Power ranking scope">
              <button
                aria-pressed={powerScope === 'ALL'}
                onClick={() => setPowerScope('ALL')}
              >
                Overall
              </button>
              {POSITION_GROUPS.map((group) => (
                <button
                  key={group}
                  aria-pressed={powerScope === group}
                  onClick={() => setPowerScope(group)}
                >
                  {group}
                </button>
              ))}
            </div>
          </div>
          <div className="card-pad power-list">
            {power.map((team, index) => {
              const color = teamColor(team.teamId, mode);
              return (
                <div key={team.teamId} className="power-row">
                  <span className="power-rank mono bold">{index + 1}</span>
                  <button
                    className="team-name power-team"
                    style={{ color }}
                    onClick={() => setSelectedTeamId(team.teamId)}
                  >
                    <span
                      className="team-name__dot"
                      style={{ background: color }}
                      aria-hidden="true"
                    />
                    {team.name}
                  </button>
                  <span
                    className="power-track"
                    role="meter"
                    aria-label={`${team.name} ${powerScope === 'ALL' ? 'overall' : powerScope} power index`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={team.powerIndex}
                  >
                    <span
                      className="power-fill"
                      style={{ width: `${team.powerIndex}%`, background: color }}
                    />
                  </span>
                  <span
                    className="power-value mono bold"
                    title={`${team.powerPoints.toFixed(1)} projected points over replacement per starting slot`}
                  >
                    {team.powerPoints.toFixed(1)}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Weekly W/L rank</span>
            <span className="mono">Record · points tiebreak</span>
          </div>
          <div className="card-pad">
            <LazyWeeklyTeamRankChart
              data={weeklyRanks.points}
              teams={weeklyRanks.teams}
              height={280}
            />
          </div>
        </section>

        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Matchup research — points allowed by defence</span>
            <span className="mono">
              {data.matchupFromPrior ? `${data.priorSeason} baseline` : `through W${data.currentWeek}`}
            </span>
          </div>

          <div className="card-pad" style={{ paddingBottom: 10 }}>
            <div className="segmented" role="group" aria-label="Position group">
              {activeGroups.map((group) => (
                <button
                  key={group}
                  aria-pressed={muGroup === group}
                  onClick={() => setMuGroup(group)}
                >
                  {group}
                </button>
              ))}
            </div>
          </div>

          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Defence</th>
                  <th className="num">Matchup</th>
                  <th className="num" title="Points allowed after adjusting for the offenses faced">
                    Adj/gm
                  </th>
                  <th className="num">Raw/gm</th>
                  <th className="num" title="Position-specific opportunities allowed per game">
                    Opp/gm
                  </th>
                  <th className="num">Last 4</th>
                  <th className="num">Ceiling%</th>
                  <th className="num">Floor%</th>
                  <th className="num">Top-10%</th>
                  <th className="num">Games</th>
                </tr>
              </thead>
              <tbody>
                {defenses.map((defense) => (
                  <tr key={defense.defense}>
                    <td className="bold">{defense.defense}</td>
                    <td className="num">
                      <MatchupChip score={defense.score} group={muGroup} />
                    </td>
                    <td className="num bold">{fmt1(defense.opponentAdjustedPpg)}</td>
                    <td className="num">{fmt1(defense.pointsPerGame)}</td>
                    <td className="num">{fmt1(defense.opportunitiesPerGame)}</td>
                    <td className="num">{fmt1(defense.last4)}</td>
                    <td className="num muted">{fmtPct(defense.ceilingRate)}</td>
                    <td className="num muted">{fmtPct(defense.floorRate)}</td>
                    <td className="num muted">{fmtPct(defense.top10Rate)}</td>
                    <td className="num muted">{defense.games}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
