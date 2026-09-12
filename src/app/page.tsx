import Link from "next/link";
import { requireAuth } from "@/lib/auth";
import { getProfile, getSettings } from "@/db";
import { Shell, PageHead, EmptyState } from "@/components/Nav";
import { RunBar } from "@/components/RunBar";
import { ActionButton } from "@/components/Forms";
import { dashboardStats, recentReplies, recentEvents, listJobs } from "@/lib/queries";
import { sponsorRegisterReady } from "@/pipeline/sponsors";
import { togglePause, applyNow } from "@/app/actions";
import { ScoreRing, VisaPill, placeLabel } from "@/components/JobBits";

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

function Stat({
  label, value, tone, hint,
}: { label: string; value: string | number; tone?: "good" | "warn" | "accent"; hint?: string }) {
  const colour =
    tone === "good" ? "var(--good)"
      : tone === "warn" ? "var(--warn)"
        : tone === "accent" ? "var(--accent)"
          : "var(--ink)";
  return (
    <div className="panel px-4 py-3.5" title={hint}>
      <div className="tnum text-[22px] font-bold leading-none" style={{ color: colour }}>
        {value}
      </div>
      <div className="mt-1.5 text-[11.5px] font-medium" style={{ color: "var(--muted)" }}>
        {label}
      </div>
    </div>
  );
}

