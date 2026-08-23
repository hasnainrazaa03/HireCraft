import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  api,
  ApiError,
  fetchAll,
  type ResumeProfileSummary,
  type ApplicationSummary,
  type LlmSettings,
  streamCopilot,
  type CopilotAction,
  type AssistantProposal,
} from "../lib/api";
import { IconSparkles } from "../components/icons";
import { Spinner } from "../components/ui";

interface Msg {
  role: "user" | "assistant";
  content: string;
  grounded_in?: string[];
  // Set when Copilot wants to change the résumé. Rendered as a preview the user
  // accepts or rejects — Copilot never writes on its own.
  action?: CopilotAction | null;
  // Cleared once the proposal has been applied or dismissed.
  actionDone?: string;
}

const SUGGESTIONS = [
  "Why is my ATS score low?",
  "What keywords am I missing?",
  "How can I make my résumé stronger?",
  "Which skills should I learn next?",
];

const PROMPT_GROUPS: { label: string; items: string[] }[] = [
  {
    label: "Résumé",
    items: ["Why is my ATS score low?", "What keywords am I missing?", "How can I make my résumé stronger?"],
  },
  {
    label: "Applications",
    items: ["Which of my applications is strongest?", "What should I fix before I apply?"],
  },
  {
    label: "Career",
    items: ["Which skills should I learn next?", "What roles fit my background?"],
  },
];

