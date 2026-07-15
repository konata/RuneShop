import { existsSync } from "node:fs";
import { chmod, chown, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { emit, type Config } from "./state";

export const service = "runeshop.service";
const root = resolve(import.meta.dir, "..");
const bun = process.execPath;
const target = `/etc/systemd/system/${service}`;

type ServiceIdentity = { home: string; uid: number; gid: number };
type Snapshot = { command: string; directory: string; started: string; uid: number };

export const identity = (): ServiceIdentity => ({ home: homedir(), uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 });

function available(...commands: string[]) {
  return process.platform === "linux" && existsSync("/run/systemd/system") && commands.every((command) => Bun.which(command));
}

export const serviceAvailable = () => process.getuid?.() === 0 && available("systemctl", "systemd-run");
export const manualServiceAvailable = () => process.getuid?.() !== 0 && available("sudo", "systemctl");
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function manualServiceCommand(owner = identity(), pid = process.pid) {
  return `sudo ${shell(bun)} run ${shell(resolve(root, "scripts/service.ts"))} handoff --home ${shell(owner.home)} --uid ${owner.uid} --gid ${owner.gid} --pid ${pid}`;
}

function rootOnly() {
  if (process.platform !== "linux") throw new Error("systemd service management is only supported on Linux");
  if (process.getuid?.() !== 0) throw new Error("systemd installation requires root");
}

async function snapshot(pid: number): Promise<Snapshot> {
  const processRoot = `/proc/${pid}`;
  const [command, directory, status, stats] = await Promise.all([
    readFile(`${processRoot}/cmdline`, "utf8"),
    readlink(`${processRoot}/cwd`),
    readFile(`${processRoot}/status`, "utf8"),
    readFile(`${processRoot}/stat`, "utf8")
  ]);
  const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
  const started = stats.slice(stats.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
  if (!Number.isInteger(uid) || !started) throw new Error(`cannot identify Bootstrap process ${pid}`);
  return { command, directory, started, uid };
}

async function bootstrap(owner: ServiceIdentity, pid: number) {
  let process: Snapshot;
  try { process = await snapshot(pid); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(`Bootstrap process ${pid} is no longer running`);
  }
  if (process.uid !== owner.uid || process.directory !== await realpath(root) || !process.command.includes("src/server.ts")) {
    throw new Error(`process ${pid} is not this RuneShop Bootstrap instance`);
  }
  return process.started;
}

async function exited(pid: number, started: string) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(100)) {
    try { if ((await snapshot(pid)).started !== started) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; else throw error; }
  }
  throw new Error("Bootstrap process did not exit within 10 seconds");
}

