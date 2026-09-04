/**
 * Pulls the league from ESPN and writes the static snapshot the app reads.
 *
 * This script is the *only* thing that ever talks to ESPN, and the only thing
 * that ever sees the credentials. It runs in Node — locally before a build, or
 * on a schedule in CI — and writes plain JSON into `public/data`. The shipped
 * bundle has no cookie in it and makes no ESPN request.
 *
 * That split isn't a stylistic choice. ESPN serves this league only to a
 * request carrying the `SWID` and `espn_s2` cookies, and a browser on
 * `*.github.io` cannot send espn.com cookies to a cross-site request under any
 * modern cookie policy. Shipping the credentials to the client would not even
 * fix it — it would just leak them, because `fetch` refuses to set `Cookie`.
 *
 *   ESPN_SWID='{XXXXXXXX-...}' ESPN_S2='AEB...' npm run snapshot
 *
 * Both can also live in a gitignored `.env` at the repo root.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ESPN_HOST,
  espnFetch,
  leagueUrl,
  parseLeague,
  parseMembers,
  parsePlayer,
  parseSchedule,
  parseTeams,
  selectStats,
  statLineOf,
  type EspnCredentials,
  type RawStatBlock,
} from '../src/lib/espn';
import { normalizeStatLine } from '../src/lib/espn-stats';
import { LINEUP_SLOTS, PRO_TEAMS, type StatLine } from '../src/lib/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'public', 'data');

/**
 * Where the raw multi-season weekly history lands.
 *
 * Outside `public/` on purpose. These are eight megabytes of finished-season
 * player-weeks that only the Node-side fits read, and anything under `public/`
 * is copied verbatim into the deployed bundle — so leaving them there would
 * ship eight megabytes to every visitor to serve a file no client ever
 * requests. Everything the browser needs from them is distilled into
 * `public/data/priors.json` by `npm run fit:priors`, at about three percent of
 * the size.
 */
const HISTORY_OUT = join(ROOT, 'history');

const LEAGUE_ID = process.env.ESPN_LEAGUE_ID || '390483100';
const SEASON = Number(process.env.ESPN_SEASON || new Date().getFullYear());
/** Season whose completed game logs seed the priors. */
const HISTORY_SEASON = SEASON - 1;

/**
 * How many finished seasons of weekly history to pull.
 *
 * Three, because the two things it buys are different and both matter. More
 * pairs sharpen every distribution the app fits — a residual shape carried as
 * 257 quantile knots wants thousands of samples, not hundreds. And a *second*
 * prior season is what makes a prior season a usable feature at all: fitting on
 * 2025 with 2024 behind it can learn what last year's level is worth, which a
 * single-season fit structurally cannot.
 *
 * Beyond three the returns fall away fast. NFL rosters, coordinators and rules
 * turn over enough that a 2022 defence tells you very little about a 2026 one,
 * and every extra season is another full universe of weekly requests.
 */
const HISTORY_DEPTH = Number(process.env.ESPN_HISTORY_DEPTH ?? 3);
const HISTORY_SEASONS = Array.from(
  { length: HISTORY_DEPTH },
  (_, i) => SEASON - 1 - i,
).filter((year) => year >= 2019);

/**
 * The pseudo-league every finished season can be read through.
 *
 * This league did not exist before {SEASON}, so its own endpoint 404s for
 * every prior year — which is why the app used to reach a single season back
 * through `kona_playercard`, the one view that returns another season's game
 * logs against a league that never played it.
 *
 * `leaguedefaults/3` is the way past that. It is ESPN's standard-scoring
 * template league, it exists for every season, and `kona_player_info` against
 * it returns each player's full weekly history for that year — **including the
 * weekly projections that preceded each game**, which `kona_playercard` does
 * not carry and which this app previously assumed were unrecoverable.
 *
 * Two things make it safe to score against this league's own settings. The raw
 * stat lines are league-independent: a reception is a reception, and the
 * multiply into points happens locally in `scoring.ts`. And the claim is
 * checked rather than trusted — `verify:history` rescores every 2025 week
 * pulled this way against the same week pulled through the league endpoint, and
 * the two agree exactly across 11,713 player-weeks. Nothing here reads
 * `appliedTotal` from this endpoint, which *would* be wrong: those totals are
 * computed under ESPN's default scoring, not this league's.
 */
