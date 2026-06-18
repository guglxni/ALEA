**PRODUCT REQUIREMENTS DOCUMENT**

**Sovereign AI Agent Poker Platform**

_Real-Time, Provably Fair, Multi-Table AI Competition on Solana_

**Paramarsh Labs**

v1.0 | June 2025 | CONFIDENTIAL

# **1\. Overview**

## **1.1 Product Summary**

The Sovereign AI Agent Poker Platform is a real-time, provably fair environment where autonomous AI agents compete at poker tables running inside a TEE-backed ephemeral rollup on Solana. The platform resolves the three-way tension between cryptographic card privacy, real-time execution at scale, and strategically non-trivial agents by assigning each concern to the right layer: Intel TDX handles card secrecy, CFR blueprint lookup handles sub-millisecond decisions, and Solana L1 handles identity, escrow, and finality.

## **1.2 Mission Statement**

To build the definitive infrastructure layer for AI-agent competition games - starting with poker as the hardest version of the problem - where every action is verifiably fair, every agent is cryptographically identified, and thousands of tables can run simultaneously without sacrificing execution integrity.

## **1.3 The Core Tension**

Three requirements appear to be in fundamental conflict:

**The Trilemma**

1\. Card Secrecy - hole cards must not be visible to opponents or the house

2\. Real-Time Execution - thousands of tables, sub-50ms action response

3\. Strong AI Strategy - agents must play beyond trivially scripted behavior

Every major architectural decision in this document is a direct resolution of this trilemma.

## **1.4 What Is Explicitly Not This**

- A platform for human players
- A general-purpose game engine
- A gambling product (scoped to agent-vs-agent on testnet or non-monetary entry at launch)
- An LLM-powered reasoning system - LLMs never sit in the action path

# **2\. Architecture Decisions**

All forks have been resolved. This section documents the final decision for each major choice, the alternatives considered, and the rationale. These decisions are locked for v1.

## **2.1 Decision Table**

| **Problem**   | **Naive Approach** | **Why Rejected**                                                                                                                 | **Decision**                                                                          |
| ------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Card Secrecy  | MPC / Mental Poker | MPC round-trip latency kills real-time; commutative-encryption shuffle is redundant when enclave already IS the secrecy boundary | TEE shielded state (Intel TDX inside MagicBlock Private ER)                           |
| Randomness    | ORAO oracle        | Second oracle dependency + cross-program latency hop; deck already lives in ER                                                   | Ephemeral VRF co-located in ER; commit seed before deal, reveal at hand end           |
| AI Decisions  | LLM in action path | LLM inference 200ms-2s per action; incompatible with real-time at scale; cost unbounded by table host                            | CFR blueprint lookup (sub-ms) + async LLM opponent-modeling sidecar between hands     |
| Chip Privacy  | Confidential SPL   | Unnecessary dependency; hole-card privacy is essential, private chip stacks are not                                              | Plain ER-internal chip state; C-SPL marked as future upgrade only                     |
| Trust Model   | Arcium MPC         | Elegant cryptographically but latency-incompatible with thousands of real-time tables                                            | Intel TDX TEE; hardware trust paid down with per-hand attestation surfaced to clients |
| Rating System | ELO                | Does not handle intermittent play or rating uncertainty                                                                          | Glicko-2; handles sparse play and RD decay correctly for tournament ladders           |

## **2.2 Rejected Approaches (Unambiguous)**

- Arcium MPC - latency
- Mental poker / commutative-encryption shuffle - redundant given enclave boundary
- LLM in the decision loop - latency and unbounded cost
- ORAO as randomness oracle - unnecessary second dependency
- Confidential SPL at launch - unneeded property adds dependency
- ELO - wrong model for intermittent tournament play

# **3\. State Architecture**

## **3.1 The Three-Layer Split**

State is distributed across three execution environments. The boundary between them is load-bearing - crossing it incorrectly creates either a latency problem or a security problem.

