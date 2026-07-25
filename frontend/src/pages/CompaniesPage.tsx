import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, type CompanyBriefResponse, type CompanyBrief } from "../lib/api";
import { IconSparkles, IconShield, IconUsers } from "../components/icons";
import { useToast } from "../lib/toast";

const CONFIDENCE_META: Record<CompanyBrief["confidence"], { label: string; badge: string }> = {
  high: { label: "High confidence", badge: "badge-emerald" },
  medium: { label: "Medium confidence", badge: "badge-blue" },
  low: { label: "Low confidence — verify carefully", badge: "badge-coral" },
};

export default function CompaniesPage() {
  const toast = useToast();
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [url, setUrl] = useState("");
  const [pageText, setPageText] = useState("");
  const [showGrounding, setShowGrounding] = useState(false);
  const [result, setResult] = useState<CompanyBriefResponse | null>(null);

  const generate = useMutation({
    mutationFn: () =>
      api.post<CompanyBriefResponse>("/companies/brief", {
        company,
        role: role || null,
        url: url || null,
        page_text: pageText || null,
      }),
    onSuccess: setResult,
    onError: (e) =>
      toast.error("Couldn't research", e instanceof ApiError ? e.message : "Please try again."),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Company intel</h1>
        <p className="mt-1 text-sm text-muted">
          A quick research brief before you apply or interview — with honest
          confidence levels, not made-up precision.
        </p>
      </div>

      {/* Input */}
      <div className="card flex flex-col items-stretch gap-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Company</label>
            <input
              className="input"
              placeholder="e.g. Stripe"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && company.trim()) generate.mutate();
              }}
            />
          </div>
          <div>
            <label className="label">Role you're targeting (optional)</label>
            <input
              className="input"
              placeholder="e.g. Backend Engineer"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowGrounding((v) => !v)}
          className="self-start text-xs text-brand-300 hover:text-brand-200"
        >
          {showGrounding ? "− Hide" : "+ Add"} a public page for fresher facts (optional)
        </button>
        {showGrounding && (
          <div className="grid gap-3 rounded-xl border border-white/[0.06] bg-surface-2 p-3">
            <div>
              <label className="label">Public page URL</label>
              <input
                className="input"
                placeholder="https://company.com/about"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="text-center text-xs text-subtle">or</div>
            <div>
              <label className="label">Paste page text</label>
              <textarea
                className="input min-h-[80px]"
                placeholder="Paste the company's About / careers page text…"
                value={pageText}
                onChange={(e) => setPageText(e.target.value)}
              />
            </div>
          </div>
        )}

        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending || !company.trim()}
          className="btn-primary self-start"
        >
          <IconSparkles className="h-4 w-4" />
          {generate.isPending ? "Researching…" : "Research company"}
        </button>
      </div>

      {generate.isPending && (
        <div className="card p-10 text-center text-sm text-subtle">
          Pulling together what's known about {company}…
        </div>
      )}

      {result && !generate.isPending && (
        <BriefView result={result} />
      )}
    </div>
  );
}

function BriefView({ result }: { result: CompanyBriefResponse }) {
  const { brief } = result;
  const conf = CONFIDENCE_META[brief.confidence];
  return (
    <div className="space-y-5">
      {/* Disclaimer — always prominent */}
      <div className="flex items-start gap-2.5 rounded-xl border border-coral/30 bg-coral/10 px-4 py-3 text-sm text-coral">
        <IconShield className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{result.disclaimer}</span>
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">
            {result.company}
            {result.role && <span className="text-muted"> · {result.role}</span>}
          </h2>
          <div className="flex items-center gap-2">
            {result.used_grounding && <span className="badge-muted">Grounded in your page</span>}
            <span className={conf.badge}>{conf.label}</span>
          </div>
        </div>

        {brief.overview && (
          <p className="mt-3 text-sm leading-relaxed text-content">{brief.overview}</p>
        )}

        {/* Fact chips */}
        <div className="mt-4 flex flex-wrap gap-2">
          {brief.industry && <Fact label="Industry" value={brief.industry} />}
          {brief.size_band && <Fact label="Size" value={brief.size_band} />}
          {brief.headquarters && <Fact label="HQ" value={brief.headquarters} />}
        </div>

        {brief.freshness_note && (
          <p className="mt-3 text-xs text-subtle">⏱ {brief.freshness_note}</p>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChipSection title="Known for" items={brief.known_for} tone="brand" />
        <ChipSection title="Likely tech stack" items={brief.likely_tech_stack} tone="blue" />
        <ListSection title="Culture signals" items={brief.culture_signals} />
        <ListSection title="Recent context" items={brief.recent_context} caption="Verify — may be dated." />
        <ListSection title="How to stand out" items={brief.interview_angles} icon="✦" />
        <ListSection title="Smart questions to ask" items={brief.smart_questions} icon="?" />
      </div>

      {brief.watch_outs.length > 0 && (
        <div className="card p-5">
          <h3 className="section-title">Worth verifying</h3>
          <ul className="mt-3 space-y-1.5">
            {brief.watch_outs.map((w, i) => (
              <li key={i} className="text-sm text-muted">• {w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Contact guidance — compliant, no PII */}
      <div className="card p-5">
        <div className="flex items-center gap-2">
          <IconUsers className="h-5 w-5 text-brand-300" />
          <h3 className="section-title">Finding the right person</h3>
        </div>
        <ol className="mt-3 space-y-2">
          {result.contact_guidance.steps.map((s, i) => (
            <li key={i} className="flex gap-2.5 text-sm text-content">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-500/15 text-[11px] font-semibold text-brand-300">
                {i + 1}
              </span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-subtle">{result.contact_guidance.note}</p>
        <Link to="/cover-letters" className="btn-secondary btn-sm mt-4">
          Draft outreach in the studio
        </Link>
      </div>

      <p className="text-center text-xs text-subtle">Cost ${result.cost_usd.toFixed(4)}</p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-surface-2 px-2.5 py-1 text-xs">
      <span className="text-subtle">{label}</span>
      <span className="font-medium text-content">{value}</span>
    </span>
  );
}

function ChipSection({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "brand" | "blue";
}) {
  if (items.length === 0) return null;
  const badge = tone === "brand" ? "badge-brand" : "badge-blue";
  return (
    <div className="card p-5">
      <h3 className="section-title">{title}</h3>
      <div className="mt-3 flex flex-wrap gap-2">
        {items.map((it) => (
          <span key={it} className={badge}>{it}</span>
        ))}
      </div>
    </div>
  );
}

function ListSection({
  title,
  items,
  icon = "•",
  caption,
}: {
  title: string;
  items: string[];
  icon?: string;
  caption?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="card p-5">
      <h3 className="section-title">{title}</h3>
      {caption && <p className="mt-1 text-xs text-subtle">{caption}</p>}
      <ul className="mt-3 space-y-2">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2 text-sm leading-relaxed text-content">
            <span className="shrink-0 text-brand-300">{icon}</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