const historySeasonUrl = (season: number) =>
  `${ESPN_HOST}/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/3` +
  '?view=kona_player_info';

/** Loads `.env` without a dependency. Real environment variables win. */
async function loadDotEnv(): Promise<void> {
  try {
    const text = await readFile(join(ROOT, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[2].trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[match[1]]) process.env[match[1]] = value;
    }
  } catch {
    /* no .env — expected in CI, where the variables come from secrets */
  }
}

function credentials(): EspnCredentials {
  const swid = process.env.ESPN_SWID;
  const espnS2 = process.env.ESPN_S2;

  if (!swid || !espnS2) {
    throw new Error(
      'Missing ESPN credentials. Set ESPN_SWID and ESPN_S2 in the environment ' +
        'or in a .env file at the repo root. Both are cookies on espn.com from ' +
        'a logged-in browser session.',
    );
  }

  // SWID is braced in the cookie jar and people paste it both ways.
  return {
    swid: swid.startsWith('{') ? swid : `{${swid}}`,
    espnS2,
  };
}

/**
 * Keys kept in the snapshot beyond the ones that score.
 *
 * ESPN attaches a lot of derived rate stats and unnamed ids to every line —
 * yards per reception, share-of-team figures, and about twenty numeric ids it
 * has never documented. None of them can move a score, and carrying them
 * tripled the size of the weekly payloads. These are the ones the app reads for
 * role, volume and availability.
 */
const USAGE_KEYS = new Set([
  'gp',
  'pass_att',
  'pass_cmp',
  'rush_att',
  'rec_tgt',
  'rec',
  'fga',
  'xpa',
  'fgm',
  'fum',
  'def_yds_allowed',
  'def_pass_def',
  'def_turnover',
]);

/**
 * Drops zero, missing and non-scoring entries.
 *
 * A stat line is mostly zeroes, and everything outside the league's own scoring
 * keys plus `USAGE_KEYS` is dead weight in the browser.
 */
function compactWith(keep: Set<string>) {
  return (line: StatLine): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(line)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) continue;
      if (!keep.has(key)) continue;
      out[key] = value;
    }
    return out;
  };
}

interface PlayerEnvelope {
  player: { id: number; stats?: RawStatBlock[] } & Record<string, unknown>;
}

