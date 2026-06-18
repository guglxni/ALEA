import { Card, Street } from "../types/cards";
import { HandContext, Position } from "../types/game-state";

// Dimensions: hand(8) × equity(5) × bet(4) × position(4) × stack(3) × street(4) = 7,680
export const HAND_BUCKETS = 8;
export const EQUITY_BUCKETS = 5;
export const BET_BUCKETS = 4;
export const POSITION_BUCKETS = 4;
export const STACK_BUCKETS = 3;
export const STREET_COUNT = 4;

export const TOTAL_BUCKETS =
  HAND_BUCKETS * EQUITY_BUCKETS * BET_BUCKETS * POSITION_BUCKETS * STACK_BUCKETS * STREET_COUNT;

// --------------- Hand strength bucketing ---------------

// Maps canonical preflop hand to bucket 0-7 (0=premium, 7=trash)
const PREFLOP_HAND_TIERS: [string[], number][] = [
  [["AA", "KK", "QQ", "AKs"], 0],
  [["JJ", "TT", "AQs", "AKo"], 1],
  [["99", "88", "AJs", "KQs"], 2],
  [["77", "66", "ATs", "KJs"], 3],
  [["55", "44", "33", "22", "T9s", "98s", "87s", "76s"], 4],
  [["KTo", "QJo", "KQo"], 5],
  [["A2s", "A3s", "A4s", "A5s"], 6],
];

function canonicalHand(c1: Card, c2: Card): string {
  const rank1 = c1[0];
  const rank2 = c2[0];
  const suited = c1[1] === c2[1];
  const ranks = "23456789TJQKA";
  const r1 = ranks.indexOf(rank1);
  const r2 = ranks.indexOf(rank2);
  const [high, low] = r1 >= r2 ? [rank1, rank2] : [rank2, rank1];
  if (high === low) return `${high}${low}`;
  return `${high}${low}${suited ? "s" : "o"}`;
}

export function preflopHandBucket(holeCards: [Card, Card]): number {
  const hand = canonicalHand(holeCards[0], holeCards[1]);
  for (const [hands, bucket] of PREFLOP_HAND_TIERS) {
    if (hands.includes(hand)) return bucket;
  }
  return 7; // trash
}

// Monte Carlo equity estimation (simplified — full version uses rollouts)
// Returns equity 0-1 vs uniform random opponent range
export function estimateEquity(holeCards: [Card, Card], communityCards: Card[], shortDeck: boolean): number {
  // For v1 we use a fast heuristic based on hand strength rank.
  // A full implementation runs Monte Carlo rollouts using hand-evaluator.
  // This placeholder returns a bucket-consistent approximation.
  const strength = roughHandStrength(holeCards, communityCards);
  return Math.min(1.0, Math.max(0.0, strength));
}

// Rough hand strength heuristic (0-1). Replace with proper hand evaluator in production.
function roughHandStrength(holeCards: [Card, Card], community: Card[]): number {
  const all = [...holeCards, ...community];
  const ranks = "23456789TJQKA";
  const rankValues = all.map((c) => ranks.indexOf(c[0]));
  const suits = all.map((c) => c[1]);
  const maxRank = Math.max(...rankValues) / 12;
  const pairs = rankValues.filter((r, i) => rankValues.indexOf(r) !== i).length > 0;
  const flush = suits.filter((s) => s === suits[0]).length >= 5;
  let score = maxRank * 0.4;
  if (pairs) score += 0.25;
  if (flush) score += 0.2;
  return Math.min(score, 1.0);
}

export function postflopEquityBucket(equity: number): number {
  if (equity < 0.2) return 0;
  if (equity < 0.4) return 1;
  if (equity < 0.6) return 2;
  if (equity < 0.8) return 3;
  return 4;
}

// --------------- Bet size bucketing ---------------
// B0=check/fold, B1=call/min-raise, B2=half-pot, B3=all-in

export function betBucket(facingBet: number, potSize: number, effectiveStack: number): number {
  if (facingBet === 0) return 0;
  if (effectiveStack <= 0) return 3;
  const fraction = facingBet / (potSize + facingBet);
  if (fraction < 0.15) return 1;
  if (fraction < 0.6) return 2;
  return 3;
}

// --------------- Position bucketing ---------------

export function positionBucket(position: Position): number {
  switch (position) {
    case "SB": return 0;
    case "BB": return 1;
    case "EP": return 2;
    case "BTN": return 3;
  }
}

// --------------- Stack depth bucketing ---------------

export function stackBucket(effectiveStackBb: number): number {
  if (effectiveStackBb <= 20) return 0;
  if (effectiveStackBb <= 50) return 1;
  return 2;
}

// --------------- Street encoding ---------------

export function streetIndex(street: Street): number {
  switch (street) {
    case "preflop": return 0;
    case "flop": return 1;
    case "turn": return 2;
    case "river": return 3;
    default: return 3;
  }
}

// --------------- Key computation ---------------

export interface BucketDimensions {
  handBucket: number;
  equityBucket: number;
  betBucket: number;
  positionBucket: number;
  stackBucket: number;
  streetIndex: number;
}

export function computeKey(d: BucketDimensions): number {
  return (
    d.handBucket * (EQUITY_BUCKETS * BET_BUCKETS * POSITION_BUCKETS * STACK_BUCKETS * STREET_COUNT) +
    d.equityBucket * (BET_BUCKETS * POSITION_BUCKETS * STACK_BUCKETS * STREET_COUNT) +
    d.betBucket * (POSITION_BUCKETS * STACK_BUCKETS * STREET_COUNT) +
    d.positionBucket * (STACK_BUCKETS * STREET_COUNT) +
    d.stackBucket * STREET_COUNT +
    d.streetIndex
  );
}

export function computeBucketFromContext(
  ctx: HandContext,
  bigBlind: number,
  shortDeck: boolean
): { key: number; dims: BucketDimensions } {
  const isPreflop = ctx.street === "preflop";
  const handBucket = isPreflop
    ? preflopHandBucket(ctx.holeCards)
    : postflopEquityBucket(estimateEquity(ctx.holeCards, ctx.communityCards, shortDeck));
  const equityBucket = isPreflop
    // Invert: hand bucket 0 (premium AA) → equity bucket 4 (high equity); bucket 7 (trash) → 0
    ? (EQUITY_BUCKETS - 1) - Math.floor(handBucket * (EQUITY_BUCKETS / HAND_BUCKETS))
    : postflopEquityBucket(estimateEquity(ctx.holeCards, ctx.communityCards, shortDeck));
  const bb = betBucket(ctx.facingBet, ctx.potSize, ctx.effectiveStack);
  const pb = positionBucket(ctx.heroPosition);
  const sb = stackBucket(bigBlind > 0 ? ctx.effectiveStack / bigBlind : 25);
  const si = streetIndex(ctx.street);
  const dims: BucketDimensions = {
    handBucket,
    equityBucket,
    betBucket: bb,
    positionBucket: pb,
    stackBucket: sb,
    streetIndex: si,
  };
  return { key: computeKey(dims), dims };
}
