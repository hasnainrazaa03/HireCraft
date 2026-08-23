import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  fetchAll,
  type ResumeProfileSummary,
  type QuestionCategory,
  type QuestionsResponse,
  type SavedQuestion,
  type SkillGapReport,
  type ApplicationSummary,
  type ApplicationDetail,
  type JobMatch,
} from "../lib/api";
import { PageLoader, EmptyState } from "../components/ui";
import { IconSparkles, IconResume } from "../components/icons";
import { useToast } from "../lib/toast";

const CATEGORIES: { id: QuestionCategory; label: string }[] = [
  { id: "behavioral", label: "Behavioral" },
  { id: "technical", label: "Technical" },
  { id: "resume", label: "Résumé-specific" },
  { id: "project", label: "Project" },
  { id: "company", label: "Company" },
  { id: "system_design", label: "System design" },
  { id: "coding", label: "Coding" },
];

const CAT_LABEL: Record<QuestionCategory, string> = {
  behavioral: "Behavioral",
  technical: "Technical",
  resume: "Résumé",
  project: "Project",
  company: "Company",
  system_design: "System design",
  coding: "Coding",
  general: "General",
};

export default function InterviewPage() {
  const { data: resumes, isLoading } = useQuery({
    queryKey: ["resumes"],
    queryFn: () => api.get<ResumeProfileSummary[]>("/resumes"),
  });

  if (isLoading) return <PageLoader label="Loading…" />;

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Interview prep</h1>
        <p className="mt-1 text-sm text-muted">
          Practice questions tailored to your résumé and role, STAR answers grounded
          in your real experience, and the skills worth shoring up.
        </p>
      </div>

      {!resumes || resumes.length === 0 ? (
        <EmptyState
          icon={<IconResume className="h-6 w-6" />}
          title="Add a résumé first"
          description="Interview prep is built around your real experience. Create a résumé to begin."
          action={<Link to="/resumes" className="btn-primary">Add résumé</Link>}
        />
      ) : (
        <>
          <QuestionStudio resumes={resumes} />
          <SkillGaps resumes={resumes} />
        </>
      )}
    </div>
  );
}

