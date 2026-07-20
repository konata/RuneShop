import { importCredential, upstream } from "./account";
import { emit } from "./state";

const issuer = "https://auth.openai.com";
const timeout = 10_000;

type Payload = Record<string, unknown>;
type Credential = Awaited<ReturnType<typeof importCredential>>;
export type DeviceStatus = {
  state: "idle" | "pending" | "complete" | "failed";
  verification_url?: string;
  user_code?: string;
  error?: string;
  account?: Credential["account"];
};

function field(...values: unknown[]) {
  const value = values.find((value) => typeof value === "string" && value.trim());
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    const aborted = () => { clearTimeout(timer); reject(new DOMException("The operation was aborted", "AbortError")); };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function post(path: string, body: Payload, signal: AbortSignal, form = false) {
  const response = await fetch(`${issuer}${path}`, {
    method: "POST",
    headers: form
      ? { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }
      : { "content-type": "application/json", accept: "application/json" },
    body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)])
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as Payload };
}

export class DeviceLogin {
  private pending?: { abort: AbortController; task: Promise<void> };
  private snapshot: DeviceStatus = { state: "idle" };

  constructor(
    private readonly authFile: string,
    private readonly imported?: () => unknown,
    private readonly lifetime = 15 * 60_000
  ) {}

  status() { return { ...this.snapshot }; }

  async start() {
    this.pending?.abort.abort();
    const response = await post("/api/accounts/deviceauth/usercode", { client_id: upstream.client }, new AbortController().signal);
    if (response.status === 404)
      throw new Error("device code sign-in is not enabled for this account; enable it in ChatGPT Codex security settings");
    if (response.status < 200 || response.status >= 300)
      throw new Error(`device code request failed (${response.status}): ${response.text.slice(0, 240)}`);
    const payload = response.json();
    const deviceAuthId = field(payload.device_auth_id);
    const userCode = field(payload.user_code, payload.usercode);
    if (!deviceAuthId || !userCode) throw new Error("device code response was not understood");
    const seconds = Math.max(0.05, Number(payload.interval) || 5);
    const abort = new AbortController();
    this.snapshot = { state: "pending", verification_url: `${issuer}/codex/device`, user_code: userCode };
    const task = this.complete(deviceAuthId, userCode, seconds, abort.signal);
    this.pending = { abort, task };
    void task.finally(() => { if (this.pending?.task === task) this.pending = undefined; });
    emit("info", "device_login_start");
    return { verification_url: this.snapshot.verification_url, user_code: userCode, expires_in: this.lifetime / 1000 };
  }

  cancel() {
    this.pending?.abort.abort();
    this.snapshot = { state: "idle" };
    emit("info", "device_login_cancelled");
    return this.status();
  }

  private async complete(deviceAuthId: string, userCode: string, seconds: number, signal: AbortSignal) {
    try {
      const code = await this.poll(deviceAuthId, userCode, seconds, signal);
      const source = await this.exchange(code, signal);
      const report = await importCredential(this.authFile, JSON.stringify(source));
      await this.imported?.();
      this.snapshot = { ...this.snapshot, state: "complete", account: report.account };
      emit("info", "device_login_complete", { refreshable: report.refreshable, expires_at: report.expires_at });
    } catch (cause) {
      if ((cause as Error).name === "AbortError") return;
      this.snapshot = { ...this.snapshot, state: "failed", error: (cause as Error).message };
      emit("warn", "device_login_failed", { message: (cause as Error).message });
    }
  }

  private async poll(deviceAuthId: string, userCode: string, seconds: number, signal: AbortSignal) {
    const deadline = Date.now() + this.lifetime;
    for (;;) {
      const poll = await post("/api/accounts/deviceauth/token", { device_auth_id: deviceAuthId, user_code: userCode }, signal);
      if (poll.status >= 200 && poll.status < 300) return poll.json();
      if (poll.status !== 403 && poll.status !== 404)
        throw new Error(`device code polling failed (${poll.status}): ${poll.text.slice(0, 240)}`);
      if (Date.now() >= deadline) throw new Error("device code expired before sign-in completed");
      await sleep(seconds * 1000, signal);
    }
  }

  private async exchange(code: Payload, signal: AbortSignal) {
    const authorizationCode = field(code.authorization_code);
    const codeVerifier = field(code.code_verifier);
    if (!authorizationCode || !codeVerifier) throw new Error("device code authorization response was not understood");
    const exchanged = await post("/oauth/token", {
      grant_type: "authorization_code", code: authorizationCode,
      redirect_uri: `${issuer}/deviceauth/callback`, client_id: upstream.client, code_verifier: codeVerifier
    }, signal, true);
    if (exchanged.status < 200 || exchanged.status >= 300)
      throw new Error(`device code exchange failed (${exchanged.status}): ${exchanged.text.slice(0, 240)}`);
    const tokens = exchanged.json();
    const source: Payload = {
      type: "codex",
      access_token: field(tokens.access_token),
      refresh_token: field(tokens.refresh_token),
      id_token: field(tokens.id_token)
    };
    if (typeof tokens.expires_in === "number") source.expired = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    return source;
  }
}
