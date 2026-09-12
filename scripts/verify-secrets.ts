import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { SignJWT, jwtVerify } from "jose";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Confirms the session secret round-trips and the model key is live.
 *   npm run verify
 */
(async () => {
  // 1. AUTH_SECRET — can we sign and verify a session cookie?
  try {
    const key = new TextEncoder().encode(process.env.AUTH_SECRET ?? "");
    const token = await new SignJWT({ sub: "owner" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key);
    const { payload } = await jwtVerify(token, key);
    console.log(`AUTH_SECRET      ok — signed and verified, sub=${payload.sub}`);
  } catch (err) {
    console.log(`AUTH_SECRET      FAILED — ${(err as Error).message}`);
  }

  // 2. ANTHROPIC_API_KEY — one tiny real call.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("ANTHROPIC        not set");
  } else {
    const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      // Same parameter shape the app uses: no temperature, adaptive thinking,
      // effort as the cost dial. Keeps this check honest about production.
      const res = await client.messages.create({
        model,
        max_tokens: 2000,
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
      });
      const text = res.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();
      console.log(`ANTHROPIC        ok — ${model} replied "${text}"`);
      console.log(`                 tokens in/out ${res.usage.input_tokens}/${res.usage.output_tokens}`);
    } catch (err) {
      console.log(`ANTHROPIC        FAILED — ${(err as Error).message.slice(0, 200)}`);
    }
  }

  // 3. Malformed values. A key pasted across two lines still "works" locally
  //    because dotenv joins them, then breaks the moment it is retyped into a
  //    hosting dashboard — so catch it here rather than in production.
  const malformed = Object.entries(process.env)
    .filter(([key]) => /^(JOBFINDER_|DATABASE_|APP_|AUTH_|CRON_|ANTHROPIC_|GMAIL_|TELEGRAM_|ADZUNA_|REED_|JOOBLE_|GREENHOUSE_|LEVER_|ASHBY_)/.test(key))
    .filter(([, value]) => value && (/[\r\n]/.test(value) || value !== value.trim()));

  if (malformed.length) {
    console.log("\nMALFORMED — these contain a newline or stray whitespace:");
    for (const [key] of malformed) console.log(`  ${key}`);
    console.log("  Put each value on a single line in .env and re-run.");
  }

  // 4. What is still outstanding before the pipeline can run end to end.
  const needed: Array<[string, string]> = [
    ["GMAIL_ADDRESS", "sending applications"],
    ["GMAIL_APP_PASSWORD", "sending + reply detection"],
    ["TELEGRAM_BOT_TOKEN", "instant alerts"],
    ["TELEGRAM_CHAT_ID", "instant alerts"],
    ["ADZUNA_APP_ID", "UK + EU job feed"],
    ["ADZUNA_APP_KEY", "UK + EU job feed"],
    ["REED_API_KEY", "UK job feed"],
  ];
  const missing = needed.filter(([key]) => !process.env[key]);

  console.log("");
  if (!missing.length) {
    console.log("everything else  set");
  } else {
    console.log("still missing:");
    for (const [key, why] of missing) console.log(`  ${key.padEnd(20)} ${why}`);
    console.log("\n(the app still runs without these — keyless job feeds and");
    console.log(" the review queue work, but nothing can be sent or alerted)");
  }
  process.exit(0);
})();
