/**
 * League data loading and derivation.
 *
 * Reads the static snapshot, then derives every index the app shows in one
 * pass. The heavy work — the value model over a thousand players and seventeen
 * weeks — runs a single time per load and every page reads the result, which is
 * what keeps the app responsive on a phone.
 */

import {
  loadHistoryFile,
  loadPriorsFile,
  loadIndex,
  loadLeagueFile,
  loadPlayersFile,
  loadProjectionModel,
  loadWeekFile,
  type DraftPick,
  type LeagueFile,
  type ProGame,
  type Transaction,
} from './snapshot';
import {
  compileScoring,
  createScorer,
  hasPlayed,
  opportunities,
  type ScoringModel,
} from '../lib/scoring';
import { round } from '../lib/stats';
import {
  buildPriorRanks,
  buildValueIndex,
  type PriorProduction,
  type ValueIndex,
} from '../lib/value';
import {
  buildSeasonValueIndex,
  type SeasonValueIndex,
} from '../lib/season-value';
import {
  buildMatchupIndex,
  matchupIndexFrom,
  buildPregameMatchupIndexes,
  MATCHUP_INFLUENCE,
  type MatchupIndex,
} from '../lib/matchup';
import { fitResidualModel, type PriorPair, type ResidualModel } from '../lib/forecast';
import {
  advance,
  newRollingState,
  projectPlayerWeek,
  type ProjectionModel,
} from '../lib/projection';
import { buildTradeValues, type DriftFit, type TradeValueIndex } from '../lib/trade';
import { starterSlots } from '../lib/optimal';
import type {
  League,
  Matchup,
  Player,
  PositionGroup,
  RankInfo,
  StatLine,
  Team,
} from '../lib/types';

export interface WeekData {
  week: number;
  stats: Record<string, StatLine>;
  projections: Record<string, StatLine>;
  /** pid -> opposing NFL team, derived from the pro schedule. */
  opponents: Record<string, string>;
  /** pid -> the player's own NFL team that week. */
  teams: Record<string, string>;
  /** teamId -> pid -> the slot the player occupied. What was actually started. */
  lineups: Record<string, Record<string, string>>;
  /** True once every game in the week has kicked off and finished. */
  complete: boolean;
}

export interface TeamInfo extends Team {
  /** Final placement once the bracket resolves: 1 = champion. */
  placement: number | null;
}

export interface LeagueData {
  season: string;
  generatedAt: number;
  league: League;
  /**
   * How much the opponent moves each position in *this* league, normalised so
   * the peak is 1. Measured per league by `fit:priors`; falls back to the
   * compiled `MATCHUP_INFLUENCE` when a snapshot has not been fit.
   */
  matchupInfluence: Record<PositionGroup, number>;
  scoringModel: ScoringModel;
  score: (stats: StatLine | undefined | null, group?: PositionGroup | null) => number;
  playersById: Map<string, Player>;
  teams: TeamInfo[];
  teamsById: Map<number, TeamInfo>;
  weeks: Map<number, WeekData>;
  schedule: Matchup[];
  scheduleByWeek: Map<number, Matchup[]>;
  draft: DraftPick[];
  transactions: Transaction[];
  proSchedule: Record<string, Record<string, ProGame>>;
  byeWeeks: Map<string, number>;
  /** Last week with completed games; 0 before the season starts. */
  currentWeek: number;
  /** The week the app opens on — the next one to be played. */
  liveWeek: number;
  maxWeek: number;
  starterSlots: string[];
  valueIndex: ValueIndex;
  seasonValueIndex: SeasonValueIndex;
  /**
   * Headline value on one proportional 0–1000 scale across all positions.
   * The league leader is 1000. No remaining projection means no score.
   */
  combinedScores: Map<string, number>;
  /** Average of the two within-position ratings, retained as positional context. */
  positionScores: Map<string, number>;
  /**
   * Cross-positional trade currency, in projected points over replacement.
   *
   * The underlying points behind `combinedScores`. Trades add these points
   * rather than rounded display scores. See `lib/trade.ts`.
   */
  tradeValues: TradeValueIndex;
  /**
   * History-only projection challenger: pid -> week -> points.
   *
   * Retained for diagnostics rather than used as the user-facing App
   * projection. Absent for a player-week the model declines to call — fewer
   * than two scored weeks behind him, or a position whose model lost to the
   * baseline on its own holdout. See `lib/projection.ts`.
   */
  ownProjections: Map<string, Map<number, number>>;
  /** The fitted model, or null when the snapshot predates the fit. */
  projectionModel: ProjectionModel | null;
  /** pid -> the per-player weekly projections the trade model prices. */
  weeklyProjections: Map<string, Map<number, number>>;
  matchupIndex: MatchupIndex;
  /**
   * True when the defence ratings come from last season because this one has
   * not played enough football yet. The UI says so rather than presenting them
   * as current.
   */
  matchupFromPrior: boolean;
  /** Pregame ratings for historical weeks, containing earlier results only. */
  pregameMatchupIndexes: Map<number, MatchupIndex>;
  residualModel: ResidualModel;
  /** Prior-season game logs, kept for the player sheet and the priors. */
  priorSeason: string;
  priorLogs: Map<string, Map<number, StatLine>>;
  /**
   * The positional rank chips — Total, PPG, boom rate — and the season they
   * describe.
   *
   * One index rather than a per-player fallback, deliberately. A rank is a
   * statement about a pool, so "#4 of 61" from 2025 and "#7 of 12" from three
   * weeks of 2026 are not comparable numbers, and a list that mixed them would
   * read as one ordering while being two. The whole set switches at once.
   */
  ranks: RankIndex;
  /**
   * The two indexes `ranks` is chosen from, both kept.
   *
   * The automatic choice above is right almost always, and the exception is
   * worth serving: somebody drafting, or valuing a trade in October, wants last
   * season's finishes back after this season has taken them away. Keeping both
   * built means Settings can pin either one without reloading the league or
   * re-deriving anything — see `withStatsSeason`.
   *
   * `priorRanks` is null when the snapshot has no fitted priors to rank; that
   * is the case the pinning UI hides itself for.
   */
  priorRanks: RankIndex | null;
  currentRanks: RankIndex;
  /**
   * Last finished season's production, per player.
   *
   * Kept alongside the ranks because the sorts on the Players page and the
   * season profile in the player sheet need the values themselves, not their
   * order — and before week one this is the only production that exists.
   */
  priorProduction: Map<string, PriorProduction>;
  playoff: PlayoffFormat;
}

