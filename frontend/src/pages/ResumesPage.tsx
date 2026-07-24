import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ResumeProfile,
  type ResumeProfileSummary,
} from "../lib/api";

const STARTER_RESUME = {
  basics: {
    name: "Your Name",
    email: "you@example.com",
    phone: "+1 (555) 000-0000",
    location: "City, State",
    github: "https://github.com/yourhandle",
    linkedin: "https://linkedin.com/in/yourhandle",
    summary: "One or two sentences about what you do.",
  },
  education: [
    {
      institution: "Your University",
      degree: "B.S.",
      field_of_study: "Computer Science",
      start_date: "2022",
      end_date: "2026",
      gpa: "3.8",
      coursework: ["Data Structures", "Operating Systems"],
    },
  ],
  experience: [
    {
      company: "Company Name",
      title: "Software Engineering Intern",
      location: "City, State",
      start_date: "2024-05",
      end_date: "2024-08",
      highlights: [
        "Describe what you built and its measurable impact.",
        "Include real numbers — HireCraft can never invent them for you.",
      ],
      technologies: ["Python", "React"],
    },
  ],
  projects: [
    {
      name: "Project Name",
      description: "One line on what it does.",
      url: "https://github.com/yourhandle/project",
      highlights: ["What you built and why it mattered."],
      technologies: ["TypeScript"],
    },
  ],
  skills: [
    { category: "Languages", items: ["Python", "JavaScript", "SQL"] },
    { category: "Tools", items: ["Git", "Docker", "PostgreSQL"] },
  ],
};

export default function ResumesPage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ["resumes"],
    queryFn: () => api.get<ResumeProfileSummary[]>("/resumes"),
  });

  const save = useMutation({
    mutationFn: async () => {
      const content = JSON.parse(draft);
      if (editingId) {
        return api.patch(`/resumes/${editingId}`, { name, content });
      }
      return api.post("/resumes", { name, content });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resumes"] });
      close();
    },
    onError: (err) => {
      if (err instanceof SyntaxError) setError(`Invalid JSON: ${err.message}`);
      else if (err instanceof ApiError) setError(err.message);
      else setError("Could not save.");
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/resumes/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["resumes"] }),
    onError: (err) =>
      alert(err instanceof ApiError ? err.message : "Could not delete."),
  });

  const makeDefault = useMutation({
    mutationFn: (id: string) => api.patch(`/resumes/${id}`, { is_default: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["resumes"] }),
  });

  function close() {
    setEditingId(null);
    setDraft("");
    setName("");
    setError(null);
  }

  function startNew() {
    setEditingId(null);
    setName("Master Resume");
    setDraft(JSON.stringify(STARTER_RESUME, null, 2));
    setError(null);
  }

  async function startEdit(id: string) {
    const profile = await api.get<ResumeProfile>(`/resumes/${id}`);
    setEditingId(id);
    setName(profile.name);
    setDraft(JSON.stringify(profile.content, null, 2));
    setError(null);
  }

  async function onFile(file: File) {
    const text = await file.text();
    setEditingId(null);
    setName(file.name.replace(/\.json$/i, "").slice(0, 120));
    setDraft(text);
    setError(null);
  }

  const editorOpen = draft !== "";

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Master resumes</h1>
          <p className="text-sm text-muted">
            Your source of truth. Every tailored resume is derived from this.
          </p>
        </div>
        {!editorOpen && (
          <div className="flex gap-2">
            <label className="btn-secondary cursor-pointer">
              Upload JSON
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onFile(file);
                  e.target.value = "";
                }}
              />
            </label>
            <button onClick={startNew} className="btn-primary">
              New resume
            </button>
          </div>
        )}
      </div>

      {editorOpen ? (
        <div className="card p-5">
          <div className="mb-4">
            <label className="label" htmlFor="resumeName">
              Name
            </label>
            <input
              id="resumeName"
              className="input max-w-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <label className="label" htmlFor="resumeJson">
            Master Resume JSON
          </label>
          <textarea
            id="resumeJson"
            className="input min-h-[460px] font-mono text-xs leading-relaxed"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />

          {error && (
            <div
              role="alert"
              className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
            >
              {error}
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button
              onClick={() => {
                setError(null);
                save.mutate();
              }}
              disabled={save.isPending || !name.trim()}
              className="btn-primary"
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button onClick={close} className="btn-secondary">
              Cancel
            </button>
          </div>
        </div>
      ) : isLoading ? (
        <div className="py-16 text-center text-subtle">Loading…</div>
      ) : profiles.length === 0 ? (
        <div className="card p-10 text-center">
          <h2 className="text-lg font-semibold">No master resume yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            Start from the template and replace it with your real experience. Include
            genuine metrics — the guardrails will not let the AI invent any.
          </p>
          <button onClick={startNew} className="btn-primary mt-6">
            Create from template
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {profiles.map((profile) => (
            <div
              key={profile.id}
              className="card flex items-center justify-between p-4"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{profile.name}</span>
                  {profile.is_default && (
                    <span className="badge bg-brand-600 text-white">Default</span>
                  )}
                </div>
                <div className="text-xs text-subtle">
                  Updated {new Date(profile.updated_at).toLocaleDateString()}
                </div>
              </div>
              <div className="flex gap-2">
                {!profile.is_default && (
                  <button
                    onClick={() => makeDefault.mutate(profile.id)}
                    className="btn-secondary"
                  >
                    Make default
                  </button>
                )}
                <button
                  onClick={() => void startEdit(profile.id)}
                  className="btn-secondary"
                >
                  Edit
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete "${profile.name}"?`)) remove.mutate(profile.id);
                  }}
                  className="btn-danger"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
