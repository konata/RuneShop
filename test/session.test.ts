import { expect, test } from "bun:test";
import { AdminSessions } from "../src/admin";

test("creates short-lived admin sessions without retaining the password as the token", async () => {
  const sessions = new AdminSessions(await Bun.password.hash("admin-secret"));
  expect(await sessions.login("wrong")).toBeNull();

  const login = await sessions.login("admin-secret");
  expect(login).not.toBeNull();
  expect(login!.token).not.toContain("admin-secret");
  expect(sessions.find(login!.token)?.csrf).toBe(login!.session.csrf);

  sessions.logout(login!.token);
  expect(sessions.find(login!.token)).toBeNull();
});

test("disables login when no admin password is configured", async () => {
  const sessions = new AdminSessions("");
  expect(sessions.enabled).toBe(false);
  expect(await sessions.login("")).toBeNull();
});
