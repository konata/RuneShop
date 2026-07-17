import { chmod, copyFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { emit, persist, read, type Config } from "./state";

type Payload = Record<string, unknown>;
const skew = 300_000;
const timeout = 10_000;
let queue = Promise.resolve();

export const upstream = {
  codex: "https://chatgpt.com/backend-api/codex",
  account: "https://chatgpt.com/backend-api/wham",
  token: "https://auth.openai.com/oauth/token",
  client: "app_EMoamEEZ73f0CkXaXp7hrann",
  agent: "codex_cli_rs",
  models: ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]
};

function object(value: unknown): Payload | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Payload : null;
}

const record = (value: unknown) => object(value) ?? {};
function field(...values: unknown[]) {
  const value = values.find((value) => typeof value === "string" && value.trim());
  return typeof value === "string" ? value.trim() : "";
}

function date(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string" || typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  const parsed = new Date(Number.isFinite(number) ? number * (number > 10_000_000_000 ? 1 : 1000) : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function claims(token: string) {
  try { return record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))); }
  catch { return {}; }
}

function accountId(id: string) {
  const payload = claims(id);
  const auth = record(payload["https://api.openai.com/auth"]);
  return field(auth.chatgpt_account_id, auth.account_id, payload.chatgpt_account_id);
}

export function parse(store: Payload) {
  const source = object(store.tokens) ?? store;
  const access = field(source.access_token, source.accessToken, store.access_token, store.accessToken);
  if (!access) return null;
  const id = field(source.id_token, store.id_token);
  const expires = date(source.expired ?? source.expires_at ?? source.expiry ?? store.expired ?? store.expires_at ?? store.expiry);
  const refreshed = date(source.last_refresh ?? store.last_refresh);
  return {
    access,
    refresh: field(source.refresh_token, source.refreshToken, store.refresh_token, store.refreshToken),
    account: field(source.account_id, source.chatgpt_account_id, store.account_id, store.chatgpt_account_id, accountId(id)),
    id,
    expires: expires ?? (refreshed ? new Date(refreshed.getTime() + 50 * 60_000) : null)
  };
}

export type CodexToken = NonNullable<ReturnType<typeof parse>>;
export function authorization(token: Pick<CodexToken, "access" | "account">) {
  const headers = new Headers({ authorization: `Bearer ${token.access}`, "user-agent": upstream.agent });
  if (token.account) headers.set("chatgpt-account-id", token.account);
  return headers;
}

