/**
 * Schedule — the NFL week, seen through the league's own lens.
 *
 * A bare fixture list is available anywhere. What makes this useful is the
 * overlay: for every game, which players in *this* league are involved, who
 * rosters them, what they scored under the league's own scoring, and how soft
 * each defence in the game has been to face.
 *
 * That turns the schedule into a planning tool — "who do I have in the Monday
 * night game", "is anyone starting against the league's most generous defence".
 */

import { useMemo, useState } from 'react';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { teamLogo } from '../lib/assets';
import { PlayerModal } from '../components/PlayerModal';
import {
  EmptyState,
  MatchupChip,
  StatTile,
  StatTileRow,
  fmt1,
} from '../components/primitives';
import { POSITION_GROUPS, type PositionGroup } from '../lib/types';

interface Game {
  week: number;
  home: string;
  away: string;
  kickoff: number;
  gameId: number;
}

/** A rostered player appearing in a given game. */
interface GamePlayer {
  pid: string;
  name: string;
  team: string;
  group: PositionGroup | null;
  points: number;
  projected: number;
  played: boolean;
  ownerName: string;
  isStarter: boolean;
}

export function SchedulePage() {
  const data = useLeagueData();
  const { week, setWeek, selectedTeamId } = useLeague();
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);

  /*
   * The NFL fixture list, rebuilt from the snapshot's pro schedule.
   *
   * That schedule is stored per NFL team, so every game appears twice — once
   * from each side. Keeping only the home team's copy collapses it back to one
   * row per fixture without needing to de-duplicate by id.
   */
  const games = useMemo<Game[]>(() => {
    const out: Game[] = [];
    const teamOf = new Map<number, string>();
    for (const player of data.playersById.values()) {
      if (player.proTeamId > 0 && player.team) teamOf.set(player.proTeamId, player.team);
    }

    for (const [teamId, byWeek] of Object.entries(data.proSchedule)) {
      const abbrev = teamOf.get(Number(teamId));
      if (!abbrev) continue;

      for (const [wk, game] of Object.entries(byWeek)) {
        // Keep the home team's copy only; the away team's is the same fixture.
        if (!game.home) continue;
        out.push({
          week: Number(wk),
          home: abbrev,
          away: game.opponent,
          kickoff: game.kickoff,
          gameId: game.gameId,
        });
      }
    }
    return out;
  }, [data.proSchedule, data.playersById]);

  /** pid -> which league team rosters them, and whether they started this week. */
  const ownership = useMemo(() => {
    const map = new Map<string, { ownerName: string; isStarter: boolean }>();
    const weekData = data.weeks.get(week);

    for (const team of data.teams) {
      // The lineup this team actually fielded that week, falling back to the
      // current one for a week that has not been played.
      const weekLineup = weekData?.lineups[String(team.teamId)];
      const slots =
        weekLineup && Object.keys(weekLineup).length > 0 ? weekLineup : team.slots;

      for (const [pid, slot] of Object.entries(slots)) {
        const upper = slot.toUpperCase();
        map.set(pid, {
          ownerName: team.name,
          isStarter: upper !== 'BN' && upper !== 'IR',
        });
      }
    }

    return map;
  }, [data, week]);

  /** Rostered players grouped by the NFL team they play for. */
  const playersByTeam = useMemo(() => {
    const map = new Map<string, GamePlayer[]>();
    const weekData = data.weeks.get(week);

    for (const [pid, owner] of ownership) {
      const player = data.playersById.get(pid);
      const nflTeam = (player?.team ?? '').toUpperCase();
      if (!nflTeam) continue;

      const statLine = weekData?.stats[pid];
      const projLine = weekData?.projections[pid];

      const entry: GamePlayer = {
        pid,
        name: player?.name || `Player ${pid}`,
        team: nflTeam,
        group: player?.group ?? null,
        points: data.score(statLine, player?.group ?? null),
        projected: data.score(projLine, player?.group ?? null),
        played: !!statLine,
        ownerName: owner.ownerName,
        isStarter: owner.isStarter,
      };

      const list = map.get(nflTeam);
      if (list) list.push(entry);
      else map.set(nflTeam, [entry]);
    }

    // Starters first, then by what they scored.
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          Number(b.isStarter) - Number(a.isStarter) ||
          b.points - a.points ||
          b.projected - a.projected,
      );
    }

    return map;
  }, [data, ownership, week]);

  const weekGames = useMemo(
    () =>
      games
        .filter((g) => g.week === week)
        .sort((a, b) => a.kickoff - b.kickoff || a.home.localeCompare(b.home)),
    [games, week],
  );

  const selectedTeamName =
    selectedTeamId !== null ? data.teamsById.get(selectedTeamId)?.name : undefined;

  const visibleGames = useMemo(() => {
    if (!onlyMine || !selectedTeamName) return weekGames;
    return weekGames.filter((g) =>
      [g.home, g.away].some((t) =>
        (playersByTeam.get(t) ?? []).some((p) => p.ownerName === selectedTeamName),
      ),
    );
  }, [weekGames, onlyMine, selectedTeamName, playersByTeam]);

  const weeks = Array.from({ length: data.maxWeek }, (_, i) => i + 1);

  // How many of the league's rostered players are on a bye this week.
  const byeCount = useMemo(() => {
    if (!weekGames.length) return 0;
    const playing = new Set<string>();
    for (const g of weekGames) {
      playing.add(g.home);
      playing.add(g.away);
    }
    let n = 0;
    for (const pid of ownership.keys()) {
      const t = (data.playersById.get(pid)?.team ?? '').toUpperCase();
      if (t && !playing.has(t)) n++;
    }
    return n;
  }, [weekGames, ownership, data]);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Schedule</h1>
      </div>

      <div className="filters">
        <div className="segmented" role="group" aria-label="Week">
          {weeks.map((w) => (
            <button key={w} aria-pressed={w === week} onClick={() => setWeek(w)}>
              {w}
            </button>
          ))}
        </div>

        {selectedTeamName && (
          <button
            className="btn btn-sm"
            aria-pressed={onlyMine}
            onClick={() => setOnlyMine((v) => !v)}
          >
            {onlyMine ? `Only ${selectedTeamName}` : 'All games'}
          </button>
        )}
      </div>

      {weekGames.length === 0 && (
        <EmptyState
          title={`No games scheduled for week ${week}`}
          hint="The snapshot carries the NFL fixture list; this week has none in it."
        />
      )}

      {games && weekGames.length > 0 && (
        <>
          <StatTileRow>
            <StatTile label="Games" value={String(weekGames.length)} />
            <StatTile
              label="Rostered players active"
              value={String(
                weekGames.reduce(
                  (n, g) =>
                    n +
                    (playersByTeam.get(g.home)?.length ?? 0) +
                    (playersByTeam.get(g.away)?.length ?? 0),
                  0,
                ),
              )}
            />
            <StatTile label="On bye" value={String(byeCount)} />
          </StatTileRow>

          <div style={{ height: 16 }} />

          <div className="stack">
            {visibleGames.map((game) => (
              <GameCard
                key={game.gameId}
                game={game}
                playersByTeam={playersByTeam}
                matchupFor={(defense, group) =>
                  (data.pregameMatchupIndexes.get(week) ?? data.matchupIndex)
                    .get(group, defense)?.score ?? null
                }
                onSelect={setOpenPid}
                highlightOwner={onlyMine ? selectedTeamName : undefined}
              />
            ))}
            {visibleGames.length === 0 && (
              <EmptyState
                title="No games involve your players this week"
                hint="Switch back to All games."
              />
            )}
          </div>
        </>
      )}

      <PlayerModal pid={openPid} week={week} onClose={() => setOpenPid(null)} />
    </>
  );
}

