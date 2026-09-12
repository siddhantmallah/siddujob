import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { anthropic, BULK_MODEL, MODEL, cacheMinimumFor } from "../src/lib/llm";
import { getProfile } from "../src/db";
import { truncate } from "../src/lib/utils";

/**
 * Confirms the cached prefix is long enough for the model actually in use, and
 * that a second request reads it back rather than re-paying for it.
 */
(async () => {
  const profile = await getProfile();
  const client = anthropic();

  for (const model of [BULK_MODEL, MODEL]) {
    const system = [
      { type: "text" as const, text: "You screen job adverts for one candidate. Be strict." },
      {
        type: "text" as const,
        text: `<candidate_cv>\n${truncate(profile.cvText, 9000)}\n</candidate_cv>`,
        cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
      },
    ];

    const count = await client.messages.countTokens({
      model, system, messages: [{ role: "user", content: "x" }],
    });
    const minimum = cacheMinimumFor(model);
    const ok = count.input_tokens >= minimum;

    console.log(`\n${model}`);
    console.log(`  cached prefix   ${count.input_tokens} tokens`);
    console.log(`  model minimum   ${minimum} tokens`);
    console.log(`  cacheable       ${ok ? "yes" : "NO — prefix too short, marker is a no-op"}`);
    if (!ok) continue;

    // Two identical requests: the first writes the entry, the second must read it.
    const ask = (n: number) => client.messages.create({
      model, max_tokens: 1400, system,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: `Reply with the single digit ${n}.` }],
    });

    const first = await ask(1);
    const second = await ask(1);

    console.log(`  write (req 1)   ${first.usage.cache_creation_input_tokens ?? 0} tokens`);
    console.log(`  read  (req 2)   ${second.usage.cache_read_input_tokens ?? 0} tokens`);
    console.log(`  uncached in     ${second.usage.input_tokens} tokens`);
    console.log(`  verdict         ${(second.usage.cache_read_input_tokens ?? 0) > 0 ? "CACHE HIT" : "MISS"}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
