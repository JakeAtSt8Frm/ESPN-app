/**
 * Trade — the only page that compares players across positions.
 *
 * Trades add the points behind the headline Value Score, preserving precision
 * through multi-player deals. See `lib/trade.ts` for how those points are built.
 *
 * The page answers two different questions and keeps them apart, because they
 * genuinely disagree and a manager needs both:
 *
 *   **Market** — who gets more value, ignoring both rosters. This is the fair
 *   question, the one to send with the offer.
 *
 *   **Your roster** — what it does to the points you will actually score,
 *   replaying every remaining week with the best legal lineup either side could
 *   field. A third elite receiver is worth his market price to the league and
 *   much less to a team that already has two, and only this half can see that.
 */

import { useMemo, useState } from 'react';
import { useLeagueData } from '../data/LeagueProvider';
import { playerName } from '../data/league';
import { PlayerModal } from '../components/PlayerModal';
import {
  EmptyState,
  StatTile,
  StatTileRow,
  fmt1,
  fmtSigned,
} from '../components/primitives';
import { playerHeadshot } from '../lib/assets';
import {
  rosterImpact,
  summarizeTrade,
  type RosterImpact,
  type TradeVerdict,
} from '../lib/trade';
import { POSITION_GROUPS, type PositionGroup } from '../lib/types';

const VERDICT_TONE: Record<TradeVerdict, string> = {
  Even: 'var(--tone-idle)',
  'Slight edge': 'var(--tone-mid)',
  'Clear win': 'var(--tone-boom)',
  Lopsided: 'var(--tone-major-boom)',
};

type SideKey = 'a' | 'b';

