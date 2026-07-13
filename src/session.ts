import { randomBytes } from "node:crypto";

export type AdminSession = {
  csrf: string;
  expires: number;
};

export class AdminSessions {
  readonly duration = 12 * 60 * 60;
  private readonly sessions = new Map<string, AdminSession>();

  constructor(private readonly passwordHash: string) {}

  get enabled() {
    return Boolean(this.passwordHash);
  }

  async login(password: string) {
    if (!this.enabled || !await Bun.password.verify(password, this.passwordHash)) return null;
    this.prune();
    const token = randomBytes(32).toString("base64url");
    const session = { csrf: randomBytes(24).toString("base64url"), expires: Date.now() + this.duration * 1000 };
    this.sessions.set(token, session);
    return { token, session };
  }

  find(token?: string) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session || session.expires <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  logout(token?: string) {
    if (token) this.sessions.delete(token);
  }

  private prune() {
    const now = Date.now();
    for (const [token, session] of this.sessions) if (session.expires <= now) this.sessions.delete(token);
  }
}
