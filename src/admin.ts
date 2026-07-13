import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { resolve } from "node:path";
import { AccountClient } from "./account";
import type { Config } from "./config";
import { emit } from "./log";
import { AdminSessions } from "./session";
import type { RelayState } from "./state";
import { credentialStatus, importCredential } from "./token";
import { Updater } from "./update";

const root = resolve(import.meta.dir, "../public");
const cookie = "runeshop-admin";
const publicPaths = new Set([
  "/admin/login",
  "/admin/app.css",
  "/admin/login.js",
  "/admin/fonts/inter-latin.woff2",
  "/admin/fonts/jetbrains-mono-latin.woff2"
]);

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

function asset(name: string, type: string, cache = "no-cache") {
  return new Response(Bun.file(resolve(root, name)), {
    headers: {
      "content-type": type,
      "cache-control": cache,
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY"
    }
  });
}

function secure(context: Context) {
  return new URL(context.req.url).protocol === "https:" || context.req.header("x-forwarded-proto") === "https";
}

export function mountAdmin(app: Hono, config: Config, state: RelayState) {
  const account = new AccountClient(config);
  const updater = new Updater(config);
  const sessions = new AdminSessions(config.adminPasswordHash);
  const active = (context: Context) => sessions.find(getCookie(context, cookie));
  const confirmed = (context: Context) => active(context)?.csrf === context.req.header("x-csrf-token");
  const guard: MiddlewareHandler = async (context, next) => {
    const { pathname } = new URL(context.req.url);
    if (publicPaths.has(pathname) || (pathname === "/admin/api/session" && context.req.method === "POST")) return next();
    if (active(context)) return next();
    return pathname.startsWith("/admin/api/") ? json({ error: { message: "admin session expired" } }, 401) : context.redirect("/admin/login");
  };

  app.use("/admin", guard);
  app.use("/admin/*", guard);

  app.get("/admin/login", (context) => active(context) ? context.redirect("/admin") : asset("login.html", "text/html; charset=utf-8", "no-store"));
  app.get("/admin/app.css", () => asset("admin.css", "text/css; charset=utf-8"));
  app.get("/admin/app.js", () => asset("admin.js", "text/javascript; charset=utf-8"));
  app.get("/admin/login.js", () => asset("login.js", "text/javascript; charset=utf-8"));
  app.get("/admin/fonts/inter-latin.woff2", () => asset("fonts/inter-latin.woff2", "font/woff2"));
  app.get("/admin/fonts/jetbrains-mono-latin.woff2", () => asset("fonts/jetbrains-mono-latin.woff2", "font/woff2"));

  app.post("/admin/api/session", async (context) => {
    if (!sessions.enabled) return json({ error: { message: "admin password is unavailable" } }, 503);
    const body = await context.req.json<{ password?: string }>().catch((): { password?: string } => ({}));
    const login = await sessions.login(body.password ?? "");
    if (!login) return json({ error: { message: "invalid admin password" } }, 401);
    setCookie(context, cookie, login.token, {
      httpOnly: true,
      maxAge: sessions.duration,
      path: "/admin",
      sameSite: "Strict",
      secure: secure(context)
    });
    emit("info", "admin_login", { status: "accepted" });
    context.header("cache-control", "no-store");
    context.header("x-content-type-options", "nosniff");
    return context.json({ ok: true });
  });

  app.get("/admin/api/session", (context) => json({ csrf: active(context)!.csrf }));
  app.post("/admin/api/session/logout", (context) => {
    if (!confirmed(context)) return json({ error: { message: "invalid confirmation token" } }, 403);
    sessions.logout(getCookie(context, cookie));
    deleteCookie(context, cookie, { path: "/admin", secure: secure(context) });
    context.header("cache-control", "no-store");
    context.header("x-content-type-options", "nosniff");
    return context.json({ ok: true });
  });

  app.get("/admin", () => asset("admin.html", "text/html; charset=utf-8", "no-store"));
  app.get("/admin/", () => asset("admin.html", "text/html; charset=utf-8", "no-store"));

  app.get("/admin/api/status", async () => {
    const [relay, revision] = await Promise.all([state.snapshot(), updater.status(false)]);
    return json({ online: true, platform: `${process.platform}/${process.arch}`, commit: revision.current, ...relay });
  });

  app.get("/admin/api/account", async (context) => {
    const force = new URL(context.req.url).searchParams.get("refresh") === "1";
    try {
      return json(await account.get(force));
    } catch (error) {
      emit("warn", "admin_account_unavailable", { message: (error as Error).message });
      return json({ error: { message: "account status is unavailable" } }, 503);
    }
  });

  app.get("/admin/api/credentials", async () => json(await credentialStatus(config)));
  app.post("/admin/api/credentials", async (context) => {
    if (!confirmed(context)) return json({ error: { message: "invalid confirmation token" } }, 403);
    const length = Number(context.req.header("content-length") || 0);
    if (length > 1_100_000) return json({ error: { message: "auth.json exceeds the 1 MB limit" } }, 413);
    const form = await context.req.raw.formData().catch(() => null);
    const file = form?.get("auth");
    if (!(file instanceof File)) return json({ error: { message: "auth.json is required" } }, 400);
    if (file.size > 1_000_000) return json({ error: { message: "auth.json exceeds the 1 MB limit" } }, 413);
    const credentials = await importCredential(config, await file.text());
    await account.invalidate();
    emit("info", "admin_credentials_imported", { refreshable: credentials.refreshable, expires_at: credentials.expires_at });
    return json(credentials);
  });

  app.get("/admin/api/update", async () => json(await updater.status(true)));
  app.post("/admin/api/update", async (context) => {
    if (!confirmed(context)) return json({ error: { message: "invalid confirmation token" } }, 403);
    if (context.req.header("x-runeshop-action") !== "update") {
      return json({ error: { message: "missing update confirmation header" } }, 400);
    }
    const started = await updater.start();
    emit("info", "admin_update", started);
    return json(started, 202);
  });
}
