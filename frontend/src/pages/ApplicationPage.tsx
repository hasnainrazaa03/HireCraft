import { useState, useEffect, useRef } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ApplicationDetail,
  type ApplicationStatus,
  type GuardrailViolation,
  type BulletConfidence,
  type TrackerStatus,
  type JobMatch,
  type Scorecard,
  type ScorecardSuggestion,
  type CopilotResponse,
  type DiffEntry,
} from "../lib/api";
import { PipelineBadge, TRACKER_STYLES } from "../components/StatusBadge";
import { DiffView, ConfidencePanel } from "../components/ReviewPanels";
import { Spinner } from "../components/ui";
import {
  IconResume, IconLetter, IconBriefcase, IconSparkles, IconPen,
  IconBell, IconRefresh, IconArrowRight, IconUpload,
} from "../components/icons";
import { ALL_STAGES, trackerLabel } from "../lib/tracker";
import { useToast } from "../lib/toast";

const ACTIVE = new Set([
  "pending",
  "scraping",
  "extracting",
  "optimizing",
  "rendering",
]);

type Tab = "overview" | "documents" | "activity" | "notes" | "emails" | "analytics";
type DocTab = "diff" | "match" | "guardrails" | "requirements" | "preview";

export default function ApplicationPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");
  const [docTab, setDocTab] = useState<DocTab>("diff");
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // A rejected download would otherwise be an unhandled promise rejection: the
  // button appears to do nothing and the user has no idea why.
  async function download(kind: string, fallbackName: string) {
    setDownloadError(null);
    try {
      await api.download(`/applications/${id}/download/${kind}`, fallbackName);
    } catch (err) {
      setDownloadError(
        err instanceof ApiError ? err.message : "Download failed. Please retry.",
      );
    }
  }

  // Cheap status poll drives the progress UI; the full record is refetched only
  // when the pipeline actually finishes.
  const { data: status } = useQuery({
    queryKey: ["application-status", id],
    queryFn: () => api.get<ApplicationStatus>(`/applications/${id}/status`),
    refetchInterval: (query) =>
      ACTIVE.has(query.state.data?.pipeline_status ?? "") ? 2000 : false,
  });

  // The pipeline status is part of the key so the full record is refetched as
  // the run advances. Keeping the previous data while the new key loads is what
  // makes that bearable: without it every transition (pending → extracting →
  // optimizing → rendering → completed) landed on a key with no cached data, so
  // `isLoading` flipped true and the whole page was replaced by "Loading…" —
  // five blank flashes during a single run, right where the user is watching
  // progress.
  const {
    data: application,
    isLoading,
    error: applicationError,
  } = useQuery({
    queryKey: ["application", id, status?.pipeline_status],
    queryFn: () => api.get<ApplicationDetail>(`/applications/${id}`),
    placeholderData: keepPreviousData,
  });

  // Deterministic fit score — only meaningful once the job has been analysed.
  const { data: match } = useQuery({
    queryKey: ["match", id],
    queryFn: () => api.get<JobMatch>(`/insights/applications/${id}/match`),
    enabled: !!application?.job?.requirements,
    retry: false,
  });

  const update = useMutation({
    mutationFn: (
      body: Partial<{
        tracker_status: TrackerStatus;
        notes: string;
        interview_at: string | null;
        reminder_at: string | null;
      }>,
    ) => api.patch(`/applications/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["application", id] });
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["analytics-overview"] });
    },
  });

  // A re-run changes the record and its pipeline badge, not just the polled
  // status — refreshing only the poll left this page and the board showing the
  // previous run's artifacts and cost.
  const retry = useMutation({
    mutationFn: () => api.post(`/applications/${id}/retry`),
    onSuccess: () => {
      for (const key of [["application-status", id], ["application", id], ["applications"]]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (err) =>
      setActionError(err instanceof ApiError ? err.message : "Couldn't restart this run."),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/applications/${id}`),
    onSuccess: () => {
      // Drop this record and refresh anything that counted it, or the board
      // keeps offering a card that 404s and the dashboard funnel stays wrong —
      // and the funnel is exactly where we land next.
      queryClient.removeQueries({ queryKey: ["application", id] });
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["analytics-overview"] });
      navigate("/applications");
    },
    onError: (err) =>
      setActionError(err instanceof ApiError ? err.message : "Couldn't delete this application."),
  });

  // A missing application is a settled outcome, not a slow one. Conflating the
  // two left a deleted, mistyped or shared-but-not-yours id spinning on
  // "Loading…" for ever: the query had failed, would not retry a 4xx, and
  // nothing ever set `application`.
  if (applicationError) {
    const missing =
      applicationError instanceof ApiError && applicationError.status === 404;
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-content">
          {missing
            ? "This application no longer exists."
            : "We couldn't load this application."}
        </p>
        <p className="mt-1 text-sm text-muted">
          {missing
            ? "It may have been deleted."
            : applicationError instanceof ApiError
              ? applicationError.message
              : "Please try again."}
        </p>
        <Link to="/applications" className="btn-secondary mt-6">
          Back to applications
        </Link>
      </div>
    );
  }

  if (isLoading || !application) {
    return <div className="py-16 text-center text-subtle">Loading…</div>;
  }

  const pipeline = status?.pipeline_status ?? application.pipeline_status;
  const busy = ACTIVE.has(pipeline);
  const report = application.guardrail_report;
  const errors = report?.violations.filter((v) => v.severity === "error") ?? [];
  const warnings = report?.violations.filter((v) => v.severity === "warning") ?? [];
  const coverage =
    report && report.keywords_requested.length > 0
      ? report.keywords_verified.length / report.keywords_requested.length
      : null;

  return (
    <div>
      <Link to="/applications" className="text-sm text-muted hover:text-content hover:underline">
        ← All applications
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {application.job?.title ?? "Untitled role"}
          </h1>
          <p className="text-sm text-muted">
            {application.job?.company ?? "Unknown company"}
            {application.job?.location ? ` · ${application.job.location}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PipelineBadge status={pipeline} />
          <span className={`badge ${TRACKER_STYLES[application.tracker_status]}`}>
            {trackerLabel(application.tracker_status)}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-md bg-surface-2 px-2.5 py-1 text-subtle">
          Created {fmtDate(application.created_at)}
        </span>
        {application.job?.source && (
          <span className="rounded-md bg-surface-2 px-2.5 py-1 text-subtle">
            Via {application.job.source}
          </span>
        )}
        {application.job?.url && (
          <a
            href={application.job.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-surface-2 px-2.5 py-1 text-brand-300 hover:text-brand-200"
          >
            View posting ↗
          </a>
        )}
      </div>

      {busy && (
        <div className="card mt-6 flex items-center gap-3 p-4">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/[0.08] border-t-brand-400" />
          <span className="text-sm text-muted">
            {status?.stage_message ?? "Working…"}
          </span>
        </div>
      )}

      {pipeline === "failed" && (
        <div className="mt-6 rounded-xl border border-danger/30 bg-danger/10 p-4">
          <div className="font-medium text-danger">This run failed</div>
          <p className="mt-1 text-sm text-danger">
            {application.error_message ?? "An unknown error occurred."}
          </p>
          <button
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
            className="btn-secondary mt-3"
          >
            {retry.isPending ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      {pipeline === "completed" && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Cost" value={`$${application.total_cost_usd.toFixed(4)}`} />
            <Stat
              label="Tokens"
              value={(
                application.total_input_tokens + application.total_output_tokens
              ).toLocaleString()}
            />
            <Stat
              label="Keyword match"
              value={coverage === null ? "—" : `${Math.round(coverage * 100)}%`}
            />
            <Stat
              label="Guardrail blocks"
              value={String(errors.length)}
              tone={errors.length > 0 ? "warn" : "ok"}
            />
          </div>

          {downloadError && (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
            >
              {downloadError}
            </div>
          )}

          <div className="mt-6 flex gap-1 overflow-x-auto border-b border-white/[0.08]">
            {(
              [
                ["overview", "Overview"],
                ["documents", "Résumé & Documents"],
                ["activity", "Activity"],
                ["notes", "Notes"],
                ["emails", "Emails"],
                ["analytics", "Analytics"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition ${
                  tab === value
                    ? "border-brand-600 text-content"
                    : "border-transparent text-subtle hover:text-content"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "overview" && (
            <OverviewTab
              application={application}
              onUpdate={update.mutate}
              onSaveNotes={(notes) => update.mutate({ notes })}
              download={(kind, name) => void download(kind, name)}
              onOpenDocs={() => setTab("documents")}
              onOpenNotes={() => setTab("notes")}
              onTailorAgain={() =>
                navigate("/new", { state: application.job?.url ? { url: application.job.url } : {} })
              }
              onRegenerate={() => retry.mutate()}
            />
          )}

          {tab === "documents" && (
            <div className="mt-6 space-y-5">
              {errors.length > 0 && (
                <div className="rounded-xl border border-coral/30 bg-coral/10 p-4">
                  <div className="font-medium text-coral">
                    HireCraft blocked {errors.length} unsupported{" "}
                    {errors.length === 1 ? "claim" : "claims"}
                  </div>
                  <p className="mt-1 text-sm text-coral">
                    The AI tried to state something your master resume does not support.
                    Those edits were removed automatically — see the Guardrails tab.
                  </p>
                </div>
              )}
              <div className="flex gap-1 overflow-x-auto border-b border-white/[0.08]">
                {(
                  [
                    ["diff", `Changes (${application.diff?.length ?? 0})`],
                    ["match", match ? `Match · ${match.overall_score}` : "Match"],
                    ["guardrails", `Guardrails (${report?.violations.length ?? 0})`],
                    ["requirements", "Job requirements"],
                    ["preview", "Final résumé"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setDocTab(value)}
                    className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition ${
                      docTab === value
                        ? "border-brand-600 text-content"
                        : "border-transparent text-subtle hover:text-content"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div>
                {docTab === "diff" && (
                  <DiffView
                    diff={application.diff ?? []}
                    emptyMessage="No changes were made — your resume already matched this posting."
                  />
                )}
                {docTab === "match" && <MatchView match={match} />}
                {docTab === "guardrails" && (
                  <GuardrailView
                    errors={errors}
                    warnings={warnings}
                    verified={report?.keywords_verified ?? []}
                    requested={report?.keywords_requested ?? []}
                    confidence={report?.bullet_confidence ?? []}
                    locks={report?.locks ?? []}
                  />
                )}
                {docTab === "requirements" && (
                  <RequirementsView requirements={application.job?.requirements ?? null} />
                )}
                {docTab === "preview" && <ResumePreview id={id!} />}
              </div>
              {application.scorecard && <ScorecardPanel card={application.scorecard} />}
            </div>
          )}

          {tab === "activity" && <ActivityView application={application} />}

          {tab === "emails" && <EmailsTab applicationId={id!} />}

          {tab === "notes" && (
            <div className="mt-6 grid max-w-2xl gap-5">
              <NotesCard application={application} onSave={(notes) => update.mutate({ notes })} />
              <DatesCard application={application} onUpdate={update.mutate} />
            </div>
          )}

          {tab === "analytics" && <AnalyticsTab application={application} />}
        </>
      )}

      {actionError && (
        <div
          role="alert"
          className="mt-6 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
        >
          {actionError}
        </div>
      )}

      <div className="mt-10 border-t border-white/[0.08] pt-5">
        <button
          onClick={() => {
            if (confirm("Delete this application and its generated files?")) {
              setActionError(null);
              remove.mutate();
            }
          }}
          className="btn-danger"
        >
          Delete application
        </button>
      </div>
    </div>
  );
}

/** ISO (UTC) → the "YYYY-MM-DDTHH:mm" a datetime-local input expects, in local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "warn";
}) {
  const toneClass =
    tone === "warn" ? "text-coral" : tone === "ok" ? "text-emerald" : "";
  return (
    <div className="card p-3">
      <div className="text-xs text-subtle">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}

function GuardrailView({
  errors,
  warnings,
  verified,
  requested,
  confidence,
  locks,
}: {
  errors: GuardrailViolation[];
  warnings: GuardrailViolation[];
  verified: string[];
  requested: string[];
  confidence: BulletConfidence[];
  locks: string[];
}) {
  const missing = requested.filter((k) => !verified.includes(k));

  return (
    <div className="space-y-6">
      {/* Per-bullet confidence — Guardrails v2 */}
      <ConfidencePanel
        confidence={confidence}
        intro="Every line in your tailored résumé, verified against your master résumé."
      />

      {/* What's locked */}
      {locks.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">Locked — the AI cannot change these</h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {locks.map((lock) => (
              <span key={lock} className="badge-muted">🔒 {lock}</span>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="text-sm font-medium">ATS keyword coverage</h3>
        <p className="mt-1 text-xs text-subtle">
          Verified against the text actually in your resume — not what the model
          claimed.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {verified.map((keyword) => (
            <span key={keyword} className="badge-emerald">
              {keyword}
            </span>
          ))}
          {missing.map((keyword) => (
            <span
              key={keyword}
              className="badge border border-dashed border-white/[0.14] text-subtle"
              title="Not present in your resume — HireCraft will not add a claim you cannot back up."
            >
              {keyword}
            </span>
          ))}
          {requested.length === 0 && (
            <span className="text-sm text-subtle">No keywords extracted.</span>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-danger">
            Blocked ({errors.length})
          </h3>
          <p className="mt-1 text-xs text-subtle">
            Removed from your resume because your master resume does not support them.
          </p>
          <ul className="mt-3 space-y-2">
            {errors.map((violation, index) => (
              <li
                key={index}
                className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
              >
                {violation.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-coral">
            Review before sending ({warnings.length})
          </h3>
          <ul className="mt-3 space-y-2">
            {warnings.map((violation, index) => (
              <li
                key={index}
                className="rounded-xl border border-coral/30 bg-coral/10 px-3 py-2.5 text-sm text-coral"
              >
                {violation.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {errors.length === 0 && warnings.length === 0 && (
        <p className="rounded-xl border border-emerald/30 bg-emerald/10 px-3 py-2.5 text-sm text-emerald">
          Every tailored statement traces back to your master resume.
        </p>
      )}
    </div>
  );
}

/** Inline PDF of the finished, tailored résumé — review the actual output
 * without downloading. Fetched as a blob, shown fit-to-width, chrome hidden. */
function ResumePreview({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let obj: string | null = null;
    let cancelled = false;
    setError(false);
    setUrl(null);
    api
      .blob(`/applications/${id}/download/resume_pdf`)
      .then((b) => {
        if (cancelled) return;
        obj = URL.createObjectURL(b);
        setUrl(obj);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [id]);

  return (
    <div className="h-[78vh] max-h-[calc(100dvh-14rem)] overflow-hidden rounded-xl border border-white/[0.08] bg-white">
      {error ? (
        <div className="flex h-full items-center justify-center text-sm text-danger">
          Couldn't render the résumé.
        </div>
      ) : !url ? (
        <div className="flex h-full items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <iframe title="Final résumé" src={`${url}#navpanes=0&zoom=page-width`} className="h-full w-full" />
      )}
    </div>
  );
}

