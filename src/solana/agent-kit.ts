import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import WebSocket from "ws";
import { ERTableState } from "../types/game-state";
import { Action } from "../types/cards";
import { AgentConfig } from "../config/config";
import { Logger } from "../utils/logger";

export interface ActionSubmitter {
  submitAction(tableId: string, handId: string, seatId: string, action: Action): Promise<string>;
}

export class SolanaAgentKit implements ActionSubmitter {
  private connection: Connection;
  private keypair: Keypair;
  private config: AgentConfig;
  private logger: Logger;
  private ws: WebSocket | null = null;
  private tableStateCache: ERTableState | null = null;
  private stateListeners: ((state: ERTableState) => void)[] = [];
  private actionSequence = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AgentConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.connection = new Connection(config.rpc.l1Endpoint, "confirmed");
    this.keypair = loadKeypair(config.agent.keypairPath);
  }

  get agentPublicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  // --------------- State polling ---------------

  startPolling(tableId: string, onState: (state: ERTableState) => void): void {
    this.stateListeners.push(onState);
    this.connectWebSocket(tableId).catch(() => {
      this.logger.warn("ws_connect_failed", { tableId, fallback: "rpc_polling" });
      this.startRpcPolling(tableId);
    });
  }

  private async connectWebSocket(tableId: string): Promise<void> {
    const url = `${this.config.rpc.erEndpoint}/${tableId}`;
    this.ws = new WebSocket(url);

    this.ws.on("message", (data: Buffer) => {
      try {
        const state = JSON.parse(data.toString()) as ERTableState;
        this.tableStateCache = state;
        this.stateListeners.forEach((fn) => fn(state));
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on("error", (err) => {
      this.logger.warn("ws_error", { error: err.message });
      if (this.ws) { this.ws.close(); this.ws = null; }
      this.startRpcPolling(tableId);
    });

    this.ws.on("close", () => {
      this.logger.info("ws_closed", { tableId });
      this.startRpcPolling(tableId);
    });
  }

  private startRpcPolling(tableId: string): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      try {
        const state = await this.fetchTableStateRpc(tableId);
        if (state) {
          this.tableStateCache = state;
          this.stateListeners.forEach((fn) => fn(state));
        }
      } catch (err) {
        this.logger.warn("rpc_poll_error", { error: (err as Error).message });
      }
    }, this.config.rpc.pollIntervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.ws) { this.ws.close(); this.ws = null; }
  }

  // In v1, ER table state is fetched via a custom RPC endpoint.
  // The production implementation would deserialize the ER account layout.
  private async fetchTableStateRpc(tableId: string): Promise<ERTableState | null> {
    try {
      const pubkey = new PublicKey(tableId);
      const info = await this.connection.getAccountInfo(pubkey, "confirmed");
      if (!info) return null;
      // Placeholder: in production, deserialize with Anchor IDL
      return JSON.parse(Buffer.from(info.data).toString("utf-8")) as ERTableState;
    } catch {
      return null;
    }
  }

  // Fetch own hole cards via TEE authorized query
  async fetchHoleCards(tableId: string, seatId: string): Promise<[string, string] | null> {
    // In production: signed RPC call to TEE endpoint.
    // The enclave validates the agent keypair signature and returns only this seat's cards.
    // Placeholder returns null — real implementation requires MagicBlock TEE SDK.
    this.logger.debug("fetch_hole_cards", { tableId, seatId });
    return null;
  }

  // --------------- Action submission ---------------

  async submitAction(tableId: string, handId: string, seatId: string, action: Action): Promise<string> {
    const nonce = deriveNonce(handId, seatId, this.actionSequence++);
    const encoded = encodeAction(action, tableId, handId, seatId, nonce, this.keypair.publicKey);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // In production: submit signed ER instruction via MagicBlock SDK.
        // Placeholder simulates the call.
        const txSig = await this.sendErInstruction(encoded);
        this.logger.info("action_submitted", { hand_id: handId, action: action.type, tx: txSig });
        return txSig;
      } catch (err) {
        const isLast = attempt === 2;
        this.logger.warn("action_submit_retry", {
          attempt: attempt + 1,
          error: (err as Error).message,
          final: isLast,
        });
        if (!isLast) await sleep(500);
      }
    }

    // All retries failed — auto-fold
    this.logger.error("action_submit_failed", { hand_id: handId, action: action.type, fallback: "fold" });
    return "auto-fold";
  }

  // Stub — replace with MagicBlock ER SDK call
  private async sendErInstruction(encoded: EncodedAction): Promise<string> {
    // Real implementation: build transaction with ER program instruction, sign, send.
    return `sim:${encoded.instruction}:${Date.now()}`;
  }

  // --------------- Tournament registration ---------------

  async registerForTournament(tournamentId: string, agentNft: PublicKey): Promise<void> {
    this.logger.info("registering_for_tournament", { tournament: tournamentId, agent: agentNft.toBase58() });
    // In production: CPI into tournament_registry Anchor program with register_agent instruction.
    // Placeholder confirms without actual on-chain call.
    await sleep(100);
    this.logger.info("registration_confirmed", { tournament: tournamentId });
  }

  async isRegistered(tournamentId: string): Promise<boolean> {
    // In production: check tournament_account participant list for this agent NFT.
    return false;
  }

  // --------------- Hand history ---------------

  async fetchHandHistory(handId: string): Promise<unknown> {
    // In production: fetch committed Merkle tree from L1 and deserialize hand history.
    this.logger.debug("fetch_hand_history", { hand_id: handId });
    return null;
  }

  get currentTableState(): ERTableState | null {
    return this.tableStateCache;
  }
}

// --------------- Helpers ---------------

function loadKeypair(keypairPath: string): Keypair {
  if (!fs.existsSync(keypairPath)) {
    // Generate ephemeral keypair for development
    const kp = Keypair.generate();
    const dir = keypairPath.split("/").slice(0, -1).join("/");
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keypairPath, JSON.stringify(Array.from(kp.secretKey)));
    return kp;
  }
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function deriveNonce(handId: string, seatId: string, sequence: number): string {
  return `${handId}:${seatId}:${sequence}`;
}

interface EncodedAction {
  instruction: string;
  tableId: string;
  handId: string;
  seatId: string;
  nonce: string;
  agent: string;
  amount?: number;
}

function encodeAction(
  action: Action,
  tableId: string,
  handId: string,
  seatId: string,
  nonce: string,
  agentKey: PublicKey
): EncodedAction {
  const base = { tableId, handId, seatId, nonce, agent: agentKey.toBase58() };
  switch (action.type) {
    case "fold":   return { ...base, instruction: "table_fold" };
    case "call":   return { ...base, instruction: "table_call" };
    case "raise":  return { ...base, instruction: "table_raise", amount: action.sizeFraction };
    case "all-in": return { ...base, instruction: "table_all_in" };
    default:       return { ...base, instruction: "table_fold" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
