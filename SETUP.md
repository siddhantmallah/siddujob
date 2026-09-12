# Setup

Roughly 45 minutes, most of it waiting for signup emails. Do it in this order —
each step unlocks the next.

Everything here has a free tier. Running cost is the Anthropic API only, and at
the default caps that is pennies a day.

---

## 1. Database — Neon (5 min)

1. Sign up at <https://neon.tech> and create a project. Pick the **London
   (eu-west-2)** region.
2. Copy the connection string from the dashboard. It looks like
   `postgresql://user:pass@ep-something.eu-west-2.aws.neon.tech/neondb?sslmode=require`
3. Locally:

```bash
cp .env.example .env
```

Paste the connection string into **`JOBFINDER_DATABASE_URL`**.

> **Why not plain `DATABASE_URL`?** A machine-wide `DATABASE_URL` is common —
> Prisma, Docker and other projects set one — and it **outranks your .env file**,
> because neither dotenv nor Next.js override a variable already present in the
> shell. This machine already had one pointing at a Prisma instance, which
> silently sent every query to the wrong database. The app reads
> `JOBFINDER_DATABASE_URL` first so that cannot happen.

Then create the tables:

```bash
npm install
npm run db:push
npm run db:check    # confirms the app is talking to the right database
```

---

## 2. Secrets (2 min)

Three random strings in `.env`. Generate them however you like:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

- `APP_PASSWORD` — what you type to open the dashboard
- `AUTH_SECRET` — signs your session cookie
- `CRON_SECRET` — the bearer token the scheduler and the worker use

---

## 3. Anthropic API (5 min)

1. <https://console.anthropic.com> → API keys → create one.
2. Add credit. Measured cost at the default caps (40 jobs scored + 15 letters a
   day) is about $29/month on Claude Opus 5, or about $12/month if you set
   `ANTHROPIC_MODEL="claude-sonnet-5"`. £10 is plenty to start and to see
   whether the scoring is any good before you commit.
3. Put it in `ANTHROPIC_API_KEY`.

This powers job scoring, cover letters, and reply classification. Without it the
app still runs on keyword matching alone, but that is a much blunter instrument.

Check it works before deploying:

```bash
npm run verify        # secrets + API key reachable
npm run verify:llm    # scores 3 sample jobs, writes a letter, prints real cost
```

---

## 4. Gmail — sending and reply detection (10 min)

Applications are sent **from your own Gmail**, not from a service domain. That
means recruiters see a real person, replies land in your real inbox, and you do
not need to own a domain.

1. Turn on 2-Step Verification: <https://myaccount.google.com/security>
2. Create an App Password: <https://myaccount.google.com/apppasswords>
   - name it "Job Finder", copy the 16-character code
3. Fill in `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`, `GMAIL_FROM_NAME`
4. Make sure IMAP is enabled: Gmail → Settings → Forwarding and POP/IMAP →
   **Enable IMAP**. Without this, replies cannot be detected.

Verify it on the Settings page with **Test the connection** once deployed.

---

## 5. Telegram alerts (5 min)

The fastest way to hear about an interview invitation.

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts → copy
   the token into `TELEGRAM_BOT_TOKEN`
2. Message **@userinfobot** → it replies with your numeric id → put it in
   `TELEGRAM_CHAT_ID`
3. Send your new bot any message (`hi`). A bot cannot message you first.

---

## 6. Job board APIs (10 min)

### Adzuna — UK and most of the EU, free

<https://developer.adzuna.com> → register → copy App ID and App Key into
`ADZUNA_APP_ID` / `ADZUNA_APP_KEY`.

### Reed — UK only, free

<https://www.reed.co.uk/developers/jobseeker> → request a key → `REED_API_KEY`.

### Jooble — optional

<https://jooble.org/api/about> → request a key → `JOOBLE_API_KEY`.

### Company ATS boards — the best source, no key needed

Postings appear here hours before aggregators, with no recruiter in between,
and the forms are the ones the browser worker can actually complete.

