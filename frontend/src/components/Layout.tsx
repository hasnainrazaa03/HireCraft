import { NavLink, Link } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../lib/auth";

const NAV = [
  { to: "/", label: "Applications", end: true },
  { to: "/resumes", label: "Resumes", end: false },
  { to: "/analytics", label: "Usage", end: false },
];

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-ink-900 text-sm text-white">
              H
            </span>
            HireCraft
          </Link>

          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    isActive
                      ? "bg-ink-100 text-ink-900"
                      : "text-ink-600 hover:bg-ink-50 hover:text-ink-900"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <Link to="/new" className="btn-primary">
              New application
            </Link>
            <div className="hidden text-right sm:block">
              <div className="text-xs text-ink-500">{user?.email}</div>
              <button
                onClick={logout}
                className="text-xs font-medium text-ink-700 hover:text-ink-900 hover:underline"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
