import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  api,
  ApiError,
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
  const { data: applications = [] } = useQuery({
    queryKey: ["applications"],
    queryFn: () => api.get<ApplicationSummary[]>("/applications?limit=100"),
  });
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

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <IconSparkles className="h-6 w-6 text-brand-300" /> Copilot
          </h1>
          <p className="text-sm text-muted">
            Grounded in your real data — it explains HireCraft's actual decisions, never guesses.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            className="input w-auto min-w-[130px] py-1.5 text-sm"
            value={resumeId}
            onChange={(e) => setResumeId(e.target.value)}
            title="Résumé to ground answers in"
          >
            <option value="">Default résumé</option>
            {resumes.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <select
            className="input w-auto min-w-[150px] max-w-[220px] py-1.5 text-sm"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            title="Focus on a specific application"
          >
            <option value="">All applications</option>
            {applications.map((a) => (
              <option key={a.id} value={a.id}>
                {a.job_title ?? "Untitled"}{a.company ? ` · ${a.company}` : ""}
              </option>
            ))}
          </select>
          {llm && (
            <select
              className="input w-auto min-w-[150px] max-w-[220px] py-1.5 text-sm"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              title="Model for this chat"
            >
              <option value="">
                {llm.providers.find((p) => p.id === llm.provider)?.models.find((m) => m.id === llm.model)?.label ?? llm.model}
              </option>
              {llm.providers
                .filter((p) => p.has_key)
                .map((p) => (
                  <optgroup key={p.id} label={p.label}>
                    {p.models.map((m) => (
                      <option key={m.id} value={`${p.id}::${m.id}`}>{m.label}</option>
                    ))}
                  </optgroup>
                ))}
            </select>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto rounded-2xl border border-white/[0.06] bg-surface-2/40 p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <IconSparkles className="h-10 w-10 text-brand-400/60" />
            <p className="max-w-sm text-sm text-subtle">
              Ask about your résumé, a specific application, or your job search. I only
              speak to what's actually in your data.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
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

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="mt-3 flex gap-2"
      >
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
