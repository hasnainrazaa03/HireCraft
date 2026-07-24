import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type ApiKeyStatus, type SessionInfo, type User } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { useToast } from "../lib/toast";
import { Modal, Spinner } from "../components/ui";
import { IconCheck, IconShield, IconLogout, IconKey } from "../components/icons";

type Tab = "profile" | "security" | "sessions" | "notifications" | "data";

const TABS: { id: Tab; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "security", label: "Security" },
  { id: "sessions", label: "Devices" },
  { id: "notifications", label: "Notifications" },
  { id: "data", label: "Data" },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("profile");
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted">Manage your account, security, and preferences.</p>

      <div className="mt-6 flex gap-1 overflow-x-auto border-b border-white/[0.07]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition ${
              tab === t.id
                ? "border-brand-500 text-content"
                : "border-transparent text-muted hover:text-content"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="pt-6">
        {tab === "profile" && <ProfileSection />}
        {tab === "security" && <SecuritySection />}
        {tab === "sessions" && <SessionsSection />}
        {tab === "notifications" && <NotificationsSection />}
        {tab === "data" && <DataSection />}
      </div>
    </div>
  );
}

function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="card mb-5 p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-5">{children}</div>
    </div>
  );
}

// --- Profile -----------------------------------------------------------------

