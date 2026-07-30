import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  fetchAll,
  type AnalyticsOverview,
  type ApplicationSummary,
  type TrackerStats,
  type TrackerStatus,
  type UsageSummary,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { StatCard, PageLoader, EmptyState } from "../components/ui";
import { ActivityFeed } from "./AnalyticsPage";
import {
  IconApplications,
  IconChart,
  IconSparkles,
  IconResume,
  IconLetter,
  IconShield,
  IconArrowRight,
} from "../components/icons";

const ACTIVE_PIPELINE = new Set([
  "pending",
  "scraping",
  "extracting",
  "optimizing",
  "rendering",
]);

const BOARD: { status: TrackerStatus; label: string; accent: string }[] = [
  { status: "preparing", label: "Preparing", accent: "bg-coral" },
  { status: "applied", label: "Applied", accent: "bg-electric" },
  { status: "screening", label: "Screening", accent: "bg-brand-400" },
  { status: "interviewing", label: "Interviewing", accent: "bg-hotpink" },
  { status: "offer", label: "Offer", accent: "bg-emerald" },
  { status: "rejected", label: "Closed", accent: "bg-danger" },
];

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function DashboardPage() {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["applications"],
    queryFn: () => fetchAll<ApplicationSummary>("/applications"),
    refetchInterval: (q) =>
      (q.state.data?.items ?? []).some((a) => ACTIVE_PIPELINE.has(a.pipeline_status))
        ? 3000
        : false,
  });
  const applications = data?.items ?? [];

  const { data: stats } = useQuery({
    queryKey: ["tracker-stats"],
    queryFn: () => api.get<TrackerStats>("/analytics/tracker"),
  });

  const { data: usage } = useQuery({
    queryKey: ["usage-mini"],
    queryFn: () => api.get<UsageSummary>("/analytics/usage?days=30"),
  });

  const { data: overview } = useQuery({
    queryKey: ["analytics-overview"],
    queryFn: () => api.get<AnalyticsOverview>("/analytics/overview"),
  });

  const grouped = useMemo(() => {
    // Fold the full tracker stage set into the dashboard's summary columns. This
    // mirrors the Applications board: a draft is "Preparing" (not yet submitted),
    // NOT "Applied" — otherwise the dashboard claims an application you haven't
    // sent, and the card the board files under Preparing looks missing here.
    const bucket: Record<TrackerStatus, TrackerStatus> = {
      wishlist: "preparing", saved: "preparing", preparing: "preparing",
      draft: "preparing",
      applied: "applied", assessment: "applied",
      screening: "screening",
      interviewing: "interviewing", technical: "interviewing",
      behavioral: "interviewing", final: "interviewing",
      offer: "offer", accepted: "offer",
      rejected: "rejected", ghosted: "rejected",
      withdrawn: "rejected", archived: "rejected",
    };
    const map = new Map<string, ApplicationSummary[]>();
    for (const c of BOARD) map.set(c.status, []);
    for (const a of applications) map.get(bucket[a.tracker_status])?.push(a);
    return map;
  }, [applications]);

  const counts = stats?.counts ?? {};
  const active = applications.filter((a) => ACTIVE_PIPELINE.has(a.pipeline_status)).length;
  const interviews = counts.interviewing ?? 0;
  const offers = counts.offer ?? 0;

  if (isLoading) return <PageLoader label="Loading your dashboard…" />;

  return (
    <div className="space-y-7">
      {/* Greeting */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {greeting()}, {user?.full_name?.split(" ")[0] || "there"} 👋
          </h1>
          <p className="mt-1 text-sm text-muted">Let's craft your next opportunity.</p>
        </div>
        <Link to="/new" className="btn-primary">
          <IconSparkles className="h-4 w-4" />
          Tailor a résumé
        </Link>
      </div>

      {applications.length === 0 ? (
        <EmptyState
          icon={<IconApplications className="h-6 w-6" />}
          title="No applications yet"
          description="Add your master résumé, then paste a job posting to generate a tailored, ATS-ready PDF in seconds."
          action={
            <>
              <Link to="/resumes" className="btn-secondary">Add résumé</Link>
              <Link to="/new" className="btn-primary">New application</Link>
            </>
          }
        />
      ) : (
        <>
          {/* Stat row */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Total applications"
              value={String(applications.length)}
              icon={<IconApplications className="h-5 w-5" />}
              tone="brand"
            />
            <StatCard
              label="In progress"
              value={String(active)}
              icon={<IconSparkles className="h-5 w-5" />}
              tone="coral"
            />
            <StatCard
              label="Interviewing"
              value={String(interviews)}
              icon={<IconChart className="h-5 w-5" />}
              tone="pink"
            />
            <StatCard
              label="Offers"
              value={String(offers)}
              icon={<IconShield className="h-5 w-5" />}
              tone="emerald"
              trend={offers > 0 ? { value: "🎉", positive: true } : undefined}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            {/* Pipeline board */}
            <div className="card p-5 lg:col-span-2">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="section-title">Application pipeline</h2>
                <Link
                  to="/applications"
                  className="flex items-center gap-1 text-sm text-brand-300 hover:text-brand-200"
                >
                  View all <IconArrowRight className="h-4 w-4" />
                </Link>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                {BOARD.map((col) => {
                  const items = grouped.get(col.status) ?? [];
                  return (
                    <div key={col.status} className="min-w-0">
                      <div className="mb-2 flex items-center gap-2 px-1">
                        <span className={`h-2 w-2 rounded-full ${col.accent}`} />
                        <span className="text-xs font-medium text-muted">{col.label}</span>
                        <span className="ml-auto text-xs text-subtle">{items.length}</span>
                      </div>
                      <div className="space-y-2">
                        {items.slice(0, 4).map((a) => (
                          <Link
                            key={a.id}
                            to={`/applications/${a.id}`}
                            className="block rounded-xl border border-white/[0.06] bg-surface-2 p-2.5 transition hover:border-white/[0.14] hover:bg-surface-3"
                          >
                            <div className="truncate text-xs font-medium text-content">
                              {a.job_title ?? "Untitled role"}
                            </div>
                            <div className="truncate text-[11px] text-subtle">
                              {a.company ?? "—"}
                            </div>
                          </Link>
                        ))}
                        {items.length === 0 && (
                          <div className="rounded-xl border border-dashed border-white/[0.07] py-4 text-center text-[11px] text-subtle">
                            Empty
                          </div>
                        )}
                        {items.length > 4 && (
                          <div className="text-center text-[11px] text-subtle">
                            +{items.length - 4} more
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Side column: rates + activity + quick actions + cost */}
            <div className="space-y-5">
              {overview && overview.funnel.submitted > 0 && (
                <div className="card p-5">
                  <h3 className="section-title text-base">Success rates</h3>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <RateChip label="Response" value={overview.funnel.response_rate} tone="text-electric" />
                    <RateChip label="Interview" value={overview.funnel.interview_rate} tone="text-hotpink" />
                    <RateChip label="Offer" value={overview.funnel.offer_rate} tone="text-emerald" />
                  </div>
                  <Link to="/analytics" className="mt-3 flex items-center justify-center gap-1 text-xs text-brand-300 hover:text-brand-200">
                    Full analytics <IconArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              )}

              {overview && overview.activity.length > 0 && (
                <div className="card p-5">
                  <h3 className="section-title text-base">Recent activity</h3>
                  <ActivityFeed items={overview.activity.slice(0, 5)} />
                </div>
              )}

              <div className="card p-5">
                <h3 className="section-title text-base">Quick actions</h3>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Link to="/new" className="btn-secondary flex-col gap-1.5 !py-3 text-xs">
                    <IconSparkles className="h-4 w-4 text-brand-300" />
                    Tailor résumé
                  </Link>
                  <Link to="/resumes" className="btn-secondary flex-col gap-1.5 !py-3 text-xs">
                    <IconResume className="h-4 w-4 text-electric" />
                    My résumés
                  </Link>
                  <Link to="/applications" className="btn-secondary flex-col gap-1.5 !py-3 text-xs">
                    <IconApplications className="h-4 w-4 text-hotpink" />
                    Applications
                  </Link>
                  <Link to="/analytics" className="btn-secondary flex-col gap-1.5 !py-3 text-xs">
                    <IconChart className="h-4 w-4 text-coral" />
                    Analytics
                  </Link>
                </div>
              </div>

              {usage && (
                <div className="card p-5">
                  <div className="flex items-center justify-between">
                    <h3 className="section-title text-base">This month</h3>
                    <IconLetter className="h-4 w-4 text-subtle" />
                  </div>
                  <div className="mt-3 flex items-end justify-between">
                    <div>
                      <div className="text-2xl font-semibold tabular-nums text-gradient">
                        ${usage.total_cost_usd.toFixed(4)}
                      </div>
                      <div className="text-xs text-muted">AI spend, 30 days</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium text-content">
                        {usage.applications}
                      </div>
                      <div className="text-xs text-subtle">applications</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RateChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-surface-2 py-2.5">
      <div className={`text-lg font-semibold tabular-nums ${tone}`}>
        {Math.round(value * 100)}%
      </div>
      <div className="text-[11px] text-subtle">{label}</div>
    </div>
  );
}
