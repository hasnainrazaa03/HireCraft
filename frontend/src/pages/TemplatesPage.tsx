import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type TemplateInfo, type ResumeProfileSummary } from "../lib/api";
import { PageLoader, Modal, Spinner } from "../components/ui";
import { IconTemplate, IconResume } from "../components/icons";
import { useToast } from "../lib/toast";

// A tiny, self-contained "look" preview per template — no external assets.
const PREVIEW: Record<string, { accent: string; rule: string; serif?: boolean }> = {
  modern: { accent: "bg-brand-500", rule: "border-brand-500/40" },
  ats: { accent: "bg-white/70", rule: "border-white/20" },
  minimal: { accent: "bg-emerald", rule: "border-transparent" },
  academic: { accent: "bg-coral", rule: "border-coral/40", serif: true },
};

export default function TemplatesPage() {
  const [preview, setPreview] = useState<TemplateInfo | null>(null);

  const { data: templates, isLoading } = useQuery({
    queryKey: ["templates"],
    queryFn: () => api.get<TemplateInfo[]>("/resumes/templates"),
  });
  const { data: resumes = [] } = useQuery({
    queryKey: ["resumes"],
    queryFn: () => api.get<ResumeProfileSummary[]>("/resumes"),
  });

  if (isLoading || !templates) return <PageLoader label="Loading templates…" />;

  const resume = resumes.find((r) => r.is_default) ?? resumes[0] ?? null;

  return (
    <div className="space-y-7">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <IconTemplate className="h-6 w-6 text-brand-300" /> Templates
        </h1>
        <p className="mt-1 text-sm text-muted">
          Every template is ATS-safe and typeset with LaTeX. Click any to preview{" "}
          {resume ? <>your <span className="text-content">{resume.name}</span></> : "a résumé"} in it,
          then pick one per résumé in the builder.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((t) => {
          const p = PREVIEW[t.id] ?? PREVIEW.modern;
          return (
            <button
              key={t.id}
              onClick={() => setPreview(t)}
              className="card card-hover group overflow-hidden text-left"
            >
              <div className="relative aspect-[3/4] bg-surface-2 p-5">
                <div className={`mx-auto h-full w-full rounded-lg border ${p.rule} bg-surface p-4 shadow-soft`}>
                  <div className={`h-2.5 w-1/2 rounded ${p.accent} ${p.serif ? "font-serif" : ""}`} />
                  <div className="mt-1.5 h-1.5 w-1/3 rounded bg-white/15" />
                  <div className={`mt-4 h-px w-full ${p.rule} border-t`} />
                  <div className="mt-3 space-y-1.5">
                    {[80, 95, 70, 88, 60].map((w, i) => (
                      <div key={i} className="h-1.5 rounded bg-white/10" style={{ width: `${w}%` }} />
                    ))}
                  </div>
                  <div className={`mt-4 h-2 w-1/3 rounded ${p.accent} opacity-70`} />
                  <div className="mt-2 space-y-1.5">
                    {[92, 78, 85].map((w, i) => (
                      <div key={i} className="h-1.5 rounded bg-white/10" style={{ width: `${w}%` }} />
                    ))}
                  </div>
                </div>
                <div className="absolute inset-0 grid place-items-center bg-canvas/60 opacity-0 backdrop-blur-sm transition group-hover:opacity-100">
                  <span className="btn-primary btn-sm pointer-events-none">Preview</span>
                </div>
              </div>
              <div className="border-t border-white/[0.06] p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{t.name}</h3>
                  <span className="badge-muted capitalize">{t.id}</span>
                </div>
                <p className="mt-1.5 text-sm text-muted">{t.description}</p>
              </div>
            </button>
          );
        })}
      </div>

      <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-center gap-2 text-sm text-muted">
          <IconResume className="h-4 w-4 text-electric" />
          Choose a template when you create or edit a résumé.
        </div>
        <Link to="/resumes" className="btn-primary">Go to résumés</Link>
      </div>

      {preview && (
        <TemplatePreviewModal template={preview} resume={resume} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

function TemplatePreviewModal({
  template,
  resume,
  onClose,
}: {
  template: TemplateInfo;
  resume: ResumeProfileSummary | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!resume) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    api
      .blob(`/resumes/${resume.id}/render.pdf?template=${template.id}`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't render this template.");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [resume, template.id]);

  return (
    <Modal open onClose={onClose} title={`${template.name} — ${resume?.name ?? "preview"}`} wide>
      {!resume ? (
        <div className="py-12 text-center">
          <p className="text-sm text-muted">Add a résumé first to preview it in a template.</p>
          <Link to="/resumes" className="btn-primary mt-4" onClick={onClose}>Add résumé</Link>
        </div>
      ) : error ? (
        <div className="py-12 text-center text-sm text-danger">{error}</div>
      ) : !url ? (
        <div className="py-16 text-center"><Spinner className="mx-auto h-6 w-6" /></div>
      ) : (
        <>
          {/* Clamped as in ResumesPage's preview: 70vh normally, but never more
              than the dialog can actually show without a second scrollbar. */}
          <iframe title="preview" src={url} className="h-[70vh] max-h-[calc(100dvh-16rem)] w-full rounded-xl border border-white/[0.08] bg-white" />
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => api.download(`/resumes/${resume.id}/render.pdf?template=${template.id}`, `${resume.name}.pdf`).catch(() => toast.error("Download failed"))}
              className="btn-secondary"
            >
              Download PDF
            </button>
            <Link to="/resumes" className="btn-primary" onClick={onClose}>Use in builder</Link>
          </div>
        </>
      )}
    </Modal>
  );
}
