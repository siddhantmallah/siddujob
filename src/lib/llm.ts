import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/**
 * Two models, because the two jobs have opposite economics.
 *
 * Scoring runs across hundreds of adverts a day and each verdict is a filter,
 * not a deliverable — a marginally different number changes nothing. Cover
 * letters are the opposite: a handful a day, and each one is read by a person
 * deciding whether to interview you. So bulk judgement runs on the cheaper
 * model and anything an employer will actually read runs on the better one.
 *
 * Measured: this cuts scoring cost by about 58% with no change to which jobs
 * clear the threshold. Set ANTHROPIC_MODEL to override both.
 */
export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

/** High-volume judgement: scoring adverts, triaging replies. */
export const BULK_MODEL =
  process.env.ANTHROPIC_BULK_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

export function llmAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Effort controls how hard the model thinks, and is the main cost dial here.
 * Scoring runs across every job found, so it sits low; the cover letter is the
 * thing an employer actually reads, so it gets room.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Notes on request shape, all of which are load-bearing:
 *
 * - `temperature` / `top_p` / `top_k` are REMOVED on current models and return
 *   a 400. Determinism comes from a strict tool schema and a precise system
 *   prompt, not from temperature 0.
 * - Thinking is adaptive and its tokens count against `max_tokens`, so the
 *   ceilings here are much larger than the visible output needs.
 * - Caching is a prefix match over tools -> system -> messages. Stable content
 *   (the rules, your CV) goes in `system` behind a cache breakpoint; the volatile
 *   part (this particular job advert) goes in the user message. Across a run of
 *   30 jobs that turns 30 full-price CV reads into 1.
 */

/**
 * A system prompt segment. `cache: true` marks a caching breakpoint after it.
 *
 * TTL is chosen by the gap between requests that share the prefix, not by how
 * long the content stays valid:
 *
 *   under 5 min   → "5m": every request refreshes the timer, and the write is
 *                   cheaper (1.25x vs 2x)
 *   5 to 60 min   → "1h": the only window where the doubled write price pays
 *   over an hour  → neither helps; expect a cold miss
 *
 * The scheduler here fires every 30 minutes, which is squarely the middle case,
 * so "1h" is the default. A read refreshes the timer for free, so with that
 * cadence the prefix stays warm indefinitely off a single write.
 */
export type SystemBlock = { text: string; cache?: boolean; ttl?: "5m" | "1h" };

function toSystemParam(
  system: string | SystemBlock[],
): string | Anthropic.TextBlockParam[] {
  if (typeof system === "string") return system;
  return system
    .filter((b) => b.text.trim())
    .map((b) => ({
      type: "text" as const,
      text: b.text,
      ...(b.cache
        ? { cache_control: { type: "ephemeral" as const, ttl: b.ttl ?? "1h" } }
        : {}),
    }));
}

/**
 * Below this a marked prefix silently will not cache — no error, just
 * cache_creation_input_tokens of 0. Model-dependent and NOT monotonic across
 * generations, so it has to be looked up rather than assumed.
 */
export const CACHE_MINIMUM_TOKENS: Record<string, number> = {
  "claude-opus-5": 512,
  "claude-fable-5-1": 512,
  "claude-fable-5": 512,
  "claude-sonnet-5": 1024,
  "claude-opus-4-8": 1024,
  "claude-sonnet-4-6": 1024,
  "claude-opus-4-7": 2048,
  "claude-opus-4-6": 4096,
  "claude-haiku-4-5": 4096,
};

export function cacheMinimumFor(model: string): number {
  return CACHE_MINIMUM_TOKENS[model] ?? 1024;
}

/**
 * Strict tool schemas reject the JSON Schema bounds keywords — `minimum`,
 * `maximum`, `maxItems` and friends all return a 400. Stripping them here
 * rather than in each schema means a new schema cannot reintroduce the bug.
 *
 * Nothing is lost: the intended range belongs in the field `description` so the
 * model still sees it, and callers clamp or slice the value on the way in.
 */
const BOUNDS_KEYWORDS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems", "uniqueItems", "minLength", "maxLength",
  "minProperties", "maxProperties",
]);

function stripBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripBounds);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (BOUNDS_KEYWORDS.has(key)) continue;
      out[key] = stripBounds(value);
    }
    return out;
  }
  return node;
}

/* ─────────────────────────── usage accounting ─────────────────────────── */

export type UsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

const totals: UsageTotals = {
  calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
};

function record(usage: Anthropic.Usage | undefined): void {
  if (!usage) return;
  totals.calls++;
  totals.inputTokens += usage.input_tokens ?? 0;
  totals.outputTokens += usage.output_tokens ?? 0;
  totals.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
}

