/**
 * A player as a row in a list.
 *
 * A dense row rather than a card: with nine starters, a seven-deep bench and a
 * free-agent list hundreds long, cards mean a lot of scrolling on a phone. The
 * row still carries every number a card would — projection, actual, boom/bust
 * state, Value Score, matchup rating and positional ranks.
 *
 * Identity and standing sit together on the top line — name, then Value, then
 * the positional ranks — so a player can be judged without reading downward. The
 * second line is only context (team, opponent).
 */

import { playerHeadshot, teamLogo } from '../lib/assets';
import {
  MatchupChip,
  PosBadge,
  StatusBadge,
  ValueChip,
  fmt1,
  fmtSigned,
} from './primitives';
import type { EnrichedPlayer, RankInfo } from '../lib/types';

interface Props {
  player: EnrichedPlayer;
  onSelect?: (pid: string) => void;
  /** Show the projection column. Hidden on views that only report results. */
  showProjection?: boolean;
  /** The app's bias- and matchup-adjusted median, shown before ESPN's. */
  appProjection?: number | null;
  /** Keep the active projection sort visible when a narrow row has room for one score. */
  primaryProjection?: 'app' | 'espn';
  /** Extra context appended to the second line, e.g. the rostering team. */
  note?: string | null;
  /** The player's place in the currently filtered and sorted list. */
  listRank?: number;
  /**
   * The points used by a league-value sort, replacing the within-position chip.
   *
   * `signed` is on by default because the sorts this was built for are margins
   * — points *above* replacement, points *above* the waiver wire — where the
   * sign is the whole meaning. A plain total is not a margin over anything, and
   * a leading `+` on one reads as a gain against a baseline that does not
   * exist.
   */
  valueMetric?: {
    label: string;
    value: number | null;
    description: string;
    signed?: boolean;
  };
}

const RESERVE_SLOTS = new Set(['BN', 'IR']);

/** A margin keeps its sign; a total does not. See `Props.valueMetric`. */
function fmtMetric(metric: { value: number | null; signed?: boolean }): string {
  if (metric.value === null) return '—';
  return metric.signed === false ? fmt1(metric.value) : fmtSigned(metric.value);
}

/** Reserve rows show football position; lineup rows retain meaningful flex slots. */
function positionBadgeSlot(player: EnrichedPlayer): string | undefined {
  return RESERVE_SLOTS.has(player.slot.toUpperCase()) ? undefined : player.slot;
}

/** Headshot that falls back to the team logo, then hides itself. */
function Avatar({ pid, team, size }: { pid: string; team: string; size: number }) {
  const src = playerHeadshot(pid, team);
  if (!src) return <span className="avatar" style={{ width: size, height: size }} />;

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="avatar"
      style={{ width: size, height: size }}
      onError={(e) => {
        const img = e.currentTarget;
        const fallback = teamLogo(team);
        if (fallback && img.src !== fallback) img.src = fallback;
        else img.style.visibility = 'hidden';
      }}
    />
  );
}

type RankKind = 'total' | 'ppg' | 'boom';

const RANK_DESCRIPTIONS: Record<RankKind, string> = {
  total: 'total points',
  ppg: 'points per game',
  boom: 'boom rate',
};

function PositionRank({
  rank,
  kind,
  label,
  season,
}: {
  rank: RankInfo | null;
  kind: RankKind;
  label: string;
  /** The season being reported, which before week one is the last finished one. */
  season: string | null;
}) {
  const description = RANK_DESCRIPTIONS[kind];
  // A rank carries the season it was measured over; a dash carries no rank at
  // all, so the row has to supply the year for the tooltip to stay truthful.
  const year = rank?.season ?? season;
  const scope = year ? ` in ${year}` : '';

  return (
    <span
      className={`player-row__rank player-row__rank--${kind}`}
      title={
        rank
          ? `${rank.group} rank ${rank.rank} of ${rank.outOf} by ${description}${scope}`
          : `${description} rank unavailable${scope}`
      }
    >
      {label} {rank ? `#${rank.rank}` : '—'}
    </span>
  );
}

/**
 * Total, PPG and boom rate rank, as one unit.
 *
 * `rankSeason` is set only while the chips report a season that is not this one
 * — see `EnrichedPlayer.rankSeason`. It leads the group as a two-digit year
 * because these read as current-season numbers otherwise, and four characters is
 * what the row can afford: the alternative is the reader drafting off last
 * year's finish while believing it is this year's form.
 */
function PositionRanks({ player: p }: { player: EnrichedPlayer }) {
  const season = p.rankSeason;

  return (
    <span className="player-row__ranks">
      {season && (
        <span
          className="player-row__rank-season"
          title={`Total, PPG and boom rate are ${season} finishes — the ${
            Number(season) + 1
          } season has not been played yet`}
        >
          '{season.slice(-2)}
        </span>
      )}
      <PositionRank rank={p.totalRank} kind="total" label="Total" season={season} />
      <span className="player-row__rank-separator" aria-hidden="true">
        |
      </span>
      <PositionRank rank={p.ppgRank} kind="ppg" label="PPG" season={season} />
      <span className="player-row__rank-separator" aria-hidden="true">
        |
      </span>
      <PositionRank rank={p.boomRateRank} kind="boom" label="BR" season={season} />
    </span>
  );
}

