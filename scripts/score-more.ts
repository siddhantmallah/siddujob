import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { sql, desc, eq } from "drizzle-orm";
import { db, jobs, getSettings } from "../src/db";
import { runScoring } from "../src/pipeline/score";
import { usageTotals, estimateCost, BULK_MODEL } from "../src/lib/llm";

/** Scores the next N best-ranked unscored jobs. Does not reset anything. */
(async () => {
  const n = Number(process.argv[2] ?? 100);
  const [{ left }] = await db.select({ left: sql<number>`count(*)::int` })
    .from(jobs).where(eq(jobs.status, "new"));
  console.log(`${left.toLocaleString("en-GB")} unscored jobs in the pool — scoring the best ${n}\n`);

  const s = await runScoring(n);
  const u = usageTotals();

  const kept = await db.select().from(jobs).where(eq(jobs.status, "scored")).orderBy(desc(jobs.score));
  const settings = await getSettings();

  console.log(`ALL MATCHES ABOVE THRESHOLD (${settings.keepThreshold})\n`);
  for (const j of kept) {
    const auto = (j.score ?? 0) >= settings.autoApplyThreshold ? " AUTO" : "     ";
    console.log(`${String(j.score).padStart(3)}${auto}  ${j.title.slice(0, 48).padEnd(48)} | ${j.company.slice(0, 22).padEnd(22)} | ${j.country} ${j.sponsorStatus}`);
  }
  console.log(`\nscored ${s.scored}  kept ${s.keptAboveThreshold}  visa-blocked ${s.visaBlocked}  early-rejected ${s.skippedEarly}  errors ${s.errors}`);
  console.log(`total matches now: ${kept.length}`);
  const c = estimateCost(BULK_MODEL);
  console.log(`
${BULK_MODEL}: ${u.calls} calls`);
  console.log(`  fresh input ${u.inputTokens.toLocaleString("en-GB")}   cache read ${u.cacheReadTokens.toLocaleString("en-GB")}   cache write ${u.cacheWriteTokens.toLocaleString("en-GB")}   output ${u.outputTokens.toLocaleString("en-GB")}`);
  console.log(`  cost ${c.spent.toFixed(4)}   without caching ${c.withoutCaching.toFixed(4)}   saved ${c.savedPercent}%`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
