const PRESENTATION = {
  starting: {
    label: "Starting",
    defaultDetail: "OmniPost is starting.",
    openEnabled: false,
    stopEnabled: false,
    restartEnabled: false,
    quitEnabled: false,
  },
  running: {
    label: "Running",
    defaultDetail: "OmniPost is ready.",
    openEnabled: true,
    stopEnabled: true,
    restartEnabled: true,
    quitEnabled: true,
  },
  stopping: {
    label: "Stopping",
    defaultDetail: "OmniPost may still be finishing an active Job.",
    openEnabled: false,
    stopEnabled: false,
    restartEnabled: false,
    quitEnabled: false,
  },
  stopped: {
    label: "Stopped",
    defaultDetail: "OmniPost is not running.",
    openEnabled: false,
    stopEnabled: false,
    restartEnabled: false,
    quitEnabled: true,
  },
  failed: {
    label: "Failed",
    defaultDetail: "OmniPost could not start.",
    openEnabled: false,
    stopEnabled: false,
    restartEnabled: false,
    quitEnabled: true,
  },
};

/** Turn the Launcher's domain status into the small view model AppKit needs. */
export function presentStatus(result) {
  const presentation = PRESENTATION[result.state] ?? PRESENTATION.failed;
  return {
    type: "state",
    state: result.state in PRESENTATION ? result.state : "failed",
    label: presentation.label,
    detail: result.failure ?? result.phase ?? presentation.defaultDetail,
    openEnabled: presentation.openEnabled,
    stopEnabled: presentation.stopEnabled,
    restartEnabled: presentation.restartEnabled,
    quitEnabled: presentation.quitEnabled,
    logsEnabled: Boolean(result.logPath),
  };
}

/**
 * The menu-bar adapter knows menu intentions, but no lifecycle mechanics. Every
 * operation goes through the same Launcher interface as the terminal adapter.
 */
export function createMenuBarController({ launcher, env, cwd, emit, startupRefreshMs = 250 }) {
  let pendingIntent = null;

  function emitStopTimeout() {
    emit({
      type: "stopTimedOut",
      intent: pendingIntent,
      message: "OmniPost is still finishing an active Job.",
      recovery:
        "Force Stop interrupts current work; it recovers through existing Lease and Transfer state.",
    });
  }

  async function finishAfterStop(stopped) {
    if (stopped.state !== "stopped") {
      if (stopped.timedOut) emitStopTimeout();
      else {
        emit(presentStatus(stopped));
        pendingIntent = null;
      }
      return;
    }
    if (pendingIntent === "restart") {
      emit(presentStatus({ state: "starting", phase: "Restarting OmniPost" }));
      const started = await launcher.start({ env, cwd, rebuild: false });
      emit(presentStatus(started));
    } else if (pendingIntent === "quit") {
      emit({ type: "quitReady" });
    } else {
      emit(presentStatus(stopped));
    }
    pendingIntent = null;
  }

  async function beginStop(intent, phase) {
    pendingIntent = intent;
    emit(presentStatus({ state: "stopping", phase }));
    const stopped = await launcher.stopSession({ env, keepWaiting: false, force: false });
    await finishAfterStop(stopped);
  }

  async function terminateForMacOS() {
    pendingIntent = "terminate";
    emit(
      presentStatus({
        state: "stopping",
        phase: "macOS requested termination; OmniPost is cleaning up before exiting.",
      }),
    );
    let stopped = await launcher.stopSession({ env, keepWaiting: false, force: false });
    if (stopped.timedOut) {
      stopped = await launcher.stopSession({ env, keepWaiting: false, force: true });
    }
    if (stopped.state !== "stopped") {
      emit(presentStatus(stopped));
      pendingIntent = null;
      return;
    }
    pendingIntent = null;
    emit({ type: "quitReady" });
  }

  function canContinuePendingStop(current) {
    return Boolean(
      pendingIntent && (current.state === "stopping" || current.state === "failed"),
    );
  }

  async function refresh() {
    const current = await launcher.status({ env });
    emit(presentStatus(current));
    return current;
  }

  async function dispatch(action) {
    try {
      const current = await refresh();
      if (action === "status") return;

      if (action === "activate") {
        if (current.state === "running") await launcher.open({ env });
        else if (current.state === "stopped" || current.state === "failed") {
          emit(
            presentStatus({
              state: "starting",
              phase:
                current.state === "failed"
                  ? "Recovering the interrupted session"
                  : "Starting the production Launcher",
            }),
          );
          const startPromise = launcher.start({ env, cwd, rebuild: false });
          const refreshTimer = setInterval(() => {
            launcher.status({ env }).then((result) => emit(presentStatus(result))).catch(() => {});
          }, startupRefreshMs);
          const started = await startPromise.finally(() => clearInterval(refreshTimer));
          emit(presentStatus(started));
        }
        return;
      }

      if (action === "recover") {
        await dispatch("activate");
        return;
      }

      if (action === "open") {
        if (current.state === "running") await launcher.open({ env });
        return;
      }

      if (action === "viewLogs") {
        const result = launcher.logs({ env });
        if (result.available) emit({ type: "openLog", path: result.logPath });
        else emit({ type: "notice", message: result.reason });
        return;
      }

      if (action === "stop") {
        if (current.state !== "running") return;
        await beginStop(
          "stop",
          "OmniPost may still be finishing an active Job.",
        );
        return;
      }

      if (action === "restart") {
        if (current.state !== "running") return;
        pendingIntent = "restart";
        emit(
          presentStatus({
            state: "stopping",
            phase: "OmniPost may still be finishing an active Job before restarting.",
          }),
        );
        const restarted = await launcher.restart({ env, cwd, rebuild: false });
        if (restarted.state === "stopping") emitStopTimeout();
        else {
          emit(presentStatus(restarted));
          pendingIntent = null;
        }
        return;
      }

      if (action === "quit") {
        if (current.state === "stopped") {
          emit({ type: "quitReady" });
          return;
        }
        if (current.state !== "running" && current.state !== "failed") return;
        await beginStop(
          "quit",
          "OmniPost may still be finishing an active Job before quitting.",
        );
        return;
      }

      if (action === "terminate") {
        if (current.state === "stopped") {
          emit({ type: "quitReady" });
          return;
        }
        await terminateForMacOS();
        return;
      }

      if (action === "keepWaiting") {
        if (!canContinuePendingStop(current)) return;
        const stopped = await launcher.stopSession({ env, keepWaiting: true, force: false });
        await finishAfterStop(stopped);
        return;
      }

      if (action === "requestForceStop") {
        if (!canContinuePendingStop(current)) return;
        emit({
          type: "confirmForceStop",
          intent: pendingIntent,
          message: "Force Stop interrupts current work.",
          recovery: "Interrupted work recovers through existing Lease and Transfer state.",
        });
        return;
      }

      if (action === "confirmForceStop") {
        if (!canContinuePendingStop(current)) return;
        const stopped = await launcher.stopSession({ env, keepWaiting: false, force: true });
        await finishAfterStop(stopped);
        return;
      }

      emit({ type: "notice", message: `Unknown menu action: ${action}` });
    } catch (error) {
      const failed = await launcher.status({ env }).catch(() => ({
        state: "failed",
        failure: error instanceof Error ? error.message : String(error),
      }));
      emit(presentStatus(failed));
    }
  }

  return { dispatch };
}
