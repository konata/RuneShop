import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialStatus, importCredential, parse } from "../src/token";
import { configuration } from "./config";

function config(directory: string, authFile = join(directory, "auth.json")) {
  return configuration({
    authFile,
    authDir: directory,
    stateDir: directory,
  });
}

test("parses RuneShop codex token files", () => {
  const token = parse({
    type: "codex",
    access_token: "access",
    refresh_token: "refresh",
    account_id: "account",
    email: "user@example.com",
    expired: "2099-01-01T00:00:00Z"
  });

  expect(token?.access).toBe("access");
  expect(token?.refresh).toBe("refresh");
  expect(token?.account).toBe("account");
  expect(token?.email).toBe("user@example.com");
});

test("parses Codex auth cache token files", () => {
  const payload = Buffer.from(JSON.stringify({ email: "user@example.com" })).toString("base64url");
  const token = parse({
    auth_mode: "chatgpt",
    tokens: {
      id_token: `header.${payload}.signature`,
      access_token: "access",
      refresh_token: "refresh",
      account_id: "account"
    },
    last_refresh: new Date().toISOString()
  });

  expect(token?.access).toBe("access");
  expect(token?.refresh).toBe("refresh");
  expect(token?.account).toBe("account");
  expect(token?.email).toBe("user@example.com");
  expect(token?.expires).toBeInstanceOf(Date);
});

test.serial("validates and atomically imports a managed Codex credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-credential-"));
  const authFile = join(directory, "auth.json");
  await writeFile(authFile, JSON.stringify({ access_token: "old" }), { mode: 0o600 });
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ plan_type: "pro" });
  }) as typeof fetch;

  try {
    const imported = await importCredential(config(directory), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        account_id: "account",
        expired: "2099-01-01T00:00:00Z",
        email: "private@example.com"
      },
      unrelated: "discarded"
    }));
    const stored = await readFile(authFile, "utf8");
    expect(imported.configured).toBe(true);
    expect(imported.refreshable).toBe(true);
    expect(JSON.parse(stored)).toEqual({
      type: "codex",
      access_token: "new-access",
      refresh_token: "new-refresh",
      account_id: "account",
      expired: "2099-01-01T00:00:00.000Z",
      last_refresh: expect.any(String)
    });
    expect(stored).not.toContain("private@example.com");
    expect(await readFile(`${authFile}.backup`, "utf8")).toContain('"old"');
    expect((await stat(authFile)).mode & 0o777).toBe(0o600);
    expect((await credentialStatus(config(directory))).configured).toBe(true);
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test.serial("retries transient credential validation once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-credential-"));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input, _init) => {
    calls++;
    return calls === 1 ? new Response("unavailable", { status: 503 }) : Response.json({ plan_type: "pro" });
  }) as typeof fetch;

  try {
    const imported = await importCredential(config(directory), JSON.stringify({
      access_token: "access",
      refresh_token: "refresh",
      account_id: "account",
      expired: "2099-01-01T00:00:00Z"
    }));
    expect(imported.configured).toBe(true);
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to import credentials outside the managed auth directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-credential-"));
  try {
    await expect(importCredential(config(directory, join(tmpdir(), "external-auth.json")), "{}"))
      .rejects.toThrow("managed auth path");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.serial("reports credentials without an OAuth client as not refreshable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-credential-"));
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input, _init) => Response.json({ plan_type: "pro" })) as typeof fetch;

  try {
    const imported = await importCredential(
      { ...config(directory), client: "" },
      JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        account_id: "account",
        expired: "2099-01-01T00:00:00Z"
      })
    );
    expect(imported.refreshable).toBe(false);
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});
