/**
 * Matchups — every head-to-head game for the selected week, from the league
 * score through the player-level probabilities that drive the simulation.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { PlayerModal } from '../components/PlayerModal';
import {
  EmptyState,
  MatchupChip,
  RangeReadout,
  WinProbBar,
  fmt1,
  fmtPct,
} from '../components/primitives';
import { useTheme } from '../components/ThemeProvider';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import {
  appProjectionFor,
  projectedLineupTotal,
  weekForecasts,
  weekIsComplete,
  weekOdds,
} from '../data/predictions';
import { buildRosterWeek, type RosterWeek } from '../data/selectors';
import type { TeamInfo } from '../data/league';
import { teamColor } from '../lib/colors';
import type { PlayerForecast } from '../lib/forecast';
import type { EnrichedPlayer } from '../lib/types';

interface PlayerChance {
  player: EnrichedPlayer;
  chance: number;
}

interface MatchupSide {
  team: TeamInfo;
  roster: RosterWeek;
  winProb: number;
  appProjection: number;
  simulatedMean: number;
  simulatedMedian: number;
  remaining: number;
  range: [number, number] | null;
  matchupScore: number | null;
  boom: PlayerChance | null;
  bust: PlayerChance | null;
}

function weightedLineupMatchup(starters: EnrichedPlayer[]): number | null {
  const scored = starters.filter((player) => player.matchupScore !== null);
  if (!scored.length) return null;

  const projected = scored.reduce((sum, player) => sum + Math.max(0, player.proj), 0);
  if (projected <= 0) {
    return scored.reduce((sum, player) => sum + (player.matchupScore ?? 0), 0) / scored.length;
  }

  return scored.reduce(
    (sum, player) =>
      sum + (player.matchupScore ?? 0) * (Math.max(0, player.proj) / projected),
    0,
  );
}

function highestChance(
  starters: EnrichedPlayer[],
  forecasts: ReadonlyMap<string, PlayerForecast>,
  kind: 'boomProb' | 'bustProb',
): PlayerChance | null {
  let highest: PlayerChance | null = null;
  for (const player of starters) {
    const chance = forecasts.get(player.pid)?.[kind] ?? null;
    if (chance === null || (highest && chance <= highest.chance)) continue;
    highest = { player, chance };
  }
  return highest;
}

export function MatchupsPage() {
  const data = useLeagueData();
  const { week, setSelectedTeamId } = useLeague();
  const { mode } = useTheme();
  const [openPid, setOpenPid] = useState<string | null>(null);

  const odds = useMemo(() => {
    const complete = weekIsComplete(data, week);
    const simulation = weekOdds(data, week, complete ? 'pregame' : 'live');
    return simulation ? { simulation, pregame: complete } : null;
  }, [data, week]);

  /* Player probabilities always stay pregame. Once a result exists, replacing
     its forecast with the result would turn boom/bust risk into hindsight. */
  const forecasts = useMemo(() => weekForecasts(data, week, 'pregame'), [data, week]);

  const matchups = useMemo(() => {
    if (!odds) return [];

    return odds.simulation.matchups.flatMap((game) => {
      const homeTeam = data.teamsById.get(game.home);
      const awayTeam = data.teamsById.get(game.away);
      const homeRoster = buildRosterWeek(data, game.home, week);
      const awayRoster = buildRosterWeek(data, game.away, week);
      if (!homeTeam || !awayTeam || !homeRoster || !awayRoster) return [];

      const side = (
        team: TeamInfo,
        roster: RosterWeek,
        winProb: number,
        simulatedMean: number,
        simulatedMedian: number,
        remaining: number,
      ): MatchupSide => ({
        team,
        roster,
        winProb,
        appProjection: projectedLineupTotal(roster.starters, forecasts, 'app'),
        simulatedMean,
        simulatedMedian,
        remaining,
        range: odds.simulation.intervals.get(team.teamId) ?? null,
        matchupScore: weightedLineupMatchup(roster.starters),
        boom: highestChance(roster.starters, forecasts, 'boomProb'),
        bust: highestChance(roster.starters, forecasts, 'bustProb'),
      });

      return [{
        matchupId: game.matchupId,
        home: side(
          homeTeam,
          homeRoster,
          game.homeWinProb,
          game.homeMean,
          game.homeMedian,
          game.homeRemaining,
        ),
        away: side(
          awayTeam,
          awayRoster,
          game.awayWinProb,
          game.awayMean,
          game.awayMedian,
          game.awayRemaining,
        ),
      }];
    });
  }, [data, forecasts, odds, week]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Matchups</h1>
          {odds && (
            <p className="small muted">
              Week {week} · {odds.pregame ? 'pregame replay' : 'live'} ·{' '}
              {odds.simulation.iterations.toLocaleString()} simulations
            </p>
          )}
        </div>
      </div>

      {!odds || matchups.length === 0 ? (
        <EmptyState title="No matchups this week" hint="This may be a playoff bye." />
      ) : (
        <div className="stack">
          {matchups.map(({ matchupId, home, away }) => {
            const homeColor = teamColor(home.team.teamId, mode);
            const awayColor = teamColor(away.team.teamId, mode);
            return (
              <section key={matchupId} className="card matchup-card">
                <div className="matchup-card__scoreboard">
                  <TeamForecast
                    side={home}
                    color={homeColor}
                    onSelect={() => setSelectedTeamId(home.team.teamId)}
                  />
                  <span className="matchup-card__versus tiny muted">vs</span>
                  <TeamForecast
                    side={away}
                    color={awayColor}
                    align="right"
                    onSelect={() => setSelectedTeamId(away.team.teamId)}
                  />
                  <div className="matchup-card__probability">
                    <WinProbBar
                      homeProb={home.winProb}
                      awayProb={away.winProb}
                      homeColor={homeColor}
                      awayColor={awayColor}
                      label={`${home.team.name} ${Math.round(home.winProb * 100)} percent, ${away.team.name} ${Math.round(away.winProb * 100)} percent`}
                    />
                  </div>
                </div>

                <div className="scroll-x">
                  <table className="table matchup-card__stats">
                    <thead>
                      <tr>
                        <th>Matchup stat</th>
                        <th className="num" style={{ color: homeColor }}>{home.team.name}</th>
                        <th className="num" style={{ color: awayColor }}>{away.team.name}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <ComparisonRow
                        label={odds.pregame ? 'Final score' : 'Score now'}
                        home={scoreNow(home.roster)}
                        away={scoreNow(away.roster)}
                      />
                      <ComparisonRow
                        label="App projection"
                        home={fmt1(home.appProjection)}
                        away={fmt1(away.appProjection)}
                      />
                      <ComparisonRow
                        label="ESPN projection"
                        home={fmt1(home.roster.projectedTotal)}
                        away={fmt1(away.roster.projectedTotal)}
                      />
                      <ComparisonRow
                        label="Simulated mean"
                        home={fmt1(home.simulatedMean)}
                        away={fmt1(away.simulatedMean)}
                      />
                      <ComparisonRow
                        label="10th–90th range"
                        home={rangeText(home.range)}
                        away={rangeText(away.range)}
                      />
                      {!odds.pregame && (
                        <ComparisonRow
                          label="Projected remaining"
                          home={fmt1(home.remaining)}
                          away={fmt1(away.remaining)}
                        />
                      )}
                      <ComparisonRow
                        label="Lineup matchup"
                        home={<MatchupChip score={home.matchupScore} />}
                        away={<MatchupChip score={away.matchupScore} />}
                      />
                      <ComparisonRow
                        label="Likely boom"
                        home={<Chance chance={home.boom} tone="var(--success-text)" icon="▲" />}
                        away={<Chance chance={away.boom} tone="var(--success-text)" icon="▲" />}
                      />
                      <ComparisonRow
                        label="Likely bust"
                        home={<Chance chance={home.bust} tone="var(--danger-text)" icon="▼" />}
                        away={<Chance chance={away.bust} tone="var(--danger-text)" icon="▼" />}
                      />
                    </tbody>
                  </table>
                </div>

                <details className="matchup-card__lineups">
                  <summary>Starters &amp; player outlook</summary>
                  <p className="tiny muted matchup-card__lineup-note">
                    App is the bias- and matchup-adjusted pregame median. Boom means at least 120% of ESPN&rsquo;s
                    projection; bust means at most 80%. Matchup is 0&ndash;100, higher is softer.
                  </p>
                  <div className="matchup-lineups">
                    <Lineup
                      side={home}
                      color={homeColor}
                      forecasts={forecasts}
                      onSelectPlayer={setOpenPid}
                    />
                    <Lineup
                      side={away}
                      color={awayColor}
                      forecasts={forecasts}
                      onSelectPlayer={setOpenPid}
                    />
                  </div>
                </details>
              </section>
            );
          })}

          <p className="tiny muted matchup-method">
            App projection adds the adjusted player medians. The simulated mean and range draw
            every unfinished starter from position-specific historical error distributions;
            the range is now centred on the simulation&rsquo;s actual median rather than its mean.
            Lineup matchup is the ESPN-projection-weighted average of the starters&rsquo; opponent
            ratings. It is context, not a second team-strength score.
          </p>
        </div>
      )}

      <PlayerModal pid={openPid} week={week} onClose={() => setOpenPid(null)} />
    </>
  );
}

