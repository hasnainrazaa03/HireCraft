import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ResumeProfile,
  type ResumeProfileSummary,
  type ResumeVersionSummary,
  type ResumeParseResponse,
  type ResumeRewriteResponse,
  type ResumeAnalysis,
  type TemplateInfo,
} from "../lib/api";
import { Modal, Spinner } from "../components/ui";
import { TagInput } from "../components/TagInput";
import { ResumeBuilder, pruneEmpty, type ResumeContent } from "../components/ResumeBuilder";
import { ScorePanel } from "../components/ScorePanel";
import { DiffView, ConfidencePanel } from "../components/ReviewPanels";
import { useToast } from "../lib/toast";
import { IconHistory, IconUpload, IconResume, IconChart, IconSparkles } from "../components/icons";

const STARTER: ResumeContent = {
  basics: {
    name: "",
    email: "",
    location: "",
    summary: "One or two sentences about what you do.",
  },
  education: [
    { institution: "", degree: "B.S.", field_of_study: "Computer Science", start_date: "2022", end_date: "2026" },
  ],
  experience: [
    {
      company: "",
      title: "",
      start_date: "2024-05",
      end_date: "2024-08",
      highlights: ["Describe what you built and its measurable impact — real numbers only."],
      technologies: [],
    },
  ],
  projects: [],
  skills: [{ category: "Languages", items: ["Python"] }],
};

type Mode = "builder" | "json";

