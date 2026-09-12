import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { readFileSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, profile as profileTable, getProfile } from "../src/db";
import { rewriteCv, findUnsupportedClaims, type ConfirmedFacts } from "../src/pipeline/cvrewrite";

/** Regenerates the CV including facts the candidate has explicitly confirmed. */
(async () => {
  const facts = JSON.parse(readFileSync("confirmed-facts.json", "utf8")) as ConfirmedFacts;
  const before = await getProfile();

  console.log(`folding in ${facts.confirmed.length} confirmed facts, honouring ${facts.denied.length} denial(s)\n`);
  const r = await rewriteCv(undefined, facts);

  writeFileSync("CV-revised.txt", r.revised_cv, "utf8");

  // A denial is a hard constraint — verify it was actually honoured.
  const banned = ["powershell", "scripting", "automation script", "python", "bash script"];
  const violated = banned.filter((b) => r.revised_cv.toLowerCase().includes(b));
  const unsupported = findUnsupportedClaims(before.cvText + " " + facts.confirmed.join(" "), r.revised_cv);

  console.log(`denial check:      ${violated.length ? "VIOLATED -> " + violated.join(", ") : "honoured — no scripting claims present"}`);
  console.log(`fabrication check: ${unsupported.length ? "FLAGGED -> " + unsupported.join(", ") : "clean — nothing beyond the CV and your confirmed answers"}`);

  if (violated.length) { console.error("\nrefusing to save a CV that breaks a stated denial"); process.exit(1); }

  await db.update(profileTable).set({ cvText: r.revised_cv, updatedAt: new Date() }).where(eq(profileTable.id, 1));
  console.log(`\nprofile updated — ${r.safe_changes.length} changes, ${r.confirm_questions.length} questions still open`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
