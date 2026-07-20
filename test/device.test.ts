import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountBootstrap } from "../src/admin";
import { DeviceLogin } from "../src/device";
import { configure, load } from "../src/state";

configure("silent");

const jwt = (payload: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");

const idToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } });

type Exchange = { url: string; body: string };

function mockFlow(options: { polls?: number; tokenStatus?: number; usercodeStatus?: number; calls?: Exchange[] } = {}) {
  let polls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    options.calls?.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/deviceauth/usercode")) {
      const status = options.usercodeStatus ?? 200;
      return status === 200
        ? Response.json({ device_auth_id: "device-id", usercode: "ABCD-1234", interval: "0.05" })
        : new Response("disabled", { status });
    }
    if (url.endsWith("/deviceauth/token")) {
      polls++;
      const succeed = options.tokenStatus ?? 200;
      if (succeed !== 200) return new Response("pending", { status: succeed });
      return polls > (options.polls ?? 1)
        ? Response.json({ authorization_code: "code", code_challenge: "challenge", code_verifier: "verifier" })
        : new Response("pending", { status: 403 });
    }
    if (url.endsWith("/oauth/token")) {
      return Response.json({ id_token: idToken, access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    }
    if (url.endsWith("/wham/usage")) return Response.json({ plan_type: "pro" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return original;
}

async function waitFor(device: DeviceLogin, state: string) {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
    if (device.status().state === state) return device.status();
    await Bun.sleep(20);
  }
  throw new Error(`device sign-in did not reach ${state}: ${JSON.stringify(device.status())}`);
}

test.serial("completes a device code sign-in and imports the credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-device-"));
  const authFile = join(directory, "auth.json");
  const calls: Exchange[] = [];
  const original = mockFlow({ calls });
  const device = new DeviceLogin(authFile);
  try {
    const started = await device.start();
    expect(started.verification_url).toBe("https://auth.openai.com/codex/device");
    expect(started.user_code).toBe("ABCD-1234");
    expect(started.expires_in).toBe(900);
    expect(device.status()).toMatchObject({ state: "pending", user_code: "ABCD-1234" });

    const status = await waitFor(device, "complete");
    expect(status.account).toMatchObject({ account_id: "account" });
    const stored = JSON.parse(await readFile(authFile, "utf8"));
    expect(stored.access_token).toBe("access");
    expect(stored.refresh_token).toBe("refresh");
    expect(stored.account_id).toBe("account");
    expect((await stat(authFile)).mode & 0o777).toBe(0o600);

    expect(calls[0]).toMatchObject({ url: "https://auth.openai.com/api/accounts/deviceauth/usercode", body: JSON.stringify({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" }) });
    expect(calls[1]).toMatchObject({ url: "https://auth.openai.com/api/accounts/deviceauth/token" });
    expect(JSON.parse(calls[1].body)).toEqual({ device_auth_id: "device-id", user_code: "ABCD-1234" });
    const exchange = calls.find((call) => call.url === "https://auth.openai.com/oauth/token");
    const parameters = new URLSearchParams(exchange?.body);
    expect(parameters.get("grant_type")).toBe("authorization_code");
    expect(parameters.get("code")).toBe("code");
    expect(parameters.get("code_verifier")).toBe("verifier");
    expect(parameters.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
    expect(parameters.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  } finally {
    globalThis.fetch = original;
    device.cancel();
    await rm(directory, { recursive: true, force: true });
  }
});

test.serial("rejects a concurrent start and cancels a pending sign-in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-device-"));
  const original = mockFlow({ tokenStatus: 403 });
  const device = new DeviceLogin(join(directory, "auth.json"));
  try {
    await device.start();
    await expect(device.start()).rejects.toThrow("already in progress");
    expect(device.cancel().state).toBe("idle");
    await Bun.sleep(150);
    expect(device.status().state).toBe("idle");
    expect(await Bun.file(join(directory, "auth.json")).exists()).toBe(false);
  } finally {
    globalThis.fetch = original;
    device.cancel();
    await rm(directory, { recursive: true, force: true });
  }
});

test.serial("fails when polling returns an unexpected status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-device-"));
  const original = mockFlow({ tokenStatus: 500 });
  const device = new DeviceLogin(join(directory, "auth.json"));
  try {
    await device.start();
    const status = await waitFor(device, "failed");
    expect(status.error).toContain("500");
    expect(await Bun.file(join(directory, "auth.json")).exists()).toBe(false);
  } finally {
    globalThis.fetch = original;
    device.cancel();
    await rm(directory, { recursive: true, force: true });
  }
});

test.serial("expires when authorization never completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-device-"));
  const original = mockFlow({ tokenStatus: 403 });
  const device = new DeviceLogin(join(directory, "auth.json"), { maxWait: 60 });
  try {
    await device.start();
    const status = await waitFor(device, "failed");
    expect(status.error).toContain("expired");
  } finally {
    globalThis.fetch = original;
    device.cancel();
    await rm(directory, { recursive: true, force: true });
  }
});

test.serial("reports when device code sign-in is disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-device-"));
  const original = mockFlow({ usercodeStatus: 404 });
  const device = new DeviceLogin(join(directory, "auth.json"));
  try {
    await expect(device.start()).rejects.toThrow("not enabled");
    expect(device.status().state).toBe("idle");
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test.serial("completes bootstrap setup with a device code credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runeshop-device-setup-"));
  const config = { ...load(directory, []), managed: false };
  const app = new Hono();
  mountBootstrap(app, config, "bootstrap-secret");
  const original = mockFlow();
  try {
    const deniedStart = await app.request("http://localhost/bootstrap/api/device", {
      method: "POST", headers: { "x-runeshop-bootstrap": "wrong" }
    });
    expect(deniedStart.status).toBe(401);

    const started = await app.request("http://localhost/bootstrap/api/device", {
      method: "POST", headers: { "x-runeshop-bootstrap": "bootstrap-secret" }
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ verification_url: "https://auth.openai.com/codex/device", user_code: "ABCD-1234" });

    let status = "";
    for (const deadline = Date.now() + 5_000; Date.now() < deadline && status !== "complete";) {
      await Bun.sleep(20);
      const poll = await app.request("http://localhost/bootstrap/api/device", {
        headers: { "x-runeshop-bootstrap": "bootstrap-secret" }
      });
      status = (await poll.json()).state;
    }
    expect(status).toBe("complete");
    expect(await Bun.file(config.authFile).exists()).toBe(true);

    const form = new FormData();
    form.set("admin_password", "admin-secret");
    const setup = await app.request("http://localhost/bootstrap/api/setup", {
      method: "POST", headers: { "x-runeshop-bootstrap": "bootstrap-secret" }, body: form
    });
    expect(setup.status).toBe(200);
    expect(await Bun.file(config.configFile).exists()).toBe(true);
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});
