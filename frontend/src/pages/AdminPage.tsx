import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type AdminStats,
  type FeatureFlagRow,
  type AdminUserPage,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageLoader, StatCard } from "../components/ui";
import { useToast } from "../lib/toast";
import { IconUsers, IconApplications, IconChart, IconShield } from "../components/icons";

type Tab = "overview" | "flags" | "users";

export default function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  if (!user?.is_superuser) return <Navigate to="/" replace />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-muted">Platform health, usage, feature flags, and users.</p>
      </div>
      <div className="flex gap-1 border-b border-white/[0.08]">
        {(["overview", "flags", "users"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize transition ${
              tab === t ? "border-brand-600 text-content" : "border-transparent text-subtle hover:text-content"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "overview" && <Overview />}
      {tab === "flags" && <Flags />}
      {tab === "users" && <Users />}
    </div>
  );
}

function Overview() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: () => api.get<AdminStats>("/admin/stats"),
  });
  if (isLoading) return <PageLoader label="Loading admin…" />;
  if (isError || !data) return <div className="py-16 text-center text-sm text-danger">Couldn't load admin stats.</div>;

  const purposes = Object.entries(data.cost_by_purpose).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Users" value={String(data.total_users)} icon={<IconUsers className="h-5 w-5" />} tone="brand" />
        <StatCard label="Active (30d)" value={String(data.active_users_30d)} icon={<IconChart className="h-5 w-5" />} tone="blue" />
        <StatCard label="Applications" value={String(data.total_applications)} icon={<IconApplications className="h-5 w-5" />} tone="pink" />
        <StatCard label="Total AI spend" value={`$${data.total_cost_usd.toFixed(4)}`} icon={<IconShield className="h-5 w-5" />} tone="emerald" />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="card p-5">
          <h2 className="section-title">Usage</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Verified users" value={data.verified_users} />
            <Row label="Résumés" value={data.total_resumes} />
            <Row label="LLM calls" value={data.total_llm_calls} />
            <Row label="Input tokens" value={data.total_input_tokens.toLocaleString()} />
            <Row label="Output tokens" value={data.total_output_tokens.toLocaleString()} />
          </dl>
        </div>
        <div className="card p-5">
          <h2 className="section-title">Cost by purpose</h2>
          {purposes.length === 0 ? (
            <p className="mt-3 text-sm text-subtle">No usage yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {purposes.map(([p, cost]) => (
                <li key={p} className="flex justify-between text-sm">
                  <span className="capitalize text-muted">{p.replace(/_/g, " ")}</span>
                  <span className="tabular-nums text-muted">${cost.toFixed(4)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card p-5">
          <h2 className="section-title">Recent signups</h2>
          <ul className="mt-3 space-y-2.5">
            {data.recent_signups.map((u) => (
              <li key={u.email} className="text-sm">
                <div className="flex items-center gap-2">
                  <span className="truncate text-content">{u.full_name || u.email}</span>
                  {u.is_verified && <span className="badge-emerald text-[10px]">verified</span>}
                </div>
                <div className="text-xs text-subtle">
                  {u.applications} application{u.applications === 1 ? "" : "s"} · {new Date(u.created_at).toLocaleDateString()}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Flags() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-flags"],
    queryFn: () => api.get<FeatureFlagRow[]>("/admin/flags"),
  });
  const toggle = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      api.put<FeatureFlagRow>(`/admin/flags/${key}`, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-flags"] });
      toast.success("Flag updated");
    },
    onError: (e) => toast.error("Couldn't update", e instanceof ApiError ? e.message : undefined),
  });

  if (isLoading || !data) return <PageLoader label="Loading flags…" />;

  return (
    <div className="card divide-y divide-white/[0.06] p-2">
      {data.map((f) => (
        <div key={f.key} className="flex items-center justify-between gap-4 p-3">
          <div className="min-w-0">
            <div className="font-mono text-sm text-content">{f.key}</div>
            <div className="text-xs text-subtle">{f.description}</div>
          </div>
          <button
            onClick={() => toggle.mutate({ key: f.key, enabled: !f.enabled })}
            className={`relative h-6 w-11 shrink-0 rounded-full transition ${f.enabled ? "bg-emerald" : "bg-white/15"}`}
            aria-pressed={f.enabled}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${f.enabled ? "left-[22px]" : "left-0.5"}`} />
          </button>
        </div>
      ))}
    </div>
  );
}

function Users() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["admin-users", q],
    queryFn: () => api.get<AdminUserPage>(`/admin/users?limit=50${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "suspend" | "reactivate" }) =>
      api.post(`/admin/users/${id}/${action}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast.success("Done");
    },
    onError: (e) => toast.error("Couldn't update", e instanceof ApiError ? e.message : undefined),
  });

  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); setQ(input.trim()); }} className="max-w-xs">
        <input className="input" placeholder="Search email or name…" value={input} onChange={(e) => setInput(e.target.value)} />
      </form>
      {isLoading || !data ? (
        <PageLoader label="Loading users…" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">User</th>
                  <th className="px-4 py-3 text-right font-medium">Apps</th>
                  <th className="px-4 py-3 text-right font-medium">Calls</th>
                  <th className="px-4 py-3 text-right font-medium">Cost</th>
                  <th className="px-4 py-3 text-right font-medium">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.id} className="table-row">
                    <td className="px-4 py-3">
                      <div className="font-medium text-content">{u.full_name || u.email}</div>
                      <div className="text-xs text-subtle">{u.email}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted">{u.applications}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted">{u.llm_calls}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted">${u.total_cost_usd.toFixed(4)}</td>
                    <td className="px-4 py-3 text-right">
                      {u.is_superuser ? (
                        <span className="badge-brand text-[10px]">admin</span>
                      ) : u.is_active ? (
                        <span className="badge-emerald text-[10px]">active</span>
                      ) : (
                        <span className="badge-danger text-[10px]">suspended</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!u.is_superuser && (
                        <button
                          onClick={() => act.mutate({ id: u.id, action: u.is_active ? "suspend" : "reactivate" })}
                          className={`btn-ghost btn-sm ${u.is_active ? "text-danger hover:bg-danger/10" : "text-emerald hover:bg-emerald/10"}`}
                        >
                          {u.is_active ? "Suspend" : "Reactivate"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-white/[0.06] px-4 py-2 text-xs text-subtle">
            {data.users.length} of {data.total} users
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold tabular-nums text-content">{value}</dd>
    </div>
  );
}
