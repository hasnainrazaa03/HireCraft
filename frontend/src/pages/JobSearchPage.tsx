import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type JobSearchResult } from "../lib/api";
import { EmptyState, Spinner } from "../components/ui";
import {
  IconSearch, IconSparkles, IconCheck, IconPin, IconBriefcase,
  IconGlobe, IconClock, IconBookmark, IconRefresh, IconArrowRight,
} from "../components/icons";

// --- helpers ----------------------------------------------------------------

const SUFFIX = /\b(gmbh|inc|llc|ltd|co|corp|group|gbr|ag|se|kg|plc|limited|technologies|labs)\b/gi;

function guessDomain(company: string): string {
  const slug = company.toLowerCase().replace(SUFFIX, "").replace(/[^a-z0-9]/g, "");
  return slug ? `${slug}.com` : "";
}

function timeAgo(unix: number | null): string {
  if (!unix) return "";
  const days = Math.floor((Date.now() / 1000 - unix) / 86400);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const SAVED_KEY = "hirecraft.savedJobs";
function loadSaved(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || "[]")); } catch { return new Set(); }
}

/**
 * Stable identity for a posting — the same rule the backend dedupes on.
 *
 * Not every source supplies a URL (it normalises a missing one to ""), so
 * keying on `job.url` alone lumped every URL-less posting together under "":
 * saving one showed all of them as saved. It's also the React key, so it has to
 * follow the job rather than its position — JobCard keeps its flipped state,
 * and an index key handed that state to whatever job landed at the same slot
 * after a re-sort.
 */
function jobKey(job: JobSearchResult): string {
  return job.url || `${job.source}|${job.title}|${job.company}`;
}

const GRADIENT_BTN =
  "btn text-white shadow-[0_4px_20px_rgba(255,79,216,0.25)] hover:-translate-y-px";
const GRADIENT_STYLE = { backgroundImage: "linear-gradient(135deg,#ff4fd8 0%,#7c4dff 55%,#5a2bde 100%)" };

type Sort = "match" | "newest";

// --- page -------------------------------------------------------------------

