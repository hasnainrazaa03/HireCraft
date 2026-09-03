import { useState, useEffect, useMemo } from "react";
import {
  NOTHING_HIDDEN, activeFilters, withoutFilter,
  loadFilters, saveFilters, loadSkipped, saveSkipped,
} from "../lib/feedPrefs";
import { useNavigate } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api, type JobSearchResult, type ResumeProfileSummary } from "../lib/api";
import { EmptyState, Spinner } from "../components/ui";
import {
  IconSearch, IconSparkles, IconCheck, IconPin,
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

/**
 * Track a CSS media query in React.
 *
 * The detail panel needs a genuinely different DOM depending on width — an
 * inline column beside the list, or an overlay drawer — so it can't be a
 * `hidden lg:block` pair: both shells would mount, and the panel would fetch
 * the posting twice.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * How a posting's age should read on a card.
 *
 * Age is the strongest available signal that a listing is already filled, and
 * the feed carries plenty of postings several months old. Showing "9mo ago" in
 * the same grey as everything else buries that, so old ones are marked — a
 * caution, not a verdict, since some reqs really do stay open.
 */
function freshness(unix: number | null): { label: string; stale: boolean } | null {
  if (!unix) return null;
  const days = Math.floor((Date.now() / 1000 - unix) / 86400);
  return { label: timeAgo(unix), stale: days > 90 };
}

/**
 * How a posting's visa stance should read.
 *
 * Only the two ends are worth a badge. "Sponsors" is rare and worth seeking
 * out; a blocker means the application cannot succeed and is worth seeing
 * before opening the card. Silence is the majority case and says nothing, so it
 * gets no badge rather than a neutral one nobody needs to read.
 */
function visaBadge(verdict: string | undefined): { text: string; tone: string } | null {
  switch (verdict) {
    case "sponsors":
      return { text: "Sponsors visas", tone: "border-emerald/30 bg-emerald/10 text-emerald" };
    case "no_sponsorship":
      return { text: "No sponsorship", tone: "border-amber-400/30 bg-amber-400/10 text-amber-200" };
    case "citizenship_required":
      return { text: "US citizens only", tone: "border-coral/30 bg-coral/10 text-coral" };
    case "clearance_required":
      return { text: "Clearance required", tone: "border-coral/30 bg-coral/10 text-coral" };
    default:
      return null;
  }
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

/**
 * Lay a scraped posting back out as headings, bullets and paragraphs.
 *
 * Extraction keeps the structure the ATS published, marking list items with
 * "• " and headings with "## ". Anything without a marker is a paragraph — and
 * a short line ending in a colon is treated as a heading too, since plenty of
 * boards write their section titles as plain bold text rather than a real
 * heading tag.
 */
type Block =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "list"; items: string[] };

function parsePosting(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("• ")) {
      const item = line.slice(2).trim();
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list") last.items.push(item);
      else blocks.push({ kind: "list", items: [item] });
    } else if (line.startsWith("## ")) {
      blocks.push({ kind: "heading", text: line.slice(3).trim() });
    } else if (line.length <= 60 && line.endsWith(":")) {
      blocks.push({ kind: "heading", text: line.slice(0, -1).trim() });
    } else {
      blocks.push({ kind: "para", text: line });
    }
  }
  return blocks;
}

