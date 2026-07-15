import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AccessControl } from "../src/access";
import { mountAdmin } from "../src/admin";
import { configure, RequestState } from "../src/state";
import { configuration } from "./config";

test("protects the admin page with a cookie session and CSRF token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-admin-"));
  const app = new Hono();
  configure("silent");
  const config = configuration({
    adminPasswordHash: await Bun.password.hash("admin-secret"),
    accessFile: join(directory, "access.json"),
    authFile: join(directory, "auth.json"),
    stateDir: directory
  });
  mountAdmin(app, config, new RequestState(directory), new AccessControl(config.accessFile));

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
    expect(setCookie).toContain("Max-Age=2592000");

    const page = await app.request("http://localhost/admin", { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>RuneShop</title>");
    expect(html).toContain('id="codex-config"');
    expect(html).toContain('id="opencode-config"');
    expect(html).toContain('id="pi-config"');
    expect(html).toContain('href="/admin/access"');
    expect(html).not.toContain('id="client-shell"');
    expect(html.indexOf('class="card activity-card"')).toBeGreaterThan(html.indexOf('class="card setup-card"'));

    const script = await app.request("http://localhost/admin/app.js", { headers: { cookie } });
    expect(script.status).toBe(200);
    const javascript = await script.text();
    expect(javascript).toContain('const key = required ? "RUNESHOP_API_KEY" : "PWD"');
    expect(javascript).toContain('env_key = "${key}"');
    expect(javascript).toContain('apiKey: `{env:${key}}`');
    expect(javascript).toContain('apiKey: `$${key}`');
    expect(javascript).toContain('npm: "@ai-sdk/openai"');
    expect(javascript).toContain("RUNESHOP_API_KEY");
    expect(javascript).toContain("client.textContent = clientName(clientId)");
    expect(javascript).toContain("client.title = clientId");
    expect(javascript).toContain('event.fast ? "-⚡️" : ""');
    expect(javascript).toContain('activityCard.classList.toggle("show-project")');
    expect(javascript).toContain('event.count > 1 ? ` × ${event.count}` : ""');
    expect(javascript).toContain("window.window_seconds / 3600");
    expect(javascript).toContain('ui["secondary-label"].textContent');
    expect(javascript).toContain('primary ? `${used}%` : "♾️"');
    expect(javascript).toContain('secondary ? `${secondary.used_percent}%` : "♾️"');
    expect(javascript).not.toContain("importable");
    expect(javascript).toContain("if (loading) return");
    expect(javascript).toContain('request("/admin/api/status").then(status).catch(offline)');
    expect((await app.request("http://localhost/base.css")).status).toBe(200);
    const stylesheet = await app.request("http://localhost/admin/app.css", { headers: { cookie } });
    expect(stylesheet.status).toBe(200);
    expect(await stylesheet.text()).toContain(".activity-card.show-project");

    const accessPage = await app.request("http://localhost/admin/access", { headers: { cookie } });
    expect(accessPage.status).toBe(200);
    expect(await accessPage.text()).toContain('id="tenant-card"');
    expect((await app.request("http://localhost/admin/access.js", { headers: { cookie } })).status).toBe(200);
    expect((await app.request("http://localhost/admin/access.css", { headers: { cookie } })).status).toBe(200);

    const session = await app.request("http://localhost/admin/api/session", { headers: { cookie } });
    const { csrf } = await session.json() as { csrf: string };
    expect(await (await app.request("http://localhost/admin/api/access", { headers: { cookie } })).json()).toEqual({ required: false, tenants: [] });
    const accessDenied = await app.request("http://localhost/admin/api/access", {
      method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ required: true })
    });
    expect(accessDenied.status).toBe(403);
    const required = await app.request("http://localhost/admin/api/access", {
      method: "PUT", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ required: true })
    });
    expect((await required.json()).required).toBe(true);
    const created = await app.request("http://localhost/admin/api/access/tenants", {
      method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ alias: "studio-mac" })
    });
    const createdAccess = await created.json() as { tenants: Array<{ alias: string; key: string; enabled: boolean }> };
    expect(created.status).toBe(201);
    expect(createdAccess.tenants[0]).toMatchObject({ alias: "studio-mac", enabled: true });
    expect(createdAccess.tenants[0].key).toStartWith("rsk_");
    const disabled = await app.request("http://localhost/admin/api/access/tenants", {
      method: "PATCH", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ alias: "studio-mac", enabled: false })
    });
    expect((await disabled.json()).tenants[0].enabled).toBe(false);
    const denied = await app.request("http://localhost/admin/api/session/logout", { method: "POST", headers: { cookie } });
    expect(denied.status).toBe(403);

    const logout = await app.request("http://localhost/admin/api/session/logout", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf }
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await app.request("http://localhost/admin")).status).toBe(302);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
