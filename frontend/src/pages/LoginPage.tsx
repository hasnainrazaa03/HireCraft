import { useState, useEffect, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError, api } from "../lib/api";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "") + "/api/v1";
const PROVIDER_LABELS: Record<string, string> = { google: "Google", github: "GitHub" };
import { IconShield, IconCheck } from "../components/icons";
import { LogoMark, Wordmark } from "../components/Logo";
import { Spinner } from "../components/ui";

const HIGHLIGHTS = [
  "Tailor your résumé to any job in seconds",
  "Guardrails that never invent experience",
  "Track every application in one place",
];

export default function LoginPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);

  useEffect(() => {
    // Show OAuth buttons only for providers configured on the server.
    api
      .get<{ providers: string[] }>("/auth/oauth/providers")
      .then((r) => setProviders(r.providers))
      .catch(() => setProviders([]));
    // Surface an error the OAuth callback bounced back with.
    const err = new URLSearchParams(window.location.search).get("oauth_error");
    if (err) setError("Sign-in with that provider didn't complete. Please try again.");
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password, fullName);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden lg:block">
        <div className="absolute inset-0 bg-hero-gradient opacity-90" />
        <div className="absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_120%,rgba(0,0,0,0.5),transparent)]" />
        <div className="relative z-10 flex h-full flex-col justify-between p-12">
          <div className="flex items-center gap-2.5 text-white">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/15 backdrop-blur">
              <LogoMark className="h-6 w-6" />
            </span>
            <span className="text-xl font-semibold tracking-tight">HireCraft</span>
          </div>

          <div className="max-w-md">
            <h1 className="text-4xl font-semibold leading-tight tracking-tight text-white">
              Craft your story.<br />Land your dream role.
            </h1>
            <p className="mt-3 text-white/80">
              Tailor your résumé to any job — without inventing a thing.
            </p>
            <ul className="mt-8 space-y-3">
              {HIGHLIGHTS.map((h) => (
                <li key={h} className="flex items-center gap-3 text-white/90">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/20">
                    <IconCheck className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-sm">{h}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center gap-2 text-sm text-white/70">
            <IconShield className="h-4 w-4" />
            Your data stays private. Guardrails keep every claim truthful.
          </div>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Wordmark size="text-xl" />
          </div>

          <h2 className="text-2xl font-semibold tracking-tight">
            {mode === "login" ? "Welcome back" : "Create your account"}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {mode === "login"
              ? "Sign in to craft your next opportunity."
              : "Start tailoring résumés that stay true to you."}
          </p>

          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            {mode === "register" && (
              <div>
                <label className="label" htmlFor="fullName">Full name</label>
                <input
                  id="fullName"
                  className="input"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  autoComplete="name"
                />
              </div>
            )}

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

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="label mb-0" htmlFor="password">Password</label>
                {mode === "login" && (
                  <Link to="/forgot-password" className="text-xs text-brand-300 transition hover:text-brand-200">
                    Forgot password?
                  </Link>
                )}
              </div>
              <input
                id="password"
                type="password"
                required
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
              {mode === "register" && (
                <p className="mt-1.5 text-xs text-subtle">At least 10 characters.</p>
              )}
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
              >
                {error}
              </div>
            )}

            <button type="submit" disabled={busy} className="btn-primary btn-lg w-full">
              {busy ? (
                <><Spinner className="h-4 w-4" /> Please wait…</>
              ) : mode === "login" ? (
                "Sign in"
              ) : (
                "Create account"
              )}
            </button>
          </form>

          {providers.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center gap-3 text-xs text-subtle">
                <span className="h-px flex-1 bg-white/[0.08]" />
                or continue with
                <span className="h-px flex-1 bg-white/[0.08]" />
              </div>
              <div className="mt-4 flex gap-2">
                {providers.map((p) => (
                  <a
                    key={p}
                    href={`${API_BASE}/auth/oauth/${p}/authorize`}
                    className="btn-secondary flex-1 justify-center"
                  >
                    {PROVIDER_LABELS[p] ?? p}
                  </a>
                ))}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
            className="mt-6 w-full text-center text-sm text-muted transition hover:text-content"
          >
            {mode === "login" ? (
              <>No account? <span className="text-brand-300">Create one</span></>
            ) : (
              <>Already have an account? <span className="text-brand-300">Sign in</span></>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
