import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type AnalyticsOverview,
  type ActivityItem,
  type NamedCount,
  type TimePoint,
  type UsageSummary,
  type HistoryInsights,
} from "../lib/api";
import { PageLoader, EmptyState } from "../components/ui";
import {
  IconApplications,
  IconChart,
  IconShield,
  IconResume,
  IconLetter,
  IconSparkles,
  IconCheck,
} from "../components/icons";

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export default function AnalyticsPage() {
  const { data: overview, isLoading } = useQuery({
    queryKey: ["analytics-overview"],
    queryFn: () => api.get<AnalyticsOverview>("/analytics/overview"),
  });

  const { data: usage } = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.get<UsageSummary>("/analytics/usage?days=30"),
  });

  const { data: history } = useQuery({
    queryKey: ["history-insights"],
    queryFn: () => api.get<HistoryInsights>("/insights/history"),
  });

  if (isLoading || !overview) return <PageLoader label="Crunching your numbers…" />;

  const { funnel, content, activity } = overview;
  const hasData = funnel.total > 0;

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-muted">
          Your whole job search, measured — funnel, momentum, and where you're
          landing.
        </p>
      </div>

      {!hasData ? (
        <EmptyState
          icon={<IconChart className="h-6 w-6" />}
          title="Nothing to chart yet"
          description="Tailor a résumé to a job posting and your funnel, rates, and activity will start filling in here."
          action={
            <Link to="/new" className="btn-primary">
              Tailor a résumé
            </Link>
          }
        />
      ) : (
        <>
          {/* Rate cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <RateCard
              label="Response rate"
              value={pct(funnel.response_rate)}
              sub={`${funnel.submitted} submitted`}
              tone="blue"
              icon={<IconApplications className="h-5 w-5" />}
            />
            <RateCard
              label="Interview rate"
              value={pct(funnel.interview_rate)}
              sub={`${funnel.interviewing} reached`}
              tone="pink"
              icon={<IconChart className="h-5 w-5" />}
            />
            <RateCard
              label="Offer rate"
              value={pct(funnel.offer_rate)}
              sub={`${funnel.offers} offer${funnel.offers === 1 ? "" : "s"}`}
              tone="emerald"
              icon={<IconShield className="h-5 w-5" />}
            />
            <RateCard
              label="Avg résumé score"
              value={content.avg_resume_score != null ? `${content.avg_resume_score}` : "—"}
              sub={`${content.resume_count} résumé${content.resume_count === 1 ? "" : "s"}`}
              tone="brand"
              icon={<IconResume className="h-5 w-5" />}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            {/* Funnel + over-time */}
            <div className="space-y-5 lg:col-span-2">
              <div className="card p-5">
                <h2 className="section-title">Funnel</h2>
                <Funnel funnel={funnel} />
              </div>

              <div className="card p-5">
                <div className="flex items-center justify-between">
                  <h2 className="section-title">Applications over time</h2>
                  <span className="text-xs text-subtle">last 90 days</span>
                </div>
                <TimeChart points={overview.applications_over_time} />
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <Leaderboard
                  title="Top companies"
                  items={overview.top_companies}
                  empty="No companies yet."
                />
                <Leaderboard
                  title="Common titles"
                  items={overview.top_titles}
                  empty="No titles yet."
                />
              </div>

              <div className="card p-5">
                <h2 className="section-title">Keywords you're covering</h2>
                <p className="mt-1 text-xs text-subtle">
                  ATS terms verified as genuinely present in your tailored résumés
                  — not what any model claimed.
                </p>
                {overview.top_keywords.length === 0 ? (
                  <p className="mt-4 text-sm text-subtle">No keywords tracked yet.</p>
                ) : (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {overview.top_keywords.map((k) => (
                      <span key={k.name} className="badge-emerald">
                        {k.name}
                        <span className="ml-1.5 opacity-70">×{k.count}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Side: content stats, best résumé, activity */}
            <div className="space-y-5">
              <div className="card p-5">
                <h2 className="section-title">What you've built</h2>
                <dl className="mt-4 space-y-3 text-sm">
                  <ContentRow icon={<IconResume className="h-4 w-4 text-electric" />} label="Résumés" value={content.resume_count} />
                  <ContentRow icon={<IconResume className="h-4 w-4 text-brand-300" />} label="Versions saved" value={content.resume_versions} />
                  <ContentRow icon={<IconSparkles className="h-4 w-4 text-hotpink" />} label="Tailored résumés" value={content.tailored_resumes} />
                  <ContentRow icon={<IconLetter className="h-4 w-4 text-coral" />} label="Cover letters" value={content.cover_letters} />
                </dl>
              </div>

              {overview.best_resume && (
                <div className="hero-card bg-hero-purple p-5">
                  <div className="relative z-10">
                    <div className="flex items-center gap-2">
                      <IconShield className="h-5 w-5 text-white" />
                      <span className="text-sm font-semibold text-white">Top performer</span>
                    </div>
                    <p className="mt-2 text-lg font-semibold text-white">
                      {overview.best_resume.name}
                    </p>
                    <p className="text-xs text-white/80">
                      {overview.best_resume.count > 0
                        ? `Landed ${overview.best_resume.count} interview${overview.best_resume.count === 1 ? "" : "s"}`
                        : "Your most-used résumé"}
                    </p>
                  </div>
                </div>
              )}

              <div className="card p-5">
                <h2 className="section-title">Recent activity</h2>
                <ActivityFeed items={activity} />
              </div>
            </div>
          </div>
        </>
      )}

      {/* Résumé performance — which version wins */}
      {history && history.resumes.length > 0 && (
        <div className="card p-5">
          <h2 className="section-title">Résumé performance</h2>
          <p className="mt-1 text-xs text-subtle">
            Which résumé actually lands interviews — reuse what's working.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Résumé</th>
                  <th className="px-3 py-2 text-right font-medium">Apps</th>
                  <th className="px-3 py-2 text-right font-medium">Interviews</th>
                  <th className="px-3 py-2 text-right font-medium">Offers</th>
                  <th className="px-3 py-2 text-right font-medium">Response</th>
                </tr>
              </thead>
              <tbody>
                {history.resumes.map((r) => (
                  <tr key={r.resume_profile_id} className="table-row">
                    <td className="px-3 py-2">
                      {r.name}
                      {r.resume_profile_id === history.best_resume_id && (
                        <span className="badge-emerald ml-2 text-[10px]">Top performer</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{r.applications}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{r.interviews}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{r.offers}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">
                      {Math.round(r.response_rate * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {history.winning_keywords.length > 0 && (
            <div className="mt-4">
              <p className="text-xs text-subtle">Keywords your interview-winning applications covered:</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {history.winning_keywords.map((k) => (
                  <span key={k} className="badge-emerald">{k}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Usage & cost */}
      {usage && (
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <h2 className="section-title">Usage &amp; cost</h2>
            <span className="text-xs text-subtle">last 30 days</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MiniStat label="Total spend" value={`$${usage.total_cost_usd.toFixed(4)}`} />
            <MiniStat label="Per application" value={`$${usage.average_cost_per_application.toFixed(4)}`} />
            <MiniStat label="Applications" value={usage.applications.toLocaleString()} />
            <MiniStat label="LLM calls" value={usage.total_calls.toLocaleString()} />
          </div>
        </div>
      )}
    </div>
  );
}

function RateCard({
  label,
  value,
  sub,
  tone,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "brand" | "blue" | "pink" | "emerald";
  icon: React.ReactNode;
}) {
  const ring: Record<string, string> = {
    brand: "bg-brand-500/12 text-brand-300",
    blue: "bg-electric/12 text-electric",
    pink: "bg-hotpink/12 text-hotpink",
    emerald: "bg-emerald/12 text-emerald",
  };
  return (
    <div className="card card-hover p-5">
      <div className={`grid h-11 w-11 place-items-center rounded-xl ${ring[tone]}`}>
        {icon}
      </div>
      <div className="mt-4 text-2xl font-semibold tabular-nums text-content">{value}</div>
      <div className="mt-0.5 text-sm text-muted">{label}</div>
      <div className="mt-1 text-xs text-subtle">{sub}</div>
    </div>
  );
}

/** A left-to-right funnel from submitted down to offers. */
function Funnel({
  funnel,
}: {
  funnel: AnalyticsOverview["funnel"];
}) {
  const stages = [
    { label: "Submitted", value: funnel.submitted, tone: "bg-electric" },
    { label: "Interviewing", value: funnel.interviewing, tone: "bg-hotpink" },
    { label: "Offers", value: funnel.offers, tone: "bg-emerald" },
  ];
  const max = Math.max(funnel.submitted, 1);
  return (
    <div className="mt-4 space-y-3">
      {stages.map((s) => (
        <div key={s.label}>
          <div className="mb-1 flex justify-between text-sm">
            <span className="text-muted">{s.label}</span>
            <span className="tabular-nums text-content">{s.value}</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={`h-full rounded-full ${s.tone} transition-all`}
              style={{ width: `${Math.max((s.value / max) * 100, s.value > 0 ? 4 : 0)}%` }}
            />
          </div>
        </div>
      ))}
      <div className="flex gap-4 pt-1 text-xs text-subtle">
        <span>{funnel.active} in progress</span>
        <span>{funnel.closed} closed</span>
      </div>
    </div>
  );
}

function TimeChart({ points }: { points: TimePoint[] }) {
  if (points.length === 0) {
    return <p className="mt-6 text-center text-sm text-subtle">No applications in this window.</p>;
  }
  const peak = Math.max(...points.map((p) => p.count), 1);
  const total = points.reduce((sum, p) => sum + p.count, 0);
  return (
    <>
      <div className="mt-5 flex h-40 items-end gap-1">
        {points.map((p) => (
          <div
            key={p.date}
            className="group relative flex flex-1 flex-col justify-end"
            title={`${p.date}: ${p.count} application${p.count === 1 ? "" : "s"}`}
          >
            <div
              className="w-full rounded-t bg-brand-600/85 transition group-hover:bg-brand-500"
              style={{ height: `${Math.max((p.count / peak) * 100, 3)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs text-subtle">
        <span>{points[0].date}</span>
        <span>{total} total</span>
        <span>{points[points.length - 1].date}</span>
      </div>
    </>
  );
}

function Leaderboard({
  title,
  items,
  empty,
}: {
  title: string;
  items: NamedCount[];
  empty: string;
}) {
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <div className="card p-5">
      <h2 className="section-title">{title}</h2>
      {items.length === 0 ? (
        <p className="mt-4 text-sm text-subtle">{empty}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((item) => (
            <li key={item.name}>
              <div className="flex justify-between text-sm">
                <span className="truncate text-muted" title={item.name}>{item.name}</span>
                <span className="ml-2 shrink-0 tabular-nums text-subtle">{item.count}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full bg-brand-600"
                  style={{ width: `${(item.count / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ACTIVITY_META: Record<ActivityItem["kind"], { dot: string; icon: React.ReactNode }> = {
  application: { dot: "bg-electric", icon: <IconApplications className="h-3.5 w-3.5" /> },
  completed: { dot: "bg-brand-400", icon: <IconCheck className="h-3.5 w-3.5" /> },
  offer: { dot: "bg-emerald", icon: <IconShield className="h-3.5 w-3.5" /> },
  resume_version: { dot: "bg-coral", icon: <IconResume className="h-3.5 w-3.5" /> },
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return <p className="mt-4 text-sm text-subtle">No activity yet.</p>;
  }
  return (
    <ul className="mt-4 space-y-3">
      {items.map((item, i) => {
        const meta = ACTIVITY_META[item.kind];
        const inner = (
          <div className="flex items-start gap-3">
            <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg text-white ${meta.dot}`}>
              {meta.icon}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm text-content">{item.title}</div>
              <div className="text-xs text-subtle">
                {item.subtitle ? `${item.subtitle} · ` : ""}
                {timeAgo(item.at)}
              </div>
            </div>
          </div>
        );
        return (
          <li key={i}>
            {item.kind === "resume_version" ? (
              <Link to="/resumes" className="block rounded-lg transition hover:opacity-80">{inner}</Link>
            ) : item.ref ? (
              <Link to={`/applications/${item.ref}`} className="block rounded-lg transition hover:opacity-80">
                {inner}
              </Link>
            ) : (
              inner
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ContentRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-3">
      {icon}
      <dt className="text-muted">{label}</dt>
      <dd className="ml-auto font-semibold tabular-nums text-content">{value}</dd>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-surface-2 p-4">
      <div className="text-xs text-subtle">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
