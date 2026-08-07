import { NavLink, Link, useLocation } from "react-router-dom";
import { useState, type ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";
import { IconShield } from "./icons";
import { Wordmark } from "./Logo";
import NotificationBell from "./NotificationBell";
import {
  IconDashboard,
  IconApplications,
  IconResume,
  IconLetter,
  IconSearch,
  IconChart,
  IconTarget,
  IconSparkles,
  IconSettings,
  IconTemplate,
  IconPlus,
  IconSun,
  IconMoon,
  IconLogout,
  IconChevronDown,
  IconUser,
  IconUsers,
  IconPen,
} from "./icons";

function VerifyBanner() {
  const toast = useToast();
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  if (dismissed) return null;

  async function resend() {
    setSending(true);
    try {
      await api.post("/auth/resend-verification");
      toast.success("Verification sent", "Check your inbox for the link.");
    } catch {
      toast.error("Couldn't send", "Please try again shortly.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="border-b border-coral/20 bg-coral/[0.07]">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm">
        <IconShield className="h-4 w-4 shrink-0 text-coral" />
        <span className="text-content">Confirm your email to secure your account.</span>
        <button onClick={resend} disabled={sending} className="font-medium text-coral hover:underline">
          {sending ? "Sending…" : "Resend link"}
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="ml-auto text-subtle transition hover:text-content"
          aria-label="Dismiss"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

const NAV = [
  { to: "/", label: "Dashboard", icon: IconDashboard, end: true },
  { to: "/copilot", label: "Copilot", icon: IconSparkles, end: false },
  { to: "/applications", label: "Applications", icon: IconApplications, end: false },
  { to: "/resumes", label: "Resumes", icon: IconResume, end: false },
  { to: "/profile", label: "Career Profile", icon: IconUser, end: false },
  { to: "/writing", label: "Writing Voice", icon: IconPen, end: false },
  { to: "/cover-letters", label: "Cover Letters", icon: IconLetter, end: false },
  { to: "/companies", label: "Company Intel", icon: IconUsers, end: false },
  { to: "/interview", label: "Interview Prep", icon: IconTarget, end: false },
  { to: "/jobs", label: "Job Search", icon: IconSearch, end: false },
  { to: "/analytics", label: "Analytics", icon: IconChart, end: false },
  { to: "/templates", label: "Templates", icon: IconTemplate, end: false },
  { to: "/admin", label: "Admin", icon: IconShield, end: false, adminOnly: true },
];

// Routes that exist today. Others render a "coming soon" placeholder so the nav
// can show the full product shape without dead links.
const LIVE_ROUTES = new Set([
  "/",
  "/copilot",
  "/applications",
  "/resumes",
  "/profile",
  "/writing",
  "/cover-letters",
  "/companies",
  "/interview",
  "/admin",
  "/analytics",
  "/jobs",
  "/templates",
  "/new",
]);

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  const initials = (user?.full_name || user?.email || "?")
    .split(/[\s@.]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");

  return (
    <div className="flex min-h-screen">
      {/* ---- Sidebar ---- */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-white/[0.06] bg-canvas-raised/70 px-4 py-5 backdrop-blur-xl lg:flex">
        <Link to="/" className="mb-7 px-2">
          <Wordmark />
        </Link>

        <nav className="flex flex-1 flex-col gap-1">
          {NAV.filter((item) => !item.adminOnly || user?.is_superuser).map((item) => {
            const Icon = item.icon;
            const live = LIVE_ROUTES.has(item.to);
            return (
              <NavLink
                key={item.to}
                to={live ? item.to : "#"}
                end={item.end}
                onClick={(e) => !live && e.preventDefault()}
                className={({ isActive }) =>
                  `nav-item ${isActive && live ? "nav-item-active" : ""} ${
                    !live ? "cursor-default opacity-45 hover:bg-transparent hover:text-muted" : ""
                  }`
                }
              >
                <Icon className="h-[18px] w-[18px]" />
                <span>{item.label}</span>
                {!live && (
                  <span className="ml-auto rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-subtle">
                    soon
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-white/[0.06] pt-3">
          <div className="flex items-center gap-2.5 px-1">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500/20 text-xs font-semibold text-brand-200">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-content">
                {user?.full_name || "Your account"}
              </div>
              <div className="truncate text-[11px] text-subtle">{user?.email}</div>
            </div>
          </div>
        </div>
      </aside>

      {/* ---- Main column ---- */}
      <div className="flex min-h-screen min-w-0 flex-1 flex-col lg:pl-64">
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-white/[0.06] bg-canvas/70 px-5 py-3.5 backdrop-blur-xl">
          {/* Global search isn't built yet. It was rendered as a live, focusable
              text box that silently did nothing on Enter; marked unavailable
              instead, the same way the sidebar flags routes that aren't live. */}
          <div className="relative hidden max-w-md flex-1 md:block">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
            <input
              className="input cursor-not-allowed pl-9 opacity-60"
              placeholder="Global search — coming soon"
              disabled
              aria-label="Global search (not yet available)"
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={toggle}
              className="btn-ghost h-9 w-9 !p-0"
              aria-label="Toggle theme"
              title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            >
              {theme === "dark" ? (
                <IconSun className="h-[18px] w-[18px]" />
              ) : (
                <IconMoon className="h-[18px] w-[18px]" />
              )}
            </button>

            <NotificationBell />

            <Link to="/new" className="btn-primary" aria-label="New application">
              <IconPlus className="h-4 w-4" />
              <span className="hidden sm:inline">New Application</span>
            </Link>

            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-surface-2 py-1.5 pl-1.5 pr-2.5 transition hover:border-white/[0.12]"
              >
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-500/20 text-xs font-semibold text-brand-200">
                  {initials}
                </span>
                <IconChevronDown className="h-4 w-4 text-subtle" />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  {/* Opaque surface, not glass: a translucent menu lets the bright
                      buttons behind it bleed through the blur. */}
                  <div className="absolute right-0 z-50 mt-2 w-52 animate-fade-in rounded-2xl border border-white/[0.1] bg-canvas-raised p-1.5 shadow-soft">
                    <div className="border-b border-white/[0.06] px-3 py-2">
                      <div className="truncate text-sm font-medium text-content">
                        {user?.full_name || "Signed in"}
                      </div>
                      <div className="truncate text-xs text-subtle">{user?.email}</div>
                    </div>
                    <Link
                      to="/settings"
                      onClick={() => setMenuOpen(false)}
                      className="nav-item mt-1 w-full"
                    >
                      <IconSettings className="h-[18px] w-[18px]" />
                      Settings
                    </Link>
                    <button
                      onClick={logout}
                      className="nav-item w-full text-danger hover:bg-danger/10 hover:text-danger"
                    >
                      <IconLogout className="h-[18px] w-[18px]" />
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Mobile nav strip */}
        <nav className="flex gap-1 overflow-x-auto border-b border-white/[0.06] px-3 py-2 lg:hidden">
          {/* The adminOnly filter has to be applied here too, not just in the
              sidebar: /admin is a live route, so below the lg breakpoint every
              user was shown an Admin link. The page itself redirects a
              non-superuser, so nothing leaked, but the link should not be there. */}
          {NAV.filter(
            (n) => LIVE_ROUTES.has(n.to) && (!n.adminOnly || user?.is_superuser),
          ).map((item) => {
            const Icon = item.icon;
            const active = item.end
              ? location.pathname === item.to
              : location.pathname.startsWith(item.to);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={`nav-item shrink-0 ${active ? "nav-item-active" : ""}`}
              >
                <Icon className="h-[18px] w-[18px]" />
                <span className="text-xs">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        {user && !user.is_verified && <VerifyBanner />}

        <main className="mx-auto w-full min-w-0 max-w-7xl flex-1 px-5 py-7">{children}</main>
      </div>
    </div>
  );
}
