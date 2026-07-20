import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { extname, resolve } from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AccessControl, AccessError } from "./access";
import { AccountClient, credentialStatus, importCredential } from "./account";
import { DeviceLogin } from "./device";
import { handoff, manualServiceAvailable, manualServiceCommand, serviceAvailable, Updater } from "./service";
import { adminHash, emit, initialize, type Config, type RequestState } from "./state";

const cookie = "runeshop-admin";
const root = resolve(import.meta.dir, "../public");
const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const media: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2"
};
const publicPaths = new Set([
  "/admin/login", "/admin/app.css", "/admin/login.js",
  "/admin/fonts/inter-latin.woff2", "/admin/fonts/jetbrains-mono-latin.woff2"
]);

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function failure(message: string, status = 400, code?: string) {
  return json({ error: { message, ...(code ? { code } : {}) } }, status);
}

function asset(name: string, cache = "no-cache") {
  return new Response(Bun.file(resolve(root, name)), { headers: {
    "content-type": media[extname(name)], "cache-control": cache, "content-security-policy": policy,
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY"
  } });
}

function assets(app: Hono, entries: Array<[string, string]>, cache = "no-cache") {
  for (const [path, file] of entries) app.get(path, () => asset(file, cache));
}

async function credentialForm(context: Context) {
  if (Number(context.req.header("content-length") || 0) > 1_100_000) return failure("auth.json exceeds the 1 MB limit", 413);
  const form = await context.req.raw.formData().catch(() => null);
  if (!form) return failure("invalid form data");
  const auth = form.get("auth");
  if (auth instanceof File && auth.size > 1_000_000) return failure("auth.json exceeds the 1 MB limit", 413);
  return form;
}

function mountDevice(app: Hono, path: string, device: DeviceLogin, authorize: (context: Context) => Response | null, read?: (context: Context) => Response | null) {
  app.post(path, async (context) => {
    const rejection = authorize(context);
    if (rejection) return rejection;
    try { return json(await device.start(), 202); }
    catch (cause) { return failure((cause as Error).message, 502); }
  });
  app.get(path, (context) => read?.(context) ?? json(device.status()));
  app.post(`${path}/cancel`, (context) => {
    const rejection = authorize(context);
    if (rejection) return rejection;
    return json(device.cancel());
  });
}

type AdminSession = { csrf: string; expires: number };
export class AdminSessions {
  readonly duration = 30 * 24 * 60 * 60;

  constructor(private readonly passwordHash: string) {}
  get enabled() { return Boolean(this.passwordHash); }
  private sign(claims: string) { return createHmac("sha256", this.passwordHash).update(claims).digest("base64url"); }
  async login(password: string) {
    if (!this.enabled || !await Bun.password.verify(password, this.passwordHash)) return null;
    const session = { csrf: randomBytes(24).toString("base64url"), expires: Date.now() + this.duration * 1000 };
    const claims = Buffer.from(JSON.stringify(session)).toString("base64url");
    return { token: `${claims}.${this.sign(claims)}`, session };
  }
  find(token?: string) {
    if (!this.enabled || !token) return null;
    const [claims, signature, extra] = token.split(".");
    if (!claims || !signature || extra) return null;
    const expected = this.sign(claims);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
      const session = JSON.parse(Buffer.from(claims, "base64url").toString()) as AdminSession;
      return typeof session.csrf === "string" && typeof session.expires === "number" && session.expires > Date.now() ? session : null;
    } catch { return null; }
  }
}

function secure(context: Context) {
  return new URL(context.req.url).protocol === "https:" || context.req.header("x-forwarded-proto") === "https";
}

function sessionReply(context: Context) {
  context.header("cache-control", "no-store");
  context.header("x-content-type-options", "nosniff");
  return context.json({ ok: true });
}

