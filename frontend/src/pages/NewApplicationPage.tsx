import { useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api, ApiError, type ApplicationDetail, type ResumeProfileSummary } from "../lib/api";

export default function NewApplicationPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"url" | "text">("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [profileId, setProfileId] = useState("");
  const [coverLetter, setCoverLetter] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <p className="mt-2 text-sm text-ink-600">
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
      <p className="mt-1 text-sm text-ink-600">
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
          <div className="mb-3 flex rounded-lg border border-ink-200 bg-white p-0.5">
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
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  mode === value ? "bg-ink-900 text-white" : "text-ink-600"
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
              <p className="mt-1.5 text-xs text-ink-500">
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
            className="mt-0.5 h-4 w-4 rounded border-ink-300 text-ink-900 focus:ring-ink-900"
          />
          <span>
            Also draft a cover letter
            <span className="block text-xs text-ink-500">
              Adds one more LLM call to the cost.
            </span>
          </span>
        </label>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
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