// The interview funnel, in order. Secondary statuses fold onto the nearest step
// so the stepper always shows a coherent position.
const FUNNEL: { key: TrackerStatus; label: string }[] = [
  { key: "applied", label: "Applied" },
  { key: "screening", label: "Screening" },
  { key: "interviewing", label: "Interviewing" },
  { key: "final", label: "Final" },
  { key: "offer", label: "Offer" },
  { key: "accepted", label: "Accepted" },
];
const FUNNEL_POS: Partial<Record<TrackerStatus, number>> = {
  applied: 0,
  screening: 1,
  assessment: 1,
  interviewing: 2,
  technical: 2,
  behavioral: 2,
  final: 3,
  offer: 4,
  accepted: 5,
};
const TERMINAL_NEG = new Set<TrackerStatus>(["rejected", "withdrawn", "ghosted", "archived"]);

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Vertical workflow stepper (matches the workspace design). */
function WorkflowCard({
  application,
  onUpdate,
}: {
  application: ApplicationDetail;
  onUpdate: (body: { tracker_status: TrackerStatus }) => void;
}) {
  const status = application.tracker_status;
  const closed = TERMINAL_NEG.has(status);
  const reached = FUNNEL_POS[status] ?? -1;

  return (
    <div className="card p-5">
      <h2 className="text-base font-semibold">Application workflow</h2>
      <p className="mt-0.5 text-xs text-subtle">Track your progress through each stage.</p>

      <ol className="mt-4">
        {FUNNEL.map((stage, i) => {
          const done = !closed && reached > i;
          const current = !closed && reached === i;
          const sub = done
            ? i === 0
              ? fmtDate(application.created_at)
              : "Completed"
            : current
              ? "In progress"
              : "Pending";
          return (
            <li key={stage.key} className="relative flex gap-3 pb-4 last:pb-0">
              {i < FUNNEL.length - 1 && (
                <span className={`absolute left-[11px] top-6 h-full w-px ${done ? "bg-emerald/40" : "bg-white/[0.09]"}`} />
              )}
              <button
                type="button"
                onClick={() => onUpdate({ tracker_status: stage.key })}
                title={`Mark as ${stage.label}`}
                className="relative z-10 mt-0.5 shrink-0"
              >
                <span
                  className={`grid h-6 w-6 place-items-center rounded-full border text-[11px] transition ${
                    done
                      ? "border-emerald/50 bg-emerald/25 text-emerald"
                      : current
                        ? "border-brand-500 bg-brand-500/25 text-brand-100"
                        : "border-white/[0.14] text-transparent hover:border-white/30"
                  }`}
                >
                  {done ? "✓" : current ? "●" : ""}
                </span>
              </button>
              <div className="min-w-0">
                <div className={`text-sm ${current ? "font-medium text-content" : done ? "text-content" : "text-subtle"}`}>
                  {stage.label}
                </div>
                <div className={`text-xs ${current ? "text-brand-300" : "text-subtle"}`}>{sub}</div>
              </div>
            </li>
          );
        })}
      </ol>

      {closed && (
        <div
          className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
            status === "rejected"
              ? "border-danger/30 bg-danger/10 text-danger"
              : "border-white/[0.1] bg-surface-2 text-muted"
          }`}
        >
          Marked <span className="font-medium">{trackerLabel(status)}</span>.
        </div>
      )}

      <label className="mt-4 block">
        <span className="sr-only">Update status</span>
        <div className="relative">
          <select
            value={status}
            onChange={(e) => onUpdate({ tracker_status: e.target.value as TrackerStatus })}
            className="btn-primary w-full cursor-pointer appearance-none justify-center pr-8 text-center"
          >
            {ALL_STAGES.map((s) => (
              <option key={s} value={s} className="bg-surface text-content">
                Update Status — {trackerLabel(s)}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/70">▾</span>
        </div>
      </label>
    </div>
  );
}

/** One document tile in the Application overview card. */
function DocCard({
  icon,
  tint,
  title,
  subtitle,
  action,
  onAction,
  disabled,
}: {
  icon: React.ReactNode;
  tint: string;
  title: string;
  subtitle: string;
  action: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-surface-2 p-3.5">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${tint}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-content">{title}</div>
        <div className="truncate text-xs text-subtle">{subtitle}</div>
      </div>
      <button
        onClick={onAction}
        disabled={disabled}
        className="btn-secondary btn-sm shrink-0 disabled:opacity-40"
      >
        {action}
      </button>
    </div>
  );
}

function scoreHex(score: number): string {
  if (score >= 80) return "#2DD4BF";
  if (score >= 60) return "#4CC9F0";
  if (score >= 40) return "#FF9F43";
  return "#FF5C7A";
}

/* ── Quality-card building blocks ─────────────────────────────────────── */

function MetricGlyph({ k }: { k: string }) {
  const c = "h-4 w-4";
  if (k === "impact")
    return (<svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 20V11M12 20V4M19 20v-6M3 20h18" /></svg>);
  if (k === "verbs")
    return (<svg className={c} viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" /></svg>);
  if (k === "conciseness")
    return (<svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /></svg>);
  if (k === "grounding")
    return (<svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3Z" /><path d="m9 12 2 2 4-4" /></svg>);
  // ats / keywords — briefcase + lens
  return (<svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><circle cx="12" cy="12" r="1.6" /></svg>);
}

/** Fixed hue per metric (icon tile) — the score/bar carry the performance color. */
const METRIC_TINT: Record<string, string> = {
  ats: "bg-brand-500/15 text-brand-300",
  impact: "bg-electric/15 text-electric",
  verbs: "bg-emerald/15 text-emerald",
  conciseness: "bg-emerald/15 text-emerald",
  grounding: "bg-emerald/15 text-emerald",
};

/** Score → { verdict label, color } tier. Matches the donut and pills. */
function tier(score: number): { label: string; color: string } {
  if (score >= 85) return { label: "Excellent", color: "#34D399" };
  if (score >= 65) return { label: "Good", color: "#38BDF8" };
  if (score >= 45) return { label: "Fair", color: "#FBBF24" };
  return { label: "Needs work", color: "#FF5C7A" };
}

const OVERALL_BLURB: Record<string, string> = {
  Excellent: "Outstanding — this résumé is tuned tightly to the role.",
  Good: "Solid foundation. A few tweaks can make it stand out even more.",
  Fair: "A decent start — the suggestions below will lift it fast.",
  "Needs work": "Let's strengthen this — start with the suggestions below.",
};

/** Large gradient score ring for the quality card. */
function ScoreRing({ score, size = 150, stroke = 12 }: { score: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#7c4dff" />
            <stop offset="100%" stopColor="#4CC9F0" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#ringGrad)" strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ * (1 - score / 100)}
          style={{ transition: "stroke-dashoffset 0.7s ease" }}
        />
      </svg>
      <div className="absolute text-center leading-none">
        <div className="text-4xl font-bold tabular-nums text-content">{score}</div>
        <div className="mt-1 text-xs text-subtle">/100</div>
      </div>
    </div>
  );
}

/** One metric tile: icon · label · score · progress bar · detail · verdict pill. */
function MetricTile({ m }: { m: Scorecard["metrics"][number] }) {
  const t = tier(m.score);
  const tint = METRIC_TINT[m.key] ?? "bg-brand-500/15 text-brand-300";
  return (
    <div className="rounded-xl border border-white/[0.07] bg-surface-2/60 p-4">
      <div className="flex items-center gap-2.5">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${tint}`}>
          <MetricGlyph k={m.key} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-content">{m.label}</span>
        <span className="shrink-0 text-sm tabular-nums">
          <span className="font-bold" style={{ color: scoreHex(m.score) }}>{m.score}</span>
          <span className="text-subtle"> /100</span>
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
        <div className="h-full rounded-full" style={{ width: `${m.score}%`, background: scoreHex(m.score), transition: "width 0.6s ease" }} />
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-subtle" title={m.detail}>{m.detail}</span>
        <span
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
          style={{ color: t.color, background: `${t.color}1f` }}
        >
          {t.label}
        </span>
      </div>
    </div>
  );
}

