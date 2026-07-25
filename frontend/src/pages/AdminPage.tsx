import { Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type AdminStats } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageLoader, StatCard } from "../components/ui";
import { IconUsers, IconApplications, IconChart, IconShield } from "../components/icons";

export default function AdminPage() {
  const { user } = useAuth();
  if (!user?.is_superuser) return <Navigate to="/" replace />;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: () => api.get<AdminStats>("/admin/stats"),
  });

  if (isLoading) return <PageLoader label="Loading admin…" />;
  if (isError || !data) {
    return <div className="py-16 text-center text-sm text-danger">Couldn't load admin stats.</div>;
  }

  const purposes = Object.entries(data.cost_by_purpose).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-muted">Platform health, usage, and cost.</p>
      </div>

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

        <div className="card p-5 lg:col-span-1">
          <h2 className="section-title">Recent signups</h2>
          <ul className="mt-3 space-y-2.5">
            {data.recent_signups.map((u) => (
              <li key={u.email} className="text-sm">
                <div className="flex items-center gap-2">
                  <span className="truncate text-content">{u.full_name || u.email}</span>
                  {u.is_verified && <span className="badge-emerald text-[10px]">verified</span>}
                </div>
                <div className="text-xs text-subtle">
                  {u.applications} application{u.applications === 1 ? "" : "s"} ·{" "}
                  {new Date(u.created_at).toLocaleDateString()}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
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
