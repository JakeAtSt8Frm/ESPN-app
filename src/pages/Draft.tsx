/**
 * Draft recap.
 *
 * The one page here that has nothing to do with the season in progress, and the
 * most useful one before a snap is played. It answers the question a league
 * actually argues about in August: **who drafted well?**
 *
 * The measure is deliberately not "who took the best players" — that is mostly
 * a restatement of who picked first. Each pick is scored against the pick it
 * *cost*: ESPN publishes an average draft position for every player, drawn from
 * millions of drafts, so the gap between where a player went here and where he
 * goes on average is a real number rather than an opinion. A team that landed
 * consistent value from where it sat drafted well from any slot.
 *
 * Two things this cannot tell you, and does not pretend to:
 *
 *   - ADP is the market's opinion, not an outcome. Beating it means the room
 *     disagreed with the consensus, and the consensus is sometimes wrong.
 *   - A pick's *Value Score* is this app's own forward-looking opinion, which
 *     before week one is built almost entirely from the same projections
 *     everyone else is reading. It gets more interesting as the season runs.
 */

import { useMemo, useState } from 'react';
import { useLeague, useLeagueData } from '../data/LeagueProvider';
import { PlayerModal } from '../components/PlayerModal';
import { PosBadge, StatTile, StatTileRow, ValueChip, fmt1 } from '../components/primitives';
import { EmptyState } from '../components/primitives';
import { teamColor } from '../lib/colors';
import { useTheme } from '../components/ThemeProvider';

interface PickRow {
  pickNumber: number;
  round: number;
  roundPick: number;
  teamId: number;
  teamName: string;
  pid: string;
  name: string;
  group: string | null;
  team: string | null;
  adp: number | null;
  /** Picks of value gained: positive means he went later than his ADP. */
  edge: number | null;
  valueScore: number | null;
  /** Cross-positional value in projected points over replacement. */
  tradePoints: number | null;
  auction: number | null;
  autoDraft: boolean;
}

type View = 'board' | 'picks' | 'teams';

