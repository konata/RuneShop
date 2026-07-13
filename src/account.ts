import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import { fresh } from "./token";

type Payload = Record<string, unknown>;
const timeout = 10_000;

export type RateWindow = {
  used_percent: number;
  window_seconds: number;
  resets_at: number;
};

export type AccountSnapshot = {
  fetched_at: string;
  plan: string;
  primary: RateWindow | null;
  secondary: RateWindow | null;
  reset_credits: number;
  lifetime_tokens: number | null;
  total_threads: number | null;
};

function record(value: unknown): Payload {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : {};
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function window(value: unknown): RateWindow | null {
  const source = record(value);
  const used = number(source.used_percent);
  const seconds = number(source.limit_window_seconds);
  const reset = number(source.reset_at);
  return used === null || seconds === null || reset === null
    ? null
    : { used_percent: used, window_seconds: seconds, resets_at: reset };
}

export function normalizeAccount(usage: Payload, profile: Payload = {}): AccountSnapshot {
  const limits = record(usage.rate_limit);
  const credits = record(usage.rate_limit_reset_credits);
  const stats = record(profile.stats);

  return {
    fetched_at: new Date().toISOString(),
    plan: typeof usage.plan_type === "string" ? usage.plan_type : "unknown",
    primary: window(limits.primary_window),
    secondary: window(limits.secondary_window),
    reset_credits: number(credits.available_count) ?? 0,
    lifetime_tokens: number(stats.lifetime_tokens),
    total_threads: number(stats.total_threads)
  };
}

export class AccountClient {
  private readonly file: string;
  private readonly ready: Promise<void>;
  private snapshot?: AccountSnapshot;
  private pending?: Promise<AccountSnapshot>;

  constructor(private readonly config: Config) {
    this.file = join(config.stateDir, "account.json");
    this.ready = this.restore();
  }

  private async restore() {
    try {
      this.snapshot = JSON.parse(await readFile(this.file, "utf8")) as AccountSnapshot;
    } catch {}
  }

  async get(force = false) {
    await this.ready;
    const age = this.snapshot ? Date.now() - Date.parse(this.snapshot.fetched_at) : Infinity;
    if (!force && this.snapshot && age < 60_000) return { ...this.snapshot, stale: false };
    if (!this.pending) this.pending = this.refresh().finally(() => (this.pending = undefined));
    try {
      return { ...(await this.pending), stale: false };
    } catch (error) {
      if (!this.snapshot) throw error;
      return { ...this.snapshot, stale: true, error: (error as Error).message };
    }
  }

  async invalidate() {
    await this.ready;
    await this.pending?.catch(() => undefined);
    this.snapshot = undefined;
    await rm(this.file, { force: true });
  }

  private async refresh() {
    const token = await fresh(this.config);
    const headers = new Headers({ authorization: `Bearer ${token.access}`, "user-agent": this.config.userAgent });
    if (token.account) headers.set("chatgpt-account-id", token.account);
    const prefix = this.config.account.includes("/backend-api") ? "/wham" : "/api/codex";
    const request = async (path: string, optional = false) => {
      const response = await fetch(`${this.config.account}${prefix}${path}`, { headers, signal: AbortSignal.timeout(timeout) });
      if (optional && response.status === 404) return {};
      const text = await response.text();
      if (!response.ok) throw new Error(`${path} failed (${response.status}): ${text.slice(0, 240)}`);
      return JSON.parse(text) as Payload;
    };

    const [usage, profile] = await Promise.all([
      request("/usage"),
      request("/profiles/me", true).catch(() => ({}))
    ]);
    this.snapshot = normalizeAccount(usage, profile);
    await this.persist(this.snapshot);
    return this.snapshot;
  }

  private async persist(snapshot: AccountSnapshot) {
    const directory = this.file.slice(0, this.file.lastIndexOf("/"));
    const temporary = `${this.file}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
