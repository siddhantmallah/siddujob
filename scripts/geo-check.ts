import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { sql } from "drizzle-orm";
import { db, jobs } from "../src/db";

/**
 * Applying from outside the advertised country is the constraint that decides
 * this whole architecture. If a source geo-blocks the apply path, its listings
 * are readable but unusable — and the pipeline should prefer sources that do
 * not, rather than queueing applications that can never be submitted.
 */
const BLOCKED = /not available in your region|not available in your country|this job is no longer|unavailable in your location|restricted in your region/i;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

(async () => {
  const rows = await db
    .select({ source: jobs.source, url: jobs.url, company: jobs.company })
    .from(jobs)
    .where(sql`status <> 'blocked'`)
    .orderBy(sql`random()`)
    .limit(60);

  // One sample per source is enough to characterise the source itself.
  const bySource = new Map<string, { source: string; url: string; company: string }>();
  for (const r of rows) if (!bySource.has(r.source)) bySource.set(r.source, r);

  for (const job of bySource.values()) {
    try {
      const res = await fetch(job.url, {
        headers: { "user-agent": UA },
        redirect: "follow",
        signal: AbortSignal.timeout(22_000),
      });
      const html = await res.text();
      const blocked = BLOCKED.exec(html);
      console.log(
        `${job.source.padEnd(11)} HTTP ${res.status}  ${
          blocked ? `BLOCKED — "${blocked[0]}"` : "reachable"
        }   ${job.company.slice(0, 26)}`,
      );
    } catch (err) {
      console.log(`${job.source.padEnd(11)} FAILED  ${(err as Error).message.slice(0, 48)}`);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