export function DraftPage() {
  const data = useLeagueData();
  const { selectedTeamId, setSelectedTeamId } = useLeague();
  const { mode } = useTheme();
  const [view, setView] = useState<View>('board');
  const [openPid, setOpenPid] = useState<string | null>(null);

  const picks = useMemo<PickRow[]>(() => {
    return [...data.draft]
      .sort((a, b) => a.pickNumber - b.pickNumber)
      .map((pick) => {
        const player = data.playersById.get(pick.playerId);
        const adp = player?.averageDraftPosition ?? null;
        return {
          pickNumber: pick.pickNumber,
          round: pick.round,
          roundPick: pick.roundPick,
          teamId: pick.teamId,
          teamName: data.teamsById.get(pick.teamId)?.name ?? `Team ${pick.teamId}`,
          pid: pick.playerId,
          name: player?.name ?? `Player ${pick.playerId}`,
          group: player?.group ?? null,
          team: player?.team ?? null,
          adp,
          /*
           * A positive edge is a player who was still on the board later than
           * he usually is. ESPN reports ADP as a decimal pick number, so this
           * is directly comparable to the pick that was actually spent.
           */
          edge: adp === null ? null : pick.pickNumber - adp,
          valueScore: data.combinedScores.get(pick.playerId) ?? null,
          // The cross-pick summary averages this, so it has to be points: a
          // team that spent a late pick on the best kicker should not grade out
          // as having drafted a first-round asset.
          tradePoints: data.tradeValues.byPlayer.get(pick.playerId)?.points ?? null,
          auction: player?.auctionValueAverage ?? null,
          autoDraft: pick.autoDraft,
        };
      });
  }, [data]);

  const rounds = useMemo(() => {
    const byRound = new Map<number, PickRow[]>();
    for (const pick of picks) {
      const list = byRound.get(pick.round);
      if (list) list.push(pick);
      else byRound.set(pick.round, [pick]);
    }
    for (const list of byRound.values()) list.sort((a, b) => a.roundPick - b.roundPick);
    return [...byRound.entries()].sort((a, b) => a[0] - b[0]);
  }, [picks]);

  const teamSummaries = useMemo(() => {
    const rows = data.teams.map((team) => {
      const own = picks.filter((p) => p.teamId === team.teamId);
      const edges = own.map((p) => p.edge).filter((e): e is number => e !== null);
      const values = own.map((p) => p.tradePoints).filter((v): v is number => v !== null);

      return {
        teamId: team.teamId,
        name: team.name,
        owner: team.ownerName,
        picks: own.length,
        /*
         * Median rather than mean. One pick taken forty slots late dominates an
         * average and turns a draft grade into a single-pick story; the median
         * describes the whole board, which is what "drafted well" should mean.
         */
        medianEdge: edges.length ? median(edges) : null,
        totalEdge: edges.reduce((s, e) => s + e, 0),
        meanValue: values.length ? values.reduce((s, v) => s + v, 0) / values.length : null,
        best: [...own].sort((a, b) => (b.edge ?? -999) - (a.edge ?? -999))[0] ?? null,
        worst: [...own].sort((a, b) => (a.edge ?? 999) - (b.edge ?? 999))[0] ?? null,
        autoPicks: own.filter((p) => p.autoDraft).length,
      };
    });

    return rows.sort((a, b) => (b.medianEdge ?? -999) - (a.medianEdge ?? -999));
  }, [data.teams, picks]);

  const steals = useMemo(
    () => [...picks].filter((p) => p.edge !== null).sort((a, b) => b.edge! - a.edge!),
    [picks],
  );

  if (picks.length === 0) {
    return (
      <>
        <div className="page-head">
          <h1 className="page-title">Draft</h1>
        </div>
        <EmptyState
          title="No draft on record"
          hint="ESPN publishes the board once the draft completes."
        />
      </>
    );
  }

  const withAdp = picks.filter((p) => p.edge !== null);
  const bestValue = steals[0];
  const biggestReach = steals[steals.length - 1];

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Draft</h1>
        <div className="seg">
          {(['board', 'picks', 'teams'] as View[]).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === 'board' ? 'Board' : v === 'picks' ? 'Picks' : 'Grades'}
            </button>
          ))}
        </div>
      </div>

      <StatTileRow>
        <StatTile label="Picks" value={String(picks.length)} sub={`${rounds.length} rounds`} />
        <StatTile
          label="Priced by ADP"
          value={`${withAdp.length}/${picks.length}`}
          sub="rest went undrafted in ESPN's sample"
        />
        {bestValue && (
          <StatTile
            label="Best value"
            value={bestValue.name}
            sub={`${fmt1(bestValue.edge!)} picks late · ${bestValue.teamName}`}
          />
        )}
        {biggestReach && (
          <StatTile
            label="Biggest reach"
            value={biggestReach.name}
            sub={`${fmt1(Math.abs(biggestReach.edge!))} picks early · ${biggestReach.teamName}`}
          />
        )}
      </StatTileRow>

      <div style={{ height: 16 }} />

      {view === 'board' && (
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Draft board</span>
            <span className="mono">snake · {rounds.length} rounds</span>
          </div>
          <div className="scroll-x">
            <table className="table draft-board">
              <thead>
                <tr>
                  <th>Rd</th>
                  {rounds[0]?.[1].map((pick) => (
                    <th key={pick.teamId} style={{ color: teamColor(pick.teamId, mode) }}>
                      {data.teamsById.get(pick.teamId)?.abbrev ?? pick.teamId}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rounds.map(([round, list]) => (
                  <tr key={round}>
                    <td className="mono muted">{round}</td>
                    {/*
                      A snake draft reverses every other round, so the board is
                      re-sorted by team to keep each column one manager's picks.
                      Reading it in pick order would zigzag the columns.
                    */}
                    {orderLike(rounds[0]?.[1] ?? [], list).map((pick) =>
                      pick ? (
                        <td key={pick.pickNumber}>
                          <button
                            className="draft-cell"
                            onClick={() => setOpenPid(pick.pid)}
                            style={{ borderLeftColor: teamColor(pick.teamId, mode) }}
                          >
                            <span className="draft-cell__name">{pick.name}</span>
                            <span className="tiny muted">
                              {pick.group} · {pick.team ?? 'FA'} · #{pick.pickNumber}
                            </span>
                            {pick.edge !== null && (
                              <span
                                className="tiny mono"
                                style={{
                                  color:
                                    pick.edge > 6
                                      ? 'var(--success-text)'
                                      : pick.edge < -6
                                        ? 'var(--danger-text)'
                                        : 'var(--text-muted)',
                                }}
                              >
                                {pick.edge > 0 ? '+' : ''}
                                {pick.edge.toFixed(0)} vs ADP
                              </span>
                            )}
                          </button>
                        </td>
                      ) : (
                        <td key={`empty-${round}`} />
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {view === 'picks' && (
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Every pick</span>
            <span className="mono">value against ADP</span>
          </div>
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Player</th>
                  <th>Team</th>
                  <th className="num">ADP</th>
                  <th className="num">vs ADP</th>
                  <th className="num">$</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {picks.map((pick) => (
                  <tr key={pick.pickNumber}>
                    <td className="num mono muted">{pick.pickNumber}</td>
                    <td>
                      <button className="team-name" onClick={() => setOpenPid(pick.pid)}>
                        <PosBadge group={pick.group} />
                        <span style={{ marginLeft: 6 }}>{pick.name}</span>
                        {pick.autoDraft && (
                          <span className="chip chip-outline" style={{ marginLeft: 6 }}>
                            auto
                          </span>
                        )}
                      </button>
                    </td>
                    <td style={{ color: teamColor(pick.teamId, mode) }}>{pick.teamName}</td>
                    <td className="num mono">{pick.adp === null ? '—' : pick.adp.toFixed(1)}</td>
                    <td
                      className="num mono bold"
                      style={{
                        color:
                          pick.edge === null
                            ? undefined
                            : pick.edge > 6
                              ? 'var(--success-text)'
                              : pick.edge < -6
                                ? 'var(--danger-text)'
                                : undefined,
                      }}
                    >
                      {pick.edge === null
                        ? '—'
                        : `${pick.edge > 0 ? '+' : ''}${pick.edge.toFixed(0)}`}
                    </td>
                    <td className="num mono muted">
                      {pick.auction === null ? '—' : `$${pick.auction.toFixed(0)}`}
                    </td>
                    <td className="num">
                      <ValueChip score={pick.valueScore} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {view === 'teams' && (
        <section className="card" style={{ overflow: 'hidden' }}>
          <div className="group-head group-head--primary">
            <span>Draft grades</span>
            <span className="mono">median picks gained vs ADP</span>
          </div>
          <div className="card-pad small muted">
            A team's grade is the <strong>median</strong> gap between where its players
            actually went and where ESPN's drafters take them on average. One pick taken
            forty slots late would carry a mean; the median describes the whole board.
          </div>
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Team</th>
                  <th className="num">Picks</th>
                  <th className="num">Median vs ADP</th>
                  <th className="num">Total</th>
                  <th className="num" title="Mean projected points over replacement per pick — cross-positional, so a kicker and a running back are on the same scale">Mean pts</th>
                  <th>Best pick</th>
                </tr>
              </thead>
              <tbody>
                {teamSummaries.map((row) => (
                  <tr
                    key={row.teamId}
                    className={row.teamId === selectedTeamId ? 'is-selected' : undefined}
                  >
                    <td>
                      <button
                        className="team-name"
                        style={{ color: teamColor(row.teamId, mode) }}
                        onClick={() => setSelectedTeamId(row.teamId)}
                      >
                        {row.name}
                        <span className="tiny muted" style={{ display: 'block' }}>
                          {row.owner}
                          {row.autoPicks > 0 ? ` · ${row.autoPicks} auto` : ''}
                        </span>
                      </button>
                    </td>
                    <td className="num mono">{row.picks}</td>
                    <td
                      className="num mono bold"
                      style={{
                        color:
                          row.medianEdge === null
                            ? undefined
                            : row.medianEdge > 0
                              ? 'var(--success-text)'
                              : 'var(--danger-text)',
                      }}
                    >
                      {row.medianEdge === null
                        ? '—'
                        : `${row.medianEdge > 0 ? '+' : ''}${row.medianEdge.toFixed(1)}`}
                    </td>
                    <td className="num mono muted">{row.totalEdge.toFixed(0)}</td>
                    <td className="num mono">
                      {row.meanValue === null ? '—' : row.meanValue.toFixed(0)}
                    </td>
                    <td className="small">
                      {row.best && row.best.edge !== null ? (
                        <button className="team-name" onClick={() => setOpenPid(row.best!.pid)}>
                          {row.best.name}
                          <span className="tiny muted"> +{row.best.edge.toFixed(0)}</span>
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <PlayerModal pid={openPid} week={data.liveWeek} onClose={() => setOpenPid(null)} />
    </>
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Reorders a round's picks to match the column order of round one.
 *
 * In a snake draft the even rounds run backwards, so laying picks out in the
 * order they were made would put a different manager in each column row by row.
 * Aligning on round one keeps every column one manager's draft.
 */
function orderLike(reference: PickRow[], list: PickRow[]): Array<PickRow | null> {
  const byTeam = new Map(list.map((pick) => [pick.teamId, pick]));
  return reference.map((ref) => byTeam.get(ref.teamId) ?? null);
}
