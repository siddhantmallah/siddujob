import Link from "next/link";
import { requireAuth } from "@/lib/auth";
import { getProfile, getSettings } from "@/db";
import { Shell } from "@/components/Nav";
import { ActionButton } from "@/components/Forms";
import {
  dashboardStats, recentReplies, recentEvents, listJobs,
} from "@/lib/queries";
import { sponsorRegisterReady } from "@/pipeline/sponsors";
import {
  runDiscoveryNow, checkInboxNow, syncSponsorsNow, togglePause, applyNow,
} from "@/app/actions";
import { ScorePill, VisaPill } from "@/components/JobBits";

export const dynamic = "force-dynamic";

function relative(date: Date | null | undefined): string {
  if (!date) return "never";
  const mins = Math.round((Date.now() - date.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "good" | "warn" }) {
  return (
    <div className="panel p-4">
      <div
        className="text-2xl font-bold tabular-nums"
        style={{ color: tone === "good" ? "var(--good)" : tone === "warn" ? "var(--warn)" : "var(--ink)" }}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted)" }}>{label}</div>
    </div>
  );
}

export default async function Dashboard() {
  await requireAuth();

  const [profile, settings, stats, replies, events, top, sponsorState] = await Promise.all([
    getProfile(),
    getSettings(),
    dashboardStats(),
    recentReplies(6),
    recentEvents(12),
    listJobs("top", 6),
    sponsorRegisterReady(),
  ]);

  const setupIssues: Array<{ text: string; href: string }> = [];
  if (!profile.cvText?.trim()) setupIssues.push({ text: "Add your CV text — nothing can be scored or written without it", href: "/profile" });
  if (!profile.cvBase64) setupIssues.push({ text: "Upload your CV PDF so it can be attached to applications", href: "/profile" });
  if (!profile.targetTitles.length) setupIssues.push({ text: "Set the job titles you want", href: "/profile" });
  if (!sponsorState.ready) setupIssues.push({ text: "Sync the UK sponsor register — this is what filters out employers who cannot hire you", href: "/settings" });
  if (!settings.autoApply) setupIssues.push({ text: "Auto-apply is switched off", href: "/settings" });

  return (
    <Shell current="/" badge={stats.interviews || undefined}>
      {/* Status bar */}
      <div className="panel mb-5 flex flex-wrap items-center gap-3 px-4 py-3">
        <span
          className="pill"
          style={{
            background: settings.paused ? "var(--bad-soft)" : settings.autoApply ? "var(--good-soft)" : "var(--warn-soft)",
            color: settings.paused ? "var(--bad)" : settings.autoApply ? "var(--good)" : "var(--warn)",
          }}
        >
          {settings.paused ? "Paused" : settings.autoApply ? "Auto-apply on" : "Auto-apply off"}
        </span>

        <span className="text-[12px]" style={{ color: "var(--muted)" }}>
          Threshold {settings.autoApplyThreshold} · {stats.appsToday}/{settings.dailyCap} sent today
        </span>

        <span className="text-[12px]" style={{ color: "var(--muted)" }}>
          Discovery {relative(settings.lastIngestAt)} · Inbox {relative(settings.lastInboxAt)}
        </span>

        <div className="ml-auto flex flex-wrap items-start gap-2">
          <ActionButton action={runDiscoveryNow} variant="primary">Find jobs now</ActionButton>
          <ActionButton action={checkInboxNow}>Check inbox</ActionButton>
          <form action={togglePause}>
            <button type="submit" className="btn">{settings.paused ? "Resume" : "Pause"}</button>
          </form>
        </div>
      </div>

      {setupIssues.length > 0 && (
        <div className="panel mb-5 p-4" style={{ borderColor: "var(--warn)" }}>
          <div className="mb-2 text-[13px] font-bold" style={{ color: "var(--warn)" }}>
            Finish setting up ({setupIssues.length})
          </div>
          <ul className="space-y-1.5">
            {setupIssues.map((issue) => (
              <li key={issue.text} className="text-[13px]">
                <Link href={issue.href} className="underline decoration-dotted underline-offset-2">
                  {issue.text}
                </Link>
              </li>
            ))}
          </ul>
          {!sponsorState.ready && (
            <div className="mt-3">
              <ActionButton action={syncSponsorsNow} variant="primary">
                Sync sponsor register now
              </ActionButton>
            </div>
          )}
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Stat label="Jobs tracked" value={stats.jobsTotal} />
        <Stat label="Worth applying" value={stats.jobsWaiting} />
        <Stat label="Applications" value={stats.appsTotal} />
        <Stat label="Awaiting reply" value={stats.awaitingReply} />
        <Stat label="Interviews" value={stats.interviews} tone={stats.interviews ? "good" : undefined} />
        <Stat
          label="Reply rate"
          value={stats.replyRate === null ? "—" : `${stats.replyRate}%`}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-5">
          {/* Replies */}
          <section className="panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[13px] font-bold">Latest replies</h2>
              <Link href="/applications" className="text-[12px]" style={{ color: "var(--accent)" }}>
                All applications →
              </Link>
            </div>

            {replies.length === 0 ? (
              <p className="hint">
                Nothing yet. Replies are detected automatically from your Gmail and you get a
                Telegram alert the moment one lands.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {replies.map(({ reply, company, title }) => (
                  <li key={reply.id} className="border-t pt-2.5 first:border-0 first:pt-0" style={{ borderColor: "var(--border)" }}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`pill ${
                          reply.kind === "interview" || reply.kind === "offer"
                            ? "pill-good"
                            : reply.kind === "rejection"
                              ? "pill-bad"
                              : "pill-flat"
                        }`}
                      >
                        {reply.kind.replace("_", " ")}
                      </span>
                      <span className="text-[13px] font-semibold">{company ?? reply.fromName}</span>
                      <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                        {title ?? reply.subject}
                      </span>
                      <span className="ml-auto text-[11px]" style={{ color: "var(--muted)" }}>
                        {relative(reply.receivedAt)}
                      </span>
                    </div>
                    {reply.summary && (
                      <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
                        {reply.summary}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Top jobs */}
          <section className="panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[13px] font-bold">Best matches waiting</h2>
              <Link href="/jobs" className="text-[12px]" style={{ color: "var(--accent)" }}>
                All jobs →
              </Link>
            </div>

            {top.length === 0 ? (
              <p className="hint">
                No scored jobs yet. Hit “Find jobs now” once your profile is filled in.
              </p>
            ) : (
              <ul className="space-y-3">
                {top.map(({ job }) => (
                  <li key={job.id} className="border-t pt-3 first:border-0 first:pt-0" style={{ borderColor: "var(--border)" }}>
                    <div className="flex flex-wrap items-center gap-2">
                      <ScorePill score={job.score} />
                      <a
                        href={job.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[13.5px] font-semibold hover:underline"
                      >
                        {job.title}
                      </a>
                      <span className="text-[12.5px]" style={{ color: "var(--muted)" }}>
                        {job.company} · {job.location || job.country.toUpperCase()}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <VisaPill job={job} />
                      <div className="ml-auto">
                        <ActionButton action={applyNow.bind(null, job.id)} variant="primary" compact>
                          Apply
                        </ActionButton>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Activity */}
        <section className="panel h-fit p-4">
          <h2 className="mb-3 text-[13px] font-bold">Activity</h2>
          {events.length === 0 ? (
            <p className="hint">Nothing has run yet.</p>
          ) : (
            <ul className="space-y-2">
              {events.map((event) => (
                <li key={event.id} className="flex gap-2 text-[12px]">
                  <span
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background:
                        event.level === "error" ? "var(--bad)"
                          : event.level === "warn" ? "var(--warn)"
                            : "var(--muted)",
                    }}
                  />
                  <span className="flex-1" style={{ color: "var(--ink)" }}>{event.message}</span>
                  <span className="shrink-0" style={{ color: "var(--muted)" }}>
                    {relative(event.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 border-t pt-3 text-[11.5px]" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
            Sponsor register:{" "}
            {sponsorState.ready
              ? `${sponsorState.rowCount.toLocaleString()} employers, synced ${relative(sponsorState.lastSyncAt)}`
              : "not synced"}
          </div>
        </section>
      </div>
    </Shell>
  );
}
