"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type RunState = {
  running: string | null;
  lastSummary: string | null;
};

const TASKS = [
  { id: "discover", label: "Find jobs", hint: "Search every source, then score what comes back" },
  { id: "score", label: "Score more", hint: "Judge the next batch of unscored jobs against your CV" },
  { id: "inbox", label: "Check inbox", hint: "Look for replies to applications already sent" },
  { id: "apply", label: "Run auto-apply", hint: "Send to everything above your threshold" },
] as const;

/**
 * Starts work on the server and polls for completion.
 *
 * Deliberately not a Server Action: those are serialised and block router
 * navigation, so one long job froze every other button and tab in the app.
 * A plain fetch leaves the router free, so tabs keep working while this runs.
 */
export function RunBar({ initial }: { initial: RunState }) {
  const router = useRouter();
  const [state, setState] = useState<RunState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/run", { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as RunState;
      setState((prev) => {
        // A run that just ended is the moment the page data is stale.
        if (prev.running && !next.running) router.refresh();
        return next;
      });
    } catch {
      /* a dropped poll is not worth surfacing */
    }
  }, [router]);

  useEffect(() => {
    if (!state.running) return;
    timer.current = setTimeout(poll, 2500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [state.running, state, poll]);

  async function start(task: string, label: string) {
    setError(null);
    setPending(task);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task }),
      });
      const body = (await res.json()) as { started?: boolean; running?: string; message?: string };
      if (!res.ok || !body.started) {
        setError(body.message ?? "Could not start");
      } else {
        setState({ running: body.running ?? label, lastSummary: null });
      }
    } catch {
      setError("Network error");
    } finally {
      setPending(null);
    }
  }

  const busy = Boolean(state.running);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {TASKS.map((task) => (
        <button
          key={task.id}
          type="button"
          title={task.hint}
          disabled={busy || pending === task.id}
          onClick={() => start(task.id, task.label)}
          className="btn"
        >
          {pending === task.id ? "Starting…" : task.label}
        </button>
      ))}

      {state.running && (
        <span className="pill pill-warn">
          <Spinner /> {state.running}
        </span>
      )}

      {!state.running && state.lastSummary && (
        <span className="text-[12px]" style={{ color: "var(--muted)" }}>
          {state.lastSummary}
        </span>
      )}

      {error && (
        <span className="text-[12px]" style={{ color: "var(--bad)" }}>{error}</span>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-current"
      style={{ borderTopColor: "transparent" }}
    />
  );
}
