import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

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

/** A system prompt segment. `cache: true` marks a caching breakpoint after it. */
export type SystemBlock = { text: string; cache?: boolean };

function toSystemParam(
  system: string | SystemBlock[],
): string | Anthropic.TextBlockParam[] {
  if (typeof system === "string") return system;
  return system
    .filter((b) => b.text.trim())
    .map((b) => ({
      type: "text" as const,
      text: b.text,
      ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
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
}): Promise<T> {
  const maxTokens = opts.maxTokens ?? 8000;
  const params = {
    model: MODEL,
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
}): Promise<string> {
  const res = await anthropic().messages.create({
    model: MODEL,
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
