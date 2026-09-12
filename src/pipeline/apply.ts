import { and, eq, gte, desc, isNull, sql, inArray } from "drizzle-orm";
import {
  db, jobs, applications, getProfile, getSettings, logEvent,
  type Job, type Profile, type ApplyChannel,
} from "@/db";
import { sendMail, mailConfigured } from "@/lib/mail";
import { coverLetterPdf } from "@/lib/pdf";
import { notify } from "@/lib/notify";
import { startOfTodayUtc, truncate } from "@/lib/utils";
import { generateCoverLetter, composeEmailBody } from "./generate";
import { applyPathReachable } from "./resolve";

/** Per-invocation ceiling, independent of the daily cap, to fit the time limit. */
const MAX_PER_RUN = 6;

export type ApplySummary = {
  eligible: number;
  sent: number;
  queuedForWorker: number;
  skipped: number;
  failed: number;
  capReached: boolean;
  reason?: string;
};

async function sentToday(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(applications)
    .where(and(gte(applications.sentAt, startOfTodayUtc()), eq(applications.status, "sent")));
  return row?.n ?? 0;
}

/** Decides how an application can physically be delivered. */
export function routeFor(job: Job): { channel: ApplyChannel; target?: string } {
  if (job.contactEmail && mailConfigured()) {
    return { channel: "email", target: job.contactEmail };
  }
  // A worker sent at a geo-blocked page only ever sees the regional notice, so
  // it goes to the manual queue with an honest reason instead.
  if (!applyPathReachable(job.source) && !job.applyUrl) {
    return { channel: "manual", target: job.url };
  }
  // Everything else needs a form filled in a browser. The local worker does
  // that; until it runs, the job sits in the queue with its letter ready.
  return { channel: "worker", target: job.applyUrl ?? job.url };
}

export type ApplyResult = {
  ok: boolean;
  applicationId?: number;
  channel: ApplyChannel;
  status: "sent" | "queued" | "failed";
  error?: string;
};

/**
 * Builds and delivers one application. Safe to call directly from the UI for a
 * single job, and used in a loop by the cron run.
 */
export async function applyToJob(
  job: Job,
  profile: Profile,
  opts: { autonomous: boolean },
): Promise<ApplyResult> {
  const route = routeFor(job);

  const [existing] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.jobId, job.id))
    .limit(1);

  if (existing) {
    return { ok: false, channel: route.channel, status: "failed", error: "Already applied to this job" };
  }

  let letter: { subject: string; body: string; note: string };
  try {
    letter = await generateCoverLetter(job, profile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent("apply", `Cover letter failed for "${job.title}" at ${job.company}`, {
      level: "error", meta: { jobId: job.id, error: message },
    });
    return { ok: false, channel: route.channel, status: "failed", error: message };
  }

  const [application] = await db.insert(applications).values({
    jobId: job.id,
    status: "queued",
    channel: route.channel,
    autonomous: opts.autonomous,
    subject: letter.subject,
    coverLetter: letter.body,
    toEmail: route.channel === "email" ? route.target : null,
    attempts: 1,
    // Nudge yourself if nothing has come back in a fortnight.
    followUpAt: new Date(Date.now() + 14 * 86_400_000),
  }).returning();

  if (route.channel !== "email") {
    await db.update(jobs).set({ status: "queued" }).where(eq(jobs.id, job.id));
    return { ok: true, applicationId: application.id, channel: route.channel, status: "queued" };
  }

  // ── Email delivery ────────────────────────────────────────────────
  try {
    const attachments = [];

    if (profile.cvBase64) {
      attachments.push({
        filename: profile.cvFileName || "CV.pdf",
        content: Buffer.from(profile.cvBase64, "base64"),
        contentType: "application/pdf",
      });
    }

    attachments.push({
      filename: `Cover Letter - ${sanitizeFilename(profile.fullName)} - ${sanitizeFilename(job.company)}.pdf`,
      content: await coverLetterPdf({
        body: letter.body,
        fullName: profile.fullName,
        email: profile.email,
        phone: profile.phone,
        location: profile.location,
        links: [profile.linkedin, profile.github, profile.website].filter(Boolean),
        jobTitle: job.title,
        company: job.company,
      }),
      contentType: "application/pdf",
    });

    const { messageId } = await sendMail({
      to: route.target!,
      subject: letter.subject,
      text: composeEmailBody(letter.body, profile),
      attachments,
    });

    await db.update(applications).set({
      status: "sent", sentAt: new Date(), messageId, updatedAt: new Date(),
    }).where(eq(applications.id, application.id));

    await db.update(jobs).set({ status: "applied" }).where(eq(jobs.id, job.id));

    await logEvent("apply", `Applied to "${job.title}" at ${job.company}`, {
      meta: { jobId: job.id, applicationId: application.id, to: route.target, autonomous: opts.autonomous },
    });

    return { ok: true, applicationId: application.id, channel: "email", status: "sent" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(applications).set({
      status: "failed", error: truncate(message, 500), updatedAt: new Date(),
    }).where(eq(applications.id, application.id));
    await db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, job.id));

    await logEvent("apply", `Send failed for "${job.title}" at ${job.company}`, {
      level: "error", meta: { jobId: job.id, error: message },
    });
    return { ok: false, applicationId: application.id, channel: "email", status: "failed", error: message };
  }
}

