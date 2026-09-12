import { eq, and, inArray, desc, asc, sql } from "drizzle-orm";
import { db, jobs, getProfile, getSettings, logEvent, type Job, type Profile } from "@/db";
import { structured, llmAvailable } from "@/lib/llm";
import { clamp, mapLimit, truncate } from "@/lib/utils";
import { assessUk, assessEu, looksLikeItRole, type VisaVerdict } from "@/lib/visa";
import { lookupSponsors, looksLikeAgency, type SponsorHit } from "./sponsors";

/**
 * Two-stage scoring.
 *
 * Stage 1 is free keyword maths that throws out the obvious mismatches — most
 * of what job boards return. Stage 2 spends a model call only on survivors,
 * which keeps the cost of a daily run in pennies rather than pounds.
 */

const PRE_SCORE_FLOOR = 22;
/** Per-run ceiling so a serverless invocation stays inside its time limit. */
const MAX_LLM_JOBS_PER_RUN = 30;

/* ───────────────────────── Stage 1: heuristics ───────────────────────── */

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9+#.]+/).filter((t) => t.length > 1);
}

const SENIORITY_TOO_HIGH = /\b(head of|director|vp|vice president|chief|cto|cio|principal|staff engineer)\b/i;
const SENIORITY_TOO_LOW =
  /\b(intern|internship|apprentice|apprenticeship|placement|work experience|graduate scheme|trainee|entry.?level)\b/i;

/**
 * Training providers advertise "Trainee Cyber Security Analyst" positions that
 * are really paid courses, not jobs. They flood security job boards, rank well
 * on keywords, and charge the applicant — so they are caught by shape rather
 * than by maintaining a blocklist of company names.
 */
const TRAINING_SCAM =
  /\b(training (provider|course|programme|program)|bootcamp|course fee|guaranteed interview|guaranteed job|self.?funded|tuition|enrol|enroll|re.?training)\b/i;

/**
 * UK security roles routinely require SC, DV, CTC or NPPV clearance, and every
 * one of those needs several years of prior UK residency. Applying from abroad
 * cannot succeed, so these are excluded outright rather than downranked.
 */
const NEEDS_CLEARANCE =
  /\b(sc|dv|ctc|bpss|nppv)\b[^.]{0,40}\b(clear|cleared|clearance|vetting)\b|\b(security clearance|developed vetting|counter.?terrorism check|must be sc|must hold dv|uk eyes only|sole uk national|british citizen)\b/i;

export function preScore(job: Job, profile: Profile): { value: number; notes: string[] } {
  const notes: string[] = [];
  let score = 30;

  const title = job.title.toLowerCase();
  const desc = job.description.toLowerCase();

  // Title overlap against your target roles — the strongest cheap signal.
  const targets = (profile.targetTitles.length ? profile.targetTitles : ["it support", "infrastructure", "devops"]).map((t) => t.toLowerCase());
  const titleHit = targets.some((t) => {
    const words = tokenize(t);
    const matched = words.filter((w) => title.includes(w)).length;
    return matched >= Math.max(1, Math.ceil(words.length * 0.6));
  });
  if (titleHit) {
    score += 22;
    notes.push("Title matches a target role");
  } else {
    score -= 8;
  }

  // Skill overlap.
  const skills = profile.skills.map((s) => s.toLowerCase()).filter(Boolean);
  if (skills.length) {
    const present = skills.filter((s) => desc.includes(s) || title.includes(s));
    const ratio = present.length / skills.length;
    score += clamp(Math.round(ratio * 30), 0, 30);
    if (present.length) {
      notes.push(`${present.length} of your skills named in the ad`);
    }
  }

  // Seniority sanity.
  if (SENIORITY_TOO_LOW.test(job.title)) {
    score -= 30;
    notes.push("Entry-level title, well below your experience");
  }
  // The company name is often the only tell — "Newto Training" advertising a
  // "Junior Cyber Security Analyst" is selling a course, not hiring.
  if (TRAINING_SCAM.test(`${job.company} ${job.title} ${desc.slice(0, 2500)}`)) {
    score -= 45;
    notes.push("Looks like a training course being advertised as a job");
  }

  // "Junior" is a fine title for someone two years in and the wrong one for
  // someone with a decade, so this depends on the profile rather than the ad.
  if (/\bjunior\b/i.test(job.title) && profile.yearsExperience >= 5) {
    score -= 26;
    notes.push("Junior title, well below your experience");
  }
  if (SENIORITY_TOO_HIGH.test(job.title) && profile.yearsExperience < 10) {
    score -= 18;
    notes.push("Leadership title above your stated experience");
  }

  // Location / remote preference.
  if (job.remote && profile.remoteOk) {
    score += 6;
  } else if (!job.remote && !profile.onsiteOk) {
    score -= 20;
    notes.push("On-site but you marked on-site as not acceptable");
  }

  // Salary floor.
  const salary = job.salaryMax ?? job.salaryMin;
  if (profile.minSalary > 0 && salary != null && job.currency === profile.currency) {
    if (salary < profile.minSalary * 0.8) {
      score -= 18;
      notes.push("Salary well below your minimum");
    } else if (salary >= profile.minSalary) {
      score += 6;
    }
  }

  // Freshness — a three-week-old ad is usually already shortlisted.
  if (job.postedAt) {
    const days = (Date.now() - job.postedAt.getTime()) / 86_400_000;
    if (days <= 3) score += 8;
    else if (days <= 10) score += 3;
    else if (days > 30) score -= 10;
  }

  // Direct ATS postings convert far better than aggregator reposts.
  if (job.atsType) score += 6;

  return { value: clamp(score, 0, 100), notes };
}