async function main(): Promise<void> {
  await loadDotEnv();
  const creds = credentials();
  await mkdir(OUT, { recursive: true });

  const log = (msg: string) => process.stdout.write(`${msg}\n`);
  log(`league ${LEAGUE_ID}, season ${SEASON}`);

  // One stamp for the whole run. Every file carries it, and the client caches
  // on it, so a half-written snapshot can never look current.
  const generatedAt = Date.now();

  // --- League, teams, schedule, draft -------------------------------------
  const raw = await espnFetch<any>(
    leagueUrl({
      season: SEASON,
      leagueId: LEAGUE_ID,
      views: [
        'mSettings',
        'mTeam',
        'mRoster',
        'mMatchup',
        'mStandings',
        'mDraftDetail',
        'mTransactions2',
      ],
    }),
    creds,
  );

  const members = parseMembers(raw.members ?? []);
  const teams = parseTeams(raw.teams ?? [], members);
  const schedule = parseSchedule(raw.schedule ?? []);
  const completedWeek = schedule.reduce(
    (max, m) => (m.complete && m.week > max ? m.week : max),
    0,
  );
  const league = parseLeague(raw, completedWeek);
  log(`  ${league.name}: ${teams.length} teams, week ${league.currentWeek}, ` +
      `${completedWeek} complete`);

  // Everything the league scores, in either the base table or the D/ST
  // override, plus the usage keys — the snapshot keeps nothing else.
  const keep = new Set<string>(USAGE_KEYS);
  for (const [key, mult] of Object.entries(league.scoringSettings)) {
    if (mult !== 0) keep.add(key);
  }
  for (const table of Object.values(league.scoringOverrides)) {
    for (const [key, mult] of Object.entries(table ?? {})) {
      if (mult !== 0) keep.add(key);
    }
  }
  const compact = compactWith(keep);
  log(`  keeping ${keep.size} stat keys`);

  // --- Pro schedule: byes, opponents and kickoff times ---------------------
  const pro = await espnFetch<any>(
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}` +
      '?view=proTeamSchedules_wl',
    creds,
  );

  const byeWeeks = new Map<number, number>();
  const proSchedule: Record<
    string,
    Record<string, { opponent: string; home: boolean; kickoff: number; gameId: number }>
  > = {};

  for (const team of pro.settings?.proTeams ?? []) {
    if (typeof team.byeWeek === 'number' && team.byeWeek > 0) {
      byeWeeks.set(team.id, team.byeWeek);
    }
    const byWeek: Record<string, { opponent: string; home: boolean; kickoff: number; gameId: number }> = {};

    for (const [week, games] of Object.entries(team.proGamesByScoringPeriod ?? {})) {
      const game = (games as any[])[0];
      if (!game) continue;
      const home = game.homeProTeamId === team.id;
      byWeek[week] = {
        opponent: PRO_TEAMS[home ? game.awayProTeamId : game.homeProTeamId] ?? '?',
        home,
        kickoff: game.date ?? 0,
        gameId: game.id ?? 0,
      };
    }
    proSchedule[String(team.id)] = byWeek;
  }
  log(`  pro schedule: ${Object.keys(proSchedule).length} teams`);

  /*
   * Each finished season's fixtures, kept to resolve who a game log was against.
   *
   * A weekly log carries the player's own team and the NFL game id but not the
   * opponent, and without the opponent the defence ratings have nothing to rate
   * — every matchup chip would be blank until this season has played enough
   * football to build its own, which is most of the season.
   */
  const priorGameSidesBySeason = new Map<
    number,
    Map<number, { home: number; away: number }>
  >();

  for (const year of HISTORY_SEASONS) {
    const priorPro = await espnFetch<any>(
      `${ESPN_HOST}/apis/v3/games/ffl/seasons/${year}?view=proTeamSchedules_wl`,
      creds,
    ).catch(() => null);

    const sides = new Map<number, { home: number; away: number }>();
    for (const team of priorPro?.settings?.proTeams ?? []) {
      for (const games of Object.values(team.proGamesByScoringPeriod ?? {})) {
        const game = (games as any[])[0];
        if (!game?.id) continue;
        sides.set(game.id, { home: game.homeProTeamId, away: game.awayProTeamId });
      }
    }
    priorGameSidesBySeason.set(year, sides);
    log(`  ${year} fixtures: ${sides.size} games`);
  }

  const priorGameSides =
    priorGameSidesBySeason.get(HISTORY_SEASON) ??
    new Map<number, { home: number; away: number }>();

  // --- The player universe -------------------------------------------------
  // One request returns every player ESPN will let this league roster, with
  // season projections, season actuals and the draft market attached.
  const universe = await espnFetch<{ players: PlayerEnvelope[] }>(
    leagueUrl({ season: SEASON, leagueId: LEAGUE_ID, views: ['kona_player_info'] }),
    creds,
    {
      filter: {
        players: {
          limit: 2000,
          sortPercOwned: { sortAsc: false, sortPriority: 1 },
          filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] },
        },
      },
    },
  );

  const envelopes = universe.players ?? [];
  const players = envelopes.map((e) => parsePlayer(e.player as any, byeWeeks, 'PPR'));
  const ids = envelopes.map((e) => e.player.id);
  log(`  players: ${players.length}`);

  const seasonProjection: Record<string, Record<string, number>> = {};
  const seasonActualPrior: Record<string, Record<string, number>> = {};
  const seasonProjectionPrior: Record<string, Record<string, number>> = {};
  /** ESPN's own applied totals, kept solely so `verify` can check ours. */
  const appliedTotals: Record<string, Record<string, number>> = {};

  for (const { player } of envelopes) {
    const pid = String(player.id);
    const put = (
      target: Record<string, Record<string, number>>,
      block: RawStatBlock | null,
    ) => {
      if (!block) return;
      const line = compact(statLineOf(block));
      if (Object.keys(line).length > 0) target[pid] = line;
    };

    put(seasonProjection, selectStats(player.stats, { season: SEASON, source: 1, split: 0 }));
    put(seasonActualPrior, selectStats(player.stats, { season: HISTORY_SEASON, source: 0, split: 0 }));
    put(seasonProjectionPrior, selectStats(player.stats, { season: HISTORY_SEASON, source: 1, split: 0 }));

    const totals: Record<string, number> = {};
    for (const block of player.stats ?? []) {
      if (typeof block.appliedTotal === 'number') totals[block.id] = block.appliedTotal;
    }
    if (Object.keys(totals).length > 0) appliedTotals[pid] = totals;
  }

  // --- Weekly projections, every week of the season ------------------------
  // ESPN publishes a projection for every future week, so the whole season is
  // available before a snap is played. Actuals arrive in the same blocks as
  // weeks complete, which is why this walks the full range every run.
  const weeks: Record<
    string,
    {
      projections: Record<string, Record<string, number>>;
      actuals: Record<string, Record<string, number>>;
      appliedProjected: Record<string, number>;
      appliedActual: Record<string, number>;
      /** teamId -> pid -> the slot that player occupied this week. */
      lineups: Record<string, Record<string, string>>;
    }
  > = {};

  for (let week = 1; week <= league.finalWeek; week++) {
    const payload = await espnFetch<{ players: PlayerEnvelope[] }>(
      leagueUrl({
        season: SEASON,
        leagueId: LEAGUE_ID,
        views: ['kona_player_info'],
        scoringPeriodId: week,
      }),
      creds,
      {
        filter: {
          players: {
            limit: 2000,
            sortPercOwned: { sortAsc: false, sortPriority: 1 },
            filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] },
          },
        },
      },
    );

    const projections: Record<string, Record<string, number>> = {};
    const actuals: Record<string, Record<string, number>> = {};
    const appliedProjected: Record<string, number> = {};
    const appliedActual: Record<string, number> = {};

    for (const { player } of payload.players ?? []) {
      const pid = String(player.id);

      const proj = selectStats(player.stats, { season: SEASON, source: 1, split: 1, week });
      if (proj) {
        const line = compact(statLineOf(proj));
        if (Object.keys(line).length > 0) projections[pid] = line;
        if (typeof proj.appliedTotal === 'number') appliedProjected[pid] = proj.appliedTotal;
      }

      const act = selectStats(player.stats, { season: SEASON, source: 0, split: 1, week });
      if (act) {
        const line = compact(statLineOf(act));
        if (Object.keys(line).length > 0) actuals[pid] = line;
        if (typeof act.appliedTotal === 'number') appliedActual[pid] = act.appliedTotal;
      }
    }

    /*
     * The lineup each team actually fielded that week.
     *
     * The roster on the team record is *today's* lineup, and using it to answer
     * "what did you start in week 3" would silently rewrite history every time
     * someone moved a player. `mBoxscore` records the real thing, per week, so
     * the History and Optimal pages compare against what was actually started.
     */
    const box = await espnFetch<any>(
      leagueUrl({
        season: SEASON,
        leagueId: LEAGUE_ID,
        views: ['mBoxscore'],
        scoringPeriodId: week,
      }),
      creds,
    );

    const lineups: Record<string, Record<string, string>> = {};
    for (const matchup of box.schedule ?? []) {
      if (matchup.matchupPeriodId !== week) continue;
      for (const side of [matchup.home, matchup.away]) {
        if (!side?.teamId) continue;
        const roster = side.rosterForCurrentScoringPeriod ?? side.rosterForMatchupPeriod;
        const slots: Record<string, string> = {};
        for (const entry of roster?.entries ?? []) {
          slots[String(entry.playerId)] =
            LINEUP_SLOTS[entry.lineupSlotId] ?? String(entry.lineupSlotId);
        }
        if (Object.keys(slots).length > 0) lineups[String(side.teamId)] = slots;
      }
    }

    weeks[String(week)] = { projections, actuals, appliedProjected, appliedActual, lineups };
    process.stdout.write(
      `\r  week ${week}: ${Object.keys(projections).length} projected, ` +
        `${Object.keys(actuals).length} played   `,
    );
  }
  process.stdout.write('\n');

  // --- Prior-season game logs ---------------------------------------------
  // `kona_playercard` is the only view that returns per-week actuals for a
  // season the league didn't play, and it returns them for the whole universe
  // in one request. These are already scored under *this* league's settings by
  // ESPN, which is what makes them a usable check as well as a usable prior.
  const cards = await espnFetch<{ players: PlayerEnvelope[] }>(
    leagueUrl({ season: SEASON, leagueId: LEAGUE_ID, views: ['kona_playercard'] }),
    creds,
    {
      filter: {
        players: {
          filterIds: { value: ids },
          filterStatsForTopScoringPeriodIds: { value: 17 },
        },
      },
    },
  );

  const history: Record<string, Record<string, Record<string, number>>> = {};
  const historyApplied: Record<string, Record<string, number>> = {};
  /** pid -> week -> { team, opponent }, joined through the NFL game id. */
  const historyGames: Record<string, Record<string, { team: string; opp: string }>> = {};
  let logCount = 0;

  for (const { player } of cards.players ?? []) {
    const pid = String(player.id);
    const byWeek: Record<string, Record<string, number>> = {};
    const applied: Record<string, number> = {};
    const games: Record<string, { team: string; opp: string }> = {};

    for (const block of player.stats ?? []) {
      if (block.seasonId !== HISTORY_SEASON) continue;
      if (block.statSourceId !== 0 || block.statSplitTypeId !== 1) continue;

      // An empty block is not noise: ESPN writes a game-log entry for every
      // week a player was on a roster, so an empty one means the game happened
      // and he did not record a stat. That distinction is the whole basis of
      // the availability term, and dropping it would bill every inactive week
      // as missing data instead of as a zero.
      const line = compact(normalizeStatLine(block.stats));

      const week = String(block.scoringPeriodId);
      byWeek[week] = line;
      if (typeof block.appliedTotal === 'number') applied[week] = block.appliedTotal;

      const sides = priorGameSides.get(Number(block.externalId));
      const own = block.proTeamId ?? 0;
      if (sides && own > 0) {
        const oppId = sides.home === own ? sides.away : sides.home;
        const team = PRO_TEAMS[own];
        const opp = PRO_TEAMS[oppId];
        if (team && opp) games[week] = { team, opp };
      }

      logCount++;
    }

    if (Object.keys(byWeek).length > 0) {
      history[pid] = byWeek;
      historyApplied[pid] = applied;
      if (Object.keys(games).length > 0) historyGames[pid] = games;
    }
  }
  log(`  ${HISTORY_SEASON} game logs: ${logCount} player-weeks over ${Object.keys(history).length} players`);

  // --- Finished seasons, week by week, with their projections --------------
  /*
   * The pairs everything downstream is fit on.
   *
   * `kona_playercard` above returns one prior season of *actuals*, and that is
   * all it returns. Reading each finished season through `leaguedefaults/3`
   * instead gets both halves of every week — what the player was projected for
   * and what he then did — for as many seasons back as `HISTORY_DEPTH` asks
   * for.
   *
   * That pairing is the point. A residual distribution, a bias correction and a
   * measurement of how much an opponent actually moves a result all need to
   * know what was expected before they can say anything about what happened.
   * Without these the app had to stand a prorated season projection in for a
   * weekly one — a real ESPN number at the wrong granularity — and pay for it
   * in every coverage figure it reported.
   *
   * These files are written for the Node-side fits and are deliberately **not**
   * loaded by the browser: the derived artefacts in `priors.json` are two
   * orders of magnitude smaller than the raw weeks they come from.
   */
  const seasonFiles: Array<{ season: number; weeks: number; players: number; pairs: number }> = [];
  await mkdir(HISTORY_OUT, { recursive: true });

  for (const year of HISTORY_SEASONS) {
    const payload = await espnFetch<{ players: PlayerEnvelope[] }>(
      historySeasonUrl(year),
      creds,
      {
        filter: {
          players: {
            limit: 2000,
            sortPercOwned: { sortAsc: false, sortPriority: 1 },
          },
        },
      },
    ).catch((err: unknown) => {
      log(`  ${year}: unavailable (${err instanceof Error ? err.message : String(err)})`);
      return null;
    });
    if (!payload) continue;

    const sides = priorGameSidesBySeason.get(year) ?? new Map();
    /** pid -> week -> line. */
    const actuals: Record<string, Record<string, Record<string, number>>> = {};
    const projections: Record<string, Record<string, Record<string, number>>> = {};
    const games: Record<string, Record<string, { team: string; opp: string }>> = {};
    /** pid -> that season's position group, which can differ from today's. */
    const positions: Record<string, number> = {};
    const seasonTotals: Record<string, Record<string, number>> = {};
    let weekCount = 0;
    let pairCount = 0;

    for (const { player } of payload.players ?? []) {
      const pid = String(player.id);
      const byWeekActual: Record<string, Record<string, number>> = {};
      const byWeekProjection: Record<string, Record<string, number>> = {};
      const byWeekGame: Record<string, { team: string; opp: string }> = {};

      for (const block of player.stats ?? []) {
        if (block.seasonId !== year) continue;

        if (block.statSplitTypeId === 0) {
          if (block.statSourceId !== 0) continue;
          const line = compact(normalizeStatLine(block.stats));
          if (Object.keys(line).length > 0) seasonTotals[pid] = line;
          continue;
        }
        if (block.statSplitTypeId !== 1) continue;

        const week = String(block.scoringPeriodId);
        const line = compact(normalizeStatLine(block.stats));

        if (block.statSourceId === 0) {
          /*
           * An empty line is not missing data. ESPN writes a game-log entry for
           * every week a player was rostered, so an empty one says the game
           * happened and he did not record a stat. That zero is most of what a
           * floor is, and dropping it would fit every spread over only the
           * weeks the player showed up.
           */
          byWeekActual[week] = line;
          weekCount++;

          const side = sides.get(Number(block.externalId));
          const own = block.proTeamId ?? 0;
          if (side && own > 0) {
            const oppId = side.home === own ? side.away : side.home;
            const team = PRO_TEAMS[own];
            const opp = PRO_TEAMS[oppId];
            if (team && opp) byWeekGame[week] = { team, opp };
          }
        } else if (block.statSourceId === 1) {
          if (Object.keys(line).length > 0) byWeekProjection[week] = line;
        }
      }

      if (Object.keys(byWeekActual).length === 0) continue;
      actuals[pid] = byWeekActual;
      if (Object.keys(byWeekProjection).length > 0) projections[pid] = byWeekProjection;
      if (Object.keys(byWeekGame).length > 0) games[pid] = byWeekGame;
      if (typeof (player as any).defaultPositionId === 'number') {
        positions[pid] = (player as any).defaultPositionId;
      }
      for (const week of Object.keys(byWeekProjection)) {
        if (week in byWeekActual) pairCount++;
      }
    }

    /*
     * No `generatedAt` here, unlike every file under `public/data`.
     *
     * A finished season does not change, so stamping it would make an identical
     * pull produce a different file every time — and `restamp-fits.ts` hashes
     * these to decide whether a fitted model can be carried onto a fresh
     * snapshot. A stamp that moved on every pull would answer "the inputs
     * changed" every Sunday, when nothing had, and force a pointless refit.
     */
    const text = JSON.stringify({
      season: year,
      actuals,
      projections,
      games,
      positions,
      seasonTotals,
    });
    await writeFile(join(HISTORY_OUT, `${year}.json`), text);
    seasonFiles.push({
      season: year,
      weeks: weekCount,
      players: Object.keys(actuals).length,
      pairs: pairCount,
    });
    log(
      `  ${year}: ${Object.keys(actuals).length} players, ${weekCount} logged weeks, ` +
        `${pairCount} projection pairs (${(text.length / 1024).toFixed(0)}KB)`,
    );
  }

  // --- Draft ---------------------------------------------------------------
  const draft = (raw.draftDetail?.picks ?? []).map((p: any) => ({
    pickNumber: p.overallPickNumber,
    round: p.roundId,
    roundPick: p.roundPickNumber,
    teamId: p.teamId,
    playerId: String(p.playerId),
    bidAmount: p.bidAmount ?? 0,
    keeper: Boolean(p.keeper),
    autoDraft: Boolean(p.autoDraftTypeId),
  }));

  const transactions = (raw.transactions ?? []).map((t: any) => ({
    id: t.id,
    type: t.type,
    status: t.status,
    teamId: t.teamId,
    date: t.proposedDate ?? 0,
    scoringPeriodId: t.scoringPeriodId ?? 0,
    bidAmount: t.bidAmount ?? 0,
    items: (t.items ?? []).map((i: any) => ({
      playerId: String(i.playerId),
      type: i.type,
      fromTeamId: i.fromTeamId ?? 0,
      toTeamId: i.toTeamId ?? 0,
    })),
  }));

  // --- Write ---------------------------------------------------------------
  const write = async (name: string, value: unknown) => {
    const path = join(OUT, name);
    const text = JSON.stringify(value);
    await writeFile(path, text);
    log(`  wrote ${name} (${(text.length / 1024).toFixed(0)}KB)`);
  };

  await write('league.json', {
    generatedAt,
    season: String(SEASON),
    league,
    members,
    teams,
    schedule,
    draft,
    transactions,
    proSchedule,
    byeWeeks: Object.fromEntries([...byeWeeks].map(([k, v]) => [String(k), v])),
  });

  await write('players.json', {
    generatedAt,
    players,
    seasonProjection,
    seasonActualPrior,
    seasonProjectionPrior,
    appliedTotals,
    priorSeason: String(HISTORY_SEASON),
  });

  // Weeks are written one file per week rather than as a single payload. The
  // whole season is ~17x the size of any one week, and the pages that need all
  // of it (Analytics, History) are code-split anyway — so the common case, a
  // reader checking this week's lineup, fetches one file instead of seventeen.
  await mkdir(join(OUT, 'weeks'), { recursive: true });
  let weekBytes = 0;
  for (const [week, payload] of Object.entries(weeks)) {
    const text = JSON.stringify({ generatedAt, week: Number(week), ...payload });
    weekBytes += text.length;
    await writeFile(join(OUT, 'weeks', `${week}.json`), text);
  }
  log(`  wrote weeks/1-${league.finalWeek}.json (${(weekBytes / 1024).toFixed(0)}KB total)`);
  await write('history.json', {
    generatedAt,
    season: String(HISTORY_SEASON),
    logs: history,
    applied: historyApplied,
    games: historyGames,
  });

  await write('index.json', {
    generatedAt,
    season: String(SEASON),
    priorSeason: String(HISTORY_SEASON),
    /** Finished seasons written under `seasons/`, newest first. */
    historySeasons: seasonFiles.map((f) => f.season),
    leagueName: league.name,
    currentWeek: league.currentWeek,
    latestCompletedWeek: completedWeek,
    finalWeek: league.finalWeek,
    weeks: Object.keys(weeks).map(Number).sort((a, b) => a - b),
  });

  log('done');
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