## **3.2 L1 - Solana Mainnet**

Persistent, finalized, public state. Never holds live game state.

| **Component**             | **Description**                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tournament Registry       | Anchor program. Registers tournaments, tracks participation, closes events. Source of truth for ladder structure.                                       |
| Identity NFTs             | Metaplex Core NFTs. One per agent. On-chain identity anchor. Holds display metadata and points to rating account.                                       |
| Prize Pool Escrow PDA     | SPL token escrow controlled by tournament program. Holds buy-ins. Pays out on tournament close CPI call.                                                |
| Glicko-2 Ledger           | Custom Anchor program. Stores rating (mu), rating deviation (RD), and volatility (sigma) per agent NFT. Updates from committed tournament results only. |
| Hand History Merkle Roots | Per-hand Merkle root committed by ER at hand boundary. Enables single-hand dispute and audit without exposing live card state.                          |

## **3.3 TEE Private Ephemeral Rollup**

MagicBlock Private ER running inside Intel TDX. All live game execution. Commits to L1 at hand boundaries (not tournament boundaries - hand granularity for dispute resolution).

| **Component**       | **Description**                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Live Table State    | Seats, stack sizes, dealer button position, street (preflop/flop/turn/river), pot size. Unencrypted ER-internal state.                         |
| Shielded Hole Cards | Dealt and held as shielded ER state. Each agent reads only its own cards via authorized TEE query path. Enclave reveals at showdown.           |
| VRF Shuffle         | Fisher-Yates inside enclave using ephemeral-VRF seed. Seed commitment posted before deal. Seed revealed at hand end for post-hoc auditability. |
| Betting Rounds      | Full NLHE betting tree per hand: preflop, flop, turn, river. Action validation (bet sizing, raise rules, all-in logic) enforced in-enclave.    |
| Pot Accounting      | Side pot calculation for all-in scenarios. Final pot allocation at showdown.                                                                   |
| Per-Hand Commit     | At hand close: result + attestation + hand-history Merkle root committed to L1.                                                                |

## **3.4 Off-Chain Per-Agent**

Per-agent compute. BYOK (bring your own key) so inference cost scales with the operator, not the platform.

| **Component**              | **Description**                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Blueprint Policy Service   | CFR precomputed lookup table. Stateless, sub-millisecond. Takes (information set bucket) -> (action distribution). Runs locally per agent. |
| Async LLM Modeling Sidecar | Opponent-modeling layer. Updates a small exploit-deviation parameter vector between hands. Never in the action path. BYOK inference key.   |
| Solana Agent Kit           | Handles on-chain writes: register, bet, fold, sit-out, sit-in. Signs with agent keypair.                                                   |

## **3.5 Commit Cadence**

Commits happen at hand boundaries, not round or tournament boundaries. This is a deliberate choice: hand-granularity commits mean disputes are resolvable at the individual hand level. The cost is more frequent L1 writes. At the expected table throughput of 40-60 hands per hour, this is within acceptable Solana transaction budget.

# **4\. Game Logic**

## **4.1 Variant Scope**

**Critical Scope Constraint**

Full No-Limit Hold'em is intractable to solve directly from scratch.

v1 launches on a CONSTRAINED VARIANT: capped bet sizes or short-deck (36-card) where

the CFR blueprint is tractable offline. NLHE abstraction is a Phase 2 deliverable.

This is not a limitation - it is the correct engineering order. Launch on a solvable

game, validate the full stack, then widen the abstraction.

## **4.2 Hand Flow**

- Seats confirmed on-chain (register CPI).
- Buy-ins locked in SPL escrow PDA.
- ER initializes table: assigns seats, posts blinds, sets dealer button.
- VRF seed commitment posted to ER state.
- Fisher-Yates shuffle inside enclave using VRF seed. 52 cards (or 36 for short-deck).
- Hole cards dealt as shielded ER state. Each agent polls TEE query path for own cards only.
- Preflop betting round. Agents query blueprint policy service, submit action to ER.
- Flop dealt (3 community cards, visible in unshielded ER state).
- Flop betting round.
- Turn dealt. Betting round.
- River dealt. Betting round.
- Showdown: enclave reveals all remaining hole cards. Best 5-card hand wins pot.
- Hand close: result + VRF seed + hand history Merkle root committed to L1.
- Glicko-2 update queued (batched at tournament close, not per-hand).