/* ───────────────────────── Visa assessment ───────────────────────── */

export function assessVisa(job: Job, profile: Profile, sponsor: SponsorHit): VisaVerdict & {
  sponsorStatus: "licensed" | "likely" | "unknown" | "not_required";
  sponsorMatchedName: string | null;
  sponsorRoutes: string[] | null;
} {
  if (!profile.needsSponsorship) {
    return {
      possible: true, confidence: 1, note: "You hold the right to work.", penalty: 0,
      sponsorStatus: "not_required", sponsorMatchedName: null, sponsorRoutes: null,
    };
  }

  const descLower = job.description.toLowerCase();
  const country = job.country.toLowerCase();

  if (NEEDS_CLEARANCE.test(`${job.title} ${job.description}`)) {
    return {
      possible: false,
      confidence: 0.85,
      note: "Requires UK security clearance (SC/DV/CTC), which needs years of UK residency.",
      penalty: 100,
      sponsorStatus: "unknown", sponsorMatchedName: null, sponsorRoutes: null,
    };
  }

  if (country === "gb" || (!country && /united kingdom|uk|london|england/i.test(job.location))) {
    const verdict = assessUk({
      hasSponsorLicence: Boolean(sponsor),
      sponsorNameMatched: sponsor?.name ?? null,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      currency: job.currency,
      descriptionLower: descLower,
      isNewEntrant: profile.yearsExperience < 3,
    });
    // An agency advertising a role tells us nothing about the end employer,
    // so its own licence must not be read as a green light.
    const agency = looksLikeAgency(job.company);
    return {
      ...verdict,
      note: agency
        ? `Advertised by a recruitment agency — the hiring employer is unnamed, so sponsorship cannot be confirmed. ${verdict.note}`
        : verdict.note,
      penalty: agency ? Math.max(verdict.penalty, 12) : verdict.penalty,
      sponsorStatus: !sponsor || agency ? (sponsor ? "likely" : "unknown") : sponsor.match === "exact" ? "licensed" : "likely",
      sponsorMatchedName: sponsor?.name ?? null,
      sponsorRoutes: sponsor?.routes ?? null,
    };
  }

  if (country) {
    const verdict = assessEu({
      countryCode: country,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      currency: job.currency,
      descriptionLower: descLower,
      isItRole: looksLikeItRole(job.title),
    });
    return {
      ...verdict,
      sponsorStatus: "unknown",
      sponsorMatchedName: null,
      sponsorRoutes: null,
    };
  }

  return {
    possible: true, confidence: 0.2,
    note: "Country unknown — check where this role is based before applying.",
    penalty: 4,
    sponsorStatus: "unknown", sponsorMatchedName: null, sponsorRoutes: null,
  };
}

/* ───────────────────────── Stage 2: model scoring ───────────────────── */

export type LlmScore = {
  fit_score: number;
  reasons: string[];
  concerns: string[];
  worth_applying: boolean;
  requirements_met: number;
  requirements_total: number;
};

const SCORE_SCHEMA = {
  type: "object",
  properties: {
    fit_score: {
      // strict mode rejects minimum/maximum, so the range lives in the
      // description and clamp() enforces it on the way in.
      type: "integer",
      description: "0-100. How well this candidate matches THIS specific job. Be strict: 80+ means a recruiter would shortlist them.",
    },
    requirements_met: { type: "integer", description: "Count of the job's stated must-haves the candidate clearly evidences." },
    requirements_total: { type: "integer", description: "Count of stated must-haves in the ad." },
    reasons: {
      type: "array", maxItems: 4, items: { type: "string" },
      description: "Concrete overlaps, each naming something from BOTH the CV and the ad.",
    },
    concerns: {
      type: "array", maxItems: 4, items: { type: "string" },
      description: "Real gaps a recruiter would notice. Empty only if there genuinely are none.",
    },
    worth_applying: { type: "boolean", description: "Would a career coach tell this person to spend 20 minutes on this application?" },
  },
  required: ["fit_score", "requirements_met", "requirements_total", "reasons", "concerns", "worth_applying"],
  additionalProperties: false,
} as const;