export default function CopilotPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [resumeId, setResumeId] = useState<string>("");
  const [appId, setAppId] = useState<string>("");
  // Per-chat model override: "" = the account's active model.
  const [override, setOverride] = useState<string>("");
  const endRef = useRef<HTMLDivElement>(null);

  const { data: resumes = [] } = useQuery({
    queryKey: ["resumes"],
    queryFn: () => api.get<ResumeProfileSummary[]>("/resumes"),
  });
  // Must match the shape the Dashboard/Applications pages cache under this same
  // key — fetchAll returns { items, total, … }. Reading it as a bare array here
  // (the previous code) crashed with "P.map is not a function" whenever one of
  // those pages had populated the cache first.
  const { data: appsData } = useQuery({
    queryKey: ["applications"],
    queryFn: () => fetchAll<ApplicationSummary>("/applications"),
  });
  const applications = appsData?.items ?? [];
  const { data: llm } = useQuery({
    queryKey: ["llm-settings"],
    queryFn: () => api.get<LlmSettings>("/account/llm"),
  });

  // Streamed via SSE so the answer appears as it's written, rather than after
  // the whole reply lands. `streaming` gates the composer the way isPending did.
  const [streaming, setStreaming] = useState(false);

  async function send(message: string) {
    const [provider, model] = override ? override.split("::") : [null, null];
    setStreaming(true);
    // The placeholder the tokens stream into.
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    try {
      await streamCopilot(
        {
          message,
          history: messages.slice(-8).map((m) => ({ role: m.role, content: m.content })),
          resume_profile_id: resumeId || null,
          application_id: appId || null,
          provider,
          model,
        },
        {
          onToken: (text) =>
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = {
                ...next[next.length - 1],
                content: next[next.length - 1].content + text,
              };
              return next;
            }),
          onDone: ({ grounded_in, action }) =>
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = { ...next[next.length - 1], grounded_in, action };
              return next;
            }),
        },
      );
    } catch (e) {
      setMessages((prev) => {
        const next = [...prev];
        const detail = e instanceof Error ? e.message : "Something went wrong. Please try again.";
        next[next.length - 1] = { role: "assistant", content: `⚠️ ${detail}` };
        return next;
      });
    } finally {
      setStreaming(false);
    }
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  function submit(text: string) {
    const message = text.trim();
    if (!message || streaming) return;
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setInput("");
    void send(message);
  }

  const controls = (stacked: boolean) => {
    const cls = stacked ? "input w-full py-1.5 text-sm" : "input w-auto min-w-[130px] py-1.5 text-sm";
    return (
      <>
        <select className={cls} value={resumeId} onChange={(e) => setResumeId(e.target.value)} title="Résumé to ground answers in">
          <option value="">Default résumé</option>
          {resumes.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <select className={stacked ? cls : `${cls} max-w-[220px]`} value={appId} onChange={(e) => setAppId(e.target.value)} title="Focus on a specific application">
          <option value="">All applications</option>
          {applications.map((a) => (
            <option key={a.id} value={a.id}>
              {a.job_title ?? "Untitled"}{a.company ? ` · ${a.company}` : ""}
            </option>
          ))}
        </select>
        {llm && (
          <select className={stacked ? cls : `${cls} max-w-[220px]`} value={override} onChange={(e) => setOverride(e.target.value)} title="Model for this chat">
            <option value="">
              {llm.providers.find((p) => p.id === llm.provider)?.models.find((m) => m.id === llm.model)?.label ?? llm.model}
            </option>
            {llm.providers.filter((p) => p.has_key).map((p) => (
              <optgroup key={p.id} label={p.label}>
                {p.models.map((m) => (
                  <option key={m.id} value={`${p.id}::${m.id}`}>{m.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
      </>
    );
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-7rem)] w-full max-w-6xl gap-5">
      {/* Left context rail — grounding controls + categorized prompts */}
      <aside className="relative hidden w-[280px] shrink-0 flex-col gap-4 overflow-y-auto pb-2 pr-1 lg:flex">
        <div className="pointer-events-none absolute -left-8 -top-10 h-44 w-44 rounded-full bg-brand-500/25 opacity-60 blur-3xl" />
        <div className="relative">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <IconSparkles className="h-6 w-6 text-brand-300" /> Copilot
          </h1>
          <p className="mt-1 text-sm text-muted">
            Grounded in your real data — it explains HireCraft's actual decisions, never guesses.
          </p>
        </div>

        <div className="card relative space-y-2.5 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Grounded in</div>
          {controls(true)}
        </div>

        <div className="relative">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">Try asking</div>
          <div className="space-y-3.5">
            {PROMPT_GROUPS.map((g) => (
              <div key={g.label}>
                <div className="mb-1.5 text-xs font-medium text-muted">{g.label}</div>
                <div className="space-y-1.5">
                  {g.items.map((p) => (
                    <button
                      key={p}
                      onClick={() => submit(p)}
                      className="flex w-full items-center gap-2 rounded-lg border border-white/[0.07] bg-surface-2/60 px-3 py-2 text-left text-xs text-muted transition hover:border-brand-500/40 hover:bg-surface-2 hover:text-content"
                    >
                      <IconSparkles className="h-3 w-3 shrink-0 text-brand-300/70" /> {p}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* Chat column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3 lg:hidden">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <IconSparkles className="h-6 w-6 text-brand-300" /> Copilot
          </h1>
          <p className="text-sm text-muted">Grounded in your real data — never guesses.</p>
          <div className="mt-2 flex flex-wrap gap-2">{controls(false)}</div>
        </div>

        {/* Only scrollable once there's a conversation: the empty state is
            h-full, so with padding it overflowed and showed a scrollbar with
            nothing to scroll. */}
        <div
          className={`relative flex-1 space-y-4 rounded-2xl border border-white/[0.06] bg-surface-2/40 p-4 ${
            messages.length === 0 ? "overflow-hidden" : "overflow-y-auto"
          }`}
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <div
                className="grid h-16 w-16 place-items-center rounded-2xl bg-brand-500/15 text-brand-300 ring-1 ring-inset ring-white/10"
                style={{ boxShadow: "0 0 44px -8px #7C4DFF" }}
              >
                <IconSparkles className="h-8 w-8" />
              </div>
              <p className="max-w-md text-sm text-subtle">
                Ask about your résumé, a specific application, or your job search. I only speak to what's actually in your data.
              </p>
              <div className="flex flex-wrap justify-center gap-2 lg:hidden">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => submit(s)}
                    className="rounded-full border border-white/[0.08] bg-surface-2 px-3 py-1.5 text-xs text-muted transition hover:border-brand-500/40 hover:text-content"
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="hidden text-xs text-subtle lg:block">Pick a starter from the left, or type your own below.</p>
            </div>
          ) : (
            messages.map((m, i) => (
              <Bubble
                key={i}
                msg={m}
                applicationId={appId}
                onResolved={(note) =>
                  setMessages((prev) => {
                    const next = [...prev];
                    next[i] = { ...next[i], action: null, actionDone: note };
                    return next;
                  })
                }
              />
            ))
          )}
          {streaming && (
            <div className="flex items-center gap-2 text-sm text-subtle">
              <Spinner className="h-4 w-4" /> Thinking…
            </div>
          )}
          <div ref={endRef} />
        </div>

        <form onSubmit={(e) => { e.preventDefault(); submit(input); }} className="mt-3 flex gap-2">
          <input
            className="input flex-1"
            placeholder="Ask your Copilot…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" disabled={!input.trim() || streaming} className="btn-primary">
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function Bubble({
  msg,
  applicationId,
  onResolved,
}: {
  msg: Msg;
  applicationId: string;
  onResolved: (note: string) => void;
}) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] ${isUser ? "" : "space-y-1.5"}`}>
        <div
          className={`whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isUser
              ? "bg-brand-600 text-white"
              : "border border-white/[0.06] bg-surface text-content"
          }`}
        >
          {msg.content}
        </div>
        {msg.action && applicationId && (
          <ProposalCard
            action={msg.action}
            applicationId={applicationId}
            onResolved={onResolved}
          />
        )}
        {msg.actionDone && (
          <p className="px-1 text-xs text-emerald">{msg.actionDone}</p>
        )}
        {msg.grounded_in && msg.grounded_in.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1">
            {msg.grounded_in.map((g) => (
              <span key={g} className="badge-muted text-[10px]">{g}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


/** Copilot's proposed edit: preview the diff, then accept or discard.
 *
 * Reuses the Application page's guardrailed pipeline — `assistant/revise` builds
 * the preview, `assistant/apply` writes it — so a Copilot edit is vetted exactly
 * like one made there, and nothing is saved until the user accepts.
 */
function ProposalCard({
  action,
  applicationId,
  onResolved,
}: {
  action: CopilotAction;
  applicationId: string;
  onResolved: (note: string) => void;
}) {
  const [proposal, setProposal] = useState<AssistantProposal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = useMutation({
    mutationFn: () =>
      api.post<AssistantProposal>(`/applications/${applicationId}/assistant/revise`, {
        instruction: action.instruction,
      }),
    onSuccess: setProposal,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Couldn't build that preview."),
  });

  const apply = useMutation({
    mutationFn: () =>
      api.post(`/applications/${applicationId}/assistant/apply`, {
        proposed: proposal!.proposed,
        rejected: [],
      }),
    onSuccess: () => onResolved("Applied. You can undo this from the application's Résumé tab."),
    onError: (e) => setError(e instanceof ApiError ? e.message : "Couldn't apply that change."),
  });

  if (error) return <p className="px-1 text-xs text-coral">⚠️ {error}</p>;

  return (
    <div className="rounded-xl border border-brand-500/30 bg-brand-500/[0.07] p-3">
      <p className="text-xs font-medium text-brand-200">Proposed change</p>
      <p className="mt-0.5 text-xs text-subtle">{action.instruction}</p>

      {!proposal ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => preview.mutate()}
            disabled={preview.isPending}
            className="btn-primary btn-sm"
          >
            {preview.isPending ? <><Spinner className="h-3.5 w-3.5" /> Preparing…</> : "Preview change"}
          </button>
          <button onClick={() => onResolved("Dismissed.")} className="btn-ghost btn-sm text-subtle">
            Not now
          </button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-content">{proposal.note}</p>
          {proposal.blocked.length > 0 && (
            <div className="rounded-lg border border-coral/30 bg-coral/10 px-2.5 py-1.5 text-[11px] text-coral">
              Guardrails blocked {proposal.blocked.length} unsupported claim
              {proposal.blocked.length === 1 ? "" : "s"} — the rest is still yours to accept.
            </div>
          )}
          <div className="max-h-56 space-y-1.5 overflow-y-auto">
            {proposal.diff.slice(0, 8).map((d, i) => (
              <div key={i} className="rounded-lg border border-white/[0.06] bg-surface p-2 text-[11px]">
                <div className="text-subtle">{String(d.label ?? d.section ?? "Change")}</div>
                {d.before ? <div className="mt-0.5 text-coral line-through">{String(d.before).slice(0, 160)}</div> : null}
                {d.after ? <div className="mt-0.5 text-emerald">{String(d.after).slice(0, 160)}</div> : null}
              </div>
            ))}
            {proposal.diff.length > 8 && (
              <p className="text-[11px] text-subtle">+{proposal.diff.length - 8} more changes</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => apply.mutate()} disabled={apply.isPending} className="btn-primary btn-sm">
              {apply.isPending ? <><Spinner className="h-3.5 w-3.5" /> Applying…</> : "Accept & apply"}
            </button>
            <button onClick={() => onResolved("Discarded — nothing was changed.")} className="btn-ghost btn-sm text-subtle">
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
