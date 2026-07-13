import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { manualServiceCommand, render } from "../src/service";

test("renders service paths and preserves home for manual installation", async () => {
  const owner = { home: "/home/client", uid: 1000, gid: 1001 };
  const unit = await render(owner);
  expect(unit).toContain("User=1000");
  expect(unit).toContain("Group=1001");
  expect(unit).toContain("Environment=HOME=/home/client");
  expect(unit).toContain("Environment=RUNESHOP_SERVICE=systemd");
  expect(unit).not.toContain("@HOME@");
  const command = manualServiceCommand(owner, 42);
  expect(command).toContain("handoff --home");
  expect(command).toContain("--uid 1000");
  expect(command).toContain("--gid 1001");
  expect(command).toContain("--pid 42");
  expect(manualServiceCommand()).toContain(homedir());
  const source = await Bun.file(resolve(import.meta.dir, "../src/service.ts")).text();
  expect(source).toContain("Bootstrap process did not exit within 10 seconds");
  expect(source).not.toContain("Bun.sleep(250)");
});
