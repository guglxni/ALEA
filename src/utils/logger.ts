import * as fs from "fs";
import * as path from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  private level: number;
  private stream: fs.WriteStream | null = null;

  constructor(level: LogLevel = "info", logFile?: string) {
    this.level = LEVELS[level];
    if (logFile) {
      const dir = path.dirname(logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(logFile, { flags: "a" });
    }
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (LEVELS[level] < this.level) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
    const prefix = `[${level.toUpperCase()}] `;
    process.stdout.write(prefix + line + "\n");
    if (this.stream) this.stream.write(line + "\n");
  }

  debug(event: string, fields?: Record<string, unknown>): void { this.write("debug", event, fields); }
  info(event: string, fields?: Record<string, unknown>): void { this.write("info", event, fields); }
  warn(event: string, fields?: Record<string, unknown>): void { this.write("warn", event, fields); }
  error(event: string, fields?: Record<string, unknown>): void { this.write("error", event, fields); }
}
