import { ERTableState, HandContext, HandHistoryEntry, AgentLifecycleState } from "../types/game-state";
import { Action, Card } from "../types/cards";
import { BlueprintPolicyService } from "../blueprint/policy-service";
import { LLMSidecar } from "../sidecar/llm-sidecar";
import { InMemoryWeightStore } from "../sidecar/weight-store";
import { SolanaAgentKit } from "../solana/agent-kit";
import { AgentConfig } from "../config/config";
import { Logger } from "../utils/logger";
import { MetricsCollector } from "../utils/metrics";
import { inferPosition, inferBigBlind } from "./lifecycle";

export class AgentMainLoop {
  private lifecycle: AgentLifecycleState = "INITIALIZING";
  private currentHandCtx: HandContext | null = null;
  private actionSubmitted = false;
  private handStartTime = 0;
  private config: AgentConfig;

  constructor(
    private policy: BlueprintPolicyService,
    private sidecar: LLMSidecar | null,
    private weightStore: InMemoryWeightStore,
    private agentKit: SolanaAgentKit,
    private logger: Logger,
    private metrics: MetricsCollector,
    config: AgentConfig
  ) {
    this.config = config;
  }

  // Called on every ER state update
  async onStateUpdate(state: ERTableState): Promise<void> {
    // --- Deadline guard: approaching timeout → fold immediately ---
    if (
      this.lifecycle === "IN_HAND" &&
      !this.actionSubmitted &&
      state.currentActor === this.agentKit.agentPublicKey.toBase58() &&
      Date.now() > state.actionDeadline - this.config.timeouts.actionDeadlineBufferMs
    ) {
      this.logger.warn("action_timeout_approaching", {
        hand_id: state.handId,
        ms_remaining: state.actionDeadline - Date.now(),
        forcing_fold: true,
      });
      this.metrics.recordActionTimeout();
      await this.submitAction(state, { type: "fold" });
      return;
    }

    // --- Hand complete ---
    if (state.handComplete && this.lifecycle === "IN_HAND") {
      this.lifecycle = "HAND_COMPLETE";
      const heroSeat = state.seats[this.agentKit.agentPublicKey.toBase58()];
      const chipsNow = heroSeat?.stack ?? 0;
      const chipsDelta = this.currentHandCtx
        ? chipsNow - (this.currentHandCtx.effectiveStack + this.currentHandCtx.potSize / 2)
        : 0;
      this.logger.info("hand_complete", {
        hand_id: state.handId,
        result: chipsDelta > 0 ? "won" : "lost",
        amount: Math.abs(chipsDelta),
      });
      this.metrics.recordHandComplete(chipsDelta > 0, chipsDelta);

      // Queue hand history for sidecar analysis
      if (this.sidecar) {
        const history = await this.buildHandHistory(state);
        if (history) this.sidecar.queueForAnalysis(history);
      }

      // Check elimination
      if ((heroSeat?.stack ?? 0) === 0) {
        this.lifecycle = "ELIMINATED";
        this.logger.info("agent_eliminated", { hand_id: state.handId });
      } else {
        this.lifecycle = "WAITING_FOR_HAND";
      }
      this.currentHandCtx = null;
      this.actionSubmitted = false;
      return;
    }

    // --- Tournament complete ---
    if (state.street === "showdown" && state.handComplete) {
      this.lifecycle = "TOURNAMENT_COMPLETE";
      return;
    }

    // --- New hand starting ---
    if (!state.handComplete && state.currentActor !== null && this.lifecycle === "WAITING_FOR_HAND") {
      this.lifecycle = "IN_HAND";
      this.actionSubmitted = false;
      this.handStartTime = Date.now();
      await this.initHandContext(state);
    }

    // --- My turn to act ---
    if (
      this.lifecycle === "IN_HAND" &&
      !this.actionSubmitted &&
      state.currentActor === this.agentKit.agentPublicKey.toBase58()
    ) {
      await this.decide(state);
    }
  }

