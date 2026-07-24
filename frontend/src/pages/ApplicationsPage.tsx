import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ApplicationSummary, type TrackerStatus } from "../lib/api";
import { PipelineBadge, TRACKER_STYLES } from "../components/StatusBadge";
import { PageLoader, EmptyState } from "../components/ui";
import { IconApplications, IconSearch } from "../components/icons";

const ACTIVE = new Set(["pending", "scraping", "extracting", "optimizing", "rendering"]);

export default function ApplicationsPage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");

  const { data: applications = [], isLoading } = useQuery({
    queryKey: ["applications"],
    queryFn: () => api.get<ApplicationSummary[]>("/applications?limit=200"),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((a) => ACTIVE.has(a.pipeline_status)) ? 3000 : false,
  });

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TrackerStatus }) =>
      api.patch(`/applications/${id}`, { tracker_status: status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["tracker-stats"] });
    },
  });

  const filtered = applications.filter((a) => {
    const q = query.toLowerCase();
    return (
      !q ||
      (a.job_title ?? "").toLowerCase().includes(q) ||
      (a.company ?? "").toLowerCase().includes(q)
    );
  });

  if (isLoading) return <PageLoader label="Loading applications…" />;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
          <p className="text-sm text-muted">{applications.length} total</p>
        </div>
        <Link to="/new" className="btn-primary">New application</Link>
      </div>

      {applications.length === 0 ? (
        <EmptyState
          icon={<IconApplications className="h-6 w-6" />}
          title="No applications yet"
          description="Paste a job posting and HireCraft will tailor your résumé to it."
          action={<Link to="/new" className="btn-primary">New application</Link>}
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="border-b border-white/[0.07] p-3">
            <div className="relative max-w-xs">
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
              <input
                className="input pl-9"
                placeholder="Search role or company…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Company</th>
                  <th className="px-4 py-3 font-medium">Pipeline</th>
                  <th className="px-4 py-3 font-medium">Stage</th>
                  <th className="px-4 py-3 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr key={a.id} className="table-row">
                    <td className="px-4 py-3">
                      <Link to={`/applications/${a.id}`} className="font-medium hover:text-brand-300">
                        {a.job_title ?? "Untitled role"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted">{a.company ?? "—"}</td>
                    <td className="px-4 py-3"><PipelineBadge status={a.pipeline_status} /></td>
                    <td className="px-4 py-3">
                      <select
                        value={a.tracker_status}
                        onChange={(e) => move.mutate({ id: a.id, status: e.target.value as TrackerStatus })}
                        className={`${TRACKER_STYLES[a.tracker_status]} cursor-pointer border-0 capitalize`}
                      >
                        {Object.keys(TRACKER_STYLES).map((s) => (
                          <option key={s} value={s} className="bg-surface text-content">{s}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted">
                      ${a.total_cost_usd.toFixed(4)}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-subtle">No matches.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
