import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { mountAdmin } from "./admin";
import { mountBootstrap } from "./bootstrap";
import { load, type Config } from "./config";
import { compact, models, responses } from "./codex";
import { configure, elapsed, emit } from "./log";
import { RelayState } from "./state";

const config = load();
configure(config.log);
const app = new Hono();

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function problem(status: number, message: string, code = "proxy_error") {
  return json({ error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", code } }, { status });
}

function clientId(request: Request) {
  return (request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || request.headers.get("x-api-key") || "").trim();
}

function wantsClientModels(request: Request) {
  return new URL(request.url).searchParams.has("client_version");
}

function admin(path: string) {
  return path === "/admin" || path.startsWith("/admin/");
}

function mountRelay(config: Config) {
  const state = new RelayState(config.stateDir);
  app.use("*", async (context, next) => {
    const start = performance.now();
    const { method } = context.req;
    const { pathname } = new URL(context.req.url);
    if (admin(pathname)) {
      await next();
      emit("debug", "admin_request", { method, path: pathname, status: context.res.status, duration_ms: elapsed(start) });
      return;
    }
    const client = clientId(context.req.raw);
    if (method === "OPTIONS") {
      emit("debug", "request", { method, path: pathname, client_id: client, status: 204, duration_ms: elapsed(start) });
      return new Response(null, { status: 204 });
    }
    try {
      await next();
      emit("info", "request", { method, path: pathname, client_id: client, status: context.res.status, duration_ms: elapsed(start) });
    } catch (error) {
      emit("error", "request_error", { method, path: pathname, client_id: client, message: (error as Error).message, duration_ms: elapsed(start) });
      throw error;
    }
  });

  mountAdmin(app, config, state);
  app.get("/", () => json({ name: "RuneShop", upstream: "codex", endpoints: ["/v1/models", "/v1/responses"] }));
  app.get("/health", () => json({ ok: true, name: "RuneShop" }));
  app.get("/models", (context) => models(config, wantsClientModels(context.req.raw)));
  app.get("/v1/models", (context) => models(config, wantsClientModels(context.req.raw)));
  app.post("/v1/responses", (context) => responses(context.req.raw, config, state, clientId(context.req.raw)));
  app.post("/v1/responses/compact", (context) => compact(context.req.raw, config, state, clientId(context.req.raw)));
}

config.configured ? mountRelay(config) : mountBootstrap(app, config);
app.notFound(() => problem(404, "not found", "not_found"));
app.onError((error) => error instanceof HTTPException ? error.getResponse() : problem(500, error.message, "internal_error"));

Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: config.idleTimeout,
  fetch: app.fetch
});

emit("info", "server_start", { host: config.host, port: config.port, configured: config.configured, managed: config.managed, idle_timeout_seconds: config.idleTimeout });
