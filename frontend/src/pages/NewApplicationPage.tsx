import { useState, useEffect, type FormEvent } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api, ApiError, type ApplicationDetail, type ResumeProfileSummary } from "../lib/api";
import { IconSparkles } from "../components/icons";

interface PrefillState {
  url?: string;
  text?: string;
  title?: string;
  company?: string;
  /** Which action the caller meant — a job card can send you here for either. */
  intent?: "tailor" | "as_is";
}

export default function NewApplicationPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const prefill = (location.state as PrefillState | null) ?? null;
  const params = new URLSearchParams(location.search);
  const clip = params.get("clip") === "1";

  const [mode, setMode] = useState<"url" | "text">(
    prefill?.text || clip ? "text" : "url",
  );
  const [url, setUrl] = useState(prefill?.url ?? "");
  const [text, setText] = useState(prefill?.text ?? "");
  // The extension passes title/company in the query string; it cannot hand them
  // over any other way, since a web page can't read chrome.storage.
  const [title, setTitle] = useState(prefill?.title ?? params.get("title") ?? "");
  const [company, setCompany] = useState(
    prefill?.company ?? params.get("company") ?? "",
  );
  const [profileId, setProfileId] = useState("");
  const [coverLetter, setCoverLetter] = useState(false);
  // "tailor" rewrites the résumé for this posting (LLM, costs money);
  // "as_is" attaches it unchanged and just tracks the application (free).
  const [intent, setIntent] = useState<"tailor" | "as_is">(
    prefill?.intent === "as_is" ? "as_is" : "tailor",
  );
  const [reachMode, setReachMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clipBlocked, setClipBlocked] = useState(false);

  // Extension clip: the posting is on the clipboard — pull it in automatically.
  // Chrome often refuses a clipboard read that isn't tied to a user gesture, so
  // a failure here is expected rather than exceptional; tell the user to paste
  // instead of leaving them with a silently empty box.
  useEffect(() => {
    if (clip && !text) {
      navigator.clipboard
        .readText()
        .then((t) => (t ? setText(t) : setClipBlocked(true)))
        .catch(() => setClipBlocked(true));
    }
  }, [clip, text]);

  const { data: profiles = [], isLoading: loadingProfiles } = useQuery({
    queryKey: ["resumes"],
    queryFn: () => api.get<ResumeProfileSummary[]>("/resumes"),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<ApplicationDetail>("/applications", {
        resume_profile_id: profileId || profiles.find((p) => p.is_default)?.id || null,
        include_cover_letter: intent === "tailor" && coverLetter,
        reach_mode: intent === "tailor" && reachMode,
        tailor: intent === "tailor",
        job:
          mode === "url"
            ? { url }
            : { text, title: title || null, company: company || null },
      }),
    onSuccess: (application) => navigate(`/applications/${application.id}`),
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : "Could not start the run."),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    create.mutate();
  }

  if (!loadingProfiles && profiles.length === 0) {
    return (
      <div className="card mx-auto max-w-md p-10 text-center">
        <h2 className="text-lg font-semibold">Add a master resume first</h2>
        <p className="mt-2 text-sm text-muted">
          HireCraft tailors an existing resume. It never invents experience, so it
          needs your real one as the source of truth.
        </p>
        <Link to="/resumes" className="btn-primary mt-6">
          Add master resume
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight">New application</h1>
      <p className="mt-1 text-sm text-muted">
        Paste a job posting and HireCraft will tailor your resume to it.
      </p>

      <form onSubmit={onSubmit} className="card mt-6 space-y-5 p-6">
        <div>
          <label className="label" htmlFor="profile">
            Master resume
          </label>
          <select
            id="profile"
            className="input"
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
                {profile.is_default ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <span className="label">Job source</span>
          <div className="segment mb-3 flex w-full">
            {(
              [
                ["url", "From URL"],
                ["text", "Paste text"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={`segment-item flex-1 ${
                  mode === value ? "segment-item-active" : ""
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "url" ? (
            <>
              <input
                className="input"
                type="url"
                placeholder="https://boards.greenhouse.io/company/jobs/12345"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
              <p className="mt-1.5 text-xs text-subtle">
                Some boards (LinkedIn, Workday) block automated access. If the fetch
                fails, switch to “Paste text”.
              </p>
            </>
          ) : (
            <div className="space-y-3">
              {clipBlocked && !text && (
                <div className="rounded-xl border border-white/[0.07] bg-surface-2 px-3 py-2.5 text-xs text-muted">
                  Your browser blocked the automatic clipboard read. The clipped job
                  description is still on your clipboard — press ⌘V / Ctrl+V below.
                </div>
              )}
              <textarea
                className="input min-h-[200px] font-mono text-xs leading-relaxed"
                placeholder="Paste the full job description here…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                required
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  className="input"
                  placeholder="Role title (optional)"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <input
                  className="input"
                  placeholder="Company (optional)"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* Two ways to add an application. Tailoring is the headline feature,
            but a role that already fits doesn't need a rewrite — and someone
            tracking where they've applied shouldn't have to pay for one. */}
        <div className="grid gap-3 sm:grid-cols-2">
          {([
            {
              key: "tailor" as const,
              title: "Tailor for this role",
              blurb: "Rewrites your résumé against this posting, then scores and reports what changed.",
              foot: "Uses AI · costs a few cents",
            },
            {
              key: "as_is" as const,
              title: "Use my résumé as it is",
              blurb: "Attaches the résumé unchanged and tracks the application. Documents, notes, and interview prep all still work.",
              foot: "No AI · free · instant",
            },
          ]).map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setIntent(opt.key)}
              aria-pressed={intent === opt.key}
              className={`rounded-xl border p-3.5 text-left transition ${
                intent === opt.key
                  ? "border-brand-500/50 bg-brand-500/[0.07]"
                  : "border-white/[0.08] hover:border-white/[0.16]"
              }`}
            >
              <div className="text-sm font-medium text-content">{opt.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-subtle">{opt.blurb}</div>
              <div className="mt-2 text-[11px] font-medium text-muted">{opt.foot}</div>
            </button>
          ))}
        </div>

        {intent === "tailor" && (
          <>
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={coverLetter}
            onChange={(e) => setCoverLetter(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-white/[0.12] text-content focus:ring-brand-500"
          />
          <span>
            Also draft a cover letter
            <span className="block text-xs text-subtle">
              Adds one more LLM call to the cost.
            </span>
          </span>
        </label>

        <label className={`flex items-start gap-2.5 rounded-xl border p-3 text-sm transition ${reachMode ? "border-brand-500/40 bg-brand-500/[0.06]" : "border-white/[0.08]"}`}>
          <input
            type="checkbox"
            checked={reachMode}
            onChange={(e) => setReachMode(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-white/[0.12] text-content focus:ring-brand-500"
          />
          <span>
            <span className="flex items-center gap-1.5 font-medium text-content">
              <IconSparkles className="h-3.5 w-3.5 text-brand-300" /> Reach mode
              <span className="rounded bg-brand-500/15 px-1.5 py-0.5 text-[10px] text-brand-200">aggressive</span>
            </span>
            <span className="mt-0.5 block text-xs text-subtle">
              Tailors your <span className="text-muted">real</span> experience harder toward this exact role — reframes it in the job's language and surfaces adjacent skills &amp; keywords you have a basis for. Anything stretched is flagged for you to confirm. It still never invents numbers, employers, titles, or credentials.
            </span>
          </span>
        </label>
          </>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={create.isPending}
          className="btn-primary w-full"
        >
          {create.isPending
            ? intent === "tailor" ? "Starting…" : "Adding…"
            : intent === "tailor" ? "Tailor my resume" : "Track this application"}
        </button>
      </form>
    </div>
  );
}
