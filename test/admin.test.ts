import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountAdmin } from "../src/admin";
import { configure, RequestState } from "../src/state";
import { configuration } from "./config";

test("protects the admin page with a cookie session and CSRF token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-admin-"));
  const app = new Hono();
  configure("silent");
  const config = configuration({
    adminPasswordHash: await Bun.password.hash("admin-secret"),
    authFile: join(directory, "auth.json"),
    stateDir: directory
  });
  mountAdmin(app, config, new RequestState(directory));

  try {
    const anonymous = await app.request("http://localhost/admin");
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toBe("/admin/login");

    const rejected = await app.request("http://localhost/admin/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" })
    });
    expect(rejected.status).toBe(401);

    const login = await app.request("http://localhost/admin/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "admin-secret" })
    });
    const setCookie = login.headers.get("set-cookie")!;
    const cookie = setCookie.split(";")[0];
    expect(login.status).toBe(200);
    expect(cookie).not.toContain("admin-secret");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/admin");

    const page = await app.request("http://localhost/admin", { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>RuneShop</title>");
    expect(html).toContain('id="codex-config"');
    expect(html).toContain('id="opencode-config"');
    expect(html).not.toContain('id="client-shell"');
    expect(html.indexOf('class="card activity-card"')).toBeGreaterThan(html.indexOf('class="card setup-card"'));

    const script = await app.request("http://localhost/admin/app.js", { headers: { cookie } });
    expect(script.status).toBe(200);
    const javascript = await script.text();
    expect(javascript).toContain('env_key = "PWD"');
    expect(javascript).toContain('apiKey: "{env:PWD}"');
    expect(javascript).toContain('npm: "@ai-sdk/openai"');
    expect(javascript).not.toContain("RUNESHOP_API_KEY");
    expect(javascript).toContain("client.textContent = clientName(clientId)");
    expect(javascript).toContain("client.title = clientId");
    expect(javascript).toContain("window.window_seconds / 3600");
    expect(javascript).toContain('ui["secondary-label"].textContent');
    expect(javascript).toContain('primary ? `${used}%` : "Unlimited"');
    expect(javascript).toContain('secondary ? `${secondary.used_percent}%` : "Unlimited"');
    expect(javascript).not.toContain("importable");
    expect(javascript).toContain("if (loading) return");
    expect(javascript).toContain('request("/admin/api/status").then(status).catch(offline)');
    expect((await app.request("http://localhost/base.css")).status).toBe(200);

    const session = await app.request("http://localhost/admin/api/session", { headers: { cookie } });
    const { csrf } = await session.json() as { csrf: string };
    const denied = await app.request("http://localhost/admin/api/session/logout", { method: "POST", headers: { cookie } });
    expect(denied.status).toBe(403);

    const logout = await app.request("http://localhost/admin/api/session/logout", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf }
    });
    expect(logout.status).toBe(200);
    expect((await app.request("http://localhost/admin", { headers: { cookie } })).status).toBe(302);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
