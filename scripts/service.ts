import { command, install, manualHandoff, render, service, uninstall } from "../src/service";

const action = Bun.argv[2] || "status";
const homeIndex = Bun.argv.indexOf("--home");
const home = homeIndex >= 0 ? Bun.argv[homeIndex + 1] : undefined;
const uidIndex = Bun.argv.indexOf("--uid");
const uid = uidIndex >= 0 ? Number(Bun.argv[uidIndex + 1]) : NaN;
const gidIndex = Bun.argv.indexOf("--gid");
const gid = gidIndex >= 0 ? Number(Bun.argv[gidIndex + 1]) : NaN;
const pidIndex = Bun.argv.indexOf("--pid");
const pid = pidIndex >= 0 ? Number(Bun.argv[pidIndex + 1]) : NaN;
const owner = home && Number.isInteger(uid) && Number.isInteger(gid) ? { home, uid, gid } : undefined;
switch (action) {
  case "render":
    process.stdout.write(await render());
    break;
  case "install":
    await install(owner);
    break;
  case "handoff":
    if (!owner) throw new Error("manual handoff requires --home, --uid, and --gid");
    await manualHandoff(owner, pid);
    break;
  case "status":
    await command(["systemctl", "status", "--no-pager", service]);
    break;
  case "start":
  case "stop":
  case "restart":
    await command(["systemctl", action, service]);
    break;
  case "logs":
    await command(["journalctl", "--unit", service, "--follow", "--output", "cat"]);
    break;
  case "uninstall":
    await uninstall();
    break;
  default:
    throw new Error(`unknown service action: ${action}`);
}
