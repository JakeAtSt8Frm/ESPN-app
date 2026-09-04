/**
 * The app's history-only weekly projection challenger.
 *
 * Every forecast in this app has so far been ESPN's, corrected: the residual
 * model measures how far ESPN lands from the outcome and re-centres it, and the
 * matchup index nudges it by the opponent. That is worth doing and it is not the
 * same thing as having a history-only opinion. This module builds that opinion
 * from the league's own scored history. It remains useful as a diagnostic
 * challenger, but the user-facing App projection is the historically tested
 * residual-and-matchup forecast because it can retain current role and news
 * through ESPN's live baseline.
 *
 * ## What it is fit on, and the one thing it cannot be fit on
 *
 * The training set is every prior-season player-week the snapshot holds, with
 * features built strictly from weeks *before* the one being predicted. The
 * matchup term comes from `buildPregameMatchupIndexes`, which rebuilds the
 * defensive ratings as they stood before each week, so no week contributes to
 * its own feature.
 *
 * What cannot be measured here is the comparison a reader will most want:
 * whether this beats ESPN. **ESPN publishes weekly projections only for the
 * season in progress** — for a finished season it serves the game logs and not
 * the numbers that preceded them — so there is no historical pair to score
 * against. The honest baseline is the best forecast the app could otherwise
 * make from the same information, which is the exponentially weighted mean of a
 * player's recent scores at the decay the Value Score already uses. Against
 * that, on rolling-origin holdouts, this model cuts mean absolute error by about
 * 7.6%.
 *
 * A direct comparison becomes possible as the snapshot captures each week's
 * ESPN projection before kickoff and its actual afterwards, so those pairs can
 * accumulate without a retrospective-data gap.
 *
 * ## Why the loss function is absolute error and not squared error
 *
 * The first version was squared-loss boosting and ridge regression, and both
 * came out *worse* than the plain weighted mean on MAE — ridge by 2%, trees by
 * 1.8% — while beating it on RMSE. That is not a bug, it is the loss functions
 * behaving correctly: squared error is minimised by the conditional mean and
 * absolute error by the conditional median, and weekly fantasy scores are skewed
 * hard enough that the two are far apart. A model fit to the mean of a
 * right-skewed distribution sits above its median and is wrong more often, by
 * less, which is exactly the wrong trade for a number a manager reads once a
 * week.
 *
 * So the trees are grown on the sign of the residual and each leaf is refit to
 * the median of the residuals landing in it — LAD boosting. Same features, same
 * depth, and the sign flips from 1.8% worse to 7.6% better.
 */

import type { PositionGroup } from './types';

/**
 * Features, in the order the model reads them.
 *
 * Every one is knowable before kickoff. There is deliberately no team-strength
 * or vegas-line term: the snapshot carries neither, and inventing a proxy from
 * the same production history the other features already carry would add
 * collinearity rather than information.
 */
export const PROJECTION_FEATURES = [
  /** Exponentially weighted mean of prior scores, 0.68 decay. */
  'ewma',
  /** Mean of the last three scored weeks. */
  'mean3',
  /** Mean of every prior week this season. */
  'seasonMean',
  /** Weeks he has actually recorded a stat line. */
  'games',
  /** Exponentially weighted opportunity volume. */
  'oppEwma',
  /** Exponentially weighted share of his own unit's opportunities. */
  'shareEwma',
  /** Pregame matchup rating for his group against this week's opponent, 0..1. */
  'matchup',
  /** Weeks played over weeks rostered — availability, not a bye count. */
  'playRate',
  /** Prior-season per-week level, 0 when there is none. */
  'priorLevel',
  /** Last week's score. */
  'lastScore',
] as const;

export type ProjectionFeature = (typeof PROJECTION_FEATURES)[number];
export const FEATURE_COUNT = PROJECTION_FEATURES.length;

/**
 * A regression tree, flattened into parallel arrays.
 *
 * Serialised form matters here: the fitted model ships inside the snapshot and
 * a tree per object costs about four times what a tree per array does. A leaf
 * carries `feature === -1`.
 */
