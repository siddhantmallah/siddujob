import { structured } from "@/lib/llm";
import { truncate } from "@/lib/utils";
import type { Job, Profile } from "@/db";

/**
 * Cover letter generation.
 *
 * The hard constraint here is truthfulness. A letter that invents experience
 * gets found out at interview and burns the employer permanently. Everything
 * claimed must trace back to the CV text.
 */

const SYSTEM = `You write cover letters for one specific job seeker applying to one specific job.

ABSOLUTE RULES — these override any instinct to make the letter more impressive:
- Every claim must be traceable to the candidate's CV. Invent nothing: no employers, no tools, no certifications, no metrics, no dates.
- If the candidate lacks something the ad asks for, either stay silent about it or address it honestly through adjacent real experience. Never imply they have it.
- No fabricated enthusiasm about the company's "mission" unless the job ad itself gives you something concrete to react to.

STYLE:
- British business English. Warm, direct, specific. No American spellings.
- 180-260 words of body text. Recruiters skim; long letters get skipped.
- Three movements: why this role and this employer specifically, then the two or three strongest concrete overlaps with evidence, then a short close.
- Open with substance. Never "I am writing to apply for..." or "I was excited to see...".
- No bullet lists, no headers, no markdown. Flowing paragraphs only.
- Do not include a date, address block, or signature — those are added by the template.

Write as the candidate, first person.`;

type Generated = {
  subject: string;
  body: string;
  tailoring_note: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    subject: {
      type: "string",
      description: "Email subject line. Format: 'Application: <exact job title>' plus a reference number if the ad gives one.",
    },
    body: {
      type: "string",
      description: "The cover letter body. Starts with 'Dear ...' and ends before any sign-off. Plain text, paragraphs separated by blank lines.",
    },
    tailoring_note: {
      type: "string",
      description: "One sentence, for the candidate's own reference, naming the specific angle taken.",
    },
  },
  required: ["subject", "body", "tailoring_note"],
  additionalProperties: false,
} as const;

export async function generateCoverLetter(
  job: Job,
  profile: Profile,
): Promise<{ subject: string; body: string; note: string }> {
  const cv = profile.cvText?.trim()
    ? truncate(profile.cvText, 9000)
    : [
        profile.headline,
        profile.summary,
        `Skills: ${profile.skills.join(", ")}`,
        `Experience: ${profile.yearsExperience} years`,
      ].filter(Boolean).join("\n");

  if (!cv.trim()) {
    throw new Error("Your profile has no CV text — add it before generating letters");
  }

  const sponsorshipLine = profile.needsSponsorship
    ? `\nWORK AUTHORISATION: the candidate requires visa sponsorship${job.country === "gb" ? " (UK Skilled Worker)" : ""}. Include ONE short, matter-of-fact sentence near the end stating this. Do not apologise for it, do not dwell on it, do not make it the theme of the letter.`
    : "";

  const result = await structured<Generated>({
    // Rules + CV are the same for every letter, so they go behind a cache
    // breakpoint; only the advert below changes per application.
    system: [
      { text: SYSTEM },
      {
        text: `<candidate_cv>\n${cv}\n</candidate_cv>\n\n<candidate_details>\nName: ${profile.fullName || "the candidate"}\nBased in: ${profile.location || "not stated"}\n</candidate_details>`,
        cache: true,
      },
    ],
    prompt: `<job_advert>
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}${job.remote ? " (remote)" : ""}

${truncate(job.description, 7000)}
</job_advert>

<what_the_screener_found>
Strengths: ${(job.scoreReasons ?? []).join("; ") || "none recorded"}
Gaps: ${(job.scoreConcerns ?? []).join("; ") || "none recorded"}
</what_the_screener_found>
${sponsorshipLine}

Write the cover letter. Lead with the strongest genuine overlap. If a named hiring contact appears in the advert, address them; otherwise use "Dear Hiring Manager".`,
    toolName: "write_cover_letter",
    toolDescription: "Record the tailored cover letter for this application.",
    schema: SCHEMA as unknown as Record<string, unknown>,
    // The letter is what an employer reads — worth the thinking budget.
    maxTokens: 16000,
    effort: "high",
  });

  const body = cleanBody(result.body, profile.fullName);
  return {
    subject: result.subject?.trim() || `Application: ${job.title}`,
    body,
    note: result.tailoring_note?.trim() ?? "",
  };
}

/**
 * Models sometimes append a sign-off despite being told not to. Strip any
 * trailing one so the template never produces two signatures.
 */
function cleanBody(body: string, fullName: string): string {
  let out = body.trim();
  const signOff = /\n\s*(kind regards|best regards|yours sincerely|yours faithfully|regards|sincerely|many thanks|thanks)[,.]?\s*(\n.*)?$/i;
  out = out.replace(signOff, "").trim();
  if (fullName) {
    out = out.replace(new RegExp(`\\n\\s*${escapeRegExp(fullName)}\\s*$`, "i"), "").trim();
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The plain-text email body: letter plus a proper sign-off and contact block. */
export function composeEmailBody(letter: string, profile: Profile): string {
  const links = [profile.linkedin, profile.github, profile.website].filter(Boolean);
  const signature = [
    "",
    "Kind regards,",
    profile.fullName,
    [profile.phone, profile.email].filter(Boolean).join("  ·  "),
    links.join("  ·  "),
  ].filter((l) => l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n");

  return `${letter}\n${signature}\n`;
}
