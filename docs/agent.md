# Agent System PRD
## Sovereign AI Agent Poker Platform — Agentic Layer

**Paramarsh Labs · v1.0 · June 2025**

---

## Table of Contents

1. [Purpose & Scope](#1-purpose--scope)
2. [Agent Process Architecture](#2-agent-process-architecture)
3. [Blueprint Policy Service](#3-blueprint-policy-service)
4. [LLM Opponent Modeling Sidecar](#4-llm-opponent-modeling-sidecar)
5. [Solana Agent Kit Integration](#5-solana-agent-kit-integration)
6. [Information State Management](#6-information-state-management)
7. [Agent Lifecycle](#7-agent-lifecycle)
8. [Inter-Component Interfaces](#8-inter-component-interfaces)
9. [Configuration & Extensibility](#9-configuration--extensibility)
10. [Observability & Logging](#10-observability--logging)
11. [Testing Strategy](#11-testing-strategy)
12. [Build Order](#12-build-order)
13. [Open Questions](#13-open-questions)

---

## 1. Purpose & Scope

### 1.1 What This Document Covers

This PRD covers the **agentic layer** of the platform in full detail: how an agent process is structured, how it makes decisions, how it perceives game state, how it submits actions, and how it models opponents over time.

It does **not** cover:

- Blockchain programs (Anchor, escrow, tournament registry, Glicko-2 ledger)
- TEE / ephemeral rollup internals
- VRF shuffle protocol
- Identity NFTs or SAID registration

Those are covered in the full platform PRD. The agent layer treats the blockchain as an I/O boundary — it reads state from the ER and writes actions back to it.

### 1.2 The Decision That Shapes Everything

> **LLMs never sit in the action path.**

An LLM takes 200ms–2s per inference call. A real-time poker table with 15-second action clocks and thousands of concurrent tables cannot absorb that latency budget. The decision was made once and is not revisitable for v1:

- **Action path**: precomputed CFR blueprint lookup — deterministic, sub-millisecond, stateless.
- **Between hands**: async LLM sidecar — updates opponent models, adjusts exploit weights, never blocks.

Every design choice in this document flows from this constraint.

### 1.3 Non-Goals for v1

- Human-readable explanation of agent decisions
- Multi-agent coordination / collusion (explicitly out of scope)
- Reinforcement learning from live play (blueprint is static per variant)
- General-purpose agent framework — this is poker-specific
- GUI or dashboard for agent monitoring (CLI + logs only at v1)

---

## 2. Agent Process Architecture

### 2.1 Overview

Each agent is an independent OS process. No shared memory between agents at the same table. Each agent has exactly three internal components:

```
┌─────────────────────────────────────────────────────────────────┐
│                        AGENT PROCESS                            │
│                                                                 │
│  ┌──────────────────────┐    ┌───────────────────────────────┐  │
│  │  Blueprint Policy    │    │   LLM Opponent Modeling       │  │
│  │  Service             │    │   Sidecar                     │  │
│  │                      │    │                               │  │
│  │  CFR lookup table    │    │  Async. Between hands only.   │  │
│  │  sub-millisecond     │◄───│  Updates exploit weights.     │  │
│  │  stateless           │    │  BYOK inference key.          │  │
│  └──────────┬───────────┘    └───────────────────────────────┘  │
│             │                                                    │
│             ▼                                                    │
│  ┌──────────────────────┐                                        │
│  │  Solana Agent Kit    │                                        │
│  │                      │                                        │
│  │  On-chain I/O        │                                        │
│  │  Action submission   │                                        │
│  │  State polling       │                                        │
│  └──────────────────────┘                                        │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Responsibilities

| Component | Responsibility | Latency budget | Blocking? |
|---|---|---|---|
| Blueprint Policy Service | Core decision engine. CFR lookup, action sampling. | < 1ms | Yes — action depends on it |
| LLM Opponent Modeling Sidecar | Opponent tendency estimation. Exploit weight updates. | Unbounded (async) | No — never in action path |
| Solana Agent Kit | ER state polling, action submission, nonce management | Network-bound | Yes — wraps RPC calls |

### 2.3 Process Startup Sequence

```
1. Load blueprint lookup table from disk into memory
2. Initialize exploit weight vector (all zeros on first run)
3. Load exploit weights from local state store (if resuming)
4. Initialize Solana Agent Kit with agent keypair + RPC endpoint
5. Register on-chain (if not already registered for this tournament)
6. Enter main loop: poll → decide → act
```

### 2.4 Main Loop

```
LOOP:
  state ← poll_er_state()
  
  IF state.action_required:
    bucket  ← compute_information_set_bucket(state)
    weights ← get_exploit_weights(state.opponent_ids)
    dist    ← blueprint.lookup(bucket)
    dist    ← apply_exploit_weights(dist, weights)
    action  ← sample_action(dist)
    submit_action(action)
  
  IF state.hand_complete:
    history ← fetch_hand_history_from_l1(state.hand_id)
    sidecar.queue_for_analysis(history)
  
  SLEEP(poll_interval_ms)
```

The sidecar runs in a goroutine (or async thread) independently. It never writes to the decision path mid-hand — only updates the weight store between hands.

---

## 3. Blueprint Policy Service

### 3.1 What a Blueprint Is

A blueprint is a precomputed strategy table produced by running CFR+ on an abstracted version of the game tree. It maps every reachable **information set bucket** to a **probability distribution over actions**.

At decision time, the service:
1. Receives the current game state
2. Computes the information set bucket
3. Looks up the strategy distribution
4. Samples an action from the distribution (or returns the full distribution if the caller wants to apply exploit weights first)

### 3.2 Information Set Bucketing

Full NLHE has ~10¹⁶⁰ distinct information sets — intractable to solve or store. Bucketing compresses this into a tractable representation by grouping similar states.

#### 3.2.1 Bucket Dimensions

**Hand Strength**

Pre-flop: 169 canonical starting hands are grouped into 8 strength tiers.

| Tier | Example hands |
|---|---|
| 1 (Premium) | AA, KK, QQ, AKs |
| 2 (Strong) | JJ, TT, AQs, AKo |
| 3 (Good) | 99, 88, AJs, KQs |
| 4 (Playable) | 77, 66, ATs, KJs |
| 5 (Speculative) | 55–22, suited connectors T9s–76s |
| 6 (Marginal) | Offsuit broadways KTo, QJo |
| 7 (Weak) | Low suited aces A2s–A5s |
| 8 (Trash) | Everything else |

Post-flop: Monte Carlo equity estimation (1000 rollouts) against a uniform random opponent range produces a continuous equity value. Bucketize into 5 equal-width equity quintiles.

| Equity bucket | Equity range |
|---|---|
| E1 | 0–20% |
| E2 | 20–40% |
| E3 | 40–60% |
| E4 | 60–80% |
| E5 | 80–100% |

**Bet Size** (v1 constrained variant — capped)

| Bucket | Description |
|---|---|
| B0 | Check or fold |
| B1 | Call or min-raise |
| B2 | Half-pot raise |
| B3 | All-in |

**Position**

| Bucket | Description |
|---|---|
| P0 | Small blind |
| P1 | Big blind |
| P2 | Early position |
| P3 | Late position / button |

**Stack Depth**

| Bucket | Effective stack (in big blinds) |
|---|---|
| S0 | Short ≤ 20BB |
| S1 | Medium 20–50BB |
| S2 | Deep > 50BB |

**Street**

| Value | Description |
|---|---|
| 0 | Pre-flop |
| 1 | Flop |
| 2 | Turn |
| 3 | River |

#### 3.2.2 Information Set Key

The lookup key is a single integer encoding all dimensions:

```
key = hand_bucket * 5*4*4*3*4 + equity_bucket * 4*4*3*4 + bet_bucket * 4*3*4
      + position_bucket * 3*4 + stack_bucket * 4 + street
```

Total key space: `8 × 5 × 4 × 4 × 3 × 4 = 7,680` distinct information set buckets. This is the full lookup table size for v1.

### 3.3 Solving the Blueprint

**Framework:** OpenSpiel (Google DeepMind) — Python, well-documented, CFR+ implemented.

**Algorithm:** CFR+ (Counterfactual Regret Minimization Plus). Faster convergence than vanilla CFR for the bucket sizes we're using.

**Solve target:** Exploitability < 5% of pot per hand (measured as expected loss per hand vs the Nash equilibrium strategy over 10,000 sampled hands).

**Solve environment:** The constrained variant game tree implemented as a custom OpenSpiel game. Short-deck (36-card, removing 2–5) is recommended over capped-bet because it has a smaller tree and cleaner strategic structure.

**Output format:**

```python
# Produced by solve script
# strategy[key] = [p_fold, p_call, p_half_pot, p_all_in]
strategy: dict[int, list[float]]  # length 7,680
```

Serialized to a flat binary file: `blueprint_v1.bin`. Layout: 7,680 × 4 float32 values = 122,880 bytes ≈ 120KB. Loads into memory in one read.

**Solve time estimate:** For 7,680 buckets and a short-deck game tree, CFR+ converges to exploitability < 5% in roughly 10^6–10^7 iterations. On a modern workstation: 2–8 hours wall-clock.

### 3.4 Policy Service API

```typescript
interface PolicyService {
  // Load blueprint from disk into memory. Call once at startup.
  load(path: string): void;

  // Compute the information set bucket for the given state.
  // Pure function — no side effects.
  computeBucket(state: GameState): number;

  // Return the action distribution for a bucket.
  // Returns [p_fold, p_call, p_half_pot, p_all_in] summing to 1.0
  lookup(bucket: number): ActionDistribution;

  // Convenience: compute bucket and look up in one call.
  getDistribution(state: GameState): ActionDistribution;

  // Sample a single action from the distribution.
  // Uses exploit weights if provided.
  sampleAction(dist: ActionDistribution, weights?: ExploitWeights): Action;
}

type ActionDistribution = [number, number, number, number]; // [fold, call, half-pot, all-in]

type Action =
  | { type: "fold" }
  | { type: "call" }
  | { type: "raise"; sizeFraction: 0.5 }
  | { type: "all-in" };
```

### 3.5 Exploit Weight Application

The LLM sidecar produces a small adjustment vector. It is applied to the blueprint distribution before sampling:

```
adjusted[i] = base[i] * (1 + weight[i])
adjusted    = normalize(adjusted)  // re-sum to 1.0
```

Weights are bounded to `[-0.5, +0.5]` to prevent degenerate distributions. A weight of `+0.3` on fold means the agent folds 30% more often than blueprint against this opponent. A weight of `-0.3` on fold means 30% less.

---

## 4. LLM Opponent Modeling Sidecar

### 4.1 Purpose

The sidecar does one thing: estimate how each opponent deviates from Nash equilibrium play, then express those deviations as adjustments to the blueprint distribution.

It is:
- Asynchronous — runs between hands, never during
- Optional — the agent is fully functional without it
- Bounded — outputs a small fixed-size weight vector, nothing more
- Operator-keyed — uses the operator's LLM API key (BYOK)

### 4.2 What It Reads

After each hand closes, the hand history is committed to L1. The sidecar fetches this from the committed Merkle tree via the L1 RPC. It reads:

- Per-action sequence: position, street, hole cards (revealed post-showdown), community cards, action taken, pot size at time of action, stack depth at time of action
- Showdown result (if reached): hole cards revealed, hand won/lost
- Player ID (agent NFT pubkey) for attribution

The sidecar accumulates this across the tournament session in a local in-memory store indexed by opponent ID.

### 4.3 What It Produces

For each opponent, the sidecar maintains and updates a `TendencyProfile`:

```typescript
interface TendencyProfile {
  opponentId: string;       // agent NFT pubkey
  handsObserved: number;
  
  // Estimated deviation from Nash in each spot
  // Positive = does this more than Nash, negative = less
  foldToThreeBetDeviation: number;      // e.g., +0.15 = over-folds to 3bets
  continuationBetCallDeviation: number; // e.g., -0.20 = under-calls c-bets
  bluffFrequencyDeviation: number;      // e.g., +0.10 = bluffs more than Nash
  allInCallDeviation: number;           // e.g., -0.30 = over-folds vs all-in
  
  confidenceScore: number;  // 0.0–1.0; scales weight of adjustments
  lastUpdatedHand: number;
}
```

These profiles are converted into `ExploitWeights` consumed by the policy service.

### 4.4 LLM Prompt Design

The sidecar sends structured hand history summaries to the LLM. The prompt is deterministic and templated — the LLM is not being asked to reason about strategy from first principles; it is being asked to extract pattern features from hand histories.

**System prompt:**

```
You are an opponent-modeling module for a poker agent. You receive
structured hand histories and output JSON containing estimated 
deviations from Nash equilibrium play for specific opponent tendencies.

Output ONLY valid JSON matching this schema:
{
  "foldToThreeBetDeviation": <float -1.0 to 1.0>,
  "continuationBetCallDeviation": <float -1.0 to 1.0>,
  "bluffFrequencyDeviation": <float -1.0 to 1.0>,
  "allInCallDeviation": <float -1.0 to 1.0>,
  "confidenceScore": <float 0.0 to 1.0>,
  "reasoning": "<one sentence>"
}

If you have fewer than 5 hands of data for this opponent, 
return all deviations as 0.0 and confidence 0.1.
```

**User prompt (per opponent update):**

```
Opponent ID: <pubkey_short>
Hands observed: <n>

Recent hand history:
<structured JSON of last 10-20 hands involving this opponent>

Based on these hands, estimate how this opponent deviates from Nash equilibrium.
```

**Hand history format sent to LLM:**

```json
{
  "hands": [
    {
      "hand_id": "abc123",
      "positions": {"hero": "BTN", "villain": "BB"},
      "preflop_actions": [
        {"player": "villain", "action": "fold", "street": "preflop",
         "pot_size_bb": 1.5, "stack_depth_bb": 45}
      ],
      "showdown": null
    }
  ]
}
```

### 4.5 Update Cadence

The sidecar runs an update cycle after every hand. One LLM call per opponent observed in the hand (max 5 opponents). At 40 hands/hour and 5 opponents: 200 LLM calls/hour. At typical API pricing, this is negligible.

The sidecar does **not** block the main agent loop. If an update cycle is running when the next hand starts, it continues in the background. Weight updates are written to the local store; the policy service reads from the store at action time. A read-write mutex ensures consistency.

### 4.6 Confidence Decay

Confidence scores decay over time. If an opponent has not been seen in 10+ hands, their `confidenceScore` is multiplied by `0.9^n` where `n` is hands since last observation. At effectively zero confidence, the exploit weights reduce to zero and the agent falls back to pure blueprint.

### 4.7 Sidecar Failure Handling

If the LLM API is unavailable, times out, or returns malformed JSON, the sidecar logs the error, skips the update cycle, and continues. The agent falls back to pure blueprint for affected opponents. This is graceful degradation — the agent remains functional.

---

## 5. Solana Agent Kit Integration

### 5.1 Responsibilities

The Solana Agent Kit component handles all I/O with the outside world:

- Polling ER state for game updates
- Submitting fold / call / raise / all-in actions to the ER
- Registering the agent in the tournament
- Reading committed hand histories from L1

It is a thin wrapper — no strategy logic lives here.

### 5.2 State Polling

The agent polls the ER via WebSocket subscription where available, falling back to periodic RPC calls at 500ms intervals.

The ER state account the agent watches:

```typescript
interface ERTableState {
  tableId:          string;
  street:           "preflop" | "flop" | "turn" | "river" | "showdown";
  pot:              number;          // in chips
  communityCards:   Card[];          // visible to all
  seats: {
    [seatId: string]: {
      agentId:      string;
      stack:        number;
      lastAction:   Action | null;
      isActive:     boolean;
    }
  };
  currentActor:     string | null;   // agentId whose turn it is
  actionDeadline:   number;          // unix timestamp
  handId:           string;
  handComplete:     boolean;
}
```

The agent's own hole cards are fetched via a separate authorized TEE query using the agent keypair. This is a signed RPC call to the TEE endpoint; the enclave returns only this agent's cards.

### 5.3 Action Submission

```typescript
interface ActionSubmitter {
  // Submit an action to the ER.
  // Returns tx signature or throws if submission fails.
  submitAction(tableId: string, handId: string, action: Action): Promise<string>;
}
```

Action encoding for ER submission:

| Action | ER instruction | Parameters |
|---|---|---|
| `fold` | `table_fold` | `{tableId, handId, seatId}` |
| `call` | `table_call` | `{tableId, handId, seatId}` |
| `raise(0.5)` | `table_raise` | `{tableId, handId, seatId, amount: pot*0.5}` |
| `all-in` | `table_all_in` | `{tableId, handId, seatId}` |

**Retry policy:** On network failure, retry up to 3 times with 500ms backoff. If all retries fail, auto-fold. Log the failure with hand ID and action attempted.

**Nonce management:** Each action instruction includes a nonce derived from `(handId, seatId, actionSequenceNumber)`. Duplicate submissions are idempotent at the ER level.

### 5.4 Timeout Handling

The agent monitors `actionDeadline` from the ER state. If the deadline is within 2 seconds and no action has been submitted, the agent submits `fold` regardless of the blueprint recommendation. This prevents auto-fold penalties due to network latency.

```
if (now > actionDeadline - 2000ms && !actionSubmitted):
  submitAction({ type: "fold" })
```

### 5.5 Registration Flow

At tournament start, the agent registers via the tournament registry program (handled by the platform's on-chain programs). The Agent Kit component handles this CPI call:

```
1. Check if agent is already registered for this tournament
2. If not: call register_agent instruction with agent NFT + buy-in
3. Wait for confirmation
4. Log seat assignment
5. Enter main polling loop
```

---

## 6. Information State Management

### 6.1 What the Agent Knows

At any point during a hand, the agent can observe:

**Public state (readable by all agents):**
- Community cards (0–5 cards)
- Pot size
- All actions taken this hand by all players (fold, call, raise amounts)
- All players' stack sizes
- Position of each player
- Current street
- Who has acted and who is left to act

**Private state (readable only by this agent):**
- This agent's own hole cards (fetched from TEE via signed query)

**What the agent cannot observe:**
- Opponents' hole cards until showdown
- ER internal state beyond the table state account
- Other agents' strategy parameters or blueprint lookups

### 6.2 Hand State Representation

The agent maintains a local `HandContext` updated on each state poll:

```typescript
interface HandContext {
  handId:            string;
  street:            Street;
  holeCards:         [Card, Card];
  communityCards:    Card[];
  potSize:           number;
  effectiveStack:    number;   // min(hero stack, max opponent stack)
  heroPosition:      Position;
  facingBet:         number;   // 0 if no bet to call
  pot_odds:          number;   // facingBet / (potSize + facingBet)
  
  opponentActions: {
    [opponentId: string]: Action[];  // actions this hand, in order
  };
  
  streetHistory: {
    [street: string]: Action[];  // all actions per street
  };
}
```

### 6.3 Between-Hand State

The sidecar's `TendencyProfile` store persists in memory for the duration of the tournament session. It is not committed on-chain. If the agent process restarts mid-tournament, the sidecar starts fresh (confidence 0.1 for all opponents until new hands are observed).

A future improvement (v2) would serialize and restore the tendency store from a local file on process restart.

---

## 7. Agent Lifecycle

### 7.1 States

```
INITIALIZING → REGISTERED → WAITING_FOR_HAND → IN_HAND → HAND_COMPLETE
                                    ↑                          │
                                    └──────────────────────────┘
                   ELIMINATED (when stack = 0 and re-buy not allowed)
                   TOURNAMENT_COMPLETE (when tournament closes)
```

### 7.2 State Transitions

| From | To | Trigger |
|---|---|---|
| INITIALIZING | REGISTERED | `register_agent` confirmed on-chain |
| REGISTERED | WAITING_FOR_HAND | Tournament start signal from ER |
| WAITING_FOR_HAND | IN_HAND | ER state transitions to `currentActor != null` |
| IN_HAND | HAND_COMPLETE | ER state sets `handComplete: true` |
| HAND_COMPLETE | WAITING_FOR_HAND | Sidecar update queued; new hand begins |
| IN_HAND | ELIMINATED | Stack reaches 0 mid-hand |
| HAND_COMPLETE | ELIMINATED | Stack reaches 0 after payout |
| ELIMINATED / HAND_COMPLETE | TOURNAMENT_COMPLETE | Tournament closes on L1 |

### 7.3 Sit-Out Handling

If the agent process is running but not registered for a hand (e.g., joining a table mid-tournament), it submits `sit_out` and waits. When a new hand begins with available seating, it submits `sit_in`.

---

## 8. Inter-Component Interfaces

### 8.1 Blueprint Service ↔ Main Loop

Synchronous in-process function call. The blueprint service exposes a `getDistribution(state: GameState)` function. No IPC, no network. The lookup table is loaded into the same process memory.

### 8.2 Sidecar ↔ Blueprint Service

The sidecar writes to a `WeightStore` (in-memory map from opponent ID to `ExploitWeights`). The policy service reads from the same `WeightStore` at action time. Access is protected by a read-write mutex.

```typescript
// WeightStore interface
interface WeightStore {
  getWeights(opponentId: string): ExploitWeights | null;
  setWeights(opponentId: string, weights: ExploitWeights): void;
}

// Thread-safe in v1: single writer (sidecar), single reader (main loop)
```

### 8.3 Sidecar ↔ L1

The sidecar reads committed hand histories from L1 via standard Solana RPC. It fetches the hand history account by hand ID after the main loop signals `handComplete`. No write path — the sidecar only reads.

### 8.4 Agent Kit ↔ ER

WebSocket subscription (preferred) or 500ms polling fallback. All ER writes go through signed transactions constructed by Agent Kit.

---

## 9. Configuration & Extensibility

### 9.1 Per-Agent Configuration

```toml
[agent]
name            = "agent-alpha"
keypair_path    = "./keys/agent-alpha.json"
tournament_id   = "Gh4k..."

[rpc]
er_endpoint     = "wss://er.magicblock.app/..."
l1_endpoint     = "https://api.devnet.solana.com"
poll_interval_ms = 500

[blueprint]
path            = "./data/blueprint_v1.bin"
variant         = "short-deck"

[sidecar]
enabled         = true
llm_provider    = "anthropic"         # or "openai", "local"
llm_model       = "claude-sonnet-4-6"
api_key_env     = "LLM_API_KEY"
max_hands_context = 20               # hands sent to LLM per update
confidence_decay_rate = 0.9
min_hands_before_exploit = 5

[exploit_weights]
max_weight      = 0.5
min_weight      = -0.5

[timeouts]
action_deadline_buffer_ms = 2000     # submit fold this many ms before deadline
rpc_timeout_ms  = 3000
llm_timeout_ms  = 10000

[logging]
level           = "info"             # debug | info | warn | error
log_file        = "./logs/agent.log"
```

### 9.2 Swappable Components

The blueprint service and the sidecar both expose stable interfaces (Section 8). To swap in a different decision engine (e.g., a stronger NLHE blueprint when available), only the blueprint binary changes — the rest of the agent is unchanged.

To swap to a different LLM provider for the sidecar, change `llm_provider` in config. The prompt template is provider-agnostic.

### 9.3 Running Without a Sidecar

Set `sidecar.enabled = false`. The agent uses pure blueprint with no exploit adjustments. This is the default for operators who do not supply an LLM API key.

---

## 10. Observability & Logging

### 10.1 Structured Log Events

All log lines are structured JSON. Key events:

```json
{"event": "hand_started", "hand_id": "abc", "street": "preflop", "hole_cards": ["Ah", "Kd"], "position": "BTN"}
{"event": "decision_made", "hand_id": "abc", "bucket": 1234, "distribution": [0.1, 0.4, 0.3, 0.2], "action": "call", "exploit_weights_applied": true}
{"event": "action_submitted", "hand_id": "abc", "action": "call", "tx": "sig123", "latency_ms": 87}
{"event": "hand_complete", "hand_id": "abc", "result": "won", "amount": 45}
{"event": "sidecar_update", "opponent_id": "xyz", "hands_observed": 12, "confidence": 0.74, "deviations": {...}}
{"event": "sidecar_error", "opponent_id": "xyz", "error": "llm_timeout", "fallback": "pure_blueprint"}
{"event": "action_timeout_approaching", "hand_id": "abc", "ms_remaining": 2100, "forcing_fold": false}
```

### 10.2 Metrics (v1: file-based, no external sink)

Appended to a local metrics file every 10 hands:

| Metric | Description |
|---|---|
| `hands_played` | Total hands completed |
| `hands_won` | Hands won (took pot) |
| `chips_won_net` | Net chip change since session start |
| `avg_decision_latency_ms` | Average time from poll to action submission |
| `blueprint_lookups` | Total blueprint lookups |
| `sidecar_updates` | Successful LLM update cycles |
| `sidecar_errors` | Failed LLM calls (timeout, malformed JSON, etc.) |
| `action_timeouts` | Times agent forced to fold due to deadline pressure |

### 10.3 What to Watch During Development

The three numbers that tell you if the agent is working:

1. `avg_decision_latency_ms` — should be < 100ms. If > 500ms, something is blocking the main loop.
2. `action_timeouts` — should be 0 or near-zero. Nonzero means polling or submission is too slow.
3. `sidecar_errors / sidecar_updates` — high error rate means the LLM provider is flaky or the prompt is producing malformed output.

---

## 11. Testing Strategy

### 11.1 Unit Tests

**Blueprint Policy Service**
- Load a hand-crafted minimal blueprint (10 buckets). Verify lookup correctness.
- Verify `computeBucket` is deterministic for same input.
- Verify `sampleAction` samples from the distribution (statistical test over 10,000 samples).
- Verify exploit weight application: known weights produce expected shifts.

**Information Set Bucketing**
- Test each bucket dimension independently with known inputs.
- Test boundary conditions: exactly 20BB stack (S0 vs S1 boundary), exactly 50% equity.
- Test that all 7,680 bucket keys are reachable.

**Sidecar**
- Mock the LLM API. Verify correct prompt construction for known hand histories.
- Verify confidence decay formula.
- Verify graceful fallback on API timeout (pure blueprint used).
- Verify weight bounds are enforced after application.

**Solana Agent Kit**
- Mock the ER RPC. Verify action encoding for each action type.
- Verify retry logic on RPC failure.
- Verify timeout-forced-fold triggers at correct deadline.

### 11.2 Integration Tests

**Call-station vs call-station (sanity check)**
- Both agents always call. Expected result: random winner, chips transfer to one side. Verifies the full loop works.

**Tight-aggressive vs call-station (expected behavior)**
- TA agent uses hardcoded thresholds (premium hands raise, trash folds). Call-station calls everything.
- Expected: TA agent wins significantly more than 50% over 100 hands.
- This test does NOT use the blueprint. It validates the loop, not the strategy.

**Blueprint agent vs call-station**
- Expected: blueprint agent wins > 70% of hands over 1,000 hands.
- Validates that the blueprint is correctly loaded and producing sensible decisions.

**Blueprint vs blueprint**
- Expected: near-50% win rate for both over 1,000 hands (Nash equilibrium approximation).
- Validates that the blueprint is close to Nash and not systematically exploitable.

### 11.3 Sidecar Validation (v2 scope, noted here for completeness)

- Blueprint + sidecar vs blueprint (no sidecar): expect sidecar-enabled agent to show meaningful win rate improvement vs call-station opponent.
- Blueprint + sidecar vs blueprint + sidecar: expect near 50/50 (sidecar cancels out when both sides use it).

---

## 12. Build Order

The agent-specific build order, independent of blockchain milestones:

### Step 1: Blueprint Solve

Produce the strategy binary before writing any agent code. Nothing else can be validated without a real blueprint.

- Implement the constrained variant game in OpenSpiel
- Run CFR+ to convergence (exploitability < 5%)
- Export `blueprint_v1.bin`
- Write a standalone verifier that loads the binary and reports exploitability

**Exit criteria:** `blueprint_v1.bin` exists and exploitability < 5%. Takes days of wall-clock time. Start it first.

### Step 2: Blueprint Policy Service

- Implement `computeBucket` for all 5 dimensions
- Implement binary loader
- Implement `lookup` and `sampleAction`
- Unit tests pass

**Exit criteria:** Policy service loads binary, returns correct distributions, samples correctly.

### Step 3: Solana Agent Kit Wrapper

- ER state polling (mock ER for this step)
- Action submission (mock ER)
- Timeout-forced-fold logic
- Unit tests with mock ER

**Exit criteria:** Agent polls mock ER, submits correct action encoding, handles timeout correctly.

### Step 4: End-to-End with Scripted Agents

- Wire policy service + agent kit
- Run two scripted agents (call-station, tight-aggressive) against each other on a real ER table
- Validate full loop: deal → decision → action → commit → new hand

**Exit criteria:** 100 hands complete without error. Results match expected behavior.

### Step 5: Blueprint Agents End-to-End

- Swap scripted agents for blueprint agents
- Run 1,000 hands blueprint vs call-station
- Measure win rate and decision latency

**Exit criteria:** Blueprint agent wins > 70% vs call-station. `avg_decision_latency_ms` < 100ms.

### Step 6: LLM Sidecar

- Implement hand history fetcher from L1
- Implement LLM prompt constructor
- Implement tendency profile store with confidence decay
- Wire into policy service via WeightStore
- Run sidecar-enabled vs call-station (verify weights are updating)
- Run sidecar-enabled vs pure blueprint (expect marginal improvement)

**Exit criteria:** Sidecar updates run successfully between hands. No action timeout regressions. Exploits a clearly exploitable opponent (all-fold or all-call agent) measurably faster than pure blueprint.

---

## 13. Open Questions

### Resolved for v1

These decisions are final:

- **Constrained variant:** Short-deck (36-card). Smaller game tree than capped-bet, cleaner structure.
- **CFR algorithm:** CFR+. Faster convergence than vanilla CFR for this bucket count.
- **Exploit weight bounds:** ±0.5. Prevents degenerate distributions while allowing meaningful adjustment.
- **Sidecar update cadence:** After every hand, per opponent observed. Not batched.
- **Sidecar failure mode:** Graceful fallback to pure blueprint. No circuit breaker needed at v1 scale.

### Open for Decision Before Step 1

1. **Short-deck game tree implementation**: Is there an existing OpenSpiel short-deck environment, or do we implement a custom game? Confirm before starting the solve.

2. **Bucket count tuning**: 7,680 total buckets is a starting point. If exploitability is too high at convergence, increase equity buckets from 5 to 10 (total: 15,360). Decide after first solve attempt.

3. **LLM provider**: Anthropic (claude-sonnet-4-6) is the default. Does the operator's BYOK requirement mean we also need to support OpenAI-compatible endpoints? If yes, abstract the LLM client interface before Step 6.

4. **Sidecar memory across restarts**: v1 loses tendency profiles on process restart. Is this acceptable for hackathon/demo context? If not, add SQLite persistence in Step 6.

5. **Multi-table agent**: Can a single agent process manage seats at multiple tables simultaneously? v1 assumes one process per seat. Multi-table support is architecturally straightforward (parallel main loops) but needs explicit scoping.

---

*Document owner: Paramarsh Labs*
*Last updated: June 2025*
*Status: Approved for v1 development*