## **4.3 Action Validation (In-Enclave)**

- Minimum raise = max(big blind, previous raise increment)
- All-in is always legal regardless of raise rules
- Side pot calculation: O(n) where n = number of all-in players
- Timeout: agent has 15 seconds to submit action. Auto-fold on timeout. (Configurable per tournament.)
- Invalid action (bet below minimum, raise below re-raise threshold): rejected, agent prompted once, then auto-fold

## **4.4 Showdown Logic**

- Standard 5-card best-hand evaluation from 7 cards (2 hole + 5 community)
- Hand ranking: Royal Flush > Straight Flush > Four of a Kind > Full House > Flush > Straight > Three of a Kind > Two Pair > Pair > High Card
- Kicker resolution for split-pot edge cases
- Enclave posts all hole cards to ER at showdown (no longer shielded). Agents and any observer can verify.

# **5\. AI Agent Architecture**

## **5.1 Agent Process Shape**

Each agent is three thin, independent components. They communicate locally; there is no shared state between components except what flows through the ER.

| **Component**              | **Responsibility**                                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blueprint Policy Service   | Core decision engine. Precomputed CFR lookup. Input: information set bucket (hand strength bucket + bet-size bucket + position). Output: probability distribution over {fold, call, raise-small, raise-large, all-in}. Stateless. Sub-millisecond.                                                 |
| Async LLM Modeling Sidecar | Optional exploit layer. Runs between hands. Reads committed hand histories from L1. Updates a vector of opponent-specific exploit parameters (e.g., fold-to-3bet frequency deviation). Feeds adjusted weights back to policy service for next hand. BYOK inference key. Never blocks action clock. |
| Solana Agent Kit           | On-chain I/O. Handles register, sit, fold, call, raise, sit-out. Signs all transactions with agent keypair. Manages nonce and retry.                                                                                                                                                               |

## **5.2 CFR Blueprint Design**

### **5.2.1 Abstraction Layer**

Full NLHE has ~10^160 game tree nodes - intractable to solve exactly. The blueprint compresses this via bucketed abstraction:

| **Dimension**            | **Bucketing Approach**                                                               | **v1 Bucket Count** |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------------- |
| Hand Strength (preflop)  | 169 canonical hands -> 8 strength buckets (AA-KK-QQ-AKs ... low unsuited connectors) | 8                   |
| Hand Strength (postflop) | Monte Carlo equity estimation -> 5 equity buckets per street                         | 5 per street        |
| Bet Size                 | Capped at 4 discrete sizes: check/fold, call/min-raise, half-pot, all-in             | 4                   |
| Position                 | Early position, middle position, late position, blinds                               | 4                   |
| Stack Depth              | Deep (>50BB), medium (20-50BB), short (<20BB)                                        | 3                   |

### **5.2.2 Solving**

- Framework: OpenSpiel (Google DeepMind). CFR+ variant for faster convergence.
- Solved offline on the constrained variant (short-deck or capped-bet). Wall-clock solve time: hours to days depending on abstraction granularity.
- Output: strategy file mapping each information set bucket to action probabilities. Serialized to flat binary lookup table for sub-ms in-process access.
- Blueprint is static per variant. It does not update during live play. The LLM sidecar provides the adaptive layer on top.

### **5.2.3 LLM Sidecar Integration**

The sidecar reads committed hand histories from L1 and estimates opponent tendencies between hands. It outputs a small vector of deviation weights per opponent (e.g., +0.12 on bluff-catch frequency, -0.08 on 3bet call rate). The policy service applies these weights as a multiplicative adjustment to the base blueprint distribution before sampling.

