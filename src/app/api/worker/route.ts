import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, applications, jobs, getProfile, logEvent } from "@/db";
import { checkCronAuth } from "@/lib/auth";
import { pendingWorkerQueue } from "@/pipeline/apply";
import { notify } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The bridge to the local browser worker.
 *
 * Vercel cannot run a headless browser, so form-filling happens on your own
 * machine. The worker pulls this queue, drives the ATS form, and posts results
 * back here. Same CRON_SECRET guards both directions.
 */

export async function GET(req: Request) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [queue, profile] = await Promise.all([pendingWorkerQueue(25), getProfile()]);

  return NextResponse.json({
    profile: {
      fullName: profile.fullName,
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      linkedin: profile.linkedin,
      github: profile.github,
      website: profile.website,
      cvFileName: profile.cvFileName,
      cvBase64: profile.cvBase64,
      needsSponsorship: profile.needsSponsorship,
      yearsExperience: profile.yearsExperience,
    },
    queue: queue.map(({ application, job }) => ({
      applicationId: application.id,
      jobId: job.id,
      title: job.title,
      company: job.company,
      url: job.applyUrl || job.url,
      atsType: job.atsType,
      score: job.score,
      subject: application.subject,
      coverLetter: application.coverLetter,
    })),
  });
}

type WorkerReport = {
  applicationId: number;
  outcome: "submitted" | "failed" | "needs_human";
  error?: string;
  note?: string;
};

export async function POST(req: Request) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let report: WorkerReport;
  try {
    report = (await req.json()) as WorkerReport;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!report?.applicationId || !report.outcome) {
    return NextResponse.json({ error: "applicationId and outcome are required" }, { status: 400 });
  }

  const [application] = await db
    .select()
    .from(applications)
    .where(eq(applications.id, report.applicationId));

  if (!application) {
    return NextResponse.json({ error: "unknown application" }, { status: 404 });
  }

  const [job] = await db.select().from(jobs).where(eq(jobs.id, application.jobId));

  if (report.outcome === "submitted") {
    await db.update(applications).set({
      status: "sent", sentAt: new Date(), error: null, updatedAt: new Date(),
    }).where(eq(applications.id, application.id));
    await db.update(jobs).set({ status: "applied" }).where(eq(jobs.id, application.jobId));

    await logEvent("worker", `Submitted "${job?.title}" at ${job?.company}`, {
      meta: { applicationId: application.id, note: report.note },
    });
    await notify({
      title: `Applied — ${job?.company ?? "unknown"}`,
      body: `${job?.title ?? ""}\nSubmitted by the browser worker.`,
      priority: "low",
    });
  } else if (report.outcome === "needs_human") {
    await db.update(applications).set({
      status: "queued",
      channel: "manual",
      error: report.note ?? "Form needs a human — likely a custom question or a login wall",
      updatedAt: new Date(),
    }).where(eq(applications.id, application.id));

    await logEvent("worker", `Needs you: "${job?.title}" at ${job?.company}`, {
      level: "warn", meta: { applicationId: application.id, note: report.note },
    });
  } else {
    await db.update(applications).set({
      status: "failed",
      error: report.error ?? "Worker failed",
      attempts: application.attempts + 1,
      updatedAt: new Date(),
    }).where(eq(applications.id, application.id));

    await logEvent("worker", `Worker failed on "${job?.title}"`, {
      level: "error", meta: { applicationId: application.id, error: report.error },
    });
  }

  return NextResponse.json({ ok: true });
}
