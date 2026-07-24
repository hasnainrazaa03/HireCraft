import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ApplicationDetail,
  type ApplicationStatus,
  type DiffEntry,
  type GuardrailViolation,
  type TrackerStatus,
} from "../lib/api";
import { PipelineBadge, TRACKER_STYLES } from "../components/StatusBadge";

const ACTIVE = new Set([
  "pending",
  "scraping",
  "extracting",
  "optimizing",
  "rendering",
]);

type Tab = "diff" | "guardrails" | "requirements";

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

  const update = useMutation({
    mutationFn: (body: Partial<{ tracker_status: TrackerStatus; notes: string }>) =>
      api.patch(`/applications/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["application", id] });
      queryClient.invalidateQueries({ queryKey: ["applications"] });
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
    return <div className="py-16 text-center text-ink-500">Loading…</div>;
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
      <Link to="/" className="text-sm text-ink-600 hover:text-ink-900 hover:underline">
        ← All applications
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {application.job?.title ?? "Untitled role"}
          </h1>
          <p className="text-sm text-ink-600">
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
            className={`badge cursor-pointer border-0 capitalize ${
              TRACKER_STYLES[application.tracker_status]
            }`}
          >
            {Object.keys(TRACKER_STYLES).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {busy && (
        <div className="card mt-6 flex items-center gap-3 p-4">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900" />
          <span className="text-sm text-ink-700">
            {status?.stage_message ?? "Working…"}
          </span>
        </div>
      )}

      {pipeline === "failed" && (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4">
          <div className="font-medium text-red-900">This run failed</div>
          <p className="mt-1 text-sm text-red-800">
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
              onClick={() => void download("resume_pdf", "resume.pdf")}
              className="btn-primary"
            >
              Download resume PDF
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
              className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {downloadError}
            </div>
          )}

          {errors.length > 0 && (
            <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="font-medium text-amber-900">
                HireCraft blocked {errors.length} unsupported{" "}
                {errors.length === 1 ? "claim" : "claims"}
              </div>
              <p className="mt-1 text-sm text-amber-800">
                The AI tried to state something your master resume does not support.
                Those edits were removed automatically — see the Guardrails tab.
              </p>
            </div>
          )}

          <div className="mt-8">
            <div className="flex gap-1 border-b border-ink-200">
              {(
                [
                  ["diff", `Changes (${application.diff?.length ?? 0})`],
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
                      ? "border-ink-900 text-ink-900"
                      : "border-transparent text-ink-500 hover:text-ink-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="pt-5">
              {tab === "diff" && <DiffView diff={application.diff ?? []} />}
              {tab === "guardrails" && (
                <GuardrailView
                  errors={errors}
                  warnings={warnings}
                  verified={report?.keywords_verified ?? []}
                  requested={report?.keywords_requested ?? []}
                />
              )}
              {tab === "requirements" && (
                <RequirementsView requirements={application.job?.requirements ?? null} />
              )}
            </div>
          </div>
        </>
      )}

      <div className="mt-10">
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

      <div className="mt-10 border-t border-ink-200 pt-5">
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
    tone === "warn" ? "text-amber-700" : tone === "ok" ? "text-emerald-700" : "";
  return (
    <div className="card p-3">
      <div className="text-xs text-ink-500">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}

function DiffView({ diff }: { diff: DiffEntry[] }) {
  if (diff.length === 0) {
    return (
      <p className="text-sm text-ink-600">
        No changes were made — your resume already matched this posting.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {diff.map((entry, index) => (
        <div key={index} className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-ink-200 bg-ink-50 px-4 py-2">
            <span className="text-sm font-medium">{entry.label}</span>
            <span className="text-xs uppercase tracking-wide text-ink-500">
              {entry.section} · {entry.change}
            </span>
          </div>
          <div className="grid gap-px bg-ink-100 md:grid-cols-2">
            <DiffSide title="Original" value={entry.before} tone="before" />
            <DiffSide title="Tailored" value={entry.after} tone="after" />
          </div>
        </div>
      ))}
    </div>
  );
}

function DiffSide({
  title,
  value,
  tone,
}: {
  title: string;
  value: string | string[] | null;
  tone: "before" | "after";
}) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return (
    <div className={`bg-white p-4 ${tone === "after" ? "md:bg-emerald-50/40" : ""}`}>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">
        {title}
      </div>
      {items.length === 0 ? (
        <p className="text-sm italic text-ink-400">— removed —</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item, index) => (
            <li key={index} className="text-sm leading-relaxed text-ink-800">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GuardrailView({
  errors,
  warnings,
  verified,
  requested,
}: {
  errors: GuardrailViolation[];
  warnings: GuardrailViolation[];
  verified: string[];
  requested: string[];
}) {
  const missing = requested.filter((k) => !verified.includes(k));

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium">ATS keyword coverage</h3>
        <p className="mt-1 text-xs text-ink-500">
          Verified against the text actually in your resume — not what the model
          claimed.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {verified.map((keyword) => (
            <span key={keyword} className="badge bg-emerald-100 text-emerald-800">
              {keyword}
            </span>
          ))}
          {missing.map((keyword) => (
            <span
              key={keyword}
              className="badge border border-dashed border-ink-300 bg-white text-ink-500"
              title="Not present in your resume — HireCraft will not add a claim you cannot back up."
            >
              {keyword}
            </span>
          ))}
          {requested.length === 0 && (
            <span className="text-sm text-ink-500">No keywords extracted.</span>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-red-800">
            Blocked ({errors.length})
          </h3>
          <p className="mt-1 text-xs text-ink-500">
            Removed from your resume because your master resume does not support them.
          </p>
          <ul className="mt-3 space-y-2">
            {errors.map((violation, index) => (
              <li
                key={index}
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
              >
                {violation.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-amber-800">
            Review before sending ({warnings.length})
          </h3>
          <ul className="mt-3 space-y-2">
            {warnings.map((violation, index) => (
              <li
                key={index}
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              >
                {violation.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {errors.length === 0 && warnings.length === 0 && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Every tailored statement traces back to your master resume.
        </p>
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
    return <p className="text-sm text-ink-600">No requirements extracted.</p>;
  }
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Section title="Required skills">
        <div className="flex flex-wrap gap-1.5">
          {requirements.required_skills.map((skill) => (
            <span key={skill.name} className="badge bg-ink-100 text-ink-800">
              {skill.name}
            </span>
          ))}
        </div>
      </Section>
      <Section title="Preferred skills">
        <div className="flex flex-wrap gap-1.5">
          {requirements.preferred_skills.map((skill) => (
            <span key={skill.name} className="badge bg-ink-50 text-ink-600">
              {skill.name}
            </span>
          ))}
        </div>
      </Section>
      <Section title="Responsibilities">
        <ul className="list-disc space-y-1 pl-4 text-sm text-ink-700">
          {requirements.responsibilities.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </Section>
      <Section title="Qualifications">
        <ul className="list-disc space-y-1 pl-4 text-sm text-ink-700">
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
