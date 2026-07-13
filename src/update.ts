import { resolve } from "node:path";
import type { Config } from "./config";
import { emit } from "./log";

export type Commit = { hash: string; subject: string };
const timeout = 15_000;

async function command(root: string, args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill();
  }, timeout);
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]).finally(() => clearTimeout(timer));
  if (expired) throw new Error(`${args.slice(0, 2).join(" ")} timed out after ${timeout / 1000} seconds`);
  if (code) throw new Error((error || output).trim() || `${args[0]} exited ${code}`);
  return output.trim();
}

export class Updater {
  readonly root = resolve(import.meta.dir, "..");
  private pending?: Promise<number>;

  constructor(private readonly config: Config, private readonly restart = () => process.exit(0)) {}

  async status(fetch = true) {
    let error = "";
    if (fetch) {
      try {
        await command(this.root, ["git", "fetch", "--quiet", "origin"]);
      } catch (cause) {
        error = (cause as Error).message;
      }
    }

    const current = await command(this.root, ["git", "rev-parse", "--short=7", "HEAD"]);
    let remote = current;
    let behind = 0;
    let ahead = 0;
    let commits: Commit[] = [];
    try {
      remote = await command(this.root, ["git", "rev-parse", "--short=7", this.config.updateRef]);
      behind = Number(await command(this.root, ["git", "rev-list", "--count", `HEAD..${this.config.updateRef}`]));
      ahead = Number(await command(this.root, ["git", "rev-list", "--count", `${this.config.updateRef}..HEAD`]));
      const log = behind
        ? await command(this.root, ["git", "log", "--format=%h%x09%s", "-n", "20", `HEAD..${this.config.updateRef}`])
        : "";
      commits = log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, ...subject] = line.split("\t");
          return { hash, subject: subject.join("\t") };
        });
    } catch (cause) {
      error ||= (cause as Error).message;
    }

    const dirty = Boolean(await command(this.root, ["git", "status", "--porcelain"]));
    const supported = this.config.managed;
    return {
      current,
      remote,
      behind,
      ahead,
      dirty,
      commits,
      supported,
      available: supported && behind > 0 && ahead === 0 && !dirty && !error,
      error: error || null
    };
  }

  async start() {
    if (this.pending) throw new Error("an update is already running");
    const status = await this.status(true);
    if (!status.supported) throw new Error("RuneShop is not managed by systemd");
    if (!status.available) throw new Error("update requires a clean, non-diverged checkout with remote commits available");

    const script = resolve(this.root, "scripts/update.sh");
    const child = Bun.spawn([
      script,
      this.config.updateRef,
      this.config.stateDir
    ], {
      cwd: this.root,
      env: { ...process.env, RUNESHOP_BUN: process.execPath },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit"
    });
    const pending = child.exited;
    this.pending = pending;
    void pending
      .then((code) => {
        if (code) return emit("error", "update_failed", { pid: child.pid, status: code });
        emit("info", "update_complete", { pid: child.pid });
        this.restart();
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    return { accepted: true, pid: child.pid };
  }
}
