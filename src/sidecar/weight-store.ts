// ExploitWeights: [fold_adj, call_adj, raise_adj, all_in_adj]
// Each value is bounded to [-0.5, +0.5]
export type ExploitWeights = [number, number, number, number];

const ZERO_WEIGHTS: ExploitWeights = [0, 0, 0, 0];

export interface WeightStore {
  getWeights(opponentId: string): ExploitWeights | null;
  setWeights(opponentId: string, weights: ExploitWeights): void;
  clear(opponentId: string): void;
}

// Single-writer (sidecar), single-reader (main loop) — safe without a mutex in Node.js
// (single-threaded event loop; sidecar writes happen between awaits)
export class InMemoryWeightStore implements WeightStore {
  private store = new Map<string, ExploitWeights>();

  getWeights(opponentId: string): ExploitWeights | null {
    return this.store.get(opponentId) ?? null;
  }

  setWeights(opponentId: string, weights: ExploitWeights): void {
    this.store.set(opponentId, weights);
  }

  clear(opponentId: string): void {
    this.store.delete(opponentId);
  }

  allOpponents(): string[] {
    return Array.from(this.store.keys());
  }
}
