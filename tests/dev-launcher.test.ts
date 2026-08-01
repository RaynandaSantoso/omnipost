import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for launcher activity");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readEvents(logPath: string): Array<{ command: string; event: string; args: string[] }> {
  try {
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("npm run dev launcher", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to start without the shared public origin", () => {
    const result = spawnSync(process.execPath, ["scripts/dev-all.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PUBLIC_BASE_URL: "",
        TIKTOK_REDIRECT_URI: "",
        INSTAGRAM_REDIRECT_URI: "",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PUBLIC_BASE_URL");
  });

  it.each(["http://omnipost.ngrok-free.app", "https://omnipost.ngrok-free.app?"])(
    "refuses to start with an invalid shared public origin",
    (publicBaseUrl) => {
      const result = spawnSync(process.execPath, ["scripts/dev-all.mjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PUBLIC_BASE_URL: publicBaseUrl,
          TIKTOK_REDIRECT_URI: "",
          INSTAGRAM_REDIRECT_URI: "",
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PUBLIC_BASE_URL");
      expect(result.stderr).not.toContain(publicBaseUrl);
    },
  );

  it("starts one shared tunnel and stops both services", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "omnipost-launcher-"));
    temporaryDirectories.push(directory);
    const logPath = path.join(directory, "children.log");
    const fakeCommand = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const command = require("node:path").basename(process.argv[1]);
const record = (event) => appendFileSync(process.env.LAUNCHER_LOG, JSON.stringify({ command, event, args: process.argv.slice(2) }) + "\\n");
record("start");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { record(signal); process.exit(0); });
setInterval(() => {}, 1000);
`;
    for (const command of ["next", "ngrok"]) {
      const commandPath = path.join(directory, command);
      writeFileSync(commandPath, fakeCommand);
      chmodSync(commandPath, 0o755);
    }

    let output = "";
    const launcher = spawn(process.execPath, ["scripts/dev-all.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        LAUNCHER_LOG: logPath,
        PUBLIC_BASE_URL: "https://omnipost.ngrok-free.app",
        TIKTOK_REDIRECT_URI:
          "https://omnipost.ngrok-free.app/api/platforms/tiktok/callback",
        INSTAGRAM_REDIRECT_URI:
          "https://omnipost.ngrok-free.app/api/platforms/instagram/callback",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    launcher.stdout.on("data", (chunk) => (output += chunk.toString()));
    launcher.stderr.on("data", (chunk) => (output += chunk.toString()));

    await waitFor(() => readEvents(logPath).filter(({ event }) => event === "start").length === 2);
    launcher.kill("SIGTERM");
    await new Promise<void>((resolve, reject) => {
      launcher.once("exit", () => resolve());
      launcher.once("error", reject);
    });

    const events = readEvents(logPath);
    const starts = events.filter(({ event }) => event === "start");
    expect(starts.map(({ command }) => command).sort()).toEqual(["next", "ngrok"]);
    expect(starts.find(({ command }) => command === "next")?.args).toEqual(["dev"]);
    expect(starts.find(({ command }) => command === "ngrok")?.args).toEqual([
      "http",
      "--url=omnipost.ngrok-free.app",
      "3000",
    ]);
    expect(events.filter(({ event }) => event === "SIGTERM").map(({ command }) => command).sort()).toEqual([
      "next",
      "ngrok",
    ]);
    expect(output).toContain("http://localhost:3000");
    expect(output).toContain("https://omnipost.ngrok-free.app");
    expect(output).toMatch(/computer.*running.*jobs/i);
  });
});
