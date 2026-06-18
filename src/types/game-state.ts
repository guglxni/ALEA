import { Action, Card, Street } from "./cards";

export type Position = "SB" | "BB" | "EP" | "BTN";

export interface SeatState {
  agentId: string;
  stack: number;
  lastAction: Action | null;
  isActive: boolean;
}

// Live table state from the ephemeral rollup
export interface ERTableState {
  tableId: string;
  street: Street;
  pot: number;
  communityCards: Card[];
  seats: Record<string, SeatState>;
  currentActor: string | null;
  actionDeadline: number; // unix timestamp ms
  handId: string;
  handComplete: boolean;
}

// Full hand context maintained by the agent
export interface HandContext {
  handId: string;
  street: Street;
  holeCards: [Card, Card];
  communityCards: Card[];
  potSize: number;
  effectiveStack: number; // min(hero stack, max opponent stack)
  heroPosition: Position;
  facingBet: number;
  potOdds: number; // facingBet / (potSize + facingBet)
  opponentActions: Record<string, Action[]>;
  streetHistory: Record<string, Action[]>;
}

// From committed L1 hand history
export interface HandHistoryEntry {
  handId: string;
  positions: Record<string, string>; // agentId -> position label
  preflopActions: HistoryAction[];
  flopActions: HistoryAction[];
  turnActions: HistoryAction[];
  riverActions: HistoryAction[];
  showdown: ShowdownResult | null;
  communityCards: Card[];
  players: string[]; // agent NFT pubkeys
}

export interface HistoryAction {
  player: string;
  action: string;
  street: Street;
  potSizeBb: number;
  stackDepthBb: number;
  amount?: number;
}

export interface ShowdownResult {
  winner: string;
  holeCards: Record<string, [Card, Card]>;
  potAwarded: number;
}

export type AgentLifecycleState =
  | "INITIALIZING"
  | "REGISTERED"
  | "WAITING_FOR_HAND"
  | "IN_HAND"
  | "HAND_COMPLETE"
  | "ELIMINATED"
  | "TOURNAMENT_COMPLETE";
