import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { LogLevel } from "./log";

type Settings = {
  version: 1;
  port: number;
  admin_password_hash: string;
  created_at: string;
};

export type Config = {
  configured: boolean;
  managed: boolean;
  configFile: string;
  host: string;
  port: number;
  adminPasswordHash: string;
  idleTimeout: number;
  authFile: string;
  authDir: string;
  stateDir: string;
  upstream: string;
  account: string;
  models: string[];
  userAgent: string;
  originator: string;
  client: string;
  token: string;
  updateRef: string;
  log: LogLevel;
  refreshSkewMs: number;
};

function port(value: unknown, fallback?: number) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) return parsed;
  if (fallback) return fallback;
  throw new Error(`invalid RuneShop port: ${value}`);
}

function startupPort(args: string[]) {
  const inline = args.find((value) => value.startsWith("--port="))?.slice(7);
  const index = args.indexOf("--port");
  const value = inline ?? (index >= 0 ? args[index + 1] : undefined);
  return value === undefined ? 3721 : port(value);
}

function settings(path: string): Settings | null {
  if (!existsSync(path)) return null;
  let value: Partial<Settings>;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
  } catch (error) {
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  if (
    value.version !== 1 ||
    typeof value.admin_password_hash !== "string" || !value.admin_password_hash.startsWith("$argon2id$") ||
    typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))
  ) throw new Error(`invalid RuneShop configuration: ${path}`);
  return { ...value, port: port(value.port) } as Settings;
}

export async function adminHash(password: string) {
  if (!password) throw new Error("admin pass is required");
  return Bun.password.hash(password);
}

export async function initialize(config: Config, passwordHash: string) {
  if (config.configured || await Bun.file(config.configFile).exists()) throw new Error("RuneShop is already configured");
  if (!passwordHash.startsWith("$argon2id$")) throw new Error("invalid admin password hash");
  const stored: Settings = {
    version: 1,
    port: config.port,
    admin_password_hash: passwordHash,
    created_at: new Date().toISOString()
  };
  const temporary = `${config.configFile}.${process.pid}.tmp`;
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await chmod(config.stateDir, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, config.configFile);
    await chmod(config.configFile, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function load(directory = resolve(homedir(), ".runeshop"), args = Bun.argv.slice(2)): Config {
  const configFile = resolve(directory, "config.json");
  const stored = settings(configFile);
  return {
    configured: Boolean(stored),
    managed: process.env.RUNESHOP_SERVICE === "systemd",
    configFile,
    host: "0.0.0.0",
    port: stored?.port ?? startupPort(args),
    adminPasswordHash: stored?.admin_password_hash ?? "",
    idleTimeout: 240,
    authFile: resolve(directory, "auth.json"),
    authDir: directory,
    stateDir: directory,
    upstream: "https://chatgpt.com/backend-api/codex",
    account: "https://chatgpt.com/backend-api",
    models: ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
    userAgent: "codex_cli_rs",
    originator: "codex_cli_rs",
    client: "app_EMoamEEZ73f0CkXaXp7hrann",
    token: "https://auth.openai.com/oauth/token",
    updateRef: "origin/main",
    log: "info",
    refreshSkewMs: 300_000
  };
}
