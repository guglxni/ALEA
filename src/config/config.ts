import * as fs from "fs";
import * as path from "path";
import * as toml from "toml";

export interface AgentConfig {
  agent: {
    name: string;
    keypairPath: string;
    tournamentId: string;
  };
  rpc: {
    erEndpoint: string;
    l1Endpoint: string;
    pollIntervalMs: number;
  };
  blueprint: {
    path: string;
    variant: "short-deck" | "capped-bet";
  };
  sidecar: {
    enabled: boolean;
    llmProvider: string;
    llmModel: string;
    apiKeyEnv: string;
    maxHandsContext: number;
    confidenceDecayRate: number;
    minHandsBeforeExploit: number;
    llmTimeoutMs: number;
  };
  exploitWeights: {
    maxWeight: number;
    minWeight: number;
  };
  timeouts: {
    actionDeadlineBufferMs: number;
    rpcTimeoutMs: number;
    llmTimeoutMs: number;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    logFile: string;
  };
}

const DEFAULTS: AgentConfig = {
  agent: { name: "agent-alpha", keypairPath: "./keys/agent.json", tournamentId: "" },
  rpc: { erEndpoint: "wss://er.magicblock.app/table", l1Endpoint: "https://api.devnet.solana.com", pollIntervalMs: 500 },
  blueprint: { path: "./data/blueprint_v1.bin", variant: "short-deck" },
  sidecar: { enabled: false, llmProvider: "anthropic", llmModel: "claude-sonnet-4-6", apiKeyEnv: "LLM_API_KEY", maxHandsContext: 20, confidenceDecayRate: 0.9, minHandsBeforeExploit: 5, llmTimeoutMs: 10000 },
  exploitWeights: { maxWeight: 0.5, minWeight: -0.5 },
  timeouts: { actionDeadlineBufferMs: 2000, rpcTimeoutMs: 3000, llmTimeoutMs: 10000 },
  logging: { level: "info", logFile: "./logs/agent.log" },
};

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// Recursively normalize snake_case keys from TOML to camelCase
function normalize(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(normalize);
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const camel = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      out[camel] = normalize(v);
    }
    return out;
  }
  return obj;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (typeof base !== "object" || base === null) return override ?? base;
  if (typeof override !== "object" || override === null) return base;
  const result = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    result[k] = deepMerge(result[k], v);
  }
  return result;
}

export function loadConfig(configPath: string): AgentConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = normalize(toml.parse(raw));
  return deepMerge(DEFAULTS, parsed) as AgentConfig;
}
