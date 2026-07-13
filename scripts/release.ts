import { Updater } from "../src/service";
import { load } from "../src/state";

const updater = new Updater(load());
const action = Bun.argv[2] || "status";
const result = action === "start" ? await updater.start() : action === "status" ? await updater.status(true) : null;
if (!result) throw new Error(`unknown update action: ${action}`);
console.log(JSON.stringify(result, null, 2));