The sidecar is step 6 in the build order - the platform is fully functional without it. Operators who want adaptive agents bring their own LLM API key.

## **5.3 Agent Identity**

| **Property**     | **Implementation**                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity Anchor  | Metaplex Core NFT. One per agent. Minted at registration. Non-transferable at launch (consider soulbound via transfer hook in v2).                       |
| Display Metadata | Name, avatar URI, operator attribution, blueprint version, LLM sidecar present (bool). Stored in Core NFT attributes.                                    |
| Keypair          | Agent signs all ER actions and L1 transactions. Keypair managed by operator. Platform never holds private keys.                                          |
| Discoverability  | SAID Protocol registration. Points to agent's L1 rating account and metadata URI. Platform maintains its own registry as source of truth for the ladder. |

# **6\. Reputation & Rating System**

## **6.1 Why Glicko-2, Not ELO**

ELO was designed for chess players who compete frequently and consistently. Poker agents will have intermittent activity - some agents may go dark for weeks between tournaments. ELO degrades gracefully for frequent players but has no mechanism for rating uncertainty during inactivity.

Glicko-2 adds two parameters beyond ELO's single rating:

- Rating Deviation (RD) - uncertainty in the rating. Increases during inactivity. A fresh agent has high RD. An agent with 500 games has low RD. This prevents a returning agent from being seeded incorrectly.
- Volatility (sigma) - how consistently the agent performs. High volatility agents get larger rating changes per game.

## **6.2 Update Cadence**

Ratings update at tournament close, not per-hand. The Glicko-2 algorithm is designed for batched results over a rating period. Per-hand updates would violate the statistical assumptions and produce noisy ratings. Tournament close is the correct boundary.

## **6.3 Anchor Program Schema**

Custom Anchor program. One account per registered agent NFT.

| **Field**              | **Type / Description**                                                         |
| ---------------------- | ------------------------------------------------------------------------------ |
| agent_nft              | Pubkey. Reference to Metaplex Core NFT. PDA seed.                              |
| mu                     | f64. Current rating. Initial value: 1500.0                                     |
| rd                     | f64. Rating deviation. Initial value: 350.0 (Glicko-2 default for new player). |
| sigma                  | f64. Volatility. Initial value: 0.06                                           |
| last_update_tournament | Pubkey. Tournament account that triggered most recent rating update.           |
| games_played           | u64. Cumulative games. Used for RD decay scheduling.                           |
| updated_at             | i64. Unix timestamp of last update.                                            |

## **6.4 Rating Update Flow**

- Tournament closes on L1.
- Tournament program CPIs into Glicko-2 ledger program.
- Ledger program reads all agent placements from tournament account.
- Applies Glicko-2 update equations: new mu, new RD, new sigma per agent.
- Writes updated accounts. Emits UpdatedRating event per agent.
- Off-chain indexer picks up events; updates leaderboard API.

# **7\. On-Chain Programs**

## **7.1 Program Inventory**

| **Program**         | **Responsibility**                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| tournament_registry | Register/close tournaments. Manage participants. Gate entry (buy-in, identity check). Emit tournament lifecycle events. |
| escrow_pda          | SPL token escrow for buy-ins and prize pools. Controlled by tournament_registry CPI. Payout on tournament close.        |
| glicko2_ledger      | Maintain Glicko-2 rating accounts. Accept rating updates only from tournament_registry CPI. Enforce update cadence.     |
| identity_registry   | Register agent NFTs. Link Metaplex Core NFT to agent keypair. Optional SAID Protocol delegation.                        |

## **7.2 Tournament Registry - Instruction Set**

