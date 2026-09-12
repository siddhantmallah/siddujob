# Running it on a schedule, for free

GitHub Actions is the obvious scheduler and it is not available here — the
account's billing is locked, which blocks Actions entirely, free tier included.
The workflow files are still in `.github/workflows/` and will work the day that
changes, but nothing below depends on them.

Two jobs need scheduling, and they have different constraints.

---

## 1. Discovery, scoring and the inbox watch — no browser needed

These are plain HTTP calls to the deployed app, so anything that can fetch a URL
on a timer will do. **cron-job.org** is free, needs no card, and goes down to
one-minute granularity.

1. Sign up at <https://cron-job.org> and create three jobs.
2. For each, set the URL and add one header.

| Title | URL | Schedule |
|---|---|---|
| Find jobs | `https://siddujob.vercel.app/api/cron/ingest` | every 30 min |
| Send applications | `https://siddujob.vercel.app/api/cron/apply` | hourly |
| Check replies | `https://siddujob.vercel.app/api/cron/inbox` | every 30 min |

Under **Advanced → Headers**, add to each:

```
Authorization: Bearer 2GPQ1Lwcmml06Fvl9VBVQsBd-GrW8nM2
```

That is the `CRON_SECRET`. Without it the endpoints return 401, which is the
point — they are open to the internet.

Discovery deliberately covers only three search terms per run, so it always
finishes inside the function limit. At every 30 minutes the full list of titles
is still covered several times a day.

**Backup:** `vercel.json` already declares Vercel Cron jobs. The Hobby plan runs
them once a day, which is not enough on its own but means the pipeline never
stops entirely if cron-job.org is down.

---

## 2. Submitting applications — needs a real browser

This one cannot run in the cloud for free. Vercel has no browser, and the
managed browser services do not have a usable free tier. So it runs on your
machine, using the Chrome already installed on it.

No download is required — the worker borrows your installed Chrome, falling
back to Edge, and only then to a bundled Chromium.

```bash
npm run worker
```

That is a **dry run**: it opens each queued application, follows the aggregator
interstitial through to the employer, fills the form, saves a screenshot to
`.worker-data/` and submits nothing. Look at those screenshots first.

```bash
npm run worker -- --submit
```

Live. Add `--headed` to watch it work, `--limit=3` to go slowly.

### Making it automatic on Windows

Runs whenever the machine is on. From an **Administrator** PowerShell in the
project folder:

```powershell
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c npm run worker -- --submit" -WorkingDirectory (Get-Location).Path
$trigger = New-ScheduledTaskTrigger -Daily -At 9am
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At 9am -RepetitionInterval (New-TimeSpan -Hours 4) -RepetitionDuration (New-TimeSpan -Hours 12)).Repetition
Register-ScheduledTask -TaskName "JobFinderWorker" -Action $action -Trigger $trigger -Description "Submits queued job applications"
```

Every four hours between 9am and 9pm. To stop it:

```powershell
Unregister-ScheduledTask -TaskName "JobFinderWorker" -Confirm:$false
```

---

## A constraint worth knowing about

**Adzuna geo-blocks its apply pages.** Its API serves job data worldwide, but
its job page returns "this job is not available in your region" when opened
from outside the advertised country — so the employer's form is unreachable
from India even though the listing is visible.

Measured across the sources in use:

| Source | Apply path from outside the UK |
|---|---|
| adzuna | **blocked** |
| reed | reachable |
| greenhouse, lever, ashby | reachable |
| arbeitnow, jobicy, remotive | reachable |

The pipeline handles this rather than ignoring it. Adzuna listings are still
read — they are good intelligence about who is hiring right now — but before
anything is queued, `resolveApplyUrls` looks for the same role on Reed and
stores a link that works. Roles it cannot find a reachable link for are marked
with an honest reason instead of being queued against a page that will only
ever show a regional notice.

When the same job appears on both Adzuna and a reachable source, deduplication
now keeps the reachable one even if the Adzuna record carries more detail.
