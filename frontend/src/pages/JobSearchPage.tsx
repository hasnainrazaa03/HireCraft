import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type JobSearchResult } from "../lib/api";
import { EmptyState, Spinner } from "../components/ui";
import { IconSearch, IconSparkles, IconCheck } from "../components/icons";

// --- helpers ----------------------------------------------------------------

const SUFFIX = /\b(gmbh|inc|llc|ltd|co|corp|group|gbr|ag|se|kg|plc|limited|technologies|labs)\b/gi;

/** Best-effort company domain for a logo lookup; falls back to an avatar. */
function guessDomain(company: string): string {
  const slug = company
    .toLowerCase()
    .replace(SUFFIX, "")
    .replace(/[^a-z0-9]/g, "");
  return slug ? `${slug}.com` : "";
}

function timeAgo(unix: number | null): string {
  if (!unix) return "";
  const days = Math.floor((Date.now() / 1000 - unix) / 86400);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const SAVED_KEY = "hirecraft.savedJobs";
function loadSaved(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

type Sort = "match" | "newest";

// --- page -------------------------------------------------------------------

export default function JobSearchPage() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("match");
  const [saved, setSaved] = useState<Set<string>>(loadSaved);
  const [detail, setDetail] = useState<JobSearchResult | null>(null);

  const { data: jobs, isLoading, isFetching } = useQuery({
    queryKey: ["job-search", query, remoteOnly],
    queryFn: () =>
      api.get<JobSearchResult[]>(
        `/jobs/search?limit=30${query ? `&q=${encodeURIComponent(query)}` : ""}${remoteOnly ? "&remote_only=true" : ""}`,
      ),
  });

  function toggleSave(job: JobSearchResult) {
    setSaved((prev) => {
      const next = new Set(prev);
      next.has(job.url) ? next.delete(job.url) : next.add(job.url);
      localStorage.setItem(SAVED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  function tailor(job: JobSearchResult) {
    navigate("/new", {
      state: job.url ? { url: job.url } : { text: job.snippet, title: job.title, company: job.company },
    });
  }

  const sorted = [...(jobs ?? [])].sort((a, b) =>
    sort === "match"
      ? (b.match_score ?? 0) - (a.match_score ?? 0)
      : (b.created_at ?? 0) - (a.created_at ?? 0),
  );

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Job search</h1>
        <p className="mt-1 text-sm text-muted">
          Every posting, scored against your résumé — so you know at a glance whether to apply.
        </p>
      </div>

      {/* Search + filters */}
      <div className="space-y-3">
        <form
          onSubmit={(e) => { e.preventDefault(); setQuery(input.trim()); }}
          className="relative"
        >
          <IconSearch className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input
            className="input py-3 pl-11 pr-24 text-base"
            placeholder="Search by title, company, or skill — e.g. Python, ML, backend…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" className="btn-primary absolute right-1.5 top-1/2 -translate-y-1/2 !py-2">
            Search
          </button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <FilterPill active={remoteOnly} onClick={() => setRemoteOnly((v) => !v)}>Remote only</FilterPill>
          <div className="mx-1 h-5 w-px bg-white/[0.08]" />
          <span className="text-xs text-subtle">Sort</span>
          <FilterPill active={sort === "match"} onClick={() => setSort("match")}>Best match</FilterPill>
          <FilterPill active={sort === "newest"} onClick={() => setSort("newest")}>Newest</FilterPill>
        </div>
      </div>

      {isLoading || isFetching ? (
        <div className="py-20 text-center"><Spinner className="mx-auto h-6 w-6" /></div>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={<IconSearch className="h-6 w-6" />}
          title="No matching roles right now"
          description="Try a broader search, or paste a specific posting into a new application."
          action={<button onClick={() => navigate("/new")} className="btn-secondary">New application</button>}
        />
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-2">
            {sorted.map((job, i) => (
              <JobCard
                key={i}
                job={job}
                saved={saved.has(job.url)}
                onSave={() => toggleSave(job)}
                onTailor={() => tailor(job)}
                onDetails={() => setDetail(job)}
              />
            ))}
          </div>
          <p className="pt-1 text-center text-xs text-subtle">
            Results from {sorted[0]?.source} · match scores are an approximate fit against your résumé
          </p>
        </>
      )}

      {detail && (
        <JobDrawer job={detail} onClose={() => setDetail(null)} onTailor={() => tailor(detail)} />
      )}
    </div>
  );
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "border-brand-500/60 bg-brand-500/15 text-brand-200"
          : "border-white/[0.08] bg-surface-2 text-muted hover:text-content"
      }`}
    >
      {children}
    </button>
  );
}

// --- card -------------------------------------------------------------------

function JobCard({
  job, saved, onSave, onTailor, onDetails,
}: {
  job: JobSearchResult;
  saved: boolean;
  onSave: () => void;
  onTailor: () => void;
  onDetails: () => void;
}) {
  const [flipped, setFlipped] = useState(false);
  return (
    <div className="group h-[23rem] [perspective:1800px]">
      <div
        className={`relative h-full w-full transition-transform duration-[600ms] [transform-style:preserve-3d] ${
          flipped ? "[transform:rotateY(180deg)]" : ""
        }`}
      >
        {/* ---------- FRONT ---------- */}
        <div className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-surface p-5 transition-all duration-300 [backface-visibility:hidden] group-hover:-translate-y-1 group-hover:border-brand-500/30 group-hover:shadow-glow">
          <div className="flex items-start gap-3.5">
            <CompanyLogo company={job.company || job.title} />
            <div className="min-w-0 flex-1">
              <h3 className="line-clamp-2 font-semibold leading-snug text-content">{job.title}</h3>
              <div className="mt-0.5 truncate text-sm font-medium text-electric">{job.company || "—"}</div>
            </div>
            <MatchRing score={job.match_score} verdict={job.verdict} />
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
            {job.location && <span>📍 {job.location}</span>}
            {job.remote && <Chip tone="emerald">Remote</Chip>}
            {job.created_at && <span>· {timeAgo(job.created_at)}</span>}
          </div>

          {job.strengths.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {job.strengths.slice(0, 3).map((s) => (
                <span key={s} className="badge bg-white/[0.06] text-content">{s}</span>
              ))}
              {job.strengths.length + job.gaps.length > 3 && (
                <span className="badge-muted">+{job.strengths.length + job.gaps.length - 3} more</span>
              )}
            </div>
          )}

          {/* The signature: an AI fit summary */}
          {job.summary && (
            <div className="mt-3 flex-1 rounded-xl border border-white/[0.05] bg-surface-2/60 p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-brand-300">
                <IconSparkles className="h-3.5 w-3.5" /> AI take
              </div>
              <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-muted">{job.summary}</p>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <button onClick={() => setFlipped(true)} className="btn-ghost btn-sm">Analysis →</button>
            <div className="flex items-center gap-1.5">
              <button onClick={onSave} className={`btn-ghost btn-sm !px-2 ${saved ? "text-brand-300" : ""}`} title={saved ? "Saved" : "Save"}>
                {saved ? "★" : "☆"}
              </button>
              <button onClick={onTailor} className="btn-primary btn-sm">
                <IconSparkles className="h-4 w-4" /> Tailor
              </button>
            </div>
          </div>
        </div>

        {/* ---------- BACK ---------- */}
        <div className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-surface-2 p-5 [backface-visibility:hidden] [transform:rotateY(180deg)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-content">{job.company}</div>
              <div className="line-clamp-1 text-xs text-subtle">{job.title}</div>
            </div>
            <MatchRing score={job.match_score} verdict={job.verdict} small />
          </div>

          <div className="mt-3 flex-1 space-y-2 overflow-y-auto pr-1">
            {job.strengths.slice(0, 4).map((s) => (
              <div key={s} className="flex items-center gap-2 text-sm text-content">
                <IconCheck className="h-4 w-4 shrink-0 text-emerald" /> {s}
              </div>
            ))}
            {job.gaps.slice(0, 4).map((g) => (
              <div key={g} className="flex items-center gap-2 text-sm text-muted">
                <span className="grid h-4 w-4 shrink-0 place-items-center text-coral">⚠</span> Missing {g}
              </div>
            ))}
            {job.strengths.length === 0 && job.gaps.length === 0 && (
              <p className="text-sm text-subtle">Add a résumé to see a full fit breakdown.</p>
            )}
          </div>

          {job.interview_chance && (
            <div className="mt-2 flex items-center justify-between rounded-xl bg-surface px-3 py-2 text-sm">
              <span className="text-muted">Interview chance</span>
              <span className={`font-semibold ${chanceTone(job.interview_chance)}`}>{job.interview_chance}</span>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <button onClick={() => setFlipped(false)} className="btn-ghost btn-sm">← Back</button>
            <div className="flex gap-1.5">
              <button onClick={onDetails} className="btn-secondary btn-sm">Details</button>
              <button onClick={onTailor} className="btn-primary btn-sm">
                <IconSparkles className="h-4 w-4" /> Tailor
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Chip({ tone, children }: { tone?: "emerald"; children: React.ReactNode }) {
  return <span className={tone === "emerald" ? "badge-emerald text-[10px]" : "badge-muted text-[10px]"}>{children}</span>;
}

function chanceTone(c: string): string {
  return c === "High" ? "text-emerald" : c === "Medium" ? "text-electric" : "text-coral";
}

// --- company logo (real, with graceful avatar fallback) ---------------------

const AVATAR_TONES = [
  "from-brand-500/30 to-brand-700/30 text-brand-200",
  "from-electric/30 to-blue-600/20 text-electric",
  "from-hotpink/30 to-brand-500/20 text-hotpink",
  "from-emerald/30 to-teal-600/20 text-emerald",
  "from-coral/30 to-orange-600/20 text-coral",
];

function CompanyLogo({ company }: { company: string }) {
  const [failed, setFailed] = useState(false);
  const domain = guessDomain(company);
  const initials =
    company.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
  let hash = 0;
  for (let i = 0; i < company.length; i++) hash = (hash * 31 + company.charCodeAt(i)) | 0;
  const tone = AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];

  if (domain && !failed) {
    return (
      <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-white p-1.5 shadow-soft transition-transform duration-300 group-hover:scale-105">
        <img
          src={`https://logo.clearbit.com/${domain}`}
          alt={company}
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
          loading="lazy"
        />
      </div>
    );
  }
  return (
    <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${tone} text-base font-semibold shadow-soft transition-transform duration-300 group-hover:scale-105`}>
      {initials}
    </div>
  );
}

// --- match ring (animated, emerald → purple gradient) -----------------------

function MatchRing({ score, verdict, small }: { score: number | null; verdict?: string | null; small?: boolean }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
  }, []);
  if (score == null) return null;
  const size = small ? 44 : 58;
  const stroke = small ? 4 : 5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const gid = `grad-${size}`;
  return (
    <div className="shrink-0 text-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <defs>
            <linearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="100%" stopColor="#7c4dff" />
            </linearGradient>
          </defs>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${gid})`} strokeWidth={stroke}
            strokeLinecap="round" strokeDasharray={circ}
            strokeDashoffset={mounted ? circ * (1 - score / 100) : circ}
            style={{ transition: "stroke-dashoffset 900ms cubic-bezier(0.22,1,0.36,1)" }}
          />
        </svg>
        <span className={`absolute inset-0 grid place-items-center font-bold tabular-nums text-content ${small ? "text-xs" : "text-base"}`}>
          {score}%
        </span>
      </div>
      {!small && verdict && (
        <div className="mt-1 text-[10px] font-medium text-emerald">{verdict}</div>
      )}
    </div>
  );
}