export function mountAdmin(app: Hono, config: Config, state: RequestState, access: AccessControl) {
  const account = new AccountClient(config);
  const updater = new Updater(config);
  const device = new DeviceLogin(config.authFile, () => account.invalidate());
  const sessions = new AdminSessions(config.adminPasswordHash);
  const active = (context: Context) => sessions.find(getCookie(context, cookie));
  const confirmed = (context: Context) => active(context)?.csrf === context.req.header("x-csrf-token");
  const guard: MiddlewareHandler = async (context, next) => {
    const path = context.req.path;
    if (publicPaths.has(path) || path === "/admin/api/session" && context.req.method === "POST" || active(context)) return next();
    return path.startsWith("/admin/api/") ? failure("admin session expired", 401) : context.redirect("/admin/login");
  };

  app.use("/admin", guard);
  app.use("/admin/*", guard);
  assets(app, [
    ["/base.css", "base.css"], ["/admin/app.css", "admin.css"], ["/admin/app.js", "admin.js"],
    ["/admin/access.css", "access.css"], ["/admin/access.js", "access.js"],
    ["/admin/login.js", "login.js"], ["/admin/fonts/inter-latin.woff2", "fonts/inter-latin.woff2"],
    ["/admin/fonts/jetbrains-mono-latin.woff2", "fonts/jetbrains-mono-latin.woff2"]
  ]);
  app.get("/admin/login", (context) => active(context) ? context.redirect("/admin") : asset("login.html", "no-store"));
  for (const path of ["/admin", "/admin/"]) app.get(path, () => asset("admin.html", "no-store"));
  app.get("/admin/access", () => asset("access.html", "no-store"));

  app.post("/admin/api/session", async (context) => {
    if (!sessions.enabled) return failure("admin password is unavailable", 503);
    const { password = "" } = await context.req.json<{ password?: string }>().catch((): { password?: string } => ({}));
    const login = await sessions.login(password);
    if (!login) return failure("invalid admin password", 401);
    setCookie(context, cookie, login.token, { httpOnly: true, maxAge: sessions.duration, path: "/admin", sameSite: "Strict", secure: secure(context) });
    emit("info", "admin_login", { status: "accepted" });
    return sessionReply(context);
  });
  app.get("/admin/api/session", (context) => json({ csrf: active(context)!.csrf }));
  app.post("/admin/api/session/logout", (context) => {
    if (!confirmed(context)) return failure("invalid confirmation token", 403);
    deleteCookie(context, cookie, { path: "/admin", secure: secure(context) });
    return sessionReply(context);
  });

  app.get("/admin/api/access", () => json(access.snapshot()));
  app.put("/admin/api/access", async (context) => {
    if (!confirmed(context)) return failure("invalid confirmation token", 403);
    const { required } = await context.req.json<{ required?: unknown }>().catch((): { required?: unknown } => ({}));
    if (typeof required !== "boolean") return failure("required must be a boolean");
    const snapshot = await access.require(required);
    emit("info", "admin_access_mode", { required });
    return json(snapshot);
  });
  app.post("/admin/api/access/tenants", async (context) => {
    if (!confirmed(context)) return failure("invalid confirmation token", 403);
    const { alias } = await context.req.json<{ alias?: unknown }>().catch((): { alias?: unknown } => ({}));
    if (typeof alias !== "string") return failure("alias is required");
    try {
      const snapshot = await access.create(alias);
      emit("info", "admin_access_tenant_created", { alias: alias.trim() });
      return json(snapshot, 201);
    } catch (cause) {
      if (cause instanceof AccessError) return failure(cause.message, cause.status);
      throw cause;
    }
  });
  app.patch("/admin/api/access/tenants", async (context) => {
    if (!confirmed(context)) return failure("invalid confirmation token", 403);
    const { alias, enabled } = await context.req.json<{ alias?: unknown; enabled?: unknown }>()
      .catch((): { alias?: unknown; enabled?: unknown } => ({}));
    if (typeof alias !== "string" || typeof enabled !== "boolean") return failure("alias and enabled are required");
    try {
      const snapshot = await access.enable(alias, enabled);
      emit("info", "admin_access_tenant", { alias, enabled });
      return json(snapshot);
    } catch (cause) {
      if (cause instanceof AccessError) return failure(cause.message, cause.status);
      throw cause;
    }
  });

  app.get("/admin/api/status", async () => {
    const [requests, revision] = await Promise.all([state.snapshot(), updater.status(false)]);
    return json({ online: true, platform: `${process.platform}/${process.arch}`, commit: revision.current, ...requests });
  });
  app.get("/admin/api/account", async (context) => {
    try { return json(await account.get(new URL(context.req.url).searchParams.get("refresh") === "1")); }
    catch (cause) {
      emit("warn", "admin_account_unavailable", { message: (cause as Error).message });
      return failure("account status is unavailable", 503);
    }
  });
  app.get("/admin/api/credentials", async () => json(await credentialStatus(config.authFile)));
  app.post("/admin/api/credentials", async (context) => {
    if (!confirmed(context)) return failure("invalid confirmation token", 403);
    const form = await credentialForm(context);
    if (form instanceof Response) return form;
    const auth = form.get("auth");
    if (!(auth instanceof File) || !auth.size) return failure("auth.json is required");
    const credentials = await importCredential(config.authFile, await auth.text());
    await account.invalidate();
    emit("info", "admin_credentials_imported", { refreshable: credentials.refreshable, expires_at: credentials.expires_at });
    return json(credentials);
  });
  mountDevice(app, "/admin/api/credentials/device", device, (context) => confirmed(context) ? null : failure("invalid confirmation token", 403));
  app.get("/admin/api/update", async () => json(await updater.status(true)));
  app.post("/admin/api/update", async (context) => {
    if (!confirmed(context)) return failure("invalid confirmation token", 403);
    if (context.req.header("x-runeshop-action") !== "update") return failure("missing update confirmation header");
    const started = await updater.start();
    emit("info", "admin_update", started);
    return json(started, 202);
  });
}

