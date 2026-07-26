import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ApplicationDetail,
  type ApplicationStatus,
  type GuardrailViolation,
  type BulletConfidence,
  type TrackerStatus,
  type JobMatch,
} from "../lib/api";
import { PipelineBadge, TRACKER_STYLES } from "../components/StatusBadge";
import { DiffView, ConfidencePanel } from "../components/ReviewPanels";
import { ALL_STAGES, trackerLabel } from "../lib/tracker";

const ACTIVE = new Set([
  "pending",
  "scraping",
  "extracting",
  "optimizing",
  "rendering",
]);

type Tab = "diff" | "match" | "guardrails" | "requirements";

export default function ApplicationPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("diff");
  const [downloadError, setDownloadError] = useState<string | null>(null);

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

  const { data: application, isLoading } = useQuery({
    queryKey: ["application", id, status?.pipeline_status],
    queryFn: () => api.get<ApplicationDetail>(`/applications/${id}`),
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

  const retry = useMutation({
    mutationFn: () => api.post(`/applications/${id}/retry`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["application-status", id] }),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/applications/${id}`),
    onSuccess: () => navigate("/"),
  });

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
      <Link to="/" className="text-sm text-muted hover:text-content hover:underline">
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
          <select
            value={application.tracker_status}
            onChange={(e) =>
              update.mutate({ tracker_status: e.target.value as TrackerStatus })
            }
            className={`badge cursor-pointer border-0 ${
              TRACKER_STYLES[application.tracker_status]
            }`}
          >
            {ALL_STAGES.map((s) => (
              <option key={s} value={s} className="bg-surface text-content">
                {trackerLabel(s)}
              </option>
            ))}
          </select>
        </div>
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

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => void download("package", "application_package.zip")}
              className="btn-primary"
            >
              Download package (.zip)
            </button>
            <button
              onClick={() => void download("resume_pdf", "resume.pdf")}
              className="btn-secondary"
            >
              Résumé PDF
            </button>
            {application.artifacts.some((a) => a.kind === "cover_letter_pdf") && (
              <button
                onClick={() => void download("cover_letter_pdf", "cover_letter.pdf")}
                className="btn-secondary"
              >
                Cover letter PDF
              </button>
            )}
            <button
              onClick={() => void download("resume_tex", "resume.tex")}
              className="btn-secondary"
            >
              LaTeX source
            </button>
            <button
              onClick={() => retry.mutate()}
              disabled={retry.isPending}
              className="btn-secondary"
            >
              Regenerate
            </button>
          </div>

          {downloadError && (
            <div
              role="alert"
              className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
            >
              {downloadError}
            </div>
          )}

          {errors.length > 0 && (
            <div className="mt-6 rounded-xl border border-coral/30 bg-coral/10 p-4">
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

          <div className="mt-8">
            <div className="flex gap-1 border-b border-white/[0.08]">
              {(
                [
                  ["diff", `Changes (${application.diff?.length ?? 0})`],
                  ["match", match ? `Match · ${match.overall_score}` : "Match"],
                  [
                    "guardrails",
                    `Guardrails (${report?.violations.length ?? 0})`,
                  ],
                  ["requirements", "Job requirements"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setTab(value)}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
                    tab === value
                      ? "border-brand-600 text-content"
                      : "border-transparent text-subtle hover:text-content"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="pt-5">
              {tab === "diff" && (
                <DiffView
                  diff={application.diff ?? []}
                  emptyMessage="No changes were made — your resume already matched this posting."
                />
              )}
              {tab === "match" && <MatchView match={match} />}
              {tab === "guardrails" && (
                <GuardrailView
                  errors={errors}
                  warnings={warnings}
                  verified={report?.keywords_verified ?? []}
                  requested={report?.keywords_requested ?? []}
                  confidence={report?.bullet_confidence ?? []}
                  locks={report?.locks ?? []}
                />
              )}
              {tab === "requirements" && (
                <RequirementsView requirements={application.job?.requirements ?? null} />
              )}
            </div>
          </div>
        </>
      )}

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="interview_at">
            Interview date
          </label>
          {/* onBlur, not onChange: a datetime-local fires per component as the
              user steps through day/month/hour, so onChange sent a PATCH per
              keystroke — enough of them to trip the rate limiter. */}
          <input
            id="interview_at"
            type="datetime-local"
            className="input"
            defaultValue={toLocalInput(application.interview_at)}
            onBlur={(e) => {
              const next = e.target.value
                ? new Date(e.target.value).toISOString()
                : null;
              if (next !== application.interview_at) {
                update.mutate({ interview_at: next });
              }
            }}
          />
        </div>
        <div>
          <label className="label" htmlFor="reminder_at">
            Follow-up reminder
          </label>
          <input
            id="reminder_at"
            type="datetime-local"
            className="input"
            defaultValue={toLocalInput(application.reminder_at)}
            onBlur={(e) => {
              const next = e.target.value
                ? new Date(e.target.value).toISOString()
                : null;
              if (next !== application.reminder_at) {
                update.mutate({ reminder_at: next });
              }
            }}
          />
        </div>
      </div>

      <div className="mt-6">
        <label className="label" htmlFor="notes">
          Notes
        </label>
        <textarea
          id="notes"
          className="input min-h-[90px]"
          defaultValue={application.notes ?? ""}
          placeholder="Recruiter name, referral, follow-up date…"
          onBlur={(e) => {
            if (e.target.value !== (application.notes ?? "")) {
              update.mutate({ notes: e.target.value });
            }
          }}
        />
      </div>

      <div className="mt-10 border-t border-white/[0.08] pt-5">
        <button
          onClick={() => {
            if (confirm("Delete this application and its generated files?")) {
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
