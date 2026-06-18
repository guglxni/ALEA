/**
 * Agent-layer test suite.
 * Run: npx ts-node scripts/run-tests.ts
 */

import { BlueprintPolicyService, ActionDistribution } from "../src/blueprint/policy-service";
import {
  computeBucketFromContext, TOTAL_BUCKETS, computeKey,
  preflopHandBucket, postflopEquityBucket,
  betBucket, positionBucket, stackBucket, streetIndex,
  HAND_BUCKETS, EQUITY_BUCKETS, BET_BUCKETS, POSITION_BUCKETS, STACK_BUCKETS, STREET_COUNT,
} from "../src/blueprint/bucketing";
import { InMemoryWeightStore, ExploitWeights } from "../src/sidecar/weight-store";
import {
  applyConfidenceDecay, profileToWeights, emptyProfile, TendencyProfile,
} from "../src/sidecar/tendency-profile";
import { CallStationAgent, TightAggressiveAgent } from "../src/agent/scripted-agents";
import { HandContext, ERTableState } from "../src/types/game-state";
import { Card } from "../src/types/cards";
import { Logger } from "../src/utils/logger";
import { MetricsCollector } from "../src/utils/metrics";
import { inferPosition, inferBigBlind } from "../src/agent/lifecycle";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Test harness ──────────────────────────────────────────────────────────────

const logger = new Logger("error"); // suppress info/warn output in test runs
let passed = 0;
let failed = 0;
let section = "";

