import { POSITION_GROUPS, type League, type PositionGroup } from './types';

/** Bump when fitting or validation semantics change, even if the JSON shape does not. */
export const FORECAST_REPORT_VERSION = 2;

export interface ForecastReportRow {
  group: PositionGroup | 'ALL';
  samples: number;
  modelMae: number;
  espnMae: number;
  coverage80: number;
}

export interface ForecastReport {
  version: typeof FORECAST_REPORT_VERSION;
  scoringKey: string;
  folds: Array<{ training: number[]; testing: number }>;
  rows: ForecastReportRow[];
}

/** Stable across JSON key order, but changes with any scoring-rule change. */
export function forecastScoringKey(
  league: Pick<League, 'scoringSettings' | 'scoringOverrides'>,
): string {
  const sorted = (rules: Record<string, number>) =>
    Object.entries(rules).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    sorted(league.scoringSettings),
    Object.entries(league.scoringOverrides ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, rules]) => [group, sorted(rules)]),
  ]);
}

export function isForecastReport(value: unknown): value is ForecastReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Record<string, unknown>;
  if (
    report.version !== FORECAST_REPORT_VERSION ||
    typeof report.scoringKey !== 'string' ||
    !Array.isArray(report.folds) ||
    report.folds.length === 0 ||
    !Array.isArray(report.rows) ||
    report.rows.length === 0
  )
    return false;
  return (
    report.folds.every((fold: unknown) => {
      if (!fold || typeof fold !== 'object') return false;
      const f = fold as Record<string, unknown>;
      return (
        Number.isSafeInteger(f.testing) &&
        Array.isArray(f.training) &&
        f.training.length > 0 &&
        f.training.every(
          (year: unknown) =>
            typeof year === 'number' &&
            Number.isSafeInteger(year) &&
            typeof f.testing === 'number' &&
            year < f.testing,
        )
      );
    }) &&
    report.rows.every((row: unknown) => {
      if (!row || typeof row !== 'object') return false;
      const r = row as Record<string, unknown>;
      return (
        (r.group === 'ALL' || POSITION_GROUPS.some((group) => group === r.group)) &&
        typeof r.samples === 'number' &&
        Number.isSafeInteger(r.samples) &&
        r.samples > 0 &&
        [r.modelMae, r.espnMae, r.coverage80].every(
          (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0,
        ) &&
        typeof r.coverage80 === 'number' &&
        r.coverage80 <= 1
      );
    }) &&
    report.rows.some((row: ForecastReportRow) => row.group === 'ALL')
  );
}
