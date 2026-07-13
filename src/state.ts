import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
type Settings = { version: 1; port: number; admin_password_hash: string };
type RelayEvent = {
  time: string;
  path: string;
  client?: string;
  model?: string;
  status: number;
  duration: number;
  detail?: string;
};
type Period = { key: string; requests: number; failures: number };
type Store = { day: Period; month: Period; activity: RelayEvent[] };

export type Config = {
  configured: boolean;
  managed: boolean;
  configFile: string;
  port: number;
  adminPasswordHash: string;
  authFile: string;
  stateDir: string;
};

export async function read<T>(path: string) {
  return JSON.parse(await Bun.file(path).text()) as T;
}

export async function persist(path: string, value: unknown) {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally { await rm(temporary, { force: true }); }
}

function port(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) return parsed;
  throw new Error(`invalid RuneShop port: ${value}`);
}

function startupPort(parameters: string[]) {
  const inline = parameters.find((value) => value.startsWith("--port="))?.slice(7);
  const index = parameters.indexOf("--port");
  const value = inline ?? (index >= 0 ? parameters[index + 1] : undefined);
  return value === undefined ? 3721 : port(value);
}

function settings(path: string): Settings | null {
  if (!existsSync(path)) return null;
  let value: Partial<Settings>;
  try { value = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>; }
  catch (error) { throw new Error(`cannot read ${path}: ${(error as Error).message}`); }
  if (value.version !== 1 || typeof value.admin_password_hash !== "string" || !value.admin_password_hash.startsWith("$argon2id$"))
    throw new Error(`invalid RuneShop configuration: ${path}`);
  return { ...value, port: port(value.port) } as Settings;
}

export async function adminHash(password: string) {
  if (!password) throw new Error("admin pass is required");
  return Bun.password.hash(password);
}

export async function initialize(config: Config, passwordHash: string) {
  if (config.configured || await Bun.file(config.configFile).exists()) throw new Error("RuneShop is already configured");
  if (!passwordHash.startsWith("$argon2id$")) throw new Error("invalid admin password hash");
  await persist(config.configFile, { version: 1, port: config.port, admin_password_hash: passwordHash } satisfies Settings);
}

export function load(directory = resolve(homedir(), ".runeshop"), parameters = Bun.argv.slice(2)): Config {
  const configFile = resolve(directory, "config.json");
  const stored = settings(configFile);
  return {
    configured: Boolean(stored), managed: process.env.RUNESHOP_SERVICE === "systemd", configFile,
    port: stored?.port ?? startupPort(parameters), adminPasswordHash: stored?.admin_password_hash ?? "",
    authFile: resolve(directory, "auth.json"), stateDir: directory
  };
}

const priority: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 50 };
let threshold: LogLevel = "info";

export function configure(level: LogLevel) { threshold = level; }
export function elapsed(start: number) { return Math.round(performance.now() - start); }
export function emit(level: Exclude<LogLevel, "silent">, event: string, fields: Record<string, unknown> = {}) {
  if (priority[level] < priority[threshold]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  level === "warn" || level === "error" ? console.error(line) : console.log(line);
}

function keys(now: Date) {
  const day = now.toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7) };
}

const period = (key: string): Period => ({ key, requests: 0, failures: 0 });
function empty(now: Date): Store {
  const current = keys(now);
  return { day: period(current.day), month: period(current.month), activity: [] };
}

function summary({ key: period, requests, failures }: Period) {
  return { period, requests, failures, success_rate: requests ? Math.round((requests - failures) / requests * 1000) / 10 : 100 };
}

export class RelayState {
  readonly started: Date;
  private readonly file: string;
  private readonly ready: Promise<void>;
  private store: Store;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(directory: string, private readonly now = () => new Date()) {
    this.started = now();
    this.file = join(directory, "admin.json");
    this.store = empty(this.started);
    this.ready = this.load();
  }

  private async load() { try { this.store = await read<Store>(this.file); this.rotate(); } catch {} }
  private rotate() {
    const current = keys(this.now());
    if (this.store.day.key !== current.day) this.store.day = period(current.day);
    if (this.store.month.key !== current.month) this.store.month = period(current.month);
  }

  async record(event: RelayEvent) {
    await this.ready;
    this.rotate();
    const failed = event.status < 200 || event.status >= 400;
    for (const period of [this.store.day, this.store.month]) { period.requests++; if (failed) period.failures++; }
    this.store.activity = [event, ...this.store.activity].slice(0, 30);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void persist(this.file, this.store), 250);
  }

  async snapshot() {
    await this.ready;
    this.rotate();
    return {
      started_at: this.started.toISOString(),
      uptime_seconds: Math.floor((this.now().getTime() - this.started.getTime()) / 1000),
      today: summary(this.store.day), month: summary(this.store.month), activity: this.store.activity
    };
  }
}
