export type RequestBody = {
  body: string;
  stream: boolean;
  model?: string;
  native: boolean;
  changes: string[];
};

type Payload = Record<string, unknown>;

const codex = {
  pass: new Set([
    "input",
    "instructions",
    "metadata",
    "model",
    "prompt_cache_key",
    "reasoning",
    "service_tier",
    "stream",
    "text",
    "tool_choice",
    "tools"
  ]),
  force: {
    store: false,
    include: ["reasoning.encrypted_content"],
    parallel_tool_calls: true
  },
  alias: new Map([
    ["web_search_preview", "web_search"],
    ["web_search_preview_2025_03_11", "web_search"]
  ])
};

const forced = new Set(Object.keys(codex.force));

export function native(headers: Headers) {
  if (headers.has("originator")) return true;
  return [...headers.keys()].some((header) => header.startsWith("x-codex-"));
}

function record(value: unknown): Payload | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : null;
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function input(value: unknown, changes: string[]) {
  if (typeof value === "string") {
    changes.push("rewrite:input");
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: value }] }];
  }

  if (!Array.isArray(value)) return value;
  let changed = false;
  const normalized = value.map((message) => {
    const source = record(message);
    if (!source || source.role !== "system") return message;
    changed = true;
    return { ...source, role: "developer" };
  });
  if (changed) changes.push("rewrite:input.role");
  return normalized;
}

function reasoning(value: unknown, changes: string[]) {
  const source = record(value);
  if (!source) return value;
  const effort = typeof source.effort === "string" ? source.effort : "";
  for (const field of Object.keys(source)) if (field !== "effort") changes.push(`drop:reasoning.${field}`);
  return effort ? { effort } : undefined;
}

function tool(value: unknown, path: string, changes: string[]) {
  const source = record(value);
  const type = typeof source?.type === "string" ? codex.alias.get(source.type) : "";
  if (!source || !type) return value;
  changes.push(`rewrite:${path}.type`);
  return { ...source, type };
}

function tools(value: unknown, changes: string[]) {
  return Array.isArray(value) ? value.map((entry, index) => tool(entry, `tools.${index}`, changes)) : value;
}

function choice(value: unknown, changes: string[]) {
  const source = record(tool(value, "tool_choice", changes));
  if (!source) return value;
  if (!Array.isArray(source.tools)) return source;
  return { ...source, tools: source.tools.map((entry, index) => tool(entry, `tool_choice.tools.${index}`, changes)) };
}

function tier(value: unknown, changes: string[]) {
  if (value === "priority") return value;
  changes.push("drop:service_tier");
}

const rewrites: Record<string, (value: unknown, changes: string[]) => unknown> = {
  input,
  reasoning,
  service_tier: tier,
  tool_choice: choice,
  tools
};

function rewrite(field: string, value: unknown, changes: string[]) {
  const normalize = rewrites[field];
  return normalize ? normalize(value, changes) : value;
}

function defaults(source: Payload, target: Payload, changes: string[]) {
  for (const [field, value] of Object.entries(codex.force)) {
    if (!same(source[field], value)) changes.push(`${source[field] === undefined ? "set" : "rewrite"}:${field}`);
    target[field] = value;
  }
}

function project(payload: Payload) {
  const changes: string[] = [];
  const next: Payload = {};

  for (const [field, value] of Object.entries(payload)) {
    if (forced.has(field)) continue;
    if (!codex.pass.has(field)) {
      changes.push(`drop:${field}`);
      continue;
    }

    const normalized = rewrite(field, value, changes);
    if (normalized !== undefined) next[field] = normalized;
  }

  defaults(payload, next, changes);
  return { payload: next, changes };
}

export function normalize(body: string, headers = new Headers()): RequestBody {
  const payload = JSON.parse(body) as Payload;
  const stream = payload.stream === true;
  const model = typeof payload.model === "string" ? payload.model : undefined;
  if (native(headers)) return { body, stream, model, native: true, changes: [] };
  const { payload: next, changes } = project(payload);
  return { body: changes.length ? JSON.stringify(next) : body, stream, model, native: false, changes };
}