function ProfileSection() {
  const { user, patchUser } = useAuth();
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const [fullName, setFullName] = useState(user?.full_name ?? "");

  const save = useMutation({
    mutationFn: (body: Partial<User>) => api.patch<User>("/account/settings", body),
    onSuccess: (updated) => {
      patchUser(updated);
      toast.success("Saved", "Your profile has been updated.");
    },
    onError: (e) => toast.error("Couldn't save", e instanceof ApiError ? e.message : undefined),
  });

  return (
    <>
      <Card title="Profile" description="Your name shown across HireCraft.">
        <div className="max-w-sm">
          <label className="label" htmlFor="name">Full name</label>
          <input id="name" className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          <button
            onClick={() => save.mutate({ full_name: fullName })}
            disabled={save.isPending}
            className="btn-primary mt-4"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </Card>

      <Card title="Appearance" description="Choose how HireCraft looks. Applies to this account.">
        <div className="flex gap-3">
          {(["dark", "light"] as const).map((option) => (
            <button
              key={option}
              onClick={() => {
                setTheme(option);
                save.mutate({ theme: option });
              }}
              className={`flex-1 rounded-xl border p-4 text-left capitalize transition ${
                theme === option
                  ? "border-brand-500/60 bg-brand-500/10"
                  : "border-white/[0.08] hover:border-white/[0.16]"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{option}</span>
                {theme === option && <IconCheck className="h-4 w-4 text-brand-300" />}
              </div>
              <div
                className={`mt-3 h-10 rounded-lg border border-white/[0.06] ${
                  option === "dark" ? "bg-[#0A0B12]" : "bg-[#F4F6FB]"
                }`}
              />
            </button>
          ))}
        </div>
      </Card>
    </>
  );
}

// --- Security ----------------------------------------------------------------

function SecuritySection() {
  const { user } = useAuth();
  const toast = useToast();

  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);

  const [newEmail, setNewEmail] = useState("");
  const [emailPw, setEmailPw] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);

  const changePw = useMutation({
    mutationFn: () =>
      api.post("/auth/change-password", {
        current_password: cur,
        new_password: next,
        logout_other_sessions: true,
      }),
    onSuccess: () => {
      toast.success("Password changed", "Other devices have been signed out.");
      setCur(""); setNext(""); setConfirm("");
    },
    onError: (e) => setPwError(e instanceof ApiError ? e.message : "Couldn't change password."),
  });

  const changeEmail = useMutation({
    mutationFn: () => api.post("/auth/change-email", { new_email: newEmail, password: emailPw }),
    onSuccess: () => {
      toast.success("Confirm your new email", "We sent a verification link to the new address.");
      setNewEmail(""); setEmailPw("");
    },
    onError: (e) => setEmailError(e instanceof ApiError ? e.message : "Couldn't change email."),
  });

  const resendVerify = useMutation({
    mutationFn: () => api.post("/auth/resend-verification"),
    onSuccess: () => toast.success("Verification sent", "Check your inbox."),
    onError: (e) => toast.error("Couldn't send", e instanceof ApiError ? e.message : undefined),
  });

  function submitPw(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    if (next !== confirm) return setPwError("New passwords don't match.");
    changePw.mutate();
  }

  return (
    <>
      {user && !user.is_verified && (
        <div className="card mb-5 flex items-center gap-4 border-coral/30 bg-coral/5 p-4">
          <IconShield className="h-5 w-5 shrink-0 text-coral" />
          <div className="flex-1 text-sm">
            <div className="font-medium text-content">Your email isn't verified</div>
            <div className="text-muted">Verify it to secure your account.</div>
          </div>
          <button onClick={() => resendVerify.mutate()} disabled={resendVerify.isPending} className="btn-secondary btn-sm">
            {resendVerify.isPending ? "Sending…" : "Resend"}
          </button>
        </div>
      )}

      <Card title="Change password" description="Changing it signs out your other devices.">
        <form onSubmit={submitPw} className="max-w-sm space-y-4">
          <div>
            <label className="label" htmlFor="cur">Current password</label>
            <input id="cur" type="password" className="input" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
          </div>
          <div>
            <label className="label" htmlFor="next">New password</label>
            <input id="next" type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
            <p className="mt-1.5 text-xs text-subtle">At least 10 characters.</p>
          </div>
          <div>
            <label className="label" htmlFor="confirm">Confirm new password</label>
            <input id="confirm" type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </div>
          {pwError && <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">{pwError}</div>}
          <button type="submit" disabled={changePw.isPending} className="btn-primary">
            {changePw.isPending ? "Changing…" : "Change password"}
          </button>
        </form>
      </Card>

      <Card title="Change email" description={`Current: ${user?.email ?? ""}. We'll confirm the new address before switching.`}>
        <form onSubmit={(e) => { e.preventDefault(); setEmailError(null); changeEmail.mutate(); }} className="max-w-sm space-y-4">
          <div>
            <label className="label" htmlFor="newEmail">New email</label>
            <input id="newEmail" type="email" className="input" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="emailPw">Confirm with password</label>
            <input id="emailPw" type="password" className="input" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} autoComplete="current-password" required />
          </div>
          {emailError && <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">{emailError}</div>}
          <button type="submit" disabled={changeEmail.isPending} className="btn-primary">
            {changeEmail.isPending ? "Sending…" : "Send confirmation"}
          </button>
        </form>
      </Card>

      <ApiKeySection />
    </>
  );
}

// --- Bring-your-own Gemini key ----------------------------------------------

function ApiKeySection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");

  const { data: status } = useQuery({
    queryKey: ["api-key"],
    queryFn: () => api.get<ApiKeyStatus>("/account/api-key"),
  });

  const save = useMutation({
    mutationFn: () => api.put<ApiKeyStatus>("/account/api-key", { api_key: key }),
    onSuccess: (s) => {
      queryClient.setQueryData(["api-key"], s);
      setKey("");
      toast.success("API key saved", "Your runs now use your own Gemini quota.");
    },
    onError: (e) => toast.error("Key rejected", e instanceof ApiError ? e.message : undefined),
  });

  const remove = useMutation({
    mutationFn: () => api.delete("/account/api-key"),
    onSuccess: () => {
      queryClient.setQueryData(["api-key"], { configured: false, hint: null });
      toast.success("API key removed");
    },
  });

  return (
    <Card
      title="Your Gemini API key"
      description="Optional. Bring your own key and your tailoring runs bill your quota instead of the shared one. Stored encrypted; we validate it before saving."
    >
      {status?.configured ? (
        <div className="flex items-center justify-between rounded-xl border border-emerald/30 bg-emerald/5 p-4">
          <div className="flex items-center gap-2.5 text-sm">
            <IconKey className="h-4 w-4 text-emerald" />
            <span>Your key is active <span className="font-mono text-muted">({status.hint})</span></span>
          </div>
          <button onClick={() => remove.mutate()} className="btn-ghost btn-sm text-danger hover:bg-danger/10">
            Remove
          </button>
        </div>
      ) : (
        <div className="max-w-md">
          <label className="label" htmlFor="apikey">Gemini API key</label>
          <input
            id="apikey"
            type="password"
            className="input font-mono"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="AIza…"
            autoComplete="off"
          />
          <p className="mt-1.5 text-xs text-subtle">
            Get one free at aistudio.google.com/apikey.
          </p>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || key.trim().length < 10}
            className="btn-primary mt-3"
          >
            {save.isPending ? "Validating…" : "Save key"}
          </button>
        </div>
      )}
    </Card>
  );
}

// --- Sessions ----------------------------------------------------------------

function SessionsSection() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { logout } = useAuth();

  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.get<SessionInfo[]>("/auth/sessions"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      toast.success("Signed out of that device");
    },
  });

  const revokeAll = useMutation({
    mutationFn: () => api.post("/auth/logout-all"),
    onSuccess: () => {
      toast.info("Signed out everywhere", "You'll need to sign in again.");
      logout();
    },
  });

  function describe(ua: string | null): string {
    if (!ua) return "Unknown device";
    const browser = /Firefox/.test(ua) ? "Firefox" : /Edg/.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Browser";
    const os = /Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : "";
    return [browser, os].filter(Boolean).join(" · ");
  }

  return (
    <Card title="Active devices" description="Sessions currently signed in to your account.">
      {isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-surface-2 p-3.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {describe(s.user_agent)}
                  {s.current && <span className="badge-emerald">This device</span>}
                </div>
                <div className="text-xs text-subtle">
                  {s.ip_address ?? "unknown IP"} · last used {new Date(s.last_used_at).toLocaleString()}
                </div>
              </div>
              {!s.current && (
                <button onClick={() => revoke.mutate(s.id)} className="btn-ghost btn-sm text-danger hover:bg-danger/10">
                  Sign out
                </button>
              )}
            </div>
          ))}
          <button onClick={() => revokeAll.mutate()} className="btn-secondary mt-4">
            <IconLogout className="h-4 w-4" />
            Sign out of all devices
          </button>
        </div>
      )}
    </Card>
  );
}

