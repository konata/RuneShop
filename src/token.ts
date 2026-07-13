import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Config } from "./config";
import { emit } from "./log";

export type CodexToken = {
  path: string;
  store: Record<string, unknown>;
  access: string;
  refresh: string;
  client: string;
  account: string;
  email: string;
  expires: Date | null;
};

export type CredentialStatus = {
  configured: boolean;
  importable: boolean;
  refreshable: boolean;
  expires_at: string | null;
  updated_at: string | null;
};

const probeTimeout = 10_000;
const refreshTimeout = 30_000;
let queue = Promise.resolve();

function serialized<T>(action: () => Promise<T>) {
  const result = queue.then(action, action);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function field(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function tokens(store: Record<string, unknown>) {
  return record(store.tokens) ?? store;
}

function expires(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value > 10_000_000_000 ? value : value * 1000);
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inferred(store: Record<string, unknown>, token: Record<string, unknown>) {
  const direct = expires(token.expired ?? token.expires_at ?? token.expiry ?? store.expired ?? store.expires_at ?? store.expiry);
  if (direct) return direct;
  const refreshed = expires(token.last_refresh ?? store.last_refresh);
  return refreshed ? new Date(refreshed.getTime() + 50 * 60 * 1000) : null;
}

function claims(id: unknown) {
  if (typeof id !== "string") return null;
  const part = id.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function identity(id: unknown) {
  const root = claims(id);
  const auth = record(root?.["https://api.openai.com/auth"]);
  return {
    account: field(auth?.chatgpt_account_id, auth?.account_id, root?.chatgpt_account_id),
    email: field(root?.email)
  };
}

export function parse(store: Record<string, unknown>, path = ""): CodexToken | null {
  const token = tokens(store);
  const user = identity(token.id_token ?? store.id_token);
  const access = field(token.access_token, token.accessToken, store.access_token, store.accessToken);
  if (!access) return null;
  return {
    path,
    store,
    access,
    refresh: field(token.refresh_token, token.refreshToken, store.refresh_token, store.refreshToken),
    client: field(token.client_id, store.client_id),
    account: field(token.account_id, token.chatgpt_account_id, store.account_id, store.chatgpt_account_id, user.account),
    email: field(token.email, store.email, user.email),
    expires: inferred(store, token)
  };
}

async function read(path: string) {
  const store = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  return parse(store, path);
}

async function discover(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const path = join(dir, entry.name);
        try {
          const [token, info] = await Promise.all([read(path), stat(path)]);
          if (!token) return null;
          const type = field(token.store.type, token.store.provider);
          const score = type === "codex" || entry.name === "codex.json" || entry.name === "auth.json" ? 1 : 0;
          return { token, time: info.mtimeMs, score };
        } catch {
          return null;
        }
      })
  );
  return candidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate)
    .sort((a, b) => b.score - a.score || b.time - a.time)[0]?.token ?? null;
}

export async function load(config: Config) {
  const token = config.authFile ? await read(config.authFile) : await discover(config.authDir);
  if (!token) throw new Error(config.authFile ? `no Codex token found in ${config.authFile}` : `no Codex token found under ${config.authDir}`);
  return token;
}

function destination(config: Config) {
  return config.authFile || join(config.authDir, "auth.json");
}