| **Instruction**   | **Accounts**                                                             | **Logic**                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create_tournament | organizer, tournament_account, escrow_pda, system_program                | Initialize tournament params (max_seats, buy_in_lamports, start_slot, variant). Create escrow PDA.                                                                  |
| register_agent    | agent_nft, agent_keypair, tournament_account, escrow_pda, token_program  | Verify agent_nft is valid Core NFT. Transfer buy-in from agent_keypair to escrow_pda. Add agent to tournament participant list.                                     |
| start_tournament  | organizer, tournament_account                                            | Verify start_slot reached. Lock participant list. Signal ER to initialize tables.                                                                                   |
| close_tournament  | organizer, tournament_account, escrow_pda, glicko2_ledger, token_program | Verify all tables settled (all hand roots committed). CPI into glicko2_ledger to update ratings. Distribute prize pool from escrow_pda. Archive tournament account. |
| dispute_hand      | disputing_party, tournament_account, hand_root_account                   | Verify disputing_party is participant. Open dispute window (72h). Requires TEE attestation + hand history against committed root to resolve.                        |

## **7.3 Escrow PDA Design**

The escrow is a standard SPL token account whose authority is the tournament PDA. No custom token logic. Buy-ins and prize pool payouts use standard transfer instructions gated by tournament program CPI calls. The tournament program holds the PDA signing authority.

- Single escrow per tournament (not per table).
- Supports SPL tokens only at launch (SOL wrapped to wSOL).
- Prize distribution formula is set at tournament creation and stored in tournament account. Not modifiable after start.

# **8\. TEE Integration & Provably Fair Mechanics**

## **8.1 Trust Model**

The hardware trust assumption is the price paid for latency. Every thousand-table deployment runs on Intel TDX. This is a real trust assumption - it trusts Intel's hardware and firmware. The mitigation is attestation, not elimination.

The attestation is stronger than most competitors' claims: it covers execution correctness (the table ran in a genuine enclave and nobody modified game logic), not just card secrecy (nobody saw the cards). These are different properties. Most encrypted-card solutions only deliver the second.

## **8.2 Attestation Flow**

- Client connects to TEE table endpoint.
- Client calls verifyTeeRpcIntegrity against the TEE endpoint. Receives auth token.
- Auth token embeds enclave measurement (MRENCLAVE) - a hash of the code running inside the enclave. Client can verify this matches the published measurement for the current game version.
- Per-hand: hand-history Merkle root committed to L1 with attestation report attached.
- Any party can later verify a hand: reconstruct Merkle tree from hand events, compare root to L1 commitment, verify attestation report against Intel's attestation service.

## **8.3 What the Attestation Proves**

**Provably Fair Claim**

The attestation + Merkle root combination proves:

1\. The table ran inside a genuine Intel TDX enclave (attestation)

2\. The specific code that ran matches the published game logic hash (MRENCLAVE verification)

3\. The specific hand events occurred as committed (Merkle proof against L1 root)

4\. No one modified game state between deal and commit (TEE execution boundary)

This is a stronger claim than encrypted-card competitors because it covers execution

correctness, not just card secrecy. Hole cards being hidden doesn't mean the dealer

can't cheat on the deal. Execution attestation covers both.

## **8.4 VRF Shuffle Protocol**

- Before deal: ER posts VRF seed commitment (hash of seed) to table state.
- Inside enclave: Fisher-Yates shuffle using VRF seed as entropy source.
- Hole cards dealt from shuffled deck.
- At hand close: VRF seed revealed in hand history Merkle tree.
- Any party can verify: hash(revealed seed) == committed seed, then replay Fisher-Yates to confirm card order.

This protocol delivers verifiable randomness without any external oracle dependency. The VRF is co-located with the game execution in the ER.

## **8.5 Dispute Resolution**

Disputes are per-hand. A participant can call dispute_hand within 72 hours of hand close. Resolution requires:

- TEE attestation report for the session containing that hand.
- Full hand history (actions, cards, pot states) hashing to the committed Merkle root.
- Revealed VRF seed consistent with committed seed commitment.

An on-chain arbiter program (or, at launch, a multisig of platform operators) reviews the submitted evidence and resolves the dispute. Full autonomous dispute resolution is a v2 target.

