import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RelayEvent = {
  time: string;
  path: string;
  client?: string;
  model?: string;
  status: number;
  duration: number;
  detail?: string;
};

type Store = {
  day: Period;
  month: Period;
  activity: RelayEvent[];
};

type Period = {
  key: string;
  requests: number;
  failures: number;
};

type LegacyStore = {
  date: string;
  requests: number;
  failures: number;
  activity: RelayEvent[];
};

function keys(now: Date) {
  const day = now.toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7) };
}

function period(key: string): Period {
  return { key, requests: 0, failures: 0 };
}

function empty(now: Date): Store {
  const current = keys(now);
  return { day: period(current.day), month: period(current.month), activity: [] };
}

function migrate(stored: Store | LegacyStore, now: Date): Store {
  if ("day" in stored) return stored;
  const next = empty(now);
  if (stored.date === next.day.key) Object.assign(next.day, { requests: stored.requests, failures: stored.failures });
  if (stored.date.startsWith(next.month.key)) Object.assign(next.month, { requests: stored.requests, failures: stored.failures });
  next.activity = stored.activity;
  return next;
}

function summary(period: Period) {
  const successes = period.requests - period.failures;
  return {
    period: period.key,
    requests: period.requests,
    failures: period.failures,
    success_rate: period.requests ? Math.round((successes / period.requests) * 1000) / 10 : 100
  };
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
    this.ready = this.restore();
  }

  private async restore() {
    try {
      this.store = migrate(JSON.parse(await readFile(this.file, "utf8")) as Store | LegacyStore, this.now());
      this.rotate();
    } catch {}
  }

  private rotate() {
    const current = keys(this.now());
    if (this.store.day.key !== current.day) this.store.day = period(current.day);
    if (this.store.month.key !== current.month) this.store.month = period(current.month);
  }

  async record(event: RelayEvent) {
    await this.ready;
    this.rotate();
    const failed = event.status < 200 || event.status >= 400;
    for (const period of [this.store.day, this.store.month]) {
      period.requests++;
      if (failed) period.failures++;
    }
    this.store.activity = [event, ...this.store.activity].slice(0, 30);
    this.schedule();
  }

  async snapshot() {
    await this.ready;
    this.rotate();
    return {
      started_at: this.started.toISOString(),
      uptime_seconds: Math.floor((this.now().getTime() - this.started.getTime()) / 1000),
      today: summary(this.store.day),
      month: summary(this.store.month),
      activity: this.store.activity
    };
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.persist(), 250);
  }

  private async persist() {
    const directory = this.file.slice(0, this.file.lastIndexOf("/"));
    const temporary = `${this.file}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(this.store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
