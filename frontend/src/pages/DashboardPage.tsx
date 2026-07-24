import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type ApplicationSummary,
  type TrackerStats,
  type TrackerStatus,
} from "../lib/api";
import { PipelineBadge, TRACKER_STYLES } from "../components/StatusBadge";

const COLUMNS: { status: TrackerStatus; label: string }[] = [
  { status: "draft", label: "Draft" },
  { status: "applied", label: "Applied" },
  { status: "screening", label: "Screening" },
  { status: "interviewing", label: "Interviewing" },
  { status: "offer", label: "Offer" },
  { status: "rejected", label: "Closed" },
];

const ACTIVE_PIPELINE = new Set([
  "pending",
  "scraping",
  "extracting",
  "optimizing",
  "rendering",
]);

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"board" | "list">("board");

  const { data: applications = [], isLoading } = useQuery({
    queryKey: ["applications"],
    queryFn: () => api.get<ApplicationSummary[]>("/applications?limit=200"),
    // Poll while anything is still generating so the board self-updates.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((a) => ACTIVE_PIPELINE.has(a.pipeline_status))
        ? 3000
        : false,
  });

  const { data: stats } = useQuery({
    queryKey: ["tracker-stats"],
    queryFn: () => api.get<TrackerStats>("/analytics/tracker"),
  });

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TrackerStatus }) =>
      api.patch(`/applications/${id}`, { tracker_status: status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["tracker-stats"] });
    },
  });

  const grouped = useMemo(() => {
    const map = new Map<string, ApplicationSummary[]>();
    for (const column of COLUMNS) map.set(column.status, []);
    for (const application of applications) {
      // Terminal states share the "Closed" column.
      const key = ["rejected", "ghosted", "withdrawn"].includes(
        application.tracker_status,
      )
        ? "rejected"
        : application.tracker_status;
      map.get(key)?.push(application);
    }
    return map;
  }, [applications]);

  if (isLoading) {
    return <div className="py-16 text-center text-ink-500">Loading applications…</div>;
  }

  if (applications.length === 0) {
    return (
      <div className="card mx-auto max-w-md p-10 text-center">
        <h2 className="text-lg font-semibold">No applications yet</h2>
        <p className="mt-2 text-sm text-ink-600">
          Add your master resume, then paste a job posting to generate a tailored,
          ATS-ready PDF.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link to="/resumes" className="btn-secondary">
            Add resume
          </Link>
          <Link to="/new" className="btn-primary">
            New application
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Applications</h1>
          <p className="text-sm text-ink-600">
            {stats?.total ?? applications.length} tracked
          </p>
        </div>
        <div className="flex rounded-lg border border-ink-200 bg-white p-0.5">
          {(["board", "list"] as const).map((option) => (
            <button
              key={option}
              onClick={() => setView(option)}
              className={`rounded-md px-3 py-1 text-sm font-medium capitalize transition ${
                view === option ? "bg-ink-900 text-white" : "text-ink-600"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {view === "board" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {COLUMNS.map((column) => {
            const items = grouped.get(column.status) ?? [];
            return (
              <div key={column.status} className="min-w-0">
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-sm font-medium text-ink-800">
                    {column.label}
                  </span>
                  <span className="text-xs text-ink-500">{items.length}</span>
                </div>
                <div className="space-y-2">
                  {items.map((application) => (
                    <Link
                      key={application.id}
                      to={`/applications/${application.id}`}
                      className="card block p-3 transition hover:border-ink-300 hover:shadow"
                    >
                      <div className="truncate text-sm font-medium">
                        {application.job_title ?? "Untitled role"}
                      </div>
                      <div className="truncate text-xs text-ink-600">
                        {application.company ?? "Unknown company"}
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <PipelineBadge status={application.pipeline_status} />
                        <span className="text-[11px] tabular-nums text-ink-500">
                          ${application.total_cost_usd.toFixed(4)}
                        </span>
                      </div>
                    </Link>
                  ))}
                  {items.length === 0 && (
                    <div className="rounded-lg border border-dashed border-ink-200 py-6 text-center text-xs text-ink-400">
                      Empty
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-ink-200 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-600">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium">Company</th>
                  <th className="px-4 py-2.5 font-medium">Pipeline</th>
                  <th className="px-4 py-2.5 font-medium">Stage</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {applications.map((application) => (
                  <tr key={application.id} className="hover:bg-ink-50">
                    <td className="px-4 py-2.5">
                      <Link
                        to={`/applications/${application.id}`}
                        className="font-medium hover:underline"
                      >
                        {application.job_title ?? "Untitled role"}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-ink-600">
                      {application.company ?? "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <PipelineBadge status={application.pipeline_status} />
                    </td>
                    <td className="px-4 py-2.5">
                      <select
                        value={application.tracker_status}
                        onChange={(e) =>
                          move.mutate({
                            id: application.id,
                            status: e.target.value as TrackerStatus,
                          })
                        }
                        className={`badge cursor-pointer border-0 capitalize ${
                          TRACKER_STYLES[application.tracker_status]
                        }`}
                      >
                        {Object.keys(TRACKER_STYLES).map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-600">
                      ${application.total_cost_usd.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
