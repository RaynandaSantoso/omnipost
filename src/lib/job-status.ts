// The lifecycle of one platform upload. Statuses are stored as plain
// strings (SQLite has no enum), so they are named here rather than spelled
// out at each query: a typo in a `where` clause would otherwise match
// nothing silently instead of failing to compile.
export const JOB_STATUS = {
  pending: "pending",
  uploading: "uploading",
  done: "done",
  failed: "failed",
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export function jobStatusFrom(value: string): JobStatus {
  const statuses = Object.values(JOB_STATUS) as string[];
  if (statuses.includes(value)) return value as JobStatus;
  throw new Error(`unsupported Job status "${value}"`);
}