function describe(name: string, fn: () => void): void {
  section = name;
  console.log(`\n[${name}]`);
  fn();
}

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}  [${section}]`);
    failed++;
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function assertAlmost(actual: number, expected: number, eps: number, label: string): void {
  assert(
    Math.abs(actual - expected) < eps,
    `${label}  (got ${actual.toFixed(4)}, want ≈${expected.toFixed(4)} ±${eps})`
  );
}

function assertThrows(fn: () => unknown, label: string): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, label);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BLUEPRINT_PATH = "./data/blueprint_v1.bin";
const blueprintExists = fs.existsSync(BLUEPRINT_PATH);

function makeCtx(overrides: Partial<HandContext> = {}): HandContext {
  return {
    handId: "test-hand",
    street: "preflop",
    holeCards: ["Ah", "Ad"] as [Card, Card],
    communityCards: [],
    potSize: 150,
    effectiveStack: 1000,
    heroPosition: "BTN",
    facingBet: 0,
    potOdds: 0,
    opponentActions: {},
    streetHistory: {},
    ...overrides,
  };
}

function makeTableState(overrides: Partial<ERTableState> = {}): ERTableState {
  return {
    tableId: "table-1",
    street: "preflop",
    pot: 150,
    communityCards: [],
    seats: {
      "hero111": { agentId: "hero111", stack: 1000, lastAction: null, isActive: true },
      "opp2222": { agentId: "opp2222", stack: 950,  lastAction: null, isActive: true },
    },
    currentActor: "hero111",
    actionDeadline: Date.now() + 15_000,
    handId: "hand-abc",
    handComplete: false,
    ...overrides,
  };
}

// ── Suite 1: Preflop hand bucketing ──────────────────────────────────────────

describe("1. Preflop hand bucketing", () => {
  // Premium (tier 0)
  assertEq(preflopHandBucket(["Ah", "Ad"]), 0, "AA → bucket 0");
  assertEq(preflopHandBucket(["Kh", "Ks"]), 0, "KK → bucket 0");
  assertEq(preflopHandBucket(["Qd", "Qc"]), 0, "QQ → bucket 0");
  assertEq(preflopHandBucket(["Ah", "Kh"]), 0, "AKs [Ah,Kh — same suit] → bucket 0");
  assertEq(preflopHandBucket(["Ah", "Ks"]), 1, "AKo [Ah,Ks — diff suit] → bucket 1 (Strong, not Premium)");
  // Strong (tier 1)
  assertEq(preflopHandBucket(["Jd", "Js"]), 1, "JJ → bucket 1");
  assertEq(preflopHandBucket(["Td", "Ts"]), 1, "TT → bucket 1");
  assertEq(preflopHandBucket(["Ah", "Qh"]), 1, "AQs → bucket 1");
  // Good (tier 2)
  assertEq(preflopHandBucket(["9h", "9d"]), 2, "99 → bucket 2");
  assertEq(preflopHandBucket(["Kh", "Qh"]), 2, "KQs → bucket 2");
  // Speculative (tier 4)
  assertEq(preflopHandBucket(["7s", "6s"]), 4, "76s → bucket 4");
  assertEq(preflopHandBucket(["5c", "5d"]), 4, "55 → bucket 4");
  // Marginal (tier 5)
  assertEq(preflopHandBucket(["Kd", "Th"]), 5, "KTo → bucket 5");
  // Weak (tier 6)
  assertEq(preflopHandBucket(["Ah", "2h"]), 6, "A2s → bucket 6");
  // Trash (tier 7)
  assertEq(preflopHandBucket(["2c", "7d"]), 7, "27o → bucket 7");
  assertEq(preflopHandBucket(["3h", "8d"]), 7, "83o → bucket 7");
  // Suit-independence for pairs
  assertEq(preflopHandBucket(["Ah", "Ac"]), preflopHandBucket(["As", "Ad"]), "AA bucket is suit-independent");
});

// ── Suite 2: Postflop equity bucketing ───────────────────────────────────────

describe("2. Equity bucketing", () => {
  assertEq(postflopEquityBucket(0.0),  0, "0% → E1");
  assertEq(postflopEquityBucket(0.19), 0, "19% → E1");
  assertEq(postflopEquityBucket(0.2),  1, "20% → E2 (boundary)");
  assertEq(postflopEquityBucket(0.39), 1, "39% → E2");
  assertEq(postflopEquityBucket(0.4),  2, "40% → E3 (boundary)");
  assertEq(postflopEquityBucket(0.5),  2, "50% → E3");
  assertEq(postflopEquityBucket(0.6),  3, "60% → E4 (boundary)");
  assertEq(postflopEquityBucket(0.79), 3, "79% → E4");
  assertEq(postflopEquityBucket(0.8),  4, "80% → E5 (boundary)");
  assertEq(postflopEquityBucket(1.0),  4, "100% → E5");
});

// ── Suite 3: Bet size bucketing ───────────────────────────────────────────────

describe("3. Bet size bucketing", () => {
  assertEq(betBucket(0, 100, 500),   0, "No bet → B0 (check/fold)");
  assertEq(betBucket(10, 100, 500),  1, "Small bet (9% pot fraction) → B1");
  assertEq(betBucket(50, 100, 500),  2, "Half-pot bet → B2");
  assertEq(betBucket(100, 100, 500), 2, "Pot-sized bet (fraction=0.50) → B2 (threshold is 0.60)");
  assertEq(betBucket(300, 100, 500), 3, "1.5x pot bet (fraction=0.75) → B3");
  assertEq(betBucket(500, 100, 0),   3, "Zero effective stack → B3 (all-in)");
  assertEq(betBucket(500, 100, 500), 3, "5x pot overbet (fraction=0.83) → B3");
});

// ── Suite 4: Position bucketing ───────────────────────────────────────────────

describe("4. Position bucketing", () => {
  assertEq(positionBucket("SB"),  0, "SB → P0");
  assertEq(positionBucket("BB"),  1, "BB → P1");
  assertEq(positionBucket("EP"),  2, "EP → P2");
  assertEq(positionBucket("BTN"), 3, "BTN → P3");
});

// ── Suite 5: Stack depth bucketing ───────────────────────────────────────────

describe("5. Stack depth bucketing", () => {
  assertEq(stackBucket(10),  0, "10BB → S0 (short)");
  assertEq(stackBucket(20),  0, "20BB → S0 (boundary: ≤20 is short)");
  assertEq(stackBucket(21),  1, "21BB → S1 (medium)");
  assertEq(stackBucket(50),  1, "50BB → S1 (boundary: ≤50 is medium)");
  assertEq(stackBucket(51),  2, "51BB → S2 (deep)");
  assertEq(stackBucket(200), 2, "200BB → S2 (deep)");
});

// ── Suite 6: Street index ─────────────────────────────────────────────────────

describe("6. Street index", () => {
  assertEq(streetIndex("preflop"),  0, "preflop → 0");
  assertEq(streetIndex("flop"),     1, "flop → 1");
  assertEq(streetIndex("turn"),     2, "turn → 2");
  assertEq(streetIndex("river"),    3, "river → 3");
  assertEq(streetIndex("showdown"), 3, "showdown → 3 (clamped)");
});

// ── Suite 7: Key space ────────────────────────────────────────────────────────

describe("7. Key space", () => {
  assertEq(TOTAL_BUCKETS, 7680, "Total buckets = 8×5×4×4×3×4 = 7,680");

  // All 7,680 keys must be distinct
  const keys = new Set<number>();
  for (let h = 0; h < HAND_BUCKETS; h++)
    for (let e = 0; e < EQUITY_BUCKETS; e++)
      for (let b = 0; b < BET_BUCKETS; b++)
        for (let p = 0; p < POSITION_BUCKETS; p++)
          for (let s = 0; s < STACK_BUCKETS; s++)
            for (let st = 0; st < STREET_COUNT; st++)
              keys.add(computeKey({ handBucket: h, equityBucket: e, betBucket: b, positionBucket: p, stackBucket: s, streetIndex: st }));

  assertEq(keys.size, TOTAL_BUCKETS, "All 7,680 keys are unique (no collisions)");
  assert(Math.min(...keys) === 0,               "Minimum key = 0");
  assert(Math.max(...keys) === TOTAL_BUCKETS - 1, "Maximum key = 7,679");
});

// ── Suite 8: Policy service ───────────────────────────────────────────────────

describe("8. Policy service — uniform fallback", () => {
  const p = new BlueprintPolicyService(logger);
  p.load("/nonexistent/blueprint.bin");

  const dist = p.lookup(0);
  assertAlmost(dist.reduce((a, b) => a + b, 0), 1.0, 1e-5, "Fallback dist sums to 1.0");
  assert(dist.every((v) => v === 0.25), "Fallback is uniform [0.25, 0.25, 0.25, 0.25]");

  // Out-of-range bucket also returns uniform
  const oob = p.lookup(99999);
  assertAlmost(oob.reduce((a, b) => a + b, 0), 1.0, 1e-5, "Out-of-range bucket → uniform");

  // getDistribution uses context → should also work without blueprint
  const ctx = makeCtx();
  const d2 = p.getDistribution(ctx, 100, true);
  assertAlmost(d2.reduce((a, b) => a + b, 0), 1.0, 1e-5, "getDistribution fallback sums to 1.0");
});

if (blueprintExists) {
  describe("8b. Policy service — real blueprint binary", () => {
    const p = new BlueprintPolicyService(logger);
    p.load(BLUEPRINT_PATH);

    // Spot-check several buckets
    for (const bucket of [0, 100, 1000, 3840, 7679]) {
      const d = p.lookup(bucket);
      assertAlmost(d.reduce((a, b) => a + b, 0), 1.0, 1e-3, `Bucket ${bucket} sums to 1.0`);
      assert(d.every((v) => v >= 0 && v <= 1), `Bucket ${bucket} all probs in [0,1]`);
    }

    // Structural check: AA preflop distribution is valid (not testing Nash correctness on stub)
    const aaCtx = makeCtx({ holeCards: ["Ah", "Ad"] as [Card, Card] });
    const aaDist = p.getDistribution(aaCtx, 100, true);
    assertAlmost(aaDist.reduce((a, b) => a + b, 0), 1.0, 1e-3, "AA preflop dist sums to 1.0");
    assert(aaDist.every((v) => v >= 0 && v <= 1), "AA preflop: all probs in [0,1]");

    // Verify trash hand (27o) prefers folding when facing a bet
    const trashCtx = makeCtx({
      holeCards: ["2c", "7d"] as [Card, Card],
      facingBet: 80,
      potSize: 100,
    });
    const trashDist = p.getDistribution(trashCtx, 100, true);
    assert(trashDist[0] >= trashDist[2], "27o facing bet: fold ≥ raise probability");
  });
} else {
  console.log("\n[8b. Blueprint binary tests SKIPPED — run `npm run solve` first]");
}

// ── Suite 9: Exploit weight application ───────────────────────────────────────

describe("9. Exploit weight application", () => {
  const p = new BlueprintPolicyService(logger);
  p.load("/nonexistent/blueprint.bin");

  const base: ActionDistribution = [0.4, 0.3, 0.2, 0.1];

  // Zero weights → same as base
  const zeroWeights: ExploitWeights = [0, 0, 0, 0];
  const unchanged = p.applyExploitWeights(base, zeroWeights);
  assertAlmost(unchanged[0], 0.4, 1e-4, "Zero weights: fold stays 0.4");
  assertAlmost(unchanged.reduce((a, b) => a + b, 0), 1.0, 1e-4, "Zero weights: still sums to 1.0");

  // +0.5 on fold → fold increases, others decrease
  const boostFold: ExploitWeights = [0.5, 0, 0, 0];
  const boosted = p.applyExploitWeights(base, boostFold);
  assert(boosted[0] > 0.4, "+0.5 fold weight: fold probability increases");
  assertAlmost(boosted.reduce((a, b) => a + b, 0), 1.0, 1e-4, "After boost: still sums to 1.0");

  // -0.5 on fold → fold decreases
  const suppressFold: ExploitWeights = [-0.5, 0, 0, 0];
  const suppressed = p.applyExploitWeights(base, suppressFold);
  assert(suppressed[0] < 0.4, "-0.5 fold weight: fold probability decreases");
  assertAlmost(suppressed.reduce((a, b) => a + b, 0), 1.0, 1e-4, "After suppress: still sums to 1.0");

  // Weight clamping: weights beyond ±0.5 are clamped
  const extreme: ExploitWeights = [5.0, -5.0, 5.0, -5.0];
  const clamped = p.applyExploitWeights(base, extreme);
  assertAlmost(clamped.reduce((a, b) => a + b, 0), 1.0, 1e-4, "Extreme weights clamped: still sums to 1.0");
  assert(clamped.every((v) => v >= 0), "Clamped weights: no negative probabilities");

  // Degenerate case: all weights drive all probabilities to zero → falls back to uniform
  const allDead: ExploitWeights = [-0.5, -0.5, -0.5, -0.5];
  const fallback = p.applyExploitWeights([0.001, 0.001, 0.001, 0.001] as unknown as ActionDistribution, allDead);
  assertAlmost(fallback.reduce((a, b) => a + b, 0), 1.0, 1e-4, "All-dead weights fall back to uniform");
});

// ── Suite 10: Action sampling distribution ────────────────────────────────────

describe("10. Action sampling (statistical, N=20,000)", () => {
  const p = new BlueprintPolicyService(logger);
  p.load("/nonexistent/blueprint.bin");
  const N = 20_000;

  const target: ActionDistribution = [0.50, 0.30, 0.15, 0.05];
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    const a = p.sampleAction(target);
    if (a.type === "fold")        counts[0]++;
    else if (a.type === "call")   counts[1]++;
    else if (a.type === "raise")  counts[2]++;
    else                          counts[3]++;
  }

  assertAlmost(counts[0]! / N, 0.50, 0.02, "Fold rate ≈ 50%");
  assertAlmost(counts[1]! / N, 0.30, 0.02, "Call rate ≈ 30%");
  assertAlmost(counts[2]! / N, 0.15, 0.02, "Raise rate ≈ 15%");
  assertAlmost(counts[3]! / N, 0.05, 0.015, "All-in rate ≈ 5%");

  // Deterministic: [1,0,0,0] always folds
  const alwaysFold: ActionDistribution = [1, 0, 0, 0];
  for (let i = 0; i < 100; i++) {
    assert(p.sampleAction(alwaysFold).type === "fold", "p=[1,0,0,0] always folds");
    break; // assert once is enough for determinism check
  }
  assert(
    Array.from({ length: 100 }).every(() => p.sampleAction(alwaysFold).type === "fold"),
    "p=[1,0,0,0] folds 100/100 times"
  );
});

// ── Suite 11: Weight store ────────────────────────────────────────────────────

describe("11. InMemoryWeightStore", () => {
  const store = new InMemoryWeightStore();

  // Read before write → null
  assert(store.getWeights("unknown") === null, "Unknown opponent → null");

  // Write and read back
  const w: ExploitWeights = [0.1, -0.2, 0.3, -0.1];
  store.setWeights("opp1", w);
  const got = store.getWeights("opp1")!;
  assert(got !== null, "After set: getWeights returns non-null");
  assertAlmost(got[0], 0.1, 1e-6, "Weight[0] round-trips correctly");
  assertAlmost(got[2], 0.3, 1e-6, "Weight[2] round-trips correctly");

  // Overwrite
  store.setWeights("opp1", [0.5, 0.5, 0.5, 0.5]);
  assertAlmost(store.getWeights("opp1")![0], 0.5, 1e-6, "Overwrite: updated value returned");

  // Clear
  store.clear("opp1");
  assert(store.getWeights("opp1") === null, "After clear: returns null");

  // Multiple opponents don't interfere
  store.setWeights("a", [0.1, 0, 0, 0]);
  store.setWeights("b", [0.2, 0, 0, 0]);
  assertAlmost(store.getWeights("a")![0], 0.1, 1e-6, "Opponent a unaffected by b");
  assertAlmost(store.getWeights("b")![0], 0.2, 1e-6, "Opponent b unaffected by a");
});

// ── Suite 12: Tendency profiles ───────────────────────────────────────────────

describe("12. TendencyProfile — decay and weight conversion", () => {
  const base: TendencyProfile = {
    opponentId: "opp",
    handsObserved: 50,
    foldToThreeBetDeviation: 0.4,
    continuationBetCallDeviation: -0.2,
    bluffFrequencyDeviation: 0.3,
    allInCallDeviation: -0.5,
    confidenceScore: 1.0,
    lastUpdatedHand: 0,
  };

  // No decay if ≤10 hands since update
  const noDecay = applyConfidenceDecay(base, 8, 0.9);
  assertAlmost(noDecay.confidenceScore, 1.0, 1e-6, "No decay: ≤10 hands since update");

  // Decay kicks in at exactly 11 hands
  const oneBeyond = applyConfidenceDecay(base, 11, 0.9);
  assertAlmost(oneBeyond.confidenceScore, Math.pow(0.9, 1), 1e-4, "Decay at 11 hands: 0.9^1");

  // Multi-step decay
  const tenBeyond = applyConfidenceDecay(base, 20, 0.9);
  assertAlmost(tenBeyond.confidenceScore, Math.pow(0.9, 10), 1e-4, "Decay at 20 hands: 0.9^10");

  // Confidence can't go negative
  const farDecayed = applyConfidenceDecay({ ...base, lastUpdatedHand: 0 }, 1000, 0.9);
  assert(farDecayed.confidenceScore >= 0, "Decayed confidence ≥ 0");

  // emptyProfile initialises with low confidence
  const empty = emptyProfile("new-opp");
  assertAlmost(empty.confidenceScore, 0.1, 1e-6, "Empty profile: confidence = 0.1");
  assertEq(empty.handsObserved, 0, "Empty profile: handsObserved = 0");

  // profileToWeights: all weights bounded ±0.5
  const weights = profileToWeights(base);
  assert(weights.length === 4, "profileToWeights returns 4 values");
  assert(weights.every((w) => w >= -0.5 && w <= 0.5), "All weights bounded to ±0.5");

  // Zero confidence → all weights near zero
  const zeroConf = profileToWeights({ ...base, confidenceScore: 0 });
  assert(zeroConf.every((w) => w === 0), "Zero confidence → zero weights");

  // High positive fold-to-3bet deviation → we should bluff more (reduce our fold weight)
  const exploit = profileToWeights({ ...base, foldToThreeBetDeviation: 0.5, confidenceScore: 1.0 });
  assert(exploit[0] < 0, "Opponent over-folds to 3bet → our fold weight is negative (we bluff more)");
});

// ── Suite 13: Scripted agents ─────────────────────────────────────────────────

describe("13. Scripted agents", () => {
  const callStation = new CallStationAgent();
  const ta = new TightAggressiveAgent();

  // Call-station always calls
  for (const street of ["preflop", "flop", "turn", "river"] as const) {
    assert(
      callStation.decide(makeCtx({ street })).type === "call",
      `Call-station always calls on ${street}`
    );
  }

  // TA preflop decisions
  const premium: [Card, Card] = ["Ah", "Ad"];
  const good: [Card, Card]    = ["9h", "9d"];
  const playable: [Card, Card] = ["7d", "7s"];
  const trash: [Card, Card]   = ["2c", "7d"];
  const marginal: [Card, Card] = ["Kd", "Th"];

  assertEq(ta.decide(makeCtx({ holeCards: premium  })).type, "raise", "TA: AA → raise");
  assertEq(ta.decide(makeCtx({ holeCards: good     })).type, "call",  "TA: 99 → call");
  assertEq(ta.decide(makeCtx({ holeCards: playable })).type, "call",  "TA: 77 → call");
  assertEq(ta.decide(makeCtx({ holeCards: marginal })).type, "fold",  "TA: KTo → fold");
  assertEq(ta.decide(makeCtx({ holeCards: trash    })).type, "fold",  "TA: 27o → fold");

  // TA postflop: folds when pot odds are too high
  const highPotOdds = makeCtx({ street: "flop", potOdds: 0.5, facingBet: 150, potSize: 150 });
  assertEq(ta.decide(highPotOdds).type, "fold", "TA: folds postflop with bad pot odds");

  // TA postflop: calls with favourable pot odds
  const goodPotOdds = makeCtx({ street: "flop", potOdds: 0.2, facingBet: 30, potSize: 120 });
  assertEq(ta.decide(goodPotOdds).type, "call", "TA: calls postflop with good pot odds");
});

// ── Suite 14: Lifecycle helpers ───────────────────────────────────────────────

describe("14. Lifecycle helpers", () => {
  const state = makeTableState();

  // inferPosition — 2-player: first seat is BTN
  assertEq(inferPosition("hero111", state.seats), "BTN", "2-player: first seat → BTN");
  assertEq(inferPosition("opp2222", state.seats), "BB",  "2-player: second seat → BB");

  // inferBigBlind — heuristic from pot
  const blindState = makeTableState({ pot: 150 }); // 1.5 BB pot → BB ≈ 100
  const bb = inferBigBlind(blindState);
  assert(bb > 0, "inferBigBlind returns positive value");
  assert(bb <= 150, "inferBigBlind ≤ pot size");

  // Zero pot → default fallback
  const zeroPot = makeTableState({ pot: 0 });
  assertEq(inferBigBlind(zeroPot), 100, "Zero pot → default 100 BB");
});

// ── Suite 15: Metrics collector ───────────────────────────────────────────────

describe("15. MetricsCollector", () => {
  const tmpFile = path.join(os.tmpdir(), `test-metrics-${Date.now()}.jsonl`);
  const m = new MetricsCollector(tmpFile, logger);

  // Initial state
  assertEq(m.snapshot().handsPlayed, 0, "Initial handsPlayed = 0");
  assertEq(m.snapshot().handsWon, 0,    "Initial handsWon = 0");
  assertAlmost(m.avgDecisionLatencyMs, 0, 1e-6, "Initial avg latency = 0");

  // Record a win
  m.recordHandComplete(true, 200);
  assertEq(m.snapshot().handsPlayed, 1, "After 1 hand: handsPlayed = 1");
  assertEq(m.snapshot().handsWon, 1,    "After win: handsWon = 1");
  assertAlmost(m.snapshot().chipsWonNet, 200, 1e-6, "After +200 chips: chipsWonNet = 200");

  // Record a loss
  m.recordHandComplete(false, -150);
  assertEq(m.snapshot().handsPlayed, 2, "After 2 hands: handsPlayed = 2");
  assertEq(m.snapshot().handsWon, 1,    "After loss: handsWon still 1");
  assertAlmost(m.snapshot().chipsWonNet, 50, 1e-6, "Net chips = 200 - 150 = 50");

  // Decision latency tracking
  m.recordDecision(80);
  m.recordDecision(120);
  assertAlmost(m.avgDecisionLatencyMs, 100, 1e-4, "Avg latency = (80+120)/2 = 100ms");
  assertEq(m.snapshot().blueprintLookups, 2, "Blueprint lookups tracked");

  // Sidecar counters
  m.recordSidecarUpdate();
  m.recordSidecarUpdate();
  m.recordSidecarError();
  assertEq(m.snapshot().sidecarUpdates, 2, "Sidecar updates counted");
  assertEq(m.snapshot().sidecarErrors,  1, "Sidecar errors counted");

  // Action timeout
  m.recordActionTimeout();
  assertEq(m.snapshot().actionTimeouts, 1, "Action timeout counted");

  // Cleanup
  try { fs.unlinkSync(tmpFile); } catch { /* ok if flush didn't write yet */ }
});

// ── Suite 16: Config loading ───────────────────────────────────────────────────

describe("16. Config loading", () => {
  // Write a minimal temp TOML and verify deep-merge with defaults
  const { loadConfig } = require("../src/config/config");
  const tmp = path.join(os.tmpdir(), `test-config-${Date.now()}.toml`);

  fs.writeFileSync(tmp, `
