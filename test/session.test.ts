import { expect, test } from "bun:test";
import { AdminSessions } from "../src/admin";

test("signs month-long admin sessions that survive restarts", async () => {
  const password = await Bun.password.hash("admin-secret");
  const sessions = new AdminSessions(password);
  expect(sessions.duration).toBe(30 * 24 * 60 * 60);
  expect(await sessions.login("wrong")).toBeNull();

  const login = (await sessions.login("admin-secret"))!;
  const restored = new AdminSessions(password);
  expect(login.token).not.toContain(password);
  expect(restored.find(login.token)?.csrf).toBe(login.session.csrf);
  expect(restored.find(`${login.token}x`)).toBeNull();

  const changed = new AdminSessions(await Bun.password.hash("new-secret"));
  expect(changed.find(login.token)).toBeNull();
});

test("disables login when no admin password is configured", async () => {
  const sessions = new AdminSessions("");
  expect(sessions.enabled).toBe(false);
  expect(await sessions.login("")).toBeNull();
});
