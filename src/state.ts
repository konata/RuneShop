import { chmodSync, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
type Settings = { version: 1; port: number; admin_password_hash: string };
type RequestEvent = {
  time: string;
  path: string;
  client?: string;
  model?: string;
  status: number;
  duration: number;
  detail?: string;
};
type Activity = RequestEvent & { count: number };
const historyLimit = 10_000;
const activityLimit = 30;

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

async function replace(path: string, source: string) {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, source, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally { await rm(temporary, { force: true }); }
}

export async function persist(path: string, value: unknown) {
  await replace(path, `${JSON.stringify(value, null, 2)}\n`);
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

function summary(period: string, counts?: { requests: number; failures: number }) {
  const { requests = 0, failures = 0 } = counts ?? {};
  return { period, requests, failures, success_rate: requests ? Math.round((requests - failures) / requests * 1000) / 10 : 100 };
}

function squash(events: RequestEvent[]) {
  const activity: Activity[] = [];
  for (const event of events) {
    const previous = activity.at(-1);
    const failed = event.status < 200 || event.status >= 400;
    if (previous && previous.status === event.status && previous.model === event.model && previous.client === event.client
      && (!failed || previous.detail === event.detail)) {
      previous.count++;
      continue;
    }
    if (activity.length === activityLimit) break;
    activity.push({ ...event, count: 1 });
  }
  return activity;
}

export class RequestState {
  readonly started: Date;
  private readonly database: Database;
  private readonly write: (event: RequestEvent, day: string, month: string, failed: number) => void;

  constructor(directory: string, private readonly now = () => new Date()) {
    this.started = now();
    const path = join(directory, "state.sqlite");
    this.database = new Database(path, { create: true, strict: true });
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS periods (
        period TEXT PRIMARY KEY,
        requests INTEGER NOT NULL,
        failures INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY,
        event TEXT NOT NULL
      );
    `);
    chmodSync(path, 0o600);

    const increment = this.database.query(`
      INSERT INTO periods (period, requests, failures) VALUES (?, 1, ?)
      ON CONFLICT (period) DO UPDATE SET
        requests = requests + 1,
        failures = failures + excluded.failures
    `);
    const insert = this.database.query("INSERT INTO requests (event) VALUES (?)");
    const trim = this.database.query("DELETE FROM requests WHERE id <= last_insert_rowid() - ?");
    this.write = this.database.transaction((event: RequestEvent, day: string, month: string, failed: number) => {
      increment.run(day, failed);
      increment.run(month, failed);
      insert.run(JSON.stringify(event));
      trim.run(historyLimit);
    });
  }

  async record(event: RequestEvent) {
    const { day, month } = keys(this.now());
    const failed = event.status < 200 || event.status >= 400;
    this.write(event, day, month, Number(failed));
  }

  async snapshot() {
    const { day, month } = keys(this.now());
    const counts = this.database.query<{ requests: number; failures: number }, [string]>(
      "SELECT requests, failures FROM periods WHERE period = ?"
    );
    const history = this.database.query<{ event: string }, [number]>(
      "SELECT event FROM requests ORDER BY id DESC LIMIT ?"
    ).all(historyLimit).map(({ event }) => JSON.parse(event) as RequestEvent);
    return {
      started_at: this.started.toISOString(),
      uptime_seconds: Math.floor((this.now().getTime() - this.started.getTime()) / 1000),
      today: summary(day, counts.get(day) ?? undefined),
      month: summary(month, counts.get(month) ?? undefined),
      activity: squash(history)
    };
  }
}
