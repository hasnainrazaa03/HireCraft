import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useToast } from "../lib/toast";
import { Wordmark } from "../components/Logo";
import { Spinner } from "../components/ui";

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const toast = useToast();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/reset-password", { token, new_password: password });
      toast.success("Password reset", "Sign in with your new password.");
      navigate("/login");
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

        <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
        <p className="mt-1 text-sm text-muted">Choose a strong password you don't use elsewhere.</p>

        {!token ? (
          <div className="mt-6 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
            This reset link is missing its token. Request a new one from the sign-in page.
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <div>
              <label className="label" htmlFor="password">New password</label>
              <input
                id="password"
                type="password"
                required
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <p className="mt-1.5 text-xs text-subtle">At least 10 characters.</p>
            </div>
            <div>
              <label className="label" htmlFor="confirm">Confirm password</label>
              <input
                id="confirm"
                type="password"
                required
                className="input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            {error && (
              <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
                {error}
              </div>
            )}
            <button type="submit" disabled={busy} className="btn-primary btn-lg w-full">
              {busy ? <><Spinner className="h-4 w-4" /> Resetting…</> : "Reset password"}
            </button>
          </form>
        )}

        <Link to="/login" className="mt-6 block text-center text-sm text-muted transition hover:text-content">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