function serialized<T>(action: () => Promise<T>) {
  const result = queue.then(action, action);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function load(path: string) {
  const token = parse(await read<Payload>(path));
  if (!token) throw new Error(`no Codex token found in ${path}`);
  return token;
}

const stale = (token: CodexToken) => token.expires ? token.expires.getTime() - Date.now() <= skew : false;
function canonical(token: CodexToken) {
  return {
    type: "codex", access_token: token.access, refresh_token: token.refresh, account_id: token.account,
    ...(token.id ? { id_token: token.id } : {}), ...(token.expires ? { expired: token.expires.toISOString() } : {}),
    last_refresh: new Date().toISOString()
  };
}

function account(token: CodexToken) {
  const access = claims(token.access);
  const identity = claims(token.id);
  const accessAuth = record(access["https://api.openai.com/auth"]);
  const identityAuth = record(identity["https://api.openai.com/auth"]);
  const profile = record(access["https://api.openai.com/profile"]);
  return {
    name: field(identity.name, profile.name) || null,
    email: field(identity.email, profile.email) || null,
    account_id: field(token.account, identityAuth.chatgpt_account_id, accessAuth.chatgpt_account_id) || null,
    plan: field(identityAuth.chatgpt_plan_type, accessAuth.chatgpt_plan_type) || null
  };
}

async function renew(token: CodexToken) {
  if (!token.refresh) throw new Error("Codex token expired without a refresh token");
  emit("info", "token_refresh", { account: token.account ? "present" : "missing", expires_at: token.expires?.toISOString() });
  const response = await fetch(upstream.token, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: upstream.client, grant_type: "refresh_token", refresh_token: token.refresh, scope: "openid profile email" }),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Codex token refresh failed (${response.status}): ${text}`);
  const payload = JSON.parse(text) as Payload;
  const id = field(payload.id_token, token.id);
  const refreshed = {
    access: field(payload.access_token), refresh: field(payload.refresh_token, token.refresh),
    account: field(payload.account_id, accountId(id), token.account), id,
    expires: typeof payload.expires_in === "number" ? new Date(Date.now() + payload.expires_in * 1000) : token.expires
  };
  if (!refreshed.access) throw new Error("Codex token refresh returned an unusable credential");
  emit("info", "token_refreshed", { account: refreshed.account ? "present" : "missing", expires_at: refreshed.expires?.toISOString() });
  return refreshed;
}

async function probe(token: CodexToken) {
  let failure: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${upstream.account}/usage`, { headers: authorization(token), signal: AbortSignal.timeout(timeout) });
      await response.text();
      if (attempt || response.status !== 429 && response.status < 500) return response.status;
    } catch (error) {
      failure = error as Error;
      if (attempt) break;
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Codex credential validation ${failure?.name === "TimeoutError" ? "timed out" : failure?.message || "failed"}`);
}

function report(token: CodexToken, updated_at: string | null) {
  return {
    configured: true, refreshable: Boolean(token.refresh), expires_at: token.expires?.toISOString() ?? null, updated_at,
    account: account(token)
  };
}

export async function credentialStatus(path: string) {
  try {
    const [token, info] = await Promise.all([load(path), stat(path)]);
    return report(token, info.mtime.toISOString());
  } catch { return { configured: false, refreshable: false, expires_at: null, updated_at: null, account: null }; }
}

export async function fresh(path: string) {
  return serialized(async () => {
    const token = await load(path);
    if (!stale(token)) return token;
    const refreshed = await renew(token);
    await persist(path, canonical(refreshed));
    return refreshed;
  });
}

export async function importCredential(path: string, source: string) {
  let store: Payload | null = null;
  try { store = object(JSON.parse(source)); } catch {}
  if (!store) throw new Error("auth.json is not valid JSON");
  return serialized(async () => {
    let token = parse(store);
    if (!token) throw new Error("auth.json does not contain a Codex access token");
    if (!token.refresh) throw new Error("auth.json does not contain a refresh token");
    if (!token.account) throw new Error("auth.json does not contain a ChatGPT account ID");
    let renewed = false;
    if (stale(token)) { token = await renew(token); renewed = true; }
    let status = await probe(token);
    if (!renewed && (status === 401 || status === 403)) { token = await renew(token); status = await probe(token); }
    if (status < 200 || status >= 300) throw new Error(`Codex credential validation failed (${status})`);
    if (await Bun.file(path).exists()) { await copyFile(path, `${path}.backup`); await chmod(`${path}.backup`, 0o600); }
    await persist(path, canonical(token));
    return report(token, new Date().toISOString());
  });
}

function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function limit(value: unknown) {
  const source = record(value);
  const used = number(source.used_percent);
  const seconds = number(source.limit_window_seconds);
  const reset = number(source.reset_at);
  return used === null || seconds === null || reset === null ? null : { used_percent: used, window_seconds: seconds, resets_at: reset };
}

export function normalizeAccount(usage: Payload, profile: Payload = {}) {
  const limits = record(usage.rate_limit);
  const credits = record(usage.rate_limit_reset_credits);
  const stats = record(profile.stats);
  const windows = [limit(limits.primary_window), limit(limits.secondary_window)]
    .filter((window): window is NonNullable<ReturnType<typeof limit>> => window !== null)
    .sort((left, right) => left.window_seconds - right.window_seconds);
  return {
    fetched_at: new Date().toISOString(), plan: typeof usage.plan_type === "string" ? usage.plan_type : "unknown",
    primary: windows[0] ?? null, secondary: windows[1] ?? null,
    reset_credits: number(credits.available_count) ?? 0, lifetime_tokens: number(stats.lifetime_tokens), total_threads: number(stats.total_threads)
  };
}

type AccountSnapshot = ReturnType<typeof normalizeAccount>;
export class AccountClient {
  private readonly file: string;
  private readonly ready: Promise<void>;
  private snapshot?: AccountSnapshot;
  private pending?: Promise<AccountSnapshot>;

  constructor(private readonly config: Config) {
    this.file = join(config.stateDir, "account.json");
    this.ready = this.restore();
  }

  private async restore() { try { this.snapshot = await read<AccountSnapshot>(this.file); } catch {} }
  async get(force = false) {
    await this.ready;
    const age = this.snapshot ? Date.now() - Date.parse(this.snapshot.fetched_at) : Infinity;
    if (!force && this.snapshot && age < 60_000) return { ...this.snapshot, stale: false };
    if (!this.pending) this.pending = this.refresh().finally(() => (this.pending = undefined));
    try { return { ...(await this.pending), stale: false }; }
    catch (error) {
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
    const token = await fresh(this.config.authFile);
    const request = async (path: string) => {
      const response = await fetch(`${upstream.account}${path}`, { headers: authorization(token), signal: AbortSignal.timeout(timeout) });
      const text = await response.text();
      if (!response.ok) throw new Error(`${path} failed (${response.status}): ${text.slice(0, 240)}`);
      return JSON.parse(text) as Payload;
    };
    const [usage, profile] = await Promise.all([request("/usage"), request("/profiles/me").catch(() => ({}))]);
    this.snapshot = normalizeAccount(usage, profile);
    await persist(this.file, this.snapshot);
    return this.snapshot;
  }
}
