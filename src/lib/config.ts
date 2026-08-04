import { z } from "zod";
import { JOB_POLICY_DEFAULTS } from "@/lib/job-policy";
import type { Platform } from "@/lib/platform";

// Env vars arrive as strings; a malformed one must name itself and never
// print its value, so the message is built from the variable name only.
function positiveInt(name: string) {
  return z.coerce
    .number({ message: `${name} must be a positive integer` })
    .int(`${name} must be a positive integer`)
    .positive(`${name} must be a positive integer`);
}

// Set by `npm run dev:app`, the local-only development command. A local-only
// run has no public origin, so the platforms that reach OmniPost through one
// cannot be connected in it. Rather than refuse to start on a .env left over
// from a tunnel session, such a run drops that config and says which platforms
// it disabled. Nothing else sets this: `npm run dev` and production keep the
// strict rules, so a half-usable tunnel config can never reach a deployment.
export const LOCAL_ONLY_ENV_VAR = "OMNIPOST_LOCAL_ONLY";

// Platform config that only works behind a public tunnel, by the Platform it
// belongs to. YouTube is absent on purpose: its redirect is a localhost URL.
const TUNNEL_DEPENDENT_CONFIG = {
  tiktok: "TIKTOK_REDIRECT_URI",
  instagram: "INSTAGRAM_REDIRECT_URI",
} as const satisfies Partial<Record<Platform, string>>;

type TunnelDependentPlatform = keyof typeof TUNNEL_DEPENDENT_CONFIG;

const configFields = {
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
};

const configSchema = z.object(configFields).superRefine((config, context) => {
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

type Environment = Record<string, string | undefined>;

function isLocalOnly(env: Environment): boolean {
  return env[LOCAL_ONLY_ENV_VAR] === "1";
}

/**
 * The platforms whose configuration a local-only run is dropping, so startup
 * can say which platforms will not be connectable in it. Empty for any other
 * run, and empty when a public origin makes the configuration usable as-is.
 */
export function skippedPlatformConfig(
  env: Environment = process.env,
): TunnelDependentPlatform[] {
  if (!isLocalOnly(env) || env.PUBLIC_BASE_URL) return [];
  const platforms = Object.keys(TUNNEL_DEPENDENT_CONFIG) as TunnelDependentPlatform[];
  return platforms.filter((platform) => env[TUNNEL_DEPENDENT_CONFIG[platform]]);
}

// Drop what a local-only run cannot honour before validating, so the schema
// itself stays strict — there is one set of rules, applied to an environment
// this mode has already narrowed to what it can actually serve.
function withoutSkippedConfig(env: Environment): Environment {
  const skipped = skippedPlatformConfig(env);
  if (skipped.length === 0) return env;

  const narrowed = { ...env };
  for (const platform of skipped) {
    delete narrowed[TUNNEL_DEPENDENT_CONFIG[platform]];
  }
  return narrowed;
}

// A checkout with no .env has no OmniPost variable set at all, which is worth
// distinguishing from a filled-in .env that is missing one. Naming the file is
// safe: it says nothing about any value, which config errors never print.
// NODE_ENV is excluded because the runtime sets it — it says nothing about
// whether the operator has configured anything.
const CONFIGURABLE_VARS = Object.keys(configFields).filter(
  (name) => name !== "NODE_ENV",
);

function isUnconfigured(env: Environment): boolean {
  return CONFIGURABLE_VARS.every((name) => env[name] === undefined);
}

// Never interpolate the raw env value into the thrown message: a malformed
// secret must be nameable without being loggable.
export function loadConfig(env: Environment = process.env): AppConfig {
  const result = configSchema.safeParse(withoutSkippedConfig(env));
  if (result.success) return result.data;

  const problems = result.error.issues.map(
    (issue) => `  - ${issue.path.join(".") || "(config)"}: ${issue.message}`,
  );
  const hint = isUnconfigured(env)
    ? "\n\nNo OmniPost configuration was found. If this is a fresh checkout, copy .env.example to .env and fill it in."
    : "";
  throw new ConfigError(
    `Invalid configuration, refusing to start:\n${problems.join("\n")}${hint}`,
  );
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
