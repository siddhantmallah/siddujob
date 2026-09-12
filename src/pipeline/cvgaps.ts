import { desc, isNotNull, sql } from "drizzle-orm";
import { db, jobs, getProfile } from "@/db";
import { structured } from "@/lib/llm";
import { truncate } from "@/lib/utils";

/**
 * CV gap analysis.
 *
 * Every scored job leaves behind a list of concerns — the specific reasons a
 * recruiter would pass. Across a few hundred adverts those stop being noise and
 * start being a pattern, and the pattern is the most honest feedback on a CV
 * that exists: it comes from the actual market, not from an opinion.
 *
 * The distinction that matters is between a MISSING skill (you have never done
 * it, so the fix is to learn it or stop targeting those roles) and an UNSTATED
 * one (you have done it and did not write it down, which is free to fix today).
 */

export type CvGap = {
  requirement: string;
  frequency: number;
  kind: "missing" | "unstated" | "weak_evidence";
  impact: "high" | "medium" | "low";
  advice: string;
  suggested_line: string;
};

export type CvAnalysis = {
  gaps: CvGap[];
  strengths: string[];
  positioning: string;
  headline_suggestion: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    gaps: {
      type: "array",
      description: "Ordered by how much they cost, most damaging first. At most 10.",
      items: {
        type: "object",
        properties: {
          requirement: { type: "string", description: "The skill or credential, as employers phrase it." },
          frequency: { type: "integer", description: "How many of the supplied rejection notes mention it." },
          kind: {
            type: "string",
            enum: ["missing", "unstated", "weak_evidence"],
            description: "missing = no evidence in the CV at all. unstated = the CV implies it but never says it. weak_evidence = mentioned but without proof, scale or outcome.",
          },
          impact: { type: "string", enum: ["high", "medium", "low"] },
          advice: { type: "string", description: "One sentence, specific and actionable." },
          suggested_line: {
            type: "string",
            description: "For 'unstated' and 'weak_evidence' only: a CV bullet the candidate could legitimately add, drawn strictly from experience already evidenced. Empty string for 'missing' — never invent experience.",
          },
        },
        required: ["requirement", "frequency", "kind", "impact", "advice", "suggested_line"],
        additionalProperties: false,
      },
    },
    strengths: {
      type: "array",
      description: "What repeatedly worked in this candidate's favour. At most 5.",
      items: { type: "string" },
    },
    positioning: {
      type: "string",
      description: "Two or three sentences: which roles this CV genuinely competes for today, and which it does not.",
    },
    headline_suggestion: {
      type: "string",
      description: "A replacement headline for the top of the CV, aimed at the roles they can actually win.",
    },
  },
  required: ["gaps", "strengths", "positioning", "headline_suggestion"],
  additionalProperties: false,
} as const;

const SYSTEM = `You analyse why one candidate's applications are failing, using the real reasons recorded against real job adverts.

You are their advocate, but an honest one. Vague encouragement wastes their time; so does telling them to learn ten things at once.

Rules:
- Separate what they CANNOT claim (no experience) from what they CAN but did not write down. The second group is free to fix and is the most valuable output you produce.
- For anything you mark "unstated" or "weak_evidence", the suggested line must be supportable by the CV as written. Never invent an employer, a tool, a metric or a certification.
- Rank by how often it appears AND how central it is. A requirement in 30% of adverts that is always a hard gate outranks one in 60% that is a nice-to-have.
- Be concrete. "Add SIEM experience" is useless. "Name the SIEM you used for alert triage at Jai Kisan" is useful.`;

export async function analyseCvGaps(): Promise<CvAnalysis & { jobsAnalysed: number }> {
  const profile = await getProfile();

  const judged = await db
    .select({
      title: jobs.title,
      company: jobs.company,
      score: jobs.score,
      concerns: jobs.scoreConcerns,
      reasons: jobs.scoreReasons,
    })
    .from(jobs)
    .where(isNotNull(jobs.scoreConcerns))
    .orderBy(desc(jobs.score))
    .limit(180);

  if (judged.length < 5) {
    throw new Error(
      `Only ${judged.length} scored jobs so far — run discovery a few times before asking for gap analysis.`,
    );
  }

  const notes = judged
    .map((j) => {
      const concerns = (j.concerns ?? []).join("; ");
      if (!concerns) return null;
      return `[${j.score}] ${j.title} @ ${j.company}: ${concerns}`;
    })
    .filter(Boolean)
    .join("\n");

  const wins = judged
    .flatMap((j) => j.reasons ?? [])
    .slice(0, 60)
    .join("\n");

  const analysis = await structured<CvAnalysis>({
    system: [
      { text: SYSTEM },
      { text: `<candidate_cv>\n${truncate(profile.cvText, 9000)}\n</candidate_cv>`, cache: true },
    ],
    prompt: `These are the recorded reasons this candidate was judged a poor fit, across ${judged.length} real adverts they were matched against. The number in brackets is the fit score out of 100.

<rejection_notes>
${truncate(notes, 14000)}
</rejection_notes>

<what_worked>
${truncate(wins, 4000)}
</what_worked>

Work out what is systematically costing them interviews, and what they can fix today without inventing anything.`,
    toolName: "record_cv_analysis",
    toolDescription: "Record the CV gap analysis.",
    maxTokens: 16000,
    effort: "high",
    schema: SCHEMA as unknown as Record<string, unknown>,
  });

  return { ...analysis, jobsAnalysed: judged.length };
}

/** Cheap frequency count over concern text — used to sanity-check the model. */
export async function concernFrequencies(): Promise<Array<{ term: string; n: number }>> {
  const rows = await db
    .select({ concerns: jobs.scoreConcerns })
    .from(jobs)
    .where(isNotNull(jobs.scoreConcerns))
    .limit(400);

  const TERMS = [
    "siem", "splunk", "sentinel", "qradar", "powershell", "python", "scripting",
    "azure", "aws", "intune", "entra", "kubernetes", "terraform", "soc",
    "threat intelligence", "dfir", "forensics", "detection", "cissp", "ccna",
    "vmware", "linux", "networking", "cloud", "automation", "degree",
  ];
  const counts = new Map<string, number>();

  for (const row of rows) {
    const text = (row.concerns ?? []).join(" ").toLowerCase();
    for (const term of TERMS) {
      if (text.includes(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([term, n]) => ({ term, n }))
    .sort((a, b) => b.n - a.n);
}