// --- Notifications -----------------------------------------------------------

const NOTIFS: { key: string; label: string; description: string }[] = [
  { key: "product_emails", label: "Product emails", description: "Occasional updates about new features." },
  { key: "application_reminders", label: "Application reminders", description: "Nudges to follow up on applications." },
  { key: "weekly_summary", label: "Weekly summary", description: "A recap of your job-search activity." },
];

function NotificationsSection() {
  const { user, patchUser } = useAuth();
  const toast = useToast();
  const prefs = user?.notification_prefs ?? {};

  const save = useMutation({
    mutationFn: (p: Record<string, boolean>) => api.patch<User>("/account/settings", { notification_prefs: p }),
    onSuccess: (u) => patchUser(u),
    onError: (e) => toast.error("Couldn't save", e instanceof ApiError ? e.message : undefined),
  });

  return (
    <Card title="Email notifications" description="Choose what HireCraft emails you about.">
      <div className="space-y-1">
        {NOTIFS.map((n) => {
          const on = prefs[n.key] ?? true;
          return (
            <label key={n.key} className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-3 hover:bg-white/[0.03]">
              <div>
                <div className="text-sm font-medium">{n.label}</div>
                <div className="text-xs text-muted">{n.description}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                onClick={() => save.mutate({ ...prefs, [n.key]: !on })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-brand-600" : "bg-white/[0.12]"}`}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
              </button>
            </label>
          );
        })}
      </div>
    </Card>
  );
}

// --- Data / danger zone ------------------------------------------------------

function DataSection() {
  const toast = useToast();
  const { logout } = useAuth();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  async function exportData() {
    try {
      await api.download("/account/export", "hirecraft-export.json");
      toast.success("Export ready", "Your data has been downloaded.");
    } catch (e) {
      toast.error("Export failed", e instanceof ApiError ? e.message : undefined);
    }
  }

  const del = useMutation({
    mutationFn: () => api.delete("/account"),
    onSuccess: () => {
      toast.info("Account deleted");
      logout();
    },
    onError: (e) => toast.error("Couldn't delete", e instanceof ApiError ? e.message : undefined),
  });

  return (
    <>
      <Card title="Export your data" description="Download everything HireCraft holds for you as a JSON file.">
        <button onClick={exportData} className="btn-secondary">Download my data</button>
      </Card>

      <div className="card mb-5 border-danger/20 p-6">
        <h2 className="text-base font-semibold text-danger">Delete account</h2>
        <p className="mt-1 text-sm text-muted">
          Permanently deletes your account, résumés, applications, and generated files.
          This cannot be undone.
        </p>
        <button onClick={() => setConfirmOpen(true)} className="btn-danger mt-5">Delete my account</button>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => { setConfirmOpen(false); setConfirmText(""); }}
        title="Delete account?"
        footer={
          <>
            <button onClick={() => { setConfirmOpen(false); setConfirmText(""); }} className="btn-secondary">Cancel</button>
            <button
              onClick={() => del.mutate()}
              disabled={confirmText !== "DELETE" || del.isPending}
              className="btn-danger"
            >
              {del.isPending ? "Deleting…" : "Delete forever"}
            </button>
          </>
        }
      >
        <p className="text-sm text-muted">
          This erases everything and can't be undone. Type <span className="font-mono text-content">DELETE</span> to confirm.
        </p>
        <input
          className="input mt-4"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="DELETE"
        />
      </Modal>
    </>
  );
}
