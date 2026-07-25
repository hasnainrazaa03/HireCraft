import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type TemplateInfo } from "../lib/api";
import { PageLoader } from "../components/ui";
import { IconTemplate, IconResume } from "../components/icons";

// A tiny, self-contained "look" preview per template — no external assets.
const PREVIEW: Record<string, { accent: string; rule: string; serif?: boolean }> = {
  modern: { accent: "bg-brand-500", rule: "border-brand-500/40" },
  ats: { accent: "bg-white/70", rule: "border-white/20" },
  minimal: { accent: "bg-emerald", rule: "border-transparent" },
  academic: { accent: "bg-coral", rule: "border-coral/40", serif: true },
};

export default function TemplatesPage() {
  const { data: templates, isLoading } = useQuery({
    queryKey: ["templates"],
    queryFn: () => api.get<TemplateInfo[]>("/resumes/templates"),
  });

  if (isLoading || !templates) return <PageLoader label="Loading templates…" />;

  return (
    <div className="space-y-7">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <IconTemplate className="h-6 w-6 text-brand-300" /> Templates
        </h1>
        <p className="mt-1 text-sm text-muted">
          Every template is ATS-safe and typeset with LaTeX. Pick one per résumé in
          the builder, or preview any of yours in a chosen template.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((t) => {
          const p = PREVIEW[t.id] ?? PREVIEW.modern;
          return (
            <div key={t.id} className="card overflow-hidden">
              {/* Faux résumé preview */}
              <div className="aspect-[3/4] bg-surface-2 p-5">
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
              </div>
              <div className="border-t border-white/[0.06] p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{t.name}</h3>
                  <span className="badge-muted capitalize">{t.id}</span>
                </div>
                <p className="mt-1.5 text-sm text-muted">{t.description}</p>
              </div>
            </div>
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
    </div>
  );
}