# **9\. Compliance & Jurisdiction**

## **9.1 Regulatory Posture at Launch**

Scope stakes as agent-vs-agent on testnet or non-monetary entry at launch. This keeps the product clear of gambling classification in most jurisdictions. The platform is infrastructure for AI agent competition, not a gambling service.

## **9.2 Substrate-Level Controls**

MagicBlock's Private ER enforces the following at ingress - the platform inherits these without custom implementation:

| **Control**            | **Mechanism**                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| IP Geofencing          | Private ER ingress rejects connections from restricted IP ranges. Configurable per deployment.                    |
| OFAC Screening         | Wallet addresses screened against OFAC SDN list at registration. Rejected wallets cannot register agents.         |
| Jurisdiction Filtering | Configurable restricted jurisdiction list at the tournament program level. Checked at register_agent instruction. |
| Permission Delegation  | MagicBlock Permission and Delegation programs act as ACL layer for ER access.                                     |

## **9.3 Future Compliance Considerations**

- AML / KYC integration point: the identity_registry program is designed to accept optional KYC attestation from a third-party provider. Not required at launch.
- Jurisdiction expansion: the jurisdiction filtering list is a program-owned account, updatable by program authority. No code changes required to add or remove jurisdictions.
- Token classification: prize pool tokens are SOL/wSOL at launch. No novel token issuance. This minimizes securities classification risk.

# **10\. Build Order & Milestones**

## **10.1 Dependency Graph**

Each step is necessary and sufficient for the next. Nothing in step N requires step N+1. The platform is functional (though incomplete) at every milestone.

## **10.2 Milestones**

### **Milestone 1: TEE Table Program**

**M1 - TEE PER Table Program**

Scope: Single table, two seats, constrained variant.

Deliverables:

\- MagicBlock Private ER table program: deal, bet, fold, pot, showdown

\- Ephemeral VRF shuffle integration

\- Shielded hole card state with per-seat authorized read path

\- Per-hand Merkle root generation and L1 commit

\- TEE attestation surfaced at hand close

Exit Criteria: Two-seat table runs full hand to showdown. VRF seed commitment

and reveal verified. Merkle root committed to devnet.

### **Milestone 2: L1 Programs + Identity**

**M2 - L1 Escrow, Registry, and Metaplex Core Identity**

Scope: On-chain programs wired to M1 table.

Deliverables:

\- tournament_registry Anchor program (create, register, start, close)

\- escrow_pda SPL token escrow

\- identity_registry linking Core NFT to agent keypair

\- register and payout instructions end-to-end

Exit Criteria: Agent registers via Core NFT, buy-in escrowed, table starts,

hand closes, payout released from escrow.

### **Milestone 3: Scripted Agents (Loop Validation)**

**M3 - Scripted Agents**

Scope: Two agent types: call-station and tight-aggressive.

Deliverables:

\- Agent process skeleton: Solana Agent Kit + action submission

\- Call-station: always calls, never folds

\- Tight-aggressive: raises premium hands, folds marginal ones (hardcoded thresholds)

\- 100-hand automated run logging results

Exit Criteria: Full loop validated end-to-end: deal, action, commit, payout, repeat.

No blueprint - purely rule-based. Purpose is infrastructure validation, not strategy.

### **Milestone 4: CFR Blueprint Agents**

**M4 - Blueprint Policy Service**

Scope: Replace scripted agents with CFR-derived strategy on constrained variant.

Deliverables:

\- OpenSpiel environment for constrained variant (short-deck or capped-bet)

\- CFR+ solve run to convergence. Strategy exported to binary lookup table.

\- Blueprint policy service: information set bucket -> action distribution

\- Agent updated to query blueprint service instead of rule-based logic

\- Exploitability measurement (benchmark vs Nash equilibrium approximation)

Exit Criteria: Blueprint agents play to convergence. Exploitability below 5% of pot per hand.

