import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { writeFileSync } from "node:fs";
import { getProfile } from "../src/db";
import { rewriteCv, findUnsupportedClaims } from "../src/pipeline/cvrewrite";
import { usageTotals, MODEL } from "../src/lib/llm";

(async () => {
  const profile = await getProfile();
  const r = await rewriteCv();

  const unsupported = findUnsupportedClaims(profile.cvText, r.revised_cv);

  writeFileSync("CV-revised.txt", r.revised_cv, "utf8");

  const notes = [
    "# CV revision notes",
    "",
    "## Changes applied (no new information needed)",
    ...r.safe_changes.map((c) => `- **${c.change}**\n  ${c.why}`),
    "",
    "## Cut or reworded",
    ...r.removed.map((c) => `- **${c.removed}**\n  ${c.why}`),
    "",
    "## Confirm before adding — these are NOT in the revised CV",
    "",
    "Each one is something the market repeatedly asked for that your CV neither",
    "claims nor rules out. Answer honestly; a yes you cannot defend at interview",
    "is worse than a no.",
    "",
    ...r.confirm_questions.map(
      (q, i) =>
        `### ${i + 1}. ${q.question}\n\n- **Section:** ${q.section}\n- **Why:** ${q.why_it_matters}\n- **If yes, add:**\n\n  > ${q.if_yes_add}\n`,
    ),
  ].join("\n");
  writeFileSync("CV-revision-notes.md", notes, "utf8");

  console.log("wrote CV-revised.txt and CV-revision-notes.md\n");
  console.log(`fabrication check: ${unsupported.length ? "FLAGGED -> " + unsupported.join(", ") : "clean — no unsupported tools or certifications introduced"}`);
  console.log(`\n${r.safe_changes.length} changes applied, ${r.removed.length} cuts, ${r.confirm_questions.length} questions for you\n`);
  console.log("QUESTIONS TO ANSWER:");
  for (const [i, q] of r.confirm_questions.entries()) {
    console.log(`  ${i + 1}. ${q.question}`);
  }
  const u = usageTotals();
  console.log(`\n${MODEL}: ${u.calls} calls, ${u.outputTokens} out`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