const SCORER_SYSTEM = `You screen job adverts for one specific candidate.

You are strict and honest. Inflated scores waste the candidate's limited applications and damage their reputation with employers, so err downward when evidence is thin.

Rules:
- Score ONLY on evidence present in the CV. Never assume unstated skills.
- A job needing 5 years of Kubernetes when the CV shows none is a low score even if the title matches.
- Title similarity alone is weak evidence. Requirements overlap is strong evidence.
- Recruiters skim: if the CV would not survive a 20-second skim against this ad, score below 50.
- Visa eligibility is assessed separately. Ignore it here.`;

export async function scoreWithLlm(job: Job, profile: Profile): Promise<LlmScore> {
  const cv = profile.cvText?.trim()
    ? truncate(profile.cvText, 9000)
    : [
        profile.headline, profile.summary,
        `Skills: ${profile.skills.join(", ")}`,
        `Experience: ${profile.yearsExperience} years`,
      ].filter(Boolean).join("\n");

  // The rules and the CV are identical for every job in a run, so they sit in
  // the cached system prefix. Only the advert varies per call.
  const system = [
    { text: SCORER_SYSTEM },
    { text: `<candidate_cv>\n${cv}\n</candidate_cv>`, cache: true },
  ];

  const prompt = `<job>
Title: ${job.title}
Company: ${job.company}
Location: ${job.location} (${job.country || "unknown country"})${job.remote ? " — remote" : ""}
Salary: ${job.salaryMin || job.salaryMax ? `${job.currency ?? ""} ${job.salaryMin ?? "?"}–${job.salaryMax ?? "?"}` : "not stated"}

${truncate(job.description, 7000)}
</job>

Score the candidate described in the system prompt against this job.`;

  return structured<LlmScore>({
    system,
    prompt,
    toolName: "record_score",
    toolDescription: "Record the fit assessment for this candidate and job.",
    schema: SCORE_SCHEMA as unknown as Record<string, unknown>,
    // Scoring runs across every job found, so it stays on the cheap end.
    maxTokens: 8000,
    effort: "low",
  });
}

/* ───────────────────────────── Orchestration ─────────────────────────── */

export type ScoreSummary = {
  considered: number;
  scored: number;
  skippedEarly: number;
  keptAboveThreshold: number;
  visaBlocked: number;
  errors: number;
};

