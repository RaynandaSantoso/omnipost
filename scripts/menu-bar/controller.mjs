const PRESENTATION = {
  starting: {
    label: "Starting",
    defaultDetail: "OmniPost is starting.",
    openEnabled: false,
  },
  running: {
    label: "Running",
    defaultDetail: "OmniPost is ready.",
    openEnabled: true,
  },
  stopping: {
    label: "Stopping",
    defaultDetail: "OmniPost may still be finishing an active Job.",
    openEnabled: false,
  },
  stopped: {
    label: "Stopped",
    defaultDetail: "OmniPost is not running.",
    openEnabled: false,
  },
  failed: {
    label: "Failed",
    defaultDetail: "OmniPost could not start.",
    openEnabled: false,
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
    logsEnabled: Boolean(result.logPath),
  };
}

/**
 * The menu-bar adapter knows menu intentions, but no lifecycle mechanics. Every
 * operation goes through the same Launcher interface as the terminal adapter.
 */
export function createMenuBarController({ launcher, env, cwd, emit, startupRefreshMs = 250 }) {
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
        else if (current.state === "stopped") {
          emit(
            presentStatus({ state: "starting", phase: "Starting the production Launcher" }),
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
