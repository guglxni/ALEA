import * as fs from "fs";
import { Logger } from "./logger";

export interface AgentMetrics {
  handsPlayed: number;
  handsWon: number;
  chipsWonNet: number;
  totalDecisionLatencyMs: number;
  blueprintLookups: number;
  sidecarUpdates: number;
  sidecarErrors: number;
  actionTimeouts: number;
}

export class MetricsCollector {
  private metrics: AgentMetrics = {
    handsPlayed: 0,
    handsWon: 0,
    chipsWonNet: 0,
    totalDecisionLatencyMs: 0,
    blueprintLookups: 0,
    sidecarUpdates: 0,
    sidecarErrors: 0,
    actionTimeouts: 0,
  };
  private lastFlushHand = 0;
  private metricsFile: string;
  private logger: Logger;

  constructor(metricsFile: string, logger: Logger) {
    this.metricsFile = metricsFile;
    this.logger = logger;
  }

  recordHandComplete(won: boolean, chipsChange: number): void {
    this.metrics.handsPlayed++;
    if (won) this.metrics.handsWon++;
    this.metrics.chipsWonNet += chipsChange;
    if (this.metrics.handsPlayed - this.lastFlushHand >= 10) {
      this.flush();
      this.lastFlushHand = this.metrics.handsPlayed;
    }
  }

  recordDecision(latencyMs: number): void {
    this.metrics.blueprintLookups++;
    this.metrics.totalDecisionLatencyMs += latencyMs;
  }

  recordSidecarUpdate(): void { this.metrics.sidecarUpdates++; }
  recordSidecarError(): void { this.metrics.sidecarErrors++; }
  recordActionTimeout(): void { this.metrics.actionTimeouts++; }

  get avgDecisionLatencyMs(): number {
    if (this.metrics.blueprintLookups === 0) return 0;
    return this.metrics.totalDecisionLatencyMs / this.metrics.blueprintLookups;
  }

  snapshot(): AgentMetrics & { avgDecisionLatencyMs: number } {
    return { ...this.metrics, avgDecisionLatencyMs: this.avgDecisionLatencyMs };
  }

  private flush(): void {
    const snap = this.snapshot();
    this.logger.info("metrics_snapshot", snap as unknown as Record<string, unknown>);
    try {
      fs.appendFileSync(this.metricsFile, JSON.stringify({ ...snap, ts: new Date().toISOString() }) + "\n");
    } catch {
      // non-fatal
    }
  }
}
