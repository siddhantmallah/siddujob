import { adzuna } from "./adzuna";
import { reed } from "./reed";
import { greenhouse, lever, ashby } from "./ats";
import { arbeitnow, remotive, jobicy, jooble } from "./feeds";
import type { JobSource, RawJob, SourceContext } from "./types";

export * from "./types";

export const ALL_SOURCES: JobSource[] = [
  adzuna, reed, greenhouse, lever, ashby, arbeitnow, remotive, jobicy, jooble,
];

export function activeSources(): JobSource[] {
  return ALL_SOURCES.filter((s) => s.enabled());
}

export type SourceResult = {
  source: string;
  count: number;
  ms: number;
  error?: string;
};

/**
 * Runs every configured source. One failing board must never abort a run — a
 * dead feed just contributes zero jobs and is reported in the summary.
 */
export async function fetchAllSources(
  ctx: SourceContext,
): Promise<{ jobs: RawJob[]; results: SourceResult[] }> {
  const sources = activeSources();

  const settled = await Promise.all(
    sources.map(async (source): Promise<{ jobs: RawJob[]; result: SourceResult }> => {
      const started = Date.now();
      try {
        const jobs = await source.fetch(ctx);
        return {
          jobs,
          result: { source: source.name, count: jobs.length, ms: Date.now() - started },
        };
      } catch (err) {
        return {
          jobs: [],
          result: {
            source: source.name,
            count: 0,
            ms: Date.now() - started,
            error: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }),
  );

  return {
    jobs: settled.flatMap((s) => s.jobs),
    results: settled.map((s) => s.result),
  };
}
