import type { Config } from "../src/config";

export function configuration(overrides: Partial<Config> = {}): Config {
  return {
    configured: true,
    managed: false,
    configFile: "",
    host: "127.0.0.1",
    port: 3721,
    adminPasswordHash: "",
    idleTimeout: 240,
    authFile: "",
    authDir: "",
    stateDir: "",
    upstream: "https://chatgpt.com/backend-api/codex",
    account: "https://chatgpt.com/backend-api",
    models: ["gpt-5.5"],
    userAgent: "codex_cli_rs",
    originator: "codex_cli_rs",
    client: "oauth-client",
    token: "https://auth.openai.com/oauth/token",
    updateRef: "origin/main",
    log: "silent",
    refreshSkewMs: 300_000,
    ...overrides
  };
}
