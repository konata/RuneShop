import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminHash, initialize, load } from "../src/state";

test("persists bootstrap settings and hashes the admin password", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-config-"));
  try {
    const initial = load(directory, ["--port", "4321"]);
    expect(initial.configured).toBe(false);
    expect(initial.port).toBe(4321);

    await initialize(initial, await adminHash("admin-secret"));
    const source = await readFile(initial.configFile, "utf8");
    const configured = load(directory, []);
    expect(source).not.toContain("api_key");
    expect(source).not.toContain("admin-secret");
    expect((await stat(initial.configFile)).mode & 0o777).toBe(0o600);
    expect(configured.configured).toBe(true);
    expect(configured.port).toBe(4321);
    expect(await Bun.password.verify("admin-secret", configured.adminPasswordHash)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an empty admin pass before initialization", async () => {
  await expect(adminHash("")).rejects.toThrow("admin pass is required");
});

test("rejects malformed persisted settings and startup ports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-config-"));
  try {
    expect(() => load(directory, ["--port", "70000"])).toThrow("invalid RuneShop port");
    await writeFile(join(directory, "config.json"), "{}\n");
    expect(() => load(directory, [])).toThrow("invalid RuneShop configuration");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