export default async function Dashboard() {
  await requireAuth();

  const [profile, settings, stats, replies, events, top, sponsorState] = await Promise.all([
    getProfile(),
    getSettings(),
    dashboardStats(),
    recentReplies(5),
    recentEvents(10),
    listJobs("top", 5),
    sponsorRegisterReady(),
  ]);

  const setup: Array<{ text: string; href: string }> = [];
  if (!profile.cvText?.trim()) setup.push({ text: "Add your CV — nothing can be scored or written without it", href: "/profile" });
  if (!profile.cvBase64) setup.push({ text: "Upload your CV PDF so it can be attached to applications", href: "/profile" });
  if (!profile.targetTitles.length) setup.push({ text: "Set the job titles you want", href: "/profile" });
  if (!sponsorState.ready) setup.push({ text: "Sync the sponsor register — it is what filters out employers who cannot hire you", href: "/settings" });
  if (!settings.autoApply) setup.push({ text: "Auto-apply is switched off", href: "/settings" });

  const statusTone = settings.paused ? "pill-bad" : settings.autoApply ? "pill-good" : "pill-warn";
  const statusText = settings.paused ? "Paused" : settings.autoApply ? "Auto-apply on" : "Manual only";

  return (
    <Shell current="/" jobCount={stats.jobsWaiting || undefined} replyCount={stats.interviews || undefined}>
      <PageHead
        title="Dashboard"
        subtitle={`${stats.appsToday} of ${settings.dailyCap} applications sent today · discovery ${relative(settings.lastIngestAt)} · inbox ${relative(settings.lastInboxAt)}`}
      >
        <span className={`pill ${statusTone}`}>{statusText}</span>
        <form action={togglePause}>
          <button type="submit" className="btn btn-sm">
            {settings.paused ? "Resume" : "Pause"}
          </button>
        </form>
      </PageHead>

      <div className="panel mb-5 px-4 py-3">
        <RunBar initial={{ running: settings.runningTask, lastSummary: settings.lastRunSummary }} />
        <p className="hint">
          These run on the server — you can switch tabs while they work.
        </p>
      </div>

      {setup.length > 0 && (
        <div
          className="panel mb-5 p-4"
          style={{ borderColor: "color-mix(in srgb, var(--warn) 45%, var(--border))" }}
        >
          <div className="eyebrow mb-2" style={{ color: "var(--warn)" }}>
            Finish setting up · {setup.length}
          </div>
          <ul className="space-y-1.5">
            {setup.map((issue) => (
              <li key={issue.text} className="text-[13px]">
                <Link href={issue.href} className="underline decoration-dotted underline-offset-2">
                  {issue.text}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Jobs tracked" value={stats.jobsTotal.toLocaleString("en-GB")} />
        <Stat label="Worth applying" value={stats.jobsWaiting} tone={stats.jobsWaiting ? "accent" : undefined} />
        <Stat label="Applications" value={stats.appsTotal} />
        <Stat label="Awaiting reply" value={stats.awaitingReply} />
        <Stat label="Interviews" value={stats.interviews} tone={stats.interviews ? "good" : undefined} />
        <Stat
          label="Reply rate"
          value={stats.replyRate === null ? "—" : `${stats.replyRate}%`}
          hint="Share of sent applications that got any response"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
        <div className="space-y-5">
          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="eyebrow">Latest replies</h2>
              <Link href="/applications" className="text-[12px] font-medium" style={{ color: "var(--accent)" }}>
                All applications →
              </Link>
            </div>

            {replies.length === 0 ? (
              <EmptyState
                title="No replies yet"
                body="Replies are detected from your Gmail automatically. An interview invitation reaches your phone by Telegram the moment it lands."
              />
            ) : (
              <ul className="space-y-2">
                {replies.map(({ reply, company, title }) => (
                  <li key={reply.id} className="panel-row px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`pill ${
                          reply.kind === "interview" || reply.kind === "offer" ? "pill-good"
                            : reply.kind === "rejection" ? "pill-bad" : "pill-flat"
                        }`}
                      >
                        {reply.kind.replace("_", " ")}
                      </span>
                      <span className="text-[13.5px] font-semibold">{company ?? reply.fromName}</span>
                      <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                        {title ?? reply.subject}
                      </span>
                      <span className="ml-auto text-[11px]" style={{ color: "var(--faint)" }}>
                        {relative(reply.receivedAt)}
                      </span>
                    </div>
                    {reply.summary && (
                      <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                        {reply.summary}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="eyebrow">Best matches waiting</h2>
              <Link href="/jobs" className="text-[12px] font-medium" style={{ color: "var(--accent)" }}>
                All jobs →
              </Link>
            </div>

            {top.length === 0 ? (
              <EmptyState
                title="Nothing scored yet"
                body="Once your profile is filled in, hit Find jobs above. Discovery searches a rotating slice of your job titles each run."
              />
            ) : (
              <ul className="space-y-2">
                {top.map(({ job }) => (
                  <li key={job.id} className="panel-row flex items-start gap-3 px-4 py-3">
                    <ScoreRing score={job.score} />
                    <div className="min-w-0 flex-1">
                      <a
                        href={job.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[13.5px] font-semibold hover:underline"
                      >
                        {job.title}
                      </a>
                      <div className="mt-0.5 truncate text-[12px]" style={{ color: "var(--muted)" }}>
                        <span style={{ color: "var(--ink-2)" }}>{job.company}</span>
                        {" · "}{placeLabel(job)}
                      </div>
                      <div className="mt-1.5">
                        <VisaPill job={job} />
                      </div>
                    </div>
                    <ActionButton action={applyNow.bind(null, job.id)} variant="primary" compact>
                      Apply
                    </ActionButton>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="h-fit">
          <h2 className="eyebrow mb-2.5">Activity</h2>
          <div className="panel p-4">
            {events.length === 0 ? (
              <p className="hint">Nothing has run yet.</p>
            ) : (
              <ul className="space-y-2.5">
                {events.map((event) => (
                  <li key={event.id} className="flex gap-2.5 text-[12px]">
                    <span
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        background:
                          event.level === "error" ? "var(--bad)"
                            : event.level === "warn" ? "var(--warn)" : "var(--border-strong)",
                      }}
                    />
                    <span className="flex-1" style={{ color: "var(--ink-2)" }}>{event.message}</span>
                    <span className="shrink-0 tnum" style={{ color: "var(--faint)" }}>
                      {relative(event.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <hr className="divider my-3.5" />
            <p className="text-[11.5px]" style={{ color: "var(--muted)" }}>
              Sponsor register:{" "}
              {sponsorState.ready
                ? `${sponsorState.rowCount.toLocaleString("en-GB")} employers, ${relative(sponsorState.lastSyncAt)}`
                : "not synced"}
            </p>
          </div>
        </section>
      </div>
    </Shell>
  );
}
