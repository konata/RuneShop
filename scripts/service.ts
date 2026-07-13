import { command, install, manualHandoff, render, service, uninstall } from "../src/service";

const action = Bun.argv[2] || "status";
const option = (name: string) => Bun.argv[Bun.argv.indexOf(`--${name}`) + 1];
const home = option("home");
const uid = Number(option("uid"));
const gid = Number(option("gid"));
const pid = Number(option("pid"));
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
