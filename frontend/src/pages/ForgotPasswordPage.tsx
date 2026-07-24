import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { IconLetter } from "../components/icons";
import { Wordmark } from "../components/Logo";
import { Spinner } from "../components/ui";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/forgot-password", { email });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <Wordmark size="text-xl" />
        </div>

        {sent ? (
          <div className="card p-6 text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-brand-500/12 text-brand-300">
              <IconLetter className="h-6 w-6" />
            </div>
            <h1 className="text-lg font-semibold">Check your inbox</h1>
            <p className="mt-2 text-sm text-muted">
              If an account exists for <span className="text-content">{email}</span>, a
              reset link is on its way. It expires in 30 minutes.
            </p>
            <Link to="/login" className="btn-secondary mt-6 w-full">
              Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
            <p className="mt-1 text-sm text-muted">
              Enter your email and we'll send you a link to set a new one.
            </p>
            <form onSubmit={onSubmit} className="mt-8 space-y-4">
              <div>
                <label className="label" htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  required
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </div>
              {error && (
                <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
                  {error}
                </div>
              )}
              <button type="submit" disabled={busy} className="btn-primary btn-lg w-full">
                {busy ? <><Spinner className="h-4 w-4" /> Sending…</> : "Send reset link"}
              </button>
            </form>
            <Link
              to="/login"
              className="mt-6 block text-center text-sm text-muted transition hover:text-content"
            >
              Back to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
