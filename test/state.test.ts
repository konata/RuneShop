import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestState } from "../src/state";

test("tracks daily and monthly request activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-state-"));
  let now = new Date("2026-07-10T12:00:00Z");
  const state = new RequestState(directory, () => now);
  await state.record({ time: new Date().toISOString(), path: "/responses", client: "/Users/natsuki/project", model: "gpt-5.5", status: 200, duration: 120 });
  await state.record({ time: new Date().toISOString(), path: "/responses", model: "gpt-5.5", status: 400, duration: 80, detail: "bad field" });

  let snapshot = await state.snapshot();
  expect(snapshot.today).toEqual({ period: "2026-07-10", requests: 2, failures: 1, success_rate: 50 });
  expect(snapshot.month).toEqual({ period: "2026-07", requests: 2, failures: 1, success_rate: 50 });
  expect(snapshot.activity[1].client).toBe("/Users/natsuki/project");

  now = new Date("2026-07-11T12:00:00Z");
  await state.record({ time: now.toISOString(), path: "/responses", model: "gpt-5.5", status: 200, duration: 60 });
  snapshot = await state.snapshot();
  expect(snapshot.today.requests).toBe(1);
  expect(snapshot.month.requests).toBe(3);
  expect(snapshot.activity[0].time).toBe(now.toISOString());

  const path = join(directory, "state.sqlite");
  const database = new Database(path, { readonly: true });
  expect(database.query("SELECT count(*) AS count FROM requests").get()).toEqual({ count: 3 });
  expect(database.query("SELECT requests, failures FROM periods WHERE period = ?").get("2026-07")).toEqual({ requests: 3, failures: 1 });
  database.close();
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await rm(directory, { recursive: true, force: true });
});

test("squashes consecutive activity while retaining raw events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-history-"));
  const state = new RequestState(directory);
  try {
    const record = (time: number, status: number, detail?: string, effort = "high", fast = false) => state.record({
      time: new Date(time * 1000).toISOString(), path: "/responses", client: "/root/project",
      model: "gpt-5.6-sol", effort, ...(fast ? { fast: true } : {}), status, duration: time, ...(detail ? { detail } : {})
    });
    await record(1, 200);
    await record(2, 200);
    await record(3, 400, "first error");
    await record(4, 400, "first error");
    await record(5, 400, "second error");
    await record(6, 200, undefined, "xhigh");
    await record(7, 200, undefined, "xhigh", true);

    const recent = (await state.snapshot()).activity;
    expect(recent.map(({ status, detail, count }) => ({ status, detail, count }))).toEqual([
      { status: 200, detail: undefined, count: 1 },
      { status: 200, detail: undefined, count: 1 },
      { status: 400, detail: "second error", count: 1 },
      { status: 400, detail: "first error", count: 2 },
      { status: 200, detail: undefined, count: 2 }
    ]);
    expect(recent[0]).toMatchObject({ effort: "xhigh", fast: true });
    expect(recent[1].effort).toBe("xhigh");
    expect(recent[1].fast).toBeUndefined();
    expect(recent[3].time).toBe(new Date(4_000).toISOString());
    expect(recent[4].time).toBe(new Date(2_000).toISOString());
    const database = new Database(join(directory, "state.sqlite"), { readonly: true });
    expect(database.query("SELECT count(*) AS count FROM requests").get()).toEqual({ count: 7 });
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains the latest ten thousand events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-retention-"));
  const state = new RequestState(directory);
  const path = join(directory, "state.sqlite");
  const database = new Database(path);
  const insert = database.query("INSERT INTO requests (event) VALUES (?)");
  database.transaction(() => {
    for (let model = 0; model < 11_005; model++)
      insert.run(JSON.stringify({
        time: new Date(model * 1000).toISOString(), path: "/responses", client: "/root/project",
        model: String(model), status: 200, duration: 1
      }));
  })();
  database.close();

  try {
    state.record({ time: new Date().toISOString(), path: "/responses", model: "latest", status: 200, duration: 1 });
    const recent = (await state.snapshot()).activity;
    expect(recent).toHaveLength(30);
    expect(recent[0].model).toBe("latest");
    expect(recent.at(-1)?.model).toBe("10976");
    const stored = new Database(path, { readonly: true });
    expect(stored.query("SELECT count(*) AS count FROM requests").get()).toEqual({ count: 10_000 });
    const oldest = stored.query<{ event: string }, []>("SELECT event FROM requests ORDER BY id LIMIT 1").get();
    expect(JSON.parse(oldest!.event).model).toBe("1006");
    stored.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