export function PlayerRow({
  player: p,
  onSelect,
  showProjection = true,
  appProjection,
  primaryProjection,
  note,
  listRank,
  valueMetric,
}: Props) {
  const useAppProjection = primaryProjection === 'app' && appProjection != null;
  const primaryScore = useAppProjection ? appProjection : p.proj;
  const projectionFirst = primaryProjection !== undefined;
  const delta = p.hasPlayed && p.proj > 0 ? p.act - p.proj : null;
  const positionRankLabel = `${p.totalRank ? `total rank ${p.totalRank.rank}` : 'total rank unavailable'}, ${
    p.ppgRank ? `PPG rank ${p.ppgRank.rank}` : 'PPG rank unavailable'
  }, ${p.boomRateRank ? `boom rate rank ${p.boomRateRank.rank}` : 'boom rate rank unavailable'}${
    p.rankSeason ? `, from the ${p.rankSeason} season` : ''
  }`;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(p.pid)}
      className={`player-row${listRank === undefined ? '' : ' player-row--ranked'}`}
      aria-label={`${listRank === undefined ? '' : `Rank ${listRank}, `}${p.name}, ${p.group ?? 'unknown position'}, ${
        p.hasPlayed && !projectionFirst ? `scored ${fmt1(p.act)}` : `${useAppProjection ? 'app ' : ''}projected ${fmt1(primaryScore)}`
      }, ${positionRankLabel}${valueMetric
        ? `, ${valueMetric.description}: ${valueMetric.value === null ? 'unavailable' : fmtMetric(valueMetric)}`
        : ''}`}
    >
      {listRank !== undefined && (
        <span className="player-row__list-rank mono" aria-hidden="true">
          {listRank}
        </span>
      )}

      <PosBadge group={p.group} slot={positionBadgeSlot(p)} />

      <Avatar pid={p.pid} team={p.team} size={34} />

      <span className="player-row__id">
        <span className="player-row__title">
          <span className="player-row__name">{p.name}</span>
          {valueMetric ? (
            <span className="chip chip-outline mono" title={valueMetric.description}>
              {valueMetric.label} {valueMetric.value === null ? '—' : fmtMetric(valueMetric)}
            </span>
          ) : <ValueChip score={p.valueScore} />}
          <PositionRanks player={p} />
          {p.isOut && (
            <span className="chip" style={{ color: 'var(--danger-text)' }}>
              OUT
            </span>
          )}
        </span>
        <span className="tiny muted">
          {p.team || '—'}
          {p.onBye ? ' · BYE' : p.opponent ? ` vs ${p.opponent}` : ''}
          {note ? ` · ${note}` : ''}
        </span>
      </span>

      {/* Matchup sits with the numbers on the right, not with the identity
          pills — it describes this week's opponent, not the player. */}
      <span className="player-row__matchup">
        <MatchupChip score={p.matchupScore} group={p.group} />
      </span>

      {/*
        Narrow rows have room for one of these two, and which one carries the
        information depends on whether the week has happened. Before kickoff the
        actual is a dash for everybody, so dropping the projection there would
        leave the row with no number on it at all. The row marks the weaker
        column and the container query hides that one.
      */}
      {showProjection && (
        <span
          className={`player-row__num mono${p.hasPlayed && !projectionFirst ? ' player-row__num--minor' : ''}`}
          title={
            appProjection === null || appProjection === undefined
              ? 'ESPN projection'
              : `This app projects ${fmt1(appProjection)}; ESPN projects ${fmt1(p.proj)}. ` +
                'The app number is ESPN adjusted by historical bias, availability and this matchup.'
          }
        >
          {/*
            The secondary forecast can collapse on a phone; the score used by
            an explicit projection sort stays visible. The app value is the
            same adjusted median shown in the player sheet.
          */}
          {appProjection !== null && appProjection !== undefined && (
            <span className="player-row__own" aria-label={`${useAppProjection ? 'ESPN' : 'App'} projection ${fmt1(useAppProjection ? p.proj : appProjection)}`}>
              {fmt1(useAppProjection ? p.proj : appProjection)}
            </span>
          )}
          {fmt1(primaryScore)}
        </span>
      )}

      <span
        className={`player-row__num mono bold${p.hasPlayed && !projectionFirst ? '' : ' player-row__num--minor'}`}
        title="Actual Score"
      >
        {p.hasPlayed ? fmt1(p.act) : '—'}
      </span>

      <span className="player-row__status">
        {delta !== null && (
          <span
            className="tiny mono"
            style={{ color: delta >= 0 ? 'var(--success-text)' : 'var(--danger-text)' }}
          >
            {delta >= 0 ? '+' : ''}
            {delta.toFixed(1)}
          </span>
        )}
        <StatusBadge status={p.status} compact />
      </span>
    </button>
  );
}

/** Card layout — used where a player is the subject rather than a list entry. */
export function PlayerCard({ player: p, onSelect }: Props) {
  return (
    <button type="button" onClick={() => onSelect?.(p.pid)} className="player-card">
      <div className="row" style={{ gap: 10 }}>
        <Avatar pid={p.pid} team={p.team} size={42} />
        <div className="grow" style={{ minWidth: 0, textAlign: 'left' }}>
          <div className="bold" style={{ fontSize: 14, lineHeight: 1.3 }}>
            {p.name}
          </div>
          <div className="tiny muted">
            {p.group} · {p.team || '—'}
            {p.opponent ? ` vs ${p.opponent}` : ''}
          </div>
        </div>
        <PosBadge group={p.group} slot={positionBadgeSlot(p)} />
      </div>

      <div className="player-card__scores">
        <div>
          <div className="tiny muted">Projected Score</div>
          <div className="mono bold" style={{ fontSize: 18 }}>
            {fmt1(p.proj)}
          </div>
        </div>
        <div>
          <div className="tiny muted">Actual Score</div>
          <div className="mono bold" style={{ fontSize: 18 }}>
            {p.hasPlayed ? fmt1(p.act) : '—'}
          </div>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 6 }}>
        <ValueChip score={p.valueScore} />
        <PositionRanks player={p} />
        <MatchupChip score={p.matchupScore} group={p.group} />
        <StatusBadge status={p.status} />
      </div>
    </button>
  );
}
