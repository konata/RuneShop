import type { Config } from "../src/state";

export function configuration(overrides: Partial<Config> = {}): Config {
  return {
    configured: true,
    managed: false,
    configFile: "",
    port: 3721,
    adminPasswordHash: "",
    authFile: "",
    accessFile: "",
    stateDir: "",
    ...overrides
  };
}
