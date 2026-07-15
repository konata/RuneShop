import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { AccessControl, apiKey } from "./access";
import { mountAdmin, mountBootstrap } from "./admin";
import { compact, models, normalize, responses, workspace } from "./codex";
import { configure, elapsed, emit, load, RequestState, type Config } from "./state";

const host = "0.0.0.0";
const idleTimeout = 240;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function problem(status: number, message: string, code = "request_error") {
  return json({ error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", code } }, status);
}

export function client(request: Request) {
  const key = apiKey(request);
  if (key && key !== "/") return key;
  return workspace(request.headers.get("x-codex-turn-metadata"));
}

function caller(request: Request, access: AccessControl) {
  const key = apiKey(request);
  if (!access.required) return key.startsWith("rsk_") ? workspace(request.headers.get("x-codex-turn-metadata")) : client(request);
  const tenant = access.tenant(key);
  if (tenant) return tenant.alias;
  if (key.startsWith("/") && key !== "/") return key;
  return workspace(request.headers.get("x-codex-turn-metadata"));
}

function finish(app: Hono) {
  app.notFound(() => problem(404, "not found", "not_found"));
  app.onError((error) => error instanceof HTTPException ? error.getResponse() : problem(500, error.message, "internal_error"));
  return app;
}

function configured(config: Config) {
  const app = new Hono();
  const state = new RequestState(config.stateDir);
  const access = new AccessControl(config.accessFile);
  const protectedPaths = new Set(["/models", "/v1/models", "/v1/responses", "/v1/responses/compact"]);
  const denied = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/v1/responses")) {
      const payload = await request.clone().text().then((body) => normalize(body, request.headers)).catch(() => undefined);
      await state.record({
        time: new Date().toISOString(), path: path.slice(3), client: caller(request, access) || payload?.workspace,
        model: payload?.model, effort: payload?.effort, ...(payload?.fast ? { fast: true } : {}),
        status: 401, duration: 0, detail: "API key is missing, unknown, or disabled"
      });
    }
    return problem(401, "API key is missing, unknown, or disabled", "invalid_api_key");
  };
  app.use("*", async (context, next) => {
    const start = performance.now();
    const { method, path } = context.req;
    const client_id = caller(context.req.raw, access);
    if (method === "OPTIONS") return new Response(null, { status: 204 });
    try {
      await next();
      const level = path === "/admin" || path.startsWith("/admin/") ? "debug" : "info";
      emit(level, "request", { method, path, client_id, status: context.res.status, duration_ms: elapsed(start) });
    } catch (cause) {
      emit("error", "request_error", { method, path, client_id, message: (cause as Error).message, duration_ms: elapsed(start) });
      throw cause;
    }
  });

  app.use("*", async (context, next) => {
    if (!access.required || !protectedPaths.has(context.req.path) || access.tenant(apiKey(context.req.raw))?.enabled) return next();
    return denied(context.req.raw);
  });

  mountAdmin(app, config, state, access);
  app.get("/", () => json({ name: "RuneShop", upstream: "codex", endpoints: ["/v1/models", "/v1/responses"] }));
  app.get("/health", () => json({ ok: true, name: "RuneShop" }));
  for (const path of ["/models", "/v1/models"]) app.get(path, (context) => models(new URL(context.req.url).searchParams.has("client_version")));
  app.post("/v1/responses", (context) => responses(context.req.raw, config, state, caller(context.req.raw, access)));
  app.post("/v1/responses/compact", (context) => compact(context.req.raw, config, state, caller(context.req.raw, access)));
  return finish(app);
}

export function application(config = load(), secret?: string) {
  let setup: Hono | undefined;
  let active: Hono;
  if (config.configured) active = configured(config);
  else {
    setup = new Hono();
    active = setup;
    mountBootstrap(setup, config, secret, () => (active = configured(load(config.stateDir, []))));
    finish(setup);
  }
  return {
    fetch: (request: Request) => {
      const path = new URL(request.url).pathname;
      const app = setup && (path === "/bootstrap" || path.startsWith("/bootstrap/")) ? setup : active;
      return app.fetch(request);
    }
  };
}

if (import.meta.main) {
  configure("info");
  const config = load();
  const app = application(config);
  Bun.serve({ hostname: host, port: config.port, idleTimeout, fetch: app.fetch });
  emit("info", "server_start", { host, port: config.port, configured: config.configured, managed: config.managed, idle_timeout_seconds: idleTimeout });
}