export default function JobSearchPage() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("match");
  const [saved, setSaved] = useState<Set<string>>(loadSaved);
  const [modal, setModal] = useState<JobSearchResult | null>(null);

  const { data: jobs, isLoading, isFetching } = useQuery({
    queryKey: ["job-search", query, remoteOnly],
    queryFn: () =>
      api.get<JobSearchResult[]>(
        `/jobs/search?limit=30${query ? `&q=${encodeURIComponent(query)}` : ""}${remoteOnly ? "&remote_only=true" : ""}`,
      ),
  });

  function toggleSave(job: JobSearchResult) {
    const key = jobKey(job);
    setSaved((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  // Persist as an effect, not inside the updater: React double-invokes state
  // updaters in StrictMode, and a write buried in one runs twice.
  useEffect(() => {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...saved]));
  }, [saved]);

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
        <h1 className="text-2xl font-semibold tracking-tight">Job Search</h1>
        <p className="mt-1 text-sm text-muted">Discover jobs that match your profile and career goals.</p>
      </div>

      <div className="space-y-3">
        <form onSubmit={(e) => { e.preventDefault(); setQuery(input.trim()); }} className="relative">
          <IconSearch className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input
            className="input py-3 pl-11 pr-24 text-base"
            placeholder="Search by title, company, keywords…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" className="btn-primary absolute right-1.5 top-1/2 -translate-y-1/2 !py-2">Search</button>
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
          {!query && (
            <div className="flex items-center gap-2 text-sm text-brand-200">
              <IconSparkles className="h-4 w-4" />
              <span>Recommended for your profile — AI-ranked against your résumé. Search above to explore more.</span>
            </div>
          )}
          <div className="grid gap-6 xl:grid-cols-2">
            {sorted.map((job) => (
              <JobCard
                key={jobKey(job)} job={job} saved={saved.has(jobKey(job))}
                onSave={() => toggleSave(job)}
                onTailor={() => tailor(job)}
                onOpen={() => setModal(job)}
              />
            ))}
          </div>
          <p className="pt-1 text-center text-xs text-subtle">
            Aggregated from {[...new Set(sorted.map((j) => j.source.split(" · ")[0]))].join(" · ")}
            {" "}· top matches AI-ranked against your résumé
          </p>
        </>
      )}

      {modal && (
        <JobModal
          job={modal} saved={saved.has(jobKey(modal))}
          onSave={() => toggleSave(modal)}
          onTailor={() => tailor(modal)}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
      active ? "border-brand-500/60 bg-brand-500/15 text-brand-200" : "border-white/[0.08] bg-surface-2 text-muted hover:text-content"
    }`}>{children}</button>
  );
}

// --- card (matches the reference: logo, title, ring, meta, skills, actions) -

function JobCard({ job, saved, onSave, onTailor, onOpen }: {
  job: JobSearchResult; saved: boolean; onSave: () => void; onTailor: () => void; onOpen: () => void;
}) {
  const [flipped, setFlipped] = useState(false);
  const allSkills = [...job.strengths, ...job.gaps];
  return (
    <div className="group h-[22rem] [perspective:1800px]">
      <div className={`relative h-full w-full transition-transform duration-[600ms] [transform-style:preserve-3d] ${flipped ? "[transform:rotateY(180deg)]" : ""}`}>
        {/* FRONT */}
        <div className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-surface p-5 transition-all duration-300 [backface-visibility:hidden] group-hover:-translate-y-1 group-hover:border-brand-500/25 group-hover:shadow-glow">
          <button
            onClick={() => setFlipped(true)}
            className="absolute right-4 top-4 z-10 text-subtle transition hover:rotate-90 hover:text-content"
            title="Flip for quick analysis" aria-label="Show quick analysis"
          >
            <IconRefresh className="h-4 w-4" />
          </button>

          <div className="flex items-start gap-3.5">
            <CompanyLogo company={job.company || job.title} domain={job.company_domain} />
            <div className="min-w-0 flex-1 pr-6">
              <h3 className="line-clamp-2 text-[17px] font-semibold leading-snug text-content">{job.title}</h3>
              <div className="mt-0.5 truncate text-sm font-medium text-electric">{job.company || "—"}</div>
            </div>
          </div>

          <div className="mt-3 flex items-start justify-between gap-3">
            <div className="space-y-1.5 text-sm text-muted">
              <div className="flex items-center gap-1.5">
                <IconPin className="h-4 w-4 text-subtle" /> {job.location || "Location N/A"}
                {job.remote && <span className="text-subtle">• Remote</span>}
              </div>
              <div className="flex items-center gap-1.5">
                <IconBriefcase className="h-4 w-4 text-subtle" /> Full Time
              </div>
            </div>
            <MatchRing score={job.match_score} verdict={job.verdict} />
          </div>

          {allSkills.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {allSkills.slice(0, 3).map((s) => (
                <span key={s} className="rounded-lg border border-white/[0.07] bg-surface-2 px-2.5 py-1 text-xs text-content">{s}</span>
              ))}
              {allSkills.length > 3 && (
                <span className="rounded-lg border border-white/[0.07] bg-surface-2 px-2.5 py-1 text-xs text-subtle">+{allSkills.length - 3} more</span>
              )}
            </div>
          )}

          <div className="mt-auto space-y-3 pt-3">
            <div className="flex items-center gap-1.5 text-xs text-subtle">
              <span>{job.created_at ? `Posted ${timeAgo(job.created_at)}` : "Recently posted"}</span>
              <span>·</span>
              <span className="truncate text-brand-300/70">{job.source}</span>
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
              <button onClick={onOpen} className="inline-flex items-center gap-1 text-sm font-medium text-brand-300 hover:text-brand-200">
                View More <IconArrowRight className="h-4 w-4" />
              </button>
              <div className="flex items-center gap-1.5">
                <button onClick={onTailor} className="btn-primary btn-sm"><IconSparkles className="h-4 w-4" /> Tailor Resume</button>
                <button onClick={onSave} className={`btn-ghost btn-sm !px-2 ${saved ? "text-brand-300" : ""}`} title={saved ? "Saved" : "Save"} aria-label={saved ? "Remove from saved" : "Save job"} aria-pressed={saved}>
                  <IconBookmark className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* BACK (quick analysis — flip retained) */}
        <div className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-surface-2 p-5 [backface-visibility:hidden] [transform:rotateY(180deg)]">
          <button onClick={() => setFlipped(false)} className="absolute right-4 top-4 z-10 text-subtle transition hover:-rotate-90 hover:text-content" title="Flip back" aria-label="Back to job details">
            <IconRefresh className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-brand-300">
            <IconSparkles className="h-3.5 w-3.5" /> Quick analysis
          </div>
          <div className="mt-3 flex-1 space-y-2 overflow-y-auto pr-1">
            {job.strengths.slice(0, 4).map((s) => (
              <div key={s} className="flex items-center gap-2 text-sm text-content"><IconCheck className="h-4 w-4 shrink-0 text-emerald" /> {s}</div>
            ))}
            {job.gaps.slice(0, 4).map((g) => (
              <div key={g} className="flex items-center gap-2 text-sm text-muted"><span className="w-4 shrink-0 text-center text-coral">⚠</span> Missing {g}</div>
            ))}
            {job.strengths.length === 0 && job.gaps.length === 0 && <p className="text-sm text-subtle">Add a résumé to see a full breakdown.</p>}
          </div>
          {job.interview_chance && (
            <div className="mt-2 flex items-center justify-between rounded-xl bg-surface px-3 py-2 text-sm">
              <span className="text-muted">Interview chance</span>
              <span className={`font-semibold ${chanceTone(job.interview_chance)}`}>{job.interview_chance}</span>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button onClick={onOpen} className="btn-ghost btn-sm">Full details</button>
            <button onClick={onTailor} className="btn-primary btn-sm"><IconSparkles className="h-4 w-4" /> Tailor</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- modal (matches the reference: tabs + AI match analysis) ----------------

type Tab = "overview" | "match" | "requirements" | "recruiters";

function JobModal({ job, saved, onSave, onTailor, onClose }: {
  job: JobSearchResult; saved: boolean; onSave: () => void; onTailor: () => void; onClose: () => void;
}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("overview");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:p-8" onClick={onClose}>
      <div
        className="my-4 w-full max-w-2xl animate-fade-in rounded-3xl border border-white/[0.08] bg-canvas-raised shadow-soft"
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label={`${job.title} at ${job.company}`}
      >
        {/* Header */}
        <div className="relative border-b border-white/[0.06] p-6">
          <button onClick={onClose} className="absolute right-5 top-5 text-subtle transition hover:text-content" aria-label="Close">✕</button>
          <div className="flex items-start gap-3.5 pr-8">
            <div className="group"><CompanyLogo company={job.company || job.title} domain={job.company_domain} /></div>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold leading-tight text-content">{job.title}</h2>
              <div className="text-sm font-medium text-electric">{job.company}</div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
            {job.location && <Meta icon={<IconPin className="h-4 w-4" />}>{job.location}</Meta>}
            <Meta icon={<IconBriefcase className="h-4 w-4" />}>Full Time</Meta>
            {job.remote && <Meta icon={<IconGlobe className="h-4 w-4" />}>Remote</Meta>}
            {job.created_at && <Meta icon={<IconClock className="h-4 w-4" />}>Posted {timeAgo(job.created_at)}</Meta>}
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <button onClick={onTailor} className={`${GRADIENT_BTN} flex-1 sm:flex-none`} style={GRADIENT_STYLE}>
              <IconSparkles className="h-4 w-4" /> Tailor My Resume
            </button>
            <button onClick={onSave} className="btn-secondary">
              <IconBookmark className="h-4 w-4" /> {saved ? "Saved" : "Save Job"}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-white/[0.06] px-6">
          {(["overview", "match", "requirements", "recruiters"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium capitalize transition ${
                tab === t ? "border-brand-500 text-content" : "border-transparent text-subtle hover:text-content"
              }`}>
              {t === "match" ? "Match Analysis" : t}
            </button>
          ))}
        </div>

        <div className="p-6">
          {tab === "overview" && <OverviewTab job={job} onWhy={() => setTab("match")} onImprove={onTailor} />}
          {tab === "match" && <MatchTab job={job} />}
          {tab === "requirements" && <RequirementsTab job={job} />}
          {tab === "recruiters" && <RecruitersTab company={job.company} onDraft={() => { onClose(); navigate("/cover-letters"); }} />}
        </div>
      </div>
    </div>
  );
}