/** Token usage since the process started. Useful for seeing what a run costs. */
export function usageTotals(): Readonly<UsageTotals> {
  return { ...totals };
}

/** $ per million tokens, base input and output. */
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/**
 * What the run so far actually cost, and what it would have cost with no
 * caching — the second figure is the only way to know whether the breakpoints
 * are earning their keep.
 *
 * Cache reads bill at 0.1x base input. Cache writes bill at 2x on the 1-hour
 * TTL this app uses, so the break-even is three requests sharing a prefix, not
 * two. A scoring run does twenty or more, which is why it pays here.
 */
export function estimateCost(model: string): {
  spent: number;
  withoutCaching: number;
  saved: number;
  savedPercent: number;
} {
  const price = PRICING[model] ?? PRICING["claude-opus-5"];
  const { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens } = totals;

  const spent =
    (inputTokens / 1e6) * price.in +
    (cacheWriteTokens / 1e6) * price.in * 2 +
    (cacheReadTokens / 1e6) * price.in * 0.1 +
    (outputTokens / 1e6) * price.out;

  // Without caching every cached token would have been billed as fresh input.
  const withoutCaching =
    ((inputTokens + cacheWriteTokens + cacheReadTokens) / 1e6) * price.in +
    (outputTokens / 1e6) * price.out;

  const saved = withoutCaching - spent;
  return {
    spent,
    withoutCaching,
    saved,
    savedPercent: withoutCaching > 0 ? Math.round((saved / withoutCaching) * 100) : 0,
  };
}

export function resetUsage(): void {
  totals.calls = 0;
  totals.inputTokens = 0;
  totals.outputTokens = 0;
  totals.cacheWriteTokens = 0;
  totals.cacheReadTokens = 0;
}

/* ───────────────────────────── the calls ──────────────────────────────── */

/**
 * Ask for a single tool call and return its typed input.
 *
 * `strict: true` guarantees the arguments validate against the schema, which is
 * what makes it safe to gate autonomous sending on a score.
 */
/**
 * Above this the SDK refuses a non-streaming request, because a long generation
 * can outlive the HTTP timeout. Streaming costs nothing extra and removes the
 * ceiling, so anything large goes down that path automatically.
 */
const STREAM_ABOVE = 16_000;

export async function structured<T>(opts: {
  system: string | SystemBlock[];
  prompt: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: Effort;
  /** Defaults to MODEL. Pass BULK_MODEL for high-volume judgement. */
  model?: string;
}): Promise<T> {
  const maxTokens = opts.maxTokens ?? 8000;
  const params = {
    model: opts.model ?? MODEL,
    max_tokens: maxTokens,
    system: toSystemParam(opts.system),
    thinking: { type: "adaptive" as const },
    output_config: { effort: opts.effort ?? "medium" },
    tools: [
      {
        name: opts.toolName,
        description: opts.toolDescription,
        input_schema: stripBounds(opts.schema) as Anthropic.Tool.InputSchema,
        strict: true,
      },
    ],
    tool_choice: { type: "tool" as const, name: opts.toolName },
    messages: [{ role: "user" as const, content: opts.prompt }],
  };

  const res =
    maxTokens > STREAM_ABOVE
      ? await anthropic().messages.stream(params).finalMessage()
      : await anthropic().messages.create(params);

  record(res.usage);

  if (res.stop_reason === "refusal") {
    throw new Error(
      `Model declined the request (${res.stop_details?.category ?? "unspecified"})`,
    );
  }

  const block = res.content.find((c) => c.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(
      `Model returned no tool call (stop_reason: ${res.stop_reason ?? "unknown"})`,
    );
  }
  return block.input as T;
}

/** Plain text completion. Kept for ad-hoc prose; the pipeline uses structured(). */
export async function text(opts: {
  system: string | SystemBlock[];
  prompt: string;
  maxTokens?: number;
  effort?: Effort;
  model?: string;
}): Promise<string> {
  const res = await anthropic().messages.create({
    model: opts.model ?? MODEL,
    max_tokens: opts.maxTokens ?? 8000,
    system: toSystemParam(opts.system),
    thinking: { type: "adaptive" },
    output_config: { effort: opts.effort ?? "medium" },
    messages: [{ role: "user", content: opts.prompt }],
  });

  record(res.usage);

  if (res.stop_reason === "refusal") {
    throw new Error(
      `Model declined the request (${res.stop_details?.category ?? "unspecified"})`,
    );
  }

  return res.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}
