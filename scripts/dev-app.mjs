// The local-only development launcher: OmniPost and nothing else.
//
// It marks the run local-only, which tells config to drop the platform
// configuration that only works behind the public tunnel `npm run dev` starts,
// instead of refusing to boot on a .env left over from a tunnel session. The
// app then says at startup which platforms it skipped. See src/lib/config.ts;
// the variable name is repeated here because a .mjs launcher cannot import it,
// the same way this directory's dev-all.mjs repeats the redirect URI rules.
import { spawn } from "node:child_process";

const child = spawn("next", ["dev"], {
  stdio: "inherit",
  env: { ...process.env, OMNIPOST_LOCAL_ONLY: "1" },
});

child.on("error", (error) => {
  console.error(`Could not start OmniPost: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
