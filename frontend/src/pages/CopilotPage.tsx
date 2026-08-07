import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  api,
  ApiError,
  fetchAll,
  type ResumeProfileSummary,
  type ApplicationSummary,
  type CopilotResponse,
  type LlmSettings,
} from "../lib/api";
import { IconSparkles } from "../components/icons";
import { Spinner } from "../components/ui";

interface Msg {
  role: "user" | "assistant";
  content: string;
  grounded_in?: string[];
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

  const send = useMutation({
    mutationFn: (message: string) => {
      const [provider, model] = override ? override.split("::") : [null, null];
      return api.post<CopilotResponse>("/copilot/chat", {
        message,
        history: messages.slice(-8).map((m) => ({ role: m.role, content: m.content })),
        resume_profile_id: resumeId || null,
        application_id: appId || null,
        provider,
        model,
      });
    },
    onSuccess: (r) =>
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: r.reply, grounded_in: r.grounded_in },
      ]),
    onError: (e) =>
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            e instanceof ApiError ? `⚠️ ${e.message}` : "⚠️ Something went wrong. Please try again.",
        },
      ]),
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, send.isPending]);

  function submit(text: string) {
    const message = text.trim();
    if (!message || send.isPending) return;
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setInput("");
    send.mutate(message);
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

        <div className="relative flex-1 space-y-4 overflow-y-auto rounded-2xl border border-white/[0.06] bg-surface-2/40 p-4">
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
            messages.map((m, i) => <Bubble key={i} msg={m} />)
          )}
          {send.isPending && (
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
          <button type="submit" disabled={!input.trim() || send.isPending} className="btn-primary">
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: Msg }) {
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
