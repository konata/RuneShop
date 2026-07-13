import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { models, responseHeaders, responses, upstreamHeaders } from "../src/codex";
import { configure, RelayState } from "../src/state";
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

test("forwards native Codex user agent upstream", () => {
  const request = new Request("http://localhost/v1/responses", {
    headers: {
      authorization: "Bearer client-key",
      cookie: "session=client",
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
  expect(headers.get("x-codex-parent-thread-id")).toBe("parent");
  expect(headers.get("x-openai-subagent")).toBe("review");
  expect(headers.get("x-responsesapi-include-timing-metrics")).toBe("true");
  expect(headers.has("connection")).toBe(false);
  expect(headers.has("cookie")).toBe(false);
  expect(headers.has("x-api-key")).toBe(false);
  expect(headers.has("x-openai-api-key")).toBe(false);
});

test("uses configured user agent for generic clients", () => {
  const request = new Request("http://localhost/v1/responses", {
    headers: {
      "user-agent": "generic-client/1.0",
      "x-openai-subagent": "generic"
    }
  });

  const headers = upstreamHeaders(request, { access: "access", account: "" }, true, false);
  expect(headers.get("user-agent")).toBe("codex_cli_rs");
  expect(headers.has("x-openai-subagent")).toBe(false);
});

test("returns native Codex response metadata downstream", () => {
  const headers = responseHeaders(new Headers({
    "content-type": "text/event-stream",
    "openai-model": "gpt-5.5",
    "retry-after": "3",
    "set-cookie": "private=upstream",
    "x-codex-primary-reset-at": "1800000000",
    "x-codex-turn-state": "sticky",
    "x-models-etag": "models-1",
    "x-openai-model": "gpt-5.5",
    "x-ratelimit-remaining-requests": "10",
    "x-request-id": "req-1"
  }), "text/event-stream; charset=utf-8");

  expect(headers.get("x-codex-turn-state")).toBe("sticky");
  expect(headers.get("x-codex-primary-reset-at")).toBe("1800000000");
  expect(headers.get("openai-model")).toBe("gpt-5.5");
  expect(headers.get("x-openai-model")).toBe("gpt-5.5");
  expect(headers.get("x-models-etag")).toBe("models-1");
  expect(headers.get("x-ratelimit-remaining-requests")).toBe("10");
  expect(headers.get("retry-after")).toBe("3");
  expect(headers.get("x-request-id")).toBe("req-1");
  expect(headers.has("set-cookie")).toBe(false);
});

test("adds relay defaults without replacing upstream cache policy", () => {
  const stream = responseHeaders(new Headers(), "text/event-stream; charset=utf-8");
  expect(stream.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(stream.get("cache-control")).toBe("no-cache");

  const cached = responseHeaders(new Headers({ "cache-control": "private" }), "text/event-stream; charset=utf-8");
  expect(cached.get("cache-control")).toBe("private");
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
    body: JSON.stringify({ model: "gpt-5.5", input: [], stream: true })
  });

  try {
    const state = new RelayState(directory);
    await responses(request, { ...config, authFile }, state, "/Users/natsuki/Lang/RuneShop");
    expect(signal).toBe(request.signal);
    const snapshot = await state.snapshot();
    expect(snapshot.today.requests).toBe(1);
    expect(snapshot.month.requests).toBe(1);
    expect(snapshot.activity[0].client).toBe("/Users/natsuki/Lang/RuneShop");
    expect(snapshot.activity[0].model).toBe("gpt-5.5");
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});