export default function ResumesPage() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [template, setTemplate] = useState("modern");
  const [onePage, setOnePage] = useState(true);
  // Points at the file the import stashed server-side, so saving keeps the
  // original document alongside the parsed content.
  const [sourceRef, setSourceRef] = useState<string | null>(null);
  const [content, setContent] = useState<ResumeContent>(STARTER);
  const [mode, setMode] = useState<Mode>("builder");
  const [jsonDraft, setJsonDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Label for the first saved version, reflecting where this résumé came from.
  const [originLabel, setOriginLabel] = useState("Original draft");

  const [historyFor, setHistoryFor] = useState<ResumeProfileSummary | null>(null);
  const [previewFor, setPreviewFor] = useState<ResumeProfileSummary | null>(null);
  const [scoreFor, setScoreFor] = useState<ResumeProfileSummary | null>(null);
  const [rewriteFor, setRewriteFor] = useState<ResumeProfileSummary | null>(null);
  const [importing, setImporting] = useState(false);

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ["resumes"],
    queryFn: () => api.get<ResumeProfileSummary[]>("/resumes"),
  });

  const { data: templates = [] } = useQuery({
    queryKey: ["templates"],
    queryFn: () => api.get<TemplateInfo[]>("/resumes/templates"),
  });

  const save = useMutation({
    mutationFn: async () => {
      const body = { name, content: currentContent(), tags, template, one_page: onePage };
      return editingId
        ? api.patch(`/resumes/${editingId}`, body)
        : api.post("/resumes", { ...body, version_label: originLabel, source_ref: sourceRef });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resumes"] });
      close();
      toast.success("Résumé saved");
    },
    onError: (err) => {
      if (err instanceof SyntaxError) setError(`Invalid JSON: ${err.message}`);
      else if (err instanceof ApiError) setError(err.message);
      else setError("Could not save.");
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/resumes/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["resumes"] }),
    onError: (err) => toast.error("Couldn't delete", err instanceof ApiError ? err.message : undefined),
  });

  const makeDefault = useMutation({
    mutationFn: (id: string) => api.patch(`/resumes/${id}`, { is_default: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["resumes"] }),
  });

  function currentContent(): ResumeContent {
    // JSON mode is the user's own literal document — don't touch it. Builder
    // mode is form state, where the placeholder rows "Add bullet"/"Add" create
    // are ours to clean up rather than to fail the save on.
    if (mode === "json") return JSON.parse(jsonDraft);
    return pruneEmpty(content);
  }

  function close() {
    setEditing(false);
    setEditingId(null);
    setName("");
    setTags([]);
    setTemplate("modern");
    setOnePage(true); // one-page is the default; startNew() calls close() first
    setSourceRef(null);
    setContent(STARTER);
    setMode("builder");
    setJsonDraft("");
    setError(null);
    setOriginLabel("Original draft");
  }

  function startNew() {
    close();
    setName("Master Resume");
    setContent(STARTER);
    setEditing(true);
  }

  async function startEdit(p: ResumeProfileSummary) {
    const full = await api.get<ResumeProfile>(`/resumes/${p.id}`);
    setEditingId(p.id);
    setName(full.name);
    setTags(full.tags ?? []);
    setTemplate(full.template ?? "modern");
    setOnePage(full.one_page ?? true);
    setContent(full.content as unknown as ResumeContent);
    setMode("builder");
    setError(null);
    setEditing(true);
  }

  // Switching modes keeps the two representations in sync.
  function switchMode(next: Mode) {
    setError(null);
    if (next === "json" && mode === "builder") {
      setJsonDraft(JSON.stringify(content, null, 2));
    } else if (next === "builder" && mode === "json") {
      try {
        setContent(JSON.parse(jsonDraft));
      } catch (e) {
        setError(`Fix the JSON before switching: ${(e as Error).message}`);
        return;
      }
    }
    setMode(next);
  }

  async function onImport(file: File) {
    setImporting(true);
    setError(null);
    try {
      if (file.name.toLowerCase().endsWith(".json")) {
        // Local JSON: load straight into the builder without a round-trip.
        setContent(JSON.parse(await file.text()));
      } else {
        const res = await api.upload<ResumeParseResponse>("/resumes/parse", file);
        setContent(res.content as unknown as ResumeContent);
        setSourceRef(res.source_ref ?? null);
        toast.success("Résumé imported", "Review and edit before saving.");
      }
      setName((n) => n || file.name.replace(/\.[^.]+$/, "").slice(0, 120));
      setOriginLabel("Imported résumé");
      setMode("builder");
      setEditing(true);
    } catch (err) {
      toast.error("Import failed", err instanceof ApiError ? err.message : "Could not read that file.");
    } finally {
      setImporting(false);
    }
  }

  if (editing) {
    return (
      <Editor
        name={name} setName={setName}
        tags={tags} setTags={setTags}
        template={template} setTemplate={setTemplate}
        onePage={onePage} setOnePage={setOnePage}
        templates={templates}
        mode={mode} switchMode={switchMode}
        content={content} setContent={setContent}
        jsonDraft={jsonDraft} setJsonDraft={setJsonDraft}
        error={error}
        saving={save.isPending}
        onSave={() => { setError(null); save.mutate(); }}
        onCancel={close}
        editingId={editingId}
      />
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Résumés</h1>
          <p className="text-sm text-muted">Your source of truth. Every tailored résumé derives from these.</p>
        </div>
        <div className="flex gap-2">
          <label className="btn-secondary cursor-pointer">
            {importing ? <Spinner className="h-4 w-4" /> : <IconUpload className="h-4 w-4" />}
            Import file
            <input
              type="file"
              accept=".pdf,.docx,.tex,.json,.txt,.md"
              className="hidden"
              disabled={importing}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImport(f); e.target.value = ""; }}
            />
          </label>
          <button onClick={startNew} className="btn-primary">New résumé</button>
        </div>
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-subtle">Loading…</div>
      ) : profiles.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-brand-500/12 text-brand-300">
            <IconResume className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-semibold">No résumé yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            Import an existing résumé (PDF, Word, LaTeX) or build one from scratch. Include
            real metrics — the guardrails won't let the AI invent any.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <label className="btn-secondary cursor-pointer">
              Import file
              <input type="file" accept=".pdf,.docx,.tex,.json,.txt,.md" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImport(f); e.target.value = ""; }} />
            </label>
            <button onClick={startNew} className="btn-primary">Build from scratch</button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {profiles.map((p) => (
            <div key={p.id} className="card flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="max-w-[16rem] truncate font-medium">{p.name}</span>
                  {p.is_default && <span className="badge-brand">Default</span>}
                  <span className="badge-muted capitalize">{p.template}</span>
                  {p.tags?.map((t) => <span key={t} className="badge-muted">{t}</span>)}
                </div>
                <div className="mt-0.5 text-xs text-subtle">
                  v{p.current_version} · updated {new Date(p.updated_at).toLocaleDateString()}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setScoreFor(p)} className="btn-ghost btn-sm">
                  <IconChart className="h-4 w-4" /> Score
                </button>
                <button onClick={() => setRewriteFor(p)} className="btn-ghost btn-sm text-brand">
                  <IconSparkles className="h-4 w-4" /> Improve with AI
                </button>
                <button onClick={() => setPreviewFor(p)} className="btn-ghost btn-sm">Preview</button>
                <ExportMenu profileId={p.id} name={p.name} />
                {/* Only for imported résumés — the exact file the user uploaded,
                    which parsing and a template render can never reproduce. */}
                {p.source_filename && (
                  <button
                    onClick={() => api.download(`/resumes/${p.id}/original`, p.source_filename!)}
                    className="btn-ghost btn-sm"
                    title={`Download the file you uploaded (${p.source_filename})`}
                  >
                    Original
                  </button>
                )}
                {p.current_version > 1 && (
                  <button onClick={() => setHistoryFor(p)} className="btn-ghost btn-sm">
                    <IconHistory className="h-4 w-4" /> History
                  </button>
                )}
                {!p.is_default && (
                  <button onClick={() => makeDefault.mutate(p.id)} className="btn-secondary btn-sm">Make default</button>
                )}
                <button onClick={() => void startEdit(p)} className="btn-secondary btn-sm">Edit</button>
                <button
                  onClick={() => { if (confirm(`Delete "${p.name}"?`)) remove.mutate(p.id); }}
                  className="btn-danger btn-sm"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {historyFor && (
        <VersionHistoryModal
          profile={historyFor}
          onClose={() => setHistoryFor(null)}
          onRestored={() => { queryClient.invalidateQueries({ queryKey: ["resumes"] }); setHistoryFor(null); }}
        />
      )}
      {previewFor && <PreviewModal profile={previewFor} templates={templates} onClose={() => setPreviewFor(null)} />}
      {scoreFor && <ScoreModal profile={scoreFor} onClose={() => setScoreFor(null)} />}
      {rewriteFor && (
        <RewriteModal
          profile={rewriteFor}
          onClose={() => setRewriteFor(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["resumes"] });
            queryClient.invalidateQueries({ queryKey: ["analysis", rewriteFor.id] });
            setRewriteFor(null);
          }}
        />
      )}
    </div>
  );
}

