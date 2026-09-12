"use client";

import { useActionState, useTransition, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/app/actions";

export function SubmitButton({
  children, variant = "primary", className = "",
}: { children: React.ReactNode; variant?: "primary" | "plain"; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`btn ${variant === "primary" ? "btn-primary" : ""} ${className}`}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

export function Feedback({ state }: { state: ActionState }) {
  if (!state?.error && !state?.message) return null;
  const bad = Boolean(state.error);
  return (
    <div
      className="rounded-lg px-3 py-2 text-[13px]"
      style={{
        background: bad ? "var(--bad-soft)" : "var(--good-soft)",
        color: bad ? "var(--bad)" : "var(--good)",
      }}
    >
      {state.error ?? state.message}
    </div>
  );
}

/** Wraps a server action that takes (prevState, formData). */
export function ActionForm({
  action, children, className = "",
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className={className}>
      {children}
      <div className="mt-3">
        <Feedback state={state} />
      </div>
    </form>
  );
}

/**
 * A button that calls a zero-or-one-argument server action and shows the
 * result inline. Used for the one-click job actions.
 */
export function ActionButton({
  action, children, confirm, variant = "plain", title, compact = false,
}: {
  action: () => Promise<ActionState | void>;
  children: React.ReactNode;
  confirm?: string;
  variant?: "primary" | "plain" | "danger";
  title?: string;
  compact?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionState | null>(null);

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        title={title}
        disabled={pending}
        className={`btn ${variant === "primary" ? "btn-primary" : ""} ${variant === "danger" ? "btn-danger" : ""}`}
        style={compact ? { padding: "5px 9px", fontSize: 12 } : undefined}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          startTransition(async () => {
            const r = await action();
            setResult(r ?? { ok: true });
          });
        }}
      >
        {pending ? "Working…" : children}
      </button>
      {result?.error ? (
        <span className="text-[11px]" style={{ color: "var(--bad)" }}>{result.error}</span>
      ) : null}
      {result?.message ? (
        <span className="text-[11px]" style={{ color: "var(--good)" }}>{result.message}</span>
      ) : null}
    </span>
  );
}

/** Collapsible block — used for cover letter previews. */
export function Disclosure({
  label, children, defaultOpen = false,
}: { label: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[12px] font-semibold"
        style={{ color: "var(--accent)" }}
      >
        {open ? "Hide" : label}
      </button>
      {open ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      style={{ padding: "5px 9px", fontSize: 12 }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}
