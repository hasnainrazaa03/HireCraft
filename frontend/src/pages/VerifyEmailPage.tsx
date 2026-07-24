import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { IconCheck } from "../components/icons";
import { Wordmark } from "../components/Logo";
import { Spinner } from "../components/ui";

type State = "verifying" | "ok" | "error";

export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { user, refreshUser } = useAuth();
  const [state, setState] = useState<State>("verifying");
  const [message, setMessage] = useState("");
  // React 18 StrictMode double-invokes effects in dev; a single-use token would
  // then fail on the second call. Guard so we only submit once.
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    if (!token) {
      setState("error");
      setMessage("This verification link is missing its token.");
      return;
    }
    (async () => {
      try {
        await api.post("/auth/verify-email", { token });
        setState("ok");
        if (user) await refreshUser();
      } catch (err) {
        setState("error");
        setMessage(
          err instanceof ApiError
            ? err.message
            : "We couldn't verify your email. The link may have expired.",
        );
      }
    })();
  }, [token, user, refreshUser]);

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <Wordmark size="text-xl" />
        </div>

        <div className="card p-8">
          {state === "verifying" && (
            <>
              <Spinner className="mx-auto h-7 w-7" />
              <p className="mt-4 text-sm text-muted">Verifying your email…</p>
            </>
          )}
          {state === "ok" && (
            <>
              <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-emerald/12 text-emerald">
                <IconCheck className="h-6 w-6" />
              </div>
              <h1 className="text-lg font-semibold">Email verified</h1>
              <p className="mt-2 text-sm text-muted">Your email address is confirmed.</p>
              <Link to={user ? "/" : "/login"} className="btn-primary mt-6 w-full">
                {user ? "Go to dashboard" : "Sign in"}
              </Link>
            </>
          )}
          {state === "error" && (
            <>
              <h1 className="text-lg font-semibold text-danger">Verification failed</h1>
              <p className="mt-2 text-sm text-muted">{message}</p>
              <Link to={user ? "/settings" : "/login"} className="btn-secondary mt-6 w-full">
                {user ? "Back to settings" : "Back to sign in"}
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
