import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { persist } from "./state";

export type Tenant = { alias: string; key: string; enabled: boolean };
type Settings = { version: 1; required: boolean; tenants: Tenant[] };

export class AccessError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function settings(path: string): Settings {
  if (!existsSync(path)) return { version: 1, required: false, tenants: [] };
  let value: Partial<Settings>;
  try { value = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>; }
  catch (error) { throw new Error(`cannot read ${path}: ${(error as Error).message}`); }
  if (value.version !== 1 || typeof value.required !== "boolean" || !Array.isArray(value.tenants))
    throw new Error(`invalid RuneShop access configuration: ${path}`);
  const aliases = new Set<string>();
  for (const tenant of value.tenants) {
    if (!tenant || typeof tenant.alias !== "string" || typeof tenant.key !== "string" || typeof tenant.enabled !== "boolean"
      || !tenant.alias.trim() || !tenant.key || aliases.has(tenant.alias.toLowerCase()))
      throw new Error(`invalid RuneShop access configuration: ${path}`);
    aliases.add(tenant.alias.toLowerCase());
  }
  return value as Settings;
}

function equal(left: string, right: string) {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

export function apiKey(request: Request) {
  return (request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || request.headers.get("x-api-key") || "").trim();
}

export class AccessControl {
  private value: Settings;
  private queue = Promise.resolve();

  constructor(private readonly path: string) { this.value = settings(path); }

  get required() { return this.value.required; }
  snapshot() { return { required: this.value.required, tenants: this.value.tenants.map((tenant) => ({ ...tenant })) }; }
  tenant(key: string) { return key ? this.value.tenants.find((tenant) => equal(tenant.key, key)) : undefined; }

  private commit(change: (current: Settings) => Settings) {
    const pending = this.queue.then(async () => {
      const next = change(this.value);
      await persist(this.path, next);
      this.value = next;
      return this.snapshot();
    });
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  require(required: boolean) {
    return this.commit((current) => ({ ...current, required }));
  }

  create(alias: string) {
    const name = alias.trim();
    if (!name) throw new AccessError("alias is required");
    if (name.length > 80) throw new AccessError("alias must be 80 characters or fewer");
    return this.commit((current) => {
      if (current.tenants.some((tenant) => tenant.alias.toLowerCase() === name.toLowerCase()))
        throw new AccessError("alias already exists", 409);
      const tenant = { alias: name, key: `rsk_${randomBytes(24).toString("base64url")}`, enabled: true };
      return { ...current, tenants: [...current.tenants, tenant] };
    });
  }

  enable(alias: string, enabled: boolean) {
    return this.commit((current) => {
      if (!current.tenants.some((tenant) => tenant.alias === alias)) throw new AccessError("tenant not found", 404);
      return { ...current, tenants: current.tenants.map((tenant) => tenant.alias === alias ? { ...tenant, enabled } : tenant) };
    });
  }
}
