import { chmod, chown, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const service = "runeshop.service";
const root = resolve(import.meta.dir, "..");
const bun = process.execPath;
const target = `/etc/systemd/system/${service}`;

export type ServiceIdentity = { home: string; uid: number; gid: number };
type ProcessSnapshot = { command: string; directory: string; started: string; uid: number };

export function identity(): ServiceIdentity {
  return { home: homedir(), uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
}

export function serviceAvailable() {
  return process.platform === "linux" && process.getuid?.() === 0 && existsSync("/run/systemd/system") && Boolean(Bun.which("systemctl") && Bun.which("systemd-run"));
}

export function manualServiceAvailable() {
  return process.platform === "linux" && process.getuid?.() !== 0 && existsSync("/run/systemd/system") && Boolean(Bun.which("sudo") && Bun.which("systemctl"));
}

function shell(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function manualServiceCommand(owner = identity(), pid = process.pid) {
  return `sudo ${shell(bun)} run ${shell(resolve(root, "scripts/service.ts"))} handoff --home ${shell(owner.home)} --uid ${owner.uid} --gid ${owner.gid} --pid ${pid}`;
}

function rootOnly() {
  if (process.getuid?.() !== 0) throw new Error("systemd installation requires root");
  if (process.platform !== "linux") throw new Error("systemd service management is only supported on Linux");
}

async function snapshot(pid: number): Promise<ProcessSnapshot> {
  const directory = `/proc/${pid}`;
  const [command, cwd, status, stat] = await Promise.all([
    readFile(`${directory}/cmdline`, "utf8"),
    readlink(`${directory}/cwd`),
    readFile(`${directory}/status`, "utf8"),
    readFile(`${directory}/stat`, "utf8")
  ]);
  const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
  const started = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
  if (!Number.isInteger(uid) || !started) throw new Error(`cannot identify Bootstrap process ${pid}`);
  return { command, directory: cwd, started, uid };
}

async function bootstrap(owner: ServiceIdentity, pid: number) {
  let target: ProcessSnapshot;
  try {
    target = await snapshot(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(`Bootstrap process ${pid} is no longer running`);
  }
  if (target.uid !== owner.uid || target.directory !== await realpath(root) || !target.command.includes("src/server.ts")) {
    throw new Error(`process ${pid} is not this RuneShop Bootstrap instance`);
  }
  return target.started;
}

async function exited(pid: number, started: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    try {
      if ((await snapshot(pid)).started !== started) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  throw new Error("Bootstrap process did not exit within 10 seconds");
}

export async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code) throw new Error(`${args.join(" ")} exited ${code}`);
}

export async function render(owner = identity()) {
  const template = await readFile(resolve(root, "deploy/runeshop.service"), "utf8");
  return template
    .replaceAll("@ROOT@", root)
    .replaceAll("@BUN@", bun)
    .replaceAll("@HOME@", owner.home)
    .replaceAll("@UID@", String(owner.uid))
    .replaceAll("@GID@", String(owner.gid));
}

export async function prepare(owner = identity()) {
  rootOnly();
  if (!Number.isInteger(owner.uid) || owner.uid < 0 || !Number.isInteger(owner.gid) || owner.gid < 0) throw new Error("invalid service identity");
  if (!(await Bun.file(bun).exists())) throw new Error(`Bun executable not found at ${bun}`);
  const state = resolve(owner.home, ".runeshop");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  await chown(state, owner.uid, owner.gid);
  for (const name of ["auth.json", "config.json"]) {
    const path = resolve(state, name);
    if (!await Bun.file(path).exists()) continue;
    await chmod(path, 0o600);
    await chown(path, owner.uid, owner.gid);
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

export async function install(owner = identity()) {
  await prepare(owner);
  await start();
}

export async function handoff() {
  if (!serviceAvailable()) throw new Error("systemd installation is unavailable");
  await prepare();
  const unit = `runeshop-bootstrap-${Date.now()}`;
  await command([
    "systemd-run",
    `--unit=${unit}`,
    "--collect",
    "--no-block",
    "--on-active=2s",
    "systemctl",
    "start",
    service
  ]);
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
  return { unit };
}

export async function manualHandoff(owner: ServiceIdentity, pid: number) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("invalid bootstrap process id");
  const started = await bootstrap(owner, pid);
  await prepare(owner);
  if (await bootstrap(owner, pid) !== started) throw new Error(`Bootstrap process ${pid} changed during service installation`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await exited(pid, started);
  await start();
}

export async function uninstall() {
  rootOnly();
  await command(["systemctl", "disable", "--now", service]);
  await rm(target, { force: true });
  await command(["systemctl", "daemon-reload"]);
}