function sanitizeFilename(s: string): string {
  return (s || "Application").replace(/[^A-Za-z0-9 _-]+/g, "").trim().slice(0, 60) || "Application";
}

/**
 * The autonomous pass. Picks the highest-scoring jobs that clear your
 * threshold and the visa gate, and applies to them.
 */
export async function runAutoApply(): Promise<ApplySummary> {
  const settings = await getSettings();
  const profile = await getProfile();

  const base: ApplySummary = {
    eligible: 0, sent: 0, queuedForWorker: 0, skipped: 0, failed: 0, capReached: false,
  };

  if (settings.paused) return { ...base, reason: "Automator is paused" };
  if (!settings.autoApply) return { ...base, reason: "Auto-apply is switched off" };
  if (!profile.cvText?.trim()) return { ...base, reason: "No CV text on your profile yet" };

  const already = await sentToday();
  const remaining = settings.dailyCap - already;
  if (remaining <= 0) {
    return { ...base, capReached: true, reason: `Daily cap of ${settings.dailyCap} already reached` };
  }

  // Jobs that are scored, above threshold, and not yet applied to.
  const candidates = await db
    .select()
    .from(jobs)
    .leftJoin(applications, eq(applications.jobId, jobs.id))
    .where(and(
      eq(jobs.status, "scored"),
      gte(jobs.score, settings.autoApplyThreshold),
      isNull(applications.id),
    ))
    .orderBy(desc(jobs.score))
    .limit(Math.min(remaining, MAX_PER_RUN) * 3);

  const queue: Job[] = [];
  for (const row of candidates) {
    const job = row.jobs;

    // The visa gate. This is the whole point of the sponsor register.
    if (settings.requireSponsor && profile.needsSponsorship && job.country === "gb") {
      if (job.sponsorStatus !== "licensed") {
        base.skipped++;
        await db.update(jobs).set({
          status: "skipped",
          skipReason: "Not on the UK sponsor register — cannot sponsor you",
        }).where(eq(jobs.id, job.id));
        continue;
      }
    }

    queue.push(job);
    if (queue.length >= Math.min(remaining, MAX_PER_RUN)) break;
  }

  base.eligible = queue.length;

  for (const job of queue) {
    const result = await applyToJob(job, profile, { autonomous: true });
    if (!result.ok) base.failed++;
    else if (result.status === "sent") base.sent++;
    else base.queuedForWorker++;
  }

  await db.execute(sql`update settings set last_apply_at = now() where id = 1`);

  if (base.sent || base.queuedForWorker) {
    await notify({
      title: `${base.sent + base.queuedForWorker} applications prepared`,
      body: [
        base.sent ? `${base.sent} emailed directly to the employer` : null,
        base.queuedForWorker ? `${base.queuedForWorker} waiting for the browser worker` : null,
        base.skipped ? `${base.skipped} skipped — employer cannot sponsor` : null,
      ].filter(Boolean).join("\n"),
      priority: "normal",
    });
  }

  return base;
}

/** Jobs whose letters are written and which need a form filled in a browser. */
export async function pendingWorkerQueue(limit = 25) {
  const rows = await db
    .select()
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(and(eq(applications.status, "queued"), inArray(applications.channel, ["worker", "manual"])))
    .orderBy(desc(jobs.score))
    .limit(limit);

  return rows.map((r) => ({ application: r.applications, job: r.jobs }));
}
