import { loadConfig } from "../config/config";
import { Logger } from "../utils/logger";
import { MetricsCollector } from "../utils/metrics";
import { BlueprintPolicyService } from "../blueprint/policy-service";
import { InMemoryWeightStore } from "../sidecar/weight-store";
import { LLMSidecar } from "../sidecar/llm-sidecar";
import { SolanaAgentKit } from "../solana/agent-kit";
import { AgentMainLoop } from "./main-loop";
import { ERTableState } from "../types/game-state";
import { PublicKey } from "@solana/web3.js";
import * as path from "path";

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? "./config/agent.toml";
  const config = loadConfig(configPath);

  const logger = new Logger(config.logging.level, config.logging.logFile);
  const metrics = new MetricsCollector("./logs/metrics.jsonl", logger);

  logger.info("agent_starting", { name: config.agent.name, variant: config.blueprint.variant });

  // --- Blueprint policy service ---
  const policy = new BlueprintPolicyService(logger);
  policy.load(config.blueprint.path);

  // --- Weight store (shared between sidecar and main loop) ---
  const weightStore = new InMemoryWeightStore();

  // --- LLM sidecar (optional) ---
  const sidecar = config.sidecar.enabled
    ? new LLMSidecar(config.sidecar, weightStore, logger, metrics)
    : null;

  if (!config.sidecar.enabled) {
    logger.info("sidecar_disabled", { reason: "sidecar.enabled=false in config" });
  }

  // --- Solana Agent Kit ---
  const agentKit = new SolanaAgentKit(config, logger);

  // --- Main loop ---
  const mainLoop = new AgentMainLoop(policy, sidecar, weightStore, agentKit, logger, metrics, config);

  // --- Registration ---
  mainLoop.setLifecycle("INITIALIZING");
  const isReg = await agentKit.isRegistered(config.agent.tournamentId);
  if (!isReg) {
    // Agent NFT pubkey — in production, load from identity_registry
    const agentNft = agentKit.agentPublicKey;
    await agentKit.registerForTournament(config.agent.tournamentId, agentNft);
  }
  mainLoop.setLifecycle("REGISTERED");

  // --- Start polling ---
  const tournamentId = config.agent.tournamentId || "devnet-table-1";
  logger.info("entering_main_loop", { tournament: tournamentId });
  mainLoop.setLifecycle("WAITING_FOR_HAND");

  agentKit.startPolling(tournamentId, async (state: ERTableState) => {
    try {
      await mainLoop.onStateUpdate(state);
    } catch (err) {
      logger.error("main_loop_error", { error: (err as Error).message, stack: (err as Error).stack });
    }

    const lc = mainLoop.currentLifecycle;
    if (lc === "ELIMINATED" || lc === "TOURNAMENT_COMPLETE") {
      agentKit.stopPolling();
      logger.info("agent_done", { lifecycle: lc, metrics: metrics.snapshot() });
      process.exit(0);
    }
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    logger.info("agent_shutdown", { metrics: metrics.snapshot() });
    agentKit.stopPolling();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