/** The rank chips' source, and the season it was measured over. */
export interface RankIndex {
  season: string;
  /** True when this is the last finished season standing in for an unplayed one. */
  fromPrior: boolean;
  ppg: Map<string, RankInfo>;
  total: Map<string, RankInfo>;
  boomRate: Map<string, RankInfo>;
}

/**
 * Which season the production numbers describe, as a preference.
 *
 * `auto` is the rule the app has always followed on its own: last season until
 * this one has four weeks in it, then this one. The other two pin a season and
 * keep it pinned. See `withStatsSeason` for why pinning is a view over already
 * loaded data rather than a load of anything.
 */
export type StatsSeason = 'auto' | 'prior' | 'current';

/**
 * Applies the preference to a loaded league.
 *
 * Both indexes are built during the one derivation pass, so this is a choice
 * between two objects that already exist — no fetch, no re-derivation, and no
 * reload. It returns `data` itself whenever the preference agrees with what is
 * already selected, which keeps the reference stable and every downstream
 * `useMemo` keyed on `data` from recomputing for nothing.
 *
 * A pin that cannot be honoured falls back rather than blanking the chips: a
 * snapshot with no fitted priors has no prior ranks to pin to.
 */
export function withStatsSeason(data: LeagueData, choice: StatsSeason): LeagueData {
  const wanted =
    choice === 'prior' ? data.priorRanks : choice === 'current' ? data.currentRanks : null;
  if (!wanted || wanted === data.ranks) return data;
  return { ...data, ranks: wanted };
}

export interface PlayoffFormat {
  teams: number;
  weekStart: number;
  regularSeasonWeeks: number;
  /** Last scoring week, including the fantasy playoffs. */
  finalWeek: number;
}

export function playoffFormat(
  league: Pick<League, 'regularSeasonWeeks' | 'playoffTeams' | 'finalWeek'>,
): PlayoffFormat {
  const regularSeasonWeeks = Math.max(1, league.regularSeasonWeeks);
  return {
    teams: Math.max(2, league.playoffTeams),
    weekStart: regularSeasonWeeks + 1,
    regularSeasonWeeks,
    finalWeek: Math.max(regularSeasonWeeks, league.finalWeek),
  };
}

/** Display name, falling back to the id so a missing player is still traceable. */
export function playerName(player: Player | undefined | null, pid: string): string {
  return player?.name?.trim() || `Player ${pid}`;
}

/**
 * True when a player is not expected to play.
 *
 * ESPN reports this as of *now*, so callers viewing a past week must combine it
 * with whether the player actually recorded stats — see `enrichPlayer`.
 */
export function isOut(player: Player | undefined | null): boolean {
  const status = (player?.injuryStatus ?? '').toUpperCase();
  return status === 'OUT' || status === 'INJURY_RESERVE' || status === 'SUSPENSION';
}

export interface LoadProgress {
  phase: string;
  loaded: number;
  total: number;
}

/**
 * Resolves each player's NFL opponent for a week from the pro schedule.
 *
 * ESPN does not attach an opponent to a stat line the way some feeds do, so it
 * is joined here from the team's schedule. A bye is an absent entry rather than
 * an empty string, which is what lets the app tell "on bye" apart from "played
 * an opponent we failed to resolve".
 */
