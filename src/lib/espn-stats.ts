/**
 * ESPN stat id -> stable stat key.
 *
 * ESPN's fantasy API reports every stat line as a map of numeric ids to values
 * (`{"3": 3668, "4": 25}`) and never tells you what those ids mean. Nothing in
 * the API is self-describing, so this table is the boundary between ESPN's
 * numbering and the readable keys the rest of the app uses.
 *
 * Every id below that carries points in this league was **derived from real
 * data rather than copied from a community table**.
 *
 * A warning about how, because the obvious method does not work. Reconciling
 * against the `appliedTotal` ESPN computes server-side proves the scoring is
 * right, and proves nothing at all about the names: `npm run verify` keys both
 * the settings and the stat line through *this* table, so any consistent
 * permutation of it cancels out and still reports 100%. Four D/ST ids were
 * wrong for exactly that reason and the check never blinked.
 *
 * An id is only pinned down by evidence from **outside** the scoring identity —
 * the observed frequency and range of the stat, or arithmetic against another
 * reported field. `npm run verify:stat-ids` is that check.
 *
 * The kicking block is the one worth spelling out, because the obvious reading
 * is wrong. The three distance buckets are ordered **longest first**:
 *
 *   Brandon Aubrey, 2025 — id 74 = 11 made / id 75 = 17 att / id 76 = 6 missed
 *                          id 77 = 10 made / id 78 = 10 att / id 79 = 0 missed
 *                          id 80 = 15 made / id 81 = 15 att / id 82 = 0 missed
 *
 * Read 74 as 0-39 and you have a kicker who missed six chip shots and went a
 * perfect 15-for-15 from 50+. Read it as 50+ and you have Aubrey. The finer
 * 50-59 (198-200) and 60+ (201-203) splits confirm it independently: they sum
 * to exactly the 74/75/76 totals (8+3 = 11 made, 13+4 = 17 attempted).
 */

/** Stat keys this league actually scores, plus the usage keys the app reads. */
export const STAT_IDS: Record<number, string> = {
  // ---- Passing -------------------------------------------------------------
  0: 'pass_att',
  1: 'pass_cmp',
  2: 'pass_inc',
  3: 'pass_yd',
  4: 'pass_td',
  19: 'pass_2pt',
  20: 'pass_int',
  21: 'pass_cmp_pct',
  22: 'pass_yd_per_game',

  // ---- Rushing -------------------------------------------------------------
  23: 'rush_att',
  24: 'rush_yd',
  25: 'rush_td',
  26: 'rush_2pt',
  39: 'rush_ypc',
  40: 'rush_yd_per_game',

  // ---- Receiving -----------------------------------------------------------
  41: 'rec_alt',
  42: 'rec_yd',
  43: 'rec_td',
  44: 'rec_2pt',
  53: 'rec',
  58: 'rec_tgt',
  60: 'rec_ypr',
  61: 'rec_yd_per_game',

  // ---- Misc offence --------------------------------------------------------
  63: 'fum_rec_td',
  72: 'fum_lost',
  73: 'fum',

  // ---- Kicking. Buckets run longest-first; see the header note. -------------
  74: 'fgm_50p',
  75: 'fga_50p',
  76: 'fgmiss_50p',
  77: 'fgm_40_49',
  78: 'fga_40_49',
  79: 'fgmiss_40_49',
  80: 'fgm_0_39',
  81: 'fga_0_39',
  82: 'fgmiss_0_39',
  83: 'fgm',
  84: 'fga',
  85: 'fgmiss',
  86: 'xpm',
  87: 'xpa',
  88: 'xpmiss',
  198: 'fgm_50_59',
  199: 'fga_50_59',
  200: 'fgmiss_50_59',
  201: 'fgm_60p',
  202: 'fga_60p',
  203: 'fgmiss_60p',

  // ---- Team defence / special teams ---------------------------------------
  /*
   * These were the one block in this table assigned by assumption rather than
   * by measurement — "the ladders must be ESPN's defaults, so the id carrying
   * -1 must be the bucket the defaults put at -1" — and four of them were
   * wrong. The circularity is the lesson: reasoning from the scoring identity
   * can only ever recover the assumption you started with, and `npm run verify`
   * cannot catch it either, because both sides of its multiply are keyed
   * through this same table and any consistent permutation cancels out.
   *
   * They are now identified the way the kicking block was — against data that
   * could refute them. Over 544 D/ST game logs from 2025:
   *
   *   id 99   2.36 per game, present in 87% of games   -> sacks
   *   id 95   0.70 per game, present in 50%            -> interceptions
   *   id 96   0.45 per game, present in 36%            -> fumble recoveries
   *   id 97   0.08 per game, present in 8%             -> blocked kicks
   *   id 98   0.02 per game, 12 all season             -> safeties
   *
   * The points-allowed ladder was shifted a whole bucket. Reconstructing what
   * each defence actually gave up from the opposing offence's own stat lines,
   * the games flagged 123 have a median of 31 points against, 124 runs 35-45,
   * and 125 runs 47-52. `npm run verify:stat-ids` re-runs both checks.
   *
   * The yards-allowed ladder beside them was already right, and cross-checks
   * against `def_yds_allowed` on the same line in 544 of 544 games.
   */
  89: 'def_pa_0',
  90: 'def_pa_1_6',
  91: 'def_pa_7_13',
  92: 'def_pa_14_17',
  93: 'def_blk_kick_td',
  95: 'def_int',
  96: 'def_fum_rec',
  97: 'def_blk_kick',
  98: 'def_safe',
  99: 'def_sack',
  101: 'def_int_td',
  102: 'def_fum_ret_td',
  103: 'def_blk_kick_ret_td',
  104: 'def_st_td',
  105: 'def_td',
  106: 'def_turnover',
  123: 'def_pa_28_34',
  124: 'def_pa_35_45',
  125: 'def_pa_46p',
  127: 'def_yds_allowed',
  128: 'def_ya_0_99',
  129: 'def_ya_100_199',
  130: 'def_ya_200_299',
  131: 'def_ya_300_349',
  132: 'def_ya_350_399',
  133: 'def_ya_400_449',
  134: 'def_ya_450_499',
  135: 'def_ya_500_549',
  136: 'def_ya_550p',
  206: 'def_2pt_ret',
  // By elimination: this league scores exactly two D/ST items at one point,
  // and id 99 is the sack. It has never once appeared in the data, which is
  // what a one-point safety looks like.
  209: 'def_safe_1pt',

  // ---- Context -------------------------------------------------------------
  210: 'gp',
};

