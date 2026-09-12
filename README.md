# Job Finder

A private job search automator for the UK and Europe, built for one person.

It pulls roles from nine sources, filters out every employer who **legally
cannot hire you**, scores what is left against your actual CV, writes a tailored
cover letter, sends the application, watches your inbox for the reply, and
pings your phone the moment someone says yes.

**→ Start with [SETUP.md](SETUP.md).**

---

## The part that matters most

If you need sponsorship, most applications fail before anyone reads them — the
employer never had a licence to hire you. No job board shows this.

This app checks every UK posting against the Home Office **Register of Licensed
Sponsors** (~127,000 employers, pulled from gov.uk and refreshed weekly) and
against the **Skilled Worker salary floor** (£38,700 general / £30,960 new
entrant). For EU roles it checks the Blue Card and equivalent thresholds per
country, using the reduced shortage-occupation floor where IT roles qualify —
which matters in Germany and Ireland especially.

Jobs that fail the gate are filtered out. Jobs that pass carry a green badge.
You stop spending evenings on roles that were never reachable.

It is a time-saving filter, not immigration advice. Confirm before you rely on
any single verdict. Thresholds live in one file: `src/lib/visa.ts`.

---

## How a job moves through it

```
  sources ──▶ ingest ──▶ visa gate ──▶ score ──▶ apply ──▶ inbox ──▶ you
  9 feeds     dedupe     sponsor       CV vs      letter    classify   Telegram
                         register      advert     + send    the reply
```

**Sources** — Adzuna, Reed, Jooble (keys); Arbeitnow, Remotive, Jobicy (free);
Greenhouse, Lever, Ashby (company boards you choose). ATS boards are the best
of these: earlier, no middleman, and forms the worker can complete.

**Ingest** — normalises everything into one shape and deduplicates. The same
role from four boards becomes one row, keeping the richest copy.

**Visa gate** — sponsor register and salary floors, as above.

**Score** — two stages. Free keyword maths discards the obvious mismatches,
then Claude reads the survivors against your CV and scores strictly: does the
candidate evidence the stated must-haves? A run costs pennies.

**Apply** — a tailored cover letter, then routed by what is actually possible:

| Channel | What happens | Auto? |
|---|---|---|
| `email` | Sent from your Gmail with CV + letter PDF attached | yes |
| `worker` | Letter written, queued for the local browser worker | yes, on your machine |
| `manual` | Something needs you — a question, a login, a CAPTCHA | no, by design |

**Inbox** — IMAP poll of your Gmail. Matches each message to an application by
mail thread, sender domain, then company name, and classifies it: interview,
offer, rejection, recruiter question, automated acknowledgement. Interviews and
offers alert you immediately, with a draft reply.

---

## Honest limits

- **No LinkedIn or Indeed.** Bot-submitting there breaks their terms and risks
  your account. The sources here are APIs meant to be consumed.
- **Auto-send covers email and the browser worker.** Everything else needs a
  click from you.
- **The worker refuses to guess.** Salary expectations, notice period, "why do
  you want to work here" — it stops and hands the job back. A wrong answer
  under your name is worse than a slow one.
- **Volume is capped on purpose.** Default 15 a day, hard ceiling 40. Gmail
  throttles bulk sending, and recruiters notice a blast.
- **The scorer is strict.** If everything looks low, that is usually real
  information about the match rather than a bug.

---

## Commands

```bash
npm run dev              # http://localhost:3000
npm run build            # production build
npm test                 # logic + live feed checks, no database needed
npm run typecheck

npm run db:push          # create/update tables
npm run db:check         # confirm the app reaches the right database
npm run db:studio        # browse the data
npm run sponsors:sync    # pull the gov.uk register
npm run pipeline:local   # run the whole pipeline once, locally

npm run worker:install   # once — downloads Chromium
npm run worker           # dry run: fills forms, submits nothing
npm run worker -- --submit --headed --limit=3
```

---

## Layout

```
src/
  db/          schema + lazy Neon client
  lib/         auth, llm, mail, notify, pdf, visa rules, queries
  sources/     nine job feeds, one normalised shape
  pipeline/    sponsors → ingest → score → generate → apply → inbox
  app/         dashboard, jobs, applications, profile, settings, cron routes
  components/
worker/        Playwright form-filler (runs on your machine)
scripts/       sponsor sync, local pipeline, smoke tests
```

Where to change things:

| Want to change | File |
|---|---|
| Visa thresholds | `src/lib/visa.ts` |
| How strictly jobs are scored | `src/pipeline/score.ts` |
| Cover letter voice and rules | `src/pipeline/generate.ts` |
| Add a job source | `src/sources/` + register in `index.ts` |
| Form field matching | `worker/apply-worker.ts` |

---

## Cost

Neon, Vercel, Adzuna, Reed, Telegram and GitHub Actions all sit inside free
tiers at this volume. The only real cost is the Anthropic API.

Measured, not estimated — run `npm run verify:llm` to reproduce it:

| | Claude Opus 5 (default) | Claude Sonnet 5 |
|---|---|---|
| Scoring one job | ~$0.014 | ~$0.006 |
| One cover letter | ~$0.027 | ~$0.011 |
| **40 jobs + 15 letters a day** | **~$29/month** | **~$12/month** |

Two things already hold that down. The CV and the scoring rules sit behind a
prompt-cache breakpoint, so a run of 30 jobs reads your CV from cache 29 times
instead of paying for it 30 times. And scoring runs at `effort: "low"` while
cover letters run at `effort: "high"` — the letter is the part an employer
actually reads.

To switch models, set `ANTHROPIC_MODEL` and redeploy. Opus 5 is the default
because it is the better judge of whether you clear a job's bar, and a wrong
score costs you either a wasted application or a missed one.
