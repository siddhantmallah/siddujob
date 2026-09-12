import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { writeFileSync } from "node:fs";
import { desc, eq } from "drizzle-orm";
import { db, jobs, getProfile } from "../src/db";
import { generateCoverLetter } from "../src/pipeline/generate";
import { routeFor } from "../src/pipeline/apply";

/** Writes the letters. Sends nothing — this is the review step before anything leaves. */
(async () => {
  const profile = await getProfile();
  const matches = await db.select().from(jobs)
    .where(eq(jobs.status, "scored")).orderBy(desc(jobs.score)).limit(4);

  if (!matches.length) { console.log("no jobs above your keep threshold"); process.exit(0); }

  const out: string[] = [];
  for (const job of matches) {
    const route = routeFor(job);
    const letter = await generateCoverLetter(job, profile);

    console.log(`\n${"=".repeat(78)}`);
    console.log(`${job.score}  ${job.title}  —  ${job.company}`);
    console.log(`${job.location || job.country.toUpperCase()} · ${job.sponsorStatus}${job.sponsorMatchedName ? ` (${job.sponsorMatchedName})` : ""} · ${job.source}`);
    console.log(`delivery: ${route.channel}${route.target ? ` -> ${route.target}` : ""}`);
    console.log(`${job.url}`);
    console.log(`${"-".repeat(78)}`);
    console.log(`Subject: ${letter.subject}\n`);
    console.log(letter.body);
    console.log(`\n[angle] ${letter.note}`);

    out.push([
      `## ${job.title} — ${job.company}  (score ${job.score})`,
      `${job.location} · ${job.sponsorStatus} · ${job.url}`,
      `Delivery: ${route.channel}${route.target ? ` -> ${route.target}` : ""}`,
      ``, `**Subject:** ${letter.subject}`, ``, letter.body, ``,
      `_Angle: ${letter.note}_`, ``, `---`, ``,
    ].join("\n"));
  }

  writeFileSync("draft-applications.md", `# Draft applications\n\nNothing here has been sent.\n\n---\n\n${out.join("\n")}`, "utf8");
  console.log(`\n${"=".repeat(78)}\nwrote draft-applications.md — NOTHING SENT`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
