import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ResumeProfileSummary,
  type ToneInfo,
  type OutreachKindInfo,
  type CoverLetterResult,
  type OutreachResult,
  type SavedCoverLetterSummary,
  type SavedCoverLetterDetail,
  type ApplicationSummary,
} from "../lib/api";
import { PageLoader, EmptyState, Spinner } from "../components/ui";
import { IconLetter, IconSparkles, IconResume, IconRefresh } from "../components/icons";
import { useToast } from "../lib/toast";

type Tab = "cover" | "outreach" | "saved";

export default function CoverLettersPage() {
  const [tab, setTab] = useState<Tab>("cover");

  const { data: resumes, isLoading } = useQuery({
    queryKey: ["resumes"],
    queryFn: () => api.get<ResumeProfileSummary[]>("/resumes"),
  });

  if (isLoading) return <PageLoader label="Loading…" />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Writing studio</h1>
        <p className="mt-1 text-sm text-muted">
          Cover letters and outreach, written from your résumé and in your voice —
          every claim checked against what you've actually done.
        </p>
      </div>

      {!resumes || resumes.length === 0 ? (
        <EmptyState
          icon={<IconResume className="h-6 w-6" />}
          title="Add a résumé first"
          description="The studio writes from your master résumé, so nothing gets invented. Create one to get started."
          action={<Link to="/resumes" className="btn-primary">Add résumé</Link>}
        />
      ) : (
        <>
          <div className="flex gap-1 border-b border-white/[0.08]">
            {(
              [
                ["cover", "Cover letter"],
                ["outreach", "Outreach"],
                ["saved", "Saved letters"],
              ] as [Tab, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
                  tab === value
                    ? "border-brand-600 text-content"
                    : "border-transparent text-subtle hover:text-content"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "cover" ? (
            <CoverLetterStudio resumes={resumes} onSaved={() => setTab("saved")} />
          ) : tab === "outreach" ? (
            <OutreachStudio resumes={resumes} />
          ) : (
            <SavedLettersStudio />
          )}
        </>
      )}
    </div>
  );
}

// --- Cover letters ----------------------------------------------------------

function CoverLetterStudio({ resumes, onSaved }: { resumes: ResumeProfileSummary[]; onSaved: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [resumeId, setResumeId] = useState(resumes[0].id);
  const [jobText, setJobText] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [hiringManager, setHiringManager] = useState("");
  const [tone, setTone] = useState("modern");
  const [useVoice, setUseVoice] = useState(true);
  const [result, setResult] = useState<CoverLetterResult | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  const { data: tones = [] } = useQuery({
    queryKey: ["cover-tones"],
    queryFn: () => api.get<ToneInfo[]>("/studio/cover-letters/tones"),
  });

  const generate = useMutation({
    mutationFn: () =>
      api.post<CoverLetterResult>("/studio/cover-letters/generate", {
        resume_profile_id: resumeId,
        job_text: jobText,
        company: company || null,
        role: role || null,
        hiring_manager: hiringManager || null,
        tone,
        use_voice: useVoice,
      }),
    onSuccess: setResult,
    onError: (e) =>
      toast.error("Couldn't generate", e instanceof ApiError ? e.message : "Please try again."),
  });

  const save = useMutation({
    mutationFn: () =>
      api.post<SavedCoverLetterDetail>("/studio/cover-letters/saved", {
        resume_profile_id: resumeId,
        paragraphs: result!.paragraphs,
        company: company || null,
        role: role || null,
        hiring_manager: hiringManager || null,
        tone,
        used_voice: result!.used_voice,
        job_text: jobText || null,
        guardrail_report: result!.guardrail_report,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["saved-letters"] });
      toast.success("Saved to your letters", "Find it under the Saved letters tab.");
      onSaved();
    },
    onError: (e) => toast.error("Couldn't save", e instanceof ApiError ? e.message : undefined),
  });

  async function exportAs(fmt: "pdf" | "docx" | "tex") {
    if (!result) return;
    setExporting(fmt);
    try {
      await api.downloadPost(
        `/studio/cover-letters/render.${fmt}`,
        {
          resume_profile_id: resumeId,
          paragraphs: result.paragraphs,
          company: company || null,
          role: role || null,
          hiring_manager: hiringManager || null,
        },
        `cover_letter.${fmt}`,
      );
    } catch (e) {
      toast.error("Export failed", e instanceof ApiError ? e.message : "Please retry.");
    } finally {
      setExporting(null);
    }
  }

  const blocked = result?.guardrail_report.violations ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Inputs */}
      <div className="card space-y-4 p-5">
        <ResumePicker resumes={resumes} value={resumeId} onChange={setResumeId} />
        <div>
          <label className="label">Job description or link</label>
          <textarea
            className="input min-h-[140px]"
            placeholder="Paste the job posting text — or a job URL and we'll pull it in…"
            value={jobText}
            onChange={(e) => setJobText(e.target.value)}
          />
          <p className="mt-1 text-xs text-subtle">
            Paste a link (Ashby, Greenhouse, Lever…) and we'll fetch the posting and fill in the company &amp; role.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Company" value={company} onChange={setCompany} placeholder="Globex" />
          <Field label="Role" value={role} onChange={setRole} placeholder="Backend Engineer" />
        </div>
        <Field
          label="Hiring manager (optional)"
          value={hiringManager}
          onChange={setHiringManager}
          placeholder="e.g. Sam Rivera"
        />
        <div>
          <label className="label">Tone</label>
          <select className="input" value={tone} onChange={(e) => setTone(e.target.value)}>
            {tones.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          {tones.find((t) => t.id === tone) && (
            <p className="mt-1 text-xs text-subtle">
              {tones.find((t) => t.id === tone)!.description}
            </p>
          )}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={useVoice} onChange={(e) => setUseVoice(e.target.checked)} className="h-4 w-4 rounded border-white/[0.14] bg-surface-3 text-brand-600 focus:ring-brand-500" />
          Write in my saved <Link to="/writing" className="text-brand-300 hover:underline">writing voice</Link>
        </label>
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending || !jobText.trim()}
          className="btn-primary w-full"
        >
          <IconSparkles className="h-4 w-4" />
          {generate.isPending ? "Writing…" : "Generate cover letter"}
        </button>
      </div>

      {/* Result */}
      <div className="card p-5">
        {generate.isPending ? (
          <CenteredNote>Writing in a {tone} tone — every claim tied to your résumé…</CenteredNote>
        ) : !result ? (
          <CenteredNote>
            <IconLetter className="mx-auto mb-2 h-6 w-6 opacity-40" />
            Your cover letter will appear here.
          </CenteredNote>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="section-title">Your cover letter</h3>
              {result.used_voice && <span className="badge-brand">In your voice</span>}
            </div>

            {blocked.length > 0 && (
              <div className="rounded-xl border border-coral/30 bg-coral/10 px-3 py-2.5 text-sm text-coral">
                {blocked.length} sentence{blocked.length === 1 ? "" : "s"} were removed for
                claiming something your résumé doesn't support.
              </div>
            )}

            {result.paragraphs.length === 0 ? (
              <div className="rounded-xl border border-white/[0.06] bg-surface-2 p-4 text-sm text-muted">
                Every paragraph made a claim your résumé doesn't back, so nothing was
                kept — HireCraft won't hand you a letter it can't stand behind. Add the
                relevant experience to your résumé, or try a different tone, and
                regenerate.
              </div>
            ) : (
              <div className="space-y-4 rounded-xl border border-white/[0.06] bg-surface-2 p-5">
                {result.greeting && (
                  <p className="text-sm leading-relaxed text-content">{result.greeting}</p>
                )}
                {result.paragraphs.map((p, i) => (
                  <p key={i} className="text-sm leading-relaxed text-content">{p}</p>
                ))}
                <div className="pt-1 text-sm leading-relaxed text-content">
                  <p>Sincerely,</p>
                  {result.signature && <p className="mt-3 font-medium">{result.signature}</p>}
                </div>
              </div>
            )}

            {/* Nothing survived verification — there is no letter to copy or export. */}
            {result.paragraphs.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary btn-sm">
                  {save.isPending ? <Spinner className="h-4 w-4" /> : "Save"}
                </button>
                <CopyButton
                  text={[
                    result.greeting,
                    ...result.paragraphs,
                    `Sincerely,\n${result.signature}`,
                  ].filter(Boolean).join("\n\n")}
                  label="Copy text"
                />
                <button onClick={() => void exportAs("pdf")} disabled={!!exporting} className="btn-secondary btn-sm">
                  {exporting === "pdf" ? <Spinner className="h-4 w-4" /> : "PDF"}
                </button>
                <button onClick={() => void exportAs("docx")} disabled={!!exporting} className="btn-secondary btn-sm">
                  {exporting === "docx" ? <Spinner className="h-4 w-4" /> : "DOCX"}
                </button>
                <button onClick={() => void exportAs("tex")} disabled={!!exporting} className="btn-secondary btn-sm">
                  {exporting === "tex" ? <Spinner className="h-4 w-4" /> : "LaTeX"}
                </button>
              </div>
            )}
            <p className="text-xs text-subtle">Cost ${result.cost_usd.toFixed(4)}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Saved letters ----------------------------------------------------------

function SavedLettersStudio() {
  const toast = useToast();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [attachTo, setAttachTo] = useState("");
  const [exporting, setExporting] = useState<string | null>(null);

  const { data: letters = [], isLoading } = useQuery({
    queryKey: ["saved-letters"],
    queryFn: () => api.get<SavedCoverLetterSummary[]>("/studio/cover-letters/saved"),
  });
  const { data: apps = [] } = useQuery({
    queryKey: ["applications"],
    queryFn: () => api.get<ApplicationSummary[]>("/applications"),
  });
  const { data: detail } = useQuery({
    queryKey: ["saved-letter", selectedId],
    queryFn: () => api.get<SavedCoverLetterDetail>(`/studio/cover-letters/saved/${selectedId}`),
    enabled: !!selectedId,
  });

  // Keep a valid selection as the list changes (first load, or after a delete).
  useEffect(() => {
    if (letters.length === 0) {
      if (selectedId) setSelectedId(null);
    } else if (!selectedId || !letters.some((l) => l.id === selectedId)) {
      setSelectedId(letters[0].id);
    }
  }, [letters, selectedId]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["saved-letters"] });
    qc.invalidateQueries({ queryKey: ["saved-letter", selectedId] });
  };

  const refine = useMutation({
    mutationFn: (fb: string) =>
      api.post<SavedCoverLetterDetail>(`/studio/cover-letters/saved/${selectedId}/refine`, { feedback: fb }),
    onSuccess: (d) => {
      const changed = (detail?.paragraphs ?? []).join("\n\n").trim() !== (d.paragraphs ?? []).join("\n\n").trim();
      setFeedback("");
      refresh();
      if (changed) toast.success("Letter refined");
      else toast.info("No change made", "The letter already reflects your résumé for that request.");
    },
    onError: (e) => toast.error("Couldn't refine", e instanceof ApiError ? e.message : undefined),
  });

  const regenerate = useMutation({
    mutationFn: () => api.post<SavedCoverLetterDetail>(`/studio/cover-letters/saved/${selectedId}/regenerate`, {}),
    onSuccess: () => { refresh(); toast.success("Regenerated from scratch"); },
    onError: (e) => toast.error("Couldn't regenerate", e instanceof ApiError ? e.message : undefined),
  });

  const attach = useMutation({
    mutationFn: (appId: string) =>
      api.post<SavedCoverLetterDetail>(`/studio/cover-letters/saved/${selectedId}/attach`, { application_id: appId }),
    onSuccess: () => {
      setAttachTo("");
      refresh();
      qc.invalidateQueries({ queryKey: ["application"] });
      toast.success("Attached", "This letter now shows on that application's Cover Letter tab.");
    },
    onError: (e) => toast.error("Couldn't attach", e instanceof ApiError ? e.message : undefined),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/studio/cover-letters/saved/${id}`),
    onSuccess: () => { setSelectedId(null); refresh(); toast.success("Deleted"); },
    onError: (e) => toast.error("Couldn't delete", e instanceof ApiError ? e.message : undefined),
  });

  const busy = refine.isPending || regenerate.isPending || attach.isPending;

  async function exportAs(fmt: "pdf" | "docx" | "tex") {
    if (!detail) return;
    if (!detail.resume_profile_id) {
      toast.error("Can't export", "The résumé this letter was written from is no longer available.");
      return;
    }
    setExporting(fmt);
    try {
      await api.downloadPost(
        `/studio/cover-letters/render.${fmt}`,
        {
          resume_profile_id: detail.resume_profile_id,
          paragraphs: detail.paragraphs,
          company: detail.company,
          role: detail.role,
          hiring_manager: detail.hiring_manager,
        },
        `cover_letter.${fmt}`,
      );
    } catch (e) {
      toast.error("Export failed", e instanceof ApiError ? e.message : "Please retry.");
    } finally {
      setExporting(null);
    }
  }

  if (isLoading) return <CenteredNote>Loading your saved letters…</CenteredNote>;
  if (letters.length === 0) {
    return (
      <EmptyState
        icon={<IconLetter className="h-6 w-6" />}
        title="No saved letters yet"
        description="Generate a cover letter on the Cover letter tab and hit Save — it'll live here, ready to refine, download, or attach to an application."
      />
    );
  }

  const flags = detail?.guardrail_report?.violations ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      {/* List */}
      <div className="space-y-2">
        {letters.map((l) => (
          <button
            key={l.id}
            onClick={() => setSelectedId(l.id)}
            className={`w-full rounded-xl border px-3.5 py-3 text-left transition ${
              selectedId === l.id
                ? "border-brand-500/60 bg-brand-500/10"
                : "border-white/[0.08] bg-surface-2 hover:border-white/[0.16]"
            }`}
          >
            <div className="truncate text-sm font-medium text-content">
              {l.company || "Untitled letter"}
              {l.role ? <span className="text-subtle"> · {l.role}</span> : null}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-subtle">
              <span>{new Date(l.updated_at).toLocaleDateString()}</span>
              <span>· {l.paragraph_count} paras</span>
              {l.used_voice && <span>· voice</span>}
            </div>
            {l.application_label && (
              <span className="mt-1.5 inline-block rounded-full bg-emerald/15 px-2 py-0.5 text-[10px] text-emerald">
                Linked · {l.application_label}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Detail + actions */}
      <div className="card p-5">
        {!detail ? (
          <CenteredNote>Select a letter to view it.</CenteredNote>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="section-title">{detail.company || "Cover letter"}{detail.role ? ` · ${detail.role}` : ""}</h3>
                <p className="mt-0.5 text-xs text-subtle">
                  {detail.tone} tone{detail.used_voice ? " · in your voice" : ""}
                  {detail.application_label ? ` · linked to ${detail.application_label}` : ""}
                </p>
              </div>
              <button
                onClick={() => { if (confirm("Delete this saved letter?")) del.mutate(detail.id); }}
                disabled={del.isPending}
                className="btn-ghost btn-sm text-subtle hover:text-coral"
              >
                Delete
              </button>
            </div>

            {flags.length > 0 && (
              <div className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2.5 text-xs text-amber-200">
                <p className="font-medium">Guardrails flagged {flags.length} item{flags.length === 1 ? "" : "s"} to verify:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {flags.slice(0, 5).map((v, i) => <li key={i}>{v.detail}</li>)}
                </ul>
              </div>
            )}

            <div className="space-y-4 rounded-xl border border-white/[0.06] bg-surface-2 p-5">
              {detail.greeting && <p className="text-sm leading-relaxed text-content">{detail.greeting}</p>}
              {detail.paragraphs.map((p, i) => (
                <p key={i} className="text-sm leading-relaxed text-content">{p}</p>
              ))}
              <div className="pt-1 text-sm leading-relaxed text-content">
                <p>Sincerely,</p>
                {detail.signature && <p className="mt-3 font-medium">{detail.signature}</p>}
              </div>
            </div>

            {/* Export */}
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton
                text={[detail.greeting, ...detail.paragraphs, `Sincerely,\n${detail.signature}`].filter(Boolean).join("\n\n")}
                label="Copy text"
              />
              <button onClick={() => void exportAs("pdf")} disabled={!!exporting} className="btn-secondary btn-sm">
                {exporting === "pdf" ? <Spinner className="h-4 w-4" /> : "PDF"}
              </button>
              <button onClick={() => void exportAs("docx")} disabled={!!exporting} className="btn-secondary btn-sm">
                {exporting === "docx" ? <Spinner className="h-4 w-4" /> : "DOCX"}
              </button>
              <button onClick={() => void exportAs("tex")} disabled={!!exporting} className="btn-secondary btn-sm">
                {exporting === "tex" ? <Spinner className="h-4 w-4" /> : "LaTeX"}
              </button>
              <button onClick={() => regenerate.mutate()} disabled={busy} className="btn-ghost btn-sm text-subtle hover:text-content">
                {regenerate.isPending ? <Spinner className="h-4 w-4" /> : <><IconRefresh className="h-3.5 w-3.5" /> Regenerate</>}
              </button>
            </div>

            {/* Attach to application */}
            <div className="rounded-xl border border-white/[0.06] bg-surface-2/50 p-3.5">
              <label className="label">Attach to an application</label>
              <p className="mb-2 text-[11px] text-subtle">Copies this letter onto the application's Cover Letter tab.</p>
              <div className="flex gap-2">
                <select className="input flex-1" value={attachTo} onChange={(e) => setAttachTo(e.target.value)}>
                  <option value="">Choose an application…</option>
                  {apps.map((a) => (
                    <option key={a.id} value={a.id}>{a.company || "Application"}{a.job_title ? ` · ${a.job_title}` : ""}</option>
                  ))}
                </select>
                <button
                  onClick={() => attachTo && attach.mutate(attachTo)}
                  disabled={!attachTo || attach.isPending}
                  className="btn-secondary btn-sm shrink-0"
                >
                  {attach.isPending ? <Spinner className="h-4 w-4" /> : "Attach"}
                </button>
              </div>
              {detail.application_id && (
                <Link to={`/applications/${detail.application_id}`} className="mt-2 inline-block text-xs text-brand-300 hover:underline">
                  Open the linked application →
                </Link>
              )}
            </div>

            {/* Refine with feedback */}
            <div>
              <label className="label">Refine with feedback</label>
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  placeholder="e.g. Open with why this team; keep it grounded"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && feedback.trim() && !busy) refine.mutate(feedback.trim()); }}
                />
                <button
                  onClick={() => feedback.trim() && refine.mutate(feedback.trim())}
                  disabled={!feedback.trim() || busy}
                  className="btn-primary btn-sm shrink-0"
                >
                  {refine.isPending ? <Spinner className="h-4 w-4" /> : "Refine"}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-subtle">Grounded to your résumé — guardrails still block anything unsupported.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Outreach ---------------------------------------------------------------

function OutreachStudio({ resumes }: { resumes: ResumeProfileSummary[] }) {
  const toast = useToast();
  const [resumeId, setResumeId] = useState(resumes[0].id);
  const [kind, setKind] = useState("recruiter_email");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [recipient, setRecipient] = useState("");
  const [context, setContext] = useState("");
  const [useVoice, setUseVoice] = useState(true);
  const [result, setResult] = useState<OutreachResult | null>(null);

  const { data: kinds = [] } = useQuery({
    queryKey: ["outreach-kinds"],
    queryFn: () => api.get<OutreachKindInfo[]>("/studio/outreach/kinds"),
  });

  const generate = useMutation({
    mutationFn: () =>
      api.post<OutreachResult>("/studio/outreach/generate", {
        resume_profile_id: resumeId,
        kind,
        company: company || null,
        role: role || null,
        recipient: recipient || null,
        context: context || null,
        use_voice: useVoice,
      }),
    onSuccess: setResult,
    onError: (e) =>
      toast.error("Couldn't generate", e instanceof ApiError ? e.message : "Please try again."),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="card space-y-4 p-5">
        <ResumePicker resumes={resumes} value={resumeId} onChange={setResumeId} />
        <div>
          <label className="label">Message type</label>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k.id} value={k.id}>{k.label}</option>
            ))}
          </select>
          {kinds.find((k) => k.id === kind) && (
            <p className="mt-1 text-xs text-subtle">{kinds.find((k) => k.id === kind)!.description}</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Company" value={company} onChange={setCompany} placeholder="Globex" />
          <Field label="Role" value={role} onChange={setRole} placeholder="Backend Engineer" />
        </div>
        <Field label="Recipient (optional)" value={recipient} onChange={setRecipient} placeholder="e.g. Sam, a recruiter" />
        <div>
          <label className="label">Context (optional)</label>
          <textarea
            className="input min-h-[90px]"
            placeholder="Anything relevant — a mutual connection, where you met, why this role…"
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={useVoice} onChange={(e) => setUseVoice(e.target.checked)} className="h-4 w-4 rounded border-white/[0.14] bg-surface-3 text-brand-600 focus:ring-brand-500" />
          Write in my saved <Link to="/writing" className="text-brand-300 hover:underline">writing voice</Link>
        </label>
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending || !company.trim()}
          className="btn-primary w-full"
        >
          <IconSparkles className="h-4 w-4" />
          {generate.isPending ? "Writing…" : "Generate message"}
        </button>
      </div>

      <div className="card p-5">
        {generate.isPending ? (
          <CenteredNote>Drafting your message…</CenteredNote>
        ) : !result ? (
          <CenteredNote>
            <IconLetter className="mx-auto mb-2 h-6 w-6 opacity-40" />
            Your outreach draft will appear here.
          </CenteredNote>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="section-title">Your draft</h3>
              {result.used_voice && <span className="badge-brand">In your voice</span>}
            </div>

            {result.warnings.map((w, i) => (
              <div key={i} className="rounded-xl border border-coral/30 bg-coral/10 px-3 py-2.5 text-sm text-coral">
                {w}
              </div>
            ))}

            {result.subject && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="label mb-0">Subject</span>
                  <CopyButton text={result.subject} label="Copy" small />
                </div>
                <div className="rounded-xl border border-white/[0.06] bg-surface-2 px-3 py-2 text-sm text-content">
                  {result.subject}
                </div>
              </div>
            )}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="label mb-0">Message</span>
                <CopyButton text={result.body} label="Copy" small />
              </div>
              <div className="whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-surface-2 p-4 text-sm leading-relaxed text-content">
                {result.body}
              </div>
            </div>
            <p className="text-xs text-subtle">Cost ${result.cost_usd.toFixed(4)}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Shared bits ------------------------------------------------------------

function ResumePicker({
  resumes,
  value,
  onChange,
}: {
  resumes: ResumeProfileSummary[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="label">Résumé</label>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {resumes.map((r) => (
          <option key={r.id} value={r.id}>{r.name}</option>
        ))}
      </select>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function CopyButton({ text, label, small }: { text: string; label: string; small?: boolean }) {
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
      className={small ? "btn-ghost btn-sm" : "btn-secondary btn-sm"}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[280px] items-center justify-center px-6 text-center text-sm text-subtle">
      <div>{children}</div>
    </div>
  );
}
