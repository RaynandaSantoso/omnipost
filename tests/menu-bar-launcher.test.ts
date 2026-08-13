import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMenuBarController, presentStatus } from "../scripts/menu-bar/controller.mjs";

type LifecycleState = "starting" | "running" | "stopping" | "stopped" | "failed";

function status(state: LifecycleState, details: Record<string, unknown> = {}) {
  return { state, ...details };
}

function lifecycle(current: ReturnType<typeof status>) {
  return {
    status: vi.fn().mockResolvedValue(current),
    start: vi.fn().mockResolvedValue(status("running", { appUrl: "http://localhost:3000" })),
    open: vi.fn().mockResolvedValue({ ...current, opened: true }),
    stopSession: vi.fn().mockResolvedValue(status("stopped")),
    restart: vi.fn().mockResolvedValue(status("running", { appUrl: "http://localhost:3000" })),
    logs: vi.fn().mockReturnValue({
      available: true,
      logPath: "/tmp/omnipost-redacted.log",
      content: "safe log",
    }),
  };
}

describe("menu-bar Launcher adapter", () => {
  it.each([
    ["starting", { phase: "Waiting for OmniPost health" }, "Starting", "Waiting for OmniPost health", false],
    ["running", {}, "Running", "OmniPost is ready.", true],
    ["stopped", {}, "Stopped", "OmniPost is not running.", false],
    ["failed", { failure: "ACCESS_PASSWORD is required" }, "Failed", "ACCESS_PASSWORD is required", false],
  ] as const)(
    "presents %s as visible menu-bar state",
    (stateName, details, label, detail, openEnabled) => {
      expect(presentStatus(status(stateName, details))).toEqual(
        expect.objectContaining({
          type: "state",
          state: stateName,
          label,
          detail,
          openEnabled,
        }),
      );
    },
  );

  it.each([
    ["starting", false, false, false],
    ["running", true, true, true],
    ["stopping", false, false, false],
    ["stopped", false, false, true],
    ["failed", false, false, true],
  ] as const)(
    "makes lifecycle actions appropriate while %s",
    (stateName, stopEnabled, restartEnabled, quitEnabled) => {
      expect(presentStatus(status(stateName))).toEqual(
        expect.objectContaining({ stopEnabled, restartEnabled, quitEnabled }),
      );
    },
  );

  it("starts a stopped Launcher session when the application is opened", async () => {
    const launcher = lifecycle(status("stopped"));
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
    });

    await controller.dispatch("activate");

    expect(launcher.start).toHaveBeenCalledOnce();
    expect(launcher.start).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/project", rebuild: false }),
    );
    expect(launcher.open).not.toHaveBeenCalled();
    expect(messages).toEqual([
      expect.objectContaining({ state: "stopped" }),
      expect.objectContaining({ state: "starting" }),
      expect.objectContaining({ state: "running", openEnabled: true }),
    ]);
  });

  it("opens the existing session when the application is opened while Running", async () => {
    const launcher = lifecycle(status("running", { appUrl: "http://localhost:3000" }));
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: () => undefined,
    });

    await controller.dispatch("activate");

    expect(launcher.open).toHaveBeenCalledOnce();
    expect(launcher.start).not.toHaveBeenCalled();
  });

  it("stops a Running session through the shared Launcher and presents Stopping immediately", async () => {
    let finishStop!: (value: ReturnType<typeof status>) => void;
    const launcher = lifecycle(status("running"));
    launcher.stopSession.mockImplementation(
      () => new Promise((resolve) => (finishStop = resolve)),
    );
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
    });

    const stopping = controller.dispatch("stop");
    await vi.waitFor(() => {
      expect(messages).toContainEqual(
        expect.objectContaining({
          state: "stopping",
          detail: "OmniPost may still be finishing an active Job.",
        }),
      );
    });
    finishStop(status("stopped"));
    await stopping;

    expect(launcher.stopSession).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
    expect(messages.at(-1)).toEqual(expect.objectContaining({ state: "stopped" }));
  });

  it("restarts only after shared graceful shutdown completes", async () => {
    let finishRestart!: (value: ReturnType<typeof status>) => void;
    const launcher = lifecycle(status("running"));
    launcher.restart.mockImplementation(
      () => new Promise((resolve) => (finishRestart = resolve)),
    );
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
    });

    const restarting = controller.dispatch("restart");
    await vi.waitFor(() => {
      expect(messages).toContainEqual(expect.objectContaining({ state: "stopping" }));
    });
    expect(launcher.start).not.toHaveBeenCalled();
    finishRestart(status("running"));
    await restarting;

    expect(launcher.restart).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/project", rebuild: false }),
    );
    expect(messages.at(-1)).toEqual(expect.objectContaining({ state: "running" }));
  });

  it("offers Keep Waiting or Force Stop only after graceful shutdown times out", async () => {
    const launcher = lifecycle(status("running"));
    launcher.stopSession.mockResolvedValue(
      status("stopping", { timedOut: true, phase: "OmniPost may still be finishing an active Job" }),
    );
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
    });

    await controller.dispatch("stop");

    expect(messages.at(-1)).toEqual({
      type: "stopTimedOut",
      intent: "stop",
      message: "OmniPost is still finishing an active Job.",
      recovery: "Force Stop interrupts current work; it recovers through existing Lease and Transfer state.",
    });
  });

  it("presents a shutdown failure without offering timeout actions", async () => {
    const launcher = lifecycle(status("running"));
    launcher.stopSession.mockResolvedValue(
      status("failed", { failure: "The Launcher owner disappeared during cleanup." }),
    );
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
    });

    await controller.dispatch("stop");

    expect(messages.at(-1)).toEqual(
      expect.objectContaining({
        type: "state",
        state: "failed",
        detail: "The Launcher owner disappeared during cleanup.",
      }),
    );
    expect(messages).not.toContainEqual(expect.objectContaining({ type: "stopTimedOut" }));
  });

  it("keeps waiting through the shared stop operation", async () => {
    const launcher = lifecycle(status("running"));
    launcher.stopSession
      .mockResolvedValueOnce(status("stopping", { timedOut: true }))
      .mockResolvedValueOnce(status("stopped"));
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
    });

    await controller.dispatch("stop");
    launcher.status.mockResolvedValue(status("stopping"));
    await controller.dispatch("keepWaiting");

    expect(launcher.stopSession).toHaveBeenCalledWith(
      expect.objectContaining({ keepWaiting: true, force: false }),
    );
    expect(messages.at(-1)).toEqual(expect.objectContaining({ state: "stopped" }));
  });

  it("force stops only after explicit confirmation", async () => {
    const launcher = lifecycle(status("running"));
    launcher.stopSession
      .mockResolvedValueOnce(status("stopping", { timedOut: true }))
      .mockResolvedValueOnce(status("stopped"));
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
    });

    await controller.dispatch("stop");
    launcher.status.mockResolvedValue(status("stopping"));
    await controller.dispatch("requestForceStop");
    expect(launcher.stopSession).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)).toEqual(
      expect.objectContaining({ type: "confirmForceStop", intent: "stop" }),
    );

    await controller.dispatch("confirmForceStop");
    expect(launcher.stopSession).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it("quits only after the complete Running session has stopped", async () => {
    let finishStop!: (value: ReturnType<typeof status>) => void;
    const launcher = lifecycle(status("running"));
    launcher.stopSession.mockImplementation(
      () => new Promise((resolve) => (finishStop = resolve)),
    );
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
    });

    const quitting = controller.dispatch("quit");
    await vi.waitFor(() => {
      expect(messages).toContainEqual(expect.objectContaining({ state: "stopping" }));
    });
    expect(messages).not.toContainEqual({ type: "quitReady" });
    finishStop(status("stopped"));
    await quitting;

    expect(messages.at(-1)).toEqual({ type: "quitReady" });
  });

  it("quits immediately when no session is owned", async () => {
    const launcher = lifecycle(status("stopped"));
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
    });

    await controller.dispatch("quit");

    expect(launcher.stopSession).not.toHaveBeenCalled();
    expect(messages.at(-1)).toEqual({ type: "quitReady" });
  });

  it("does not abandon a still-owned Failed session when quitting", async () => {
    const launcher = lifecycle(status("failed", { failure: "The tunnel exited" }));
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
    });

    await controller.dispatch("quit");

    expect(launcher.stopSession).toHaveBeenCalledWith(
      expect.objectContaining({ keepWaiting: false, force: false }),
    );
    expect(messages.at(-1)).toEqual({ type: "quitReady" });
  });

  it("refreshes the visible startup phase while start is still pending", async () => {
    let finishStart!: (value: ReturnType<typeof status>) => void;
    const launcher = lifecycle(status("stopped"));
    launcher.start.mockImplementation(
      () => new Promise((resolve) => (finishStart = resolve)),
    );
    launcher.status
      .mockResolvedValueOnce(status("stopped"))
      .mockResolvedValue(status("starting", { phase: "Building OmniPost for production" }));
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
      startupRefreshMs: 1,
    });

    const activation = controller.dispatch("activate");
    await vi.waitFor(() => {
      expect(messages).toContainEqual(
        expect.objectContaining({ detail: "Building OmniPost for production" }),
      );
    });
    finishStart(status("running"));
    await activation;
  });

  it("keeps a startup failure visible and opens its redacted session log", async () => {
    const launcher = lifecycle(
      status("failed", {
        failure: "Production startup failed safely",
        logPath: "/tmp/omnipost-redacted.log",
      }),
    );
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
    });

    await controller.dispatch("activate");
    await controller.dispatch("viewLogs");

    expect(launcher.start).not.toHaveBeenCalled();
    expect(messages).toContainEqual(
      expect.objectContaining({ state: "failed", detail: "Production startup failed safely" }),
    );
    expect(messages).toContainEqual({ type: "openLog", path: "/tmp/omnipost-redacted.log" });
  });

  it("does not invoke Open OmniPost when status says it is not meaningful", async () => {
    const launcher = lifecycle(status("starting", { phase: "Building" }));
    const messages: unknown[] = [];
    const controller = createMenuBarController({
      launcher,
      env: () => undefined,
      cwd: "/project",
      emit: (message: unknown) => messages.push(message),
    });

    await controller.dispatch("open");

    expect(launcher.open).not.toHaveBeenCalled();
    expect(messages.at(-1)).toEqual(expect.objectContaining({ state: "starting" }));
  });

  it("configures the bundle as a native menu-bar application without Terminal", () => {
    const root = process.cwd();
    const plist = readFileSync(path.join(root, "OmniPost.app/Contents/Info.plist"), "utf8");
    const executable = readFileSync(path.join(root, "OmniPost.app/Contents/MacOS/OmniPost"), "utf8");
    const source = readFileSync(path.join(root, "macos/OmniPostLauncher.swift"), "utf8");

    expect(plist).toContain("<key>LSUIElement</key>");
    expect(plist).toMatch(/<key>LSUIElement<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>LSMultipleInstancesProhibited<\/key>\s*<true\/>/);
    expect(executable).not.toContain('tell application "Terminal"');
    expect(executable).toContain("/opt/homebrew/bin/node");
    expect(source).toContain("NSStatusBar.system.statusItem");
    expect(source).not.toContain("WKWebView");
    expect(source).toContain('NSMenuItem(title: "Stop OmniPost"');
    expect(source).toContain('NSMenuItem(title: "Restart"');
    expect(source).toContain('NSMenuItem(title: "Quit"');
    expect(source).toContain("applicationShouldTerminate");
  });
});