function Meta({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 text-subtle">{icon}<span className="text-muted">{children}</span></span>;
}

function OverviewTab({ job, onWhy, onImprove }: { job: JobSearchResult; onWhy: () => void; onImprove: () => void }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <h3 className="section-title mb-2">About the role</h3>
          <p className="line-clamp-6 text-sm leading-relaxed text-muted">{job.snippet || "No description available."}</p>
          {job.url && (
            <a href={job.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm text-brand-300 hover:text-brand-200">
              View Full Description <IconArrowRight className="h-4 w-4" />
            </a>
          )}
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-surface-2 p-4">
          <h3 className="section-title mb-3">Skills you have</h3>
          {job.strengths.length ? (
            <ul className="space-y-2">
              {job.strengths.slice(0, 6).map((s) => (
                <li key={s} className="flex items-center gap-2.5 text-sm text-content">
                  <span className="h-2 w-2 rounded-full bg-emerald" /> {s}
                </li>
              ))}
              {job.strengths.length > 6 && <li className="badge-brand mt-1 inline-block">+{job.strengths.length - 6} more</li>}
            </ul>
          ) : <p className="text-sm text-subtle">No overlapping skills detected from this posting.</p>}
        </div>
      </div>

      {/* AI Match Analysis */}
      <div className="rounded-2xl border border-white/[0.07] bg-surface-2 p-5">
        <h3 className="section-title mb-4">AI Match Analysis</h3>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <MatchRing score={job.match_score} verdict={job.verdict} />
          <div className="text-sm leading-relaxed text-muted">
            {job.summary || "Add a résumé to see your fit for this role."}
            <button onClick={onWhy} className="ml-1 inline-flex items-center gap-1 text-brand-300 hover:text-brand-200">
              Why this score? <IconArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <div>
            <div className="mb-2 text-sm font-medium text-emerald">Your Strengths</div>
            <ul className="space-y-1.5">
              {job.strengths.length ? job.strengths.map((s) => (
                <li key={s} className="flex items-center gap-2 text-sm text-content"><IconCheck className="h-4 w-4 text-emerald" /> {s}</li>
              )) : <li className="text-sm text-subtle">—</li>}
            </ul>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium text-coral">Potential Gaps</div>
            <ul className="space-y-1.5">
              {job.gaps.length ? job.gaps.map((g) => (
                <li key={g} className="flex items-center gap-2 text-sm text-muted"><span className="text-coral">⚠</span> {g}</li>
              )) : <li className="text-sm text-subtle">None detected</li>}
            </ul>
            <button onClick={onImprove} className="btn-primary btn-sm mt-3"><IconSparkles className="h-4 w-4" /> Improve Your Match</button>
          </div>
        </div>
      </div>

      {/* Interview chance */}
      {job.interview_chance && (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/[0.07] bg-surface-2 p-5">
          <div>
            <h3 className="section-title">Estimated Interview Chance</h3>
            <div className={`mt-1 text-lg font-semibold ${chanceTone(job.interview_chance)}`}>{job.interview_chance}</div>
            <p className="text-xs text-subtle">Based on your profile and role requirements</p>
          </div>
          <Sparkline tone={job.interview_chance} />
        </div>
      )}
    </div>
  );
}

function MatchTab({ job }: { job: JobSearchResult }) {
  const total = job.strengths.length + job.gaps.length;
  const coverage = total ? Math.round((job.strengths.length / total) * 100) : job.match_score ?? 0;
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/[0.07] bg-surface-2 p-6 sm:flex-row">
        <MatchRing score={job.match_score} verdict={job.verdict} />
        <p className="text-sm leading-relaxed text-muted">{job.summary}</p>
      </div>
      <div>
        <div className="mb-1.5 flex justify-between text-sm">
          <span className="text-muted">Requirement coverage</span>
          <span className="tabular-nums text-content">{coverage}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full" style={{ width: `${coverage}%`, backgroundImage: "linear-gradient(90deg,#34d399,#7c4dff)" }} />
        </div>
        <p className="mt-1.5 text-xs text-subtle">
          You cover {job.strengths.length} of {total || "—"} skills this posting mentions.
        </p>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-medium text-emerald">Matched</div>
          <div className="flex flex-wrap gap-1.5">
            {job.strengths.length ? job.strengths.map((s) => <span key={s} className="badge-emerald">{s}</span>) : <span className="text-sm text-subtle">—</span>}
          </div>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium text-coral">To strengthen</div>
          <div className="flex flex-wrap gap-1.5">
            {job.gaps.length ? job.gaps.map((g) => <span key={g} className="badge-coral">{g}</span>) : <span className="text-sm text-subtle">None</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function RequirementsTab({ job }: { job: JobSearchResult }) {
  const items = [...job.strengths.map((s) => ({ name: s, have: true })), ...job.gaps.map((g) => ({ name: g, have: false }))];
  return items.length ? (
    <div className="space-y-2">
      <p className="text-sm text-subtle">Skills &amp; tools this posting mentions, matched against your résumé.</p>
      <ul className="mt-3 divide-y divide-white/[0.05] rounded-2xl border border-white/[0.07]">
        {items.map((it) => (
          <li key={it.name} className="flex items-center justify-between px-4 py-2.5 text-sm">
            <span className="text-content">{it.name}</span>
            {it.have ? (
              <span className="inline-flex items-center gap-1 text-emerald"><IconCheck className="h-4 w-4" /> You have this</span>
            ) : (
              <span className="text-coral">Missing</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  ) : <p className="text-sm text-subtle">No specific requirements were detected in this posting's text.</p>;
}

function RecruitersTab({ company, onDraft }: { company: string; onDraft: () => void }) {
  const steps = [
    `Check ${company || "the company"}'s careers or team page — many list the hiring contact directly.`,
    `Search LinkedIn (in its own interface) for "recruiter ${company}" to find who's likely hiring.`,
    "Look for a warm intro first — 2nd-degree connections or your school's alumni network.",
    "Only use contact details a person has published for this purpose. Don't guess or scrape private addresses.",
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-brand-500/20 bg-brand-500/[0.06] p-4 text-sm text-muted">
        HireCraft doesn't scrape or store anyone's personal contact data. Here's how to find the right person through
        legitimate channels — then reach out respectfully.
      </div>
      <ol className="space-y-2.5">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3 text-sm text-content">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-500/15 text-[11px] font-semibold text-brand-300">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      <button onClick={onDraft} className="btn-secondary">Draft outreach in the studio</button>
    </div>
  );
}

function Sparkline({ tone }: { tone: string }) {
  const color = tone === "High" ? "#34d399" : tone === "Medium" ? "#4CC9F0" : "#f87171";
  const pts = "0,26 14,22 28,24 42,16 56,18 70,10 84,12 98,5 112,7 126,2";
  return (
    <svg width="130" height="32" viewBox="0 0 130 32" className="shrink-0">
      <defs>
        <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={`${pts} 130,32 0,32`} fill="url(#spark)" stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function chanceTone(c: string): string {
  return c === "High" ? "text-emerald" : c === "Medium" ? "text-electric" : "text-coral";
}

// --- company logo + match ring ----------------------------------------------

const AVATAR_TONES = [
  "from-brand-500/30 to-brand-700/30 text-brand-200",
  "from-electric/30 to-blue-600/20 text-electric",
  "from-hotpink/30 to-brand-500/20 text-hotpink",
  "from-emerald/30 to-teal-600/20 text-emerald",
  "from-coral/30 to-orange-600/20 text-coral",
];

function CompanyLogo({ company, domain }: { company: string; domain?: string }) {
  // Try the real domain a source handed us first (accurate), then one guessed
  // from the name, then fall to initials. DuckDuckGo's icon service is the
  // provider — Clearbit's free logo API was sunset and now returns nothing.
  const candidates = [...new Set([domain, guessDomain(company)].filter(Boolean))]
    .map((d) => `https://icons.duckduckgo.com/ip3/${d}.ico`);
  const [idx, setIdx] = useState(0);
  const initials = company.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
  let hash = 0;
  for (let i = 0; i < company.length; i++) hash = (hash * 31 + company.charCodeAt(i)) | 0;
  const tone = AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];

  if (idx < candidates.length) {
    return (
      <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-white p-1.5 shadow-soft transition-transform duration-300 group-hover:scale-105">
        <img src={candidates[idx]} alt={company} className="h-full w-full object-contain" onError={() => setIdx((i) => i + 1)} loading="lazy" />
      </div>
    );
  }
  return (
    <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${tone} text-base font-semibold shadow-soft transition-transform duration-300 group-hover:scale-105`}>
      {initials}
    </div>
  );
}

function MatchRing({ score, verdict }: { score: number | null; verdict?: string | null }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { const t = setTimeout(() => setMounted(true), 60); return () => clearTimeout(t); }, []);
  if (score == null) return null;
  const size = 72, stroke = 7;
  const c = size / 2;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  // Open gauge: draw a 270° arc with the 90° gap centred at the bottom. The
  // circles are rotated 135° so the gap sits at 6 o'clock; the text stays upright.
  const ARC = 0.75;
  const rot = `rotate(135 ${c} ${c})`;
  const gid = `grad-${Math.round(score)}`;
  return (
    <div className="shrink-0 text-center" role="img" aria-label={`${score} percent résumé match${verdict ? `, ${verdict}` : ""}`}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} aria-hidden="true">
          <defs>
            <linearGradient id={gid} x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="100%" stopColor="#7c4dff" />
            </linearGradient>
          </defs>
          {/* track (the full 270° arc) */}
          <circle
            cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth={stroke}
            strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ * (1 - ARC)} transform={rot}
          />
          {/* progress (score along that arc) */}
          <circle
            cx={c} cy={c} r={r} fill="none" stroke={`url(#${gid})`} strokeWidth={stroke}
            strokeLinecap="round" strokeDasharray={circ}
            strokeDashoffset={circ * (1 - ARC * (mounted ? score / 100 : 0))}
            transform={rot}
            style={{ transition: "stroke-dashoffset 900ms cubic-bezier(0.22,1,0.36,1)" }}
          />
        </svg>
        <span className="absolute inset-0 grid place-items-center text-lg font-bold tabular-nums text-content">{score}%</span>
      </div>
      {verdict && <div className="-mt-1 text-[11px] font-medium text-emerald">{verdict}</div>}
    </div>
  );
}