/**
 * Ids ESPN reports that are deliberately left unnamed.
 *
 * Each was a plausible guess that did not survive checking, and a wrong label
 * on a player sheet is worse than no label:
 *
 *   155, 156  Sum to a player's games played, so "wins and losses" is the
 *             obvious reading — except teammates disagree. Fifteen Lions
 *             carry nine different pairs, so whatever they split, it is not
 *             the team's record.
 *   158       Read as snaps it makes a kicker (155) busier than a receiver
 *             (66) and gives a quarterback 234 in a season of roughly 1,100.
 *   59, 212,  No arithmetic against any other reported field reproduces them.
 *   213
 *
 * They fall through `normalizeStatLine` under their numeric key, so they are
 * still present, still inspectable, and impossible to mistake for a fact.
 */
export const UNNAMED_IDS = [59, 94, 100, 126, 155, 156, 158, 212, 213] as const;

/** Reverse lookup, built once. */
export const STAT_KEY_TO_ID: Record<string, number> = Object.fromEntries(
  Object.entries(STAT_IDS).map(([id, key]) => [key, Number(id)]),
);

/**
 * Human labels for the keys the player sheet shows.
 *
 * Only keys worth printing appear here; anything missing falls back to its raw
 * key, which is honest about the ones ESPN never explains.
 */
export const STAT_LABELS: Record<string, string> = {
  pass_att: 'Pass attempts',
  pass_cmp: 'Completions',
  pass_yd: 'Passing yards',
  pass_td: 'Passing TD',
  pass_int: 'Interceptions',
  pass_2pt: 'Passing 2PT',
  rush_att: 'Carries',
  rush_yd: 'Rushing yards',
  rush_td: 'Rushing TD',
  rush_2pt: 'Rushing 2PT',
  rec: 'Receptions',
  rec_tgt: 'Targets',
  rec_yd: 'Receiving yards',
  rec_td: 'Receiving TD',
  rec_2pt: 'Receiving 2PT',
  fum_lost: 'Fumbles lost',
  fum_rec_td: 'Fumble recovery TD',
  fgm_0_39: 'FG made 0-39',
  fgm_40_49: 'FG made 40-49',
  fgm_50_59: 'FG made 50-59',
  fgm_60p: 'FG made 60+',
  fgm_50p: 'FG made 50+',
  fgmiss: 'FG missed',
  xpm: 'Extra points',
  fga: 'FG attempts',
  def_sack: 'Sacks',
  def_int: 'Interceptions',
  def_fum_rec: 'Fumble recoveries',
  def_safe: 'Safeties',
  def_safe_1pt: 'One-point safeties',
  def_blk_kick: 'Blocked kicks',
  def_int_td: 'Interception TD',
  def_fum_ret_td: 'Fumble return TD',
  def_blk_kick_td: 'Blocked kick TD',
  def_blk_kick_ret_td: 'Blocked kick return TD',
  def_st_td: 'Special teams TD',
  def_pa_0: 'Shutouts',
  def_pa_1_6: 'Held to 1-6',
  def_pa_7_13: 'Held to 7-13',
  def_pa_14_17: 'Held to 14-17',
  def_pa_28_34: 'Allowed 28-34',
  def_pa_35_45: 'Allowed 35-45',
  def_pa_46p: 'Allowed 46+',
  def_ya_100_199: 'Allowed 100-199 yds',
  def_ya_200_299: 'Allowed 200-299 yds',
  def_ya_350_399: 'Allowed 350-399 yds',
  gp: 'Games played',
};

/** Translates an ESPN `{statId: value}` map into keyed form. */
export function normalizeStatLine(
  raw: Record<string, number> | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;

  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    // Ids outside the table are kept under their raw number so nothing is
    // silently dropped: scoring reads by key, and an unmapped scoring id would
    // then fail `verify` loudly rather than quietly scoring zero.
    out[STAT_IDS[Number(id)] ?? id] = value;
  }

  return out;
}