/** Full AI Résumé Quality card — donut + metric grid + AI-wired improvements. */
function QualityCard({ card, onSuggest }: { card: Scorecard; onSuggest: (instruction: string) => void }) {
  const [howOpen, setHowOpen] = useState(false);
  const t = tier(card.overall);
  const grid = card.metrics.filter((m) => m.key !== "grounding").slice(0, 4);
  const grounding = card.metrics.find((m) => m.key === "grounding");

  return (
    <div className="card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-500/15 text-brand-300">
            <IconChart className="h-5 w-5" />
          </span>
          <div>
            <h2 className="flex items-center gap-1.5 text-lg font-semibold">
              AI Résumé Quality <IconSparkles className="h-4 w-4 text-brand-300" />
            </h2>
            <p className="text-sm text-subtle">Tailored for this role</p>
          </div>
        </div>
        <button
          onClick={() => setHowOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-surface px-3 py-1.5 text-xs text-muted transition hover:text-content"
        >
          <IconSparkles className="h-3.5 w-3.5" /> How we score
          <span className="grid h-4 w-4 place-items-center rounded-full border border-white/20 text-[10px]">i</span>
        </button>
      </div>

      {howOpen && (
        <p className="mt-3 rounded-lg border border-white/[0.07] bg-surface-2/60 p-3 text-xs leading-relaxed text-muted">
          Every score is computed deterministically from your tailored résumé — no guesswork.
          <span className="text-content"> Job-fit keywords</span> = share of the posting's ATS terms your background genuinely supports;
          <span className="text-content"> Quantified impact</span> = bullets carrying a real number;
          <span className="text-content"> Action-verb strength</span> = bullets led by a strong verb;
          <span className="text-content"> Conciseness</span> = bullets in the 6–34 word range.
          Nothing here can be inflated by keyword-stuffing — guardrails block any claim your résumé doesn't back.
        </p>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,220px)_1fr]">
        <div className="flex flex-col items-center justify-center gap-3 text-center">
          <ScoreRing score={card.overall} />
          <span
            className="rounded-full px-3 py-1 text-sm font-semibold"
            style={{ color: t.color, background: `${t.color}1f` }}
          >
            {t.label}
          </span>
          <p className="max-w-[15rem] text-sm text-subtle">{OVERALL_BLURB[t.label]}</p>
          {grounding && grounding.score >= 100 && (
            <span className="flex items-center gap-1 text-xs text-emerald">
              <IconShieldCheck className="h-3.5 w-3.5" /> Every claim verified
            </span>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {grid.map((m) => (
            <MetricTile key={m.key} m={m} />
          ))}
        </div>
      </div>

      {card.suggestions.length > 0 ? (
        <div className="mt-5 rounded-xl border border-brand-500/25 bg-brand-500/[0.06] p-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,240px)_1fr] lg:items-center">
            <div className="flex items-start gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-500/20 text-brand-300">
                <IconSparkles className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-base font-semibold">Improve your score</h3>
                <p className="mt-0.5 text-xs text-subtle">
                  Real gaps from this résumé — hand any to the grounded AI to fix.
                </p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {card.suggestions.map((s) => (
                <SuggestionCard key={s.key} s={s} onSuggest={onSuggest} />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-emerald/25 bg-emerald/[0.06] p-4 text-sm text-emerald">
          <IconShieldCheck className="h-4 w-4" /> Your résumé is in great shape — nothing to fix right now.
        </div>
      )}
    </div>
  );
}

function SuggestionCard({ s, onSuggest }: { s: ScorecardSuggestion; onSuggest: (instruction: string) => void }) {
  const tint = METRIC_TINT[s.metric_key] ?? "bg-brand-500/15 text-brand-300";
  return (
    <div className="flex flex-col rounded-lg border border-white/[0.07] bg-surface p-3.5">
      <span className={`grid h-8 w-8 place-items-center rounded-lg ${tint}`}>
        <MetricGlyph k={s.metric_key} />
      </span>
      <h4 className="mt-2.5 text-sm font-semibold text-content">{s.title}</h4>
      <p className="mt-1 flex-1 text-xs leading-relaxed text-subtle">{s.detail}</p>
      <button
        onClick={() => onSuggest(s.instruction)}
        className="mt-3 flex items-center gap-1 self-start text-xs font-medium text-brand-300 transition hover:text-brand-200"
      >
        Improve with AI <IconArrowRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function IconChart({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="m7 14 3-4 3 3 4-6" />
    </svg>
  );
}

function IconShieldCheck({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** Right-sidebar quick actions. */
function QuickActions({ items }: { items: { label: string; icon: React.ReactNode; onClick: () => void }[] }) {
  return (
    <div className="card p-5">
      <h2 className="text-base font-semibold">Quick actions</h2>
      <div className="mt-3 space-y-0.5">
        {items.map((it) => (
          <button
            key={it.label}
            onClick={it.onClick}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm text-content transition hover:bg-white/[0.04]"
          >
            <span className="text-brand-300">{it.icon}</span>
            <span className="flex-1">{it.label}</span>
            <span className="text-subtle">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Notes editor (saves via PATCH on button click). */
function NotesCard({ application, onSave }: { application: ApplicationDetail; onSave: (notes: string) => void }) {
  const [text, setText] = useState(application.notes ?? "");
  const dirty = text !== (application.notes ?? "");
  return (
    <div className="card p-5">
      <h2 className="text-base font-semibold">Application notes</h2>
      <p className="mt-0.5 text-xs text-subtle">Your thoughts, interview feedback, or anything important.</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Write a note…"
        className="input mt-3 min-h-[90px] leading-relaxed"
      />
      <button onClick={() => onSave(text)} disabled={!dirty} className="btn-primary btn-sm mt-2 disabled:opacity-40">
        Save note
      </button>
    </div>
  );
}

/** Job details panel. */
function JobDetailsCard({ job }: { job: ApplicationDetail["job"] }) {
  const req = (job?.requirements ?? {}) as Record<string, unknown>;
  const rows: [string, string][] = [
    ["Company", job?.company ?? "—"],
    ["Location", job?.location ?? "—"],
    ["Seniority", (req.seniority as string) ?? "—"],
    ["Posted", fmtDate(job?.created_at) || "—"],
    ["Source", job?.source ?? "—"],
  ];
  return (
    <div className="card p-5">
      <h2 className="text-base font-semibold">Job details</h2>
      <dl className="mt-3 space-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-subtle">{k}</dt>
            <dd className="truncate text-right text-content">{v}</dd>
          </div>
        ))}
      </dl>
      {job?.url && (
        <a
          href={job.url}
          target="_blank"
          rel="noreferrer"
          className="btn-secondary mt-4 w-full justify-center"
        >
          View original posting ↗
        </a>
      )}
    </div>
  );
}

type ProposalStatus = "pending" | "applied" | "discarded";
interface Proposal {
  note: string;
  diff: DiffEntry[];
  proposed: unknown;
  blocked: string[];
  status: ProposalStatus;
}
interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  grounded_in?: string[];
  proposal?: Proposal;
}

function ChatBubble({ msg }: { msg: ChatMsg }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[85%] space-y-1.5">
        <div
          className={`whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
            isUser ? "bg-brand-600 text-white" : "border border-white/[0.06] bg-surface text-content"
          }`}
        >
          {msg.content}
        </div>
        {msg.grounded_in && msg.grounded_in.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {msg.grounded_in.map((g) => (
              <span key={g} className="badge-muted text-[10px]">{g}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const ASSIST_SUGGESTIONS = [
  "Make my résumé more impactful for this role.",
  "What keywords am I missing?",
  "Rewrite my summary to be stronger.",
];

/** A proposed revision rendered inline: note + diff + Apply/Discard. */
function ProposalMessage({
  msg,
  onApply,
  onDiscard,
  applying,
}: {
  msg: ChatMsg;
  onApply: () => void;
  onDiscard: () => void;
  applying: boolean;
}) {
  const p = msg.proposal!;
  return (
    <div className="rounded-2xl border border-brand-500/30 bg-brand-500/[0.05] p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium text-content">
        <IconSparkles className="h-4 w-4 text-brand-300" /> Proposed revision
      </div>
      <p className="mt-1 text-sm text-muted">{msg.content}</p>
      {p.blocked.length > 0 && (
        <p className="mt-2 text-xs text-coral">
          {p.blocked.length} unsupported edit{p.blocked.length === 1 ? "" : "s"} were blocked and left out.
        </p>
      )}
      {p.diff.length > 0 && (
        <div className="mt-3 max-h-72 overflow-y-auto">
          <DiffView diff={p.diff} afterLabel="Proposed" emptyMessage="No changes." />
        </div>
      )}
      {p.status === "pending" ? (
        <div className="mt-3 flex gap-2">
          <button onClick={onApply} disabled={applying || p.diff.length === 0} className="btn-primary btn-sm disabled:opacity-40">
            {applying ? "Applying…" : "Apply changes"}
          </button>
          <button onClick={onDiscard} disabled={applying} className="btn-ghost btn-sm">Discard</button>
        </div>
      ) : (
        <div className={`mt-2 text-xs ${p.status === "applied" ? "text-emerald" : "text-subtle"}`}>
          {p.status === "applied" ? "✓ Applied to your tailored résumé" : "Discarded"}
        </div>
      )}
    </div>
  );
}

/** Inline grounded assistant (Phase B): grounded chat + propose/apply rewrites.
 * "Ask" hits the grounded /copilot/chat; "Rewrite" proposes a guardrailed
 * revision (preview diff) that "Apply" commits to the tailored résumé + PDF. */
function AIAssistantCard({ applicationId, prefill }: { applicationId: string; prefill?: { instruction: string; nonce: number } }) {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const push = (m: ChatMsg) => setMessages((p) => [...p, m]);
  const setProposalStatus = (index: number, status: ProposalStatus) =>
    setMessages((p) => p.map((m, i) => (i === index && m.proposal ? { ...m, proposal: { ...m.proposal, status } } : m)));

  const send = useMutation({
    mutationFn: (message: string) =>
      api.post<CopilotResponse>("/copilot/chat", {
        message,
        history: messages.slice(-8).map((m) => ({ role: m.role, content: m.content })),
        application_id: applicationId,
      }),
    onSuccess: (r) => push({ role: "assistant", content: r.reply, grounded_in: r.grounded_in }),
    onError: (e) => push({ role: "assistant", content: e instanceof ApiError ? `⚠️ ${e.message}` : "⚠️ Something went wrong. Try again." }),
  });

  const revise = useMutation({
    mutationFn: (instruction: string) =>
      api.post<{ note: string; diff: DiffEntry[]; proposed: unknown; blocked: string[] }>(
        `/applications/${applicationId}/assistant/revise`,
        { instruction },
      ),
    onSuccess: (r) => push({ role: "assistant", content: r.note, proposal: { ...r, status: "pending" } }),
    onError: (e) => push({ role: "assistant", content: e instanceof ApiError ? `⚠️ ${e.message}` : "⚠️ Couldn't propose a rewrite." }),
  });

  const apply = useMutation({
    mutationFn: (vars: { proposed: unknown; index: number }) =>
      api.post(`/applications/${applicationId}/assistant/apply`, { proposed: vars.proposed }),
    onSuccess: (_d, vars) => {
      setProposalStatus(vars.index, "applied");
      qc.invalidateQueries({ queryKey: ["application", applicationId] });
      push({ role: "assistant", content: "✓ Applied — your tailored résumé and PDF are updated." });
    },
    onError: (e) => push({ role: "assistant", content: e instanceof ApiError ? `⚠️ ${e.message}` : "⚠️ Couldn't apply the change." }),
  });

  const busy = send.isPending || revise.isPending || apply.isPending;
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  // A "Improve with AI" click from the quality card lands a grounded rewrite here.
  const prefillNonce = prefill?.nonce ?? 0;
  useEffect(() => {
    if (prefillNonce > 0 && prefill?.instruction) {
      document.getElementById("ai-assistant")?.scrollIntoView({ behavior: "smooth", block: "start" });
      rewrite(prefill.instruction);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce]);

  function ask(text: string) {
    const m = text.trim();
    if (!m || busy) return;
    push({ role: "user", content: m });
    setInput("");
    send.mutate(m);
  }
  function rewrite(text: string) {
    const m = text.trim();
    if (!m || busy) return;
    push({ role: "user", content: m });
    setInput("");
    revise.mutate(m);
  }

  return (
    <div id="ai-assistant" className="card flex scroll-mt-24 flex-col p-5">
      <div className="flex items-center gap-2">
        <IconSparkles className="h-5 w-5 text-brand-300" />
        <h2 className="text-base font-semibold">AI Assistant</h2>
        <span className="badge-emerald text-[10px]">Grounded</span>
      </div>
      <p className="mt-0.5 text-xs text-subtle">Grounded in your résumé and this job — it never invents.</p>

      <div className="mt-3 max-h-[30rem] min-h-[9rem] flex-1 space-y-3 overflow-y-auto rounded-xl border border-white/[0.06] bg-surface-2/40 p-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-4 text-center">
            <p className="max-w-xs text-sm text-subtle">
              Ask a question, or hit <span className="text-content">Rewrite</span> to propose a grounded change you can review and apply.
            </p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {ASSIST_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => rewrite(s)}
                  className="rounded-full border border-white/[0.1] bg-surface px-3 py-1 text-xs text-muted transition hover:text-content"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) =>
            m.proposal ? (
              <ProposalMessage
                key={i}
                msg={m}
                applying={apply.isPending}
                onApply={() => apply.mutate({ proposed: m.proposal!.proposed, index: i })}
                onDiscard={() => setProposalStatus(i, "discarded")}
              />
            ) : (
              <ChatBubble key={i} msg={m} />
            ),
          )
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-subtle">
            <Spinner className="h-3.5 w-3.5" /> {revise.isPending ? "Drafting a grounded revision…" : apply.isPending ? "Applying…" : "Thinking…"}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className="mt-2 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask, or describe a change to make…"
          className="input flex-1"
        />
        <button
          type="button"
          onClick={() => rewrite(input)}
          disabled={busy || !input.trim()}
          title="Propose a grounded rewrite you can review and apply"
          className="btn-secondary shrink-0 disabled:opacity-40"
        >
          <IconSparkles className="h-4 w-4" /> Rewrite
        </button>
        <button type="submit" disabled={busy || !input.trim()} className="btn-primary shrink-0 disabled:opacity-40" title="Ask a question">
          <IconArrowRight className="h-4 w-4" />
        </button>
      </form>
      <p className="mt-1.5 text-[11px] text-subtle">
        Grounded in your résumé and this job. “Rewrite” proposes a guardrailed change; “Apply” updates the résumé + PDF.
      </p>
    </div>
  );
}

/** The Overview tab: two-column workspace (docs + quality + assistant | workflow + actions + notes + job). */
function OverviewTab({
  application,
  onUpdate,
  onSaveNotes,
  download,
  onOpenDocs,
  onOpenNotes,
  onTailorAgain,
  onRegenerate,
}: {
  application: ApplicationDetail;
  onUpdate: (body: { tracker_status: TrackerStatus }) => void;
  onSaveNotes: (notes: string) => void;
  download: (kind: string, name: string) => void;
  onOpenDocs: () => void;
  onOpenNotes: () => void;
  onTailorAgain: () => void;
  onRegenerate: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const hasCover = application.artifacts.some((a) => a.kind === "cover_letter_pdf");
  const [assist, setAssist] = useState<{ instruction: string; nonce: number }>({ instruction: "", nonce: 0 });
  const handleSuggest = (instruction: string) => setAssist((p) => ({ instruction, nonce: p.nonce + 1 }));

  const coverLetter = useMutation({
    mutationFn: () => api.post<ApplicationDetail>(`/applications/${application.id}/cover-letter`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["application", application.id] });
      toast.success(hasCover ? "Cover letter regenerated" : "Cover letter generated");
    },
    onError: (e) => toast.error("Couldn't draft the cover letter", e instanceof ApiError ? e.message : undefined),
  });

  const quick = [
    { label: "Tailor résumé again", icon: <IconRefresh className="h-4 w-4" />, onClick: onTailorAgain },
    { label: "Regenerate this tailoring", icon: <IconSparkles className="h-4 w-4" />, onClick: onRegenerate },
    {
      label: coverLetter.isPending
        ? "Drafting cover letter…"
        : hasCover
          ? "Regenerate cover letter"
          : "Generate cover letter",
      icon: <IconLetter className="h-4 w-4" />,
      onClick: () => coverLetter.mutate(),
    },
    { label: "Review changes & guardrails", icon: <IconPen className="h-4 w-4" />, onClick: onOpenDocs },
    { label: "Download package (.zip)", icon: <IconUpload className="h-4 w-4" />, onClick: () => download("package", "application_package.zip") },
    { label: "Download résumé PDF", icon: <IconResume className="h-4 w-4" />, onClick: () => download("resume_pdf", "resume.pdf") },
    ...(hasCover
      ? [{ label: "Download cover letter", icon: <IconLetter className="h-4 w-4" />, onClick: () => download("cover_letter_pdf", "cover_letter.pdf") }]
      : []),
    { label: "Download LaTeX (.tex)", icon: <IconArrowRight className="h-4 w-4" />, onClick: () => download("resume_tex", "resume.tex") },
    { label: "Set a reminder", icon: <IconBell className="h-4 w-4" />, onClick: onOpenNotes },
  ];
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-6">
        <div className="card p-5">
          <h2 className="text-base font-semibold">Application overview</h2>
          <p className="mt-0.5 text-sm text-muted">
            Track, manage, and optimize your application — update status, grab your documents, and refine your materials.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <DocCard
              icon={<IconResume className="h-4 w-4" />} tint="bg-brand-500/15 text-brand-300"
              title="Résumé (Tailored)" subtitle={`Updated ${fmtDate(application.updated_at)}`}
              action="Preview" onAction={onOpenDocs}
            />
            <DocCard
              icon={<IconLetter className="h-4 w-4" />} tint="bg-electric/15 text-electric"
              title="Cover Letter"
              subtitle={coverLetter.isPending ? "Drafting…" : hasCover ? `Updated ${fmtDate(application.updated_at)}` : "Not generated yet"}
              action={coverLetter.isPending ? "…" : hasCover ? "Download" : "Generate"}
              disabled={coverLetter.isPending}
              onAction={() => (hasCover ? download("cover_letter_pdf", "cover_letter.pdf") : coverLetter.mutate())}
            />
            <DocCard
              icon={<IconUpload className="h-4 w-4" />} tint="bg-emerald/15 text-emerald"
              title="Résumé source" subtitle="Your master résumé" action="Open" onAction={onOpenDocs}
            />
            <DocCard
              icon={<IconBriefcase className="h-4 w-4" />} tint="bg-coral/15 text-coral"
              title="Job description" subtitle={application.job?.company ? `From ${application.job.company}` : "Extracted"}
              action="View" onAction={onOpenDocs}
            />
          </div>
        </div>
        {application.scorecard && (
          <QualityCard card={application.scorecard} onSuggest={handleSuggest} />
        )}
        <AIAssistantCard applicationId={application.id} prefill={assist} />
      </div>

      <div className="space-y-5">
        <WorkflowCard application={application} onUpdate={onUpdate} />
        <QuickActions items={quick} />
        <NotesCard application={application} onSave={onSaveNotes} />
        <JobDetailsCard job={application.job} />
      </div>
    </div>
  );
}

/** Interview date + follow-up reminder, shown in the Notes tab. */
function DatesCard({
  application,
  onUpdate,
}: {
  application: ApplicationDetail;
  onUpdate: (body: { interview_at?: string | null; reminder_at?: string | null }) => void;
}) {
  return (
    <div className="card p-5">
      <h2 className="text-base font-semibold">Dates &amp; reminders</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">Interview date</span>
          <input
            type="datetime-local"
            className="input"
            defaultValue={toLocalInput(application.interview_at)}
            onBlur={(e) => {
              const next = e.target.value ? new Date(e.target.value).toISOString() : null;
              if (next !== application.interview_at) onUpdate({ interview_at: next });
            }}
          />
        </label>
        <label className="block">
          <span className="label">Follow-up reminder</span>
          <input
            type="datetime-local"
            className="input"
            defaultValue={toLocalInput(application.reminder_at)}
            onBlur={(e) => {
              const next = e.target.value ? new Date(e.target.value).toISOString() : null;
              if (next !== application.reminder_at) onUpdate({ reminder_at: next });
            }}
          />
        </label>
      </div>
    </div>
  );
}

/** Simple activity timeline from the application's own timestamps. */
function ActivityView({ application }: { application: ApplicationDetail }) {
  const events = [
    { label: "Application created", at: application.created_at },
    { label: "Last updated", at: application.updated_at },
    ...(application.interview_at ? [{ label: "Interview scheduled", at: application.interview_at }] : []),
    ...(application.reminder_at ? [{ label: "Follow-up reminder set", at: application.reminder_at }] : []),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return (
    <div className="card mt-6 p-5">
      <h2 className="text-base font-semibold">Activity</h2>
      <ol className="mt-4 space-y-3">
        {events.map((e, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-400" />
            <div>
              <div className="text-sm text-content">{e.label}</div>
              <div className="text-xs text-subtle">{new Date(e.at).toLocaleString()}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const COST_CATEGORY_META: Record<string, { label: string; color: string }> = {
  resume: { label: "Résumé tailoring & edits", color: "#7c4dff" },
  cover_letter: { label: "Cover letter", color: "#4CC9F0" },
  outreach: { label: "Outreach", color: "#2DD4BF" },
};

/** Per-application spend: totals + a category breakdown that grows with every AI action. */
function AnalyticsTab({ application }: { application: ApplicationDetail }) {
  const bd = application.cost_breakdown || {};
  const cats = Object.entries(bd)
    .filter(([, v]) => v.cost_usd > 0 || v.input_tokens + v.output_tokens > 0)
    .sort((a, b) => b[1].cost_usd - a[1].cost_usd);
  const totalCost = application.total_cost_usd;
  const totalTokens = application.total_input_tokens + application.total_output_tokens;

  return (
    <div className="mt-6 space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Total cost" value={`$${totalCost.toFixed(4)}`} />
        <Stat label="Total tokens" value={totalTokens.toLocaleString()} />
        <Stat
          label="Input / Output tokens"
          value={`${application.total_input_tokens.toLocaleString()} / ${application.total_output_tokens.toLocaleString()}`}
        />
      </div>

      <div className="card p-5">
        <h2 className="text-base font-semibold">Cost breakdown</h2>
        <p className="mt-0.5 text-xs text-subtle">
          Additive across every AI action on this application — tailoring, revisions, cover letter, and outreach.
        </p>
        {cats.length === 0 ? (
          <p className="mt-4 text-sm text-subtle">No AI spend recorded yet.</p>
        ) : (
          <div className="mt-4 space-y-3.5">
            {cats.map(([key, v]) => {
              const meta = COST_CATEGORY_META[key] ?? { label: key, color: "#8a8a8a" };
              const pct = totalCost > 0 ? (v.cost_usd / totalCost) * 100 : 0;
              return (
                <div key={key}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 text-content">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
                      {meta.label}
                    </span>
                    <span className="tabular-nums text-content">
                      ${v.cost_usd.toFixed(4)}
                      <span className="ml-1 text-subtle">· {(v.input_tokens + v.output_tokens).toLocaleString()} tok</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: meta.color, transition: "width 0.5s ease" }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const OUTREACH_KINDS = [
  { key: "recruiter_email", label: "Recruiter email" },
  { key: "follow_up", label: "Follow-up" },
  { key: "referral_request", label: "Referral request" },
];

/** Draft short, grounded outreach for this application (Emails tab). */
function EmailsTab({ applicationId }: { applicationId: string }) {
  const toast = useToast();
  const [kind, setKind] = useState("recruiter_email");
  const [recipient, setRecipient] = useState("");
  const [context, setContext] = useState("");
  const [draft, setDraft] = useState<{ subject: string; body: string; warnings: string[] } | null>(null);

  const gen = useMutation({
    mutationFn: () =>
      api.post<{ subject: string; body: string; warnings: string[] }>(
        `/applications/${applicationId}/outreach`,
        { kind, recipient: recipient || null, context: context || null },
      ),
    onSuccess: (d) => setDraft(d),
    onError: (e) => toast.error("Couldn't draft the message", e instanceof ApiError ? e.message : undefined),
  });

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <div className="card p-5">
        <h2 className="text-base font-semibold">Draft outreach</h2>
        <p className="mt-0.5 text-xs text-subtle">
          Grounded in your résumé — you review and send it yourself. Never scrapes anyone's contact details.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {OUTREACH_KINDS.map((k) => (
            <button
              key={k.key}
              onClick={() => setKind(k.key)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                kind === k.key
                  ? "border-brand-500/60 bg-brand-500/15 text-brand-200"
                  : "border-white/[0.1] bg-surface-2 text-muted hover:text-content"
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <label className="mt-3 block">
          <span className="label">Recipient (optional)</span>
          <input className="input" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="A recruiter or contact's name" />
        </label>
        <label className="mt-3 block">
          <span className="label">Context (optional)</span>
          <textarea
            className="input min-h-[70px]"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Anything to weave in — a mutual contact, why this team, a deadline…"
          />
        </label>
        <button onClick={() => gen.mutate()} disabled={gen.isPending} className="btn-primary mt-3 disabled:opacity-40">
          {gen.isPending ? "Drafting…" : draft ? "Redraft" : "Draft message"}
        </button>
      </div>

      <div className="card p-5">
        {!draft ? (
          <div className="flex h-full min-h-[12rem] items-center justify-center text-center text-sm text-subtle">
            Pick a type and hit <span className="mx-1 text-content">Draft message</span> — your outreach appears here.
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Draft</h2>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(`Subject: ${draft.subject}\n\n${draft.body}`);
                  toast.success("Copied to clipboard");
                }}
                className="btn-secondary btn-sm"
              >
                Copy
              </button>
            </div>
            <div className="mt-3 text-xs text-subtle">Subject</div>
            <div className="rounded-lg border border-white/[0.07] bg-surface-2 px-3 py-2 text-sm text-content">{draft.subject}</div>
            <div className="mt-3 text-xs text-subtle">Body</div>
            <div className="whitespace-pre-wrap rounded-lg border border-white/[0.07] bg-surface-2 px-3 py-2 text-sm leading-relaxed text-content">
              {draft.body}
            </div>
            {draft.warnings.length > 0 && (
              <div className="mt-3 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">
                Double-check before sending — {draft.warnings.join("; ")}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const VERDICT_TONE: Record<JobMatch["verdict"], string> = {
  "Strong match": "text-emerald",
  "Good match": "text-electric",
  "Fair match": "text-coral",
  Reach: "text-hotpink",
};

function MatchView({ match }: { match: JobMatch | undefined }) {
  if (!match) {
    return (
      <p className="text-sm text-muted">
        A fit score appears once the job has been analysed (run the tailoring pipeline).
      </p>
    );
  }
  return (
    <div className="space-y-6">
      {/* Score + verdict */}
      <div className="flex flex-wrap items-center gap-5 rounded-2xl border border-white/[0.06] bg-surface-2 px-5 py-4">
        <div className="text-4xl font-semibold tabular-nums text-gradient">
          {match.overall_score}
          <span className="ml-1 text-base font-normal text-subtle">/100</span>
        </div>
        <div className={`text-lg font-semibold ${VERDICT_TONE[match.verdict]}`}>
          {match.verdict}
        </div>
      </div>

      {/* Sub-scores */}
      <div className="grid gap-3 sm:grid-cols-2">
        {match.subscores.map((s) => (
          <div key={s.key} className="card p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{s.label}</span>
              <span className="tabular-nums text-muted">{s.score}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="h-full rounded-full bg-brand-600" style={{ width: `${s.score}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-subtle">{s.detail}</p>
          </div>
        ))}
      </div>

      {/* Strengths + gaps */}
      <div className="grid gap-5 md:grid-cols-2">
        <div className="card p-5">
          <h3 className="section-title text-emerald">Strengths</h3>
          <ul className="mt-3 space-y-2">
            {match.strengths.map((s, i) => (
              <li key={i} className="text-sm text-content">✓ {s}</li>
            ))}
            {match.strengths.length === 0 && <li className="text-sm text-subtle">—</li>}
          </ul>
        </div>
        <div className="card p-5">
          <h3 className="section-title text-coral">Gaps</h3>
          <ul className="mt-3 space-y-2">
            {match.gaps.map((g, i) => (
              <li key={i} className="text-sm text-content">• {g}</li>
            ))}
          </ul>
        </div>
      </div>

      {/* Skill chips */}
      {(match.matched_skills.length > 0 || match.missing_skills.length > 0) && (
        <div className="card p-5">
          <h3 className="section-title">Skills</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {match.matched_skills.map((s) => (
              <span key={s.name} className="badge-emerald">{s.name}</span>
            ))}
            {match.missing_skills.map((s) => (
              <span key={s.name} className="badge border border-dashed border-white/[0.14] text-subtle">
                {s.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RequirementsView({
  requirements,
}: {
  requirements: ApplicationDetail["job"] extends null
    ? never
    : NonNullable<ApplicationDetail["job"]>["requirements"];
}) {
  if (!requirements) {
    return <p className="text-sm text-muted">No requirements extracted.</p>;
  }
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Section title="Required skills">
        <div className="flex flex-wrap gap-1.5">
          {requirements.required_skills.map((skill) => (
            <span key={skill.name} className="badge bg-white/[0.06] text-content">
              {skill.name}
            </span>
          ))}
        </div>
      </Section>
      <Section title="Preferred skills">
        <div className="flex flex-wrap gap-1.5">
          {requirements.preferred_skills.map((skill) => (
            <span key={skill.name} className="badge bg-surface-2 text-muted">
              {skill.name}
            </span>
          ))}
        </div>
      </Section>
      <Section title="Responsibilities">
        <ul className="list-disc space-y-1 pl-4 text-sm text-muted">
          {requirements.responsibilities.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </Section>
      <Section title="Qualifications">
        <ul className="list-disc space-y-1 pl-4 text-sm text-muted">
          {requirements.qualifications.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      {children}
    </div>
  );
}

function barTone(score: number): string {
  if (score >= 85) return "bg-emerald";
  if (score >= 65) return "bg-brand-400";
  if (score >= 45) return "bg-electric";
  return "bg-coral";
}

/** Résumé-quality readout for the finished tailoring — deterministic, no LLM. */
function ScorecardPanel({ card }: { card: Scorecard }) {
  const ring =
    card.overall >= 85 ? "text-emerald"
    : card.overall >= 65 ? "text-brand-300"
    : card.overall >= 45 ? "text-electric" : "text-coral";
  return (
    <div className="mt-8 card p-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Résumé quality</h3>
          <p className="mt-0.5 text-xs text-subtle">
            How strong this tailored résumé is for the role — scored on the signals
            recruiters and ATS reward.
          </p>
        </div>
        <div className="text-right">
          <div className={`text-3xl font-semibold tabular-nums ${ring}`}>{card.overall}</div>
          <div className="text-[11px] uppercase tracking-wide text-subtle">overall / 100</div>
        </div>
      </div>
      <div className="mt-4 space-y-2.5">
        {card.metrics.map((m) => (
          <div key={m.key}>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-content">{m.label}</span>
              <span className="tabular-nums text-muted" title={m.detail}>{m.score}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={`h-full rounded-full ${barTone(m.score)} transition-[width] duration-500`}
                style={{ width: `${m.score}%` }}
              />
            </div>
            <p className="mt-0.5 text-[11px] text-subtle">{m.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
