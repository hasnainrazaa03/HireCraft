import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { tokens } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Spinner } from "../components/ui";

/**
 * Lands here after the provider → API callback redirects with tokens in the URL
 * fragment. We store them, refresh the user, and continue into the app. The
 * fragment never hits the network, so the tokens aren't logged server-side.
 */
export default function OAuthCallbackPage() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [error, setError] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const access = params.get("access_token");
    const refresh = params.get("refresh_token");
    if (!access || !refresh) {
      setError(true);
      return;
    }
    tokens.set(access, refresh);
    // Clear the fragment so tokens don't linger in the address bar / history.
    window.history.replaceState(null, "", window.location.pathname);
    refreshUser()
      .then(() => navigate("/", { replace: true }))
      .catch(() => setError(true));
  }, [navigate, refreshUser]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-danger">Sign-in couldn't be completed.</p>
        <button onClick={() => navigate("/login")} className="btn-secondary">
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center gap-3">
      <Spinner className="h-6 w-6" />
      <span className="text-sm text-muted">Signing you in…</span>
    </div>
  );
}
