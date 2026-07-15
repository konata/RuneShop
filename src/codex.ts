import { authorization, fresh, upstream, type CodexToken } from "./account";
import { elapsed, emit, type Config, type RequestState } from "./state";

type Payload = Record<string, unknown>;
const accepted = new Set([
  "input", "instructions", "metadata", "model", "prompt_cache_key", "reasoning",
  "service_tier", "stream", "text", "tool_choice", "tools"
]);
const forced: Payload = { store: false, include: ["reasoning.encrypted_content"], parallel_tool_calls: true };
const aliases = new Map([["web_search_preview", "web_search"], ["web_search_preview_2025_03_11", "web_search"]]);

function native(headers: Headers) {
  return headers.has("originator") || [...headers.keys()].some((header) => header.startsWith("x-codex-"));
}

function object(value: unknown): Payload | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Payload : null;
}

export function workspace(value: unknown) {
  try {
    const metadata = object(typeof value === "string" ? JSON.parse(value) : value);
    const workspaces = object(metadata?.workspaces);
    return workspaces ? Object.keys(workspaces)[0] || "" : "";
  } catch { return ""; }
}

function mode(payload: Payload): { effort?: string; fast?: boolean } {
  const effort = object(payload.reasoning)?.effort;
  return { ...(typeof effort === "string" ? { effort } : {}), ...(payload.service_tier === "priority" ? { fast: true } : {}) };
}

function tool(value: unknown, path: string, changes: string[]) {
  const source = object(value);
  const type = typeof source?.type === "string" ? aliases.get(source.type) : undefined;
  if (!source || !type) return value;
  changes.push(`rewrite:${path}.type`);
  return { ...source, type };
}

function rewrite(field: string, value: unknown, changes: string[]) {
  if (field === "input") {
    if (typeof value === "string") {
      changes.push("rewrite:input");
      return [{ type: "message", role: "user", content: [{ type: "input_text", text: value }] }];
    }
    if (!Array.isArray(value)) return value;
    let changed = false;
    const messages = value.map((message) => {
      const source = object(message);
      if (!source || source.role !== "system") return message;
      changed = true;
      return { ...source, role: "developer" };
    });
    if (changed) changes.push("rewrite:input.role");
    return messages;
  }
  if (field === "reasoning") {
    const source = object(value);
    if (!source) return value;
    for (const name of Object.keys(source)) if (name !== "effort") changes.push(`drop:reasoning.${name}`);
    return typeof source.effort === "string" ? { effort: source.effort } : undefined;
  }
  if (field === "service_tier") {
    if (value === "priority") return value;
    changes.push("drop:service_tier");
    return;
  }
  if (field === "tools") return Array.isArray(value) ? value.map((entry, index) => tool(entry, `tools.${index}`, changes)) : value;
  if (field === "tool_choice") {
    const choice = object(tool(value, "tool_choice", changes));
    if (!choice || !Array.isArray(choice.tools)) return choice ?? value;
    return { ...choice, tools: choice.tools.map((entry, index) => tool(entry, `tool_choice.tools.${index}`, changes)) };
  }
  return value;
}

export function normalize(body: string, headers = new Headers()) {
  const payload = JSON.parse(body) as Payload;
  const stream = payload.stream === true;
  const model = typeof payload.model === "string" ? payload.model : undefined;
  const project = workspace(object(payload.client_metadata)?.["x-codex-turn-metadata"]);
  if (native(headers)) return { body, stream, model, ...(project ? { workspace: project } : {}), ...mode(payload), native: true, changes: [] };
  const changes: string[] = [];
  const normalized: Payload = {};
  for (const [field, value] of Object.entries(payload)) {
    if (Object.hasOwn(forced, field)) continue;
    if (!accepted.has(field)) { changes.push(`drop:${field}`); continue; }
    const result = rewrite(field, value, changes);
    if (result !== undefined) normalized[field] = result;
  }
  for (const [field, value] of Object.entries(forced)) {
    if (JSON.stringify(payload[field]) !== JSON.stringify(value)) changes.push(`${payload[field] === undefined ? "set" : "rewrite"}:${field}`);
    normalized[field] = value;
  }
  return {
    body: changes.length ? JSON.stringify(normalized) : body, stream, model,
    ...(project ? { workspace: project } : {}), ...mode(normalized), native: false, changes
  };
}

