/**
 * The scoring engine.
 *
 * Every number in this app — projections, actuals, value scores, matchup
 * ratings, optimal lineups — traces back to `scoreStatLine`. ESPN publishes a
 * precomputed `appliedTotal` alongside most stat lines, and we deliberately do
 * not use it as the app's source of truth: it exists only on the blocks ESPN
 * chooses to return, is absent from bulk player payloads, and carries no
 * per-category breakdown to explain a number with. Recomputing from the
 * league's own 46 scoring items gives all three.
 *
 * It also gives a free correctness check. Where ESPN does publish a total, ours
 * must equal it to the cent — `npm run verify` asserts exactly that across
 * every player and every game log the league can see.
 */

import type { PositionGroup, ScoringSettings, StatLine } from './types';

/**
 * Compiled form of a league's scoring settings.
 *
 * Compiling once and reusing matters: a season is ~1,000 players x 17 weeks,
 * and walking `Object.entries` per call was the hottest path in the app this
 * one is modelled on.
 */
export interface ScoringModel {
  keys: string[];
  multipliers: number[];
  /** Per-group compiled variants, for groups that override the base table. */
  byGroup: Partial<Record<PositionGroup, { keys: string[]; multipliers: number[] }>>;
  raw: ScoringSettings;
  overrides: Partial<Record<PositionGroup, ScoringSettings>>;
}

function compileTable(settings: ScoringSettings): { keys: string[]; multipliers: number[] } {
  const keys: string[] = [];
  const multipliers: number[] = [];

  for (const [key, mult] of Object.entries(settings)) {
    // A zero-weighted key can never move the total, so it is dropped here
    // rather than multiplied by zero a million times. This league declares 46
    // scoring items and about half are zero outside D/ST.
    if (typeof mult === 'number' && mult !== 0 && Number.isFinite(mult)) {
      keys.push(key);
      multipliers.push(mult);
    }
  }

  return { keys, multipliers };
}

/** Compiles league scoring settings, including any per-position overrides. */
export function compileScoring(
  settings: ScoringSettings | undefined | null,
  overrides: Partial<Record<PositionGroup, ScoringSettings>> = {},
): ScoringModel {
  const base = compileTable(settings ?? {});
  const byGroup: ScoringModel['byGroup'] = {};

  for (const [group, table] of Object.entries(overrides)) {
    if (!table) continue;
    // An override is a full replacement for the keys it names, layered over the
    // base table — ESPN expresses D/ST scoring as "these ids mean something
    // different in slot 16" rather than as a separate settings block.
    byGroup[group as PositionGroup] = compileTable({ ...(settings ?? {}), ...table });
  }

  return { ...base, byGroup, raw: settings ?? {}, overrides };
}

/**
 * Scores one raw stat line.
 *
 * Rounded to 2dp to match ESPN's own display rounding, which is what keeps
 * per-player numbers summing to the team total ESPN reports.
 */
export function scoreStatLine(
  model: ScoringModel,
  stats: StatLine | undefined | null,
  group?: PositionGroup | null,
): number {
  if (!stats) return 0;

  const table = (group && model.byGroup[group]) || model;
  const { keys, multipliers } = table;

  let total = 0;
  for (let i = 0; i < keys.length; i++) {
    const v = stats[keys[i]];
    if (typeof v === 'number' && Number.isFinite(v)) total += v * multipliers[i];
  }

  return Math.round((total + Number.EPSILON) * 100) / 100;
}

/**
 * Memoising wrapper around `scoreStatLine`.
 *
 * Stat line objects are stable for the lifetime of a load, so a WeakMap keyed
 * on object identity deduplicates for free with no invalidation logic. The
 * cache is per-group because the same D/ST line scores differently under the
 * base table than under the override.
 */
export function createScorer(model: ScoringModel) {
  const caches = new Map<string, WeakMap<object, number>>();

  return function score(
    stats: StatLine | undefined | null,
    group?: PositionGroup | null,
  ): number {
    if (!stats) return 0;

    const bucket = group ?? '_';
    let cache = caches.get(bucket);
    if (!cache) {
      cache = new WeakMap();
      caches.set(bucket, cache);
    }

    const cached = cache.get(stats);
    if (cached !== undefined) return cached;

    const value = scoreStatLine(model, stats, group);
    cache.set(stats, value);
    return value;
  };
}

export type Scorer = ReturnType<typeof createScorer>;

/**
 * Stat keys that show a player actually took the field.
 *
 * A player can appear in a week's payload carrying only contextual fields, so
 * presence in the map is not enough. D/ST is included through its own keys: a
 * defence that forced nothing still played, which is why the points-allowed
 * ladder counts as participation.
 */
const PARTICIPATION_KEYS = [
  'gp',
  'snaps',
  'pass_att',
  'rush_att',
  'rec_tgt',
  'rec',
  'fga',
  'xpa',
  'def_yds_allowed',
  'def_sack',
  'def_pa_0',
  'def_pa_1_6',
  'def_pa_7_13',
  'def_pa_14_17',
  'def_pa_28_34',
  'def_pa_35_45',
  'def_pa_46p',
] as const;

/** True when the stat line shows real participation, not just a stub. */
export function hasPlayed(stats: StatLine | undefined | null): boolean {
  if (!stats) return false;
  for (const key of PARTICIPATION_KEYS) {
    const v = stats[key];
    if (typeof v === 'number' && v > 0) return true;
  }
  return false;
}

/**
 * True when a projection carries a usable forecast.
 *
 * ESPN emits a projection block for every player in the universe, including
 * ones with no expectation of playing. Treating those as a real 0.0 projection
 * would flag every inactive player as a boom, so at least one non-zero
 * projected stat is required.
 */
export function hasValidProjection(stats: StatLine | undefined | null): boolean {
  if (!stats) return false;
  for (const key in stats) {
    const v = stats[key];
    if (typeof v === 'number' && v > 0) return true;
  }
  return false;
}

/**
 * Opportunity volume for a player-week — a position-aware usage proxy.
 *
 * Volume is the most stable predictor of future scoring, so this feeds the
 * Value Score. Returns null where the idea doesn't apply, which callers treat
 * as neutral rather than as a zero.
 */
export function opportunities(group: PositionGroup, stats: StatLine): number | null {
  const n = (key: string): number => {
    const v = stats[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };

  // Projections report receptions where game logs report both; targets are the
  // better measure of role, so they are preferred when present.
  const receivingVolume = (): number => (n('rec_tgt') > 0 ? n('rec_tgt') : n('rec'));

  switch (group) {
    case 'QB':
      return n('pass_att') + n('rush_att');
    case 'RB':
      return n('rush_att') + receivingVolume();
    case 'WR':
    case 'TE':
      return receivingVolume();
    case 'K':
      return n('fga') + n('xpa');
    case 'DST': {
      // A defence's "volume" is the chances it gets to make a play. Sacks,
      // takeaways and tackles for loss are the events this league pays for.
      const events =
        n('def_sack') + n('def_int') + n('def_fum_rec') + n('def_blk_kick');
      return events > 0 ? events : null;
    }
    default:
      return null;
  }
}

/**
 * Efficiency proxy: points produced per opportunity.
 *
 * Position-aware so a kicker's per-attempt rate is never compared against a
 * receiver's per-target rate. Null below a floor of volume, where the ratio is
 * noise rather than a rate.
 */
export function efficiency(
  group: PositionGroup,
  stats: StatLine,
  scored: number,
): number | null {
  const opps = opportunities(group, stats);
  if (opps === null || opps < 2) return null;
  return scored / opps;
}
