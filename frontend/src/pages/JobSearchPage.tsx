import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type JobSearchResult } from "../lib/api";
import { EmptyState, Spinner } from "../components/ui";
import { IconSearch, IconSparkles } from "../components/icons";

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
        <div className="space-y-3">
          {jobs.map((job, i) => (
            <div key={i} className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-medium text-content">{job.title}</h3>
                  <div className="mt-0.5 text-sm text-muted">
                    {job.company}
                    {job.location ? ` · ${job.location}` : ""}
                    {job.remote && <span className="badge-emerald ml-2 text-[10px]">Remote</span>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {job.url && (
                    <a href={job.url} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">
                      View
                    </a>
                  )}
                  <button onClick={() => tailor(job)} className="btn-primary btn-sm">
                    <IconSparkles className="h-4 w-4" /> Tailor
                  </button>
                </div>
              </div>
              {job.snippet && (
                <p className="mt-2 line-clamp-2 text-sm text-subtle">{job.snippet}</p>
              )}
              {job.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {job.tags.slice(0, 6).map((t) => (
                    <span key={t} className="badge-muted">{t}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
          <p className="pt-1 text-center text-xs text-subtle">Source: {jobs[0]?.source}</p>
        </div>
      )}
    </div>
  );
}
