import { NextResponse, after } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db, settings as settingsTable, getSettings, logEvent } from "@/db";
import { isAuthed } from "@/lib/auth";
import { runDiscovery, runApplyPass, runInboxPass } from "@/pipeline/run";
import { syncSponsorRegister } from "@/pipeline/sponsors";
import { runScoring } from "@/pipeline/score";
import { truncate } from "@/lib/utils";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Starts long work WITHOUT holding the browser.
 *
 * These used to be Server Actions. Next.js runs Server Actions one at a time
 * and blocks router navigation while one is in flight, so a 114-second discovery
 * froze every button and tab in the app and then died at the function limit
 * anyway. Here the response returns immediately and the work continues in
 * after(), with progress readable from GET.
 */

const TASKS = {
  discover: { label: "Finding jobs", run: () => runDiscovery() },
  score: { label: "Scoring jobs", run: () => runScoring(20) },
  apply: { label: "Sending applications", run: () => runApplyPass() },
  inbox: { label: "Checking inbox", run: () => runInboxPass() },
  sponsors: { label: "Syncing sponsor register", run: () => syncSponsorRegister() },
} as const;

type TaskName = keyof typeof TASKS;

/** A run older than this is treated as dead — the function was killed mid-flight. */
const STALE_AFTER_MS = 5 * 60_000;

export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const current = await getSettings();

  const stale =
    current.runningSince && Date.now() - current.runningSince.getTime() > STALE_AFTER_MS;

  if (stale) {
    await db.update(settingsTable)
      .set({ runningTask: null, runningSince: null, lastRunSummary: "Timed out" })
      .where(eq(settingsTable.id, 1));
  }

  return NextResponse.json({
    running: stale ? null : current.runningTask,
    since: stale ? null : current.runningSince,
    lastSummary: current.lastRunSummary,
    lastIngestAt: current.lastIngestAt,
    lastInboxAt: current.lastInboxAt,
  });
}

export async function POST(req: Request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let task: TaskName;
  try {
    task = ((await req.json()) as { task?: TaskName }).task as TaskName;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!task || !(task in TASKS)) {
    return NextResponse.json({ error: "unknown task" }, { status: 400 });
  }

  const current = await getSettings();
  const busy =
    current.runningTask &&
    current.runningSince &&
    Date.now() - current.runningSince.getTime() < STALE_AFTER_MS;

  if (busy) {
    return NextResponse.json(
      { started: false, running: current.runningTask, message: `${current.runningTask} is already running` },
      { status: 409 },
    );
  }

  const { label, run } = TASKS[task];

  await db.update(settingsTable)
    .set({ runningTask: label, runningSince: new Date(), lastRunSummary: null })
    .where(eq(settingsTable.id, 1));

  // Everything below happens after the response has been flushed to the browser.
  after(async () => {
    let summary: string;
    try {
      const result = (await run()) as Record<string, unknown>;
      summary = describe(task, result);
    } catch (err) {
      summary = `Failed: ${truncate(err instanceof Error ? err.message : String(err), 200)}`;
      await logEvent("run", `${label} failed`, { level: "error", meta: { task } });
    }
    await db.update(settingsTable)
      .set({ runningTask: null, runningSince: null, lastRunSummary: summary })
      .where(eq(settingsTable.id, 1))
      .catch(() => {});
  });

  return NextResponse.json({ started: true, running: label });
}

/** Turns a pipeline result into one line a person can read at a glance. */
function describe(task: TaskName, result: Record<string, unknown>): string {
  const ingest = result.ingest as { inserted?: number; queries?: string[] } | undefined;
  const score = result.score as { keptAboveThreshold?: number; scored?: number } | undefined;
  const apply = result.apply as { sent?: number; queuedForWorker?: number; reason?: string } | undefined;
  const inbox = result.inbox as { newReplies?: number; interviews?: number } | undefined;

  switch (task) {
    case "discover":
      return [
        `${ingest?.inserted ?? 0} new jobs`,
        score ? `${score.scored ?? 0} scored, ${score.keptAboveThreshold ?? 0} worth applying to` : null,
        ingest?.queries?.length ? `searched: ${ingest.queries.join(", ")}` : null,
      ].filter(Boolean).join(" · ");
    case "score":
      return `${(result as { scored?: number }).scored ?? 0} scored, ${(result as { keptAboveThreshold?: number }).keptAboveThreshold ?? 0} kept`;
    case "apply":
      if (apply?.reason) return apply.reason;
      return `${apply?.sent ?? 0} emailed, ${apply?.queuedForWorker ?? 0} queued for the worker`;
    case "inbox":
      return inbox?.newReplies
        ? `${inbox.newReplies} new replies, ${inbox.interviews ?? 0} interviews`
        : "No new replies";
    case "sponsors":
      return (result as { ok?: boolean; rowCount?: number; error?: string }).ok
        ? `${((result as { rowCount?: number }).rowCount ?? 0).toLocaleString("en-GB")} licensed sponsors synced`
        : `Sync failed: ${(result as { error?: string }).error ?? "unknown"}`;
    default:
      return "Done";
  }
}

export async function DELETE() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await db.execute(sql`update settings set running_task = null, running_since = null where id = 1`);
  return NextResponse.json({ ok: true });
}