export async function command(parameters: string[]) {
  const code = await Bun.spawn(parameters, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
  if (code) throw new Error(`${parameters.join(" ")} exited ${code}`);
}

export async function render(owner = identity()) {
  return (await readFile(resolve(root, "deploy/runeshop.service"), "utf8"))
    .replaceAll("@ROOT@", root).replaceAll("@BUN@", bun).replaceAll("@HOME@", owner.home)
    .replaceAll("@UID@", String(owner.uid)).replaceAll("@GID@", String(owner.gid));
}

async function prepare(owner = identity()) {
  rootOnly();
  if (![owner.uid, owner.gid].every((id) => Number.isInteger(id) && id >= 0)) throw new Error("invalid service identity");
  if (!await Bun.file(bun).exists()) throw new Error(`Bun executable not found at ${bun}`);
  const state = resolve(owner.home, ".runeshop");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  await chown(state, owner.uid, owner.gid);
  for (const name of ["access.json", "auth.json", "config.json"]) {
    const path = resolve(state, name);
    if (await Bun.file(path).exists()) { await chmod(path, 0o600); await chown(path, owner.uid, owner.gid); }
  }
  await chmod(resolve(root, "scripts/update.sh"), 0o755);
  await writeFile(target, await render(owner), { mode: 0o644 });
  await command(["systemctl", "daemon-reload"]);
  await command(["systemctl", "enable", service]);
}

async function start() {
  await command(["systemctl", "start", service]);
  await command(["systemctl", "status", "--no-pager", service]);
}

export async function install(owner = identity()) { await prepare(owner); await start(); }

export async function handoff() {
  if (!serviceAvailable()) throw new Error("systemd installation is unavailable");
  await prepare();
  const unit = `runeshop-bootstrap-${Date.now()}`;
  await command(["systemd-run", `--unit=${unit}`, "--collect", "--no-block", "--on-active=2s", "systemctl", "start", service]);
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
  return { unit };
}

export async function manualHandoff(owner: ServiceIdentity, pid: number) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("invalid bootstrap process id");
  const started = await bootstrap(owner, pid);
  await prepare(owner);
  if (await bootstrap(owner, pid) !== started) throw new Error(`Bootstrap process ${pid} changed during service installation`);
  try { process.kill(pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  await exited(pid, started);
  await start();
}

export async function uninstall() {
  rootOnly();
  await command(["systemctl", "disable", "--now", service]);
  await rm(target, { force: true });
  await command(["systemctl", "daemon-reload"]);
}

type Commit = { hash: string; subject: string };
const gitTimeout = 15_000;

async function git(...parameters: string[]) {
  const child = Bun.spawn(["git", ...parameters], { cwd: root, stdout: "pipe", stderr: "pipe" });
  let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill(); }, gitTimeout);
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
  ]).finally(() => clearTimeout(timer));
  if (expired) throw new Error(`git ${parameters[0]} timed out after ${gitTimeout / 1000} seconds`);
  if (code) throw new Error((error || output).trim() || `git exited ${code}`);
  return output.trim();
}

export class Updater {
  private pending?: Promise<number>;

  constructor(
    private readonly config: Pick<Config, "managed" | "stateDir">,
    private readonly ref = "origin/main",
    private readonly restart = () => process.exit(0)
  ) {}

  async status(fetch = true) {
    let error = "";
    if (fetch) try { await git("fetch", "--quiet", "origin"); } catch (cause) { error = (cause as Error).message; }
    const [current, dirty] = await Promise.all([git("rev-parse", "--short=7", "HEAD"), git("status", "--porcelain").then(Boolean)]);
    let remote = current;
    let behind = 0;
    let ahead = 0;
    let commits: Commit[] = [];
    try {
      [remote, behind, ahead] = await Promise.all([
        git("rev-parse", "--short=7", this.ref),
        git("rev-list", "--count", `HEAD..${this.ref}`).then(Number),
        git("rev-list", "--count", `${this.ref}..HEAD`).then(Number)
      ]);
      if (behind) commits = (await git("log", "--format=%h%x09%s", "-n", "20", `HEAD..${this.ref}`))
        .split("\n").filter(Boolean).map((line) => {
          const [hash, ...subject] = line.split("\t");
          return { hash, subject: subject.join("\t") };
        });
    } catch (cause) { error ||= (cause as Error).message; }
    const supported = this.config.managed;
    const available = supported && behind > 0 && !ahead && !dirty && !error;
    return { current, remote, behind, ahead, dirty, commits, supported, available, error: error || null };
  }

  async start() {
    if (this.pending) throw new Error("an update is already running");
    const status = await this.status(true);
    if (!status.supported) throw new Error("RuneShop is not managed by systemd");
    if (!status.available) throw new Error("update requires a clean, non-diverged checkout with remote commits available");
    const child = Bun.spawn([resolve(root, "scripts/update.sh"), this.ref, this.config.stateDir], {
      cwd: root, env: { ...process.env, RUNESHOP_BUN: process.execPath }, stdin: "ignore", stdout: "inherit", stderr: "inherit"
    });
    const pending = child.exited;
    this.pending = pending;
    void pending.then((code) => {
      if (code) return emit("error", "update_failed", { pid: child.pid, status: code });
      emit("info", "update_complete", { pid: child.pid });
      this.restart();
    }).finally(() => { if (this.pending === pending) this.pending = undefined; });
    return { accepted: true, pid: child.pid };
  }
}