export function TradePage() {
  const data = useLeagueData();
  const { tradeValues } = data;

  const [teamA, setTeamA] = useState<number | null>(data.teams[0]?.teamId ?? null);
  const [teamB, setTeamB] = useState<number | null>(data.teams[1]?.teamId ?? null);
  const [aSends, setASends] = useState<string[]>([]);
  const [bSends, setBSends] = useState<string[]>([]);
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [browseGroup, setBrowseGroup] = useState<PositionGroup | 'ALL'>('ALL');

  // Memoised because both feed a useMemo: `?? []` would mint a new array on
  // every render and re-solve seventeen weeks of lineups for nothing.
  const rosterA = useMemo(
    () => data.teamsById.get(teamA ?? -1)?.players ?? [],
    [data.teamsById, teamA],
  );
  const rosterB = useMemo(
    () => data.teamsById.get(teamB ?? -1)?.players ?? [],
    [data.teamsById, teamB],
  );

  const summary = useMemo(
    () => summarizeTrade(aSends, bSends, tradeValues),
    [aSends, bSends, tradeValues],
  );

  /*
   * The wire, best first. Both sides of a lopsided-count trade need it: whoever
   * receives fewer players ends a body short and signs the best free agent, and
   * that pickup is a real part of what the trade is worth.
   */
  const freeAgentPool = useMemo(() => {
    const owned = new Set<string>();
    for (const team of data.teams) for (const pid of team.players) owned.add(pid);
    return [...tradeValues.byPlayer.values()]
      .filter((v) => !owned.has(v.pid) && !v.unprojected)
      .sort((x, y) => y.points - x.points)
      .map((v) => v.pid);
  }, [data.teams, tradeValues]);

  const impacts = useMemo(() => {
    if (teamA === null || teamB === null) return null;
    if (!aSends.length && !bSends.length) return null;

    const shared = {
      playersById: data.playersById,
      weeklyProjections: data.weeklyProjections,
      values: tradeValues,
      freeAgentPool,
      rosterSlots: data.league.rosterSlots,
      rosterLimit: data.league.rosterSlots.length + data.league.benchSlots,
      fromWeek: data.liveWeek,
      finalWeek: data.playoff.finalWeek,
    };

    return {
      a: rosterImpact({
        ...shared,
        teamId: teamA,
        playerIds: rosterA,
        sends: aSends,
        receives: bSends,
      }),
      b: rosterImpact({
        ...shared,
        teamId: teamB,
        playerIds: rosterB,
        sends: bSends,
        receives: aSends,
      }),
    };
  }, [teamA, teamB, aSends, bSends, rosterA, rosterB, data, tradeValues, freeAgentPool]);

  const toggle = (side: SideKey, pid: string) => {
    const [list, set] = side === 'a' ? [aSends, setASends] : [bSends, setBSends];
    set(list.includes(pid) ? list.filter((p) => p !== pid) : [...list, pid]);
  };

  const clear = () => {
    setASends([]);
    setBSends([]);
  };

  if (!data.teams.length) return <EmptyState title="No teams in this league" />;

  const anySelected = aSends.length > 0 || bSends.length > 0;
  const nameA = data.teamsById.get(teamA ?? -1)?.name ?? 'Team A';
  const nameB = data.teamsById.get(teamB ?? -1)?.name ?? 'Team B';

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Trade</h1>
      </div>

      <div className="stack">
        <div className="grid-2">
          <SidePanel
            heading="Sends"
            teamId={teamA}
            teamName={nameA}
            teams={data.teams}
            onTeam={setTeamA}
            exclude={teamB}
            roster={rosterA}
            selected={aSends}
            onToggle={(pid) => toggle('a', pid)}
            onOpen={setOpenPid}
            data={data}
          />
          <SidePanel
            heading="Sends"
            teamId={teamB}
            teamName={nameB}
            teams={data.teams}
            onTeam={setTeamB}
            exclude={teamA}
            roster={rosterB}
            selected={bSends}
            onToggle={(pid) => toggle('b', pid)}
            onOpen={setOpenPid}
            data={data}
          />
        </div>

        {!anySelected ? (
          <EmptyState
            title="Pick players from each side"
            hint="Any number on either side — 1-for-1, 2-for-1, 2-for-2. Values are in projected points, so uneven sides add up honestly."
          />
        ) : (
          <>
            <section className="card card-pad">
              <div className="row-between wrap" style={{ marginBottom: 10 }}>
                <div className="section-title" style={{ margin: 0 }}>
                  Market value
                </div>
                <button type="button" className="btn btn-sm btn-ghost" onClick={clear}>
                  Clear
                </button>
              </div>

              <StatTileRow>
                <StatTile
                  label="Verdict"
                  value={summary.verdict}
                  sub={
                    summary.favors === null
                      ? 'no meaningful gap'
                      : `favours ${summary.favors === 'A' ? nameA : nameB}`
                  }
                  tone={VERDICT_TONE[summary.verdict]}
                />
                <StatTile
                  label={`${nameA} receives`}
                  value={fmt1(summary.aReceives.points)}
                  sub={`${summary.aReceives.count} player${summary.aReceives.count === 1 ? '' : 's'} · pts over replacement`}
                />
                <StatTile
                  label={`${nameB} receives`}
                  value={fmt1(summary.bReceives.points)}
                  sub={`${summary.bReceives.count} player${summary.bReceives.count === 1 ? '' : 's'} · pts over replacement`}
                />
                <StatTile
                  label="Gap"
                  value={fmtSigned(summary.netPoints)}
                  sub={`${fmt1(summary.netPerWeek)} pts a week over ${summary.weeksRemaining} weeks`}
                />
              </StatTileRow>

              <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
                Roster-blind: this is what the two sides are worth to the league, which is
                the fair way to judge an offer. It says nothing about whether either team
                needs what it is getting — that is the next section.
              </p>
            </section>

            {impacts && (
              <section className="card card-pad">
                <div className="section-title">What it does to each roster</div>
                <div className="grid-2">
                  <ImpactCard
                    name={nameA}
                    impact={impacts.a}
                    data={data}
                    weeks={summary.weeksRemaining}
                  />
                  <ImpactCard
                    name={nameB}
                    impact={impacts.b}
                    data={data}
                    weeks={summary.weeksRemaining}
                  />
                </div>
                <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
                  Every remaining week solved separately for the best legal lineup, then
                  summed. Surplus is priced correctly by construction: a player who never
                  wins a slot adds nothing here even though he is worth his full market
                  value above. Roster limits are enforced — a side receiving more players
                  than it sends drops its least valuable, and a side receiving fewer signs
                  the best free agent.
                </p>
              </section>
            )}
          </>
        )}

        <ValueTable
          data={data}
          group={browseGroup}
          onGroup={setBrowseGroup}
          onOpen={setOpenPid}
        />
      </div>

      {openPid && (
        <PlayerModal pid={openPid} week={data.liveWeek} onClose={() => setOpenPid(null)} />
      )}
    </>
  );
}

