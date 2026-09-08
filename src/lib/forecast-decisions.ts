import { mixtureCdf, type PlayerForecast, type ResidualModel } from './forecast';
import { sampleTeamTotals } from './simulate';

/** Strictly over the target; a DNP at zero does not clear a zero-point target. */
export function probabilityAbove(
  model: ResidualModel,
  forecast: PlayerForecast,
  target: number,
): number | null {
  if (!Number.isFinite(target)) return null;
  const fit = model.byGroup.get(forecast.group);
  if (!fit) return null;
  if (forecast.actual !== null) return forecast.actual > target ? 1 : 0;
  return (
    1 -
    mixtureCdf(
      fit,
      forecast.projection,
      forecast.playProb,
      target,
      forecast.biasShift + forecast.matchupShift,
    )
  );
}

export interface PlayerComparison {
  aWins: number;
  bWins: number;
  ties: number;
  iterations: number;
}

/** Both players share each simulated NFL-team shock, including across fantasy rosters. */
export function compareForecasts(
  model: ResidualModel,
  a: PlayerForecast,
  b: PlayerForecast,
  iterations = 20000,
): PlayerComparison {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100000) {
    throw new Error('Player comparison requires between 1 and 100,000 simulations');
  }
  if (a.pid === b.pid) return { aWins: 0, bWins: 0, ties: 1, iterations };
  const [scoresA, scoresB] = sampleTeamTotals(
    [
      { teamId: 0, starters: [a] },
      { teamId: 1, starters: [b] },
    ],
    model,
    iterations,
    0xdec1510,
  );
  let aWins = 0;
  let bWins = 0;
  for (let i = 0; i < iterations; i++) {
    // Fantasy scores settle to hundredths; sub-cent differences are ties.
    const difference = Math.round(scoresA[i] * 100) - Math.round(scoresB[i] * 100);
    if (difference > 0) aWins++;
    else if (difference < 0) bWins++;
  }
  return {
    aWins: aWins / iterations,
    bWins: bWins / iterations,
    ties: (iterations - aWins - bWins) / iterations,
    iterations,
  };
}
