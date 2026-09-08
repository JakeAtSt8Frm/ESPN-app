import type { League } from './types';

/** Compact display label for lineup slots. */
export function fmtSlot(slot: string): string {
  return slot.toUpperCase() === 'SUPER_FLEX' ? 'SF' : slot.replace(/_/g, ' ');
}

/** Describe the loaded scoring table, including reception overrides by position. */
export function fmtLeagueFormat(league: Pick<League, 'size' | 'scoringSettings' | 'scoringOverrides'>): string {
  const receptions = league.scoringSettings.rec ?? 0;
  const customReceptions = Object.values(league.scoringOverrides).some(
    (settings) => settings.rec !== undefined && settings.rec !== receptions,
  );
  const scoring = customReceptions ? 'Custom reception scoring'
    : receptions === 0.5 ? 'Half PPR'
      : receptions === 1 ? 'Full PPR'
        : receptions === 0 ? 'Non-PPR' : `${receptions} points per reception`;
  return `${league.size} teams · ${scoring}`;
}