function SidePanel({
  heading,
  teamId,
  teamName,
  teams,
  onTeam,
  exclude,
  roster,
  selected,
  onToggle,
  onOpen,
  data,
}: {
  heading: string;
  teamId: number | null;
  teamName: string;
  teams: ReturnType<typeof useLeagueData>['teams'];
  onTeam: (id: number) => void;
  exclude: number | null;
  roster: string[];
  selected: string[];
  onToggle: (pid: string) => void;
  onOpen: (pid: string) => void;
  data: ReturnType<typeof useLeagueData>;
}) {
  const rows = useMemo(
    () =>
      roster
        .map((pid) => ({
          pid,
          player: data.playersById.get(pid),
          value: data.tradeValues.byPlayer.get(pid),
        }))
        .sort((a, b) => (b.value?.points ?? 0) - (a.value?.points ?? 0)),
    [roster, data],
  );

  const total = selected.reduce(
    (sum, pid) => sum + (data.tradeValues.byPlayer.get(pid)?.points ?? 0),
    0,
  );

  return (
    <section className="card card-pad">
      <div className="row-between wrap" style={{ marginBottom: 10, gap: 8 }}>
        <select
          className="select grow"
          value={teamId ?? ''}
          onChange={(e) => onTeam(Number(e.target.value))}
          aria-label={`Team that ${heading.toLowerCase()}`}
        >
          {teams.map((t) => (
            <option key={t.teamId} value={t.teamId} disabled={t.teamId === exclude}>
              {t.name}
            </option>
          ))}
        </select>
        <span className="chip chip-outline mono" title={`${teamName} sends ${fmt1(total)} points of value`}>
          {selected.length} · {fmt1(total)} pts
        </span>
      </div>

      <div className="scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 34 }}>
                <span className="sr-only">Include in trade</span>
              </th>
              <th>Player</th>
              <th className="num">Trade pts</th>
              <th className="num">Idx</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ pid, player, value }) => {
              const isOn = selected.includes(pid);
              return (
                <tr
                  key={pid}
                  style={isOn ? { background: 'var(--accent-wash)' } : undefined}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={isOn}
                      onChange={() => onToggle(pid)}
                      aria-label={`Include ${playerName(player, pid)} in the trade`}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: 0,
                        textAlign: 'left',
                        minHeight: 0,
                        background: 'none',
                        border: 0,
                        width: '100%',
                      }}
                      onClick={() => onOpen(pid)}
                    >
                      <img
                        src={playerHeadshot(pid, player?.team) ?? ''}
                        alt=""
                        width={26}
                        height={26}
                        loading="lazy"
                        style={{ borderRadius: '50%', flex: '0 0 auto' }}
                        onError={(e) => {
                          e.currentTarget.style.visibility = 'hidden';
                        }}
                      />
                      <span style={{ minWidth: 0 }}>
                        <span
                          className="bold"
                          style={{
                            display: 'block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {playerName(player, pid)}
                        </span>
                        <span className="tiny muted">
                          {player?.group ?? '—'} · {player?.team ?? 'FA'}
                          {value?.injuryStatus &&
                            value.injuryStatus !== 'ACTIVE' &&
                            ` · ${value.injuryStatus.replace('_', ' ').toLowerCase()}`}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="num bold">{fmt1(value?.points ?? 0)}</td>
                  <td className="num muted">{fmt1(value?.index ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ImpactCard({
  name,
  impact,
  data,
  weeks,
}: {
  name: string;
  impact: RosterImpact;
  data: ReturnType<typeof useLeagueData>;
  weeks: number;
}) {
  const tone =
    impact.deltaPerWeek > 0.5
      ? 'var(--tone-boom)'
      : impact.deltaPerWeek < -0.5
        ? 'var(--tone-bust)'
        : 'var(--tone-idle)';

  return (
    <div className="card card-pad" style={{ background: 'var(--surface-sunken)' }}>
      <div className="bold" style={{ marginBottom: 8 }}>
        {name}
      </div>

      <div className="mono" style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1, color: tone }}>
        {fmtSigned(impact.delta)}
      </div>
      <div className="small muted" style={{ marginBottom: 10 }}>
        projected starting points over {weeks} weeks · {fmtSigned(impact.deltaPerWeek)} a week
      </div>

      <div className="metric-grid">
        <div className="metric">
          <div className="tiny muted">Before</div>
          <div className="mono bold">{fmt1(impact.before)}</div>
        </div>
        <div className="metric">
          <div className="tiny muted">After</div>
          <div className="mono bold">{fmt1(impact.after)}</div>
        </div>
        <div className="metric">
          <div className="tiny muted">Roster</div>
          <div className="mono bold">{impact.rosterSizeAfter}</div>
        </div>
      </div>

      {impact.dropped.length > 0 && (
        <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
          Cut to make room:{' '}
          {impact.dropped
            .map((pid) => playerName(data.playersById.get(pid), pid))
            .join(', ')}
        </p>
      )}
      {impact.added.length > 0 && (
        <p className="small muted" style={{ marginTop: 6, marginBottom: 0 }}>
          Fills the open spot from waivers:{' '}
          {impact.added.map((pid) => playerName(data.playersById.get(pid), pid)).join(', ')}
        </p>
      )}
      {impact.shortAt.length > 0 && (
        <p className="small" style={{ marginTop: 6, marginBottom: 0, color: 'var(--danger-text)' }}>
          Leaves the lineup card unfillable at{' '}
          {impact.shortAt.map((g) => (g === 'DST' ? 'D/ST' : g)).join(', ')}.
        </p>
      )}
    </div>
  );
}

/** Reference ladder, so a value can be checked against the field. */
function ValueTable({
  data,
  group,
  onGroup,
  onOpen,
}: {
  data: ReturnType<typeof useLeagueData>;
  group: PositionGroup | 'ALL';
  onGroup: (g: PositionGroup | 'ALL') => void;
  onOpen: (pid: string) => void;
}) {
  const ownerByPid = useMemo(() => {
    const map = new Map<string, string>();
    for (const team of data.teams) for (const pid of team.players) map.set(pid, team.abbrev);
    return map;
  }, [data.teams]);

  const rows = useMemo(
    () =>
      [...data.tradeValues.byPlayer.values()]
        .filter((v) => !v.unprojected && (group === 'ALL' || v.group === group))
        .sort((a, b) => b.points - a.points)
        .slice(0, 60),
    [data.tradeValues, group],
  );

  return (
    <section className="card card-pad">
      <div className="row-between wrap" style={{ marginBottom: 10, gap: 8 }}>
        <div className="section-title" style={{ margin: 0 }}>
          Trade value board
        </div>
        <div className="segmented" role="group" aria-label="Filter by position">
          {(['ALL', ...POSITION_GROUPS] as Array<PositionGroup | 'ALL'>).map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={group === g}
              onClick={() => onGroup(g)}
            >
              {g === 'DST' ? 'D/ST' : g}
            </button>
          ))}
        </div>
      </div>

      <div className="scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Player</th>
              <th>Owner</th>
              <th className="num">Trade pts</th>
              <th className="num">Idx</th>
              <th className="num">Proj pts</th>
              <th className="num">ESPN $</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v, i) => {
              const player = data.playersById.get(v.pid);
              return (
                <tr key={v.pid}>
                  <td className="num muted">{i + 1}</td>
                  <td>
                    <button
                      type="button"
                      className="btn-ghost bold"
                      style={{
                        padding: 0,
                        minHeight: 0,
                        background: 'none',
                        border: 0,
                        textAlign: 'left',
                      }}
                      onClick={() => onOpen(v.pid)}
                    >
                      {playerName(player, v.pid)}
                    </button>{' '}
                    <span className="tiny muted">
                      {v.group === 'DST' ? 'D/ST' : v.group} · {player?.team ?? 'FA'}
                    </span>
                  </td>
                  <td className="tiny muted">{ownerByPid.get(v.pid) ?? 'FA'}</td>
                  <td className="num bold">{fmt1(v.points)}</td>
                  <td className="num muted">{fmt1(v.index)}</td>
                  <td className="num muted">{fmt1(v.projectedPoints)}</td>
                  <td className="num muted">
                    {v.auctionValue === null ? '—' : `$${v.auctionValue.toFixed(0)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
        <strong>Idx</strong> puts the same points on a 0–100 scale where the league&rsquo;s
        most valuable player is 100. It is linear, not a percentile, so two players at 40
        really are worth one at 80. <strong>ESPN $</strong> is the auction market, shown for
        comparison only — nothing on this page is fitted to it.
      </p>
    </section>
  );
}