// --- details drawer ---------------------------------------------------------

function JobDrawer({ job, onClose, onTailor }: { job: JobSearchResult; onClose: () => void; onTailor: () => void }) {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg animate-slide-in flex-col overflow-y-auto border-l border-white/[0.08] bg-canvas-raised">
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] p-6">
          <div className="flex items-start gap-3">
            <div className="group"><CompanyLogo company={job.company || job.title} /></div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold leading-tight text-content">{job.title}</h2>
              <div className="text-sm font-medium text-electric">{job.company}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
                {job.location && <span>📍 {job.location}</span>}
                {job.remote && <Chip tone="emerald">Remote</Chip>}
                {job.created_at && <span>· {timeAgo(job.created_at)}</span>}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost btn-sm !px-2" aria-label="Close">✕</button>
        </div>

        <div className="flex gap-2 border-b border-white/[0.06] p-4">
          <button onClick={onTailor} className="btn-primary flex-1">
            <IconSparkles className="h-4 w-4" /> Tailor résumé
          </button>
          <button onClick={() => { onClose(); navigate("/cover-letters"); }} className="btn-secondary">
            Cover letter
          </button>
          {job.url && (
            <a href={job.url} target="_blank" rel="noreferrer" className="btn-secondary">Apply ↗</a>
          )}
        </div>

        <div className="space-y-6 p-6">
          {/* Match analysis */}
          {job.match_score != null && (
            <section>
              <h3 className="section-title mb-3">Match analysis</h3>
              <div className="flex items-center gap-5 rounded-2xl border border-white/[0.06] bg-surface-2 p-5">
                <MatchRing score={job.match_score} verdict={job.verdict} />
                <p className="text-sm leading-relaxed text-muted">{job.summary}</p>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <div className="mb-2 text-sm font-medium text-emerald">Your strengths</div>
                  <ul className="space-y-1.5">
                    {job.strengths.length ? job.strengths.map((s) => (
                      <li key={s} className="flex items-center gap-2 text-sm text-content">
                        <IconCheck className="h-4 w-4 text-emerald" /> {s}
                      </li>
                    )) : <li className="text-sm text-subtle">—</li>}
                  </ul>
                </div>
                <div>
                  <div className="mb-2 text-sm font-medium text-coral">Potential gaps</div>
                  <ul className="space-y-1.5">
                    {job.gaps.length ? job.gaps.map((g) => (
                      <li key={g} className="flex items-center gap-2 text-sm text-muted">
                        <span className="text-coral">⚠</span> {g}
                      </li>
                    )) : <li className="text-sm text-subtle">None detected</li>}
                  </ul>
                </div>
              </div>
              {job.interview_chance && (
                <div className="mt-4 flex items-center justify-between rounded-xl border border-white/[0.06] bg-surface-2 px-4 py-3">
                  <span className="text-sm text-muted">Estimated interview chance</span>
                  <span className={`font-semibold ${chanceTone(job.interview_chance)}`}>{job.interview_chance}</span>
                </div>
              )}
            </section>
          )}

          {/* Overview */}
          <section>
            <h3 className="section-title mb-2">About the role</h3>
            <p className="whitespace-pre-line text-sm leading-relaxed text-muted">
              {job.snippet || "No description available."}
            </p>
            {job.url && (
              <a href={job.url} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm text-brand-300 hover:text-brand-200">
                View the full posting →
              </a>
            )}
          </section>

          {job.tags.length > 0 && (
            <section>
              <h3 className="section-title mb-2">Tags</h3>
              <div className="flex flex-wrap gap-1.5">
                {job.tags.map((t) => <span key={t} className="badge-muted capitalize">{t}</span>)}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
