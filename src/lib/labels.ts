/** Compact display label for lineup slots. */
export function fmtSlot(slot: string): string {
  return slot.toUpperCase() === 'SUPER_FLEX' ? 'SF' : slot.replace(/_/g, ' ');
}