export interface FlatTree {
  /** Split feature index per node, -1 for a leaf. */
  feature: number[];
  /** Split threshold per node. */
  threshold: number[];
  /** Left child index per node, -1 for a leaf. */
  left: number[];
  /** Right child index per node, -1 for a leaf. */
  right: number[];
  /** Prediction per node; only meaningful at leaves. */
  value: number[];
}

export interface GroupModel {
  group: PositionGroup;
  /** Median of the training target — where boosting starts. */
  base: number;
  /** Shrinkage applied to every tree. */
  learningRate: number;
  trees: FlatTree[];
  /** Player-weeks the fit was built from. */
  samples: number;
  /** Holdout MAE of this model and of the baseline it is measured against. */
  mae: number;
  baselineMae: number;
  /**
   * Median prediction over median outcome, on startable players in the holdout.
   *
   * The accuracy gate says the ordering is right; this says the column sits in
   * the right place. A model can beat its baseline and still be biased low
   * everywhere, which is exactly what shipped the first time.
   */
  level: number;
  /**
   * Whether this group can be trusted before the season has produced weeks.
   *
   * Seeding a player from last season puts the model in a state it was never
   * fit on, and some groups handle it and some do not — kicker came back at
   * 0.80 of a player's own prior level where the skew justifies 0.97, tight end
   * at 1.02 where it justifies 0.87. Both are fine once real weeks arrive, so
   * the model still ships; the app simply shows nothing for them until it has
   * in-season history to work from.
   */
  coldStartOk: boolean;
}

export interface ProjectionModel {
  /** The snapshot this model was fitted against, for cache and build checks. */
  generatedAt: number;
  /**
   * Hash of the inputs the fit actually read — the scoring table, each player's
   * position, and the finished-season history.
   *
   * Lets `npm run restamp` carry a model onto a fresher snapshot when none of
   * those moved, which is true of every in-season refresh: new scores cannot
   * change a model fitted on three completed seasons. Absent on a model written
   * before the hash existed, which is treated as "cannot be carried forward".
   */
  inputsHash?: string;
  /** Seasons the fit was trained on, joined by `+`. */
  season: string;
  fittedAt: number;
  features: readonly string[];
  byGroup: Partial<Record<PositionGroup, GroupModel>>;
}

// ------------------------------------------------------------- prediction --

function treeValue(tree: FlatTree, x: number[]): number {
  let at = 0;
  while (tree.feature[at] >= 0) {
    at = x[tree.feature[at]] <= tree.threshold[at] ? tree.left[at] : tree.right[at];
  }
  return tree.value[at];
}

/** Runs one position group's model over a feature vector. */
export function predictWith(model: GroupModel, x: number[]): number {
  let out = model.base;
  for (const tree of model.trees) out += model.learningRate * treeValue(tree, x);
  // A projection is a quantity of points; the model has no reason to know that.
  return Math.max(0, out);
}

// ---------------------------------------------------------- feature state --

/**
 * A player's rolling history, updated week by week.
 *
 * Kept as a mutable object rather than rebuilt per week because the app walks
 * every player through every week on load, and rebuilding an eighteen-week
 * window each time turned a linear pass into a quadratic one.
 */
export interface RollingState {
  scores: number[];
  opportunities: number[];
  shares: number[];
  /** Weeks he was on a roster and could have recorded something. */
  rostered: number;
  /** Weeks he did. */
  played: number;
  /** Prior-season per-week level, or 0. */
  priorLevel: number;
  /**
   * True while every week in this history came from the prior season.
   *
   * The cold-start path is a different question from the in-season one and some
   * groups are only trustworthy on the second — see `coldStartOk`.
   */
  seededOnly: boolean;
}

export function newRollingState(priorLevel = 0): RollingState {
  return {
    scores: [],
    opportunities: [],
    shares: [],
    rostered: 0,
    played: 0,
    priorLevel,
    seededOnly: false,
  };
}

