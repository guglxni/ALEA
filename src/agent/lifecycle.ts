import { ERTableState, SeatState } from "../types/game-state";
import { Position } from "../types/game-state";

// Infer hero's position from seat arrangement (simplified 2-player model; extend for 6)
export function inferPosition(heroId: string, seats: Record<string, SeatState>): Position {
  const ids = Object.keys(seats);
  const heroIndex = ids.indexOf(heroId);
  if (ids.length === 2) {
    return heroIndex === 0 ? "BTN" : "BB";
  }
  // For 3-6 players: rough positional mapping
  const ratio = heroIndex / ids.length;
  if (ratio < 0.17) return "SB";
  if (ratio < 0.33) return "BB";
  if (ratio < 0.67) return "EP";
  return "BTN";
}

// Estimate big blind size from pot / action context
// In production, the ER state should expose this directly
export function inferBigBlind(state: ERTableState): number {
  if (state.pot > 0) {
    // During preflop, pot starts at 1.5 BB (SB + BB)
    // Rough heuristic: divide by 1.5
    return Math.max(1, Math.round(state.pot / 1.5));
  }
  return 100; // default 100-chip BB
}

// Check whether tournament is over (all but one seat eliminated)
export function isTournamentOver(state: ERTableState): boolean {
  const active = Object.values(state.seats).filter((s) => s.isActive && s.stack > 0);
  return active.length <= 1;
}
