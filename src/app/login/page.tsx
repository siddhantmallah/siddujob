import { redirect } from "next/navigation";
import { isAuthed } from "@/lib/auth";
import { login } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/Forms";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await isAuthed()) redirect("/");

  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="panel w-full max-w-sm p-7">
        <h1 className="text-lg font-bold tracking-tight">Job Finder</h1>
        <p className="hint mb-5">
          Private tool. One password, no accounts.
        </p>

        <ActionForm action={login}>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoFocus
            autoComplete="current-password"
            className="input"
            required
          />
          <div className="mt-4">
            <SubmitButton>Sign in</SubmitButton>
          </div>
        </ActionForm>
      </div>
    </div>
  );
}
