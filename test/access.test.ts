import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessControl } from "../src/access";
import { application } from "../src/server";
import { configure, RequestState } from "../src/state";
import { configuration } from "./config";

configure("silent");

test("persists API access mode and generated tenant keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-access-"));
  const path = join(directory, "access.json");
  const access = new AccessControl(path);
  try {
    expect(access.snapshot()).toEqual({ required: false, tenants: [] });
    const created = await access.create("studio-mac");
    expect(created.tenants[0]).toMatchObject({ alias: "studio-mac", enabled: true });
    expect(created.tenants[0].key).toStartWith("rsk_");
    await access.require(true);
    await access.enable("studio-mac", false);

    const restored = new AccessControl(path).snapshot();
    expect(restored).toEqual({ required: true, tenants: [{ ...created.tenants[0], enabled: false }] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(access.create("STUDIO-MAC")).rejects.toThrow("alias already exists");
    expect(() => access.create(" ")).toThrow("alias is required");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.serial("authenticates model routes and records tenant aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-access-server-"));
  const config = configuration({
    accessFile: join(directory, "access.json"), authFile: join(directory, "auth.json"), stateDir: directory,
    adminPasswordHash: await Bun.password.hash("admin-secret")
  });
  const access = new AccessControl(config.accessFile);
  const active = (await access.create("studio-mac")).tenants[0];
  const disabled = (await access.create("retired-runner")).tenants[1];
  await access.enable(disabled.alias, false);
  await access.require(true);
  await writeFile(config.authFile, JSON.stringify({
    access_token: "upstream-access", account_id: "account", expired: "2099-01-01T00:00:00Z"
  }));
  const runtime = application(config);
  const original = globalThis.fetch;
  let upstreamAuthorization = "";
  globalThis.fetch = (async (_input, init) => {
    upstreamAuthorization = new Headers(init?.headers).get("authorization") || "";
    return Response.json({ id: "response" });
  }) as typeof fetch;
  const request = (path: string, init?: RequestInit) => runtime.fetch(new Request(`http://localhost${path}`, init));
  const body = JSON.stringify({
    model: "gpt-5.6-sol", input: "hello", reasoning: { effort: "high" },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ workspaces: { "/Users/natsuki/Lang/RuneShop": {} } })
    }
  });

  try {
    expect((await request("/health")).status).toBe(200);
    expect((await request("/v1/models")).status).toBe(401);
    expect((await request("/v1/models", { headers: { "x-api-key": active.key } })).status).toBe(200);

    const accepted = await request("/v1/responses", {
      method: "POST", headers: { authorization: `Bearer ${active.key}`, "content-type": "application/json" }, body
    });
    expect(accepted.status).toBe(200);
    expect(upstreamAuthorization).toBe("Bearer upstream-access");

    const unknown = await request("/v1/responses", {
      method: "POST", headers: { authorization: "Bearer rsk_unknown", "content-type": "application/json" }, body
    });
    expect(unknown.status).toBe(401);
    expect((await unknown.json()).error.code).toBe("invalid_api_key");

    const rejected = await request("/v1/responses", {
      method: "POST", headers: { authorization: `Bearer ${disabled.key}`, "content-type": "application/json" }, body
    });
    expect(rejected.status).toBe(401);

    const snapshot = await new RequestState(directory).snapshot();
    expect(snapshot.activity.map(({ client, status }) => ({ client, status }))).toEqual([
      { client: "retired-runner", status: 401 },
      { client: "/Users/natsuki/Lang/RuneShop", status: 401 },
      { client: "studio-mac", status: 200 }
    ]);
    expect(JSON.stringify(snapshot.activity)).not.toContain(active.key);
    expect(JSON.stringify(snapshot.activity)).not.toContain(disabled.key);

    const login = await request("/admin/api/session", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "admin-secret" })
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = await (await request("/admin/api/session", { headers: { cookie } })).json() as { csrf: string };
    const open = await request("/admin/api/access", {
      method: "PUT", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ required: false })
    });
    expect(open.status).toBe(200);
    expect((await request("/v1/models")).status).toBe(200);
    expect((await request("/v1/responses", {
      method: "POST", headers: { authorization: `Bearer ${active.key}`, "content-type": "application/json" }, body
    })).status).toBe(200);
    const openActivity = await new RequestState(directory).snapshot();
    expect(openActivity.activity[0].client).toBe("/Users/natsuki/Lang/RuneShop");
    expect(JSON.stringify(openActivity.activity)).not.toContain(active.key);
    await request("/admin/api/access", {
      method: "PUT", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ required: true })
    });
    expect((await request("/v1/models")).status).toBe(401);
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});