[agent]
name = "test-agent"
keypair_path = "./keys/test.json"
tournament_id = "TOUR123"

[sidecar]
enabled = true
api_key_env = "MY_KEY"
`);

  const cfg = loadConfig(tmp);
  assertEq(cfg.agent.name, "test-agent",           "agent.name loaded from TOML");
  assertEq(cfg.agent.tournamentId, "TOUR123",       "agent.tournamentId loaded");
  assertEq(cfg.sidecar.enabled, true,               "sidecar.enabled overridden to true");
  assertEq(cfg.sidecar.apiKeyEnv, "MY_KEY",         "sidecar.apiKeyEnv overridden");
  // Defaults intact for untouched fields
  assertEq(cfg.rpc.pollIntervalMs, 500,             "rpc.pollIntervalMs default = 500");
  assertEq(cfg.exploitWeights.maxWeight, 0.5,       "exploitWeights.maxWeight default = 0.5");
  assertEq(cfg.timeouts.actionDeadlineBufferMs, 2000, "timeouts.actionDeadlineBufferMs default = 2000");
  assertEq(cfg.blueprint.variant, "short-deck",     "blueprint.variant default = short-deck");

  fs.unlinkSync(tmp);

  // Missing file throws
  assertThrows(() => loadConfig("/no/such/file.toml"), "loadConfig throws on missing file");
});

// ── Summary ───────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${"─".repeat(50)}`);
console.log(`Tests: ${passed} passed, ${failed} failed, ${total} total`);
if (!blueprintExists) console.log("(blueprint binary tests skipped — run `npm run solve` to include)");
if (failed > 0) process.exit(1);