type RequestBody = ReturnType<typeof normalize>;
const requestNames = new Set([
  "version", "openai-beta", "x-client-request-id", "x-oai-attestation", "conversation_id",
  "session-id", "thread-id", "traceparent", "tracestate"
]);
const secretNames = new Set(["authorization", "chatgpt-account-id", "cookie", "set-cookie", "set-cookie2", "x-api-key"]);
const secretSuffixes = ["-authorization", "-api-key", "-access-token", "-refresh-token", "-session-token"];
const transportNames = new Set([
  "accept-encoding", "connection", "content-encoding", "content-length", "expect", "host", "keep-alive",
  "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"
]);
const responseNames = new Set(["cache-control", "cf-ray", "content-type", "retry-after", "x-request-id"]);
const responsePrefixes = ["openai-", "x-codex-", "x-models-", "x-openai-", "x-ratelimit-", "x-reasoning-"];
const levels = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth" },
  { effort: "high", description: "Greater reasoning depth for complex work" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex work" }
];

function relayable(name: string) {
  return !transportNames.has(name) && !secretNames.has(name) && !secretSuffixes.some((suffix) => name.endsWith(suffix));
}

function requestHeader(name: string, codex: boolean) {
  return relayable(name) && (codex || requestNames.has(name));
}

function responseHeader(name: string, codex: boolean) {
  return relayable(name) && (codex || responseNames.has(name) || responsePrefixes.some((prefix) => name.startsWith(prefix)));
}

export function upstreamHeaders(request: Request, token: Pick<CodexToken, "access" | "account">, stream: boolean, codex = false) {
  const headers = new Headers();
  for (const [name, value] of request.headers) if (requestHeader(name, codex)) headers.set(name, value);
  for (const [name, value] of authorization(token)) headers.set(name, value);
  headers.set("content-type", "application/json");
  headers.set("accept", stream ? "text/event-stream" : "application/json");
  headers.set("user-agent", codex && request.headers.get("user-agent") || upstream.agent);
  headers.set("originator", request.headers.get("originator") || upstream.agent);
  return headers;
}

export function responseHeaders(source: Headers, fallback: string, codex = false) {
  const headers = new Headers();
  for (const [name, value] of source) if (responseHeader(name, codex)) headers.set(name, value);
  if (!headers.has("content-type")) headers.set("content-type", fallback);
  if (fallback.startsWith("text/event-stream") && !headers.has("cache-control")) headers.set("cache-control", "no-cache");
  return headers;
}

const htmlSelectors = [
  ["[role=\"alert\"]", "[id*=\"error\" i]", "[class*=\"error\" i]", "[id*=\"message\" i]", "[class*=\"message\" i]", "[id*=\"detail\" i]", "[class*=\"detail\" i]"],
  ["h1", "h2", "h3", "title"],
  ["main p"],
  ["p"],
  ["body"]
];
const entities: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"" };

