import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import type { Hono } from "hono";
import { adminHash, initialize, type Config } from "./config";
import { emit } from "./log";
import { handoff, manualServiceAvailable, manualServiceCommand, serviceAvailable } from "./service";
import { importCredential } from "./token";

const root = resolve(import.meta.dir, "../public");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function asset(name: string, type: string) {
  return new Response(Bun.file(resolve(root, name)), {
    headers: {
      "content-type": type,
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY"
    }
  });
}

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

export function mountBootstrap(app: Hono, config: Config, secret = randomBytes(32).toString("base64url")) {
  const authorized = (value = "") => timingSafeEqual(digest(value), digest(secret));
  const guarded = (header?: string) => authorized(header) ? null : json({ error: { message: "invalid bootstrap token" } }, 401);
  const available = serviceAvailable();
  const manual = manualServiceAvailable();

  emit("info", "bootstrap_ready", {
    url: `http://<server>:${config.port}/bootstrap`,
    token: secret,
    systemd: available,
    manual_systemd: manual
  });

  app.get("/", (context) => context.redirect("/bootstrap"));
  app.get("/admin", (context) => context.redirect("/bootstrap"));
  app.get("/admin/", (context) => context.redirect("/bootstrap"));
  app.get("/admin/login", (context) => context.redirect("/bootstrap"));
  app.all("/admin/api/*", () => json({ error: { message: "RuneShop setup is required" } }, 401));
  app.get("/bootstrap", () => asset("bootstrap.html", "text/html; charset=utf-8"));
  app.get("/bootstrap/app.css", () => asset("bootstrap.css", "text/css; charset=utf-8"));
  app.get("/bootstrap/app.js", () => asset("bootstrap.js", "text/javascript; charset=utf-8"));
  app.get("/admin/fonts/inter-latin.woff2", () => asset("fonts/inter-latin.woff2", "font/woff2"));
  app.get("/admin/fonts/jetbrains-mono-latin.woff2", () => asset("fonts/jetbrains-mono-latin.woff2", "font/woff2"));
  app.get("/bootstrap/api/status", async () => json({
    configured: await Bun.file(config.configFile).exists(),
    managed: config.managed,
    systemd: available,
    manual_systemd: manual,
    ...(manual ? { manual_systemd_command: manualServiceCommand() } : {})
  }));

  app.post("/bootstrap/api/setup", async (context) => {
    const denied = guarded(context.req.header("x-runeshop-bootstrap"));
    if (denied) return denied;
    if (await Bun.file(config.configFile).exists()) return json({ error: { message: "RuneShop is already configured" } }, 409);
    const length = Number(context.req.header("content-length") || 0);
    if (length > 1_100_000) return json({ error: { message: "auth.json exceeds the 1 MB limit" } }, 413);
    const form = await context.req.raw.formData().catch(() => null);
    const auth = form?.get("auth");
    const password = String(form?.get("admin_password") ?? "");
    if (!(auth instanceof File)) return json({ error: { message: "auth.json is required" } }, 400);
    if (auth.size > 1_000_000) return json({ error: { message: "auth.json exceeds the 1 MB limit" } }, 413);
    if (!password) return json({ error: { message: "admin pass is required" } }, 400);

    const passwordHash = await adminHash(password);
    await importCredential(config, await auth.text());
    await initialize(config, passwordHash);
    emit("info", "bootstrap_complete", { port: config.port, client_access: "trusted", systemd: available, manual_systemd: manual });
    const response = json({
      ok: true,
      managed: config.managed,
      systemd: available,
      manual_systemd: manual,
      ...(manual ? { manual_systemd_command: manualServiceCommand() } : {})
    });
    if (config.managed) setTimeout(() => process.exit(0), 500);
    return response;
  });

  app.post("/bootstrap/api/service", async (context) => {
    const denied = guarded(context.req.header("x-runeshop-bootstrap"));
    if (denied) return denied;
    if (!await Bun.file(config.configFile).exists()) return json({ error: { message: "complete setup before installing the service" } }, 409);
    const started = await handoff();
    emit("info", "bootstrap_service", started);
    return json({ ok: true, ...started }, 202);
  });

  app.all("*", () => json({ error: { message: "RuneShop setup is required", code: "setup_required" } }, 503));
}
