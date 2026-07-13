import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountClient, normalizeAccount } from "../src/account";
import { configuration } from "./config";

test("normalizes account usage without exposing identity", () => {
  const account = normalizeAccount(
    {
      user_id: "user",
      account_id: "account",
      email: "private@example.com",
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 5, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 12, limit_window_seconds: 604_800, reset_at: 1_800_100_000 }
      },
      rate_limit_reset_credits: { available_count: 1 }
    },
    { stats: { lifetime_tokens: 123_456, total_threads: 42 } }
  );

  expect(account.plan).toBe("pro");
  expect(account.primary?.used_percent).toBe(5);
  expect(account.secondary?.window_seconds).toBe(604_800);
  expect(account.reset_credits).toBe(1);
  expect(account.lifetime_tokens).toBe(123_456);
  expect(account.total_threads).toBe(42);
  expect(JSON.stringify(account)).not.toContain("private@example.com");
  expect(JSON.stringify(account)).not.toContain('"account_id"');
});

test.serial("uses only upstream account credentials for status requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-account-"));
  const authFile = join(directory, "auth.json");
  await writeFile(authFile, JSON.stringify({ access_token: "upstream", account_id: "account", expired: "2099-01-01T00:00:00Z" }));
  const config = configuration({
    authFile,
    authDir: directory,
    stateDir: directory,
  });
  const original = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers; signal?: AbortSignal | null }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), signal: init?.signal });
    if (url.endsWith("/usage")) {
      return Response.json({ plan_type: "pro", rate_limit: {}, rate_limit_reset_credits: { available_count: 1 } });
    }
    if (url.endsWith("/profiles/me")) return Response.json({ stats: {} });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const account = new AccountClient(config);
    await account.get(true);
    await account.get();
    expect((await stat(join(directory, "account.json"))).mode & 0o777).toBe(0o600);
    expect(calls.map((call) => call.url)).toEqual([
      "https://chatgpt.com/backend-api/wham/usage",
      "https://chatgpt.com/backend-api/wham/profiles/me"
    ]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer upstream");
      expect(call.headers.get("chatgpt-account-id")).toBe("account");
      expect(call.headers.get("user-agent")).toBe("codex_cli_rs");
      expect(call.headers.has("x-api-key")).toBe(false);
      expect(call.headers.has("originator")).toBe(false);
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});
