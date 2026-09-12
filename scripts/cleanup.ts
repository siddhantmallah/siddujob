import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { sql, inArray, notInArray, and, ne } from "drizzle-orm";
import { db, jobs, getProfile } from "../src/db";

/**
 * Retires jobs that newer rules would never have ingested. Run after changing
 * target countries so the stored list matches what the pipeline believes.
 */
(async () => {
  const profile = await getProfile();
  const wanted = profile.targetCountries;
  if (!wanted.length) { console.log("no target countries set"); process.exit(0); }

  const res = await db.update(jobs).set({
    status: "blocked",
    skipReason: "Outside your target countries",
  }).where(and(
    ne(jobs.country, ""),
    notInArray(jobs.country, wanted),
    notInArray(jobs.status, ["applied", "queued"]),
  )).returning({ id: jobs.id });

  console.log(`retired ${res.length} jobs outside ${wanted.join(", ")}`);

  const left = await db.select({
    country: jobs.country, n: sql<number>`count(*)::int`,
  }).from(jobs).where(ne(jobs.status, "blocked")).groupBy(jobs.country)
    .orderBy(sql`count(*) desc`).limit(12);
  console.log("remaining:", left.map((r) => `${r.country || "??"}=${r.n}`).join("  "));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
