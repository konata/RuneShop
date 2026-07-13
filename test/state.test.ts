import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

  await Bun.sleep(350);
  const stored = JSON.parse(await readFile(join(directory, "admin.json"), "utf8"));
  expect(stored.day.requests).toBe(1);
  expect(stored.month.requests).toBe(3);
  expect((await stat(join(directory, "admin.json"))).mode & 0o777).toBe(0o600);
  await rm(directory, { recursive: true, force: true });
});
