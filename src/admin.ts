import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { extname, resolve } from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AccountClient, credentialStatus, importCredential } from "./account";
import { handoff, manualServiceAvailable, manualServiceCommand, serviceAvailable, Updater } from "./service";
import { adminHash, emit, initialize, type Config, type RelayState } from "./state";

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
  const auth = form?.get("auth");
  if (!(auth instanceof File)) return failure("auth.json is required");
  if (auth.size > 1_000_000) return failure("auth.json exceeds the 1 MB limit", 413);
  return form!;
}

type AdminSession = { csrf: string; expires: number };
export class AdminSessions {
  readonly duration = 12 * 60 * 60;
  private readonly sessions = new Map<string, AdminSession>();

  constructor(private readonly passwordHash: string) {}
  get enabled() { return Boolean(this.passwordHash); }
  async login(password: string) {
    if (!this.enabled || !await Bun.password.verify(password, this.passwordHash)) return null;
    const now = Date.now();
    for (const [token, session] of this.sessions) if (session.expires <= now) this.sessions.delete(token);
    const token = randomBytes(32).toString("base64url");
    const session = { csrf: randomBytes(24).toString("base64url"), expires: now + this.duration * 1000 };
    this.sessions.set(token, session);
    return { token, session };
  }
  find(token?: string) {
    const session = token ? this.sessions.get(token) : undefined;
    if (session && session.expires > Date.now()) return session;
    if (token) this.sessions.delete(token);
    return null;
  }
  logout(token?: string) { if (token) this.sessions.delete(token); }
}

function secure(context: Context) {
  return new URL(context.req.url).protocol === "https:" || context.req.header("x-forwarded-proto") === "https";
}

function sessionReply(context: Context) {
  context.header("cache-control", "no-store");
  context.header("x-content-type-options", "nosniff");
  return context.json({ ok: true });
}

export function mountAdmin(app: Hono, config: Config, state: RelayState) {
  const account = new AccountClient(config);
  const updater = new Updater(config);
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
    ["/admin/login.js", "login.js"], ["/admin/fonts/inter-latin.woff2", "fonts/inter-latin.woff2"],
    ["/admin/fonts/jetbrains-mono-latin.woff2", "fonts/jetbrains-mono-latin.woff2"]
  ]);
  app.get("/admin/login", (context) => active(context) ? context.redirect("/admin") : asset("login.html", "no-store"));
  for (const path of ["/admin", "/admin/"]) app.get(path, () => asset("admin.html", "no-store"));

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
    sessions.logout(getCookie(context, cookie));
    deleteCookie(context, cookie, { path: "/admin", secure: secure(context) });
    return sessionReply(context);
  });

  app.get("/admin/api/status", async () => {
    const [relay, revision] = await Promise.all([state.snapshot(), updater.status(false)]);
    return json({ online: true, platform: `${process.platform}/${process.arch}`, commit: revision.current, ...relay });
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
    const credentials = await importCredential(config.authFile, await (form.get("auth") as File).text());
    await account.invalidate();
    emit("info", "admin_credentials_imported", { refreshable: credentials.refreshable, expires_at: credentials.expires_at });
    return json(credentials);
  });
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
export function mountBootstrap(app: Hono, config: Config, secret = randomBytes(32).toString("base64url")) {
  const authorized = (value = "") => timingSafeEqual(digest(value), digest(secret));
  const denied = (value?: string) => authorized(value) ? null : failure("invalid bootstrap token", 401);
  const systemd = serviceAvailable();
  const manual = manualServiceAvailable();
  const serviceStatus = () => ({
    managed: config.managed, systemd, manual_systemd: manual,
    ...(manual ? { manual_systemd_command: manualServiceCommand() } : {})
  });

  emit("info", "bootstrap_ready", { url: `http://<server>:${config.port}/bootstrap`, token: secret, systemd, manual_systemd: manual });
  for (const path of ["/", "/admin", "/admin/", "/admin/login"]) app.get(path, (context) => context.redirect("/bootstrap"));
  app.all("/admin/api/*", () => failure("RuneShop setup is required", 401));
  assets(app, [
    ["/base.css", "base.css"], ["/bootstrap/app.css", "bootstrap.css"], ["/bootstrap/app.js", "bootstrap.js"],
    ["/admin/fonts/inter-latin.woff2", "fonts/inter-latin.woff2"],
    ["/admin/fonts/jetbrains-mono-latin.woff2", "fonts/jetbrains-mono-latin.woff2"]
  ], "no-store");
  app.get("/bootstrap", () => asset("bootstrap.html", "no-store"));
  app.get("/bootstrap/api/status", async () => json({ configured: await Bun.file(config.configFile).exists(), ...serviceStatus() }));

  app.post("/bootstrap/api/setup", async (context) => {
    const rejection = denied(context.req.header("x-runeshop-bootstrap"));
    if (rejection) return rejection;
    if (await Bun.file(config.configFile).exists()) return failure("RuneShop is already configured", 409);
    const form = await credentialForm(context);
    if (form instanceof Response) return form;
    const password = String(form.get("admin_password") ?? "");
    if (!password) return failure("admin pass is required");
    const passwordHash = await adminHash(password);
    await importCredential(config.authFile, await (form.get("auth") as File).text());
    await initialize(config, passwordHash);
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