function RewriteModal({
  profile,
  onClose,
  onSaved,
}: {
  profile: ResumeProfileSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();

  // The rewrite is one LLM call, so run it once when the modal opens and hold
  // the result. The user then reviews before anything is written back.
  const rewrite = useMutation({
    mutationFn: () =>
      api.post<ResumeRewriteResponse>(`/resumes/${profile.id}/rewrite`),
    onError: (e) =>
      toast.error(
        "Couldn't rewrite",
        e instanceof ApiError ? e.message : "Please try again in a moment.",
      ),
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/resumes/${profile.id}`, {
        content: rewrite.data!.content,
        version_label: "AI rewrite",
      }),
    onSuccess: () => {
      toast.success("Saved", "The improved résumé is now a new version.");
      onSaved();
    },
    onError: (e) =>
      toast.error(
        "Couldn't save",
        e instanceof ApiError ? e.message : "Please try again.",
      ),
  });

  // Kick off the rewrite exactly once.
  useEffect(() => {
    rewrite.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const result = rewrite.data;
  const delta = result ? result.score_after - result.score_before : 0;
  const confidence = result?.guardrail_report.bullet_confidence ?? [];
  const blocked = confidence.filter((c) => c.confidence === "blocked").length;

  return (
    <Modal open onClose={onClose} title={`Improve with AI — ${profile.name}`} size="xl">
      {rewrite.isPending ? (
        <div className="py-16 text-center">
          <Spinner className="mx-auto h-6 w-6" />
          <p className="mt-3 text-sm text-subtle">
            Rewriting for impact and clarity — every claim stays tied to your résumé.
          </p>
        </div>
      ) : rewrite.isError || !result ? (
        <div className="py-10 text-center">
          <p className="text-sm text-danger">
            {rewrite.error instanceof ApiError
              ? rewrite.error.message
              : "Couldn't rewrite this résumé."}
          </p>
          <button onClick={() => rewrite.mutate()} className="btn-secondary btn-sm mt-4">
            Try again
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Score before/after */}
          <div className="rounded-2xl border border-white/[0.06] bg-surface-2 px-5 py-4">
            <div className="flex flex-wrap items-center gap-4">
              <ScoreDelta label="Before" value={result.score_before} />
              <span className="text-subtle">→</span>
              <ScoreDelta label="After" value={result.score_after} highlight />
              <span
                className={`ml-auto text-sm font-medium ${
                  delta > 0 ? "text-emerald" : delta < 0 ? "text-coral" : "text-subtle"
                }`}
              >
                {delta > 0 ? `+${delta}` : delta} points
              </span>
            </div>
            <p className="mt-3 border-t border-white/[0.06] pt-3 text-xs leading-relaxed text-muted">
              {delta > 0
                ? "The rewrite tightened wording and surfaced more concrete impact, which lifted the score."
                : delta < 0
                  ? "A small dip here is normal: the AI favored readability and concision, which can trade off against raw keyword or metric density. Skim the changes below and keep only what serves you — nothing is saved until you accept."
                  : "Same score, cleaner phrasing — these are lateral gains in clarity. Keep what reads better."}
            </p>
          </div>

          {result.diff.length === 0 ? (
            <p className="rounded-xl border border-emerald/30 bg-emerald/10 px-3 py-2.5 text-sm text-emerald">
              Your résumé is already tight — the AI had nothing meaningful to improve.
            </p>
          ) : (
            <>
              <DiffView
                diff={result.diff}
                afterLabel="Improved"
                emptyMessage="No changes were made."
              />
              <ConfidencePanel
                confidence={confidence}
                intro="Every improved line, verified against your original résumé."
              />
              {blocked > 0 && (
                <p className="text-xs text-subtle">
                  {blocked} suggestion{blocked === 1 ? "" : "s"} were blocked for making
                  a claim your résumé doesn't support, and left out.
                </p>
              )}
            </>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
            <span className="text-xs text-subtle">
              Costs ${result.cost_usd.toFixed(4)} · saved as a new version you can roll back
            </span>
            <div className="flex gap-2">
              <button onClick={onClose} className="btn-secondary">
                Discard
              </button>
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending || result.diff.length === 0}
                className="btn-primary"
              >
                {save.isPending ? "Saving…" : "Accept & save version"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ScoreDelta({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div
        className={`text-2xl font-semibold tabular-nums ${
          highlight ? "text-brand" : "text-content"
        }`}
      >
        {value}
        <span className="ml-0.5 text-sm font-normal text-subtle">/100</span>
      </div>
    </div>
  );
}

function ScoreModal({ profile, onClose }: { profile: ResumeProfileSummary; onClose: () => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["analysis", profile.id],
    queryFn: () => api.get<ResumeAnalysis>(`/resumes/${profile.id}/analysis`),
  });
  return (
    <Modal open onClose={onClose} title={`Score — ${profile.name}`} size="xl">
      {isLoading ? (
        <div className="py-10 text-center"><Spinner className="mx-auto h-6 w-6" /></div>
      ) : isError || !data ? (
        <div className="py-10 text-center text-sm text-danger">Couldn't score this résumé.</div>
      ) : (
        <ScorePanel analysis={data} />
      )}
    </Modal>
  );
}

// --- Editor ------------------------------------------------------------------

function Editor(props: any) {
  const {
    name, setName, tags, setTags, template, setTemplate, templates,
    onePage, setOnePage,
    mode, switchMode, content, setContent, jsonDraft, setJsonDraft,
    error, saving, onSave, onCancel, editingId,
  } = props;
  const toast = useToast();
  const [analysis, setAnalysis] = useState<ResumeAnalysis | null>(null);

  const analyze = useMutation({
    mutationFn: () => {
      // Same pruning as save: scoring a draft shouldn't fail on a blank row.
      const c = mode === "json" ? JSON.parse(jsonDraft) : pruneEmpty(content);
      return api.post<ResumeAnalysis>("/resumes/analyze", c);
    },
    onSuccess: setAnalysis,
    onError: (e) => toast.error("Couldn't score", e instanceof ApiError ? e.message : "Fix any errors first."),
  });

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{editingId ? "Edit résumé" : "New résumé"}</h1>
        <div className="flex gap-2">
          <button onClick={() => analyze.mutate()} disabled={analyze.isPending} className="btn-secondary">
            <IconChart className="h-4 w-4" /> {analyze.isPending ? "Scoring…" : "Score"}
          </button>
          <button onClick={onCancel} className="btn-secondary">Cancel</button>
          <button onClick={onSave} disabled={saving || !name.trim()} className="btn-primary">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {analysis && (
        <Modal open onClose={() => setAnalysis(null)} title="Résumé score" size="xl">
          <ScorePanel analysis={analysis} />
        </Modal>
      )}

      <div className="card mb-5 p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-1">
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="sm:col-span-1">
            <label className="label">Template</label>
            <select className="input" value={template} onChange={(e) => setTemplate(e.target.value)}>
              {templates.map((t: TemplateInfo) => <option key={t.id} value={t.id} className="bg-surface">{t.name}</option>)}
            </select>
          </div>
          <div className="sm:col-span-1">
            <label className="label">Tags</label>
            <TagInput value={tags} onChange={setTags} placeholder="SWE, ML…" />
          </div>
        </div>
        <label className="mt-3 flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={!onePage}
            onChange={(e) => setOnePage(!e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-white/[0.14] bg-surface-3 text-brand-600 focus:ring-brand-500"
          />
          <span>
            <span className="font-medium">Allow more than one page</span>
            <span className="mt-0.5 block text-xs text-subtle">
              By default HireCraft auto-tightens spacing so the résumé fits a single page (preview, exports, and tailored versions). Check this to relax that and let it run onto a second page.
            </span>
          </span>
        </label>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <div className="segment">
          {(["builder", "json"] as Mode[]).map((m) => (
            <button key={m} onClick={() => switchMode(m)} className={`segment-item ${mode === m ? "segment-item-active" : ""}`}>
              {m === "builder" ? "Builder" : "JSON"}
            </button>
          ))}
        </div>
        {editingId && (
          <span className="text-xs text-subtle">Saving content changes creates a new version.</span>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">{error}</div>
      )}

      {mode === "builder" ? (
        <ResumeBuilder value={content} onChange={setContent} />
      ) : (
        <textarea
          className="input min-h-[520px] font-mono text-xs leading-relaxed"
          value={jsonDraft}
          onChange={(e) => setJsonDraft(e.target.value)}
          spellCheck={false}
        />
      )}

      <div className="mt-6 flex justify-end gap-2">
        <button onClick={onCancel} className="btn-secondary">Cancel</button>
        <button onClick={onSave} disabled={saving || !name.trim()} className="btn-primary">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// --- Export menu -------------------------------------------------------------

function ExportMenu({ profileId, name }: { profileId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const safe = name.replace(/\s+/g, "_");

  async function dl(fmt: string) {
    setOpen(false);
    try {
      await api.download(`/resumes/${profileId}/render.${fmt}`, `${safe}.${fmt}`);
    } catch (e) {
      toast.error("Export failed", e instanceof ApiError ? e.message : undefined);
    }
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="btn-secondary btn-sm">Export</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-36 rounded-xl border border-white/[0.1] bg-canvas-raised p-1 shadow-soft">
            {[["pdf", "PDF"], ["docx", "Word (.docx)"], ["tex", "LaTeX"], ["json", "JSON"]].map(([fmt, label]) => (
              <button key={fmt} onClick={() => dl(fmt)} className="nav-item w-full text-sm">{label}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// --- Preview modal -----------------------------------------------------------

function PreviewModal({ profile, templates, onClose }: { profile: ResumeProfileSummary; templates: TemplateInfo[]; onClose: () => void }) {
  const [template, setTemplate] = useState(profile.template);
  const { data: url, isFetching, isError } = useQuery({
    queryKey: ["preview", profile.id, template],
    queryFn: async () => {
      const blob = await api.blob(`/resumes/${profile.id}/render.pdf?template=${template}`);
      return URL.createObjectURL(blob);
    },
    staleTime: 0,
  });

  // Release the object URL when it's replaced (template change) or the modal
  // unmounts, so previewing several templates doesn't leak blobs.
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  return (
    <Modal open onClose={onClose} title={`Preview — ${profile.name}`} size="xl">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm text-muted">Template:</span>
        <select className="input max-w-[12rem]" value={template} onChange={(e) => setTemplate(e.target.value)}>
          {templates.map((t) => <option key={t.id} value={t.id} className="bg-surface">{t.name}</option>)}
        </select>
      </div>
      {/* 70vh on a tall screen, but clamped to what's left inside the dialog
          once its header, padding and the template row are accounted for —
          otherwise the panel's own scrollbar appears and you get two nested
          scroll areas fighting over the same gesture. */}
      <div className="h-[76vh] max-h-[calc(100dvh-14rem)] overflow-hidden rounded-xl border border-white/[0.08] bg-white">
        {isFetching ? (
          <div className="flex h-full items-center justify-center"><Spinner className="h-6 w-6" /></div>
        ) : isError ? (
          <div className="flex h-full items-center justify-center text-sm text-danger">Couldn't render this résumé.</div>
        ) : (
          <iframe title="Résumé preview" src={`${url}#navpanes=0&zoom=page-width`} className="h-full w-full" />
        )}
      </div>
    </Modal>
  );
}