function TeamForecast({
  side,
  color,
  align = 'left',
  onSelect,
}: {
  side: MatchupSide;
  color: string;
  align?: 'left' | 'right';
  onSelect: () => void;
}) {
  return (
    <div className={`matchup-card__team${align === 'right' ? ' is-away' : ''}`}>
      <button className="team-name" style={{ color }} onClick={onSelect}>
        {align === 'left' && (
          <span className="team-name__dot" style={{ background: color }} aria-hidden="true" />
        )}
        {side.team.name}
        {align === 'right' && (
          <span className="team-name__dot" style={{ background: color }} aria-hidden="true" />
        )}
      </button>
      <span className="tiny muted">{side.team.ownerName}</span>
      <span className="tiny mono">
        <span className="projection-app">{fmt1(side.appProjection)} app</span>
        {' · '}{fmt1(side.roster.projectedTotal)} ESPN
      </span>
      <span className="matchup-card__win mono" style={{ color }}>
        {fmtPct(side.winProb)}
      </span>
      {side.range && (
        <RangeReadout
          median={side.simulatedMedian}
          low={side.range[0]}
          high={side.range[1]}
          size={14}
        />
      )}
    </div>
  );
}

function ComparisonRow({ label, home, away }: { label: string; home: ReactNode; away: ReactNode }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="num bold">{home}</td>
      <td className="num bold">{away}</td>
    </tr>
  );
}