function QuestionStudio({ resumes }: { resumes: ResumeProfileSummary[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [resumeId, setResumeId] = useState(resumes[0].id);
  const [applicationId, setApplicationId] = useState("");
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [selected, setSelected] = useState<Set<QuestionCategory>>(new Set());
  const [useVoice, setUseVoice] = useState(true);

  // Saved questions are the source of truth: the set (and every answer drafted
  // against it) survives a reload, and each question keeps its own answered /
  // unanswered state.
  const { data: questions = [], isLoading: loadingSaved } = useQuery({
    queryKey: ["interview-saved", applicationId],
    queryFn: () =>
      api.get<SavedQuestion[]>(
        `/interview/saved${applicationId ? `?application_id=${applicationId}` : ""}`,
      ),
  });

  // Applications to "prepare for" — picking one grounds the questions in that
  // job (role, company, and the posting's keywords, via the backend). Uses
  // fetchAll to match the { items, … } shape cached under this key elsewhere.
  const { data: appsData } = useQuery({
    queryKey: ["applications"],
    queryFn: () => fetchAll<ApplicationSummary>("/applications"),
  });
  const apps = appsData?.items ?? [];
  // Load the chosen application's detail just to borrow its résumé profile.
  const { data: appDetail } = useQuery({
    queryKey: ["application", applicationId],
    queryFn: () => api.get<ApplicationDetail>(`/applications/${applicationId}`),
    enabled: !!applicationId,
  });
  // Depend on the id, not the whole query object — otherwise any refetch of the
  // application (a new object reference) re-runs this and silently reverts a
  // résumé the user picked manually after choosing an application.
  useEffect(() => {
    if (appDetail?.resume_profile_id) setResumeId(appDetail.resume_profile_id);
  }, [appDetail?.resume_profile_id]);

  function chooseApplication(id: string) {
    setApplicationId(id);
    const app = apps.find((a) => a.id === id);
    if (app) {
      setRole(app.job_title ?? "");
      setCompany(app.company ?? "");
    }
  }

  const generate = useMutation({
    mutationFn: () =>
      api.post<QuestionsResponse>("/interview/questions", {
        resume_profile_id: resumeId,
        application_id: applicationId || null,
        role: role || null,
        company: company || null,
        categories: Array.from(selected),
        count: 8,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["interview-saved", applicationId] });
      toast.success(
        "Questions saved",
        questions.length > 0
          ? "Added new questions — your existing ones and answers are untouched."
          : "They'll still be here when you come back.",
      );
    },
    onError: (e) =>
      toast.error("Couldn't generate", e instanceof ApiError ? e.message : "Please try again."),
  });

  function toggle(cat: QuestionCategory) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-4 p-5">
        {apps.length > 0 && (
          <div>
            <label className="label">Prepare for</label>
            <select className="input" value={applicationId} onChange={(e) => chooseApplication(e.target.value)}>
              <option value="">Custom — standalone prep</option>
              {apps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.company || "Application"}{a.job_title ? ` · ${a.job_title}` : ""}
                </option>
              ))}
            </select>
            {applicationId ? (
              <p className="mt-1 text-xs text-brand-300">
                Grounded in this job — its posting's keywords steer the questions; résumé, role &amp; company auto-filled (still editable below).
              </p>
            ) : (
              <p className="mt-1 text-xs text-subtle">
                Pick an application to auto-fill and ground the questions in that job — or keep it custom.
              </p>
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Résumé</label>
            <select className="input" value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
              {resumes.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Role (optional)</label>
            <input className="input" placeholder="Backend Engineer" value={role} onChange={(e) => setRole(e.target.value)} />
          </div>
          <div>
            <label className="label">Company (optional)</label>
            <input className="input" placeholder="Globex" value={company} onChange={(e) => setCompany(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">Focus areas (optional — leave blank for a mix)</label>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => toggle(c.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  selected.has(c.id)
                    ? "border-brand-500/60 bg-brand-500/15 text-brand-200"
                    : "border-white/[0.08] bg-surface-2 text-muted hover:text-content"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={useVoice}
            onChange={(e) => setUseVoice(e.target.checked)}
            className="h-4 w-4 rounded border-white/[0.14] bg-surface-3 text-brand-600 focus:ring-brand-500"
          />
          Answer in my <Link to="/writing" className="text-brand-300 hover:underline">writing voice</Link>
          <span className="text-xs text-subtle">— adapts wording &amp; tone of drafted answers, not the facts.</span>
        </label>
        <button onClick={() => generate.mutate()} disabled={generate.isPending} className="btn-primary">
          <IconSparkles className="h-4 w-4" />
          {generate.isPending
            ? "Generating…"
            : questions.length > 0
              ? "Generate more questions"
              : "Generate questions"}
        </button>
      </div>

      {applicationId && <ApplicationSkillFit applicationId={applicationId} />}

      {loadingSaved ? (
        <p className="text-sm text-subtle">Loading your saved questions…</p>
      ) : questions.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-subtle">
              {questions.filter((q) => q.answer).length} of {questions.length} answered · saved
              automatically · generating again adds new questions, never repeats
            </p>
          </div>
          {questions.map((q) => (
            <QuestionCard
              key={q.id}
              question={q}
              useVoice={useVoice}
              applicationId={applicationId}
              catLabel={CAT_LABEL[q.category]}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** When preparing for a specific application, show how the résumé stacks up against
 *  that job — strengths and the gaps worth prepping, ranked by importance. Reuses
 *  the deterministic match endpoint (now with semantic skill resolution). */
function ApplicationSkillFit({ applicationId }: { applicationId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["insights-match", applicationId],
    queryFn: () => api.get<JobMatch>(`/insights/applications/${applicationId}/match`),
  });

  if (isLoading) return <div className="card p-5 text-sm text-subtle">Analysing this application…</div>;
  if (!data) return null;

  const have = data.matched_skills.slice().sort((a, b) => b.importance - a.importance);
  const gaps = data.missing_skills.slice().sort((a, b) => b.importance - a.importance);

  // A thinly-extracted posting can list no structured skills — don't show an empty
  // two-column card; point to the cross-job view instead.
  if (have.length === 0 && gaps.length === 0) {
    return (
      <div className="card p-5">
        <h2 className="section-title">How you fit this role</h2>
        <p className="mt-1 text-sm text-subtle">
          This posting didn't list specific skills we could extract, so there's nothing role-specific to compare —
          the cross-job skill view below still applies.
        </p>
      </div>
    );
  }
  const verdictTone =
    data.overall_score >= 75 ? "text-emerald" : data.overall_score >= 55 ? "text-gradient" : "text-coral";

  return (
    <div className="card space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title">How you fit this role</h2>
        <span className="flex items-center gap-2 text-sm">
          <span className={`text-2xl font-semibold tabular-nums ${verdictTone}`}>{data.overall_score}</span>
          <span className="text-xs text-subtle">match · {data.verdict}</span>
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-sm font-medium text-emerald">Strengths to lead with</h3>
          {have.length === 0 ? (
            <p className="mt-2 text-xs text-subtle">No direct skill overlap detected.</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {have.map((s) => (
                <span key={s.name} className="badge-emerald" title={`Importance ${s.importance}/5`}>{s.name}</span>
              ))}
            </div>
          )}
        </div>
        <div>
          <h3 className="text-sm font-medium text-coral">Gaps worth prepping</h3>
          {gaps.length === 0 ? (
            <p className="mt-2 text-xs text-subtle">You cover this role's stated skills — prep stories, not skills.</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {gaps.map((s) => (
                <span
                  key={s.name}
                  className={s.importance >= 4 ? "badge-coral" : "badge-muted"}
                  title={s.importance >= 4 ? "High priority for this JD" : "Nice to have"}
                >
                  {s.name}{s.importance >= 4 ? " ●" : ""}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <p className="text-[11px] text-subtle">
        Deterministic — from this job's requirements vs. your résumé. Demonstrated skills count even when the exact
        keyword is absent (e.g. MongoDB → NoSQL). ● marks a high-priority gap.
      </p>
    </div>
  );
}

/** One saved question. Answered and unanswered questions live side by side, so
 *  the actions differ: a question with no answer offers "Draft a STAR answer",
 *  one that already has an answer offers "Redraft" (when the stored answer isn't
 *  good enough) — the redraft replaces it. Both persist. */
function QuestionCard({
  question,
  useVoice,
  applicationId,
  catLabel,
}: {
  question: SavedQuestion;
  useVoice: boolean;
  applicationId: string;
  catLabel: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const answer = question.answer;

  const draft = useMutation({
    mutationFn: () =>
      api.post<SavedQuestion>(`/interview/saved/${question.id}/answer`, {
        use_voice: useVoice,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["interview-saved", applicationId] });
      toast.success(answer ? "Answer redrafted" : "Answer drafted and saved");
    },
    onError: (e) =>
      toast.error("Couldn't draft", e instanceof ApiError ? e.message : "Please try again."),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/interview/saved/${question.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["interview-saved", applicationId] }),
    onError: (e) =>
      toast.error("Couldn't remove", e instanceof ApiError ? e.message : undefined),
  });

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="badge-muted">{catLabel}</span>
            {answer ? (
              <span className="badge-emerald text-[10px]">Answered</span>
            ) : (
              <span className="badge-muted text-[10px]">No answer yet</span>
            )}
          </span>
          <p className="mt-2 text-sm font-medium text-content">{question.question}</p>
          {question.why && <p className="mt-1.5 text-xs text-subtle">Why they ask: {question.why}</p>}
          {question.tip && <p className="mt-1 text-xs text-brand-300">💡 {question.tip}</p>}
        </div>
        <button
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
          className="btn-ghost btn-sm shrink-0 text-subtle hover:text-coral"
          title="Remove this question"
        >
          Remove
        </button>
      </div>

      {!answer && (
        <button
          onClick={() => draft.mutate()}
          disabled={draft.isPending}
          className="btn-secondary btn-sm mt-3"
        >
          {draft.isPending ? "Drafting…" : "Draft a STAR answer"}
        </button>
      )}

      {answer && (
        <div className="mt-4 space-y-2 rounded-xl border border-white/[0.06] bg-surface-2 p-4">
          {question.answer_warnings.map((w, i) => (
            <div key={i} className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">
              {w}
            </div>
          ))}
          <StarField label="Situation" text={answer.situation} />
          <StarField label="Task" text={answer.task} />
          <StarField label="Action" text={answer.action} />
          <StarField label="Result" text={answer.result} />
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {question.used_voice ? (
              <span className="text-[11px] text-subtle">In your voice</span>
            ) : <span />}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => draft.mutate()}
                disabled={draft.isPending}
                className="btn-ghost btn-sm text-subtle hover:text-content"
                title="Not happy with this one? Draft a different answer."
              >
                {draft.isPending ? "Redrafting…" : "Redraft"}
              </button>
              <CopyButton
                text={`Situation: ${answer.situation}\nTask: ${answer.task}\nAction: ${answer.action}\nResult: ${answer.result}`}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StarField({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-brand-300">{label}</span>
      <p className="text-sm leading-relaxed text-content">{text}</p>
    </div>
  );
}

function SkillGaps({ resumes }: { resumes: ResumeProfileSummary[] }) {
  const [resumeId, setResumeId] = useState(resumes[0].id);
  const { data, isLoading } = useQuery({
    queryKey: ["skill-gaps", resumeId],
    queryFn: () => api.get<SkillGapReport>(`/insights/skill-gaps?resume_id=${resumeId}`),
  });

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title">Skill gaps across your saved jobs</h2>
        <select
          className="input max-w-[200px] py-1.5 text-sm"
          value={resumeId}
          onChange={(e) => setResumeId(e.target.value)}
        >
          {resumes.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <p className="mt-4 text-sm text-subtle">Analysing…</p>
      ) : !data || data.jobs_analyzed === 0 ? (
        <p className="mt-4 text-sm text-subtle">
          Once you've saved a few applications, the most in-demand skills you're missing
          will show up here.
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          <div className="flex flex-wrap gap-6 text-sm">
            <div>
              <div className="text-2xl font-semibold tabular-nums text-content">{data.jobs_analyzed}</div>
              <div className="text-xs text-subtle">jobs analysed</div>
            </div>
            {data.average_match != null && (
              <div>
                <div className="text-2xl font-semibold tabular-nums text-gradient">{data.average_match}</div>
                <div className="text-xs text-subtle">avg match</div>
              </div>
            )}
          </div>

          {data.top_missing.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-coral">Most impactful skills to learn</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {data.top_missing.map((s) => (
                  <span key={s.name} className="badge-coral" title={`Wanted by ${s.demand} job(s)`}>
                    {s.name}<span className="ml-1 opacity-70">×{s.demand}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {data.covered.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-emerald">In-demand skills you already have</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {data.covered.map((s) => (
                  <span key={s.name} className="badge-emerald">{s.name}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="btn-ghost btn-sm"
    >
      {copied ? "Copied!" : "Copy answer"}
    </button>
  );
}