function GameCard({
  game,
  playersByTeam,
  matchupFor,
  onSelect,
  highlightOwner,
}: {
  game: Game;
  playersByTeam: Map<string, GamePlayer[]>;
  matchupFor: (defense: string, group: PositionGroup) => number | null;
  onSelect: (pid: string) => void;
  highlightOwner?: string;
}) {
  const home = playersByTeam.get(game.home) ?? [];
  const away = playersByTeam.get(game.away) ?? [];

  // ESPN gives kickoff as a real timestamp, so this shows local kickoff time
  // rather than a bare date — which is the part that decides a lineup.
  const date = new Date(game.kickoff);
  const dateLabel = Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
  const kickedOff = game.kickoff > 0 && Date.now() > game.kickoff;

  const total = (list: GamePlayer[]) =>
    list.reduce((s, p) => s + (p.played ? p.points : 0), 0);

  return (
    <section className="card" style={{ overflow: 'hidden' }}>
      <header className="group-head group-head--primary schedule-game__head">
        <span className="schedule-game__teams">
          <TeamMark team={game.away} />
          <span>{game.away}</span>
          <span className="muted" style={{ textTransform: 'none', fontWeight: 500 }}>
            at
          </span>
          <TeamMark team={game.home} />
          <span>{game.home}</span>
        </span>
        <span className="tiny muted schedule-game__kickoff">
          {dateLabel}
          {kickedOff ? ' · started' : ''}
        </span>
      </header>

      <div className="game-grid">
        <TeamSide
          team={game.away}
          opponent={game.home}
          players={away}
          total={total(away)}
          matchupFor={matchupFor}
          onSelect={onSelect}
          highlightOwner={highlightOwner}
        />
        <TeamSide
          team={game.home}
          opponent={game.away}
          players={home}
          total={total(home)}
          matchupFor={matchupFor}
          onSelect={onSelect}
          highlightOwner={highlightOwner}
        />
      </div>
    </section>
  );
}

