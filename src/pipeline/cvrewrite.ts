import { structured } from "@/lib/llm";
import { truncate } from "@/lib/utils";
import { getProfile } from "@/db";
import { analyseCvGaps, type CvAnalysis } from "./cvgaps";

/**
 * CV rewriting.
 *
 * Two categories of change, kept strictly apart because they carry different
 * risk:
 *
 *   SAFE     — reordering, rephrasing, removing self-sabotaging wording,
 *              surfacing evidence already present. Applied directly.
 *   CONFIRM  — a claim the market clearly wants and the CV hints at but does
 *              not state. These are NOT written into the CV. They are handed
 *              back as questions, because the only person who knows whether
 *              they are true is the candidate.
 *
 * A CV that overstates gets found out in the first technical interview, and the
 * cost of that lands on a person who has already waited years for the call.
 */

export type CvRewrite = {
  revised_cv: string;
  safe_changes: Array<{ change: string; why: string }>;
  confirm_questions: Array<{
    question: string;
    if_yes_add: string;
    section: string;
    why_it_matters: string;
  }>;
  removed: Array<{ removed: string; why: string }>;
};

const SCHEMA = {
  type: "object",
  properties: {
    revised_cv: {
      type: "string",
      description:
        "The complete rewritten CV as plain text with simple headings. Contains ONLY claims supportable by the original. No placeholders, no brackets, no TODO markers.",
    },
    safe_changes: {
      type: "array",
      description: "Changes made without needing new information. At most 12.",
      items: {
        type: "object",
        properties: {
          change: { type: "string" },
          why: { type: "string", description: "Tied to a real rejection reason where possible." },
        },
        required: ["change", "why"],
        additionalProperties: false,
      },
    },
    confirm_questions: {
      type: "array",
      description:
        "Things the market wants, which the CV neither states nor rules out. At most 10, ordered by how much they would help.",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "A direct yes/no question to the candidate." },
          if_yes_add: { type: "string", description: "The exact CV line to add if the answer is yes." },
          section: { type: "string", description: "Which CV section it belongs in." },
          why_it_matters: { type: "string", description: "What it unlocks, referencing the rejection pattern." },
        },
        required: ["question", "if_yes_add", "section", "why_it_matters"],
        additionalProperties: false,
      },
    },
    removed: {
      type: "array",
      description: "Content deliberately cut or reworded because it was hurting. At most 8.",
      items: {
        type: "object",
        properties: {
          removed: { type: "string" },
          why: { type: "string" },
        },
        required: ["removed", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["revised_cv", "safe_changes", "confirm_questions", "removed"],
  additionalProperties: false,
} as const;

const SYSTEM = `You rewrite one person's CV using evidence about why it is failing in a specific job market.

THE ABSOLUTE RULE: the revised CV may contain only claims a reader could justify from the original CV. No new employer, tool, product name, certification, metric, date, headcount or outcome. If the analysis says a skill is missing, the CV stays silent about it — you do not soften it, imply it, or hedge it in.

Where the market clearly wants something the CV neither claims nor denies, do NOT write it in. Put it in confirm_questions instead, phrased as a direct question, with the exact line to add if the answer is yes. That list is the most valuable thing you produce.

What you SHOULD do freely:
- Reposition. One clear target identity beats three hedged ones.
- Delete wording that disqualifies on skim. "Fundamentals" and "Exposure" next to a skill read as "cannot do this".
- Promote buried evidence. If something appears once in a duty list but is a headline requirement in the market, give it its own line.
- Lead every bullet with the action and its outcome, not the responsibility.
- Quantify only with numbers already in the original.
- Cut content that attracts roles the candidate cannot win.

British English. Plain text, simple headings, no markdown syntax, no tables. Keep it to two pages of content.`;

/**
 * Facts the candidate has explicitly confirmed in answer to a gap question.
 *
 * These are the ONLY route by which new claims may enter a CV. They come from
 * the person whose name is on it, which is the only authority that counts —
 * the model may never promote a guess into this list.
 */
export type ConfirmedFacts = {
  confirmed: string[];
  /** Explicitly denied. Must never appear in the CV, however tempting. */
  denied: string[];
};

export async function rewriteCv(
  existingAnalysis?: CvAnalysis,
  facts?: ConfirmedFacts,
): Promise<CvRewrite & { analysis: CvAnalysis }> {
  const profile = await getProfile();
  if (!profile.cvText?.trim()) {
    throw new Error("No CV text on the profile — upload your CV first.");
  }

  const analysis = existingAnalysis ?? (await analyseCvGaps());

  const gapSummary = analysis.gaps
    .map(
      (g) =>
        `- [${g.kind}, ${g.impact} impact, seen ${g.frequency}x] ${g.requirement}: ${g.advice}`,
    )
    .join("\n");

  const rewrite = await structured<CvRewrite>({
    system: [
      { text: SYSTEM },
      { text: `<original_cv>\n${truncate(profile.cvText, 10000)}\n</original_cv>`, cache: true },
    ],
    prompt: `Market evidence gathered from real adverts this candidate was scored against:

<positioning>
${analysis.positioning}
</positioning>

<repeated_strengths>
${analysis.strengths.map((s) => `- ${s}`).join("\n")}
</repeated_strengths>

<repeated_gaps>
${gapSummary}
</repeated_gaps>

${
      facts?.confirmed.length
        ? `\nThe candidate has since CONFIRMED the following, in answer to direct questions. Treat each as established fact and work it into the CV where it earns its place — these are the additions that close the gaps above:\n\n${facts.confirmed.map((f) => `- ${f}`).join("\n")}\n`
        : ""
    }${
      facts?.denied.length
        ? `\nThe candidate has explicitly DENIED the following. These must NOT appear anywhere in the CV, must not be implied, and must not be hedged in:\n\n${facts.denied.map((f) => `- ${f}`).join("\n")}\n`
        : ""
    }
Rewrite the CV for the roles the positioning says are genuinely winnable. Apply every change that needs no new information, plus every confirmed fact above. Anything still unresolved becomes a question.`,
    toolName: "record_cv_rewrite",
    toolDescription: "Record the rewritten CV and the reasoning behind it.",
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 32000,
    effort: "high",
  });

  return { ...rewrite, analysis };
}

/**
 * Cheap guard against the model quietly inventing a tool or certification.
 * Not a substitute for reading it, but it catches the obvious cases.
 */
export function findUnsupportedClaims(original: string, revised: string): string[] {
  const WATCHED = [
    "splunk", "sentinel", "qradar", "arcsight", "crowdstrike", "carbon black",
    "powershell", "python", "bash", "ansible", "terraform", "kubernetes",
    "docker", "jenkins", "gitlab", "cissp", "cism", "cisa", "oscp", "az-500",
    "az-104", "sc-200", "ccna", "comptia security+", "hyper-v", "intune",
    "defender", "entra", "okta", "sailpoint", "qualys", "rapid7",
  ];
  const before = original.toLowerCase();
  const after = revised.toLowerCase();
  return WATCHED.filter((term) => after.includes(term) && !before.includes(term));
}
