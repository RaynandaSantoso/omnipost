import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for launcher activity");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeFakeCommands(commands: Record<string, string>): { directory: string; logPath: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "omnipost-run-launcher-"));
  temporaryDirectories.push(directory);
  const logPath = path.join(directory, "commands.log");

  for (const [command, source] of Object.entries(commands)) {
    const commandPath = path.join(directory, command);
    writeFileSync(commandPath, `#!/usr/bin/env node\n${source}`);
    chmodSync(commandPath, 0o755);
  }

  return { directory, logPath };
}

function readEvents(logPath: string): Array<{ command: string; args: string[]; event: string }> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("production launcher", () => {
  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    children.clear();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opens the existing app without starting or validating another session", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("ready");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(3000, "127.0.0.1", resolve);
    });

    const { directory, logPath } = makeFakeCommands({
      open: `const { appendFileSync } = require("node:fs"); appendFileSync(process.env.LAUNCHER_LOG, JSON.stringify({ command: "open", event: "start", args: process.argv.slice(2) }) + "\\n");`,
    });
    const workingDirectory = mkdtempSync(path.join(tmpdir(), "omnipost-running-launcher-"));
    temporaryDirectories.push(workingDirectory);

    try {
      const launcher = spawn(process.execPath, [path.join(process.cwd(), "scripts/run-all.mjs")], {
        cwd: workingDirectory,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          LAUNCHER_LOG: logPath,
          PUBLIC_BASE_URL: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(launcher);
      const status = await new Promise<number | null>((resolve, reject) => {
        launcher.once("exit", (code) => resolve(code));
        launcher.once("error", reject);
      });

      expect(status).toBe(0);
      expect(readEvents(logPath)).toEqual([
        { command: "open", event: "start", args: ["http://localhost:3000"] },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("runs the production app and tunnel while preventing idle sleep", async () => {
    const workingDirectory = mkdtempSync(path.join(tmpdir(), "omnipost-production-launcher-"));
    temporaryDirectories.push(workingDirectory);
    mkdirSync(path.join(workingDirectory, ".next"), { recursive: true });
    writeFileSync(path.join(workingDirectory, ".next", "BUILD_ID"), "test-build");

    const recorder = `
const { appendFileSync } = require("node:fs");
const command = require("node:path").basename(process.argv[1]);
const record = (event) => appendFileSync(process.env.LAUNCHER_LOG, JSON.stringify({ command, event, args: process.argv.slice(2) }) + "\\n");
record("start");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { record(signal); process.exit(0); });
setInterval(() => {}, 1000);
`;
    const next = `
${recorder}
const { createServer } = require("node:http");
const server = createServer((_request, response) => { response.statusCode = 200; response.end("ready"); });
server.listen(3000, "127.0.0.1");
`;
    const open = `
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.LAUNCHER_LOG, JSON.stringify({ command: "open", event: "start", args: process.argv.slice(2) }) + "\\n");
`;
    const { directory, logPath } = makeFakeCommands({ next, ngrok: recorder, caffeinate: recorder, open });
    const launcher = spawn(process.execPath, [path.join(process.cwd(), "scripts/run-all.mjs")], {
      cwd: workingDirectory,
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
    children.add(launcher);

    await waitFor(() => readEvents(logPath).some(({ command }) => command === "open"));
    launcher.kill("SIGTERM");
    await new Promise<void>((resolve, reject) => {
      launcher.once("exit", () => resolve());
      launcher.once("error", reject);
    });

    const events = readEvents(logPath);
    expect(events.find(({ command, event }) => command === "next" && event === "start")?.args).toEqual([
      "start",
      "--port",
      "3000",
    ]);
    expect(events.find(({ command, event }) => command === "ngrok" && event === "start")?.args).toEqual([
      "http",
      "--url=omnipost.ngrok-free.app",
      "3000",
    ]);
    expect(
      events.find(({ command, event }) => command === "caffeinate" && event === "start")?.args,
    ).toEqual(["-i", "-w", expect.any(String)]);
    expect(events.find(({ command, event }) => command === "open" && event === "start")?.args).toEqual([
      "http://localhost:3000",
    ]);
    expect(events.filter(({ event }) => event === "SIGTERM").map(({ command }) => command).sort()).toEqual([
      "caffeinate",
      "next",
      "ngrok",
    ]);
  });
});

describe("macOS app bundle", () => {
  it("launches the production runner in Terminal and declares its icon", () => {
    const plist = readFileSync("OmniPost.app/Contents/Info.plist", "utf8");
    const executablePath = "OmniPost.app/Contents/MacOS/OmniPost";
    const executable = readFileSync(executablePath, "utf8");

    expect(plist).toContain("CFBundleExecutable");
    expect(plist).toContain("CFBundleIconFile");
    expect(plist).not.toContain("LSMinimumSystemVersion");
    expect(executable).toContain('tell application "Terminal"');
    expect(executable).toContain("scripts/run-all.mjs");
    expect(executable).not.toContain("scripts/dev-all.mjs");
    expect((statSync(executablePath).mode & 0o111) !== 0).toBe(true);
    expect(existsSync("OmniPost.app/Contents/Resources/OmniPost.icns")).toBe(true);
  });
});
