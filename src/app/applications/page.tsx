import { requireAuth } from "@/lib/auth";
import { Shell, PageHead, EmptyState } from "@/components/Nav";
import { ActionButton, Disclosure, CopyButton } from "@/components/Forms";
import { ScoreRing } from "@/components/JobBits";
import { listApplications, repliesForApplications } from "@/lib/queries";
import { setApplicationStatus, checkInboxNow } from "@/app/actions";
import type { ApplicationStatus } from "@/db";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  queued: "pill-flat",
  sent: "pill-flat",
  acknowledged: "pill-flat",
  replied: "pill-warn",
  interview: "pill-good",
  offer: "pill-good",
  rejected: "pill-bad",
  failed: "pill-bad",
  withdrawn: "pill-flat",
};

const MANUAL_STATUSES: ApplicationStatus[] = [
  "sent", "interview", "rejected", "offer", "withdrawn",
];

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default async function ApplicationsPage() {
  await requireAuth();

  const rows = await listApplications(120);
  const replies = await repliesForApplications(rows.map((r) => r.application.id));
  const repliesByApp = new Map<number, typeof replies>();
  for (const reply of replies) {
    if (reply.applicationId == null) continue;
    const list = repliesByApp.get(reply.applicationId) ?? [];
    list.push(reply);
    repliesByApp.set(reply.applicationId, list);
  }

  const queued = rows.filter((r) => r.application.status === "queued");

  return (
    <Shell current="/applications">
      <PageHead
        title="Applications"
        subtitle={`${rows.length} total · ${queued.length} waiting on the browser worker`}
      >
        <ActionButton action={checkInboxNow}>Check inbox now</ActionButton>
      </PageHead>

      {queued.length > 0 && (
        <div className="panel mb-5 p-4" style={{ borderColor: "var(--accent)" }}>
          <div className="text-[13px] font-bold">{queued.length} applications ready to submit</div>
          <p className="hint">
            These have finished cover letters but need a form filled in a browser, which Vercel
            cannot do. Run <code className="font-mono">npm run worker</code> on your own machine and
            it will submit them, or open each advert below and paste the letter in yourself.
          </p>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing sent yet"
          body="Applications appear here the moment one goes out, along with any reply and what it means."
        />
      ) : (
        <ul className="space-y-2.5">
          {rows.map(({ application, job }) => {
            const appReplies = repliesByApp.get(application.id) ?? [];
            return (
              <li key={application.id} className="panel-row p-4">
                <div className="flex flex-wrap items-start gap-2.5">
                  <ScoreRing score={job.score} />

                  <div className="min-w-0 flex-1">
                    <a
                      href={job.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-[14px] font-semibold hover:underline"
                    >
                      {job.title}
                    </a>
                    <div className="mt-0.5 text-[12.5px]" style={{ color: "var(--muted)" }}>
                      <span className="font-medium" style={{ color: "var(--ink)" }}>{job.company}</span>
                      {" · "}{job.location || job.country.toUpperCase()}
                      {" · "}{application.channel === "email" ? `emailed ${application.toEmail}` : application.channel}
                      {" · "}{fmtDate(application.sentAt ?? application.createdAt)}
                    </div>
                  </div>

                  <span className={`pill ${STATUS_STYLE[application.status] ?? "pill-flat"}`}>
                    {application.status}
                  </span>
                  {application.autonomous && <span className="pill pill-flat">auto</span>}
                </div>

                {application.error && (
                  <p className="mt-2 text-[12px]" style={{ color: "var(--bad)" }}>
                    {application.error}
                  </p>
                )}

                {appReplies.length > 0 && (
                  <div className="mt-3 space-y-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
                    {appReplies.map((reply) => (
                      <div key={reply.id}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`pill ${STATUS_STYLE[reply.kind] ?? "pill-flat"}`}>
                            {reply.kind.replace("_", " ")}
                          </span>
                          <span className="text-[12.5px] font-medium">{reply.fromName || reply.fromAddress}</span>
                          <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                            {fmtDate(reply.receivedAt)}
                          </span>
                        </div>
                        {reply.summary && (
                          <p className="mt-1 text-[12.5px]">{reply.summary}</p>
                        )}
                        {reply.suggestedReply && (
                          <div className="mt-1.5">
                            <Disclosure label="Show suggested reply">
                              <pre
                                className="whitespace-pre-wrap rounded-lg p-3 text-[12px]"
                                style={{ background: "var(--panel-2)", fontFamily: "inherit" }}
                              >
                                {reply.suggestedReply}
                              </pre>
                              <div className="mt-1.5">
                                <CopyButton text={reply.suggestedReply} label="Copy reply" />
                              </div>
                            </Disclosure>
                          </div>
                        )}
                        <div className="mt-1.5">
                          <Disclosure label="Show their email">
                            <pre
                              className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg p-3 text-[11.5px]"
                              style={{ background: "var(--panel-2)", fontFamily: "inherit", color: "var(--muted)" }}
                            >
                              {reply.body}
                            </pre>
                          </Disclosure>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {application.coverLetter && (
                    <Disclosure label="Show cover letter">
                      <pre
                        className="whitespace-pre-wrap rounded-lg p-3 text-[12.5px]"
                        style={{ background: "var(--panel-2)", fontFamily: "inherit" }}
                      >
                        {application.coverLetter}
                      </pre>
                      <div className="mt-2 flex gap-2">
                        <CopyButton text={application.coverLetter} label="Copy letter" />
                        {application.subject && <CopyButton text={application.subject} label="Copy subject" />}
                      </div>
                    </Disclosure>
                  )}

                  <div className="ml-auto flex flex-wrap items-start gap-1.5">
                    {MANUAL_STATUSES.filter((s) => s !== application.status).map((status) => (
                      <ActionButton
                        key={status}
                        action={setApplicationStatus.bind(null, application.id, status)}
                        compact
                        title={`Mark as ${status}`}
                      >
                        {status}
                      </ActionButton>
                    ))}
                    <a
                      href={job.applyUrl || job.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="btn"
                      style={{ padding: "5px 9px", fontSize: 12 }}
                    >
                      Open
                    </a>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Shell>
  );
}
