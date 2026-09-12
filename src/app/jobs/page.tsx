import Link from "next/link";
import { requireAuth } from "@/lib/auth";
import { Shell, PageHead, EmptyState } from "@/components/Nav";
import { ActionButton } from "@/components/Forms";
import { ScoreRing, VisaPill, SalaryText, SourceTag, placeLabel } from "@/components/JobBits";
import { listJobs, type JobFilter } from "@/lib/queries";
import { applyNow, skipJob, unskipJob, blockCompanyForJob, rescore } from "@/app/actions";

export const dynamic = "force-dynamic";

const TABS: Array<{ key: JobFilter; label: string }> = [
  { key: "top", label: "Worth applying" },
  { key: "applied", label: "Applied" },
  { key: "skipped", label: "Skipped" },
  { key: "blocked_visa", label: "UK · no sponsor licence" },
  { key: "all", label: "Everything" },
];

export default async function JobsPage({
  searchParams,
}: { searchParams: Promise<{ filter?: string }> }) {
  await requireAuth();
  const params = await searchParams;
  const filter = (TABS.find((t) => t.key === params.filter)?.key ?? "top") as JobFilter;
  const rows = await listJobs(filter, 80);

  return (
    <Shell current="/jobs">
      <PageHead
        title="Jobs"
        subtitle={`${rows.length} shown · sorted by how well they match your CV`}
      />

      <div
        className="mb-4 flex flex-wrap gap-1 rounded-xl p-1"
        style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}
      >
        {TABS.map((tab) => {
          const active = filter === tab.key;
          return (
            <Link
              key={tab.key}
              href={`/jobs?filter=${tab.key}`}
              prefetch
              className="rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors"
              style={{
                background: active ? "var(--panel)" : "transparent",
                color: active ? "var(--ink)" : "var(--muted)",
                boxShadow: active ? "var(--shadow-sm)" : undefined,
              }}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={filter === "top" ? "No matches waiting" : "Nothing here"}
          body={
            filter === "top"
              ? "Run Find jobs from the dashboard, or lower your keep threshold in Settings if you want to see weaker matches."
              : "Nothing falls into this view yet."
          }
        />
      ) : (
        <ul className="space-y-2.5">
          {rows.map(({ job, applicationId, applicationStatus }) => (
            <li key={job.id} className="panel-row p-4">
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
                    {" · "}{placeLabel(job)}
                    {job.remote ? " · remote" : ""}
                    {" · "}<SalaryText job={job} />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <VisaPill job={job} />
                  <SourceTag source={job.source} />
                </div>
              </div>

              {(job.scoreReasons?.length || job.scoreConcerns?.length) ? (
                <div className="mt-2.5 grid gap-1.5 text-[12px] md:grid-cols-2">
                  {job.scoreReasons?.length ? (
                    <ul className="space-y-0.5">
                      {job.scoreReasons.map((r, i) => (
                        <li key={i} style={{ color: "var(--good)" }}>+ {r}</li>
                      ))}
                    </ul>
                  ) : <div />}
                  {job.scoreConcerns?.length ? (
                    <ul className="space-y-0.5">
                      {job.scoreConcerns.map((c, i) => (
                        <li key={i} style={{ color: "var(--warn)" }}>− {c}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {job.visaNote && (
                <p className="mt-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
                  Visa: {job.visaNote}
                </p>
              )}

              {job.skipReason && (
                <p className="mt-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
                  Skipped: {job.skipReason}
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-start gap-2">
                {applicationId ? (
                  <span className="pill pill-flat">applied · {applicationStatus}</span>
                ) : (
                  <ActionButton action={applyNow.bind(null, job.id)} variant="primary" compact>
                    Write &amp; apply
                  </ActionButton>
                )}

                {job.status === "skipped" ? (
                  <ActionButton action={unskipJob.bind(null, job.id)} compact>Restore</ActionButton>
                ) : (
                  <ActionButton action={skipJob.bind(null, job.id, "Skipped by you")} compact>
                    Skip
                  </ActionButton>
                )}

                <ActionButton action={rescore.bind(null, job.id)} compact>Re-score</ActionButton>

                <ActionButton
                  action={blockCompanyForJob.bind(null, job.id)}
                  confirm={`Block ${job.company} permanently? Every current and future job from them is hidden.`}
                  variant="danger"
                  compact
                >
                  Block employer
                </ActionButton>

                <a
                  href={job.applyUrl || job.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="btn btn-sm"
                  style={{ marginLeft: "auto" }}
                >
                  Open advert
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
