import { z } from "zod";
import { JOB_POLICY_DEFAULTS } from "@/lib/job-policy";

// Env vars arrive as strings; a malformed one must name itself and never
// print its value, so the message is built from the variable name only.
function positiveInt(name: string) {
  return z.coerce
    .number({ message: `${name} must be a positive integer` })
    .int(`${name} must be a positive integer`)
    .positive(`${name} must be a positive integer`);
}

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
  // Optional shared-password access gate. Unset (or blank) means the app
  // runs open, which is the correct behaviour for a local-only install.
  ACCESS_PASSWORD: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  // Job engine policy. Defaults are sensible for a single-user instance;
  // an operator tuning them against a stricter platform quota should not
  // have to edit code.
  JOB_MAX_ATTEMPTS: positiveInt("JOB_MAX_ATTEMPTS").default(
    JOB_POLICY_DEFAULTS.maxAttempts,
  ),
  JOB_LEASE_MS: positiveInt("JOB_LEASE_MS").default(JOB_POLICY_DEFAULTS.leaseMs),
  JOB_BACKOFF_BASE_MS: positiveInt("JOB_BACKOFF_BASE_MS").default(
    JOB_POLICY_DEFAULTS.backoffBaseMs,
  ),
  JOB_BACKOFF_MAX_MS: positiveInt("JOB_BACKOFF_MAX_MS").default(
    JOB_POLICY_DEFAULTS.backoffMaxMs,
  ),
  // OAuth values stay optional until the operator connects YouTube. This
  // preserves dry-run-only installs, while the OAuth routes name exactly
  // which configuration is missing when they are used.
  YOUTUBE_CLIENT_ID: z.string().min(1).optional(),
  YOUTUBE_CLIENT_SECRET: z.string().min(1).optional(),
  YOUTUBE_REDIRECT_URI: z.string().url().optional(),
  // Same optional-until-connected pattern as YOUTUBE_*.
  TIKTOK_CLIENT_KEY: z.string().min(1).optional(),
  TIKTOK_CLIENT_SECRET: z.string().min(1).optional(),
  TIKTOK_REDIRECT_URI: z.string().url().optional(),
  // One public HTTPS origin is shared by every local platform integration.
  // Redirect paths remain platform-specific, but cannot point at a second
  // tunnel or host.
  PUBLIC_BASE_URL: z.string().url().optional(),
  INSTAGRAM_APP_ID: z.string().min(1).optional(),
  INSTAGRAM_APP_SECRET: z.string().min(1).optional(),
  INSTAGRAM_REDIRECT_URI: z.string().url().optional(),
  // A base64-encoded, 32-byte AES-256-GCM key. Never include the value in a
  // validation error: config errors name variables, not their secrets.
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
}).superRefine((config, context) => {
  const redirects = [
    ["TIKTOK_REDIRECT_URI", config.TIKTOK_REDIRECT_URI, "/api/platforms/tiktok/callback"],
    [
      "INSTAGRAM_REDIRECT_URI",
      config.INSTAGRAM_REDIRECT_URI,
      "/api/platforms/instagram/callback",
    ],
  ] as const;

  if (!config.PUBLIC_BASE_URL) {
    for (const [name, redirectUri] of redirects) {
      if (redirectUri) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: `${name} requires PUBLIC_BASE_URL`,
        });
      }
    }
    return;
  }

  const publicOrigin = new URL(config.PUBLIC_BASE_URL);
  if (
    publicOrigin.protocol !== "https:" ||
    publicOrigin.pathname !== "/" ||
    publicOrigin.search ||
    publicOrigin.hash ||
    config.PUBLIC_BASE_URL.includes("?") ||
    config.PUBLIC_BASE_URL.includes("#") ||
    publicOrigin.username ||
    publicOrigin.password
  ) {
    context.addIssue({
      code: "custom",
      path: ["PUBLIC_BASE_URL"],
      message: "PUBLIC_BASE_URL must be an HTTPS origin without a path, query, fragment, or credentials",
    });
  }

  for (const [name, redirectUri, callbackPath] of redirects) {
    if (!redirectUri) continue;
    const redirect = new URL(redirectUri);
    if (
      redirect.origin !== publicOrigin.origin ||
      redirect.pathname !== callbackPath ||
      redirect.search ||
      redirect.hash ||
      redirectUri.includes("?") ||
      redirectUri.includes("#") ||
      redirect.username ||
      redirect.password
    ) {
      context.addIssue({
        code: "custom",
        path: [name],
        message: `${name} must use PUBLIC_BASE_URL and end exactly in ${callbackPath}`,
      });
    }
  }
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
