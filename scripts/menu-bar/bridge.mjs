import { createInterface } from "node:readline";

import { environmentFrom } from "../launcher/environment.mjs";
import * as launcher from "../launcher/lifecycle.mjs";
import { createMenuBarController } from "./controller.mjs";

const cwd = process.argv[2] ?? process.cwd();
const env = environmentFrom(cwd);
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const controller = createMenuBarController({ launcher, env, cwd, emit });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Commands are intentionally serialized: two quick menu clicks cannot race
// one another into contradictory lifecycle requests.
let pending = Promise.resolve();
lines.on("line", (action) => {
  pending = pending.then(() => controller.dispatch(action));
});