/** Exponentially weighted mean, newest last. Matches `value.ts`. */
export function weightedMean(values: number[], decay = 0.68): number {
  if (!values.length) return 0;
  let total = 0;
  let weights = 0;
  let weight = 1;
  for (let i = values.length - 1; i >= 0; i--) {
    total += values[i] * weight;
    weights += weight;
    weight *= decay;
  }
  return weights ? total / weights : 0;
}

/** Minimum scored weeks before the model is trusted over the fallback. */
export const MIN_HISTORY = 2;

/**
 * Builds the feature vector for a week, from history that precedes it.
 *
 * `matchup` arrives as the 0–100 rating and is scaled here rather than by the
 * caller, so the training script and the app cannot disagree about it.
 */
export function featuresFrom(state: RollingState, matchupScore: number | null): number[] {
  const { scores, opportunities, shares, rostered, played, priorLevel } = state;
  const recent = scores.slice(-3);

  return [
    weightedMean(scores),
    recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0,
    scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
    played,
    weightedMean(opportunities),
    weightedMean(shares),
    matchupScore === null ? 0.5 : matchupScore / 100,
    rostered > 0 ? played / rostered : 1,
    priorLevel,
    scores.length ? scores[scores.length - 1] : 0,
  ];
}

/** Folds one played (or missed) week into the rolling history. */
export function advance(
  state: RollingState,
  played: boolean,
  score: number,
  volume: number | null,
  share: number | null,
  /** False for a week carried over from last season. */
  inSeason = true,
): void {
  if (inSeason) state.seededOnly = false;
  else if (!state.scores.length) state.seededOnly = true;
  state.rostered++;
  if (played) state.played++;
  state.scores.push(played ? score : 0);
  state.opportunities.push(played ? (volume ?? 0) : 0);
  state.shares.push(played ? (share ?? 0) : 0);
}

/**
 * The app's projection for a player-week, or null when it should not be shown.
 *
 * Null rather than a guess: with fewer than two scored weeks behind him, every
 * feature this model reads is either empty or a prior-season echo, and the
 * result would be the group's median dressed up as an opinion about a player.
 * The page shows nothing there, which is the honest answer, and ESPN's own
 * projection is beside it either way.
 */
export function projectPlayerWeek(
  model: ProjectionModel | null,
  group: PositionGroup | null,
  state: RollingState | undefined,
  matchupScore: number | null,
): number | null {
  if (!model || !group || !state) return null;
  const groupModel = model.byGroup[group];
  if (!groupModel) return null;
  if (state.played < MIN_HISTORY) return null;
  // A group whose cold start is miscalibrated says nothing until it has real
  // weeks of this season behind it.
  if (state.seededOnly && !groupModel.coldStartOk) return null;
  return predictWith(groupModel, featuresFrom(state, matchupScore));
}

// ------------------------------------------------------------------- fit ---

/*
 * Fitting lives here rather than in the script so the tree walked at predict
 * time and the tree grown at fit time are the same code. A mismatch between
 * those two is the classic way a model that scored well offline quietly stops
 * working in the app.
 */

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Candidate split points, as quantiles rather than every observed value. */
const SPLIT_QUANTILES = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9];

