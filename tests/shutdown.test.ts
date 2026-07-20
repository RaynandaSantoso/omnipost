import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("registerShutdownHandlers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omnipost-shutdown-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("disconnects prisma and exits on SIGTERM", async () => {
    const { registerShutdownHandlers } = await import("@/lib/shutdown");
    const { prisma } = await import("@/lib/db");

    const disconnectSpy = vi
      .spyOn(prisma, "$disconnect")
      .mockResolvedValue(undefined);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    registerShutdownHandlers();
    process.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(disconnectSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    disconnectSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