function Chance({
  chance,
  tone,
  icon,
}: {
  chance: PlayerChance | null;
  tone: string;
  icon: string;
}) {
  if (!chance) return <span className="muted">—</span>;
  return (
    <span style={{ color: tone }} title={chance.player.name}>
      <span aria-hidden="true">{icon}</span> {chance.player.name} · {fmtPct(chance.chance)}
    </span>
  );
}

function Lineup({
  side,
  color,
  forecasts,
  onSelectPlayer,
}: {
  side: MatchupSide;
  color: string;
  forecasts: ReadonlyMap<string, PlayerForecast>;
  onSelectPlayer: (pid: string) => void;
}) {
  return (
    <div className="matchup-lineup">
      <div className="matchup-lineup__head" style={{ color }}>
        <span>{side.team.name}</span>
        <span className="mono">
          <span className="projection-app">{fmt1(side.appProjection)} app</span>
          {' · '}{fmt1(side.roster.projectedTotal)} ESPN
        </span>
      </div>
      {side.roster.starters.map((player) => {
        const forecast = forecasts.get(player.pid);
        return (
          <button
            key={player.pid}
            type="button"
            className="matchup-lineup__player"
            onClick={() => onSelectPlayer(player.pid)}
          >
            <span className="matchup-lineup__identity">
              <span className="chip chip-outline matchup-lineup__slot">{player.slot}</span>
              <span>
                <span className="bold">{player.name}</span>
                <span className="tiny muted matchup-lineup__opponent">
                  {player.team || '—'}
                  {player.opponent ? ` vs ${player.opponent}` : player.onBye ? ' · BYE' : ''}
                </span>
              </span>
            </span>
            <span className="matchup-lineup__numbers">
              <span className="mono projection-app" title="App projection">
                App {fmt1(appProjectionFor(player, forecasts))}
              </span>
              <span className="mono" title={`ESPN projection ${fmt1(player.proj)}`}>
                ESPN {fmt1(player.proj)}
              </span>
              {player.hasPlayed && <span className="mono">Actual {fmt1(player.act)}</span>}
              <MatchupChip score={player.matchupScore} group={player.group} />
              {forecast?.boomProb !== null && forecast?.boomProb !== undefined && (
                <span className="mono" style={{ color: 'var(--success-text)' }} title="Likely boom">
                  ▲ {fmtPct(forecast.boomProb)}
                </span>
              )}
              {forecast?.bustProb !== null && forecast?.bustProb !== undefined && (
                <span className="mono" style={{ color: 'var(--danger-text)' }} title="Likely bust">
                  ▼ {fmtPct(forecast.bustProb)}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function scoreNow(roster: RosterWeek): string {
  return roster.starters.some((player) => player.hasPlayed) ? fmt1(roster.actualTotal) : '—';
}

function rangeText(range: [number, number] | null): string {
  return range ? `${range[0].toFixed(0)}–${range[1].toFixed(0)}` : '—';
}