Find a company's board name from its careers URL:

- `boards.greenhouse.io/monzo` → `monzo`
- `jobs.lever.co/palantir` → `palantir`
- `jobs.ashbyhq.com/ramp` → `ramp`

```
GREENHOUSE_BOARDS="monzo,wise,starlingbank,deliveroo"
LEVER_BOARDS="palantir,netlify"
ASHBY_BOARDS="ramp,linear"
```

Build this list deliberately: pick employers you would genuinely take a job at
**and** that appear on the sponsor register. Thirty good names here is worth
more than every aggregator combined.

---

## 7. Deploy to Vercel (5 min)

```bash
git init
git add -A
git commit -m "Job Finder"
```

Push to a **private** GitHub repo, then at <https://vercel.com/new> import it.

Before the first deploy, add every variable from your `.env` under
**Settings → Environment Variables**. Deploy.

Open the URL, sign in with `APP_PASSWORD`.

---

## 8. Fill in your profile (15 min — the part that actually matters)

Go to **Profile**. Two fields decide whether any of this works:

- **CV PDF** — attached verbatim to every application
- **CV text** — paste the whole thing. Every sentence a cover letter writes is
  traced back to this. Anything you leave out will never be mentioned; anything
  vague produces a vague letter.

Then set your target titles (one per line), countries (`gb, ie, de, nl, pl`),
years of experience, and tick **I need visa sponsorship**.

---

## 9. Sync the sponsor register

**Settings → Sync now.** Pulls ~127,000 licensed UK employers straight from the
Home Office publication on gov.uk. It refreshes itself weekly after this.

This is the filter that changes your odds. Skip it and you are back to applying
to employers who cannot legally hire you.

---

## 10. Turn on the scheduler

Vercel's Hobby plan only runs cron **once per day**, so GitHub Actions does the
real scheduling — free, every 30 minutes. In your repo:

**Settings → Secrets and variables → Actions → New repository secret**

- `APP_URL` = `https://your-app.vercel.app`
- `CRON_SECRET` = the same value you set on Vercel

Then **Actions → job pipeline → Run workflow** to test it immediately.

---

## 11. First run

1. Dashboard → **Find jobs now**. Give it a minute.
2. **Jobs** tab → read the scores and the visa badges. Are they sensible?
3. Pick one and hit **Write & apply**. Read the letter it produced.
4. Only when a letter is something you would have sent yourself: **Settings →
   Apply automatically**, threshold `78`, daily cap `10`.

Start at cap 10. Raise it once you have seen a week of output.

---

## 12. The browser worker (optional, but this is the real automator)

Most employers want a form filled, not an email. Vercel cannot run a browser,
so that happens on your machine.

```bash
npm run worker:install     # once — downloads Chromium
npm run worker             # dry run: fills everything, submits nothing
```

Look at the screenshots in `.worker-data/`. When they look right:

```bash
npm run worker -- --submit
```

Useful flags: `--headed` to watch it, `--limit=3` to go slowly.

It handles Greenhouse, Lever, Ashby, Workable and ordinary forms. Anything with
a CAPTCHA, a login wall, or a question it has not been given an answer to is
handed back to you rather than guessed at.

To run it on a schedule, use Windows Task Scheduler pointed at
`npm run worker -- --submit` in this folder.

---

## Troubleshooting

**"DATABASE_URL is not set"** — variable missing on Vercel, or you added it
after deploying. Redeploy after adding.

**No jobs found** — check Settings → Job sources. Greyed-out means the key is
missing. Also check your target countries are valid two-letter codes.

**Everything shows "not a sponsor"** — the register has not synced. Settings →
Sync now.

**Replies not detected** — IMAP is off in Gmail, or the app password is wrong.
Settings → Test the connection.

**Cover letters feel generic** — your CV text is too thin. It is the only thing
the writer can draw on.

**Scores all look too low** — that is usually accurate and worth believing. If
a specific job is genuinely a better fit than it scored, hit **Re-score**; if a
whole category is wrong, your target titles are probably off.
