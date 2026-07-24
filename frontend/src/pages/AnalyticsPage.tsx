import { useQuery } from "@tanstack/react-query";
import { api, type UsageSummary } from "../lib/api";

export default function AnalyticsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.get<UsageSummary>("/analytics/usage?days=30"),
  });

  if (isLoading || !data) {
    return <div className="py-16 text-center text-subtle">Loading…</div>;
  }

  const peak = Math.max(...data.by_day.map((d) => d.cost_usd), 0.000001);
  const purposes = Object.entries(data.by_purpose).sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Usage &amp; cost</h1>
      <p className="text-sm text-muted">Last 30 days</p>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total spend" value={`$${data.total_cost_usd.toFixed(4)}`} />
        <Stat
          label="Per application"
          value={`$${data.average_cost_per_application.toFixed(4)}`}
        />
        <Stat label="Applications" value={data.applications.toLocaleString()} />
        <Stat label="LLM calls" value={data.total_calls.toLocaleString()} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <h2 className="text-sm font-medium">Daily spend</h2>
          {data.by_day.length === 0 ? (
            <p className="mt-6 text-center text-sm text-subtle">
              No usage recorded yet.
            </p>
          ) : (
            <div className="mt-5 flex h-44 items-end gap-1">
              {data.by_day.map((day) => (
                <div
                  key={day.date}
                  className="group relative flex flex-1 flex-col justify-end"
                  title={`${day.date}: $${day.cost_usd.toFixed(4)} · ${day.calls} calls`}
                >
                  <div
                    className="w-full rounded-t bg-brand-600/85 transition group-hover:bg-brand-600"
                    style={{
                      height: `${Math.max((day.cost_usd / peak) * 100, 2)}%`,
                    }}
                  />
                </div>
              ))}
            </div>
          )}
          {data.by_day.length > 0 && (
            <div className="mt-2 flex justify-between text-xs text-subtle">
              <span>{data.by_day[0].date}</span>
              <span>{data.by_day[data.by_day.length - 1].date}</span>
            </div>
          )}
        </div>

        <div className="card p-5">
          <h2 className="text-sm font-medium">Cost by stage</h2>
          {purposes.length === 0 ? (
            <p className="mt-6 text-center text-sm text-subtle">No data yet.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {purposes.map(([purpose, cost]) => (
                <li key={purpose}>
                  <div className="flex justify-between text-sm">
                    <span className="capitalize text-muted">
                      {purpose.replace(/_/g, " ")}
                    </span>
                    <span className="tabular-nums text-muted">
                      ${cost.toFixed(4)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-brand-600"
                      style={{
                        width: `${(cost / (purposes[0][1] || 1)) * 100}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-6 border-t border-white/[0.06] pt-4 text-xs text-subtle">
            <div className="flex justify-between">
              <span>Input tokens</span>
              <span className="tabular-nums">
                {data.total_input_tokens.toLocaleString()}
              </span>
            </div>
            <div className="mt-1 flex justify-between">
              <span>Output tokens</span>
              <span className="tabular-nums">
                {data.total_output_tokens.toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-subtle">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
