import { HandHistoryEntry } from "../types/game-state";
import { TendencyStore, TendencyProfile, profileToWeights } from "./tendency-profile";
import { InMemoryWeightStore } from "./weight-store";
import { AgentConfig } from "../config/config";
import { Logger } from "../utils/logger";
import { MetricsCollector } from "../utils/metrics";

interface LLMDeviationOutput {
  foldToThreeBetDeviation: number;
  continuationBetCallDeviation: number;
  bluffFrequencyDeviation: number;
  allInCallDeviation: number;
  confidenceScore: number;
  reasoning: string;
}

const SYSTEM_PROMPT = `You are an opponent-modeling module for a poker agent. You receive structured hand histories and output JSON containing estimated deviations from Nash equilibrium play for specific opponent tendencies.

Output ONLY valid JSON matching this schema:
{
  "foldToThreeBetDeviation": <float -1.0 to 1.0>,
  "continuationBetCallDeviation": <float -1.0 to 1.0>,
  "bluffFrequencyDeviation": <float -1.0 to 1.0>,
  "allInCallDeviation": <float -1.0 to 1.0>,
  "confidenceScore": <float 0.0 to 1.0>,
  "reasoning": "<one sentence>"
}

If you have fewer than 5 hands of data for this opponent, return all deviations as 0.0 and confidence 0.1.`;

export class LLMSidecar {
  private tendencyStore = new TendencyStore();
  private queue: { history: HandHistoryEntry; handIndex: number }[] = [];
  private running = false;
  private apiKey: string;
  private config: AgentConfig["sidecar"];
  private logger: Logger;
  private metrics: MetricsCollector;
  private weightStore: InMemoryWeightStore;
  private handCounter = 0;

  constructor(
    config: AgentConfig["sidecar"],
    weightStore: InMemoryWeightStore,
    logger: Logger,
    metrics: MetricsCollector
  ) {
    this.config = config;
    this.weightStore = weightStore;
    this.logger = logger;
    this.metrics = metrics;
    this.apiKey = process.env[config.apiKeyEnv] ?? "";
    if (!this.apiKey) {
      this.logger.warn("sidecar_no_api_key", { env: config.apiKeyEnv });
    }
  }

  queueForAnalysis(history: HandHistoryEntry): void {
    this.handCounter++;
    this.queue.push({ history, handIndex: this.handCounter });
    this.tendencyStore.applyDecay(this.handCounter, this.config.confidenceDecayRate);
    if (!this.running) {
      this.running = true;
      this.drainQueue().finally(() => { this.running = false; });
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      await this.processHand(item.history, item.handIndex);
    }
  }

  private async processHand(history: HandHistoryEntry, handIndex: number): Promise<void> {
    // Extract unique opponents from this hand (excluding hero — identified by role)
    const opponents = history.players.filter((p) => p !== history.players[0]);
    for (const opponentId of opponents.slice(0, 5)) {
      await this.updateOpponent(opponentId, history, handIndex);
    }
  }

  private async updateOpponent(
    opponentId: string,
    latestHistory: HandHistoryEntry,
    handIndex: number
  ): Promise<void> {
    const existing = this.tendencyStore.get(opponentId);
    if (existing.handsObserved < this.config.minHandsBeforeExploit) {
      // Not enough data yet — just increment count
      this.tendencyStore.set({ ...existing, handsObserved: existing.handsObserved + 1, lastUpdatedHand: handIndex });
      this.updateWeights(opponentId);
      return;
    }

    try {
      const deviations = await this.callLLM(opponentId, existing.handsObserved + 1, latestHistory);
      const updated: TendencyProfile = {
        opponentId,
        handsObserved: existing.handsObserved + 1,
        foldToThreeBetDeviation: deviations.foldToThreeBetDeviation,
        continuationBetCallDeviation: deviations.continuationBetCallDeviation,
        bluffFrequencyDeviation: deviations.bluffFrequencyDeviation,
        allInCallDeviation: deviations.allInCallDeviation,
        confidenceScore: deviations.confidenceScore,
        lastUpdatedHand: handIndex,
      };
      this.tendencyStore.set(updated);
      this.updateWeights(opponentId);
      this.metrics.recordSidecarUpdate();
      this.logger.info("sidecar_update", {
        opponent_id: opponentId,
        hands_observed: updated.handsObserved,
        confidence: updated.confidenceScore,
        deviations: {
          fold_to_3bet: updated.foldToThreeBetDeviation,
          cbet_call: updated.continuationBetCallDeviation,
          bluff: updated.bluffFrequencyDeviation,
          all_in_call: updated.allInCallDeviation,
        },
        reasoning: deviations.reasoning,
      });
    } catch (err) {
      this.metrics.recordSidecarError();
      this.logger.error("sidecar_error", {
        opponent_id: opponentId,
        error: err instanceof Error ? err.message : String(err),
        fallback: "pure_blueprint",
      });
    }
  }

  private updateWeights(opponentId: string): void {
    const profile = this.tendencyStore.get(opponentId);
    const weights = profileToWeights(profile);
    this.weightStore.setWeights(opponentId, weights);
  }

  private async callLLM(
    opponentId: string,
    handsObserved: number,
    latestHistory: HandHistoryEntry
  ): Promise<LLMDeviationOutput> {
    if (!this.apiKey) throw new Error("No LLM API key configured");

    const userPrompt = buildUserPrompt(opponentId, handsObserved, latestHistory);
    const response = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.llmModel,
          max_tokens: 256,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        }),
      },
      this.config.llmTimeoutMs
    );

    if (!response.ok) {
      throw new Error(`LLM API error ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as { content: Array<{ text: string }> };
    const text = data.content?.[0]?.text ?? "";
    return parseDeviationOutput(text);
  }
}

function buildUserPrompt(opponentId: string, handsObserved: number, history: HandHistoryEntry): string {
  const shortId = opponentId.slice(0, 8);
  const allActions = [
    ...history.preflopActions,
    ...history.flopActions,
    ...history.turnActions,
    ...history.riverActions,
  ].filter((a) => a.player === opponentId);

  const handSummary = {
    hand_id: history.handId,
    positions: history.positions,
    preflop_actions: history.preflopActions,
    showdown: history.showdown,
  };

  return `Opponent ID: ${shortId}
Hands observed: ${handsObserved}

Recent hand history:
${JSON.stringify({ hands: [handSummary] }, null, 2)}

Based on these hands, estimate how this opponent deviates from Nash equilibrium.`;
}

function parseDeviationOutput(text: string): LLMDeviationOutput {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM returned non-JSON: ${text.slice(0, 100)}`);
  const parsed = JSON.parse(match[0]);
  return {
    foldToThreeBetDeviation: clamp(Number(parsed.foldToThreeBetDeviation ?? 0), -1, 1),
    continuationBetCallDeviation: clamp(Number(parsed.continuationBetCallDeviation ?? 0), -1, 1),
    bluffFrequencyDeviation: clamp(Number(parsed.bluffFrequencyDeviation ?? 0), -1, 1),
    allInCallDeviation: clamp(Number(parsed.allInCallDeviation ?? 0), -1, 1),
    confidenceScore: clamp(Number(parsed.confidenceScore ?? 0.1), 0, 1),
    reasoning: String(parsed.reasoning ?? ""),
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
