import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountBootstrap } from "../src/admin";
import { configure, load } from "../src/state";

test.serial("bootstraps RuneShop behind a one-time token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-bootstrap-"));
  const config = { ...load(directory, []), managed: false };
  const app = new Hono();
  const original = globalThis.fetch;
  configure("silent");
  mountBootstrap(app, config, "bootstrap-secret");
  globalThis.fetch = (async (input) => {
    expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
    return Response.json({ plan_type: "pro" });
  }) as typeof fetch;

  try {
    expect((await app.request("http://localhost/v1/models")).status).toBe(503);
    expect((await app.request("http://localhost/admin/api/status")).status).toBe(401);
    expect((await app.request("http://localhost/admin/login")).headers.get("location")).toBe("/bootstrap");
    const page = await app.request("http://localhost/bootstrap");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="bootstrap-form"');
    expect(html).toContain('id="admin-password" name="admin_password" type="text"');
    expect(html).toContain('placeholder="Choose admin pass" required');
    expect(html).toContain('id="manual-action-command"');
    expect(html).not.toContain('minlength="8"');
    const script = await (await app.request("http://localhost/bootstrap/app.js")).text();
    expect(script).toContain("sessionStorage.getItem(storageKey)");
    expect(script).toContain("byId(\"token-field\").hidden = !needsToken");
    expect((await app.request("http://localhost/base.css")).status).toBe(200);

    const denied = await app.request("http://localhost/bootstrap/api/setup", {
      method: "POST",
      headers: { "x-runeshop-bootstrap": "wrong" }
    });
    expect(denied.status).toBe(401);

    const empty = new FormData();
    empty.set("admin_password", "");
    empty.set("auth", new File([JSON.stringify({
      access_token: "access",
      refresh_token: "refresh",
      account_id: "account",
      expired: "2099-01-01T00:00:00Z"
    })], "auth.json", { type: "application/json" }));
    const missingPassword = await app.request("http://localhost/bootstrap/api/setup", {
      method: "POST",
      headers: { "x-runeshop-bootstrap": "bootstrap-secret" },
      body: empty
    });
    expect(missingPassword.status).toBe(400);
    expect(await Bun.file(config.authFile).exists()).toBe(false);
    expect(await Bun.file(config.configFile).exists()).toBe(false);

    const form = new FormData();
    const adminPassword = "short";
    form.set("admin_password", adminPassword);
    form.set("auth", new File([JSON.stringify({
      access_token: "access",
      refresh_token: "refresh",
      account_id: "account",
      expired: "2099-01-01T00:00:00Z"
    })], "auth.json", { type: "application/json" }));
    const setup = await app.request("http://localhost/bootstrap/api/setup", {
      method: "POST",
      headers: { "x-runeshop-bootstrap": "bootstrap-secret" },
      body: form
    });
    expect(setup.status).toBe(200);

    const stored = await readFile(config.configFile, "utf8");
    const configured = load(directory, []);
    expect(stored).not.toContain("api_key");
    expect(stored).not.toContain(adminPassword);
    expect(stored).not.toContain("bootstrap-secret");
    expect(await Bun.password.verify(adminPassword, configured.adminPasswordHash)).toBe(true);
    expect((await stat(config.authFile)).mode & 0o777).toBe(0o600);
    const status = await (await app.request("http://localhost/bootstrap/api/status")).json();
    expect(status.configured).toBe(true);
    expect(typeof status.systemd).toBe("boolean");
    expect(typeof status.manual_systemd).toBe("boolean");
    expect(status.managed).toBe(false);

    const repeated = await app.request("http://localhost/bootstrap/api/setup", {
      method: "POST",
      headers: { "x-runeshop-bootstrap": "bootstrap-secret" },
      body: form
    });
    expect(repeated.status).toBe(409);
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});