function Posting({ text }: { text: string }) {
  const blocks = parsePosting(text);
  return (
    <div className="space-y-3.5">
      {blocks.map((b, i) =>
        b.kind === "heading" ? (
          <h4 key={i} className="pt-1.5 text-sm font-semibold tracking-tight text-content">{b.text}</h4>
        ) : b.kind === "list" ? (
          <ul key={i} className="space-y-2">
            {b.items.map((item, j) => (
              <li key={j} className="flex gap-2.5 text-sm leading-relaxed text-muted">
                <span className="mt-[0.5rem] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400/70" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className="text-sm leading-relaxed text-muted">{b.text}</p>
        ),
      )}
    </div>
  );
}

const GRADIENT_BTN =
  "btn text-white shadow-[0_4px_20px_rgba(255,79,216,0.25)] hover:-translate-y-px";
const GRADIENT_STYLE = { backgroundImage: "linear-gradient(135deg,#ff4fd8 0%,#7c4dff 55%,#5a2bde 100%)" };

type Sort = "match" | "newest";

// --- page -------------------------------------------------------------------

type Mode = "feed" | "live";

interface FeedStats {
  total: number;
  active: number;
  new: number;
  closed: number;
  by_bucket: Record<string, number>;
  by_source: Record<string, number>;
  by_level: Record<string, number>;
  by_location: Record<string, number>;
  remote: number;
  last_run: string | null;
}

export default function JobSearchPage() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [exclude, setExclude] = useState("");
  const [mustHave, setMustHave] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [saved, setSaved] = useState<Set<string>>(loadSaved);
  const [modal, setModal] = useState<JobSearchResult | null>(null);
  // "live" searches the boards on demand; "feed" reads the postings the
  // scheduled ATS scraper has accumulated (persisted, so it fills up over time).
  const [mode, setMode] = useState<Mode>("feed");

  // Which résumé the feed is scored against. The stored score was computed at
  // scrape time against whichever résumé was default then, so it goes stale as
  // soon as you add or edit one — picking here re-scores every card live.
  const [feedResume, setFeedResume] = useState("");
  // One object rather than eleven useStates: it is saved, restored and cleared
  // as a unit, and eleven separate effects writing to one storage key would
  // race each other on every keystroke.
  const [filters, setFilters] = useState(loadFilters);
  const setFilter = <K extends keyof typeof filters>(key: K, value: (typeof filters)[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));
  useEffect(() => { saveFilters(filters); }, [filters]);

  // Roles pushed to the bottom. Kept out of `filters` because clearing the
  // filters must not un-skip anything — those are two different decisions.
  const [skipped, setSkipped] = useState<Set<string>>(loadSkipped);
  useEffect(() => { saveSkipped(skipped); }, [skipped]);

  // The rest of this page still speaks in individual filters. These are the one
  // place that translates, so a rename never has to be chased through the JSX.
  const bucket = filters.bucket;
  const setBucket = (v: string) => setFilter("bucket", v);
  const feedLevel = filters.level;
  const setFeedLevel = (v: string) => setFilter("level", v);
  const feedSource = filters.source;
  const setFeedSource = (v: string) => setFilter("source", v);
  const feedLocation = filters.location;
  const setFeedLocation = (v: string) => setFilter("location", v);
  const feedRemote = filters.remote;
  const setFeedRemote = (v: boolean) => setFilter("remote", v);
  const feedMinScore = filters.minScore;
  const setFeedMinScore = (v: number) => setFilter("minScore", v);
  const feedPostedWithin = filters.postedWithin;
  const setFeedPostedWithin = (v: number) => setFilter("postedWithin", v);
  const feedDegree = filters.degree;
  const setFeedDegree = (v: string) => setFilter("degree", v);
  const feedVisa = filters.visa;
  const setFeedVisa = (v: string) => setFilter("visa", v);
  const feedQuery = filters.query;
  const setFeedQuery = (v: string) => setFilter("query", v);
  // Sort is a filter in every way that matters here: chosen once, it says what
  // you want to see first, and resetting it each visit is the same annoyance.
  const sort = (filters.sort || "match") as Sort;
  const setSort = (v: Sort) => setFilter("sort", v);
  const applied = activeFilters(filters);
  // Age cutoff in days; 0 = any age.

  // Defaults to what a master's candidate can actually apply to — see the
  // control's help text for what that does and doesn't exclude.

  // Defaults to hiding what a candidate needing sponsorship cannot get.



  const live = useQuery({
    queryKey: ["job-search", query, remoteOnly, exclude, mustHave],
    enabled: mode === "live",
    queryFn: () =>
      api.get<JobSearchResult[]>(
        `/jobs/search?limit=30${query ? `&q=${encodeURIComponent(query)}` : ""}${remoteOnly ? "&remote_only=true" : ""}` +
          `${exclude.trim() ? `&exclude=${encodeURIComponent(exclude.trim())}` : ""}` +
          `${mustHave.trim() ? `&must_have=${encodeURIComponent(mustHave.trim())}` : ""}`,
      ),
    // Keep the current results on screen while a new search loads, instead of
    // blanking the whole grid to a spinner on every keystroke-search.
    placeholderData: keepPreviousData,
  });

  const { data: feedResumes = [] } = useQuery({
    queryKey: ["resumes"],
    queryFn: () => api.get<ResumeProfileSummary[]>("/resumes"),
  });
  // Default to the user's default résumé so the scores mean something on arrival.
  useEffect(() => {
    if (!feedResume && feedResumes.length) {
      setFeedResume((feedResumes.find((r) => r.is_default) ?? feedResumes[0]).id);
    }
  }, [feedResumes, feedResume]);

  const feedParams = new URLSearchParams({ limit: "120", sort });
  if (feedResume) feedParams.set("resume_id", feedResume);
  if (bucket) feedParams.set("bucket", bucket);
  if (feedLevel) feedParams.set("level", feedLevel);
  if (feedSource) feedParams.set("source", feedSource);
  if (feedLocation) feedParams.set("location", feedLocation);
  if (feedRemote) feedParams.set("remote_only", "true");
  if (feedMinScore) feedParams.set("min_score", String(feedMinScore));
  if (feedPostedWithin) feedParams.set("posted_within", String(feedPostedWithin));
  feedParams.set("degree", feedDegree);
  feedParams.set("visa", feedVisa);
  if (feedQuery.trim()) feedParams.set("q", feedQuery.trim());

  const feed = useQuery({
    queryKey: ["job-feed", feedParams.toString()],
    enabled: mode === "feed",
    queryFn: () => api.get<JobSearchResult[]>(`/jobs/feed?${feedParams.toString()}`),
    placeholderData: keepPreviousData,
  });

  const { data: feedStats } = useQuery({
    queryKey: ["job-feed-stats"],
    queryFn: () => api.get<FeedStats>("/jobs/feed/stats"),
  });

  const active = mode === "feed" ? feed : live;
  const jobs = active.data;
  const isLoading = active.isLoading;
  const isFetching = active.isFetching;

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

  function handoff(job: JobSearchResult, intent: "tailor" | "as_is") {
    const source = job.url
      ? { url: job.url }
      : { text: job.description || job.snippet, title: job.title, company: job.company };
    navigate("/new", { state: { ...source, intent } });
  }

  // Below this width there isn't room for a list and a panel side by side, so
  // the panel becomes an overlay drawer instead.
  const wide = useMediaQuery("(min-width: 1024px)");
  const splitView = modal !== null && wide;

  // Mirrors the server's ordering, including its recency tiebreak — without it
  // an unscored feed (no résumé yet) ties on every comparison and "best match"
  // renders in arbitrary order while looking like a ranking.
  // Skipped roles sink rather than vanish.
  //
  // Hiding them would be the other obvious choice and the wrong one: a skip is
  // a quick judgement made on a card, and quick judgements are sometimes wrong.
  // At the bottom it can be reconsidered; gone, it cannot, and there would be
  // no way to tell a list that has nothing left from one that has been skipped
  // empty.
  const sorted = useMemo(() => {
    const rank = (j: JobSearchResult) => (skipped.has(jobKey(j)) ? 1 : 0);
    return [...(jobs ?? [])].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (sort === "match"
          ? (b.match_score ?? 0) - (a.match_score ?? 0) || (b.created_at ?? 0) - (a.created_at ?? 0)
          : (b.created_at ?? 0) - (a.created_at ?? 0)),
    );
  }, [jobs, sort, skipped]);

  const detail = modal && (
    <JobDetail
      resumeId={mode === "feed" ? feedResume : undefined}
      job={modal} saved={saved.has(jobKey(modal))}
      onSave={() => toggleSave(modal)}
      onTailor={() => handoff(modal, "tailor")}
      onTrack={() => handoff(modal, "as_is")}
      onClose={() => setModal(null)}
    />
  );

  return (
    // Opening a posting splits the page rather than covering it: the board
    // narrows to a single column on the left and stays fully live — scroll it,
    // re-filter it, click straight through to another posting — while the
    // detail sits beside it. Nothing is dimmed and nothing is blocked.
    <div className="flex gap-6">
    <div className="min-w-0 flex-1 space-y-7">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Job Search</h1>
        <p className="mt-1 text-sm text-muted">Discover jobs that match your profile and career goals.</p>
      </div>

      <div className="space-y-3">
        {/* Feed = postings the scheduled ATS scraper has collected (persisted, so
            the list grows); Live = search the boards right now. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="segment">
            <button
              onClick={() => setMode("feed")}
              className={`segment-item ${mode === "feed" ? "segment-item-active" : ""}`}
            >
              My feed{feedStats?.active ? ` (${feedStats.active})` : ""}
            </button>
            <button
              onClick={() => setMode("live")}
              className={`segment-item ${mode === "live" ? "segment-item-active" : ""}`}
            >
              Live search
            </button>
          </div>
          {mode === "feed" && feedStats?.last_run && (
            <span className="text-xs text-subtle">
              Auto-updates every 6 hours · last run {new Date(feedStats.last_run).toLocaleString()}
            </span>
          )}
        </div>

        {mode === "feed" && (
          <div className="space-y-3 rounded-xl border border-white/[0.08] bg-surface-2/40 p-3">
            {/* Which résumé the scores describe. Without this the number is
                whatever résumé happened to be default when the scrape ran. */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="label">Score against</span>
                <select
                  className="input mt-1"
                  value={feedResume}
                  onChange={(e) => setFeedResume(e.target.value)}
                >
                  {feedResumes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}{r.is_default ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Search</span>
                <input
                  className="input mt-1"
                  placeholder="title, company, or place"
                  value={feedQuery}
                  onChange={(e) => setFeedQuery(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">Level</span>
                <select className="input mt-1" value={feedLevel} onChange={(e) => setFeedLevel(e.target.value)}>
                  <option value="">Any level</option>
                  {Object.entries(feedStats?.by_level ?? {}).map(([lv, n]) => (
                    <option key={lv} value={lv}>{lv.replace("_", " ")} ({n})</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Location</span>
                <select className="input mt-1" value={feedLocation} onChange={(e) => setFeedLocation(e.target.value)}>
                  <option value="">Anywhere</option>
                  {Object.entries(feedStats?.by_location ?? {}).map(([loc, n]) => (
                    <option key={loc} value={loc}>{loc} ({n})</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Board</span>
                <select className="input mt-1" value={feedSource} onChange={(e) => setFeedSource(e.target.value)}>
                  <option value="">All boards</option>
                  {Object.entries(feedStats?.by_source ?? {}).map(([s, n]) => (
                    <option key={s} value={s}>{s} ({n})</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Minimum match</span>
                <select className="input mt-1" value={feedMinScore} onChange={(e) => setFeedMinScore(Number(e.target.value))}>
                  {[0, 40, 50, 60, 70, 80].map((v) => (
                    <option key={v} value={v}>{v === 0 ? "Any score" : `${v}+`}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Visa</span>
                <select className="input mt-1" value={feedVisa} onChange={(e) => setFeedVisa(e.target.value)}>
                  <option value="open">Open to sponsorship</option>
                  <option value="sponsors">Explicitly sponsors</option>
                  <option value="no_sponsorship">Won't sponsor</option>
                  <option value="citizenship_required">Citizenship required</option>
                  <option value="clearance_required">Clearance required</option>
                  <option value="any">Any</option>
                </select>
                <span className="mt-1 block text-[11px] leading-snug text-subtle">
                  {feedVisa === "open"
                    ? "Hides roles needing citizenship or a clearance, and explicit refusals. Keeps roles that say nothing — silence isn't a no."
                    : feedVisa === "sponsors"
                      ? "Only roles that say outright they sponsor. A small, high-signal list."
                      : feedVisa === "any"
                        ? "No visa filtering."
                        : "Showing only this category."}
                </span>
              </label>
              <label className="block">
                <span className="label">Education</span>
                <select className="input mt-1" value={feedDegree} onChange={(e) => setFeedDegree(e.target.value)}>
                  <option value="masters_eligible">Master's eligible</option>
                  <option value="graduate_stated">Graduate degree stated</option>
                  <option value="bachelors">Bachelor's stated</option>
                  <option value="undergrad_only">Undergraduate only</option>
                  <option value="phd">PhD required</option>
                  <option value="any">Any</option>
                </select>
                {/* A filter that hides things by default has to say what it
                    hides. A stated bachelor's minimum is kept on purpose — a
                    master's exceeds it — so the only exclusions are postings a
                    master's candidate genuinely can't apply to. */}
                <span className="mt-1 block text-[11px] leading-snug text-subtle">
                  {feedDegree === "masters_eligible"
                    ? "Hides undergraduate-only and PhD-required roles. Keeps roles stating a bachelor's minimum — a master's exceeds it."
                    : feedDegree === "graduate_stated"
                      ? "Only roles that name a master's or graduate degree. Hides roles that state no degree at all."
                      : feedDegree === "any"
                        ? "No education filtering."
                        : "Showing only this level."}
                </span>
              </label>
              <label className="block">
                <span className="label">Date posted</span>
                <select className="input mt-1" value={feedPostedWithin} onChange={(e) => setFeedPostedWithin(Number(e.target.value))}>
                  <option value={0}>Any time</option>
                  <option value={7}>Past week</option>
                  <option value={30}>Past month</option>
                  <option value={90}>Past 3 months</option>
                  <option value={180}>Past 6 months</option>
                </select>
              </label>
              <label className="block">
                <span className="label">Sort</span>
                <select className="input mt-1" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  <option value="match">Best match</option>
                  <option value="newest">Newest</option>
                </select>
              </label>
              <label className="flex items-end gap-2 pb-1.5 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={feedRemote}
                  onChange={(e) => setFeedRemote(e.target.checked)}
                  className="h-4 w-4 rounded border-white/[0.14] bg-surface-3 text-brand-600 focus:ring-brand-500"
                />
                Remote only{feedStats?.remote ? ` (${feedStats.remote})` : ""}
              </label>
            </div>

            {feedStats && Object.keys(feedStats.by_bucket).length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
                <FilterPill active={!bucket} onClick={() => setBucket("")}>
                  All ({feedStats.active})
                </FilterPill>
                {Object.entries(feedStats.by_bucket).map(([b, n]) => (
                  <FilterPill key={b} active={bucket === b} onClick={() => setBucket(b)}>
                    {b} ({n})
                  </FilterPill>
                ))}
              </div>
            )}

            {/* What is actually being applied, spelled out.
                Filters used to be a set of pills whose state you had to read
                off their shading, so "why am I seeing so few of these?" was
                answered by hunting for the one that was on. Each active filter
                is a chip that says what it does and comes off with one click,
                and the whole set clears with one more. */}
            {applied.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-subtle">
                  {applied.length} filter{applied.length === 1 ? "" : "s"} on
                </span>
                {applied.map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setFilters((f) => withoutFilter(f, key))}
                    title={`Remove ${label}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-brand-500/30 bg-brand-500/10 px-3 py-1 text-xs font-medium text-brand-100 hover:border-brand-400/60 hover:bg-brand-500/20"
                  >
                    {label}
                    <span aria-hidden className="text-brand-300">×</span>
                  </button>
                ))}
                <button
                  onClick={() => setFilters({ ...NOTHING_HIDDEN })}
                  className="btn-ghost btn-sm text-subtle hover:text-content"
                >
                  Clear all
                </button>
              </div>
            )}
            {skipped.size > 0 && (
              <div className="flex items-center gap-2 pt-1 text-xs text-subtle">
                <span>{skipped.size} skipped, sorted to the bottom.</span>
                <button onClick={() => setSkipped(new Set())} className="text-brand-300 hover:text-brand-200">
                  Bring them back
                </button>
              </div>
            )}
          </div>
        )}

        {mode === "live" && (
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
        )}
        <div className="flex flex-wrap items-center gap-2">
          {mode === "live" && (
            <>
          <FilterPill active={remoteOnly} onClick={() => setRemoteOnly((v) => !v)}>Remote only</FilterPill>
          <FilterPill active={showFilters || !!(exclude || mustHave)} onClick={() => setShowFilters((v) => !v)}>
            Filters{exclude || mustHave ? " •" : ""}
          </FilterPill>
          <div className="mx-1 h-5 w-px bg-white/[0.08]" />
            </>
          )}
          <span className="text-xs text-subtle">Sort</span>
          <FilterPill active={sort === "match"} onClick={() => setSort("match")}>Best match</FilterPill>
          <FilterPill active={sort === "newest"} onClick={() => setSort("newest")}>Newest</FilterPill>
        </div>
        {mode === "live" && showFilters && (
          <div className="grid gap-3 rounded-xl border border-white/[0.08] bg-surface-2/50 p-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Must include <span className="text-subtle">(comma-separated)</span></span>
              <input className="input mt-1" placeholder="e.g. python, remote" value={mustHave} onChange={(e) => setMustHave(e.target.value)} />
            </label>
            <label className="block">
              <span className="label">Exclude from title <span className="text-subtle">(comma-separated)</span></span>
              <input className="input mt-1" placeholder="e.g. senior, staff, sales" value={exclude} onChange={(e) => setExclude(e.target.value)} />
            </label>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="py-20 text-center"><Spinner className="mx-auto h-6 w-6" /></div>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={<IconSearch className="h-6 w-6" />}
          title={mode === "feed" ? "Your feed is still filling up" : "No matching roles right now"}
          description={
            mode === "feed"
              ? "The scraper runs every 6 hours and saves what matches your profile. Check back shortly, or use Live search in the meantime."
              : "Try a broader search, or paste a specific posting into a new application."
          }
          action={<button onClick={() => navigate("/new")} className="btn-secondary">New application</button>}
        />
      ) : (
        <>
          {!query && (
            <div className="flex items-center gap-2 text-sm text-brand-200">
              <IconSparkles className="h-4 w-4" />
              <span>
                {sorted.some((j) => j.match_score != null)
                  ? "Recommended for your profile — AI-ranked against your résumé. Search above to explore more."
                  : "Newest postings first. Add a résumé, or pick one under \u201cScore against\u201d, to rank these by how well you fit."}
              </span>
            </div>
          )}
          <div className={`grid gap-6 transition-opacity ${splitView ? "" : "xl:grid-cols-2"} ${isFetching ? "opacity-60" : ""}`}>
            {sorted.map((job) => (
              <JobCard
                scoredWith={mode === "feed" ? feedResumes.find((r) => r.id === feedResume)?.name : undefined}
                key={jobKey(job)} job={job} saved={saved.has(jobKey(job))}
                skipped={skipped.has(jobKey(job))}
                onSkip={() => setSkipped((prev) => {
                  const next = new Set(prev);
                  const id = jobKey(job);
                  // The same button undoes it, so a mis-click costs one click.
                  next.has(id) ? next.delete(id) : next.add(id);
                  return next;
                })}
                onSave={() => toggleSave(job)}
                onTailor={() => handoff(job, "tailor")}
                onTrack={() => handoff(job, "as_is")}
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

      {/* Narrow screens: no room to split, so the panel overlays instead. */}
      {modal && !wide && (
        <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm" onClick={() => setModal(null)}>
          <div
            className="absolute right-0 top-0 h-full w-full max-w-xl animate-slide-in-right border-l border-white/[0.08] bg-canvas-raised shadow-soft"
            onClick={(e) => e.stopPropagation()}
            role="dialog" aria-modal="true"
          >
            {detail}
          </div>
        </div>
      )}
    </div>

    {/* Wide screens: a real column in the page flow. Sticky so it stays with
        you as the board scrolls, and capped to the viewport so the panel's own
        body scrolls rather than stretching the page. */}
    {splitView && (
      <aside className="w-[26rem] shrink-0 xl:w-[30rem]">
        {/* top clears the app's sticky header (~4rem) so the panel parks just
            below it rather than sliding underneath. */}
        <div className="sticky top-[4.5rem] h-[calc(100vh-5.5rem)] animate-slide-in-right overflow-hidden rounded-2xl border border-white/[0.08] bg-canvas-raised shadow-soft">
          {detail}
        </div>
      </aside>
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

function JobCard({ job, saved, skipped, onSave, onSkip, onTailor, onTrack, onOpen, scoredWith }: {
  job: JobSearchResult; saved: boolean; onSave: () => void; onTailor: () => void;
  onTrack: () => void; onOpen: () => void;
  /** Pushed to the bottom of the list — not a role for this candidate. */
  skipped?: boolean;
  onSkip?: () => void;
  /** Name of the résumé this card's match score was computed against. */
  scoredWith?: string;
}) {
  const [flipped, setFlipped] = useState(false);
  const allSkills = [...job.strengths, ...job.gaps];
  return (
    <div className={`group h-[22rem] [perspective:1800px] ${skipped ? "opacity-45 saturate-50 hover:opacity-90" : ""}`}>
      <div className={`relative h-full w-full transition-transform duration-[600ms] [transform-style:preserve-3d] ${flipped ? "[transform:rotateY(180deg)]" : ""}`}>
        {/* FRONT */}
        <div className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-surface p-5 transition-all duration-300 [backface-visibility:hidden] group-hover:-translate-y-1 group-hover:border-brand-500/25 group-hover:shadow-glow">
          <button
            onClick={() => setFlipped(true)}
            className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-lg text-subtle transition hover:bg-white/[0.06] hover:text-content"
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
              </div>
              {job.remote && (
                <div className="flex items-center gap-1.5">
                  <IconGlobe className="h-4 w-4 text-subtle" /> Remote
                </div>
              )}
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
            {/* Feed-only: the term bucket the scraper classified this into, and
                which of the user's résumés it recommends sending. */}
            {(job.bucket || job.track_resume) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {job.bucket && <span className="badge-muted text-[10px]">{job.bucket}</span>}
                {/* Deliberately NOT job.track_resume: that comes from the
                    scraper's own config and names a PDF in the user's folder,
                    which may not correspond to any résumé in the app. The score
                    shown on this card is against the résumé selected above, so
                    that is the one to name. */}
                {scoredWith && (
                  <span
                    className="badge-brand text-[10px]"
                    title={`This card's match score is against ${scoredWith}`}
                  >
                    Scored vs {scoredWith}
                  </span>
                )}
                {!job.active && <span className="badge-coral text-[10px]">Closed</span>}
              </div>
            )}
            <div className="flex items-center gap-1.5 text-xs text-subtle">
              {(() => {
                const age = freshness(job.created_at);
                if (!age) return <span>Posted date unknown</span>;
                return (
                  <span className={age.stale ? "text-amber-300/90" : undefined}>
                    Posted {age.label}{age.stale ? " · may be filled" : ""}
                  </span>
                );
              })()}
              {(() => {
                const badge = visaBadge(job.visa_verdict);
                return badge ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.tone}`}>
                    {badge.text}
                  </span>
                ) : null;
              })()}
              <span>·</span>
              <span className="truncate text-brand-300/70">{job.source}</span>
              {job.sponsorship && (
                <>
                  <span>·</span>
                  <span className="truncate" title="What the posting says about visa sponsorship">
                    {job.sponsorship.slice(0, 28)}
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
              <button onClick={onOpen} className="inline-flex items-center gap-1 text-sm font-medium text-brand-300 hover:text-brand-200">
                View More <IconArrowRight className="h-4 w-4" />
              </button>
              <div className="flex items-center gap-1.5">
                {onSkip && (
                  <button
                    onClick={onSkip}
                    className={`btn-ghost btn-sm !px-2 ${skipped ? "!text-brand-200" : "text-subtle hover:text-content"}`}
                    title={skipped ? "Bring this back up the list" : "Not for me — push to the bottom"}
                    aria-label={skipped ? "Un-skip this job" : "Skip this job"}
                    aria-pressed={!!skipped}
                  >
                    {skipped ? "Undo" : "Skip"}
                  </button>
                )}
                <button onClick={onTrack} className="btn-secondary btn-sm" title="Add to your tracker with your résumé as it is — no AI, no cost">Track</button>
                <button onClick={onTailor} className="btn-primary btn-sm"><IconSparkles className="h-4 w-4" /> Tailor Resume</button>
                <button onClick={onSave} className={`btn-ghost btn-sm !px-2 ${saved ? "!bg-brand-500/20 !text-brand-200" : ""}`} title={saved ? "Saved" : "Save"} aria-label={saved ? "Remove from saved" : "Save job"} aria-pressed={saved}>
                  <IconBookmark className={`h-4 w-4 ${saved ? "fill-current" : ""}`} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* BACK (quick analysis — flip retained) */}
        <div className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-surface-2 p-5 [backface-visibility:hidden] [transform:rotateY(180deg)]">
          <button onClick={() => setFlipped(false)} className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-lg text-subtle transition hover:bg-white/[0.06] hover:text-content" title="Flip back" aria-label="Back to job details">
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
            <button onClick={onTrack} className="btn-secondary btn-sm" title="Add to your tracker with your résumé as it is — no AI, no cost">Track</button>
            <button onClick={onTailor} className="btn-primary btn-sm"><IconSparkles className="h-4 w-4" /> Tailor</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- detail panel (tabs + AI match analysis) --------------------------------

type Tab = "overview" | "match" | "requirements" | "recruiters";

function JobDetail({ job: initial, saved, onSave, onTailor, onTrack, onClose, resumeId }: {
  job: JobSearchResult; saved: boolean; onSave: () => void; onTailor: () => void;
  onTrack: () => void; onClose: () => void;
  /** Résumé the re-fetched posting should be re-scored against. */
  resumeId?: string;
}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("overview");
  // Most feed rows come from aggregator lists that carry no description, so the
  // card has nothing to show and nothing to score. They do carry the ATS link,
  // so pull the real posting the moment the user opens one.
  const [job, setJob] = useState(initial);
  const [fetching, setFetching] = useState(false);
  useEffect(() => setJob(initial), [initial]);
  useEffect(() => {
    // The list response carries only a 400-character preview, so the panel
    // always pulls the single-job response to get the whole description — and
    // for aggregator rows that arrived with no body at all, that call is also
    // what scrapes it from the ATS.
    if (!job.id || job.description || fetching) return;
    setFetching(true);
    api
      .post<JobSearchResult>(
        `/jobs/feed/${job.id}/fetch${resumeId ? `?resume_id=${resumeId}` : ""}`,
      )
      .then(setJob)
      .catch(() => {/* dead link — leave the card as it was */})
      .finally(() => setFetching(false));
    // Only on opening a different posting.
  }, [job.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // Just the panel's contents. Positioning belongs to whichever shell renders
    // it — an inline column beside the list on a wide screen, an overlay drawer
    // when there isn't room for both.
    <div
      className="flex h-full flex-col overflow-hidden"
      aria-label={`${job.title} at ${job.company}`}
    >
        {/* Header — fixed while the body scrolls, so the title and the primary
            action stay reachable however long the posting is. */}
        <div className="relative shrink-0 border-b border-white/[0.06] p-6">
          <button onClick={onClose} className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-lg text-base text-subtle transition hover:bg-white/[0.06] hover:text-content" aria-label="Close">✕</button>
          <div className="flex items-start gap-3.5 pr-8">
            <div className="group"><CompanyLogo company={job.company || job.title} domain={job.company_domain} /></div>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold leading-tight text-content">{job.title}</h2>
              <div className="text-sm font-medium text-electric">{job.company}</div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
            {job.location && <Meta icon={<IconPin className="h-4 w-4" />}>{job.location}</Meta>}
            {job.remote && <Meta icon={<IconGlobe className="h-4 w-4" />}>Remote</Meta>}
            {(() => {
              const age = freshness(job.created_at);
              if (!age) return null;
              return (
                <span className="inline-flex items-center gap-1.5 text-subtle">
                  <IconClock className="h-4 w-4" />
                  <span className={age.stale ? "text-amber-300/90" : "text-muted"}>
                    Posted {age.label}
                  </span>
                  {age.stale && (
                    <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-200">
                      may be filled
                    </span>
                  )}
                </span>
              );
            })()}
          </div>
          {(() => {
            const badge = visaBadge(job.visa_verdict);
            if (!badge) return null;
            return (
              <div className={`mt-3 rounded-xl border px-3 py-2 ${badge.tone}`}>
                <div className="text-xs font-semibold">{badge.text}</div>
                {/* The sentence that decided it. A verdict this consequential
                    should be checkable rather than taken on trust. */}
                {job.visa_evidence && (
                  <p className="mt-1 text-[11px] leading-snug opacity-80">…{job.visa_evidence}…</p>
                )}
              </div>
            );
          })()}
          <div className="mt-5 flex flex-wrap gap-3">
            <button onClick={onTailor} className={`${GRADIENT_BTN} flex-1 sm:flex-none`} style={GRADIENT_STYLE}>
              <IconSparkles className="h-4 w-4" /> Tailor My Resume
            </button>
            {/* Applying without a rewrite is the common case for a role that
                already fits, and it costs nothing. */}
            <button onClick={onTrack} className="btn-secondary" title="Add to your tracker with your résumé as it is — no AI, no cost">
              Apply as-is
            </button>
            <button onClick={onSave} className={`btn-secondary ${saved ? "!border-brand-500/40 !bg-brand-500/20 !text-brand-200" : ""}`}>
              <IconBookmark className={`h-4 w-4 ${saved ? "fill-current" : ""}`} /> {saved ? "Saved" : "Save Job"}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-white/[0.06] px-6">
          {(["overview", "match", "requirements", "recruiters"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium capitalize transition ${
                tab === t ? "border-brand-500 text-content" : "border-transparent text-subtle hover:text-content"
              }`}>
              {t === "match" ? "Match Analysis" : t}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain p-6">
          {tab === "overview" && <OverviewTab job={job} fetching={fetching} onWhy={() => setTab("match")} onImprove={onTailor} />}
          {tab === "match" && <MatchTab job={job} />}
          {tab === "requirements" && <RequirementsTab job={job} />}
          {tab === "recruiters" && <RecruitersTab company={job.company} onDraft={() => { onClose(); navigate("/cover-letters"); }} />}
      </div>
    </div>
  );
}

function Meta({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 text-subtle">{icon}<span className="text-muted">{children}</span></span>;
}

function OverviewTab({ job, onWhy, onImprove, fetching }: { job: JobSearchResult; onWhy: () => void; onImprove: () => void; fetching?: boolean }) {
  // Whether a résumé was actually compared against this posting. Without one
  // there is no analysis, and the empty lists below must say so rather than
  // render as findings — "None detected" under Potential Gaps reads as "you
  // have no gaps", which is the opposite of what an unscored card knows.
  const scored = job.match_score != null;
  // The whole posting once the single-job response lands; the list's 400-char
  // preview until then, so there's something to read immediately.
  const body = job.description || job.snippet;
  const [expanded, setExpanded] = useState(false);
  // Collapse again when a different posting is opened into the same panel.
  useEffect(() => setExpanded(false), [job.id, job.url]);
  return (
    <div className="space-y-6">
      {/* The description gets the panel's full width and reads top to bottom:
          a few lines by default, the entire posting once expanded. The panel
          scrolls, so there is no reason to keep the body in a narrow column. */}
      <div>
        <h3 className="section-title mb-2">About the role</h3>
        {body ? (
          <>
            {/* Collapsed, the posting is clipped by height and faded out, so a
                bullet list is cut at a believable place instead of the first
                block being stretched to fill a line clamp. */}
            <div className={`relative ${expanded ? "" : "max-h-44 overflow-hidden"}`}>
              <Posting text={body} />
              {!expanded && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-canvas-raised to-transparent" />
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
              {/* Only offer the toggle when there is more to reveal — six lines
                  is roughly 400 characters at this width. */}
              {(job.description || body.length > 400) && (
                <button
                  onClick={() => setExpanded((v) => !v)}
                  className="inline-flex items-center gap-1 text-sm font-medium text-brand-300 hover:text-brand-200"
                >
                  {expanded ? "Show less" : "View more"}
                  <IconArrowRight className={`h-4 w-4 transition-transform ${expanded ? "-rotate-90" : "rotate-90"}`} />
                </button>
              )}
              {job.url && (
                <a href={job.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-subtle hover:text-content">
                  View full description on {job.source.split(" · ")[0]} <IconArrowRight className="h-4 w-4" />
                </a>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            {fetching
              ? "Fetching the full posting…"
              : "This listing didn't include a description, and we couldn't fetch it from the source."}
          </p>
        )}
      </div>

      <div className="rounded-2xl border border-white/[0.07] bg-surface-2 p-4">
        <h3 className="section-title mb-3">Skills you have</h3>
        {job.strengths.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {job.strengths.slice(0, 8).map((s) => (
              <li key={s} className="flex items-center gap-2.5 text-sm text-content">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald" /> {s}
              </li>
            ))}
            {job.strengths.length > 8 && <li className="badge-brand mt-1 inline-block">+{job.strengths.length - 8} more</li>}
          </ul>
        ) : (
          <p className="text-sm text-subtle">
            {scored
              ? "No overlapping skills detected from this posting."
              : "Pick a résumé above to see which of your skills this posting asks for."}
          </p>
        )}
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
              )) : <li className="text-sm text-subtle">{scored ? "—" : "Not analysed yet"}</li>}
            </ul>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium text-coral">Potential Gaps</div>
            <ul className="space-y-1.5">
              {job.gaps.length ? job.gaps.map((g) => (
                <li key={g} className="flex items-center gap-2 text-sm text-muted"><span className="text-coral">⚠</span> {g}</li>
              )) : <li className="text-sm text-subtle">{scored ? "None detected" : "Not analysed yet"}</li>}
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
      {verdict && (
        <div className={`-mt-1 text-[11px] font-medium ${
          score >= 70 ? "text-emerald" : score >= 50 ? "text-electric" : "text-coral"
        }`}>{verdict}</div>
      )}
    </div>
  );
}
