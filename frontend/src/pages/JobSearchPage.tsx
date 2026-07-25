import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type JobSearchResult } from "../lib/api";
import { EmptyState, Spinner } from "../components/ui";
import { IconSearch, IconSparkles } from "../components/icons";

// Deterministic accent per company so avatars are stable and varied (no logos
// are available from the board, so initials stand in).
const AVATAR_TONES = [
  "bg-brand-500/20 text-brand-200",
  "bg-electric/20 text-electric",
  "bg-hotpink/20 text-hotpink",
  "bg-emerald/20 text-emerald",
  "bg-coral/20 text-coral",
];

function CompanyAvatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "?";
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const tone = AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
  return (
    <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl text-sm font-semibold ${tone}`}>
      {initials}
    </div>
  );
}

export default function JobSearchPage() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(false);

  const { data: jobs, isLoading, isFetching } = useQuery({
    queryKey: ["job-search", query, remoteOnly],
    queryFn: () =>
      api.get<JobSearchResult[]>(
        `/jobs/search?limit=30${query ? `&q=${encodeURIComponent(query)}` : ""}${remoteOnly ? "&remote_only=true" : ""}`,
      ),
  });

  function tailor(job: JobSearchResult) {
    // Deep-link into the tailoring flow with the job prefilled (URL preferred).
    navigate("/new", {
      state: job.url
        ? { url: job.url }
        : { text: job.snippet, title: job.title, company: job.company },
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <IconSearch className="h-6 w-6 text-brand-300" /> Job search
        </h1>
        <p className="mt-1 text-sm text-muted">
          Browse live openings and tailor your résumé to any of them in one click.
          Results come from a public job board.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(input.trim());
        }}
        className="card flex flex-wrap items-center gap-3 p-4"
      >
        <div className="relative min-w-[220px] flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input
            className="input pl-9"
            placeholder="Role, skill, or company — e.g. Python, React, backend…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={remoteOnly} onChange={(e) => setRemoteOnly(e.target.checked)} />
          Remote only
        </label>
        <button type="submit" className="btn-primary">Search</button>
      </form>

      {isLoading || isFetching ? (
        <div className="py-16 text-center"><Spinner className="mx-auto h-6 w-6" /></div>
      ) : !jobs || jobs.length === 0 ? (
        <EmptyState
          icon={<IconSearch className="h-6 w-6" />}
          title="No matching roles right now"
          description="Try a broader search, or paste a specific job posting directly into a new application."
          action={<button onClick={() => navigate("/new")} className="btn-secondary">New application</button>}
        />
      ) : (
        <>
          <div className="grid gap-5 md:grid-cols-2">
            {jobs.map((job, i) => (
              <JobCard key={i} job={job} onTailor={() => tailor(job)} />
            ))}
          </div>
          <p className="pt-2 text-center text-xs text-subtle">
            Results from {jobs[0]?.source} · match scores are an approximate fit against your résumé
          </p>
        </>
      )}
    </div>
  );
}

function JobCard({ job, onTailor }: { job: JobSearchResult; onTailor: () => void }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <div className="h-64 [perspective:1400px]">
      <div
        className={`relative h-full w-full transition-transform duration-500 [transform-style:preserve-3d] ${
          flipped ? "[transform:rotateY(180deg)]" : ""
        }`}
      >
        {/* Front */}
        <div className="absolute inset-0 flex flex-col rounded-2xl border border-white/[0.07] bg-surface p-5 [backface-visibility:hidden]">
          <div className="flex items-start gap-3">
            <CompanyAvatar name={job.company || job.title} />
            <div className="min-w-0 flex-1">
              <h3 className="line-clamp-2 font-semibold leading-snug text-content">{job.title}</h3>
              <div className="mt-1 truncate text-sm font-medium text-muted">{job.company || "—"}</div>
            </div>
            <MatchRing score={job.match_score} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
            {job.location && <span>{job.location}</span>}
            {job.remote && <span className="badge-emerald text-[10px]">Remote</span>}
          </div>
          {job.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {job.tags.slice(0, 4).map((t) => (
                <span key={t} className="badge-muted capitalize">{t}</span>
              ))}
            </div>
          )}
          <div className="mt-auto flex items-center justify-between gap-2 pt-3">
            <button onClick={() => setFlipped(true)} className="btn-ghost btn-sm">
              Details →
            </button>
            <button onClick={onTailor} className="btn-primary btn-sm">
              <IconSparkles className="h-4 w-4" /> Tailor
            </button>
          </div>
        </div>

        {/* Back */}
        <div className="absolute inset-0 flex flex-col rounded-2xl border border-white/[0.07] bg-surface-2 p-5 [backface-visibility:hidden] [transform:rotateY(180deg)]">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-subtle">
              {job.company || "About the role"}
            </span>
            <MatchRing score={job.match_score} small />
          </div>
          <p className="mt-2 flex-1 overflow-y-auto pr-1 text-sm leading-relaxed text-muted">
            {job.snippet || "No description available."}
          </p>
          {job.matched_skills.length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] text-subtle">Your matching skills</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {job.matched_skills.slice(0, 6).map((s) => (
                  <span key={s} className="badge-emerald text-[10px]">{s}</span>
                ))}
              </div>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button onClick={() => setFlipped(false)} className="btn-ghost btn-sm">← Back</button>
            <div className="flex gap-2">
              {job.url && (
                <a href={job.url} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
                  View more
                </a>
              )}
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

function MatchRing({ score, small }: { score: number | null; small?: boolean }) {
  if (score == null) return null;
  const size = small ? 34 : 44;
  const stroke = small ? 3 : 4;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const tone = score >= 70 ? "#34d399" : score >= 45 ? "#5ea0ff" : "#f87171";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title={`~${score}% résumé fit`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ * (1 - score / 100)}
        />
      </svg>
      <span
        className={`absolute inset-0 grid place-items-center font-semibold tabular-nums ${small ? "text-[10px]" : "text-xs"}`}
        style={{ color: tone }}
      >
        {score}
      </span>
    </div>
  );
}
