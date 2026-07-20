import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z
    .string({ message: "DATABASE_URL is required" })
    .min(1, "DATABASE_URL is required")
    .refine((value) => value.startsWith("file:"), {
      message: "DATABASE_URL must be a sqlite connection string (file:...)",
    }),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// Never interpolate the raw env value into the thrown message: a malformed
// secret must be nameable without being loggable.
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(config)"}: ${issue.message}`,
    );
    throw new ConfigError(
      `Invalid configuration, refusing to start:\n${problems.join("\n")}`,
    );
  }
  return result.data;
}

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

// Test-only: allow a fresh loadConfig() call to re-validate process.env.
export function resetConfigCache(): void {
  cachedConfig = undefined;
}
