import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, tokens, type User } from "./api";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    tokens.clear();
    setUser(null);
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
      if (!tokens.access) {
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
    () => ({ user, loading, login, register, logout }),
    [user, loading, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
}
