import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, isExpired, tokens, type User } from "./api";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName?: string) => Promise<void>;
  logout: () => void;
  /** Re-fetch the current user (after settings changes, verification, etc.). */
  refreshUser: () => Promise<void>;
  /** Merge partial fields into the cached user without a round-trip. */
  patchUser: (patch: Partial<User>) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    // Revoke this device's session server-side; ignore failures (we clear
    // locally regardless, so the user is signed out even if the call fails).
    api.post("/auth/logout").catch(() => {});
    tokens.clear();
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      setUser(await api.get<User>("/auth/me"));
    } catch {
      /* stay with the cached user on a transient failure */
    }
  }, []);

  const patchUser = useCallback((patch: Partial<User>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  // The API client fires this when a refresh fails, so an expired session in a
  // background query still tears down the UI state.
  useEffect(() => {
    const onLogout = () => setUser(null);
    window.addEventListener("hirecraft:logout", onLogout);
    return () => window.removeEventListener("hirecraft:logout", onLogout);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // No token, or one that has already expired with no refresh to rescue it:
      // calling /auth/me would be a guaranteed 401, which the browser logs as a
      // console error that reads like a real failure on an ordinary signed-out
      // visit. Go straight to the login screen instead.
      if (!tokens.access || (isExpired(tokens.access) && isExpired(tokens.refresh))) {
        tokens.clear();
        setLoading(false);
        return;
      }
      try {
        const me = await api.get<User>("/auth/me");
        if (!cancelled) setUser(me);
      } catch {
        tokens.clear();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ access_token: string; refresh_token: string }>(
      "/auth/login",
      { email, password },
    );
    tokens.set(res.access_token, res.refresh_token);
    setUser(await api.get<User>("/auth/me"));
  }, []);

  const register = useCallback(
    async (email: string, password: string, fullName?: string) => {
      const res = await api.post<{ access_token: string; refresh_token: string }>(
        "/auth/register",
        { email, password, full_name: fullName || null },
      );
      tokens.set(res.access_token, res.refresh_token);
      setUser(await api.get<User>("/auth/me"));
    },
    [],
  );

  const value = useMemo(
    () => ({ user, loading, login, register, logout, refreshUser, patchUser }),
    [user, loading, login, register, logout, refreshUser, patchUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
}
