import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type WritingProfile, type WritingSample } from "../lib/api";
import { useToast } from "../lib/toast";
import { PageLoader, EmptyState, Spinner } from "../components/ui";
import { IconPen, IconSparkles, IconTrash } from "../components/icons";

const KINDS = [
  { value: "cover_letter", label: "Cover letter" },
  { value: "email", label: "Email" },
  { value: "sop", label: "Statement of purpose" },
  { value: "other", label: "Other" },
] as const;

export default function WritingPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["writing"],
    queryFn: () => api.get<WritingProfile>("/writing"),
  });

  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("cover_letter");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["writing"] });

  const addSample = useMutation({
    mutationFn: () => api.post<WritingSample>("/writing/samples", { kind, title: title || null, content }),
    onSuccess: () => {
      invalidate();
      setTitle("");
      setContent("");
      toast.success("Sample added");
    },
    onError: (e) => toast.error("Couldn't add", e instanceof ApiError ? e.message : undefined),
  });

  const removeSample = useMutation({
    mutationFn: (id: string) => api.delete(`/writing/samples/${id}`),
    onSuccess: invalidate,
  });

  const analyze = useMutation({
    mutationFn: () => api.post<WritingProfile>("/writing/analyze"),
    onSuccess: (updated) => {
      queryClient.setQueryData(["writing"], updated);
      toast.success("Voice updated", "Your writing style has been analyzed.");
    },
    onError: (e) => toast.error("Couldn't analyze", e instanceof ApiError ? e.message : undefined),
  });

  if (isLoading || !data) return <PageLoader label="Loading your writing profile…" />;

  const voice = data.voice;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Writing profile</h1>
        <p className="mt-1 text-sm text-muted">
          Add samples of your own writing and HireCraft learns your voice — so
          cover letters and outreach sound like you, not generic AI.
        </p>
      </div>

      {/* Voice card */}
      <div className="hero-card mb-6 bg-hero-purple p-6">
        <div className="relative z-10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-white">
              <IconSparkles className="h-5 w-5" />
              <span className="font-semibold">Your voice</span>
            </div>
            <button
              onClick={() => analyze.mutate()}
              disabled={analyze.isPending || data.sample_count === 0}
              className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur transition hover:bg-white/25 disabled:opacity-50"
            >
              {analyze.isPending ? "Analyzing…" : voice ? "Re-analyze" : "Analyze my voice"}
            </button>
          </div>
          {voice ? (
            <div className="mt-4 space-y-3 text-white/90">
              <p className="text-sm leading-relaxed">{voice.summary}</p>
              <div className="flex flex-wrap gap-1.5">
                {voice.tone && <Pill>{voice.tone}</Pill>}
                {voice.formality !== "unknown" && <Pill>{voice.formality}</Pill>}
              </div>
              {voice.habits.length > 0 && (
                <div className="text-xs text-white/75">
                  <span className="font-medium text-white/90">Keeps:</span> {voice.habits.join(" · ")}
                </div>
              )}
              {voice.avoid.length > 0 && (
                <div className="text-xs text-white/75">
                  <span className="font-medium text-white/90">Avoids:</span> {voice.avoid.join(" · ")}
                </div>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm text-white/80">
              {data.sample_count === 0
                ? "Add at least one writing sample below, then analyze."
                : "Ready to analyze — click the button above."}
            </p>
          )}
        </div>
      </div>

      {/* Add sample */}
      <div className="card mb-6 p-6">
        <h2 className="mb-4 text-base font-semibold">Add a writing sample</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Type</label>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {KINDS.map((k) => <option key={k.value} value={k.value} className="bg-surface">{k.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Title (optional)</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Grad school SOP" />
          </div>
        </div>
        <div className="mt-3">
          <label className="label">Content</label>
          <textarea
            className="input min-h-[160px] leading-relaxed"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste something you wrote — a past cover letter, an email, an SOP…"
          />
          <div className="mt-1 text-xs text-subtle">{content.length} characters (min 30)</div>
        </div>
        <button
          onClick={() => addSample.mutate()}
          disabled={addSample.isPending || content.trim().length < 30}
          className="btn-primary mt-4"
        >
          {addSample.isPending ? "Adding…" : "Add sample"}
        </button>
      </div>

      {/* Samples list */}
      <h2 className="section-title mb-3">Your samples ({data.sample_count})</h2>
      {data.samples.length === 0 ? (
        <EmptyState icon={<IconPen className="h-6 w-6" />} title="No samples yet" description="Add a few things you've written so HireCraft can learn your voice." />
      ) : (
        <div className="space-y-2">
          {data.samples.map((s) => (
            <div key={s.id} className="card flex items-start justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="badge-muted capitalize">{s.kind.replace("_", " ")}</span>
                  {s.title && <span className="text-sm font-medium">{s.title}</span>}
                </div>
                <p className="mt-1.5 line-clamp-2 text-sm text-muted">{s.content}</p>
              </div>
              <button
                onClick={() => removeSample.mutate(s.id)}
                className="btn-ghost btn-sm shrink-0 text-danger hover:bg-danger/10"
                aria-label="Delete sample"
              >
                <IconTrash className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {analyze.isPending && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted">
          <Spinner className="h-4 w-4" /> Reading your writing…
        </div>
      )}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-medium text-white">{children}</span>;
}
