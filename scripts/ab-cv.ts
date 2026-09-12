import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { readFileSync, writeFileSync } from "node:fs";
import { eq, isNotNull, inArray, sql } from "drizzle-orm";
import { db, jobs, profile as profileTable, getProfile } from "../src/db";
import { scoreWithLlm } from "../src/pipeline/score";
import { mapLimit } from "../src/lib/utils";

/**
 * Same jobs, old CV vs revised CV. The only variable that changes is the CV,
 * so the score delta is attributable to the rewrite and nothing else.
 */
(async () => {
  const before = await getProfile();
  writeFileSync("cv-original-backup.txt", before.cvText, "utf8");

  const sample = await db.select().from(jobs)
    .where(sql`score is not null and status <> 'blocked'`)
    .orderBy(sql`score desc`).limit(12);

  console.log(`comparing ${sample.length} already-scored jobs\n`);
  const old = new Map(sample.map((j) => [j.id, j.score ?? 0]));

  const revised = readFileSync("CV-revised.txt", "utf8");
  await db.update(profileTable).set({ cvText: revised }).where(eq(profileTable.id, 1));
  const after = await getProfile();

  const results = await mapLimit(sample, 4, async (job) => {
    try {
      const r = await scoreWithLlm(job, after);
      return { job, next: Math.min(100, Math.max(0, Math.round(r.fit_score))) };
    } catch {
      return { job, next: null as number | null };
    }
  });

  let up = 0, down = 0, same = 0, delta = 0;
  console.log("  old  new   job");
  for (const { job, next } of results) {
    if (next === null) { console.log("   ??   ??   " + job.title.slice(0, 46)); continue; }
    const o = old.get(job.id) ?? 0;
    const d = next - o;
    delta += d;
    if (d > 2) up++; else if (d < -2) down++; else same++;
    const arrow = d > 2 ? "UP  " : d < -2 ? "DOWN" : "  = ";
    console.log(`  ${String(o).padStart(3)}  ${String(next).padStart(3)}  ${arrow} ${job.title.slice(0, 44).padEnd(44)} ${job.company.slice(0, 16)}`);
  }
  console.log(`\n${up} improved, ${down} worse, ${same} unchanged — average change ${(delta / results.length).toFixed(1)} points`);
  console.log("\nprofile now holds the revised CV (original saved to cv-original-backup.txt)");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