export async function runScoring(limit = MAX_LLM_JOBS_PER_RUN): Promise<ScoreSummary> {
  const profile = await getProfile();
  const settings = await getSettings();

  // Rank the WHOLE backlog on the free first-pass score before spending a model
  // call on anything. Taking the most recent N instead would mean the best job
  // in the database never gets looked at simply because 200 others arrived after
  // it — which is exactly what happened before this was fixed.
  //
  // Paged, with a truncated description, so memory stays flat no matter how big
  // the backlog grows. Full rows are fetched only for the survivors.
  const PAGE = 400;
  const shortlist: Array<{ id: number; pre: number; notes: string[] }> = [];

  for (let offset = 0; ; offset += PAGE) {
    const page = await db
      .select({
        id: jobs.id, title: jobs.title, company: jobs.company,
        companyNorm: jobs.companyNorm, country: jobs.country,
        location: jobs.location, remote: jobs.remote,
        salaryMin: jobs.salaryMin, salaryMax: jobs.salaryMax,
        currency: jobs.currency, postedAt: jobs.postedAt,
        atsType: jobs.atsType, status: jobs.status,
        // preScore only does substring tests; the opening few KB carry the
        // requirements and cost a fraction of the full text to load.
        description: sql<string>`substring(${jobs.description} for 4000)`,
      })
      .from(jobs)
      .where(eq(jobs.status, "new"))
      .orderBy(asc(jobs.id))
      .limit(PAGE)
      .offset(offset);

    if (!page.length) break;

    for (const row of page) {
      const { value, notes } = preScore(row as unknown as Job, profile);
      shortlist.push({ id: row.id, pre: value, notes });
    }

    // Keep only what could still make the cut, plus headroom for the cheap
    // rejections we still want to record.
    shortlist.sort((a, b) => b.pre - a.pre);
    if (shortlist.length > limit * 8) shortlist.length = limit * 8;

    if (page.length < PAGE) break;
  }

  if (!shortlist.length) {
    return { considered: 0, scored: 0, skippedEarly: 0, keptAboveThreshold: 0, visaBlocked: 0, errors: 0 };
  }

  const ids = shortlist.map((s) => s.id);
  const rows = await db.select().from(jobs).where(inArray(jobs.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pending = shortlist
    .map((s) => byId.get(s.id))
    .filter((j): j is Job => Boolean(j));

  const summary: ScoreSummary = {
    considered: pending.length, scored: 0, skippedEarly: 0,
    keptAboveThreshold: 0, visaBlocked: 0, errors: 0,
  };
  if (!pending.length) return summary;

  const sponsorMap = await lookupSponsors(pending.map((j) => j.companyNorm));

  // Stage 1 — cheap filter.
  const survivors: Array<{ job: Job; pre: number; notes: string[] }> = [];
  const earlyRejects: Array<{ id: number; pre: number; reason: string }> = [];

  for (const job of pending) {
    const { value, notes } = preScore(job, profile);
    if (value < PRE_SCORE_FLOOR) {
      earlyRejects.push({ id: job.id, pre: value, reason: "Weak keyword match against your profile" });
    } else {
      survivors.push({ job, pre: value, notes });
    }
  }

  for (const r of earlyRejects) {
    await db.update(jobs)
      .set({ status: "skipped", preScore: r.pre, score: Math.round(r.pre), skipReason: r.reason })
      .where(eq(jobs.id, r.id));
  }
  summary.skippedEarly = earlyRejects.length;

  // Stage 2 — model scoring on the best survivors only.
  survivors.sort((a, b) => b.pre - a.pre);
  const toScore = survivors.slice(0, limit);
  const deferred = survivors.slice(limit);

  const useLlm = llmAvailable();

  await mapLimit(toScore, 4, async ({ job, pre, notes }) => {
    const sponsor = sponsorMap.get(job.companyNorm) ?? null;
    const visa = assessVisa(job, profile, sponsor);

    let base = pre;
    let reasons = notes;
    let concerns: string[] = [];

    if (useLlm) {
      try {
        const llm = await scoreWithLlm(job, profile);
        llm.fit_score = clamp(Math.round(llm.fit_score), 0, 100);
        // Blend: the model judges fit, the heuristic guards against model drift.
        base = Math.round(llm.fit_score * 0.75 + pre * 0.25);
        reasons = llm.reasons.length ? llm.reasons : notes;
        concerns = llm.concerns;
        if (!llm.worth_applying) base = Math.min(base, 44);
        if (llm.requirements_total > 0) {
          const ratio = llm.requirements_met / llm.requirements_total;
          if (ratio < 0.4) base = Math.min(base, 52);
        }
      } catch (err) {
        summary.errors++;
        concerns = ["Automatic scoring failed; this is the keyword score only"];
        console.warn(`[score] job ${job.id} LLM scoring failed:`, (err as Error).message);
      }
    }

    const final = clamp(Math.round(base - visa.penalty), 0, 100);
    const blockedByVisa = !visa.possible;
    if (blockedByVisa) summary.visaBlocked++;

    const keep = final >= settings.keepThreshold && !blockedByVisa;
    if (keep) summary.keptAboveThreshold++;
    summary.scored++;

    await db.update(jobs).set({
      preScore: pre,
      score: final,
      scoreReasons: reasons.slice(0, 4),
      scoreConcerns: concerns.slice(0, 4),
      sponsorStatus: visa.sponsorStatus,
      sponsorMatchedName: visa.sponsorMatchedName,
      sponsorRoutes: visa.sponsorRoutes,
      blueCardOk: job.country !== "gb" ? visa.possible : null,
      visaNote: visa.note,
      status: keep ? "scored" : "skipped",
      skipReason: keep
        ? null
        : blockedByVisa
          ? `Visa: ${visa.note}`
          : `Scored ${final}, below your keep threshold of ${settings.keepThreshold}`,
    }).where(eq(jobs.id, job.id));
  });

  if (deferred.length) {
    await logEvent("score", `${deferred.length} jobs deferred to the next run (per-run cap)`, {
      level: "info",
    });
  }

  await logEvent("score", `Scored ${summary.scored}, kept ${summary.keptAboveThreshold}`, {
    meta: summary as unknown as Record<string, unknown>,
  });

  return summary;
}

/** Re-score a single job on demand (used by the "rescore" button). */
export async function rescoreJob(jobId: number): Promise<Job | null> {
  await db.update(jobs).set({ status: "new", skipReason: null }).where(eq(jobs.id, jobId));
  await runScoring(1);
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  return row ?? null;
}

export async function resetSkipped(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await db.update(jobs)
    .set({ status: "new", skipReason: null })
    .where(and(inArray(jobs.id, ids), eq(jobs.status, "skipped")));
}
