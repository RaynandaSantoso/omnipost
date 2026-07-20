import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { resolveDatabaseUrl } from "@/lib/database-url";

// Reused across hot reloads in dev so `next dev` doesn't exhaust SQLite
// connections by constructing a new client on every module reload.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const url = resolveDatabaseUrl(process.env.DATABASE_URL ?? "file:./data/dev.db");
  const adapter = new PrismaBetterSqlite3({ url });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Single-tenant app: exactly one User row, created on first boot.
export async function ensureSeedUser() {
  const existing = await prisma.user.findFirst();
  if (existing) {
    return existing;
  }
  return prisma.user.create({ data: {} });
}
