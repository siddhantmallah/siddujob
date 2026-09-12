import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import * as schema from "./schema";

export * from "./schema";

/**
 * The connection is created on first query, not on import. Next.js evaluates
 * every route module during `next build`, and a build must not need a live
 * database — only a request does.
 */
let instance: NeonHttpDatabase<typeof schema> | null = null;

function connect(): NeonHttpDatabase<typeof schema> {
  if (instance) return instance;
  // JOBFINDER_DATABASE_URL wins when present. Plain DATABASE_URL is a very
  // common machine-wide variable, and a stale one silently points this app at
  // someone else's database — which is exactly what happened on first setup.
  const url = process.env.JOBFINDER_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "No database URL. Set JOBFINDER_DATABASE_URL (preferred) or DATABASE_URL in .env, or in the Vercel project settings.",
    );
  }
  instance = drizzle(neon(url), { schema });
  return instance;
}

export const db = new Proxy({} as NeonHttpDatabase<typeof schema>, {
  get(_target, property, receiver) {
    const real = connect() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, property, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

/** Reads the singleton profile row, creating it on first call. */
export async function getProfile() {
  const [row] = await db.select().from(schema.profile).where(eq(schema.profile.id, 1));
  if (row) return row;
  const [created] = await db.insert(schema.profile).values({ id: 1 }).returning();
  return created;
}

/** Reads the singleton settings row, creating it on first call. */
export async function getSettings() {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.id, 1));
  if (row) return row;
  const [created] = await db.insert(schema.settings).values({ id: 1 }).returning();
  return created;
}

export async function logEvent(
  kind: string,
  message: string,
  opts: { level?: "info" | "warn" | "error"; meta?: Record<string, unknown> } = {},
) {
  try {
    await db.insert(schema.events).values({
      kind, message, level: opts.level ?? "info", meta: opts.meta,
    });
  } catch {
    // Logging must never take the pipeline down.
  }
}