  private async initHandContext(state: ERTableState): Promise<void> {
    const heroId = this.agentKit.agentPublicKey.toBase58();
    const heroSeat = state.seats[heroId];
    if (!heroSeat) return;

    const opponents = Object.entries(state.seats)
      .filter(([id]) => id !== heroId)
      .map(([, seat]) => seat);
    const maxOppStack = Math.max(0, ...opponents.map((s) => s.stack));

    // Fetch hole cards from TEE
    const holeCards = await this.agentKit.fetchHoleCards(state.tableId, heroId);
    const cards: [Card, Card] = holeCards
      ? [holeCards[0] as Card, holeCards[1] as Card]
      : ["As", "Kd"]; // stub for dev

    this.currentHandCtx = {
      handId: state.handId,
      street: state.street as any,
      holeCards: cards,
      communityCards: state.communityCards as Card[],
      potSize: state.pot,
      effectiveStack: Math.min(heroSeat.stack, maxOppStack),
      heroPosition: inferPosition(heroId, state.seats),
      facingBet: 0,
      potOdds: 0,
      opponentActions: {},
      streetHistory: {},
    };

    this.logger.info("hand_started", {
      hand_id: state.handId,
      street: state.street,
      hole_cards: cards,
      position: this.currentHandCtx.heroPosition,
    });
  }

  private async decide(state: ERTableState): Promise<void> {
    if (!this.currentHandCtx) return;

    // Update context from latest state
    this.currentHandCtx.street = state.street as any;
    this.currentHandCtx.communityCards = state.communityCards as Card[];
    this.currentHandCtx.potSize = state.pot;

    const bigBlind = inferBigBlind(state);
    const shortDeck = this.config.blueprint.variant === "short-deck";

    const t0 = Date.now();
    const dist = this.policy.getDistribution(this.currentHandCtx, bigBlind, shortDeck);
    const { key, dims } = this.policy.computeBucket(this.currentHandCtx, bigBlind, shortDeck);

    // Collect exploit weights from all active opponents
    const heroId = this.agentKit.agentPublicKey.toBase58();
    const opponentIds = Object.keys(state.seats).filter((id) => id !== heroId);
    const combinedWeights = mergeOpponentWeights(opponentIds, this.weightStore);

    const action = this.policy.sampleAction(dist, combinedWeights ?? undefined);
    const latency = Date.now() - t0;
    this.metrics.recordDecision(latency);

    this.logger.info("decision_made", {
      hand_id: state.handId,
      bucket: key,
      distribution: dist,
      action: action.type,
      exploit_weights_applied: combinedWeights !== null,
      latency_ms: latency,
    });

    await this.submitAction(state, action);
  }

  private async submitAction(state: ERTableState, action: Action): Promise<void> {
    if (this.actionSubmitted) return;
    this.actionSubmitted = true;

    const heroId = this.agentKit.agentPublicKey.toBase58();
    await this.agentKit.submitAction(state.tableId, state.handId, heroId, action);
  }

  private async buildHandHistory(state: ERTableState): Promise<HandHistoryEntry | null> {
    // In production: fetch committed history from L1 Merkle tree
    // Stub: build minimal history from current state
    const players = Object.keys(state.seats);
    return {
      handId: state.handId,
      positions: Object.fromEntries(players.map((id, i) => [id, i === 0 ? "BTN" : "BB"])),
      preflopActions: [],
      flopActions: [],
      turnActions: [],
      riverActions: [],
      showdown: null,
      communityCards: state.communityCards as Card[],
      players,
    };
  }

  get currentLifecycle(): AgentLifecycleState {
    return this.lifecycle;
  }

  setLifecycle(state: AgentLifecycleState): void {
    this.lifecycle = state;
  }
}

// Merge exploit weights from multiple opponents (average)
function mergeOpponentWeights(
  opponentIds: string[],
  store: InMemoryWeightStore
): [number, number, number, number] | null {
  const weights = opponentIds.map((id) => store.getWeights(id)).filter((w): w is [number, number, number, number] => w !== null);
  if (weights.length === 0) return null;
  return [0, 1, 2, 3].map((i) => weights.reduce((s, w) => s + w[i], 0) / weights.length) as unknown as [
    number, number, number, number
  ];
}
