import { db, logEvent } from "@/db";
import { sql } from "drizzle-orm";
import { runIngest, type IngestSummary } from "./ingest";
import { runScoring, type ScoreSummary } from "./score";
import { resolveApplyUrls, type ResolveSummary } from "./resolve";
import { runAutoApply, type ApplySummary } from "./apply";
import { runInboxCheck, type InboxSummary } from "./inbox";
import { sponsorRegisterReady, syncSponsorRegister } from "./sponsors";
import { notifyRunSummary } from "@/lib/notify";

export type FullRunSummary = {
  ingest?: IngestSummary;
  score?: ScoreSummary;
  resolve?: ResolveSummary;
  apply?: ApplySummary;
  inbox?: InboxSummary;
  sponsorSync?: { ok: boolean; rowCount: number; error?: string };
  ms: number;
};

/** Discover + score. Split from applying so the two can run on their own clocks. */
export async function runDiscovery(): Promise<FullRunSummary> {
  const started = Date.now();

  // The sponsor register underpins every UK decision — make sure it exists,
  // and refresh it when it goes stale.
  const state = await sponsorRegisterReady();
  const stale = state.lastSyncAt
    ? Date.now() - state.lastSyncAt.getTime() > 7 * 86_400_000
    : true;

  let sponsorSync: FullRunSummary["sponsorSync"];
  if (!state.ready || stale) {
    const result = await syncSponsorRegister();
    sponsorSync = { ok: result.ok, rowCount: result.rowCount, error: result.error };
  }

  const ingest = await runIngest();
  const score = await runScoring();
  // Give surviving jobs a link that works from here before any of them can be
  // queued against a page this location cannot open.
  const resolve = await resolveApplyUrls();

  await db.execute(sql`update settings set last_ingest_at = now() where id = 1`);

  return { ingest, score, resolve, sponsorSync, ms: Date.now() - started };
}

export async function runApplyPass(): Promise<FullRunSummary> {
  const started = Date.now();
  const apply = await runAutoApply();
  return { apply, ms: Date.now() - started };
}

export async function runInboxPass(): Promise<FullRunSummary> {
  const started = Date.now();
  const inbox = await runInboxCheck();
  return { inbox, ms: Date.now() - started };
}

/** Everything, in order. Used by the local CLI runner. */
export async function runEverything(): Promise<FullRunSummary> {
  const started = Date.now();
  const discovery = await runDiscovery();
  const apply = await runAutoApply();
  const inbox = await runInboxCheck();

  const summary: FullRunSummary = {
    ...discovery,
    apply,
    inbox,
    ms: Date.now() - started,
  };

  await notifyRunSummary({
    found: discovery.ingest?.inserted ?? 0,
    kept: discovery.score?.keptAboveThreshold ?? 0,
    applied: (apply.sent ?? 0) + (apply.queuedForWorker ?? 0),
    replies: inbox.newReplies ?? 0,
  });

  await logEvent("run", `Full pipeline finished in ${Math.round(summary.ms / 1000)}s`, {
    meta: summary as unknown as Record<string, unknown>,
  });

  return summary;
}