function opponentsFor(
  players: Iterable<Player>,
  proSchedule: LeagueFile['proSchedule'],
  week: number,
): { opponents: Record<string, string>; teams: Record<string, string> } {
  const opponents: Record<string, string> = {};
  const teams: Record<string, string> = {};

  for (const player of players) {
    if (!player.team || player.proTeamId <= 0) continue;
    const game = proSchedule[String(player.proTeamId)]?.[String(week)];
    if (!game) continue;
    opponents[player.playerId] = game.opponent;
    teams[player.playerId] = player.team;
  }

  return { opponents, teams };
}

export async function loadLeague(
  leagueKey: string,
  onProgress?: (progress: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<LeagueData> {
  const report = (phase: string, loaded: number, total: number) =>
    onProgress?.({ phase, loaded, total });

  report('Reading snapshot', 0, 4);
  const index = await loadIndex(leagueKey, signal);
  const stamp = index.generatedAt;

  const [leagueFile, playersFile, historyFile, projectionModel, priors] = await Promise.all([
    loadLeagueFile(leagueKey, stamp, signal),
    loadPlayersFile(leagueKey, stamp, signal),
    loadHistoryFile(leagueKey, stamp, signal),
    loadProjectionModel(leagueKey, stamp, signal),
    loadPriorsFile(leagueKey, stamp, signal),
  ]);

  const { league, teams: rawTeams, schedule, draft, transactions, proSchedule } = leagueFile;

  report('Loading weeks', 1, 4);
  const weekFiles = await Promise.all(
    index.weeks.map((week) => loadWeekFile(leagueKey, week, stamp, signal)),
  );

  // --- Shapes -------------------------------------------------------------
  const playersById = new Map<string, Player>(
    playersFile.players.map((p) => [p.playerId, p]),
  );

  const scoringModel = compileScoring(league.scoringSettings, league.scoringOverrides);
  const score = createScorer(scoringModel);

  const scheduleByWeek = new Map<number, Matchup[]>();
  for (const matchup of schedule) {
    const list = scheduleByWeek.get(matchup.week);
    if (list) list.push(matchup);
    else scheduleByWeek.set(matchup.week, [matchup]);
  }

  const weeks = new Map<number, WeekData>();
  const weekStats = new Map<number, Record<string, StatLine>>();
  const weekProjections = new Map<number, Record<string, StatLine>>();
  const weekOpponents = new Map<number, Record<string, string>>();
  const weekTeams = new Map<number, Record<string, string>>();

  for (const file of weekFiles) {
    const { opponents, teams } = opponentsFor(playersById.values(), proSchedule, file.week);
    const complete = (scheduleByWeek.get(file.week) ?? []).every((m) => m.complete);

    weeks.set(file.week, {
      week: file.week,
      stats: file.actuals,
      projections: file.projections,
      opponents,
      teams,
      lineups: file.lineups ?? {},
      complete: complete && Object.keys(file.actuals).length > 0,
    });
    weekStats.set(file.week, file.actuals);
    weekProjections.set(file.week, file.projections);
    weekOpponents.set(file.week, opponents);
    weekTeams.set(file.week, teams);
  }

  const currentWeek = index.latestCompletedWeek;
  const maxWeek = index.finalWeek;
  const format = playoffFormat(league);
  // The week the app opens on: the next one to be played, capped at the last
  // week the league actually plays.
  const liveWeek = Math.min(Math.max(1, currentWeek + 1), format.finalWeek);

  const teamsWithPlacement: TeamInfo[] = rawTeams.map((team) => ({
    ...team,
    placement: null,
  }));
  const teamsById = new Map(teamsWithPlacement.map((t) => [t.teamId, t]));

  // --- Metrics ------------------------------------------------------------
  report('Computing metrics', 2, 4);

  const valueIndex = buildValueIndex({
    scoringModel,
    playersById,
    season: index.season,
    weekStats,
    weekProjections,
    weekOpponents,
    weekTeams,
    forecastProjections: weekProjections.get(liveWeek),
    throughWeek: currentWeek,
  });

  /*
   * Prior-season stats, opponents and teams, in the same week-keyed shape as
   * this season's. Built here because two different things need them: the
   * defence ratings below, and the residual fit further down.
   */
  const priorStats = new Map<number, Record<string, StatLine>>();
  const priorOpponents = new Map<number, Record<string, string>>();
  const priorTeams = new Map<number, Record<string, string>>();

  for (const [pid, byWeek] of Object.entries(historyFile.logs)) {
    for (const [rawWeek, line] of Object.entries(byWeek)) {
      const week = Number(rawWeek);
      let stats = priorStats.get(week);
      if (!stats) priorStats.set(week, (stats = {}));
      stats[pid] = line;

      const game = historyFile.games?.[pid]?.[rawWeek];
      if (!game) continue;

      let opps = priorOpponents.get(week);
      if (!opps) priorOpponents.set(week, (opps = {}));
      opps[pid] = game.opp;

      let teams = priorTeams.get(week);
      if (!teams) priorTeams.set(week, (teams = {}));
      teams[pid] = game.team;
    }
  }

  // The fantasy schedule ends before the NFL schedule. A season projection is
  // spread over the 17 games each NFL team can play, derived from the 18-week
  // history feed rather than from this league's fantasy playoff calendar.
  const priorSeasonWeeks = priorStats.size
    ? Math.max(...priorStats.keys())
    : league.finalWeek + 1;

  /*
   * The rank chips — Total, PPG and boom rate — before this season has ranks.
   *
   * `buildValueIndex` ranks the season in progress, and in week one there is no
   * season in progress: no games, so no points per game, no total and no boom
   * rate, and every row on every page reads "Total — | PPG — | BR —". Correct,
   * and useless to somebody setting a week-one lineup off what these players did
   * last year.
   *
   * The production comes from `priors.json`, fitted by `npm run fit:priors`.
   * Boom rate is the reason it cannot be computed here: it needs the weekly
   * projection that preceded each game and `history.json` carries actuals alone
   * — shipping a season of projections to recover it would roughly double a
   * 930KB payload for one chip. Total and PPG could be recomputed from
   * `priorLogs`, and are not, so that all three chips come from one measurement
   * of one season rather than from two that could drift apart.
   *
   * The pool, though, is decided here: who a player is ranked against is today's
   * universe, not last season's. See `PriorProduction.group`.
   */
  const priorProduction = new Map<string, PriorProduction>();
  const priorProductionSeason = String(priors?.recentSeason ?? historyFile.season);
  for (const [pid, entry] of Object.entries(priors?.players ?? {})) {
    const recent = entry.recent;
    if (!recent) continue;
    const group = playersById.get(pid)?.group;
    if (!group) continue;

    const [total, games, boom, projectedGames] = recent;
    if (games <= 0) continue;

    priorProduction.set(pid, {
      pid,
      season: priorProductionSeason,
      group,
      total,
      games,
      ppg: total / games,
      boom,
      projectedGames,
      boomRate: projectedGames > 0 ? boom / projectedGames : 0,
    });
  }

  /*
   * When this season takes over, on the same clock the defence ratings use and
   * for the same reason: four weeks is where a current-season measurement stops
   * being noise. Replaced rather than blended — a rank is an ordering over a
   * pool, and averaging two orderings taken over two different pools produces a
   * number that describes neither.
   */
  const RANKS_MIN_WEEKS = 4;
  const priorRanks =
    priorProduction.size > 0
      ? buildPriorRanks(priorProductionSeason, priorProduction.values(), priorSeasonWeeks)
      : null;

  const priorRankIndex: RankIndex | null = priorRanks
    ? {
        season: priorRanks.season,
        fromPrior: true,
        ppg: priorRanks.ppgRanks,
        total: priorRanks.totalRanks,
        boomRate: priorRanks.boomRateRanks,
      }
    : null;

  const currentRankIndex: RankIndex = {
    season: index.season,
    fromPrior: false,
    ppg: valueIndex.ppgRanks,
    total: valueIndex.totalRanks,
    boomRate: valueIndex.boomRateRanks,
  };

  const ranks: RankIndex =
    currentWeek < RANKS_MIN_WEEKS && priorRankIndex ? priorRankIndex : currentRankIndex;

  /*
   * Defence ratings need played football to rate. In week one this season has
   * none, and an index built over zero weeks rates every defence null — which
   * would blank the matchup chip on every row for the first month, exactly when
   * a manager is least sure who to start.
   *
   * So until this season has enough weeks of its own, the ratings come from
   * last season. That is a real limitation and not a small one: rosters and
   * coordinators change over an offseason, and a defence that was generous last
   * December may not be in September. It is stated in the UI rather than
   * papered over, and it is replaced — not blended — the moment this season can
   * stand on its own, for the same reason the residual fit does.
   */
  const MATCHUP_MIN_WEEKS = 4;
  const matchupFromPrior = currentWeek < MATCHUP_MIN_WEEKS && priorStats.size > 0;

  /*
   * The bootstrap ratings, from as many finished seasons as the snapshot has.
   *
   * `priors.json` carries a recency-weighted blend across every season it
   * pulled, fitted in Node by `npm run fit:priors` and installed here as-is.
   * On a held-out season that blend orders results better than the most recent
   * season alone at five of six positions — including the two where the
   * opponent matters most — which is the whole case for carrying more than one
   * year of defensive history.
   *
   * The single prior season remains the fallback for a snapshot that predates
   * the fit, so an old snapshot degrades to the previous behaviour rather than
   * to nothing.
   */
  const blendedPriorIndex = priors?.defense
    ? matchupIndexFrom(
        new Map(
          Object.entries(priors.defense).map(([group, entries]) => [
            group as PositionGroup,
            new Map(Object.entries(entries)),
          ]),
        ),
        0,
      )
    : null;

  const priorMatchupIndex =
    blendedPriorIndex ??
    (priorStats.size
      ? buildMatchupIndex({
          scoringModel,
          playersById,
          weekStats: priorStats,
          weekOpponents: priorOpponents,
          weekTeams: priorTeams,
          throughWeek: Math.max(...priorStats.keys()),
        })
      : null);
  const currentMatchupIndex = buildMatchupIndex({
    scoringModel,
    playersById,
    weekStats,
    weekOpponents,
    weekTeams,
    throughWeek: currentWeek,
  });
  const matchupIndex = matchupFromPrior && priorMatchupIndex
    ? priorMatchupIndex
    : currentMatchupIndex;

  const currentPregameMatchupIndexes = buildPregameMatchupIndexes(
    { scoringModel, playersById, weekStats, weekOpponents, weekTeams },
    maxWeek,
  );
  const pregameMatchupIndexes = new Map<number, MatchupIndex>();
  for (let week = 1; week <= maxWeek; week++) {
    // A Week 1 pregame index contains zero current-season games. Carry the
    // prior-season baseline until four current games exist, exactly as the live
    // index above does, so forecasts never silently lose matchup context.
    const usePrior = week - 1 < MATCHUP_MIN_WEEKS && priorMatchupIndex !== null;
    pregameMatchupIndexes.set(
      week,
      usePrior
        ? priorMatchupIndex
        : (currentPregameMatchupIndexes.get(week) ?? currentMatchupIndex),
    );
  }

  const priorLogs = new Map<string, Map<number, StatLine>>();
  for (const [pid, byWeek] of Object.entries(historyFile.logs)) {
    priorLogs.set(
      pid,
      new Map(Object.entries(byWeek).map(([week, line]) => [Number(week), line])),
    );
  }

  /*
   * The history-only weekly projection challenger.
   *
   * Each player is walked forward through the season once, carrying the rolling
   * history the model reads. Weeks already played fold their real result in as
   * the walk passes them, so a projection for week 9 is built from weeks 1-8
   * and nothing later — the same discipline `buildPregameMatchupIndexes` uses,
   * and for the same reason.
   *
   * The walk is seeded with the tail of last season. Without it every player
   * carries an empty history until his third game and the model declines to
   * call anyone for the first month of the year, which is precisely when a
   * second opinion is worth most. Last season's closing form is not a strong
   * signal for a player who changed teams, but it is the best one available in
   * September and it is what the model was trained to consume: recent weekly
   * scores, wherever they came from.
   */
  const PRIOR_SEED_WEEKS = 5;
  const ownProjections = new Map<string, Map<number, number>>();

  if (projectionModel) {
    /*
     * Prior-season opportunity share, which the seed needs and the game logs do
     * not carry directly: a share is a player's volume over his own unit's, so
     * the unit totals have to be rebuilt first.
     */
    const priorTeamTotals = new Map<string, number>();
    for (const [pid, byWeek] of priorLogs) {
      const group = playersById.get(pid)?.group;
      if (!group) continue;
      for (const [week, line] of byWeek) {
        if (!hasPlayed(line)) continue;
        const team = historyFile.games?.[pid]?.[String(week)]?.team;
        if (!team) continue;
        const volume = opportunities(group, line);
        if (volume === null) continue;
        const key = `${week}:${team}:${group}`;
        priorTeamTotals.set(key, (priorTeamTotals.get(key) ?? 0) + volume);
      }
    }

    /*
     * Current-season unit totals, so the share feature means the same thing at
     * serve time as it did at fit time. It was passed as null here to begin
     * with, which quietly fed the model a zero for every in-season week — a
     * train/serve mismatch on a feature the fit had real values for.
     */
    const seasonTeamTotals = new Map<string, number>();
    for (const [week, lines] of weekStats) {
      for (const [pid, line] of Object.entries(lines)) {
        if (!hasPlayed(line)) continue;
        const group = playersById.get(pid)?.group;
        const team = weekTeams.get(week)?.[pid];
        if (!group || !team) continue;
        const volume = opportunities(group, line);
        if (volume === null) continue;
        const key = `${week}:${team}:${group}`;
        seasonTeamTotals.set(key, (seasonTeamTotals.get(key) ?? 0) + volume);
      }
    }

    /*
     * A player's level across every finished season, weighted toward the recent.
     *
     * The seed below reads last season's game logs, which is the only place
     * per-week volume and opportunity share can come from. It is not the best
     * available answer to "what does this player score", for two reasons.
     *
     * One season is noisy. A receiver who caught two touchdowns in a quiet year
     * and none in a loud one has a level that swings by four points on a
     * sample of seventeen, and the app applies that number to every week of
     * September.
     *
     * And one season is sometimes *nothing*. A player who missed all of last
     * year with a torn ACL has no logs at all, so the app seeded him from
     * scratch and printed no projection for the first month of his comeback —
     * for exactly the player a manager is most unsure about.
     *
     * So the level is blended across whatever seasons the priors carry, with
     * the same decay the defence ratings use, and the most recent season still
     * dominating. Volume and share stay on last season alone, because that is
     * the only granularity available and mixing a three-year average of volume
     * into a one-year form window would put the rolling state somewhere the
     * model was never fit.
     */
    const SEASON_DECAY = 0.45;

    const blendedPrior = (pid: string): { level: number; durability: number } | null => {
      const entry = priors?.players?.[pid];
      if (!entry) return null;

      const seasons = Object.keys(entry.seasons)
        .map(Number)
        .filter((year) => Number.isFinite(year))
        .sort((a, b) => b - a);
      if (seasons.length === 0) return null;

      let weightSum = 0;
      let levelSum = 0;
      let games = 0;
      let rostered = 0;

      seasons.forEach((year, i) => {
        const [level, played, weeks] = entry.seasons[String(year)];
        const weight = SEASON_DECAY ** i;
        weightSum += weight;
        levelSum += weight * level;
        games += played;
        rostered += weeks;
      });

      return {
        level: levelSum / weightSum,
        // Durability pools every season equally: how often a player is fit is a
        // property of the player, and three years of it is three years of
        // evidence rather than three opinions about this year.
        durability: rostered > 0 ? games / rostered : 1,
      };
    };

    for (const [pid, player] of playersById) {
      const group = player.group;
      if (!group) continue;

      const seeded = newRollingState();
      const priorWeeks = priorLogs.get(pid);
      const blended = blendedPrior(pid);

      /*
       * A player with priors but no logs from last season — the comeback case.
       * Seeded from the blend alone, with no volume or share, which is honest:
       * nothing here knows what his role will be, and the model reads the
       * missing features as unknown rather than as zero.
       */
      if (!priorWeeks && blended) {
        seeded.priorLevel = round(blended.level, 2);
        for (let i = 0; i < PRIOR_SEED_WEEKS; i++) {
          advance(seeded, true, blended.level, null, null, false);
        }
        seeded.rostered = Math.round(seeded.played / Math.max(blended.durability, 0.05));
      }

      if (priorWeeks) {
        /*
         * The seed is last season's *level*, held flat — not its closing run.
         *
         * Weighting last season by recency cannot be justified across a
         * boundary that contains a draft, free agency and a training camp:
         * there is no reason week 17 should count five times week 13 when the
         * roster in between was rebuilt. Worse, it is actively harmful — the
         * decay leans hardest on the most recent week, and the most recent week
         * of an NFL regular season is the one every playoff-bound starter sits
         * out. Seeding from the tail projected Ja'Marr Chase at 3.6 points.
         *
         * So the seed is his mean over the weeks he played, repeated: every
         * form feature the model reads then agrees, and none of them is
         * pretending to know something about September that last December
         * cannot tell it.
         */
        const played = [...priorWeeks.entries()].filter(
          ([week, line]) => week <= 17 && hasPlayed(line),
        );

        if (played.length >= 2) {
          let points = 0;
          let volumeTotal = 0;
          let volumeCount = 0;
          let shareTotal = 0;
          let shareCount = 0;

          for (const [week, line] of played) {
            points += score(line, group);
            const volume = opportunities(group, line);
            if (volume !== null) {
              volumeTotal += volume;
              volumeCount++;
              const team = historyFile.games?.[pid]?.[String(week)]?.team;
              const unit = team ? priorTeamTotals.get(`${week}:${team}:${group}`) : undefined;
              if (unit) {
                shareTotal += volume / unit;
                shareCount++;
              }
            }
          }

          /*
           * The blended level where the priors have one, last season's own
           * otherwise. Both are a mean over the weeks he played; the blend just
           * has more of them behind it.
           */
          const level = blended?.level ?? points / played.length;
          const volumeLevel = volumeCount ? volumeTotal / volumeCount : null;
          const shareLevel = shareCount ? shareTotal / shareCount : null;
          seeded.priorLevel = round(level, 2);

          for (let i = 0; i < PRIOR_SEED_WEEKS; i++) {
            advance(seeded, true, level, volumeLevel, shareLevel, false);
          }
        }

        /*
         * Availability is counted over the whole prior season rather than the
         * seeded window, because that is the question it answers — a player who
         * missed six weeks and then finished strong is still a player who
         * misses weeks.
         */
        /*
         * Availability carries over as a rate rather than as raw counts. The
         * counts themselves would be inconsistent with the seeded window — a
         * `games` of 15 beside five scores is a state the model was never fit
         * on — so the window keeps its own length and only the rate is
         * inherited.
         */
        let rostered = 0;
        let appearances = 0;
        for (const [week, line] of priorWeeks) {
          if (week > 17) continue;
          rostered++;
          if (hasPlayed(line)) appearances++;
        }
        const rate =
          blended?.durability ??
          (rostered > 0 && appearances > 0 ? appearances / rostered : null);
        if (rate !== null) {
          seeded.rostered = Math.round(seeded.played / Math.max(rate, 0.05));
        }
      }

      const byWeek = new Map<number, number>();
      for (let week = 1; week <= format.finalWeek; week++) {
        const opponent = weekOpponents.get(week)?.[pid] ?? null;
        // A bye has no opponent and no projection to make.
        if (opponent) {
          const rating = matchupIndex.get(group, opponent)?.score ?? null;
          const value = projectPlayerWeek(projectionModel, group, seeded, rating);
          if (value !== null) byWeek.set(week, round(value, 2));
        }

        /*
         * Only weeks that have actually been played advance the history. Beyond
         * the live week there is nothing to fold in, so every remaining week is
         * projected from today's form — which is the honest shape of a forecast
         * made in September about December.
         */
        if (week >= liveWeek) continue;
        const line = weekStats.get(week)?.[pid];
        if (!line) continue;
        const didPlay = hasPlayed(line);
        const volume = didPlay ? opportunities(group, line) : null;
        const team = weekTeams.get(week)?.[pid];
        const unit = team ? seasonTeamTotals.get(`${week}:${team}:${group}`) : undefined;
        advance(
          seeded,
          didPlay,
          didPlay ? score(line, group) : 0,
          volume,
          volume !== null && unit ? volume / unit : null,
        );
      }

      if (byWeek.size) ownProjections.set(pid, byWeek);
    }
  }

  /*
   * Prior-season pairs, so the forecast has a measured spread to work from
   * before this season has produced one. See `MIN_OWN_SAMPLES` in forecast.ts
   * for where they come from and where they are weak.
   */
  const priorPairs = new Map<PositionGroup, PriorPair[]>();
  /** pid -> weeks he recorded a stat line, over weeks he could have. */
  const priorPlays = new Map<string, { played: number; projected: number }>();
  const priorGames = Math.max(1, priorSeasonWeeks - 1);

  for (const [pid, byWeek] of priorLogs) {
    const player = playersById.get(pid);
    const group = player?.group;
    if (!group) continue;

    const seasonLine = playersFile.seasonProjectionPrior[pid];
    if (!seasonLine) continue;

    const perWeek = score(seasonLine, group) / priorGames;
    if (perWeek < 1) continue;

    let list = priorPairs.get(group);
    if (!list) priorPairs.set(group, (list = []));

    let played = 0;
    for (const [week, line] of byWeek) {
      /*
       * An empty log is a week the player was on a roster and recorded nothing.
       * That zero belongs in the distribution — it is most of what a floor is —
       * and dropping it would fit a spread over only the weeks he showed up.
       */
      const actual = score(line, group);
      const didPlay = hasPlayed(line);
      if (didPlay) played++;

      list.push({
        pid,
        projection: perWeek,
        actual,
        played: didPlay,
        week,
        team: player.team ?? '',
      });
    }
    priorPlays.set(pid, { played, projected: byWeek.size });
  }

  const residualModel = fitResidualModel({
    scoringModel,
    playersById,
    weekStats,
    weekProjections,
    weekTeams,
    throughWeek: currentWeek,
    priorPairs,
    priorPlays,
    priorFit: priors?.residual ?? null,
  });

  report('Valuing players', 3, 4);

  /*
   * Rest-of-season inputs. Both are per-player, per-week maps over the weeks
   * that have not been played, scored and measured with the same engine the
   * rest of the app uses rather than with anything ESPN precomputed.
   */
  const weeklyProjections = new Map<string, Map<number, number>>();
  const weeklyOpportunities = new Map<string, Map<number, number>>();

  for (const [week, lines] of weekProjections) {
    if (week < liveWeek) continue;
    for (const [pid, line] of Object.entries(lines)) {
      const group = playersById.get(pid)?.group;
      if (!group) continue;

      let byWeek = weeklyProjections.get(pid);
      if (!byWeek) weeklyProjections.set(pid, (byWeek = new Map()));
      byWeek.set(week, score(line, group));

      const volume = opportunities(group, line);
      if (volume !== null) {
        let opps = weeklyOpportunities.get(pid);
        if (!opps) weeklyOpportunities.set(pid, (opps = new Map()));
        opps.set(week, volume);
      }
    }
  }

  /*
   * Schedule ahead: the mean matchup rating a player faces over the weeks that
   * remain. Ratings come from the same defence model the weekly chips use, so
   * a player is never rated against a defence the model has not seen play.
   */
  const scheduleAhead = new Map<string, number>();
  for (const [pid, player] of playersById) {
    if (!player.group || !player.team) continue;
    let sum = 0;
    let n = 0;
    for (let week = liveWeek; week <= format.finalWeek; week++) {
      const game = proSchedule[String(player.proTeamId)]?.[String(week)];
      if (!game) continue;
      const rating = matchupIndex.get(player.group, game.opponent);
      if (rating === null) continue;
      sum += rating.score;
      n++;
    }
    if (n > 0) scheduleAhead.set(pid, sum / n);
  }

  /*
   * Each player's measured availability across every finished season.
   *
   * Folded into the rest-of-season score alongside today's injury label, which
   * on its own cannot distinguish a back who has missed a third of three
   * seasons from one who has never missed a snap — both read ACTIVE in
   * September, and over fourteen remaining weeks they are not the same asset.
   */
  const durability = new Map<string, number>();
  for (const [pid, entry] of Object.entries(priors?.players ?? {})) {
    let games = 0;
    let weeks = 0;
    for (const [, played, rostered] of Object.values(entry.seasons)) {
      games += played;
      weeks += rostered;
    }
    if (weeks > 0) durability.set(pid, games / weeks);
  }

  /*
   * The league's own measured opponent influence, or the compiled fallback.
   *
   * `MATCHUP_INFLUENCE` was fit against one league's scoring table, and the
   * measurement is a property of that table rather than of football — see
   * `BuildSeasonValueInput.influenceByGroup`. Every league's `priors.json`
   * carries its own, so a snapshot that has been fit prices its own schedule;
   * one that has not falls back to the constant, which is the same bargain the
   * rest of the priors make.
   */
  const matchupInfluence: Record<PositionGroup, number> = { ...MATCHUP_INFLUENCE };
  for (const group of Object.keys(matchupInfluence) as PositionGroup[]) {
    const measured = priors?.influence?.[group];
    if (typeof measured === 'number' && Number.isFinite(measured)) {
      matchupInfluence[group] = measured;
    }
  }

  const seasonValueIndex = buildSeasonValueIndex({
    valueIndex,
    playersById,
    weeklyProjections,
    weeklyOpportunities,
    scheduleAhead,
    rosterSlots: league.rosterSlots,
    numTeams: league.size,
    fromWeek: liveWeek,
    finalWeek: format.finalWeek,
    durability,
    influenceByGroup: matchupInfluence,
  });

  /*
   * Trade values, priced against the same weekly projections the rest-of-season
   * model uses but in points rather than percentiles, so they can be summed
   * across positions and across a multi-player deal.
   */
  const rostered = new Set<string>();
  for (const team of teamsWithPlacement) {
    for (const pid of team.players ?? []) rostered.add(pid);
  }

  /*
   * Drift and reliability measured offline over every finished season, forward
   * — see `BuildTradeValuesInput.driftByGroup`. Falls back to measuring here
   * from the single prorated prior season when a snapshot predates the fit.
   */
  const driftByGroup = priors?.drift
    ? new Map<PositionGroup, DriftFit>(
        Object.entries(priors.drift).map(([group, fit]) => [
          group as PositionGroup,
          { group: group as PositionGroup, ...fit, measured: true },
        ]),
      )
    : undefined;

  const tradeValues = buildTradeValues({
    playersById,
    weeklyProjections,
    rosteredIds: rostered,
    rosterSlots: league.rosterSlots,
    numTeams: league.size,
    fromWeek: liveWeek,
    finalWeek: format.finalWeek,
    priorPairs,
    driftByGroup,
  });

  // One denominator for the entire league, before any UI filtering. Never
  // substitute a positional percentile when there is no remaining projection.
  const combinedScores = new Map<string, number>();
  for (const [pid, value] of tradeValues.byPlayer) {
    if (!value.unprojected) combinedScores.set(pid, Math.round(value.index * 10));
  }

  const positionScores = new Map<string, number>();
  const scoredPids = new Set<string>([
    ...valueIndex.byPlayer.keys(),
    ...seasonValueIndex.byPlayer.keys(),
  ]);
  for (const pid of scoredPids) {
    const inSeason = valueIndex.byPlayer.get(pid)?.score ?? null;
    const seasonValue = seasonValueIndex.byPlayer.get(pid);
    // Neutral priors are useful inside the model, but are not a player rating
    // when neither production nor a remaining projection supports them.
    if (inSeason === null && seasonValue?.breakdown.restOfSeasonPoints == null) continue;
    const rest = seasonValue?.score ?? null;
    if (inSeason !== null && rest !== null) {
      positionScores.set(pid, Math.round((inSeason + rest) / 2));
    } else if (inSeason !== null) positionScores.set(pid, inSeason);
    else if (rest !== null) positionScores.set(pid, rest);
  }

  report('Ready', 4, 4);

  return {
    season: index.season,
    generatedAt: stamp,
    league,
    matchupInfluence,
    scoringModel,
    score,
    playersById,
    teams: teamsWithPlacement,
    teamsById,
    weeks,
    schedule,
    scheduleByWeek,
    draft,
    transactions,
    proSchedule,
    byeWeeks: new Map(Object.entries(leagueFile.byeWeeks)),
    currentWeek,
    liveWeek,
    maxWeek,
    starterSlots: starterSlots(league.rosterSlots),
    valueIndex,
    seasonValueIndex,
    combinedScores,
    positionScores,
    tradeValues,
    ownProjections,
    projectionModel,
    weeklyProjections,
    matchupIndex,
    matchupFromPrior,
    pregameMatchupIndexes,
    residualModel,
    priorSeason: historyFile.season,
    priorLogs,
    ranks,
    priorRanks: priorRankIndex,
    currentRanks: currentRankIndex,
    priorProduction,
    playoff: format,
  };
}
