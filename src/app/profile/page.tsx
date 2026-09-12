import { requireAuth } from "@/lib/auth";
import { getProfile } from "@/db";
import { Shell } from "@/components/Nav";
import { ActionForm, SubmitButton } from "@/components/Forms";
import { saveProfile } from "@/app/actions";

export const dynamic = "force-dynamic";

function Field({
  label, name, defaultValue, placeholder, hint, type = "text", required = false,
}: {
  label: string; name: string; defaultValue?: string | number;
  placeholder?: string; hint?: string; type?: string; required?: boolean;
}) {
  return (
    <div>
      <label className="label" htmlFor={name}>{label}</label>
      <input
        id={name}
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        className="input"
      />
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export default async function ProfilePage() {
  await requireAuth();
  const profile = await getProfile();

  return (
    <Shell current="/profile">
      <h1 className="mb-1 text-[15px] font-bold">Your profile</h1>
      <p className="mb-5 text-[13px]" style={{ color: "var(--muted)" }}>
        Everything here feeds matching and cover letters. The CV text is the single source of truth —
        nothing gets claimed on your behalf that is not in it.
      </p>

      <ActionForm action={saveProfile} className="space-y-5">
        <section className="panel p-5">
          <h2 className="mb-4 text-[13px] font-bold">Contact</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Full name" name="fullName" defaultValue={profile.fullName} required />
            <Field label="Email" name="email" type="email" defaultValue={profile.email} required
              hint="Shown in the letter. Applications are sent from your GMAIL_ADDRESS." />
            <Field label="Phone" name="phone" defaultValue={profile.phone} placeholder="+44 7700 900000" />
            <Field label="Based in" name="location" defaultValue={profile.location} placeholder="London, UK" />
            <Field label="LinkedIn" name="linkedin" defaultValue={profile.linkedin} placeholder="linkedin.com/in/you" />
            <Field label="GitHub" name="github" defaultValue={profile.github} placeholder="github.com/you" />
            <Field label="Website" name="website" defaultValue={profile.website} />
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="mb-4 text-[13px] font-bold">What you are looking for</h2>
          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="targetTitles">Target job titles</label>
              <textarea
                id="targetTitles"
                name="targetTitles"
                rows={4}
                defaultValue={profile.targetTitles.join("\n")}
                placeholder={"IT Support Engineer\nInfrastructure Engineer\nDevOps Engineer\nSystems Administrator\nCloud Engineer\nService Desk Analyst"}
                className="input font-mono text-[13px]"
              />
              <p className="hint">One per line. These become the search terms across every job board.</p>
            </div>

            <div>
              <label className="label" htmlFor="targetCountries">Countries</label>
              <input
                id="targetCountries"
                name="targetCountries"
                defaultValue={profile.targetCountries.join(", ")}
                placeholder="gb, ie, de, nl, pl, pt"
                className="input font-mono text-[13px]"
              />
              <p className="hint">
                Two-letter codes, comma separated. gb ie de nl fr es pl pt it se dk be at cz fi lu.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Years of experience" name="yearsExperience" type="number"
                defaultValue={profile.yearsExperience}
                hint="Under 3 unlocks the UK new-entrant salary threshold." />
              <Field label="Minimum salary" name="minSalary" type="number" defaultValue={profile.minSalary} />
              <div>
                <label className="label" htmlFor="currency">Currency</label>
                <select id="currency" name="currency" defaultValue={profile.currency} className="input">
                  <option value="GBP">GBP</option>
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap gap-5 pt-1">
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" name="needsSponsorship" defaultChecked={profile.needsSponsorship} />
                I need visa sponsorship
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" name="remoteOk" defaultChecked={profile.remoteOk} />
                Remote is fine
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" name="onsiteOk" defaultChecked={profile.onsiteOk} />
                On-site is fine
              </label>
            </div>
            <p className="hint">
              With sponsorship ticked, UK employers missing from the Home Office register are filtered
              out before you ever see them, and EU roles below the Blue Card salary floor are flagged.
            </p>
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="mb-1 text-[13px] font-bold">Your CV</h2>
          <p className="mb-4 text-[12.5px]" style={{ color: "var(--muted)" }}>
            Both fields matter. The PDF is attached to applications exactly as you wrote it; the text
            is what the matcher and the letter writer actually read.
          </p>

          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="cvFile">CV PDF</label>
              <input id="cvFile" name="cvFile" type="file" accept="application/pdf" className="input" />
              <p className="hint">
                {profile.cvBase64
                  ? `Currently attached: ${profile.cvFileName}. Upload a new one to replace it.`
                  : "No CV uploaded yet. Max 4 MB."}{" "}
                The text is read out of the PDF automatically — leave the box below
                empty and it will fill itself.
              </p>
            </div>

            <div>
              <label className="label" htmlFor="cvText">CV text</label>
              <textarea
                id="cvText"
                name="cvText"
                rows={16}
                defaultValue={profile.cvText}
                placeholder="Filled automatically from the PDF you upload. Paste here only if you want to override it, or if the PDF is a scan."
                className="input font-mono text-[12.5px]"
              />
              <p className="hint">
                Every claim in a generated letter is traced back to this text, so anything missing
                here is never mentioned. Anything you type wins over the PDF extraction.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="label" htmlFor="headline">Headline</label>
                <input id="headline" name="headline" defaultValue={profile.headline}
                  placeholder="Infrastructure engineer, 6 years, Azure and Windows Server" className="input" />
              </div>
              <div>
                <label className="label" htmlFor="skills">Key skills</label>
                <input id="skills" name="skills" defaultValue={profile.skills.join(", ")}
                  placeholder="Active Directory, Azure, Intune, PowerShell, VMware, Linux, Networking, ITIL"
                  className="input" />
                <p className="hint">Comma separated. Used for the free first-pass filter.</p>
              </div>
            </div>

            <div>
              <label className="label" htmlFor="summary">Short summary</label>
              <textarea id="summary" name="summary" rows={3} defaultValue={profile.summary} className="input" />
            </div>
          </div>
        </section>

        <SubmitButton>Save profile</SubmitButton>
      </ActionForm>
    </Shell>
  );
}
