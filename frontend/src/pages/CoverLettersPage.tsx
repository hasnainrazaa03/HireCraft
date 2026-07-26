import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ResumeProfileSummary,
  type ToneInfo,
  type OutreachKindInfo,
  type CoverLetterResult,
  type OutreachResult,
} from "../lib/api";
import { PageLoader, EmptyState } from "../components/ui";
import { IconLetter, IconSparkles, IconResume } from "../components/icons";
import { useToast } from "../lib/toast";

type Tab = "cover" | "outreach";

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
            <CoverLetterStudio resumes={resumes} />
          ) : (
            <OutreachStudio resumes={resumes} />
          )}
        </>
      )}
    </div>
  );
}

// --- Cover letters ----------------------------------------------------------

function CoverLetterStudio({ resumes }: { resumes: ResumeProfileSummary[] }) {
  const toast = useToast();
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
          <label className="label">Job description</label>
          <textarea
            className="input min-h-[140px]"
            placeholder="Paste the job posting here…"
            value={jobText}
            onChange={(e) => setJobText(e.target.value)}
          />
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
          <input type="checkbox" checked={useVoice} onChange={(e) => setUseVoice(e.target.checked)} />
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
              <div className="space-y-3 rounded-xl border border-white/[0.06] bg-surface-2 p-4">
                {result.paragraphs.map((p, i) => (
                  <p key={i} className="text-sm leading-relaxed text-content">{p}</p>
                ))}
              </div>
            )}

            {/* Nothing survived verification — there is no letter to copy or export. */}
            {result.paragraphs.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <CopyButton text={result.paragraphs.join("\n\n")} label="Copy text" />
                <button onClick={() => void exportAs("pdf")} disabled={!!exporting} className="btn-secondary btn-sm">
                  {exporting === "pdf" ? "…" : "PDF"}
                </button>
                <button onClick={() => void exportAs("docx")} disabled={!!exporting} className="btn-secondary btn-sm">
                  {exporting === "docx" ? "…" : "DOCX"}
                </button>
                <button onClick={() => void exportAs("tex")} disabled={!!exporting} className="btn-secondary btn-sm">
                  {exporting === "tex" ? "…" : "LaTeX"}
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
          <input type="checkbox" checked={useVoice} onChange={(e) => setUseVoice(e.target.checked)} />
          Write in my saved <Link to="/writing" className="text-brand-300 hover:underline">writing voice</Link>
        </label>
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
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
    <div>
      <label className="label">{label}</label>
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
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
