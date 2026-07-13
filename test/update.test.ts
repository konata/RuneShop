import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Updater } from "../src/service";
import { configuration } from "./config";

test("enables updates only for systemd-managed instances", async () => {
  const unmanaged = await new Updater(configuration({ managed: false }), "HEAD").status(false);
  const managed = await new Updater(configuration({ managed: true }), "HEAD").status(false);
  expect(unmanaged.supported).toBe(false);
  expect(managed.supported).toBe(true);
});

test("updates under the service user and leaves restart to systemd", async () => {
  const script = await Bun.file(resolve(import.meta.dir, "../scripts/update.sh")).text();
  expect(script).toContain('exec 9>"$state/update.lock"');
  expect(script).not.toContain("systemctl restart");
  expect(script).not.toContain("/run/lock");
});