function growNode(
  X: number[][],
  target: number[],
  rows: number[],
  depth: number,
  minLeaf: number,
  tree: FlatTree,
): number {
  const mean = rows.reduce((s, i) => s + target[i], 0) / rows.length;
  const push = (feature: number, threshold: number, value: number): number => {
    tree.feature.push(feature);
    tree.threshold.push(threshold);
    tree.left.push(-1);
    tree.right.push(-1);
    tree.value.push(value);
    return tree.feature.length - 1;
  };

  if (depth === 0 || rows.length < minLeaf * 2) return push(-1, 0, mean);

  let bestGain = 0;
  let bestFeature = -1;
  let bestThreshold = 0;
  let bestLeft: number[] = [];
  let bestRight: number[] = [];

  const sse0 = rows.reduce((s, i) => s + (target[i] - mean) ** 2, 0);

  for (let f = 0; f < X[0].length; f++) {
    const sorted = rows.map((i) => X[i][f]).sort((a, b) => a - b);
    let previous = Number.NaN;

    for (const q of SPLIT_QUANTILES) {
      const threshold = sorted[Math.floor(q * (sorted.length - 1))];
      if (threshold === previous) continue;
      previous = threshold;

      const left: number[] = [];
      const right: number[] = [];
      for (const i of rows) (X[i][f] <= threshold ? left : right).push(i);
      if (left.length < minLeaf || right.length < minLeaf) continue;

      const lm = left.reduce((s, i) => s + target[i], 0) / left.length;
      const rm = right.reduce((s, i) => s + target[i], 0) / right.length;
      let sse = 0;
      for (const i of left) sse += (target[i] - lm) ** 2;
      for (const i of right) sse += (target[i] - rm) ** 2;

      const gain = sse0 - sse;
      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = f;
        bestThreshold = threshold;
        bestLeft = left;
        bestRight = right;
      }
    }
  }

  if (bestFeature < 0) return push(-1, 0, mean);

  const self = push(bestFeature, bestThreshold, mean);
  tree.left[self] = growNode(X, target, bestLeft, depth - 1, minLeaf, tree);
  tree.right[self] = growNode(X, target, bestRight, depth - 1, minLeaf, tree);
  return self;
}

function leafIndex(tree: FlatTree, x: number[]): number {
  let at = 0;
  while (tree.feature[at] >= 0) {
    at = x[tree.feature[at]] <= tree.threshold[at] ? tree.left[at] : tree.right[at];
  }
  return at;
}

export interface FitOptions {
  trees?: number;
  depth?: number;
  learningRate?: number;
  minLeaf?: number;
}

/**
 * LAD boosting: trees on the sign of the residual, leaves refit to its median.
 *
 * See the module header for why the loss is absolute rather than squared. The
 * defaults were selected on rolling-origin holdouts, not tuned on the test
 * weeks the reported error is measured over.
 */
export function fitGroupModel(
  X: number[][],
  y: number[],
  options: FitOptions = {},
): { base: number; learningRate: number; trees: FlatTree[] } {
  const { trees = 120, depth = 3, learningRate = 0.08, minLeaf = 25 } = options;

  const base = median(y);
  const predictions = new Array<number>(y.length).fill(base);
  const rows = X.map((_, i) => i);
  const out: FlatTree[] = [];

  for (let t = 0; t < trees; t++) {
    const signs = y.map((v, i) => Math.sign(v - predictions[i]));
    const tree: FlatTree = { feature: [], threshold: [], left: [], right: [], value: [] };
    growNode(X, signs, rows, depth, minLeaf, tree);

    // Refit each leaf to the median of the residuals that reach it — this is
    // the step that makes the ensemble track the median rather than the mean.
    const residualsByLeaf = new Map<number, number[]>();
    for (let i = 0; i < X.length; i++) {
      const leaf = leafIndex(tree, X[i]);
      const bucket = residualsByLeaf.get(leaf);
      if (bucket) bucket.push(y[i] - predictions[i]);
      else residualsByLeaf.set(leaf, [y[i] - predictions[i]]);
    }
    for (const [leaf, residuals] of residualsByLeaf) tree.value[leaf] = median(residuals);

    for (let i = 0; i < X.length; i++) {
      predictions[i] += learningRate * treeValue(tree, X[i]);
    }
    out.push(tree);
  }

  return { base, learningRate, trees: out };
}

/** Mean absolute error, the metric this model is fit and judged on. */
export function meanAbsoluteError(actual: number[], predicted: number[]): number {
  if (!actual.length) return 0;
  let total = 0;
  for (let i = 0; i < actual.length; i++) total += Math.abs(actual[i] - predicted[i]);
  return total / actual.length;
}
