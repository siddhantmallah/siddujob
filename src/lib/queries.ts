import { and, desc, eq, gte, inArray, isNull, sql, or } from "drizzle-orm";
import { db, jobs, applications, replies, events } from "@/db";
import { startOfTodayUtc } from "./utils";

export type DashboardStats = {
  jobsTotal: number;
  jobsWaiting: number;
  appsTotal: number;
  appsToday: number;
  appsThisWeek: number;
  queuedForWorker: number;
  interviews: number;
  rejections: number;
  awaitingReply: number;
  replyRate: number | null;
};

export async function dashboardStats(): Promise<DashboardStats> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const [counts] = await db
    .select({
      jobsTotal: sql<number>`count(*)::int`,
      jobsWaiting: sql<number>`count(*) filter (where ${jobs.status} = 'scored')::int`,
    })
    .from(jobs);

  const [appCounts] = await db
    .select({
      appsTotal: sql<number>`count(*) filter (where ${applications.status} <> 'queued')::int`,
      appsToday: sql<number>`count(*) filter (where ${applications.sentAt} >= ${startOfTodayUtc()})::int`,
      appsThisWeek: sql<number>`count(*) filter (where ${applications.sentAt} >= ${weekAgo})::int`,
      queuedForWorker: sql<number>`count(*) filter (where ${applications.status} = 'queued')::int`,
      interviews: sql<number>`count(*) filter (where ${applications.status} in ('interview','offer'))::int`,
      rejections: sql<number>`count(*) filter (where ${applications.status} = 'rejected')::int`,
      awaitingReply: sql<number>`count(*) filter (where ${applications.status} = 'sent')::int`,
      anyReply: sql<number>`count(*) filter (where ${applications.replyCount} > 0)::int`,
      sent: sql<number>`count(*) filter (where ${applications.sentAt} is not null)::int`,
    })
    .from(applications);

  return {
    jobsTotal: counts?.jobsTotal ?? 0,
    jobsWaiting: counts?.jobsWaiting ?? 0,
    appsTotal: appCounts?.appsTotal ?? 0,
    appsToday: appCounts?.appsToday ?? 0,
    appsThisWeek: appCounts?.appsThisWeek ?? 0,
    queuedForWorker: appCounts?.queuedForWorker ?? 0,
    interviews: appCounts?.interviews ?? 0,
    rejections: appCounts?.rejections ?? 0,
    awaitingReply: appCounts?.awaitingReply ?? 0,
    replyRate:
      appCounts && appCounts.sent > 0
        ? Math.round((appCounts.anyReply / appCounts.sent) * 100)
        : null,
  };
}

export async function recentReplies(limit = 8) {
  return db
    .select({
      reply: replies,
      company: jobs.company,
      title: jobs.title,
      url: jobs.url,
      applicationId: applications.id,
    })
    .from(replies)
    .leftJoin(applications, eq(replies.applicationId, applications.id))
    .leftJoin(jobs, eq(applications.jobId, jobs.id))
    .orderBy(desc(replies.receivedAt))
    .limit(limit);
}

export type JobFilter = "top" | "all" | "applied" | "skipped" | "blocked_visa";

export async function listJobs(filter: JobFilter, limit = 60) {
  const base = db
    .select({
      job: jobs,
      applicationId: applications.id,
      applicationStatus: applications.status,
    })
    .from(jobs)
    .leftJoin(applications, eq(applications.jobId, jobs.id));

  if (filter === "top") {
    return base
      .where(and(eq(jobs.status, "scored"), isNull(applications.id)))
      .orderBy(desc(jobs.score))
      .limit(limit);
  }
  if (filter === "applied") {
    return base
      .where(inArray(jobs.status, ["applied", "queued"]))
      .orderBy(desc(jobs.score))
      .limit(limit);
  }
  if (filter === "skipped") {
    return base.where(eq(jobs.status, "skipped")).orderBy(desc(jobs.score)).limit(limit);
  }
  if (filter === "blocked_visa") {
    return base
      .where(and(eq(jobs.country, "gb"), eq(jobs.sponsorStatus, "unknown")))
      .orderBy(desc(jobs.score))
      .limit(limit);
  }
  return base.orderBy(desc(jobs.createdAt)).limit(limit);
}

export async function listApplications(limit = 100) {
  return db
    .select({ application: applications, job: jobs })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .orderBy(desc(applications.updatedAt))
    .limit(limit);
}

export async function repliesForApplications(applicationIds: number[]) {
  if (!applicationIds.length) return [];
  return db
    .select()
    .from(replies)
    .where(inArray(replies.applicationId, applicationIds))
    .orderBy(desc(replies.receivedAt));
}

export async function recentEvents(limit = 20) {
  return db.select().from(events).orderBy(desc(events.createdAt)).limit(limit);
}

/** Applications sent over two weeks ago with no reply — worth a nudge. */
export async function needsFollowUp(limit = 10) {
  return db
    .select({ application: applications, job: jobs })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(and(
      eq(applications.status, "sent"),
      eq(applications.replyCount, 0),
      or(isNull(applications.followUpAt), gte(sql`now()`, applications.followUpAt)),
    ))
    .orderBy(desc(jobs.score))
    .limit(limit);
}