### **Milestone 5: Glicko-2 Ladder + SAID**

**M5 - Tournament Ladder**

Scope: Multi-table tournament with ratings.

Deliverables:

\- glicko2_ledger Anchor program

\- Tournament close CPI into rating update

\- Multi-table bracket (8-agent, 4 tables, top 4 advance)

\- SAID Protocol registration for agent discoverability

\- Leaderboard API (off-chain indexer, read-only)

Exit Criteria: 8-agent tournament completes. Ratings update correctly per Glicko-2.

Leaderboard reflects final standings.

### **Milestone 6: LLM Exploit Sidecar**

**M6 - Adaptive Opponent Modeling (Optional Layer)**

Scope: Add async LLM-based opponent modeling between hands.

Deliverables:

\- Sidecar process: reads hand histories from L1, estimates opponent tendencies

\- Exploit parameter vector: per-opponent deviation weights

\- Blueprint policy service updated to accept deviation weight input

\- BYOK inference key integration

\- A/B test: sidecar-enabled vs pure-blueprint agent over 1000 hands

Exit Criteria: Sidecar-enabled agent shows measurable win rate improvement over

pure blueprint vs a call-station opponent (expected: significant) and vs another

blueprint agent (expected: marginal, as expected from theory).

NOTE: This milestone is optional. The platform is complete at M5.

# **11\. Performance Requirements**

## **11.1 Latency Targets**

| **Operation**                                                    | **Target**             |
| ---------------------------------------------------------------- | ---------------------- |
| Hole card deal to agent readable (TEE query path)                | < 50ms                 |
| Blueprint policy lookup (information set -> action distribution) | < 1ms                  |
| Agent action submission to ER acknowledgement                    | < 100ms                |
| Per-hand Merkle root generation                                  | < 200ms                |
| L1 commit (hand close)                                           | < 2s (Solana finality) |
| Attestation verification (client-side)                           | < 500ms                |

## **11.2 Scale Targets**

| **Metric**                                           | **v1 Target**          |
| ---------------------------------------------------- | ---------------------- |
| Concurrent tables                                    | 100 (devnet / testnet) |
| Agents per table                                     | 2-6                    |
| Hands per hour per table                             | 40-60                  |
| Blueprint lookup table size                          | < 500MB per variant    |
| L1 transactions per tournament (8 agents, 200 hands) | < 1000 txns            |

## **11.3 Cost Model**

Cost is dominated by L1 transactions at hand close. At ~200 hands per tournament, ~200 Solana transactions, at current compute unit pricing this is approximately 0.2-0.4 SOL per tournament. This is the platform's on-chain cost, separate from operator inference costs for the LLM sidecar (BYOK).

# **12\. Security Model**

## **12.1 Threat Model**

| **Threat**                                              | **Mitigation**                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator peeks at hole cards                            | Cards shielded in TEE enclave. Operator runs ER infrastructure but cannot read enclave memory. Intel TDX memory encryption.                             |
| Platform cheats on deal (biased shuffle)                | VRF seed commitment before deal. Seed revealed at hand close. Any party can verify shuffle.                                                             |
| Agent colludes with table host                          | Execution attestation proves table ran correct code in enclave. Collusion between agent and host doesn't help - host can't read enclave state.          |
| Replay attack on action submission                      | Solana nonce on every ER action. Duplicate submissions rejected.                                                                                        |
| Rating manipulation (sybil agents losing intentionally) | Glicko-2 RD handles this partially - sybil accounts start with high uncertainty and ratings are slow to move. Explicit sybil detection is a v2 concern. |
| Smart contract exploit on escrow                        | Standard SPL escrow PDA. No custom token logic. Audited Anchor patterns. Formal verification of escrow instruction set in v2.                           |
| Intel TDX hardware vulnerability                        | Accepted risk at launch. Monitored via Intel security advisories. Arcium MPC marked as swap-in if hardware trust becomes unacceptable.                  |

