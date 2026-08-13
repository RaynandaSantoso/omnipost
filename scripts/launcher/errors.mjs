/**
 * A named, actionable Launcher failure: a prerequisite that is wrong, or
 * ownership of the one production session that cannot be taken. Its message
 * identifies the setting, command, path, or port at fault and never carries a
 * configured value, so it stays safe to print and log.
 */
export class LauncherError extends Error {
  constructor(message) {
    super(message);
    this.name = "LauncherError";
  }
}