function managed(config: Config) {
  const path = destination(config);
  const child = relative(config.authDir, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

async function save(path: string, store: Record<string, unknown>) {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function credentialStatus(config: Config): Promise<CredentialStatus> {
  try {
    const token = await load(config);
    const info = await stat(token.path);
    return {
      configured: true,
      importable: managed(config),
      refreshable: Boolean(token.refresh && (config.client || token.client)),
      expires_at: token.expires?.toISOString() ?? null,
      updated_at: info.mtime.toISOString()
    };
  } catch {
    return { configured: false, importable: managed(config), refreshable: false, expires_at: null, updated_at: null };
  }
}

function stale(token: CodexToken, skewMs: number) {
  return token.expires ? token.expires.getTime() - Date.now() <= skewMs : false;
}

function patch(store: Record<string, unknown>, payload: Record<string, unknown>) {
  const token = tokens(store);
  const user = identity(payload.id_token ?? token.id_token);
  token.access_token = payload.access_token;
  token.refresh_token = payload.refresh_token || token.refresh_token;
  token.id_token = payload.id_token || token.id_token;
  token.account_id = payload.account_id || user.account || token.account_id;
  token.email = payload.email || user.email || token.email;
  if (typeof payload.expires_in === "number") token.expired = new Date(Date.now() + payload.expires_in * 1000).toISOString();
  store.last_refresh = new Date().toISOString();
  if (token === store) store.type = store.type || "codex";
  return store;
}

async function renew(config: Config, token: CodexToken) {
  if (!token.refresh) throw new Error(`Codex token expired and ${token.path} has no refresh_token`);
  const client = config.client || token.client;
  if (!client) throw new Error("Codex OAuth client ID is unavailable");
  emit("info", "token_refresh", { account: token.account ? "present" : "missing", expires_at: token.expires?.toISOString() });

  const form = new URLSearchParams({
    client_id: client,
    grant_type: "refresh_token",
    refresh_token: token.refresh,
    scope: "openid profile email"
  });
  const response = await fetch(config.token, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(refreshTimeout)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Codex token refresh failed (${response.status}): ${text}`);

  const next = patch(token.store, JSON.parse(text) as Record<string, unknown>);
  const refreshed = parse(next, token.path);
  if (!refreshed) throw new Error("Codex token refresh returned an unusable credential");
  emit("info", "token_refreshed", { account: refreshed.account ? "present" : "missing", expires_at: refreshed.expires?.toISOString() });
  return refreshed;
}

async function probe(config: Config, token: CodexToken) {
  const headers = new Headers({ authorization: `Bearer ${token.access}`, "user-agent": config.userAgent });
  headers.set("chatgpt-account-id", token.account);
  const prefix = config.account.includes("/backend-api") ? "/wham" : "/api/codex";
  let failure: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${config.account}${prefix}/usage`, { headers, signal: AbortSignal.timeout(probeTimeout) });
      await response.text();
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        await Bun.sleep(1_000);
        continue;
      }
      return response.status;
    } catch (error) {
      failure = error as Error;
      if (attempt === 0) {
        await Bun.sleep(1_000);
        continue;
      }
    }
  }
  const reason = failure?.name === "TimeoutError" ? "timed out" : failure?.message || "failed";
  throw new Error(`Codex credential validation ${reason}`);
}

function canonical(token: CodexToken) {
  const source = tokens(token.store);
  const id = field(source.id_token, token.store.id_token);
  return {
    type: "codex",
    access_token: token.access,
    refresh_token: token.refresh,
    account_id: token.account,
    ...(id ? { id_token: id } : {}),
    ...(token.client ? { client_id: token.client } : {}),
    ...(token.expires ? { expired: token.expires.toISOString() } : {}),
    last_refresh: new Date().toISOString()
  };
}

export async function fresh(config: Config) {
  return serialized(async () => {
    const token = await load(config);
    if (!stale(token, config.refreshSkewMs)) return token;
    const refreshed = await renew(config, token);
    await save(token.path, refreshed.store);
    return refreshed;
  });
}

export async function importCredential(config: Config, source: string): Promise<CredentialStatus> {
  if (!managed(config)) throw new Error("credential imports require the managed auth path");
  let store: Record<string, unknown> | null = null;
  try {
    store = record(JSON.parse(source));
  } catch {}
  if (!store) throw new Error("auth.json is not valid JSON");

  return serialized(async () => {
    const path = destination(config);
    let token = parse(store, path);
    if (!token) throw new Error("auth.json does not contain a Codex access token");
    if (!token.refresh) throw new Error("auth.json does not contain a refresh token");
    if (!token.account) throw new Error("auth.json does not contain a ChatGPT account ID");

    let renewed = false;
    if (stale(token, config.refreshSkewMs)) {
      token = await renew(config, token);
      renewed = true;
    }
    let status = await probe(config, token);
    if (!renewed && (status === 401 || status === 403)) {
      token = await renew(config, token);
      status = await probe(config, token);
    }
    if (status < 200 || status >= 300) throw new Error(`Codex credential validation failed (${status})`);

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (await Bun.file(path).exists()) {
      await copyFile(path, `${path}.backup`);
      await chmod(`${path}.backup`, 0o600);
    }
    await save(path, canonical(token));
    return {
      configured: true,
      importable: true,
      refreshable: Boolean(config.client || token.client),
      expires_at: token.expires?.toISOString() ?? null,
      updated_at: new Date().toISOString()
    };
  });
}
