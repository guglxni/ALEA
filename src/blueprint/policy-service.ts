import * as fs from "fs";
import { HandContext } from "../types/game-state";
import { Action } from "../types/cards";
import { computeBucketFromContext, TOTAL_BUCKETS, BucketDimensions } from "./bucketing";
import { ExploitWeights } from "../sidecar/weight-store";
import { Logger } from "../utils/logger";

// [p_fold, p_call, p_half_pot, p_all_in] — each row sums to 1.0
export type ActionDistribution = [number, number, number, number];

// Uniform fallback — used when no blueprint is loaded or bucket out of range
const UNIFORM: ActionDistribution = [0.25, 0.25, 0.25, 0.25];

export interface PolicyService {
  load(path: string): void;
  computeBucket(ctx: HandContext, bigBlind: number, shortDeck: boolean): { key: number; dims: BucketDimensions };
  lookup(bucket: number): ActionDistribution;
  getDistribution(ctx: HandContext, bigBlind: number, shortDeck: boolean): ActionDistribution;
  sampleAction(dist: ActionDistribution, weights?: ExploitWeights): Action;
}

export class BlueprintPolicyService implements PolicyService {
  // Float32 view — 4 floats per bucket
  private table: Float32Array | null = null;
  private loaded = false;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  load(blueprintPath: string): void {
    if (!fs.existsSync(blueprintPath)) {
      this.logger.warn("blueprint_not_found", { path: blueprintPath, fallback: "uniform" });
      return;
    }
    const buf = fs.readFileSync(blueprintPath);
    this.table = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (this.table.length !== TOTAL_BUCKETS * 4) {
      throw new Error(
        `Blueprint size mismatch: expected ${TOTAL_BUCKETS * 4} floats, got ${this.table.length}`
      );
    }
    this.loaded = true;
    this.logger.info("blueprint_loaded", { path: blueprintPath, buckets: TOTAL_BUCKETS });
  }

  computeBucket(ctx: HandContext, bigBlind: number, shortDeck: boolean) {
    return computeBucketFromContext(ctx, bigBlind, shortDeck);
  }

  lookup(bucket: number): ActionDistribution {
    if (!this.loaded || !this.table || bucket < 0 || bucket >= TOTAL_BUCKETS) {
      return [...UNIFORM] as ActionDistribution;
    }
    const offset = bucket * 4;
    return [
      this.table[offset],
      this.table[offset + 1],
      this.table[offset + 2],
      this.table[offset + 3],
    ];
  }

  getDistribution(ctx: HandContext, bigBlind: number, shortDeck: boolean): ActionDistribution {
    const { key } = this.computeBucket(ctx, bigBlind, shortDeck);
    return this.lookup(key);
  }

  applyExploitWeights(base: ActionDistribution, weights: ExploitWeights): ActionDistribution {
    const MIN = -0.5;
    const MAX = 0.5;
    const adjusted = base.map((p, i) => {
      const w = Math.min(MAX, Math.max(MIN, weights[i] ?? 0));
      return p * (1 + w);
    }) as unknown as [number, number, number, number];
    const sum = adjusted.reduce((a, b) => a + b, 0);
    if (sum <= 0) return [...UNIFORM] as ActionDistribution;
    return adjusted.map((p) => p / sum) as unknown as ActionDistribution;
  }

  sampleAction(dist: ActionDistribution, weights?: ExploitWeights): Action {
    const effective = weights ? this.applyExploitWeights(dist, weights) : dist;
    const r = Math.random();
    let cum = 0;
    // indices: 0=fold, 1=call, 2=half-pot raise, 3=all-in
    for (let i = 0; i < effective.length; i++) {
      cum += effective[i];
      if (r < cum) return indexToAction(i);
    }
    return indexToAction(3); // all-in as fallback (probability mass rounding)
  }
}

function indexToAction(i: number): Action {
  switch (i) {
    case 0: return { type: "fold" };
    case 1: return { type: "call" };
    case 2: return { type: "raise", sizeFraction: 0.5 };
    case 3: return { type: "all-in" };
    default: return { type: "fold" };
  }
}
