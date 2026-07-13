export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const priority: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 50 };
let threshold: LogLevel = "info";

export function configure(level: LogLevel) {
  threshold = level;
}

export function elapsed(start: number) {
  return Math.round(performance.now() - start);
}

export function emit(level: Exclude<LogLevel, "silent">, event: string, fields: Record<string, unknown> = {}) {
  if (priority[level] < priority[threshold]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  level === "warn" || level === "error" ? console.error(line) : console.log(line);
}