// --- Version history ---------------------------------------------------------

function VersionHistoryModal({ profile, onClose, onRestored }: { profile: ResumeProfileSummary; onClose: () => void; onRestored: () => void }) {
  const toast = useToast();
  const { data: versions = [], isLoading } = useQuery({
    queryKey: ["resume-versions", profile.id],
    queryFn: () => api.get<ResumeVersionSummary[]>(`/resumes/${profile.id}/versions`),
  });
  const restore = useMutation({
    mutationFn: (version: number) => api.post(`/resumes/${profile.id}/versions/${version}/restore`),
    onSuccess: () => { toast.success("Restored", "The résumé was rolled back — this is undoable."); onRestored(); },
    onError: (e) => toast.error("Couldn't restore", e instanceof ApiError ? e.message : undefined),
  });

  return (
    <Modal open onClose={onClose} title={`Version history — ${profile.name}`} wide>
      <p className="mb-4 text-sm text-muted">Each edit is snapshotted. Restoring is itself undoable — the current version is saved before rolling back.</p>
      {isLoading ? (
        <div className="py-6 text-center text-sm text-subtle">Loading…</div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between rounded-xl border border-brand-500/30 bg-brand-500/5 px-4 py-2.5">
            <div>
              <div className="text-sm font-medium">Current — v{profile.current_version}</div>
              {profile.label && <div className="text-xs text-subtle">{profile.label}</div>}
            </div>
            <span className="badge-brand">Live</span>
          </div>
          {versions.length === 0 ? (
            <div className="py-4 text-center text-xs text-subtle">No earlier versions yet — edits and restores will appear here.</div>
          ) : (
            versions.map((v) => (
              <div key={v.id} className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-surface-2 px-4 py-2.5">
                <div>
                  <div className="text-sm font-medium">Version {v.version}</div>
                  <div className="text-xs text-subtle">{v.label ? `${v.label} · ` : ""}{new Date(v.created_at).toLocaleString()}</div>
                </div>
                <button onClick={() => restore.mutate(v.version)} disabled={restore.isPending} className="btn-secondary btn-sm">Restore</button>
              </div>
            ))
          )}
        </div>
      )}
    </Modal>
  );
}
