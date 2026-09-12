import { requireAuth } from "@/lib/auth";
import { getSettings } from "@/db";
import { Shell } from "@/components/Nav";
import { ActionForm, SubmitButton, ActionButton } from "@/components/Forms";
import { saveSettings, syncSponsorsNow, testEmail } from "@/app/actions";
import { sponsorRegisterReady } from "@/pipeline/sponsors";
import { activeSources, ALL_SOURCES } from "@/sources";
import { THRESHOLD_SNAPSHOT_DATE, UK_SALARY } from "@/lib/visa";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requireAuth();
  const [settings, sponsorState] = await Promise.all([getSettings(), sponsorRegisterReady()]);
  const active = new Set(activeSources().map((s) => s.name));

  return (
    <Shell current="/settings">
      <h1 className="mb-5 text-[15px] font-bold">Settings</h1>

      <ActionForm action={saveSettings} className="space-y-5">
        <section className="panel p-5">
          <h2 className="mb-1 text-[13px] font-bold">The automator</h2>
          <p className="mb-4 text-[12.5px]" style={{ color: "var(--muted)" }}>
            When auto-apply is on, anything scoring at or above the threshold gets a tailored cover
            letter and is sent without asking you. Everything below waits in the Jobs list.
          </p>

          <div className="space-y-4">
            <label className="flex items-center gap-2.5 text-[13px] font-medium">
              <input type="checkbox" name="autoApply" defaultChecked={settings.autoApply} />
              Apply automatically above the threshold
            </label>

            <label className="flex items-center gap-2.5 text-[13px]">
              <input type="checkbox" name="paused" defaultChecked={settings.paused} />
              Pause everything (nothing is sent, discovery keeps running)
            </label>

            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <label className="label" htmlFor="autoApplyThreshold">Auto-apply threshold</label>
                <input id="autoApplyThreshold" name="autoApplyThreshold" type="number" min={50} max={100}
                  defaultValue={settings.autoApplyThreshold} className="input" />
                <p className="hint">78 is a good start. Raise it if the letters feel like a stretch.</p>
              </div>
              <div>
                <label className="label" htmlFor="dailyCap">Applications per day</label>
                <input id="dailyCap" name="dailyCap" type="number" min={1} max={40}
                  defaultValue={settings.dailyCap} className="input" />
                <p className="hint">Gmail throttles bulk sending; 40 is the ceiling here.</p>
              </div>
              <div>
                <label className="label" htmlFor="keepThreshold">Keep threshold</label>
                <input id="keepThreshold" name="keepThreshold" type="number" min={0} max={100}
                  defaultValue={settings.keepThreshold} className="input" />
                <p className="hint">Jobs below this are hidden from the Jobs list entirely.</p>
              </div>
            </div>

            <label className="flex items-start gap-2.5 text-[13px]">
              <input type="checkbox" name="requireSponsor" defaultChecked={settings.requireSponsor} className="mt-0.5" />
              <span>
                Never auto-apply to a UK employer that is not on the sponsor register
                <span className="hint block">
                  Strongly recommended. Without a licence they cannot hire you regardless of how the
                  interview goes.
                </span>
              </span>
            </label>
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="mb-4 text-[13px] font-bold">Exclusions</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="label" htmlFor="blockedCompanies">Blocked employers</label>
              <textarea id="blockedCompanies" name="blockedCompanies" rows={5}
                defaultValue={settings.blockedCompanies.join("\n")}
                placeholder={"Agency You Hate Ltd\nFormer Employer"}
                className="input font-mono text-[12.5px]" />
              <p className="hint">One per line.</p>
            </div>
            <div>
              <label className="label" htmlFor="blockedKeywords">Blocked keywords</label>
              <textarea id="blockedKeywords" name="blockedKeywords" rows={5}
                defaultValue={settings.blockedKeywords.join("\n")}
                placeholder={"unpaid\ncommission only\nnight shift"}
                className="input font-mono text-[12.5px]" />
              <p className="hint">A job whose title or description contains any of these is dropped at ingest.</p>
            </div>
          </div>
        </section>

        <SubmitButton>Save settings</SubmitButton>
      </ActionForm>

      {/* Non-form panels */}
      <section className="panel mt-5 p-5">
        <h2 className="mb-1 text-[13px] font-bold">UK sponsor register</h2>
        <p className="mb-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
          Pulled straight from the Home Office publication on gov.uk. Refreshes itself weekly.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <span className={`pill ${sponsorState.ready ? "pill-good" : "pill-bad"}`}>
            {sponsorState.ready
              ? `${sponsorState.rowCount.toLocaleString()} licensed employers`
              : "not synced"}
          </span>
          {sponsorState.lastSyncAt && (
            <span className="text-[12px]" style={{ color: "var(--muted)" }}>
              last synced {sponsorState.lastSyncAt.toLocaleDateString("en-GB")}
            </span>
          )}
          <ActionButton action={syncSponsorsNow} variant="primary">Sync now</ActionButton>
        </div>
        <p className="hint mt-3">
          Salary thresholds in use: UK Skilled Worker £{UK_SALARY.general.toLocaleString()} general,
          £{UK_SALARY.newEntrant.toLocaleString()} new entrant. EU Blue Card floors are a{" "}
          {THRESHOLD_SNAPSHOT_DATE} snapshot — edit them in{" "}
          <code className="font-mono">src/lib/visa.ts</code> when the rules move.
        </p>
      </section>

      <section className="panel mt-5 p-5">
        <h2 className="mb-3 text-[13px] font-bold">Job sources</h2>
        <div className="flex flex-wrap gap-1.5">
          {ALL_SOURCES.map((source) => (
            <span key={source.name} className={`pill ${active.has(source.name) ? "pill-good" : "pill-flat"}`}>
              {source.name}
            </span>
          ))}
        </div>
        <p className="hint mt-3">
          Greyed-out sources are missing their API key. Add them as environment variables on Vercel
          and redeploy. The three ATS sources (greenhouse, lever, ashby) need a comma-separated list
          of company board names — they are by far the best source, because you reach the employer
          before the advert hits an aggregator.
        </p>
      </section>

      <section className="panel mt-5 p-5">
        <h2 className="mb-3 text-[13px] font-bold">Email</h2>
        <p className="mb-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
          Applications are sent from your own Gmail so replies arrive in your real inbox.
        </p>
        <ActionButton action={testEmail}>Test the connection</ActionButton>
      </section>
    </Shell>
  );
}