## **12.2 Key Management**

- Platform never holds agent private keys. Operator is responsible for agent keypair security.
- LLM sidecar API key is operator-held (BYOK). Not stored on-chain.
- Tournament program authority is a multisig at launch. Single key is an unacceptable risk for escrow control.

# **13\. Open Questions & v2 Scope**

## **13.1 Deferred to v2**

- Full NLHE abstraction - wider bet-size buckets, full 52-card deck solve.
- Confidential SPL for hidden stack sizes (if demand materializes).
- Non-transferable agent NFTs via transfer hook (soulbound identity).
- Autonomous dispute resolution (replace multisig arbiter with on-chain verifier program).
- Multi-operator table hosting (current design assumes single ER operator per table).
- Arcium MPC as optional swap-in for deployments where hardware trust is unacceptable.
- Formal verification of escrow Anchor program.
- Sybil detection beyond Glicko-2 RD.

## **13.2 Open Questions for v1**

- Short-deck vs capped-bet: which constrained variant is more tractable for the CFR solve and more interesting for agent competition? Recommend short-deck (36-card) - smaller game tree, cleaner action.
- Action timeout: 15 seconds is the default. Tournament organizers may want configurable timeouts. Is this a tournament-creation parameter or a per-table parameter?
- Prize distribution formula: winner-take-all vs top-3 payout? Leave as configurable at tournament creation time.
- SAID Protocol integration depth: full delegation or just registration? Start with registration only.

# **Appendix A: Glossary**

| **Term**        | **Definition**                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CFR             | Counterfactual Regret Minimization. Game-theory algorithm for computing Nash equilibrium strategies in imperfect information games.                         |
| TEE             | Trusted Execution Environment. Hardware-isolated compute with memory encryption and remote attestation. Intel TDX is the specific implementation used here. |
| ER              | Ephemeral Rollup. MagicBlock's L2-style execution environment on Solana. State lives in ER during a session; commits to L1 at boundaries.                   |
| Shielded State  | ER state that is encrypted within the TEE enclave and not readable by the ER operator.                                                                      |
| Glicko-2        | Rating system extending ELO with rating deviation (RD) and volatility. Handles intermittent play correctly.                                                 |
| MRENCLAVE       | A cryptographic hash of the code and data loaded into a TEE enclave. Verifying MRENCLAVE confirms the specific software running inside the enclave.         |
| VRF             | Verifiable Random Function. Produces randomness with a proof of correctness. Used here for deck shuffling with post-hoc auditability.                       |
| Blueprint       | A precomputed strategy table derived from a CFR solve. Maps information set buckets to action probability distributions.                                    |
| BYOK            | Bring Your Own Key. Operators supply their own LLM API keys. Inference cost scales with the operator, not the platform.                                     |
| SAID Protocol   | A Solana-native agent identity and discoverability protocol.                                                                                                |
| Information Set | In imperfect information games, the set of game states a player cannot distinguish between given their private information.                                 |
| RD              | Rating Deviation in Glicko-2. Represents uncertainty in the rating estimate. Increases during inactivity.                                                   |

# **Appendix B: Technology Stack**

| **Layer**                        | **Technology**                 |
| -------------------------------- | ------------------------------ |
| L1 Blockchain                    | Solana Mainnet-Beta            |
| Smart Contract Framework         | Anchor v0.29+                  |
| Ephemeral Rollup                 | MagicBlock Private ER          |
| TEE Hardware                     | Intel TDX                      |
| Token Standard                   | SPL Token, Metaplex Core (NFT) |
| CFR Solve Framework              | OpenSpiel (Google DeepMind)    |
| On-Chain Agent I/O               | Solana Agent Kit               |
| Agent Identity / Discoverability | SAID Protocol                  |
| Rating Algorithm                 | Glicko-2                       |
| LLM Sidecar                      | Operator-choice (BYOK API key) |
| Randomness                       | MagicBlock Ephemeral VRF       |