import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { models, responseHeaders, responses, upstreamHeaders } from "../src/codex";
import { client } from "../src/server";
import { configure, RequestState } from "../src/state";
import { configuration } from "./config";

configure("silent");

const config = configuration();

test("returns OpenAI model list by default", async () => {
  const payload = await models().json();
  expect(payload.data[0].id).toBe("gpt-5.6-sol");
});

test("returns Codex client model metadata when requested", async () => {
  const payload = await models(true).json();
  expect(payload.models[0].slug).toBe("gpt-5.6-sol");
  expect(payload.models[0].supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toContain("xhigh");
});

test("preserves native Codex context with managed credentials", () => {
  const request = new Request("http://localhost/v1/responses", {
    headers: {
      authorization: "Bearer client-key",
      "chatgpt-account-id": "client-account",
      connection: "keep-alive",
      cookie: "session=client",
      "future-codex-context": "future",
      "session-id": "session",
      "thread-id": "thread",
      "user-agent": "codex-native/1.0",
      "x-api-key": "client-key",
      "x-codex-parent-thread-id": "parent",
      "x-codex-window-id": "window",
      "x-openai-api-key": "client-openai-key",
      "x-openai-subagent": "review",
      "x-responsesapi-include-timing-metrics": "true"
    }
  });

  const headers = upstreamHeaders(request, { access: "access", account: "account" }, true, true);
  expect(headers.get("user-agent")).toBe("codex-native/1.0");
  expect(headers.get("chatgpt-account-id")).toBe("account");
  expect(headers.get("authorization")).toBe("Bearer access");
  expect(headers.get("future-codex-context")).toBe("future");
  expect(headers.get("session-id")).toBe("session");
  expect(headers.get("thread-id")).toBe("thread");
  expect(headers.get("x-codex-parent-thread-id")).toBe("parent");
  expect(headers.get("x-openai-subagent")).toBe("review");
  expect(headers.get("x-responsesapi-include-timing-metrics")).toBe("true");
  expect(headers.has("connection")).toBe(false);
  expect(headers.has("cookie")).toBe(false);
  expect(headers.has("x-api-key")).toBe(false);
  expect(headers.has("x-openai-api-key")).toBe(false);
});

test("filters generic client headers", () => {
  const request = new Request("http://localhost/v1/responses", {
    headers: {
      "future-provider-context": "future",
      "session-id": "session",
      "user-agent": "generic-client/1.0",
      "x-openai-subagent": "generic"
    }
  });

  const headers = upstreamHeaders(request, { access: "access", account: "" }, true, false);
  expect(headers.get("session-id")).toBe("session");
  expect(headers.get("user-agent")).toBe("codex_cli_rs");
  expect(headers.has("future-provider-context")).toBe(false);
  expect(headers.has("x-openai-subagent")).toBe(false);
});

test("uses turn workspace only when the client key has no project path", () => {
  const metadata = JSON.stringify({ workspaces: { "/Users/natsuki/Lang/RuneShop": { has_changes: true } } });
  const request = (key: string, turn = metadata) => new Request("http://localhost/v1/responses", {
    headers: { authorization: `Bearer ${key}`, "x-codex-turn-metadata": turn }
  });

  expect(client(request("/Users/natsuki/Lang/RuneShop/src"))).toBe("/Users/natsuki/Lang/RuneShop/src");
  expect(client(request("/"))).toBe("/Users/natsuki/Lang/RuneShop");
  expect(client(request("/", "invalid"))).toBe("");
  expect(client(new Request("http://localhost/v1/responses", { headers: { authorization: "Bearer /" } }))).toBe("");
});

test("returns native Codex response metadata downstream", () => {
  const headers = responseHeaders(new Headers({
    connection: "keep-alive",
    "content-encoding": "gzip",
    "content-length": "100",
    "content-type": "text/event-stream",
    "future-codex-state": "future",
    "openai-model": "gpt-5.5",
    "retry-after": "3",
    "set-cookie": "private=upstream",
    "x-codex-primary-reset-at": "1800000000",
    "x-codex-turn-state": "sticky",
    "x-models-etag": "models-1",
    "x-openai-model": "gpt-5.5",
    "x-ratelimit-remaining-requests": "10",
    "x-request-id": "req-1"
  }), "text/event-stream; charset=utf-8", true);

  expect(headers.get("future-codex-state")).toBe("future");
  expect(headers.get("x-codex-turn-state")).toBe("sticky");
  expect(headers.get("x-codex-primary-reset-at")).toBe("1800000000");
  expect(headers.get("openai-model")).toBe("gpt-5.5");
  expect(headers.get("x-openai-model")).toBe("gpt-5.5");
  expect(headers.get("x-models-etag")).toBe("models-1");
  expect(headers.get("x-ratelimit-remaining-requests")).toBe("10");
  expect(headers.get("retry-after")).toBe("3");
  expect(headers.get("x-request-id")).toBe("req-1");
  expect(headers.has("connection")).toBe(false);
  expect(headers.has("content-encoding")).toBe(false);
  expect(headers.has("content-length")).toBe(false);
  expect(headers.has("set-cookie")).toBe(false);
});

test("adds streaming defaults without replacing upstream cache policy", () => {
  const stream = responseHeaders(new Headers(), "text/event-stream; charset=utf-8");
  expect(stream.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(stream.get("cache-control")).toBe("no-cache");

  const cached = responseHeaders(new Headers({ "cache-control": "private" }), "text/event-stream; charset=utf-8");
  expect(cached.get("cache-control")).toBe("private");

  const generic = responseHeaders(new Headers({ "future-provider-state": "future" }), "application/json");
  expect(generic.has("future-provider-state")).toBe(false);
});

test.serial("propagates downstream cancellation upstream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-"));
  const authFile = join(directory, "auth.json");
  await writeFile(authFile, JSON.stringify({
    access_token: "access",
    account_id: "account",
    expired: "2099-01-01T00:00:00Z"
  }));

  const original = globalThis.fetch;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_input, init) => {
    signal = init?.signal;
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const request = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "x-codex-window-id": "window" },
    body: JSON.stringify({
      model: "gpt-5.5", input: [], reasoning: { effort: "xhigh" }, service_tier: "priority", stream: true,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ workspaces: { "/Users/natsuki/Lang/RuneShop": { has_changes: true } } })
      }
    })
  });

  try {
    const state = new RequestState(directory);
    await responses(request, { ...config, authFile }, state);
    expect(signal).toBe(request.signal);
    const snapshot = await state.snapshot();
    expect(snapshot.today.requests).toBe(1);
    expect(snapshot.month.requests).toBe(1);
    expect(snapshot.activity[0].client).toBe("/Users/natsuki/Lang/RuneShop");
    expect(snapshot.activity[0].model).toBe("gpt-5.5");
    expect(snapshot.activity[0].effort).toBe("xhigh");
    expect(snapshot.activity[0].fast).toBe(true);
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});
