import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, fetchAll, type ApplicationSummary, type TrackerStatus } from "../lib/api";
import { PipelineBadge, TRACKER_STYLES } from "../components/StatusBadge";
import { PageLoader, EmptyState } from "../components/ui";
import { useToast } from "../lib/toast";
import { IconApplications, IconSearch } from "../components/icons";
import { BOARD_COLUMNS, columnFor, ALL_STAGES, trackerLabel } from "../lib/tracker";

const ACTIVE = new Set(["pending", "scraping", "extracting", "optimizing", "rendering"]);
type View = "board" | "list";
type AppPage = { items: ApplicationSummary[]; total: number; truncated: boolean };

export default function ApplicationsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("board");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<TrackerStatus | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["applications"],
    queryFn: () => fetchAll<ApplicationSummary>("/applications"),
    refetchInterval: (q) =>
      (q.state.data?.items ?? []).some((a) => ACTIVE.has(a.pipeline_status)) ? 3000 : false,
  });
  const applications = data?.items ?? [];
  const total = data?.total ?? applications.length;
  const truncated = data?.truncated ?? false;

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TrackerStatus }) =>
      api.patch(`/applications/${id}`, { tracker_status: status }),
    // Optimistic: the card jumps columns instantly, then reconciles.
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ["applications"] });
      const prev = queryClient.getQueryData<AppPage>(["applications"]);
      queryClient.setQueryData<AppPage>(["applications"], (old) =>
        old
          ? {
              ...old,
              items: old.items.map((a) =>
                a.id === id ? { ...a, tracker_status: status } : a,
              ),
            }
          : old,
      );
      return { prev };
    },
    // Rolling back silently made a failed move look like a UI glitch: the card
    // simply snapped back with no explanation.
    onError: (err, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["applications"], ctx.prev);
      toast.error(
        "Couldn't move that application",
        err instanceof ApiError ? err.message : "Please try again.",
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["tracker-stats"] });
      queryClient.invalidateQueries({ queryKey: ["analytics-overview"] });
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

  function onDrop(status: TrackerStatus) {
    setOverCol(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const app = applications.find((a) => a.id === id);
    if (app && app.tracker_status !== status) move.mutate({ id, status });
  }

  if (isLoading) return <PageLoader label="Loading applications…" />;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
          <p className="text-sm text-muted">{total} total · drag cards to move them</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-white/[0.08] bg-surface-2 p-0.5">
            {(["board", "list"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition ${
                  view === v ? "bg-brand-600 text-white" : "text-muted hover:text-content"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          <Link to="/new" className="btn-primary">New application</Link>
        </div>
      </div>

      {applications.length === 0 ? (
        <EmptyState
          icon={<IconApplications className="h-6 w-6" />}
          title="No applications yet"
          description="Paste a job posting and HireCraft will tailor your résumé to it."
          action={<Link to="/new" className="btn-primary">New application</Link>}
        />
      ) : (
        <>
          {truncated && (
            <div className="mb-4 rounded-xl border border-coral/30 bg-coral/10 px-3 py-2.5 text-sm text-coral">
              Showing the {applications.length} most recent of {total} applications.
              Older ones aren't on the board or in this search — narrow it down by
              stage, or archive what you've finished with.
            </div>
          )}

          <div className="mb-4 relative max-w-xs">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
            <input
              className="input pl-9"
              placeholder="Search role or company…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {view === "board" ? (
            <div className="-mx-1 flex gap-3 overflow-x-auto pb-4">
              {BOARD_COLUMNS.map((col) => {
                const items = filtered.filter((a) => columnFor(a.tracker_status) === col.status);
                const isOver = overCol === col.status;
                return (
                  <div
                    key={col.status}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (overCol !== col.status) setOverCol(col.status);
                    }}
                    onDragLeave={(e) => {
                      // Only clear when truly leaving the column, not entering a child.
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol(null);
                    }}
                    onDrop={() => onDrop(col.status)}
                    className={`flex w-64 shrink-0 flex-col rounded-2xl border p-2 transition ${
                      isOver
                        ? "border-brand-500/60 bg-brand-500/[0.06]"
                        : "border-white/[0.06] bg-surface-2/50"
                    }`}
                  >
                    <div className="mb-2 flex items-center gap-2 px-2 py-1">
                      <span className={`h-2 w-2 rounded-full ${col.accent}`} />
                      <span className="text-xs font-semibold text-muted">{col.label}</span>
                      <span className="ml-auto text-xs text-subtle">{items.length}</span>
                    </div>
                    <div className="flex min-h-[3rem] flex-col gap-2">
                      {items.map((a) => (
                        <BoardCard
                          key={a.id}
                          app={a}
                          onDragStart={() => setDragId(a.id)}
                          onDragEnd={() => {
                            setDragId(null);
                            setOverCol(null);
                          }}
                          dragging={dragId === a.id}
                        />
                      ))}
                      {items.length === 0 && (
                        <div className="rounded-xl border border-dashed border-white/[0.07] py-6 text-center text-[11px] text-subtle">
                          Drop here
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
                            className={`${TRACKER_STYLES[a.tracker_status]} cursor-pointer appearance-none border-0 pr-6`}
                          >
                            {ALL_STAGES.map((s) => (
                              <option key={s} value={s} className="bg-surface text-content">
                                {trackerLabel(s)}
                              </option>
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
        </>
      )}
    </div>
  );
}

function BoardCard({
  app,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  app: ApplicationSummary;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  const interview = app.interview_at ? new Date(app.interview_at) : null;
  const upcoming = interview && interview.getTime() > Date.now();
  return (
    <Link
      to={`/applications/${app.id}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`block cursor-grab rounded-xl border border-white/[0.07] bg-surface p-3 transition hover:border-white/[0.16] active:cursor-grabbing ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <div className="truncate text-sm font-medium text-content">
        {app.job_title ?? "Untitled role"}
      </div>
      <div className="truncate text-xs text-subtle">{app.company ?? "—"}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <PipelineBadge status={app.pipeline_status} />
        {interview && (
          <span
            className={`badge text-[10px] ${upcoming ? "badge-brand" : "badge-muted"}`}
            title={`Interview ${interview.toLocaleString()}`}
          >
            🗓 {interview.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </span>
        )}
        {app.has_notes && <span className="text-xs text-subtle" title="Has notes">📝</span>}
      </div>
    </Link>
  );
}