function TeamMark({ team }: { team: string }) {
  return (
    <img
      src={teamLogo(team) ?? undefined}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      style={{ objectFit: 'contain' }}
      onError={(e) => {
        e.currentTarget.style.visibility = 'hidden';
      }}
    />
  );
}

function TeamSide({
  team,
  opponent,
  players,
  total,
  matchupFor,
  onSelect,
  highlightOwner,
}: {
  team: string;
  opponent: string;
  players: GamePlayer[];
  total: number;
  matchupFor: (defense: string, group: PositionGroup) => number | null;
  onSelect: (pid: string) => void;
  highlightOwner?: string;
}) {
  return (
    <div className="game-side">
      <div className="row-between" style={{ padding: '8px 12px 4px' }}>
        <span className="row" style={{ gap: 6 }}>
          <TeamMark team={team} />
          <span className="bold small">{team}</span>
        </span>
        {players.length > 0 && (
          <span className="mono small">{fmt1(total)}</span>
        )}
      </div>

      {players.length === 0 ? (
        <div className="tiny muted" style={{ padding: '4px 12px 10px' }}>
          No rostered players
        </div>
      ) : (
        players.map((p) => (
          <button
            key={p.pid}
            className="game-player"
            onClick={() => onSelect(p.pid)}
            style={
              highlightOwner && p.ownerName === highlightOwner
                ? { background: 'var(--accent-wash)' }
                : undefined
            }
          >
            <span className="chip chip-outline tiny" style={{ minWidth: 28, justifyContent: 'center' }}>
              {p.group ?? '?'}
            </span>
            <span className="game-player__name">
              <span className="small" style={{ fontWeight: p.isStarter ? 700 : 500 }}>
                {p.name}
              </span>
              <span className="tiny muted">{p.ownerName}</span>
            </span>
            <MatchupChip score={p.group ? matchupFor(opponent, p.group) : null} group={p.group} />
            <span className="mono small bold" style={{ minWidth: 42, textAlign: 'right' }}>
              {p.played ? fmt1(p.points) : fmt1(p.projected)}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

/** Position groups, re-exported for the filter UI if it grows. */
export { POSITION_GROUPS };
