import type { Config } from "./config";
import { elapsed, emit } from "./log";
import { native as nativeRequest, normalize } from "./normalize";
import type { RelayState } from "./state";
import { fresh, type CodexToken } from "./token";

const requestMetadata = new Set([
  "version",
  "openai-beta",
  "x-client-request-id",
  "x-oai-attestation",
  "conversation_id",
  "session_id",
  "thread-id",
  "traceparent",
  "tracestate"
]);

const nativeMetadataPrefixes = ["x-codex-", "x-openai-", "x-responsesapi-"];
const credentialHeaders = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);
const credentialSuffixes = ["-authorization", "-api-key", "-access-token", "-refresh-token", "-session-token"];

const responseMetadata = new Set(["cache-control", "cf-ray", "content-type", "retry-after", "x-request-id"]);
const responseMetadataPrefixes = ["openai-", "x-codex-", "x-models-", "x-openai-", "x-ratelimit-", "x-reasoning-"];

const levels = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth" },
  { effort: "high", description: "Greater reasoning depth for complex work" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex work" }
];

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8" } });
}

function copy(headers: Headers, allowed: (name: string) => boolean) {
  const out = new Headers();
  for (const [name, value] of headers) if (allowed(name)) out.set(name, value);
  return out;
}

function requestHeader(name: string, native: boolean) {
  if (credentialHeaders.has(name) || credentialSuffixes.some((suffix) => name.endsWith(suffix))) return false;
  return requestMetadata.has(name) || (native && nativeMetadataPrefixes.some((prefix) => name.startsWith(prefix)));
}

function responseHeader(name: string) {
  return responseMetadata.has(name) || responseMetadataPrefixes.some((prefix) => name.startsWith(prefix));
}

function trace(request: Request) {
  return request.headers.get("x-client-request-id") || crypto.randomUUID();
}

export function upstreamHeaders(request: Request, config: Config, token: Pick<CodexToken, "access" | "account">, stream: boolean, native = false) {
  const headers = copy(request.headers, (name) => requestHeader(name, native));
  headers.set("authorization", `Bearer ${token.access}`);
  headers.set("content-type", "application/json");
  headers.set("accept", stream ? "text/event-stream" : "application/json");
  headers.set("user-agent", (native && request.headers.get("user-agent")) || config.userAgent);
  headers.set("originator", request.headers.get("originator") || config.originator);
  if (token.account) headers.set("chatgpt-account-id", token.account);
  return headers;
}

async function upstream(request: Request, config: Config, path: string, payload: string, stream: boolean, native = false) {
  const token = await fresh(config);
  return fetch(`${config.upstream}${path}`, {
    method: "POST",
    headers: upstreamHeaders(request, config, token, stream, native),
    body: payload,
    signal: request.signal
  });
}

function detail(text: string) {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error && typeof parsed.error === "object" ? (parsed.error as Record<string, unknown>) : {};
    return parsed.detail ?? error.message ?? parsed.message ?? text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

type RelayFields = { path: string; client?: string; model?: string; duration_ms: number };

function record(state: RelayState | undefined, fields: RelayFields, status: number, detail?: unknown) {
  void state?.record({
    time: new Date().toISOString(),
    path: fields.path,
    client: fields.client,
    model: fields.model,
    status,
    duration: fields.duration_ms,
    ...(detail ? { detail: String(detail).slice(0, 240) } : {})
  });
}

async function relayError(response: Response, fields: RelayFields & Record<string, unknown>, state?: RelayState) {
  const text = await response.text();
  const message = detail(text);
  emit("warn", "upstream_error", { ...fields, status: response.status, detail: message });
  record(state, fields, response.status, message);
  return new Response(text || JSON.stringify({ error: { message: response.statusText } }), {
    status: response.status,
    headers: responseHeaders(response.headers, "application/json; charset=utf-8")
  });
}

export async function responses(request: Request, config: Config, state?: RelayState, client?: string) {
  const start = performance.now();
  const id = trace(request);
  const { body, stream, model, native, changes } = normalize(await request.text(), request.headers);
  emit("debug", "upstream_request", { trace: id, path: "/responses", model, stream, native, changes });
  let response: Response;
  try {
    response = await upstream(request, config, "/responses", body, stream, native);
  } catch (error) {
    record(state, { path: "/responses", client, model, duration_ms: elapsed(start) }, 0, (error as Error).message);
    throw error;
  }
  const fields = { trace: id, path: "/responses", client, model, stream, duration_ms: elapsed(start) };
  if (!response.ok) return relayError(response, fields, state);
  emit("info", "upstream_response", { ...fields, status: response.status });
  record(state, fields, response.status);
  return relay(response, stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
}

export async function compact(request: Request, config: Config, state?: RelayState, client?: string) {
  const start = performance.now();
  const id = trace(request);
  const payload = await request.text();
  const native = nativeRequest(request.headers);
  emit("debug", "upstream_request", { trace: id, path: "/responses/compact", native });
  let response: Response;
  try {
    response = await upstream(request, config, "/responses/compact", payload, false, native);
  } catch (error) {
    record(state, { path: "/responses/compact", client, duration_ms: elapsed(start) }, 0, (error as Error).message);
    throw error;
  }
  const fields = { trace: id, path: "/responses/compact", client, stream: false, duration_ms: elapsed(start) };
  if (!response.ok) return relayError(response, fields, state);
  emit("info", "upstream_response", { ...fields, status: response.status });
  record(state, fields, response.status);
  return relay(response, "application/json; charset=utf-8");
}

function relay(response: Response, fallback: string) {
  return new Response(response.body, { status: response.status, headers: responseHeaders(response.headers, fallback) });
}

export function responseHeaders(source: Headers, fallback: string) {
  const headers = copy(source, responseHeader);
  if (!headers.has("content-type")) headers.set("content-type", fallback);
  if (fallback.startsWith("text/event-stream") && !headers.has("cache-control")) headers.set("cache-control", "no-cache");
  return headers;
}

function display(id: string) {
  return id
    .split("-")
    .map((word) => (word === "gpt" ? "GPT" : word[0]?.toUpperCase() + word.slice(1)))
    .join(" ");
}

function clientModel(id: string) {
  return {
    slug: id,
    display_name: display(id),
    description: display(id),
    context_window: 272000,
    max_context_window: 272000,
    input_modalities: ["text", "image"],
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: true,
    support_verbosity: true,
    default_verbosity: "low",
    default_reasoning_level: "medium",
    supported_reasoning_levels: levels,
    prefer_websockets: false,
    visibility: "list",
    supported_in_api: true
  };
}

export function models(config: Config, client = false) {
  if (client) return json({ models: config.models.map(clientModel) });
  return json({
    object: "list",
    data: config.models.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "codex"
    }))
  });
}