function decode(text: string) {
  return text.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|apos|gt|lt|nbsp|quot));/gi, (entity, decimal, hexadecimal, name) => {
    const point = decimal ? Number(decimal) : hexadecimal ? Number.parseInt(hexadecimal, 16) : NaN;
    return name ? entities[name.toLowerCase()] : point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

function fragments(html: string, selector: string) {
  const matches: string[][] = [];
  let match: string[] | undefined;
  new HTMLRewriter().on(selector, {
    element() { match = []; matches.push(match); },
    text(chunk) { match?.push(chunk.text); }
  }).transform(html);
  return matches.map((parts) => parts.join(""));
}

function readable(text: string) {
  return decode(text.replace(/<!--[\s\S]*?-->|<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function htmlDetail(html: string) {
  const clean = new HTMLRewriter().on("style, script, svg, template", { element(element) { element.remove(); } }).transform(html);
  const noscript = fragments(clean, "noscript");
  const sources = [clean, ...noscript];
  const best = (values: string[]) => [...new Set(values.map(readable).filter(Boolean))].sort((left, right) => right.length - left.length)[0];
  for (const selectors of htmlSelectors.slice(0, 3)) {
    const message = best(sources.flatMap((source) => selectors.flatMap((selector) => fragments(source, selector))));
    if (message) return message;
  }
  const message = best(noscript);
  if (message) return message;
  for (const selectors of htmlSelectors.slice(3)) {
    const fallback = best(sources.flatMap((source) => selectors.flatMap((selector) => fragments(source, selector))));
    if (fallback) return fallback;
  }
  return "";
}

function detail(text: string, status: number, contentType: string) {
  try {
    const payload = JSON.parse(text) as Payload;
    const error = object(payload.error) ?? {};
    return payload.detail ?? error.message ?? payload.message ?? text.slice(0, 500);
  } catch {}
  const html = contentType.toLowerCase().includes("html") || /^\s*(?:<!doctype html\b|<(?:html|head|body|title|h[1-3])\b)/i.test(text);
  if (!html) return text.slice(0, 500);
  const message = htmlDetail(text);
  return `HTTP ${status}${message ? `: ${message}` : ""}`.slice(0, 500);
}

type Fields = { path: string; client?: string; model?: string; effort?: string; fast?: boolean; duration_ms: number };
function track(state: RequestState | undefined, fields: Fields, status: number, message?: unknown) {
  void state?.record({
    time: new Date().toISOString(), path: fields.path, client: fields.client, model: fields.model, effort: fields.effort,
    ...(fields.fast ? { fast: true } : {}),
    status, duration: fields.duration_ms, ...(message ? { detail: String(message).slice(0, 240) } : {})
  });
}

async function forward(request: Request, config: Config, state: RequestState | undefined, client: string | undefined, path: string, payload: RequestBody) {
  const start = performance.now();
  const trace = request.headers.get("x-client-request-id") || crypto.randomUUID();
  emit("debug", "upstream_request", { trace, path, model: payload.model, stream: payload.stream, native: payload.native, changes: payload.changes });
  let response: Response;
  try {
    const token = await fresh(config.authFile);
    response = await fetch(`${upstream.codex}${path}`, {
      method: "POST", headers: upstreamHeaders(request, token, payload.stream, payload.native), body: payload.body, signal: request.signal
    });
  } catch (error) {
    track(state, { path, client, model: payload.model, effort: payload.effort, fast: payload.fast, duration_ms: elapsed(start) }, 0, (error as Error).message);
    throw error;
  }
  const fields = { trace, path, client, model: payload.model, effort: payload.effort, fast: payload.fast, stream: payload.stream, duration_ms: elapsed(start) };
  if (!response.ok) {
    const text = await response.text();
    const message = String(detail(text, response.status, response.headers.get("content-type") || "") || response.statusText || `HTTP ${response.status}`);
    emit("warn", "upstream_error", { ...fields, status: response.status, detail: message });
    track(state, fields, response.status, message);
    return new Response(text || JSON.stringify({ error: { message } }), {
      status: response.status, headers: responseHeaders(response.headers, "application/json; charset=utf-8", payload.native)
    });
  }
  emit("info", "upstream_response", { ...fields, status: response.status });
  track(state, fields, response.status);
  const fallback = payload.stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8";
  return new Response(response.body, { status: response.status, headers: responseHeaders(response.headers, fallback, payload.native) });
}

export async function responses(request: Request, config: Config, state?: RequestState, client?: string) {
  const payload = normalize(await request.text(), request.headers);
  return forward(request, config, state, client || payload.workspace, "/responses", payload);
}

export async function compact(request: Request, config: Config, state?: RequestState, client?: string) {
  return forward(request, config, state, client, "/responses/compact", {
    body: await request.text(), stream: false, model: undefined, native: native(request.headers), changes: []
  });
}

function display(id: string) {
  return id.split("-").map((word) => word === "gpt" ? "GPT" : word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

function clientModel(id: string) {
  return {
    slug: id, display_name: display(id), description: display(id), context_window: 272000, max_context_window: 272000,
    input_modalities: ["text", "image"], supports_parallel_tool_calls: true, supports_reasoning_summaries: true,
    support_verbosity: true, default_verbosity: "low", default_reasoning_level: "medium", supported_reasoning_levels: levels,
    prefer_websockets: false, visibility: "list", supported_in_api: true
  };
}

export function models(client = false) {
  const body = client
    ? { models: upstream.models.map(clientModel) }
    : { object: "list", data: upstream.models.map((id) => ({ id, object: "model", created: 0, owned_by: "codex" })) };
  return Response.json(body, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
