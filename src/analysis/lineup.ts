export interface LineupPlayer { id: string; name: string; positions: readonly string[]; points: number }
const FLEX: Readonly<Record<string, readonly string[]>> = {
  FLEX: ['RB', 'WR', 'TE'], WRRBTE_FLEX: ['RB', 'WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'], WRTE_FLEX: ['WR', 'TE'], WRRB_FLEX: ['WR', 'RB'], IDP_FLEX: ['DL', 'LB', 'DB'],
};
const BENCH = new Set(['BN', 'BENCH', 'IR', 'RESERVE', 'TAXI']);

export function eligibleForSlot(positions: readonly string[], slot: string): boolean {
  const normalized = slot.toUpperCase();
  return positions.some((position) => (FLEX[normalized] ?? [normalized]).includes(position.toUpperCase()));
}

/** Exact assignment across overlapping starter slots. A player can occupy only one slot. */
export function optimizeLineup(players: readonly LineupPlayer[], rosterSlots: readonly string[]) {
  const slots = rosterSlots.map((slot) => slot.toUpperCase()).filter((slot) => !BENCH.has(slot));
  if (slots.length > 12 || players.length > 60) throw new Error('Lineup optimization supports at most 12 starter slots and 60 players.');
  if (new Set(players.map((player) => player.id)).size !== players.length ||
    players.some((player) => !player.id || !Number.isFinite(player.points))) {
    throw new Error('Lineup players need unique IDs and finite point estimates.');
  }
  type State = { points: number; assignments: Array<{ slot: string; slotIndex: number; player: LineupPlayer }> };
  const states = new Map<number, State>([[0, { points: 0, assignments: [] }]]);
  for (const player of [...players].sort((a, b) => a.id.localeCompare(b.id))) {
    const previous = [...states];
    for (const [mask, state] of previous) {
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        if (mask & (1 << slotIndex)) continue;
        const slot = slots[slotIndex]!;
        if (!eligibleForSlot(player.positions, slot)) continue;
        const next = mask | (1 << slotIndex);
        const points = state.points + player.points;
        if (!states.has(next) || points > states.get(next)!.points) states.set(next, { points,
          assignments: [...state.assignments, { slot, slotIndex, player }] });
      }
    }
  }
  const complete = states.get((1 << slots.length) - 1);
  const best = complete ?? [...states.values()].sort((a, b) =>
    b.assignments.length - a.assignments.length || b.points - a.points)[0]!;
  return { complete: Boolean(complete), expectedPoints: Math.round(best.points * 100) / 100,
    assignments: best.assignments.sort((a, b) => a.slotIndex - b.slotIndex),
    missingSlots: slots.filter((_, index) => !best.assignments.some((entry) => entry.slotIndex === index)) };
}