const digest = (value: string) => createHash("sha256").update(value).digest();
export function mountBootstrap(app: Hono, config: Config, secret = randomBytes(32).toString("base64url"), ready = () => {}) {
  const authorized = (value = "") => timingSafeEqual(digest(value), digest(secret));
  const denied = (value?: string) => authorized(value) ? null : failure("invalid bootstrap token", 401);
  const systemd = serviceAvailable();
  const manual = manualServiceAvailable();
  const serviceStatus = () => ({
    managed: config.managed, systemd, manual_systemd: manual,
    ...(manual ? { manual_systemd_command: manualServiceCommand() } : {})
  });

  const url = `http://${hostname() || "localhost"}:${config.port}/bootstrap#token=${encodeURIComponent(secret)}`;
  emit("info", "bootstrap_ready", { url, systemd, manual_systemd: manual });
  const device = new DeviceLogin(config.authFile);
  for (const path of ["/", "/admin", "/admin/", "/admin/login"]) app.get(path, (context) => context.redirect("/bootstrap"));
  app.all("/admin/api/*", () => failure("RuneShop setup is required", 401));
  assets(app, [
    ["/base.css", "base.css"], ["/bootstrap/app.css", "bootstrap.css"], ["/bootstrap/app.js", "bootstrap.js"],
    ["/admin/fonts/inter-latin.woff2", "fonts/inter-latin.woff2"],
    ["/admin/fonts/jetbrains-mono-latin.woff2", "fonts/jetbrains-mono-latin.woff2"]
  ], "no-store");
  app.get("/bootstrap", () => asset("bootstrap.html", "no-store"));
  app.get("/bootstrap/api/status", async () => json({ configured: await Bun.file(config.configFile).exists(), ...serviceStatus() }));

  mountDevice(app, "/bootstrap/api/device", device,
    (context) => denied(context.req.header("x-runeshop-bootstrap")),
    (context) => denied(context.req.header("x-runeshop-bootstrap")));

  app.post("/bootstrap/api/setup", async (context) => {
    const rejection = denied(context.req.header("x-runeshop-bootstrap"));
    if (rejection) return rejection;
    if (await Bun.file(config.configFile).exists()) return failure("RuneShop is already configured", 409);
    const form = await credentialForm(context);
    if (form instanceof Response) return form;
    const password = String(form.get("admin_password") ?? "");
    if (!password) return failure("admin pass is required");
    const passwordHash = await adminHash(password);
    const auth = form.get("auth");
    if (auth instanceof File && auth.size) await importCredential(config.authFile, await auth.text());
    else if (!await Bun.file(config.authFile).exists()) return failure("auth.json is required");
    await initialize(config, passwordHash);
    ready();
    emit("info", "bootstrap_complete", { port: config.port, client_access: "trusted", systemd, manual_systemd: manual });
    const response = json({ ok: true, ...serviceStatus() });
    if (config.managed) setTimeout(() => process.exit(0), 500);
    return response;
  });
  app.post("/bootstrap/api/service", async (context) => {
    const rejection = denied(context.req.header("x-runeshop-bootstrap"));
    if (rejection) return rejection;
    if (!await Bun.file(config.configFile).exists()) return failure("complete setup before installing the service", 409);
    const started = await handoff();
    emit("info", "bootstrap_service", started);
    return json({ ok: true, ...started }, 202);
  });
  app.all("*", () => failure("RuneShop setup is required", 503, "setup_required"));
}
