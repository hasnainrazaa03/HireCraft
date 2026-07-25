import { useState, useEffect, type FormEvent } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api, ApiError, type ApplicationDetail, type ResumeProfileSummary } from "../lib/api";

interface PrefillState {
  url?: string;
  text?: string;
  title?: string;
  company?: string;
}

export default function NewApplicationPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const prefill = (location.state as PrefillState | null) ?? null;
  const clip = new URLSearchParams(location.search).get("clip") === "1";

  const [mode, setMode] = useState<"url" | "text">(
    prefill?.text || clip ? "text" : "url",
  );
  const [url, setUrl] = useState(prefill?.url ?? "");
  const [text, setText] = useState(prefill?.text ?? "");
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [company, setCompany] = useState(prefill?.company ?? "");
  const [profileId, setProfileId] = useState("");
  const [coverLetter, setCoverLetter] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Extension clip: the posting is on the clipboard — pull it in automatically.
  useEffect(() => {
    if (clip && !text) {
      navigator.clipboard.readText().then((t) => t && setText(t)).catch(() => {});
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
        include_cover_letter: coverLetter,
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
          {create.isPending ? "Starting…" : "Tailor my resume"}
        </button>
      </form>
    </div>
  );
}
